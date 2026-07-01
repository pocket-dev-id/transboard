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

  // アクティブイベント (現在の病棟)
  activeEvents: [],

  // 本日全イベント (タイムライン用)
  todayEvents: [],

  // 汎用スケジュールアイテム (タイムライン用)
  scheduleItems: [],

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
};
