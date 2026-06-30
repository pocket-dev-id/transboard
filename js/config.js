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

  // 状態表示名
  STATUS_LABEL: {
    IN_BED: '在床',
    DEPART_REGISTERED: '出棟登録済',
    MOVING: '移動中',
    ARRIVED: '検査室到着',
    IN_EXAM: '検査中',
    NEARLY_DONE: 'あと10分',
    PICKUP_REQUIRED: '迎え要',
    RETURNED: '帰棟済',
    CANCELLED: 'キャンセル',
  },

  // 状態遷移ルール: key = 現在状態, value = 遷移可能な次状態[]
  STATUS_TRANSITIONS: {
    IN_BED: ['DEPART_REGISTERED'],
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
};
