/**
 * TransBoard - APIクライアント
 * RESTful Table API ラッパー
 */

const API_DEFAULT_TIMEOUT_MS = 8000;
const API_SIGNALING_TIMEOUT_MS = 5000;
const API_HEARTBEAT_TIMEOUT_MS = 4000;
const API_TRANSIENT_RETRY_DELAY_MS = 350;

function isIdempotentRead(options = {}) {
  return String(options.method || 'GET').toUpperCase() === 'GET';
}

function waitForTransientRetry() {
  const jitterMs = Math.round(Math.random() * 150);
  return new Promise(resolve => setTimeout(resolve, API_TRANSIENT_RETRY_DELAY_MS + jitterMs));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = API_DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const originalSignal = options.signal;
  if (originalSignal) {
    if (originalSignal.aborted) controller.abort();
    else originalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// 子機→親機への通信専用フェッチ。メインプロセス経由(Node httpモジュール)で中継することで、
// レンダラーのfetch()にかかるChromiumのLocal Network Access制限を回避する。
// window.electronAPIが無い環境（ブラウザ単体テスト等）では従来通りfetchにフォールバックする。
async function parentFetch(url, options = {}, timeoutMs = API_DEFAULT_TIMEOUT_MS) {
  if (window.electronAPI && window.electronAPI.parentHttpRequest) {
    // 病棟ネットワークの短い瞬断で表示更新が即失敗しないよう、読み取りだけ一度再試行する。
    // 更新系は二重実行を避けるため絶対に再試行しない。
    const maxAttempts = isIdempotentRead(options) ? 2 : 1;
    let result;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      result = await window.electronAPI.parentHttpRequest({
        url,
        method: (options.method || 'GET').toUpperCase(),
        headers: options.headers || {},
        body: options.body,
        // 再試行は短く切り上げ、親機停止時に画面更新を長く待たせない。
        timeoutMs: attempt === 1 ? timeoutMs : Math.min(timeoutMs, 3000),
        purpose: options.purpose,
      });
      if (result.ok || attempt === maxAttempts) break;
      await waitForTransientRetry();
    }
    if (!result.ok) {
      const err = new Error(result.error === 'TIMEOUT' ? 'タイムアウトしました' : (result.error || 'ネットワークエラー'));
      err.name = result.error === 'TIMEOUT' ? 'AbortError' : 'NetworkError';
      throw err;
    }
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => (result.bodyText ? JSON.parse(result.bodyText) : null),
      text: async () => result.bodyText || '',
    };
  }
  return fetchWithTimeout(url, options, timeoutMs);
}

// 子機/単独モードかどうかの判定。localStorageの'cfg_share_mode'を直接読む
// 箇所がAPI各メソッドに散在していたため、一箇所にまとめる。
function isClientMode() {
  const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
  return shareMode === 'client' || shareMode === 'child';
}

// 親機のAPIベースURL(http://<parentIp>:3005/api/<path>)の組み立て。
// 各メソッドが個別にテンプレートリテラルで組み立てていたのを一箇所にまとめる。
function buildParentApiUrl(path) {
  const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
  return `http://${parentIp}:3005/api/${path}`;
}

