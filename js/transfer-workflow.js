'use strict';
// メインプロセスと画面が参照する搬送状態の単一定義。
(function(root, factory) {
  const workflow = factory();
  if (typeof module === 'object' && module.exports) module.exports = workflow;
  if (root) root.TransferWorkflow = workflow;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const actions = {
  // 病棟側
  ward: {
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
      { label: '帰棟完了', toStatus: 'RETURNED', cls: 'btn-success' },
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

  // 検査室側
  exam: {
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
  const activeStatuses = Object.freeze(['DEPART_REGISTERED', 'MOVING', 'ARRIVED', 'IN_EXAM', 'NEARLY_DONE', 'PICKUP_REQUIRED']);
  const hideableStatuses = Object.freeze(['ARRIVED', 'NEARLY_DONE']);
  const presets = Object.freeze({
    standard: Object.freeze([]),
    skipArrival: Object.freeze(['ARRIVED']),
    skipNearlyDone: Object.freeze(['NEARLY_DONE']),
    direct: Object.freeze(['ARRIVED', 'NEARLY_DONE']),
  });
  function cloneActions(scope) {
    return Object.fromEntries(Object.entries(actions[scope]).map(([status, buttons]) =>
      [status, buttons.map(button => ({ ...button }))]));
  }
  function allowedActions(fromStatus, scope, hiddenStatuses = [], actionMap = actions[scope]) {
    let result = [...(actionMap[fromStatus] || [])];
    for (const hiddenStatus of hideableStatuses) {
      if (!hiddenStatuses.includes(hiddenStatus) || !result.some(button => button.toStatus === hiddenStatus)) continue;
      const existing = new Set(result.map(button => button.toStatus));
      result = result.filter(button => button.toStatus !== hiddenStatus)
        .concat((actionMap[hiddenStatus] || []).filter(button => !existing.has(button.toStatus)));
    }
    return result;
  }
  return { activeStatuses, hideableStatuses, presets, cloneActions, allowedActions };
});
