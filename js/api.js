/**
 * TransBoard - APIクライアント
 * RESTful Table API ラッパー
 */

const API = {

  /* ---------- 汎用フェッチ ---------- */
  async _fetch(url, options = {}) {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';

    if (shareMode === 'client' || shareMode === 'child') {
      try {
        const cleanUrl = url.replace(/^\//, '');
        const res = await fetch(`http://${parentIp}:3005/api/${cleanUrl}`, options);
        if (res.status === 204) return null;
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
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
      const res = await fetch(url, options);
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
    const patch = { current_status: newStatus, ...extraFields };
    if (statusTimeMap[newStatus]) {
      patch[statusTimeMap[newStatus]] = now;
    }
    // あと10分の場合、迎え目安を再計算
    if (newStatus === 'NEARLY_DONE') {
      patch.estimated_pickup_at = now + 10 * 60 * 1000;
    }
    // ログ用に遷移前のステータスを取得
    let fromStatus = null;
    try {
      const current = await this.getOne('transfer_events', eventId);
      if (current && current.current_status) fromStatus = current.current_status;
    } catch (e) { /* 取得失敗時はnullのまま */ }

    const updated = await this.patch('transfer_events', eventId, patch);
    // ログを記録
    await this.addStatusLog(eventId, fromStatus, newStatus, 'UI操作');

    // 状態変化による自動音声合成アナウンスのシグナリング送信
    try {
      const event = await this.getOne('transfer_events', eventId);
      if (event) {
        const bed = AppState.getBedById(event.bed_id);
        const bedName = bed ? `${bed.bed_number}号床` : '患者';
        const room = AppState.getExamRoomById(event.exam_room_id);
        const roomName = room ? room.name : '検査室';
        const ward = AppState.wards.find(w => w.id === event.ward_id);
        const wardName = ward ? ward.name : '病棟';

        let speechText = '';
        let toId = '';
        let fromId = '';

        if (newStatus === 'MOVING') {
          speechText = `${wardName}から、${bedName}が、${roomName}へ移動を開始しました。`;
          toId = event.exam_room_id;
          fromId = event.ward_id;
        } else if (newStatus === 'ARRIVED') {
          speechText = `${roomName}に、${bedName}が到着しました。`;
          toId = event.ward_id;
          fromId = event.exam_room_id;
        } else if (newStatus === 'PICKUP_REQUIRED') {
          speechText = `${roomName}から、${bedName}のお迎え要請です。`;
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
      }
    } catch(err) {
      console.error('[Speech Signal Error]', err);
    }

    return updated;
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
      return fetch(`http://${parentIp}:3005/api/webrtc/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg)
      }).then(r => r.json());
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

    return fetch('/api/webrtc/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg)
    }).then(r => r.json());
  },

  async webrtcPoll(myId) {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';

    if (shareMode === 'client' || shareMode === 'child') {
      return fetch(`http://${parentIp}:3005/api/webrtc/poll?id=${encodeURIComponent(myId)}`)
        .then(r => r.json());
    }

    if (window.electronAPI && window.electronAPI.webrtcRequest) {
      return window.electronAPI.webrtcRequest({
        url: `/webrtc/poll?id=${encodeURIComponent(myId)}`,
        options: { method: 'GET' }
      });
    }

    return fetch(`/api/webrtc/poll?id=${encodeURIComponent(myId)}`)
      .then(r => r.json());
  },

  /* ---------- デバイス管理（子機→親機ハートビート） ---------- */
  async deviceHeartbeat(info) {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
    if (shareMode !== 'client' && shareMode !== 'child') return;
    return fetch(`http://${parentIp}:3005/api/device/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(info)
    }).then(r => r.json()).catch(() => null);
  },

  async getConnectedDevices() {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const parentIp = localStorage.getItem('cfg_parent_ip') || 'localhost';
    if (shareMode === 'client' || shareMode === 'child') {
      return fetch(`http://${parentIp}:3005/api/device/list`).then(r => r.json());
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
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }) }).then(r => r.json());
    }
  }
};