// 設定画面(js/settings/network.js)とセットアップウィザード(js/wizard.js)の
// 「接続テスト」ボタンが共通で使う、親機への疎通確認+APIトークン検証。
// 2画面ともwards取得(疎通)→beds取得(トークン検証)の2段階を同じ形で実装して
// いたため、判定ロジック+診断ログの出力だけをここに集約する。UIへの反映
// (トースト表示か、インラインHTMLかなど画面ごとに異なる)は呼び出し元に残す。
async function testParentConnection(parentIp, token, logPrefix) {
  const url = `http://${parentIp}:3005/api/tables/wards`;
  const appVer = await window.electronAPI?.getAppVersion?.().catch(() => '?') ?? '?';
  const logLines = [
    `[${logPrefix}] appVersion=${appVer} url=${url}`,
    `  navigator.onLine=${navigator.onLine}`,
  ];
  let result;
  try {
    const res = await parentFetch(url, {
      headers: token ? { 'X-API-Token': token } : {},
      purpose: 'connection-test',
    }, 4000);
    if (res.ok) {
      const data = await res.json();
      const wardsCount = data.data?.length;
      logLines.push(`  結果: 疎通成功 status=${res.status} wards=${wardsCount ?? '?'}件`);
      // 第2段階: APIトークン検証。wardsはトークン不要のため疎通確認にしかならず、
      // 患者データ（beds等）はトークン必須。ここで検証しないと
      // 「テストは成功するのに実際の同期は401で全滅」という状態を見逃す
      if (token) {
        try {
          const res2 = await parentFetch(`http://${parentIp}:3005/api/tables/beds`, {
            headers: { 'X-API-Token': token },
            purpose: 'connection-test',
          }, 4000);
          if (res2.ok) {
            logLines.push(`  トークン検証: 成功 status=${res2.status}`);
            result = { outcome: 'ok', wardsCount };
          } else if (res2.status === 401) {
            logLines.push(`  トークン検証: 失敗 status=401（トークン不一致）`);
            result = { outcome: 'token-mismatch', wardsCount };
          } else {
            logLines.push(`  トークン検証: HTTPエラー status=${res2.status}`);
            result = { outcome: 'token-http-error', status: res2.status };
          }
        } catch (e2) {
          logLines.push(`  トークン検証: 例外 name=${e2.name} message=${e2.message}`);
          result = { outcome: 'token-exception', error: e2 };
        }
      } else {
        logLines.push('  トークン検証: スキップ（未入力）');
        result = { outcome: 'no-token', wardsCount };
      }
    } else {
      logLines.push(`  結果: HTTPエラー status=${res.status}`);
      result = { outcome: 'http-error', status: res.status };
    }
  } catch (e) {
    const reason = e.name === 'AbortError'
      ? 'タイムアウトしました（4秒応答なし）'
      : `${e.name || 'Error'}: ${e.message || '原因不明'}`;
    logLines.push(`  結果: 例外 name=${e.name} message=${e.message} stack=${(e.stack || '').split('\n').slice(0, 3).join(' / ')}`);
    result = { outcome: 'exception', reason, error: e };
  }
  window.electronAPI?.appendDebugLog?.(logLines.join('\n')).catch(() => {});
  return result;
}

// 稼働モード・親機IPは「この端末自身」の設定のため、共有APIルーティング
// （API.patch）を通さず常にローカルDBへ直接書き込む。API.patch経由にすると
// 子機からの保存が親機のDBのshare_modeを'client'に上書きし、親機の再起動後に
// 共有サーバー(3005)が起動しなくなる事故が起きる。main.jsは起動時にローカル
// DBのshare_modeを見てサーバー起動を判定している。
// 設定画面(network.js)とセットアップウィザード(wizard.js)の両方が保存時に
// 使う共通処理。呼び出し元の既存のエラー処理方針(投げるか警告に留めるか)は
// そのまま呼び出し元に委ねる。
async function saveLocalShareModeSettings(mode, parentIp) {
  if (!window.electronAPI?.dbRequest) return;
  await Promise.all([
    window.electronAPI.dbRequest({ url: 'tables/system_settings/share_mode', options: { method: 'PATCH', body: JSON.stringify({ value: mode }) } }),
    window.electronAPI.dbRequest({ url: 'tables/system_settings/parent_ip', options: { method: 'PATCH', body: JSON.stringify({ value: parentIp }) } }),
  ]);
}

let terminalApiTokenCache = null;

function ensureMutationSuccess(result) {
  if (result && result.success === false) {
    const error = new Error(result.message || 'データ更新に失敗しました');
    if (result.conflict) error.conflict = true;
    throw error;
  }
  return result;
}

