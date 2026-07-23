/**
 * TransBoard - APIクライアント
 * RESTful Table API ラッパー
 */

const API_DEFAULT_TIMEOUT_MS = 8000;
const API_SIGNALING_TIMEOUT_MS = 5000;
const API_HEARTBEAT_TIMEOUT_MS = 4000;

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
    const result = await window.electronAPI.parentHttpRequest({
      url,
      method: (options.method || 'GET').toUpperCase(),
      headers: options.headers || {},
      body: options.body,
      timeoutMs,
    });
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

const API = {

  /* ---------- 汎用フェッチ ---------- */
  async _fetch(url, options = {}) {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';

    if (shareMode === 'client' || shareMode === 'child') {
      try {
        const cleanUrl = url.replace(/^\//, '');
        const apiToken = localStorage.getItem('cfg_api_token') || '';
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

  async getAll(table, params = {}) {
    const qs = new URLSearchParams({ limit: 200, ...params }).toString();
    return this._fetch(`tables/${table}?${qs}`);
  },

  async getWardStatusEvents(wardId, todayMs) {
    const qs = new URLSearchParams({ ward_id: wardId || '', today_ms: String(todayMs || 0) }).toString();
    return this._fetch(`tables/transfer_events/ward-status?${qs}`);
  },

  async getOne(table, id) {
    return this._fetch(`tables/${table}/${id}`);
  },

  async create(table, data) {
    return this._fetch(`tables/${table}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  },

  async update(table, id, data) {
    return this._fetch(`tables/${table}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  },

  async patch(table, id, data) {
    return this._fetch(`tables/${table}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  },

  async bulkPatch(table, data) {
    return this._fetch(`tables/${table}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  },

  async remove(table, id) {
    return this._fetch(`tables/${table}/${id}`, { method: 'DELETE' });
  },

  /* ---------- マスタ取得 ---------- */
  async getWards()      { return (await this.getAll('wards')).data; },
  async getBeds(wardId) {
    const res = await this.getAll('beds');
    return res.data.filter(b => b.ward_id === wardId);
  },
  async getAllBeds()     { return (await this.getAll('beds')).data; },
  async getBedTypes()    { return (await this.getAll('bed_types')).data; },
  async getExamRooms()  { return (await this.getAll('exam_rooms')).data; },
  async getExamTypes()  { return (await this.getAll('exam_types')).data; },
  async getStaffs(wardId) {
    const res = await this.getAll('staffs');
    return res.data.filter(s => s.is_active && (!wardId || s.ward_id === wardId));
  },

  /* ---------- 申し送りメモ ---------- */
  async getHandoverNotes(wardId) {
    const res = await this.getAll('handover_notes');
    const list = (res.data || []).filter(n => !wardId || n.ward_id === wardId);
    return list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  },

  /* ---------- 出棟イベント ---------- */
  async getActiveEvents(wardId) {
    const res = await this.getAll('transfer_events');
    return res.data.filter(e =>
      e.ward_id === wardId &&
      CONFIG.ACTIVE_STATUSES.includes(e.current_status)
    );
  },

  async getAllEventsForWard(wardId) {
    const res = await this.getAll('transfer_events');
    return res.data.filter(e => e.ward_id === wardId);
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
      // 完了・キャンセルは、移動中で記録される departed_at に加えて出棟登録時刻 created_at でも当日判定する
      // （移動中を記録しない運用でも当日分を取りこぼさない）
      return (e.departed_at != null && e.departed_at >= todayMs) ||
             (e.created_at != null && e.created_at >= todayMs);
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
    return this.create('transfer_events', data);
  },

  async updateEventStatus(eventId, newStatus, extraFields = {}) {
    const now = Date.now();
    const statusTimeMap = {
      MOVING: 'departed_at',
      ARRIVED: 'arrived_at',
      IN_EXAM: 'exam_started_at',
      NEARLY_DONE: 'nearly_done_at',
      PICKUP_REQUIRED: 'pickup_ready_at',
      RETURNED: 'returned_at',
    };
    // ログ用・タイムスタンプ補完用に遷移前のイベントを取得
    let current = null;
    let fromStatus = null;
    try {
      current = await this.getOne('transfer_events', eventId);
      if (current && current.current_status) fromStatus = current.current_status;
    } catch (e) { /* 取得失敗時はnullのまま */ }

    const patch = { current_status: newStatus, ...extraFields };
    if (statusTimeMap[newStatus]) {
      patch[statusTimeMap[newStatus]] = now;
    }
    // 検査開始時に到着記録が無ければ補完する。病棟が「到着」を飛ばして直接「検査開始」した場合でも
    // arrived_at を失わず、移動時間メトリクスが取りこぼされないようにする（到着は検査開始の前提）。
    if (newStatus === 'IN_EXAM' && current && current.arrived_at == null) {
      patch.arrived_at = now;
    }
    // NEARLY_DONEの場合、設定値に基づいて迎え目安を再計算
    if (newStatus === 'NEARLY_DONE') {
      const ndMin = AppState.getSettingInt('nearly_done_minutes', 10);
      patch.estimated_pickup_at = now + (ndMin > 0 ? ndMin : 10) * 60 * 1000;
    }

    const updated = await this.patch('transfer_events', eventId, patch);
    // ログを記録
    await this.addStatusLog(eventId, fromStatus, newStatus, 'UI操作');

    // 状態変化による自動音声合成アナウンスのシグナリング送信
    try {
      const event = await this.getOne('transfer_events', eventId);
      await this.sendStatusAnnouncement(event, newStatus);
    } catch(err) {
      console.error('[Speech Signal Error]', err);
    }

    return updated;
  },

  // 状態変化時の自動音声合成アナウンス送信。updateEventStatus からの遷移だけでなく、
  // 出棟登録時点でMOVINGとして作成する場合（modal.js _submitDepart）からも呼べるよう
  // eventオブジェクトを直接受け取る形で切り出している
  async sendStatusAnnouncement(event, newStatus) {
    if (!event) return;
    const bed = AppState.getBedById(event.bed_id);
    const bedName = bed ? `${bed.bed_number}号床` : '患者';
    const room = AppState.getExamRoomById(event.exam_room_id);
    const roomName = room ? room.name : '検査室';
    const ward = AppState.wards.find(w => w.id === event.ward_id);
    const wardName = ward ? ward.name : '病棟';

    // 患者名を読み上げに含めるかは施設の設定次第（既定は含めない）。
    // 有効時は文頭に付与し、聞き逃しにくくする
    const announceName = AppState.systemSettings?.find(s => s.id === 'announce_patient_name')?.value === 'true';
    const namePrefix = announceName && bed?.patient_name ? `${bed.patient_name}さん、` : '';

    let speechText = '';
    let toId = '';
    let fromId = '';

    if (newStatus === 'MOVING') {
      speechText = `${namePrefix}${wardName}から、${bedName}が、${roomName}へ移動を開始しました。`;
      toId = event.exam_room_id;
      fromId = event.ward_id;
    } else if (newStatus === 'ARRIVED') {
      speechText = `${namePrefix}${roomName}に、${bedName}が到着しました。`;
      toId = event.ward_id;
      fromId = event.exam_room_id;
    } else if (newStatus === 'PICKUP_REQUIRED') {
      speechText = `${namePrefix}${roomName}から、${bedName}のお迎え要請です。`;
      toId = event.ward_id;
      fromId = event.exam_room_id;
    }

    if (speechText && toId) {
      await this.webrtcSend({
        from: fromId,
        to: toId,
        type: 'speech',
        text: speechText
      });
    }
  },

  /* ---------- 操作監査ログ (データ #2) ---------- */
  async writeAuditLog(action, { targetType = '', targetId = null, staffId = null, details = {} } = {}) {
    try {
      await this.create('audit_logs', {
        id: `al-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        action,
        target_type: targetType,
        target_id: targetId,
        staff_id: staffId,
        details: JSON.stringify(details),
        created_at: Date.now(),
      });
    } catch (e) {
      console.warn('[AuditLog] 書き込み失敗:', e);
    }
  },

  /* ---------- 状態ログ ---------- */
  async addStatusLog(eventId, fromStatus, toStatus, changedBy = 'user') {
    return this.create('transfer_status_logs', {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      transfer_event_id: eventId,
      from_status: fromStatus,
      to_status: toStatus,
      changed_by: changedBy,
      changed_at: Date.now(),
      note: '',
    });
  },

  async getStatusLogs(eventId) {
    const res = await this.getAll('transfer_status_logs');
    return res.data
      .filter(l => l.transfer_event_id === eventId)
      .sort((a, b) => b.changed_at - a.changed_at);
  },

  async getAllStatusLogs() {
    const res = await this.getAll('transfer_status_logs');
    return res.data.sort((a, b) => b.changed_at - a.changed_at);
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

    if (shareMode === 'client' || shareMode === 'child') {
      return parentFetch(`http://${parentIp}:3005/api/webrtc/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Token': localStorage.getItem('cfg_api_token') || '' },
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
    const qs = new URLSearchParams({ id: myId, client: clientId || myId }).toString();

    if (shareMode === 'client' || shareMode === 'child') {
      return parentFetch(`http://${parentIp}:3005/api/webrtc/poll?${qs}`, {
        headers: { 'X-API-Token': localStorage.getItem('cfg_api_token') || '' }
      }, API_SIGNALING_TIMEOUT_MS).then(r => r.json());
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
    if (shareMode !== 'client' && shareMode !== 'child') return;
    return parentFetch(`http://${parentIp}:3005/api/device/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(info)
    }, API_HEARTBEAT_TIMEOUT_MS).then(r => r.json()).catch(() => null);
  },

  async getConnectedDevices() {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
    if (shareMode === 'client' || shareMode === 'child') {
      return parentFetch(`http://${parentIp}:3005/api/device/list`, {}, API_HEARTBEAT_TIMEOUT_MS).then(r => r.json());
    }
    if (window.electronAPI) {
      return window.electronAPI.dbRequest({ url: 'device/list', options: { method: 'GET' } }).catch(() => ({ success: false, devices: [] }));
    }
    return { success: false, devices: [] };
  },

  async disconnectDevice(deviceId) {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
    const url = (shareMode === 'client' || shareMode === 'child')
      ? `http://${parentIp}:3005/api/device/disconnect`
      : null;
    if (url) {
      return parentFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }) }, API_HEARTBEAT_TIMEOUT_MS).then(r => r.json());
    }
  }
};
