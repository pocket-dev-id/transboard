(function attachTransboardContracts(root, factory) {
  const contracts = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = contracts;
  } else {
    root.TransboardContracts = contracts;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const freezeMap = (map) => Object.freeze(
    Object.fromEntries(Object.entries(map).map(([key, values]) => [key, Object.freeze([...values])]))
  );

  const TRANSFER_STATUSES = Object.freeze([
    'IN_BED',
    'DEPART_REGISTERED',
    'MOVING',
    'ARRIVED',
    'IN_EXAM',
    'NEARLY_DONE',
    'PICKUP_REQUIRED',
    'RETURNED',
    'CANCELLED',
  ]);

  const HIDEABLE_TRANSFER_STATUSES = Object.freeze(['ARRIVED', 'NEARLY_DONE']);

  const WARD_STATUS_ACTIONS = freezeMap({
    DEPART_REGISTERED: ['MOVING', 'IN_EXAM', 'CANCELLED'],
    MOVING: ['ARRIVED', 'IN_EXAM', 'CANCELLED'],
    ARRIVED: ['IN_EXAM', 'CANCELLED'],
    IN_EXAM: ['NEARLY_DONE', 'PICKUP_REQUIRED', 'RETURNED', 'CANCELLED'],
    NEARLY_DONE: ['PICKUP_REQUIRED', 'CANCELLED'],
    PICKUP_REQUIRED: ['RETURNED', 'CANCELLED'],
    RETURNED: [],
    CANCELLED: [],
  });

  const EXAM_STATUS_ACTIONS = freezeMap({
    DEPART_REGISTERED: ['ARRIVED'],
    MOVING: ['ARRIVED'],
    ARRIVED: ['IN_EXAM'],
    IN_EXAM: ['NEARLY_DONE', 'PICKUP_REQUIRED'],
    NEARLY_DONE: ['PICKUP_REQUIRED'],
    PICKUP_REQUIRED: [],
  });

  const SETTING_CONTRACTS = Object.freeze({
    nearly_done_minutes: Object.freeze({ type: 'integer', fallback: 10, min: 1, max: 1440 }),
    soon_threshold_min: Object.freeze({ type: 'integer', fallback: 15, min: 0, max: 1440 }),
    notification_volume: Object.freeze({ type: 'integer', fallback: 80, min: 0, max: 100 }),
    hidden_statuses: Object.freeze({ type: 'hidden_statuses', fallback: Object.freeze([]) }),
    action_button_labels: Object.freeze({ type: 'string_map', fallback: Object.freeze({}) }),
    status_custom_labels: Object.freeze({ type: 'string_map', fallback: Object.freeze({}) }),
    status_colors: Object.freeze({ type: 'color_map', fallback: Object.freeze({}) }),
  });

  function cloneFallback(value) {
    if (Array.isArray(value)) return [...value];
    if (value && typeof value === 'object') return { ...value };
    return value;
  }

  function fallbackFor(contract, override) {
    return cloneFallback(override === undefined ? contract?.fallback : override);
  }

  function parseJsonSetting(rawValue) {
    if (typeof rawValue !== 'string') return rawValue;
    try {
      return JSON.parse(rawValue);
    } catch {
      return undefined;
    }
  }

  function normalizeSettingValue(id, rawValue, fallbackOverride) {
    const contract = SETTING_CONTRACTS[id];
    if (!contract) {
      if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
        return cloneFallback(fallbackOverride);
      }
      const parsed = parseJsonSetting(rawValue);
      return parsed === undefined ? cloneFallback(fallbackOverride) : parsed;
    }
    const fallback = () => fallbackFor(contract, fallbackOverride);

    if (contract.type === 'integer') {
      if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') return fallback();
      const value = Number(rawValue);
      return Number.isInteger(value) && value >= contract.min && value <= contract.max
        ? value
        : fallback();
    }

    const parsed = parseJsonSetting(rawValue);
    if (parsed === undefined) return fallback();

    if (contract.type === 'hidden_statuses') {
      if (!Array.isArray(parsed)) return fallback();
      return [...new Set(parsed.filter(status => HIDEABLE_TRANSFER_STATUSES.includes(status)))];
    }

    if (contract.type === 'color_map') {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback();
      const allowedColorKeys = new Set(['card_bg', 'card_border', 'card_text', 'badge_bg', 'badge_text']);
      const outerEntries = Object.entries(parsed).map(([status, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const innerEntries = Object.entries(value).filter(([key, color]) =>
          allowedColorKeys.has(key) && typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
        );
        return innerEntries.length > 0 ? [status, Object.fromEntries(innerEntries)] : null;
      }).filter(Boolean);
      return Object.fromEntries(outerEntries);
    }

    if (contract.type === 'string_map') {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback();
      const entries = Object.entries(parsed).filter(([key, value]) =>
        typeof key === 'string' && typeof value === 'string'
      );
      return Object.fromEntries(entries);
    }

    return fallback();
  }

  function hiddenIncludes(hiddenStatuses, status) {
    return hiddenStatuses instanceof Set
      ? hiddenStatuses.has(status)
      : Array.isArray(hiddenStatuses) && hiddenStatuses.includes(status);
  }

  function allowedTargets(status, hiddenStatuses = [], scope = 'ward') {
    const actionMap = scope === 'exam' ? EXAM_STATUS_ACTIONS : WARD_STATUS_ACTIONS;
    const targets = [...(actionMap[status] || [])];
    if (!hiddenIncludes(hiddenStatuses, 'ARRIVED')) return targets;
    return [...new Set(targets.flatMap(target =>
      target === 'ARRIVED' ? (actionMap.ARRIVED || []) : [target]
    ))];
  }

  function isTransitionAllowed(fromStatus, toStatus, hiddenStatuses = [], scope = 'ward') {
    if (!fromStatus || !toStatus) return false;
    if (fromStatus === toStatus) return true;
    return allowedTargets(fromStatus, hiddenStatuses, scope).includes(toStatus);
  }

  return Object.freeze({
    TRANSFER_STATUSES,
    HIDEABLE_TRANSFER_STATUSES,
    WARD_STATUS_ACTIONS,
    EXAM_STATUS_ACTIONS,
    SETTING_CONTRACTS,
    normalizeSettingValue,
    allowedTargets,
    isTransitionAllowed,
  });
});