// 親機からのレスポンスは、401でも本文が正常なJSONとして返る。res.okを見ずに
// r.json()だけすると「認証エラー」が「正常な空応答」と区別できなくなり、
// ハートビートが接続中を報告して切断バナーを打ち消す等の誤検知につながる。
async function assertParentResponseOk(res) {
  if (res && res.ok === false) {
    const error = new Error(res.status === 401
      ? 'APIトークンが親機と一致しません'
      : `親機がエラーを返しました (HTTP ${res.status})`);
    if (res.status === 401) error.unauthorized = true;
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function requireDataArray(result, label) {
  if (!Array.isArray(result?.data)) {
    const error = new Error(result?.message || `${label}の取得に失敗しました`);
    if (result?.unauthorized) error.unauthorized = true;
    throw error;
  }
  return result.data;
}

const MASTER_REVISION_TABLES = new Set([
  'wards', 'beds', 'exam_rooms', 'exam_types', 'staffs', 'system_settings',
]);

function getLocalMasterUpdatedAt(table, id) {
  if (!MASTER_REVISION_TABLES.has(table)) return undefined;
  const stateKey = {
    wards: 'wards',
    beds: 'beds',
    exam_rooms: 'allExamRooms',
    exam_types: 'allExamTypes',
    // exam_rooms/exam_typesと同様、非活性を含む全件から探す。
    // masters.jsのスタッフ編集フォームはAppState.allStaffs(非活性含む)を使うため、
    // 活性のみのAppState.staffsだけを見ると、非活性スタッフの編集で
    // _expectedUpdatedAtが付与されず楽観的排他ロックが働かない
    staffs: 'allStaffs',
    system_settings: 'systemSettings',
  }[table];
  try {
    const records = typeof AppState !== 'undefined'
      ? (AppState[stateKey] || (table === 'staffs' ? AppState.staffs : null))
      : null;
    return Array.isArray(records)
      ? records.find(record => String(record.id) === String(id))?.updated_at
      : undefined;
  } catch {
    return undefined;
  }
}

function addExpectedMasterRevision(table, id, data) {
  if (!MASTER_REVISION_TABLES.has(table) || !data || Object.prototype.hasOwnProperty.call(data, '_expectedUpdatedAt')) {
    return data;
  }
  const updatedAt = getLocalMasterUpdatedAt(table, id);
  return updatedAt === undefined ? data : { ...data, _expectedUpdatedAt: updatedAt };
}

async function getTerminalApiToken() {
  if (terminalApiTokenCache !== null) return terminalApiTokenCache;

  // 旧版のlocalStorage値は初回だけsafeStorage管理へ移行する。安全な保存に失敗した
  // 場合は消さず、既存端末の接続を壊さない。
  const legacyToken = localStorage.getItem('cfg_api_token') || '';
  if (window.electronAPI?.getTerminalApiToken) {
    if (legacyToken && window.electronAPI.setTerminalApiToken) {
      const migrated = await window.electronAPI.setTerminalApiToken(legacyToken).catch(() => null);
      if (migrated?.success) {
        localStorage.removeItem('cfg_api_token');
        terminalApiTokenCache = legacyToken;
        return terminalApiTokenCache;
      }
    }
    const stored = await window.electronAPI.getTerminalApiToken().catch(() => null);
    terminalApiTokenCache = stored?.success ? String(stored.token || '') : legacyToken;
    return terminalApiTokenCache;
  }

  // ブラウザ単体のデモ環境ではElectron safeStorageを利用できないため、従来値を使う。
  terminalApiTokenCache = legacyToken;
  return terminalApiTokenCache;
}

async function setTerminalApiToken(token) {
  const normalized = String(token || '').trim().slice(0, 256);
  if (window.electronAPI?.setTerminalApiToken) {
    const result = await window.electronAPI.setTerminalApiToken(normalized);
    if (result?.success) {
      terminalApiTokenCache = normalized;
      localStorage.removeItem('cfg_api_token');
    }
    return result;
  }
  localStorage.setItem('cfg_api_token', normalized);
  terminalApiTokenCache = normalized;
  return { success: true, secure: false };
}

const API = {
  getTerminalApiToken,
  setTerminalApiToken,

  /* ---------- 汎用フェッチ ---------- */
  async _fetch(url, options = {}) {
    if (isClientMode()) {
      try {
        const cleanUrl = url.replace(/^\//, '');
        const apiToken = await getTerminalApiToken();
        const terminalRole = localStorage.getItem('cfg_terminal_role') === 'exam' ? 'exam' : 'ward';
        const optionsWithToken = apiToken
          ? {
              ...options,
              headers: {
                ...(options.headers || {}),
                'X-API-Token': apiToken,
                'X-Terminal-Role': terminalRole,
              }
            }
          : {
              ...options,
              headers: { ...(options.headers || {}), 'X-Terminal-Role': terminalRole },
            };
        const res = await parentFetch(buildParentApiUrl(cleanUrl), optionsWithToken);
        if (res.status === 204) return null;
        const data = await res.json();
        if (!res.ok) {
          const err = new Error(data.message || `HTTP ${res.status}`);
          // 401 = APIトークン不一致。ネットワーク断と区別して表示できるようフラグを立てる
          if (res.status === 401 || data.unauthorized) err.unauthorized = true;
          throw err;
        }
        return data;
      } catch (e) {
        console.error('[Client API Error]', url, e);
        throw e;
      }
    }

    if (window.electronAPI) {
      try {
        const data = await window.electronAPI.dbRequest({ url, options });
        return data;
      } catch (e) {
        console.error('[API Error Intercepted]', url, e);
        throw e;
      }
    }
    try {
      const res = await fetchWithTimeout(url, options);
      if (res.status === 204) return null;
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      console.error('[API Error]', url, e);
      throw e;
    }
  },

  async getPasscodeStatus() {
    if (isClientMode()) {
      const parentIp = localStorage.getItem('cfg_parent_ip') || '';
      const apiToken = await getTerminalApiToken();
      const res = await parentFetch(`http://${parentIp}:3005/api/auth/passcode-status`, {
        headers: apiToken ? { 'X-API-Token': apiToken } : {},
      });
      return res.json();
    }
    if (!window.electronAPI?.getPasscodeStatus) {
      return { success: false, requiresSetup: true };
    }
    return window.electronAPI.getPasscodeStatus();
  },

  async verifyAdminPasscode(passcode) {
    if (isClientMode()) {
      const parentIp = localStorage.getItem('cfg_parent_ip') || '';
      const apiToken = await getTerminalApiToken();
      const res = await parentFetch(`http://${parentIp}:3005/api/auth/verify-passcode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiToken ? { 'X-API-Token': apiToken } : {}),
        },
        body: JSON.stringify({ passcode: String(passcode || '').slice(0, 128) }),
      });
      return res.json();
    }
    if (!window.electronAPI?.verifyAdminPasscode) {
      return { success: false, valid: false };
    }
    return window.electronAPI.verifyAdminPasscode(String(passcode || '').slice(0, 128));
  },

  async setAdminPasscode(passcode) {
    if (isClientMode()) {
      return { success: false, message: '管理者パスコードは親機でのみ変更できます' };
    }
    if (!window.electronAPI?.setAdminPasscode) {
      return { success: false, message: 'パスコード保存機能を利用できません' };
    }
    return window.electronAPI.setAdminPasscode(String(passcode || '').slice(0, 128));
  },

  async getAll(table, params = {}) {
    const qs = new URLSearchParams({ limit: 200, ...params }).toString();
    return this._fetch(`tables/${table}?${qs}`);
  },

  async getWardStatusEvents(wardId, todayMs) {
    const qs = new URLSearchParams({ ward_id: wardId || '', today_ms: String(todayMs || 0) }).toString();
    return this._fetch(`tables/transfer_events/ward-status?${qs}`);
  },

  // 端末間チャット(1対1)。conversation_keyはUI.conversationKey()で組んだもの。
  // 古い順(created_at昇順)に並べて返す＝タイムライン表示の順序そのまま
  async getChatMessages(conversationKey) {
    if (!conversationKey) return [];
    const res = await this.getAll('chat_messages', { conversation_key: conversationKey });
    const list = (res.data || []).filter(m => m.conversation_key === conversationKey);
    return list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  },

  async getOne(table, id) {
    return this._fetch(`tables/${table}/${id}`);
  },

  // skipRevisionCheck: 患者データ等とは無関係な項目（マップ配置の座標など）だけを
  // 更新する場合に、他端末での無関係な更新と衝突して失敗するのを避けるための逃げ道。
  // 楽観的排他ロックを守るべきフィールド（patient_name等）を含む更新では使わないこと
  async create(table, data, { skipRevisionCheck = false } = {}) {
    const payload = skipRevisionCheck ? data : addExpectedMasterRevision(table, data?.id, data);
    return ensureMutationSuccess(await this._fetch(`tables/${table}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  },

  async update(table, id, data) {
    const payload = addExpectedMasterRevision(table, id, data);
    return ensureMutationSuccess(await this._fetch(`tables/${table}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  },

  async patch(table, id, data, { skipRevisionCheck = false } = {}) {
    if (table === 'transfer_events' && data?.current_status === 'RETURNED') {
      return this.updateEventStatus(id, 'RETURNED', {}, CONFIG.STATUS_SCOPE.WARD, data.expectedStatus || null);
    }
    const payload = skipRevisionCheck ? data : addExpectedMasterRevision(table, id, data);
    return ensureMutationSuccess(await this._fetch(`tables/${table}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  },

  async bulkPatch(table, data, { skipRevisionCheck = false } = {}) {
    const payload = Array.isArray(data)
      ? (skipRevisionCheck ? data : data.map(item => addExpectedMasterRevision(table, item?.id, item)))
      : data;
    return ensureMutationSuccess(await this._fetch(`tables/${table}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  },

  async bulkUpsert(table, data) {
    const payload = Array.isArray(data)
      ? data.map(item => addExpectedMasterRevision(table, item?.id, item))
      : data;
    return ensureMutationSuccess(await this._fetch(`tables/${table}/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  },

  async remove(table, id) {
    return ensureMutationSuccess(await this._fetch(`tables/${table}/${id}`, { method: 'DELETE' }));
  },

  /* ---------- マスタ取得 ---------- */
  async getWards()      { return requireDataArray(await this.getAll('wards'), '病棟マスター'); },
  async getAllBeds()     { return requireDataArray(await this.getAll('beds'), '病床マスター'); },
  async getExamRooms()  { return requireDataArray(await this.getAll('exam_rooms'), '検査室マスター'); },
  async getExamTypes()  { return requireDataArray(await this.getAll('exam_types'), '検査種別'); },
  async getPickupAssistanceTypes() { return requireDataArray(await this.getAll('pickup_assistance_types'), 'お迎え介助マスター'); },
  async getAllStaffs() { return requireDataArray(await this.getAll('staffs'), 'スタッフマスター'); },

  /* ---------- 出棟イベント ---------- */
  async getActiveEvents(wardId) {
    const res = await this.getAll('transfer_events', { ward_id: wardId || '' });
    return res.data.filter(e =>
      e.ward_id === wardId &&
      CONFIG.ACTIVE_STATUSES.includes(e.current_status)
    );
  },

  async getAllEventsForWard(wardId) {
    const res = await this.getAll('transfer_events', { ward_id: wardId || '' });
    return requireDataArray(res, '移送履歴');
  },

  // 検査室一覧グリッド用の病棟横断集計データ。患者情報を含むイベント本体ではなく、
  // exam_room_id/current_statusだけを専用エンドポイントから取得する。
  async getExamRoomGridStatus() {
    const res = await this._fetch('tables/transfer_events/exam-room-grid-status');
    return requireDataArray(res, '検査室一覧ステータス');
  },

  // 指定病床の過去(帰棟済み/キャンセル)の移送履歴を新しい順で返す。
  // 進行中のイベントは対象外(excludeEventIdは念のための二重防御)
  async getPastEventsForBed(bedId, _wardId, excludeEventId = null) {
    const res = await this.getAll('transfer_events', { bed_id: bedId || '', completed_only: 'true' });
    return requireDataArray(res, '病床履歴')
      .filter(e => String(e.bed_id) === String(bedId) && String(e.id) !== String(excludeEventId || '') &&
        (e.current_status === 'RETURNED' || e.current_status === 'CANCELLED'))
      .sort((a, b) => (b.returned_at || b.created_at || 0) - (a.returned_at || a.created_at || 0));
  },

  // 指定病床の在室記録を新しい順で返す。検査室への移送有無に関わらず入院〜退院の
  // 滞在を記録するため、transfer_eventsに現れない在室も追跡できる。
  // 現在も在室中(ended_at===null)のレコードも含める。除外すると、現在の入院中に
  // 既に完了した移送が「どの滞在にも属さない孤立イベント」として表示され、
  // グルーピングが機能しなくなるため（_mergeBedHistory参照）。
  // bed_idはサーバー側でも絞り込まれるが、絞り込み未対応の親機に接続した場合の
  // 保険としてクライアント側のフィルタも残す（二重に絞っても結果は変わらない）
  async getOccupancyHistoryForBed(bedId) {
    const res = await this.getAll('bed_occupancy_log', { bed_id: bedId });
    return (res.data || [])
      .filter(o => String(o.bed_id) === String(bedId))
      .sort((a, b) => (b.ended_at ?? Number.MAX_SAFE_INTEGER) - (a.ended_at ?? Number.MAX_SAFE_INTEGER));
  },

  async getScheduleFeeds() {
    const res = await this.getAll('schedule_feeds');
    return res.data || [];
  },

  async getScheduleItemsForRange(dayStartMs, dayEndMs) {
    const res = await this.getAll('schedule_items', { start_ms: String(dayStartMs), end_ms: String(dayEndMs) });
    return (res.data || []).filter(item =>
      item.start_ms != null && item.start_ms >= dayStartMs && item.start_ms < dayEndMs
    );
  },

  async getExamRoomStatus(roomId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const qs = new URLSearchParams({
      exam_room_id: roomId || '',
      today_ms: String(today.getTime()),
    }).toString();
    const res = await this._fetch(`tables/transfer_events/exam-room-status?${qs}`);
    return {
      events: requireDataArray(res, '検査室の進捗情報'),
      recentStatusLogs: Array.isArray(res?.recentStatusLogs) ? res.recentStatusLogs : [],
      recentAnnouncements: Array.isArray(res?.recentAnnouncements) ? res.recentAnnouncements : [],
    };
  },

  async getEventsForExamRoom(roomId) {
    const result = await this.getExamRoomStatus(roomId);
    return result.events;
  },

  async createEvent(data) {
    const result = await this.create('transfer_events', data);
    if (result && result.success === false) {
      const err = new Error(result.message || 'Event creation failed');
      err.conflict = !!result.conflict;
      err.conflictType = result.conflictType || '';
      err.currentStatus = result.currentStatus || null;
      err.existingEventId = result.existingEventId || null;
      throw err;
    }
    return result;
  },

  async startTransfer(data) {
    const result = await this._fetch('transfer/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (result && result.success !== false) return result;

    // 親機を先に更新できない一時的な構成では、旧テーブルAPIへ限定的にフォールバックする。
    if (result?.message === 'Not Found') {
      const now = Date.now();
      const requestedDuration = Number(data.expectedDurationMin);
      const durationMin = Math.min(
        300,
        Math.max(5, Math.round(Number.isFinite(requestedDuration) ? requestedDuration : 30))
      );
      const event = {
        id: data.eventId,
        bed_id: data.bedId,
        ward_id: data.wardId,
        exam_type_id: data.examTypeId,
        exam_room_id: data.examRoomId,
        escort_staff_id: data.escortStaffId || null,
        current_status: 'MOVING',
        expected_duration_min: durationMin,
        estimated_pickup_at: now + durationMin * 60 * 1000,
        note: data.note || '',
        patient_name: data.patientName || null,
        patient_id: data.patientId || null,
        patient_ic_tag_id: data.patientIcTagId || null,
        registered_at: now,
        created_at: now,
        departed_at: now,
        arrived_at: null,
        exam_started_at: null,
        nearly_done_at: null,
        pickup_ready_at: null,
        returned_at: null,
      };
      let storedEvent = event;
      try {
        await this.createEvent(event);
      } catch (createError) {
        const existing = await this.getOne('transfer_events', event.id).catch(() => null);
        if (
          !existing ||
          String(existing.bed_id) !== String(event.bed_id) ||
          !CONFIG.ACTIVE_STATUSES.includes(existing.current_status)
        ) {
          throw createError;
        }
        storedEvent = existing;
      }

      const logs = await this.getStatusLogs(event.id).catch(() => []);
      if (!logs.some(log => !log.from_status && ['MOVING', 'DEPART_REGISTERED'].includes(log.to_status))) {
        await this.addStatusLog(event.id, 'MOVING', 'MOVING', '移送を開始しました');
      }
      return { success: true, fallback: true, event: storedEvent };
    }

    const err = new Error(result?.message || 'Transfer start failed');
    err.conflict = !!result?.conflict;
    err.conflictType = result?.conflictType || '';
    err.currentStatus = result?.currentStatus || null;
    err.existingEventId = result?.existingEventId || null;
    throw err;
  },

  async updateEventStatus(eventId, newStatus, extraFields = {}, scope = CONFIG.STATUS_SCOPE.WARD, expectedStatus = null, source = null) {
    // 完了/中止した移送にICカードの紐づけを残さないよう、RETURNED/CANCELLEDでは
    // patient_ic_tag_idを既定でクリアする。呼び出し元ごとに個別実装すると
    // タイムライン・carryover等で対応漏れが起きるため、ここに一元化する
    // (呼び出し元がextraFieldsで明示的に指定していればそちらを優先する)
    const mergedExtraFields = (newStatus === 'RETURNED' || newStatus === 'CANCELLED')
      ? { patient_ic_tag_id: null, ...extraFields }
      : extraFields;
    const result = await this._fetch('status/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, newStatus, extraFields: mergedExtraFields, scope, expectedStatus, source }),
    });
    if (result && result.success === false) {
      const err = new Error(result.message || 'Status update failed');
      err.conflict = !!result.conflict;
      err.conflictType = result.conflictType || '';
      err.expectedStatus = result.expectedStatus || expectedStatus || null;
      err.currentStatus = result.currentStatus || null;
      err.event = result.event || null;
      throw err;
    }
    return result;
  },

  // 互換API名。以前はstatus/updateのmaintenanceフラグで任意の進行中状態を
  // RETURNEDにしていたが、現在は通常の遷移検証を必ず通す。
  async completeEventForMaintenance(eventId, expectedStatus = null) {
    return this.updateEventStatus(eventId, 'RETURNED', {}, CONFIG.STATUS_SCOPE.WARD, expectedStatus, 'maintenance');
  },

  /* ---------- 操作監査ログ (データ #2) ---------- */
  async patchEventFields(eventId, fields = {}, expectedStatus = null) {
    const payload = expectedStatus ? { ...fields, expectedStatus } : { ...fields };
    const result = await this.patch('transfer_events', eventId, payload);
    if (result && result.success === false) {
      const err = new Error(result.message || 'Event update failed');
      err.conflict = !!result.conflict;
      err.conflictType = result.conflictType || '';
      err.expectedStatus = result.expectedStatus || expectedStatus || null;
      err.currentStatus = result.currentStatus || null;
      err.event = result.event || null;
      throw err;
    }
    return result;
  },

  async writeAuditLog(action, { targetType = '', targetId = null, staffId = null, details = {} } = {}) {
    try {
      return await this._fetch('audit/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, targetType, targetId, staffId, details }),
      });
    } catch (e) {
      console.warn('[AuditLog] 書き込み失敗:', e);
      return { success: false, skipped: true, message: e.message };
    }
  },

  /* ---------- 状態ログ ---------- */
  async addStatusLog(eventId, fromStatus, toStatus, changedBy = 'user') {
    if (fromStatus !== toStatus) {
      throw new Error('状態変更ログは status/update を通じて記録してください');
    }
    return ensureMutationSuccess(await this._fetch('status/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, expectedStatus: fromStatus || null, note: String(changedBy || '') }),
    }));
  },

  async acknowledgeStatusLog(logId, wardId) {
    return ensureMutationSuccess(await this._fetch('status/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logId, wardId }),
    }));
  },

  async getStatusLogs(eventId) {
    const res = await this.getAll('transfer_status_logs', { transfer_event_id: eventId || '' });
    return res.data
      .filter(l => l.transfer_event_id === eventId)
      .sort((a, b) => b.changed_at - a.changed_at);
  },

  async getAllStatusLogs(wardId = '') {
    const res = await this.getAll('transfer_status_logs', { ward_id: wardId || '' });
    return requireDataArray(res, '状態変更ログ').sort((a, b) => b.changed_at - a.changed_at);
  },

  /* ---------- 通話 ---------- */
  async getCallHistory() {
    const res = await this.getAll('calls');
    return res.data.sort((a, b) => b.started_at - a.started_at).slice(0, 20);
  },

  /* ---------- WebRTCシグナリング ---------- */
  async webrtcSend(msg) {
    const apiToken = await getTerminalApiToken();

    if (isClientMode()) {
      return parentFetch(buildParentApiUrl('webrtc/send'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiToken ? { 'X-API-Token': apiToken } : {}),
        },
        body: JSON.stringify(msg)
      }, API_SIGNALING_TIMEOUT_MS).then(r => r.json());
    }

    if (window.electronAPI && window.electronAPI.webrtcRequest) {
      return window.electronAPI.webrtcRequest({
        url: '/webrtc/send',
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg)
        }
      });
    }

    return fetchWithTimeout('/api/webrtc/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg)
    }, API_SIGNALING_TIMEOUT_MS).then(r => r.json());
  },

  async webrtcPoll(myId, clientId = '') {
    const apiToken = await getTerminalApiToken();
    const qs = new URLSearchParams({ id: myId, client: clientId || myId }).toString();

    if (isClientMode()) {
      return parentFetch(buildParentApiUrl(`webrtc/poll?${qs}`), {
        headers: apiToken ? { 'X-API-Token': apiToken } : {},
      }, API_SIGNALING_TIMEOUT_MS)
        // res.okを見ないと401のJSONが正常な空ポーリングとして扱われ、
        // トークン不一致の子機で着信が一切鳴らないまま無警告になる
        .then(assertParentResponseOk);
    }

    if (window.electronAPI && window.electronAPI.webrtcRequest) {
      return window.electronAPI.webrtcRequest({
        url: `/webrtc/poll?${qs}`,
        options: { method: 'GET' }
      });
    }

    return fetchWithTimeout(`/api/webrtc/poll?${qs}`, {}, API_SIGNALING_TIMEOUT_MS)
      .then(r => r.json());
  },

  /* ---------- デバイス管理（子機→親機ハートビート） ---------- */
  async deviceHeartbeat(info) {
    if (isClientMode()) {
      const apiToken = await getTerminalApiToken();
      return parentFetch(buildParentApiUrl('device/heartbeat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiToken ? { 'X-API-Token': apiToken } : {}),
        },
        body: JSON.stringify(info)
        // 401を成功として扱うと、10秒ごとのハートビートが「接続中」を報告し、
        // 5秒ポーリングが上げたトークン不一致バナーを打ち消してしまう。
        // 失敗の理由(認証エラーかどうか)は呼び出し元のバナー表示に必要なので保持する。
      }, API_HEARTBEAT_TIMEOUT_MS)
        .then(assertParentResponseOk)
        .catch(e => (e?.unauthorized ? { success: false, unauthorized: true } : null));
    }
    // 親機自身も他端末から在席を確認できるよう、ローカルIPC経由で自分を登録する
    if (window.electronAPI) {
      return window.electronAPI.dbRequest({ url: 'device/heartbeat', options: { method: 'POST', body: JSON.stringify(info) } }).catch(() => null);
    }
    return null;
  },

  async getConnectedDevices() {
    const apiToken = await getTerminalApiToken();
    if (isClientMode()) {
      return parentFetch(buildParentApiUrl('device/list'), {
        headers: apiToken ? { 'X-API-Token': apiToken } : {},
      }, API_HEARTBEAT_TIMEOUT_MS).then(assertParentResponseOk);
    }
    if (window.electronAPI) {
      return window.electronAPI.dbRequest({ url: 'device/list', options: { method: 'GET' } }).catch(() => ({ success: false, devices: [] }));
    }
    return { success: false, devices: [] };
  },

  async disconnectDevice(deviceId) {
    if (isClientMode()) {
      const apiToken = await getTerminalApiToken();
      return parentFetch(buildParentApiUrl('device/disconnect'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiToken ? { 'X-API-Token': apiToken } : {}),
        },
        body: JSON.stringify({ deviceId }),
      }, API_HEARTBEAT_TIMEOUT_MS).then(r => r.json());
    }
    // 親機自身の画面から切断する場合、HTTP経由ではなくローカルIPCで直接処理する
    // (以前はここが未実装で常にundefinedを返し、呼び出し元が誤って
    // 「削除しました」と成功トーストを出していた)
    if (window.electronAPI) {
      return window.electronAPI.dbRequest({ url: 'device/disconnect', options: { method: 'POST', body: JSON.stringify({ deviceId }) } }).catch(() => ({ success: false }));
    }
    return { success: false };
  },

  async parentAction(action, payload = {}, { method = 'POST', timeoutMs = API_DEFAULT_TIMEOUT_MS } = {}) {
    if (!isClientMode()) {
      throw new Error('parentAction is only for child terminals');
    }
    const apiToken = await getTerminalApiToken();
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiToken ? { 'X-API-Token': apiToken } : {}),
      },
    };
    if (method !== 'GET') options.body = JSON.stringify(payload || {});
    const res = await parentFetch(buildParentApiUrl(`parent-actions/${action}`), options, timeoutMs);
    const data = await res.json().catch(() => ({ success: false, message: `HTTP ${res.status}` }));
    if (!res.ok || data.unauthorized) {
      const err = new Error(data.message || `HTTP ${res.status}`);
      if (res.status === 401 || data.unauthorized) err.unauthorized = true;
      throw err;
    }
    return data;
  }
};
