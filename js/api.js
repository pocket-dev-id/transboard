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

let terminalApiTokenCache = null;

function ensureMutationSuccess(result) {
  if (result && result.success === false) {
    const error = new Error(result.message || 'データ更新に失敗しました');
    if (result.conflict) error.conflict = true;
    throw error;
  }
  return result;
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
  'wards', 'beds', 'bed_types', 'exam_rooms', 'exam_types', 'staffs', 'system_settings',
]);

function getLocalMasterUpdatedAt(table, id) {
  if (!MASTER_REVISION_TABLES.has(table)) return undefined;
  const stateKey = {
    wards: 'wards',
    beds: 'beds',
    bed_types: 'allBedTypes',
    exam_rooms: 'allExamRooms',
    exam_types: 'allExamTypes',
    staffs: 'staffs',
    system_settings: 'systemSettings',
  }[table];
  try {
    const records = typeof AppState !== 'undefined' ? AppState[stateKey] : null;
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
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';

    if (shareMode === 'client' || shareMode === 'child') {
      try {
        const cleanUrl = url.replace(/^\//, '');
        const apiToken = await getTerminalApiToken();
        const optionsWithToken = apiToken
          ? { ...options, headers: { ...(options.headers || {}), 'X-API-Token': apiToken } }
          : options;
        const res = await parentFetch(`http://${parentIp}:3005/api/${cleanUrl}`, optionsWithToken);
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
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    if (shareMode === 'client' || shareMode === 'child') {
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
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    if (shareMode === 'client' || shareMode === 'child') {
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
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    if (shareMode === 'client' || shareMode === 'child') {
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

  // 申し送りメモ（指定病棟、新しい順）。親機/子機ともAPI経由で取得する
  async getHandoverNotes(wardId) {
    const res = await this.getAll('handover_notes');
    const list = (res.data || []).filter(n => !wardId || n.ward_id === wardId);
    return list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  },

  async getOne(table, id) {
    return this._fetch(`tables/${table}/${id}`);
  },

  async create(table, data) {
    const payload = addExpectedMasterRevision(table, data?.id, data);
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

  async patch(table, id, data) {
    if (table === 'transfer_events' && data?.current_status === 'RETURNED') {
      return this.completeEventForMaintenance(id, data.expectedStatus || null);
    }
    const payload = addExpectedMasterRevision(table, id, data);
    return ensureMutationSuccess(await this._fetch(`tables/${table}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  },

  async bulkPatch(table, data) {
    const payload = Array.isArray(data)
      ? data.map(item => addExpectedMasterRevision(table, item?.id, item))
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
  async getBeds(wardId) {
    return (await this.getAllBeds()).filter(b => b.ward_id === wardId);
  },
  async getAllBeds()     { return requireDataArray(await this.getAll('beds'), '病床マスター'); },
  async getBedTypes()    { return requireDataArray(await this.getAll('bed_types'), '病床タイプ'); },
  async getExamRooms()  { return requireDataArray(await this.getAll('exam_rooms'), '検査室マスター'); },
  async getExamTypes()  { return requireDataArray(await this.getAll('exam_types'), '検査種別'); },
  async getStaffs(wardId) {
    return (await requireDataArray(await this.getAll('staffs'), 'スタッフマスター'))
      .filter(s => s.is_active && (!wardId || s.ward_id === wardId));
  },
  async getAllStaffs() { return requireDataArray(await this.getAll('staffs'), 'スタッフマスター'); },

  /* ---------- 出棟イベント ---------- */
  async getActiveEvents(wardId) {
    const res = await this.getAll('transfer_events');
    return res.data.filter(e =>
      e.ward_id === wardId &&
      CONFIG.ACTIVE_STATUSES.includes(e.current_status)
    );
  },

  async getAllEventsForWard(wardId) {
    const res = await this.getAll('transfer_events', { ward_id: wardId || '' });
    return requireDataArray(res, '移送履歴');
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
    const res = await this.getAll('schedule_items');
    return (res.data || []).filter(item =>
      item.start_ms != null && item.start_ms >= dayStartMs && item.start_ms < dayEndMs
    );
  },

  async getTodayEventsForWard(wardId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const res = await this.getAll('transfer_events');
    return res.data.filter(e => {
      if (e.ward_id !== wardId) return false;
      // 進行中のイベントは departed_at の有無に関わらず常に含める
      if (CONFIG.ACTIVE_STATUSES.includes(e.current_status)) return true;
      // 完了・キャンセルは今日の departed_at を基準にフィルタ
      return e.departed_at != null && e.departed_at >= todayMs;
    });
  },

  async getEventsForExamRoom(roomId) {
    const res = await this.getAll('transfer_events');
    return res.data.filter(e =>
      e.exam_room_id === roomId &&
      CONFIG.ACTIVE_STATUSES.includes(e.current_status)
    );
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

  async updateEventStatus(eventId, newStatus, extraFields = {}, scope = CONFIG.STATUS_SCOPE.WARD, expectedStatus = null) {
    const result = await this._fetch('status/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, newStatus, extraFields, scope, expectedStatus }),
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

  async completeEventForMaintenance(eventId, expectedStatus = null) {
    const result = await this._fetch('status/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        newStatus: 'RETURNED',
        scope: CONFIG.STATUS_SCOPE.WARD,
        expectedStatus,
        maintenance: true,
      }),
    });
    if (result && result.success === false) {
      const err = new Error(result.message || 'Maintenance completion failed');
      err.conflict = !!result.conflict;
      err.conflictType = result.conflictType || '';
      err.expectedStatus = result.expectedStatus || expectedStatus || null;
      err.currentStatus = result.currentStatus || null;
      err.event = result.event || null;
      throw err;
    }
    return result;
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

  async getStatusLogs(eventId) {
    const res = await this.getAll('transfer_status_logs');
    return res.data
      .filter(l => l.transfer_event_id === eventId)
      .sort((a, b) => b.changed_at - a.changed_at);
  },

  async getAllStatusLogs(wardId = '') {
    const res = await this.getAll('transfer_status_logs', { ward_id: wardId || '' });
    return requireDataArray(res, '状態変更ログ').sort((a, b) => b.changed_at - a.changed_at);
  },

  /* ---------- 通話 ---------- */
  async createCall(data) {
    return this.create('calls', {
      id: `call-${Date.now()}`,
      ...data,
      started_at: Date.now(),
      status: 'calling',
    });
  },

  async updateCall(callId, data) {
    return this.patch('calls', callId, data);
  },

  async getCallHistory() {
    const res = await this.getAll('calls');
    return res.data.sort((a, b) => b.started_at - a.started_at).slice(0, 20);
  },

  /* ---------- WebRTCシグナリング ---------- */
  async webrtcSend(msg) {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
    const apiToken = await getTerminalApiToken();

    if (shareMode === 'client' || shareMode === 'child') {
      return parentFetch(`http://${parentIp}:3005/api/webrtc/send`, {
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
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
    const apiToken = await getTerminalApiToken();
    const qs = new URLSearchParams({ id: myId, client: clientId || myId }).toString();

    if (shareMode === 'client' || shareMode === 'child') {
      return parentFetch(`http://${parentIp}:3005/api/webrtc/poll?${qs}`, {
        headers: apiToken ? { 'X-API-Token': apiToken } : {},
      }, API_SIGNALING_TIMEOUT_MS)
        .then(r => r.json());
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
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
    const apiToken = await getTerminalApiToken();
    if (shareMode !== 'client' && shareMode !== 'child') return;
    return parentFetch(`http://${parentIp}:3005/api/device/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiToken ? { 'X-API-Token': apiToken } : {}),
      },
      body: JSON.stringify(info)
    }, API_HEARTBEAT_TIMEOUT_MS).then(r => r.json()).catch(() => null);
  },

  async getConnectedDevices() {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
    const apiToken = await getTerminalApiToken();
    if (shareMode === 'client' || shareMode === 'child') {
      return parentFetch(`http://${parentIp}:3005/api/device/list`, {
        headers: apiToken ? { 'X-API-Token': apiToken } : {},
      }, API_HEARTBEAT_TIMEOUT_MS).then(r => r.json());
    }
    if (window.electronAPI) {
      return window.electronAPI.dbRequest({ url: 'device/list', options: { method: 'GET' } }).catch(() => ({ success: false, devices: [] }));
    }
    return { success: false, devices: [] };
  },

  async disconnectDevice(deviceId) {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
    const apiToken = await getTerminalApiToken();
    const url = (shareMode === 'client' || shareMode === 'child')
      ? `http://${parentIp}:3005/api/device/disconnect`
      : null;
    if (url) {
      return parentFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiToken ? { 'X-API-Token': apiToken } : {}),
        },
        body: JSON.stringify({ deviceId }),
      }, API_HEARTBEAT_TIMEOUT_MS).then(r => r.json());
    }
  },

  async parentAction(action, payload = {}, { method = 'POST', timeoutMs = API_DEFAULT_TIMEOUT_MS } = {}) {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
    const apiToken = await getTerminalApiToken();
    if (shareMode !== 'client' && shareMode !== 'child') {
      throw new Error('parentAction is only for child terminals');
    }
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiToken ? { 'X-API-Token': apiToken } : {}),
      },
    };
    if (method !== 'GET') options.body = JSON.stringify(payload || {});
    const res = await parentFetch(`http://${parentIp}:3005/api/parent-actions/${action}`, options, timeoutMs);
    const data = await res.json().catch(() => ({ success: false, message: `HTTP ${res.status}` }));
    if (!res.ok || data.unauthorized) {
      const err = new Error(data.message || `HTTP ${res.status}`);
      if (res.status === 401 || data.unauthorized) err.unauthorized = true;
      throw err;
    }
    return data;
  }
};
