/**
 * TransBoard - グローバル状態管理
 */

const AppState = {
  // 選択中の病棟
  currentWardId: 'ward-1',

  // 選択中の検査室
  currentExamRoomId: null,

  // マスタキャッシュ
  beds: [],
  bedTypes: [],
  examRooms: [],
  examTypes: [],
  staffs: [],
  wards: [],
  stickyNotes: [],
  handoverNotes: [],

  // アクティブイベント (現在の病棟)
  activeEvents: [],

  // 本日全イベント (タイムライン用)
  todayEvents: [],

  // 汎用スケジュールアイテム (タイムライン用)
  scheduleItems: [],

  scheduleFeeds: [],

  // 全イベント (履歴用)
  allEvents: [],

  // 状態ログ
  statusLogs: [],

  // 通話状態
  callState: {
    active: false,
    callId: null,
    target: null,
    status: 'idle', // idle | calling | connected | ended
    startTime: null,
    timerInterval: null,
  },

  // ポーリングタイマー
  pollTimer: null,

  // 最終更新時刻
  lastUpdated: null,

  /* ---------- ヘルパー ---------- */

  getBedById(id) {
    return this.beds.find(b => b.id === id);
  },

  getBedTypeByCode(code) {
    const normalized = this.normalizeBedTypeCode(code);
    return this.bedTypes.find(t => t.code === normalized || t.id === normalized);
  },

  normalizeBedTypeCode(code) {
    const map = { '一般': 'normal', '隔離': 'isolation', 'ICU': 'icu' };
    return map[code] || code || 'normal';
  },

  getBedTypeLabel(code) {
    const normalized = this.normalizeBedTypeCode(code);
    const type = this.getBedTypeByCode(normalized);
    return type ? type.name : (code || normalized);
  },

  getExamTypeById(id) {
    return (this.allExamTypes || this.examTypes).find(t => t.id === id);
  },

  getExamRoomById(id) {
    return this.examRooms.find(r => r.id === id);
  },

  getStaffById(id) {
    return this.staffs.find(s => s.id === id);
  },

  getActiveEventForBed(bedId) {
    return this.activeEvents.find(e => e.bed_id === bedId);
  },

  getEventForBed(bedId) {
    // アクティブ + 本日の帰棟済/キャンセル
    return this.todayEvents.find(e => e.bed_id === bedId);
  },

  /* ---------- サブスクライバーパターン ---------- */
  // コンポーネントが特定のデータキーの変更を購読できるようにする
  // 戻り値は購読解除関数
  _subscribers: {},

  subscribe(key, callback) {
    if (!this._subscribers[key]) this._subscribers[key] = new Set();
    this._subscribers[key].add(callback);
    return () => this._subscribers[key].delete(callback);
  },

  // データ更新後に呼ぶことで、そのキーを購読しているコンポーネントを再描画させる
  notify(key) {
    const subs = this._subscribers[key];
    if (!subs) return;
    subs.forEach(cb => {
      try { cb(); } catch (e) { console.error(`[AppState.notify:${key}]`, e); }
    });
  },

  // サマリー計算
  getSummary() {
    const events = this.activeEvents;
    const now = Date.now();
    const soonMs = CONFIG.SOON_THRESHOLD_MIN * 60 * 1000;

    let depart = 0, escort = 0, pickup = 0, soon = 0, delay = 0;
    for (const e of events) {
      if (CONFIG.DEPART_STATUSES.includes(e.current_status)) depart++;
      if (e.escort_staff_id) escort++;
      if (e.current_status === 'PICKUP_REQUIRED') pickup++;
      if (e.estimated_pickup_at) {
        const remaining = e.estimated_pickup_at - now;
        if (remaining > 0 && remaining <= soonMs) soon++;
        if (remaining < 0 && e.current_status !== 'RETURNED' && e.current_status !== 'CANCELLED') delay++;
      }
    }
    return { depart, escort, pickup, soon, delay };
  },

  // 優先一覧: 迎え要→あと10分→残り時間短い順
  getPriorityList() {
    const now = Date.now();
    const items = this.activeEvents
      .filter(e => CONFIG.DEPART_STATUSES.includes(e.current_status))
      .map(e => {
        const bed = this.getBedById(e.bed_id);
        const examType = this.getExamTypeById(e.exam_type_id);
        const examRoom = this.getExamRoomById(e.exam_room_id);
        const remaining = e.estimated_pickup_at ? e.estimated_pickup_at - now : null;
        let priorityScore = 99;
        if (e.current_status === 'PICKUP_REQUIRED') priorityScore = 0;
        else if (e.current_status === 'NEARLY_DONE') priorityScore = 1;
        else if (remaining !== null && remaining < 0) priorityScore = 2;
        else if (remaining !== null && remaining < CONFIG.SOON_THRESHOLD_MIN * 60 * 1000) priorityScore = 3;
        else priorityScore = 10 + (remaining !== null ? remaining / 60000 : 999);
        return { event: e, bed, examType, examRoom, remaining, priorityScore };
      })
      .sort((a, b) => a.priorityScore - b.priorityScore);
    return items;
  },

  // 日跨ぎ（帰棟し忘れ等で日付をまたいで残った）未完了の出棟を返す。
  // 基準時刻(departed_at || created_at)が本日0:00より前のアクティブ移送が対象。
  // タイムスタンプが無いものは判定不能として対象外（安全側）。
  getCarriedOverEvents() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    return this.activeEvents.filter(e => {
      if (!CONFIG.ACTIVE_STATUSES.includes(e.current_status)) return false;
      const ref = e.departed_at || e.created_at || 0;
      return ref > 0 && ref < todayMs;
    });
  },

  /* ---------- system_settings 読み取りヘルパー（コード#1: 重複ボイラープレート排除） ---------- */
  getSettingRaw(id, fallback = null) {
    const s = this.systemSettings?.find(x => x.id === id);
    return s ? s.value : fallback;
  },
  getSettingJSON(id, fallback) {
    try {
      const raw = this.getSettingRaw(id);
      return raw != null ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  getSettingInt(id, fallback) {
    const raw = this.getSettingRaw(id);
    const n = parseInt(raw, 10);
    return isNaN(n) ? fallback : n;
  },
  getSettingBool(id, fallback) {
    const raw = this.getSettingRaw(id);
    return raw == null ? fallback : raw !== 'false';
  },
};
