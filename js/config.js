/**
 * TransBoard - 設定定数
 */

const CONFIG = {
  // ポーリング間隔 (ms)
  POLL_INTERVAL: 5000,

  // 状態定義
  STATUS: {
    IN_BED: 'IN_BED',
    DEPART_REGISTERED: 'DEPART_REGISTERED',
    MOVING: 'MOVING',
    ARRIVED: 'ARRIVED',
    IN_EXAM: 'IN_EXAM',
    NEARLY_DONE: 'NEARLY_DONE',
    PICKUP_REQUIRED: 'PICKUP_REQUIRED',
    RETURNED: 'RETURNED',
    CANCELLED: 'CANCELLED',
  },

  // 状態表示名（施設ごとのカスタム表示名で上書きされる可能性がある実行時の値）
  STATUS_LABEL: {
    IN_BED: '在床',
    DEPART_REGISTERED: '出棟登録済（旧）',
    MOVING: '移動中',
    ARRIVED: '検査室到着',
    IN_EXAM: '検査中',
    NEARLY_DONE: 'あと10分',
    PICKUP_REQUIRED: '迎え要',
    RETURNED: '帰棟済',
    CANCELLED: 'キャンセル',
  },

  // 状態表示名のデフォルト値（不変のスナップショット）
  // カスタム表示名設定画面のプレースホルダー・リセット処理など、
  // 「本来のデフォルト」を参照する必要がある箇所は STATUS_LABEL ではなくこちらを使う
  STATUS_LABEL_DEFAULTS: Object.freeze({
    IN_BED: '在床',
    DEPART_REGISTERED: '出棟登録済（旧）',
    MOVING: '移動中',
    ARRIVED: '検査室到着',
    IN_EXAM: '検査中',
    NEARLY_DONE: 'あと10分',
    PICKUP_REQUIRED: '迎え要',
    RETURNED: '帰棟済',
    CANCELLED: 'キャンセル',
  }),

  // ステータスカラーのデフォルト値（カラーピッカーの初期表示・リセット用）
  STATUS_DEFAULT_COLORS: {
    IN_BED: '#f8fafc', DEPART_REGISTERED: '#dbeafe', MOVING: '#ede9fe',
    ARRIVED: '#e0f2fe', IN_EXAM: '#fefce8', NEARLY_DONE: '#fff7ed',
    PICKUP_REQUIRED: '#fee2e2', RETURNED: '#f0fdf4', CANCELLED: '#f1f5f9',
  },

  // 状態アイコン（FontAwesome クラス名）
  // 色だけでなく形状でも状態を識別できるようにする（色覚・印刷・モノクロ画面への対応）
  STATUS_ICON: {
    IN_BED: 'fa-bed',
    DEPART_REGISTERED: 'fa-door-open',
    MOVING: 'fa-walking',
    ARRIVED: 'fa-map-marker-alt',
    IN_EXAM: 'fa-stethoscope',
    NEARLY_DONE: 'fa-clock',
    PICKUP_REQUIRED: 'fa-bell',
    RETURNED: 'fa-check-circle',
    CANCELLED: 'fa-times-circle',
  },

  // 状態遷移ルール: key = 現在状態, value = 遷移可能な次状態[]
  STATUS_TRANSITIONS: {
    IN_BED: ['MOVING'],
    DEPART_REGISTERED: ['MOVING', 'IN_EXAM', 'CANCELLED'],
    MOVING: ['ARRIVED', 'IN_EXAM', 'CANCELLED'],
    ARRIVED: ['IN_EXAM', 'CANCELLED'],
    IN_EXAM: ['NEARLY_DONE', 'PICKUP_REQUIRED', 'CANCELLED'],
    NEARLY_DONE: ['PICKUP_REQUIRED', 'CANCELLED'],
    PICKUP_REQUIRED: ['RETURNED', 'CANCELLED'],
    RETURNED: [],
    CANCELLED: [],
  },

  // 「出棟中」扱いの状態
  DEPART_STATUSES: ['DEPART_REGISTERED', 'MOVING', 'ARRIVED', 'IN_EXAM', 'NEARLY_DONE', 'PICKUP_REQUIRED'],

  // 「進行中」表示対象
  ACTIVE_STATUSES: ['DEPART_REGISTERED', 'MOVING', 'ARRIVED', 'IN_EXAM', 'NEARLY_DONE', 'PICKUP_REQUIRED'],

  // 迎え要件のしきい値 (分)
  SOON_THRESHOLD_MIN: 15,

  // アクションボタン設定
  ACTION_BUTTONS: {
    DEPART_REGISTERED: [
      { label: '移動中へ', toStatus: 'MOVING', cls: 'btn-primary' },
      { label: '検査開始', toStatus: 'IN_EXAM', cls: 'btn-warning' },
      { label: 'キャンセル', toStatus: 'CANCELLED', cls: 'btn-secondary' },
    ],
    MOVING: [
      { label: '検査室到着', toStatus: 'ARRIVED', cls: 'btn-info' },
      { label: '検査開始', toStatus: 'IN_EXAM', cls: 'btn-warning' },
      { label: 'キャンセル', toStatus: 'CANCELLED', cls: 'btn-secondary' },
    ],
    ARRIVED: [
      { label: '検査開始', toStatus: 'IN_EXAM', cls: 'btn-warning' },
      { label: 'キャンセル', toStatus: 'CANCELLED', cls: 'btn-secondary' },
    ],
    IN_EXAM: [
      { label: 'あと10分', toStatus: 'NEARLY_DONE', cls: 'btn-orange' },
      { label: '迎え要', toStatus: 'PICKUP_REQUIRED', cls: 'btn-danger' },
      { label: 'キャンセル', toStatus: 'CANCELLED', cls: 'btn-secondary' },
    ],
    NEARLY_DONE: [
      { label: '迎え要', toStatus: 'PICKUP_REQUIRED', cls: 'btn-danger' },
      { label: 'キャンセル', toStatus: 'CANCELLED', cls: 'btn-secondary' },
    ],
    PICKUP_REQUIRED: [
      { label: '帰棟完了', toStatus: 'RETURNED', cls: 'btn-success' },
      { label: 'キャンセル', toStatus: 'CANCELLED', cls: 'btn-secondary' },
    ],
    RETURNED: [],
    CANCELLED: [],
  },

  // 検査室側アクション
  EXAM_ROOM_ACTIONS: {
    DEPART_REGISTERED: [
      { label: '到着', toStatus: 'ARRIVED', cls: 'btn-info' },
    ],
    MOVING: [
      { label: '到着', toStatus: 'ARRIVED', cls: 'btn-info' },
    ],
    ARRIVED: [
      { label: '検査開始', toStatus: 'IN_EXAM', cls: 'btn-warning' },
    ],
    IN_EXAM: [
      { label: 'あと10分', toStatus: 'NEARLY_DONE', cls: 'btn-orange' },
      { label: '終了（迎え要）', toStatus: 'PICKUP_REQUIRED', cls: 'btn-danger' },
    ],
    NEARLY_DONE: [
      { label: '終了（迎え要）', toStatus: 'PICKUP_REQUIRED', cls: 'btn-danger' },
    ],
    PICKUP_REQUIRED: [],
  },

  // ロール定義 (セキュリティ #5: RBAC基盤)
  HIDEABLE_STATUSES: ['ARRIVED', 'NEARLY_DONE'],

  STATUS_SCOPE: {
    WARD: 'ward',
    EXAM: 'exam',
  },

  getHiddenStatuses() {
    try {
      const raw = AppState?.getSettingJSON?.('hidden_statuses', []);
      if (!Array.isArray(raw)) return [];
      return raw.filter(status => this.HIDEABLE_STATUSES.includes(status));
    } catch {
      return [];
    }
  },

  isStatusHidden(status) {
    return this.getHiddenStatuses().includes(status);
  },

  getOperationalActiveStatuses() {
    const hidden = new Set(this.getHiddenStatuses());
    return this.ACTIVE_STATUSES.filter(status => !hidden.has(status));
  },

  getAllowedActions(status, scope = 'ward') {
    const source = scope === this.STATUS_SCOPE.EXAM ? this.EXAM_ROOM_ACTIONS : this.ACTION_BUTTONS;
    const hidden = new Set(this.getHiddenStatuses());
    const result = [];
    const seen = new Set();
    const visit = (actions) => {
      actions.forEach(action => {
        if (hidden.has(action.toStatus)) {
          visit(source[action.toStatus] || []);
          return;
        }
        if (seen.has(action.toStatus)) return;
        seen.add(action.toStatus);
        result.push(action);
      });
    };
    visit(source[status] || []);
    return result;
  },

  isTransitionAllowed(fromStatus, toStatus, scope = 'ward') {
    if (!fromStatus || !toStatus) return false;
    if (fromStatus === toStatus) return true;
    return this.getAllowedActions(fromStatus, scope).some(action => action.toStatus === toStatus);
  },

  ROLES: {
    ADMIN:     'admin',
    NURSE:     'nurse',
    TRANSPORT: 'transport',
    READONLY:  'readonly',
  },

  // パーミッション定義: キー = 操作名, 値 = 許可ロール[]
  PERMISSIONS: {
    STATUS_CHANGE:      ['admin', 'nurse', 'transport'],
    PATIENT_REGISTER:   ['admin', 'nurse'],
    PATIENT_DISCHARGE:  ['admin', 'nurse'],
    ESCORT_ASSIGN:      ['admin', 'nurse', 'transport'],
    SETTINGS_ACCESS:    ['admin'],
    HISTORY_VIEW:       ['admin', 'nurse'],
    EXPORT_DATA:        ['admin'],
  },
};
