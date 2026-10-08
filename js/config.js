/**
 * TransBoard - 設定定数
 */

const CONFIG = {
  // ポーリング間隔 (ms)
  POLL_INTERVAL: 5000,

  // モーダルウィンドウを操作なしで放置したときに自動的に閉じるまでの時間 (ms)
  MODAL_IDLE_AUTO_CLOSE_MS: 120000,

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

  // 「出棟中」扱いの状態
  DEPART_STATUSES: [...TransferWorkflow.activeStatuses],

  // 「進行中」表示対象
  ACTIVE_STATUSES: [...TransferWorkflow.activeStatuses],

  // 付き添いスタッフが実際に患者と一緒に病棟を離れて移動している状態（それ以外はDEPART_STATUSESでも
  // 検査中等で病棟へ戻り手離れしている「待機」扱い）
  ESCORT_ACTIVE_STATUSES: ['MOVING', 'PICKUP_REQUIRED'],

  // 検査室から病棟へ伝わる通知のうち、病棟側で受領確認する状態
  WARD_ACK_STATUSES: ['ARRIVED', 'IN_EXAM', 'NEARLY_DONE', 'PICKUP_REQUIRED'],

  // 迎え要件のしきい値 (分)
  SOON_THRESHOLD_MIN: 15,

  ACTION_BUTTONS: TransferWorkflow.cloneActions('ward'),
  EXAM_ROOM_ACTIONS: TransferWorkflow.cloneActions('exam'),

  // ロール定義 (セキュリティ #5: RBAC基盤)
  HIDEABLE_STATUSES: [...TransferWorkflow.hideableStatuses],

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

  getAllowedActions(status, scope = 'ward') {
    const source = scope === this.STATUS_SCOPE.EXAM ? this.EXAM_ROOM_ACTIONS : this.ACTION_BUTTONS;
    return TransferWorkflow.allowedActions(status, scope, this.getHiddenStatuses(), source);
  },
};
