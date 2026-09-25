'use strict';

// 搬送ステータスと病床稼働。processDbRequest のテーブル振り分けは main.js に残す。

let appendAuditLog = null;
let normalizeTerminalRole = null;
let parseJsonBody = null;
let pushStatusLog = null;
let readDB = null;
let requireExternalAuth = null;
let summarizeAuditRecord = null;
let trimTable = null;
let writeDB = null;
let writeDbOrThrow = null;
// 状態変更に伴う音声通知の送出に使う。注入し忘れると、DBへの書き込みは
// 成功しているのに通知の送出でエラーになり、呼び出し元には失敗が返る
let processWebrtcRequest = null;
let BED_OCCUPANCY_RETENTION_DAYS_DEFAULT = 7;
let BED_OCCUPANCY_LOG_MAX_ENTRIES = 20000;
let TRANSFER_EVENTS_MAX_ENTRIES = 50000;

function configureTransferStatus(deps) {
  appendAuditLog = deps.appendAuditLog;
  normalizeTerminalRole = deps.normalizeTerminalRole;
  parseJsonBody = deps.parseJsonBody;
  pushStatusLog = deps.pushStatusLog;
  readDB = deps.readDB;
  requireExternalAuth = deps.requireExternalAuth;
  summarizeAuditRecord = deps.summarizeAuditRecord;
  trimTable = deps.trimTable;
  writeDB = deps.writeDB;
  writeDbOrThrow = deps.writeDbOrThrow;
  processWebrtcRequest = deps.processWebrtcRequest;
  BED_OCCUPANCY_RETENTION_DAYS_DEFAULT = deps.BED_OCCUPANCY_RETENTION_DAYS_DEFAULT;
  BED_OCCUPANCY_LOG_MAX_ENTRIES = deps.BED_OCCUPANCY_LOG_MAX_ENTRIES;
  TRANSFER_EVENTS_MAX_ENTRIES = deps.TRANSFER_EVENTS_MAX_ENTRIES;
}

const ACTIVE_TRANSFER_STATUSES = new Set([
  'DEPART_REGISTERED',
  'MOVING',
  'ARRIVED',
  'IN_EXAM',
  'NEARLY_DONE',
  'PICKUP_REQUIRED',
]);
// 新規transfer_events作成時のcurrent_status検証用。ACTIVE_TRANSFER_STATUSES
// (進行中の状態)に終端状態(RETURNED/CANCELLED)を加えた全既知状態の集合。
// デモデータ投入(js/demo.js)は意図的に様々な終端状態でイベントを作成するため
// 特定の初期値には絞らず、既知の状態値かどうかだけを検証する
const KNOWN_TRANSFER_STATUSES = new Set([...ACTIVE_TRANSFER_STATUSES, 'RETURNED', 'CANCELLED']);
const HIDEABLE_TRANSFER_STATUSES = new Set(['ARRIVED', 'NEARLY_DONE']);
const WARD_ACKNOWLEDGEMENT_STATUSES = new Set(['ARRIVED', 'IN_EXAM', 'NEARLY_DONE', 'PICKUP_REQUIRED']);
const WARD_STATUS_ACTIONS = {
  DEPART_REGISTERED: ['MOVING', 'IN_EXAM', 'CANCELLED'],
  MOVING: ['ARRIVED', 'IN_EXAM', 'CANCELLED'],
  ARRIVED: ['IN_EXAM', 'CANCELLED'],
  IN_EXAM: ['NEARLY_DONE', 'PICKUP_REQUIRED', 'RETURNED', 'CANCELLED'],
  NEARLY_DONE: ['PICKUP_REQUIRED', 'CANCELLED'],
  PICKUP_REQUIRED: ['RETURNED', 'CANCELLED'],
  RETURNED: [],
  CANCELLED: [],
};
const EXAM_STATUS_ACTIONS = {
  DEPART_REGISTERED: ['ARRIVED'],
  MOVING: ['ARRIVED'],
  ARRIVED: ['IN_EXAM'],
  IN_EXAM: ['NEARLY_DONE', 'PICKUP_REQUIRED'],
  NEARLY_DONE: ['PICKUP_REQUIRED'],
  PICKUP_REQUIRED: [],
};

function getHiddenTransferStatuses(db) {
  const parsed = getJsonSetting(db, 'hidden_statuses', []);
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter(status => HIDEABLE_TRANSFER_STATUSES.has(status)));
}

function getAllowedTransferTargets(fromStatus, db, actionMap = WARD_STATUS_ACTIONS) {
  const hidden = getHiddenTransferStatuses(db);
  const targets = [...(actionMap[fromStatus] || [])];
  if (hidden.has('ARRIVED')) {
    const expanded = [];
    for (const target of targets) {
      if (target === 'ARRIVED') expanded.push(...(actionMap.ARRIVED || []));
      else expanded.push(target);
    }
    return [...new Set(expanded)];
  }
  return targets;
}

function isScopedTransferStatusTransitionAllowed(fromStatus, toStatus, db, scope = 'ward') {
  if (!fromStatus || !toStatus) return false;
  if (fromStatus === toStatus) return true;
  const actionMap = scope === 'exam' ? EXAM_STATUS_ACTIONS : WARD_STATUS_ACTIONS;
  return getAllowedTransferTargets(fromStatus, db, actionMap).includes(toStatus);
}

function findActiveBedEventConflict(events, candidate, excludeId = null) {
  const bedId = candidate?.bed_id == null ? '' : String(candidate.bed_id);
  const status = candidate?.current_status || '';
  if (!bedId || !ACTIVE_TRANSFER_STATUSES.has(status)) return null;

  const excluded = excludeId == null ? '' : String(excludeId);
  return (events || []).find(event =>
    String(event.id) !== excluded &&
    String(event.bed_id) === bedId &&
    ACTIVE_TRANSFER_STATUSES.has(event.current_status)
  ) || null;
}

function shouldCheckActiveBedConflict(beforeItem, afterItem, isCreate = false) {
  if (!afterItem || !ACTIVE_TRANSFER_STATUSES.has(afterItem.current_status)) return false;
  if (isCreate || !beforeItem) return true;
  return String(beforeItem.bed_id || '') !== String(afterItem.bed_id || '') ||
    String(beforeItem.current_status || '') !== String(afterItem.current_status || '');
}

function activeBedConflictResponse(conflict) {
  return {
    success: false,
    conflict: true,
    conflictType: 'active_event_for_bed',
    message: 'この病床には既に進行中の出棟イベントがあります。最新状態に更新してください。',
    existingEventId: conflict?.id || null,
    currentStatus: conflict?.current_status || null,
  };
}

// bed のPATCH前後で在室者を比較し、検査室移送を伴わない入退院・患者入替も
// bed_occupancy_log に記録する。transfer_events に依存しないため、移送なしの
// 在室も履歴として残せる。
function bedOccupancyHasOccupant(rec) {
  return !!(rec && (rec.patient_id || rec.patient_name));
}

// 同一患者かどうか。両者に患者IDがある場合のみIDで判定し、片方でも欠けていれば
// 氏名で判定する。CSV取込が氏名のみで登録した病床に後から患者IDを補記しても
// 別患者への入れ替わりと誤判定しないため（IDの「変更」は入れ替わりとして扱う）。
function isSameBedOccupant(before, after) {
  if (!bedOccupancyHasOccupant(before) || !bedOccupancyHasOccupant(after)) return false;
  if (before.patient_id && after.patient_id) {
    return String(before.patient_id) === String(after.patient_id);
  }
  return String(before.patient_name || '') === String(after.patient_name || '');
}

function findOpenBedOccupancy(occupancyLog, bedId) {
  return (occupancyLog || []).find(o => String(o.bed_id) === String(bedId) && o.ended_at == null) || null;
}

// patchData: このPATCH/POSTで実際に送られてきた生の差分（マージ後のbedsレコードではない）。
// admission_dateがこの中に明示的に含まれているかどうかの判定にのみ使う。
// beds自体はPATCHされなかったフィールドを前の値のまま持ち越すため、after.admission_date
// を無条件に信用すると「前の入居者の入院日」が新しい入居者の在室ログへ紛れ込む
// （例: CSV取込が氏名/IDだけ書き換えてadmission_dateを送らないケース）
function applyBedOccupancyTransition(occupancyLog, bedId, wardId, before, after, patchData, now, source) {
  const hadOccupant = bedOccupancyHasOccupant(before);
  const hasOccupant = bedOccupancyHasOccupant(after);
  if (!hadOccupant && !hasOccupant) return;

  const open = findOpenBedOccupancy(occupancyLog, bedId);
  const patchHasAdmissionDate = !!(patchData && Object.prototype.hasOwnProperty.call(patchData, 'admission_date') && patchData.admission_date != null);

  // 同一患者の情報が更新されただけ（患者IDの補記・氏名や入院日の修正）の場合は
  // 滞在を分割せず、在室中のレコードを最新値へ追従させる
  if (hadOccupant && hasOccupant && isSameBedOccupant(before, after)) {
    if (open) {
      open.patient_id = after.patient_id || null;
      open.patient_name = after.patient_name || null;
      if (patchHasAdmissionDate) open.admission_date = patchData.admission_date;
    }
    return;
  }

  if (hadOccupant && open) {
    open.ended_at = now;
    open.end_reason = source === 'csv_clear' ? 'csv_cleared' : (hasOccupant ? 'overwritten_by_new_admission' : 'discharged');
  }
  if (hasOccupant) {
    occupancyLog.push({
      id: `bed-occ-${now}-${Math.random().toString(36).slice(2, 7)}`,
      bed_id: bedId,
      ward_id: wardId || null,
      patient_name: after.patient_name || null,
      patient_id: after.patient_id || null,
      // このPATCHが明示的にadmission_dateを指定した場合のみ採用し、それ以外は今回検知した
      // 時刻を使う（前の入居者の値を持ち越さない）
      admission_date: patchHasAdmissionDate ? patchData.admission_date : now,
      started_at: now,
      ended_at: null,
      end_reason: null,
      source: source || 'unknown',
      created_at: now,
    });
  }
}

// 病床そのものが削除された場合に在室中のレコードを閉じる。閉じずに放置すると
// 対象の病床が存在しないため二度とクローズされず、掃除も在室中を除外するため
// 永久に残ってしまう
function closeOpenBedOccupancyForDeletedBed(occupancyLog, bedId, now) {
  const open = findOpenBedOccupancy(occupancyLog, bedId);
  if (!open) return false;
  open.ended_at = now;
  open.end_reason = 'bed_deleted';
  return true;
}

// 在室ログの掃除。保持期間（既定7日）を主軸とし、件数上限は通常運用では作動しない
// 安全弁として併用する。件数のみで間引くと病床数・回転率次第で保持期間が勝手に
// 縮み「入退院のたびに過去の記録が消える」挙動になるため、期間を主軸に据えている。
// 在室中のエントリ（ended_at == null）は期間・件数いずれの理由でも削除しない
// （病床あたり最大1件しか存在しないため、これ自体が無制限に増えることはない）。
// 戻り値は削除件数。
function pruneBedOccupancyLog(occupancyLog, retentionDays, maxEntries, now) {
  // 設定値が0や負値でも「全件即削除」にならないよう最低1日にクランプする
  const days = Math.max(1, retentionDays);
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (let i = occupancyLog.length - 1; i >= 0; i--) {
    const entry = occupancyLog[i];
    if (entry.ended_at != null && entry.ended_at < cutoff) {
      occupancyLog.splice(i, 1);
      removed++;
    }
  }

  // 安全弁：期間削除後もなお上限を超える場合のみ、クローズ済みを退院が古い順に間引く。
  // 期間削除と基準を揃えるため配列順(≒入院順)ではなく ended_at 順で選ぶ
  const overflow = occupancyLog.length - maxEntries;
  if (overflow > 0) {
    const closedIndices = [];
    for (let i = 0; i < occupancyLog.length; i++) {
      if (occupancyLog[i].ended_at != null) closedIndices.push(i);
    }
    closedIndices.sort((a, b) => (occupancyLog[a].ended_at || 0) - (occupancyLog[b].ended_at || 0));
    // splice で添字がずれないよう、削除対象を添字の降順に並べ替えてから消す
    const targets = closedIndices.slice(0, overflow).sort((a, b) => b - a);
    for (const idx of targets) {
      occupancyLog.splice(idx, 1);
      removed++;
    }
  }

  return removed;
}

// 設定値を読んで在室ログを掃除する。db.bed_occupancy_log を直接書き換えるため、
// 呼び出し側は既存の writeDB(db) にそのまま相乗りできる（追加のI/Oは発生しない）
function pruneBedOccupancyLogFromDb(db, now = Date.now()) {
  if (!db.bed_occupancy_log || db.bed_occupancy_log.length === 0) return 0;
  const days = getSystemSettingInt(db, 'bed_occupancy_retention_days', BED_OCCUPANCY_RETENTION_DAYS_DEFAULT);
  return pruneBedOccupancyLog(db.bed_occupancy_log, days, BED_OCCUPANCY_LOG_MAX_ENTRIES, now);
}

// テーブルへの書き込みに付随する副作用(在室ログの反映等)を
// 一箇所にまとめたもの。POST/一括PATCH/単体PATCH/DELETE/一括upsertの各分岐から、
// 同じ組み合わせを個別に書く代わりにここを参照する。
// onUpsert: レコード1件の反映ごとに呼ぶ。onDelete: 削除時に呼ぶ。
// finalize: そのリクエスト全体の反映が終わった後に1回だけ呼ぶ(掃除処理の重複実行を避ける)
const WRITE_HOOKS = {
  beds: {
    onUpsert: (db, id, wardId, before, after, raw, now, source) =>
      applyBedOccupancyTransition(db.bed_occupancy_log, id, wardId, before, after, raw, now, source),
    onDelete: (db, id, now) => closeOpenBedOccupancyForDeletedBed(db.bed_occupancy_log, id, now),
    finalize: (db, now) => pruneBedOccupancyLogFromDb(db, now),
  },
};

function pruneExpiredTransferEventsFromDb(db, now = Date.now()) {
  const days = getSystemSettingInt(db, 'event_retention_days', 0);
  if (days <= 0 || !Array.isArray(db.transfer_events)) return 0;

  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const completedStatuses = new Set(['RETURNED', 'CANCELLED']);
  const staleIds = new Set(
    db.transfer_events
      .filter(event => (
        event.id !== null &&
        event.id !== undefined &&
        completedStatuses.has(event.current_status) &&
        Number(event.returned_at || event.cancelled_at || event.created_at || 0) < cutoff
      ))
      .map(event => String(event.id))
  );
  if (staleIds.size === 0) return 0;

  db.transfer_events = db.transfer_events.filter(event => !staleIds.has(String(event.id)));
  if (Array.isArray(db.transfer_status_logs)) {
    db.transfer_status_logs = db.transfer_status_logs.filter(log => (
      !staleIds.has(String(log.event_id || log.transfer_event_id || ''))
    ));
  }
  appendAuditLog(db, 'EVENT_RETENTION_CLEANUP', {
    targetType: 'transfer_events',
    actorType: 'system',
    details: { removedCount: staleIds.size, retentionDays: days },
  });
  return staleIds.size;
}

function statusMismatchConflictResponse(expectedStatus, current) {
  return {
    success: false,
    conflict: true,
    conflictType: 'status_mismatch',
    message: '他端末で状態が更新されています。最新状態に更新してください。',
    expectedStatus,
    currentStatus: current?.current_status || null,
    event: current || null,
  };
}

function getSystemSettingInt(db, id, fallback) {
  const setting = (db.system_settings || []).find(s => s.id === id);
  const value = parseInt(setting?.value, 10);
  return Number.isFinite(value) ? value : fallback;
}

// system_settingsの値をJSONとしてまるごと解釈し、未設定・不正なJSONの場合は
// fallbackをそのまま返す。既定値のキー単位マージが必要な設定
// (キーごとのデフォルトとマージするもの)には使わず、個別実装のままにする
function getJsonSetting(db, id, fallback) {
  const raw = (db.system_settings || []).find(s => s.id === id)?.value;
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function sanitizeStatusExtraFields(extraFields) {
  const allowed = new Set(['patient_ic_tag_id', 'note', 'escort_staff_id', 'estimated_pickup_at', 'pickup_assistance_type_id', 'pickup_assistance_note']);
  const clean = {};
  if (!extraFields || typeof extraFields !== 'object' || Array.isArray(extraFields)) return clean;
  Object.entries(extraFields).forEach(([key, value]) => {
    if (allowed.has(key)) clean[key] = value;
  });
  return clean;
}

function createStatusSpeechMessage(db, event, newStatus, filledArrivedAtForDirectExamStart) {
  const bed = (db.beds || []).find(b => b.id === event.bed_id);
  // Windowsの日本語音声では「床」を「とこ」と読む場合があるため、
  // 画面表記とは分けて、読み上げ文では明瞭な「号室」を使用する。
  const spokenRoomName = bed
    ? String(bed.bed_number || bed.room_number || '').trim()
    : '';
  const bedName = spokenRoomName
    ? (/(?:号室|個室)$/.test(spokenRoomName) ? spokenRoomName : `${spokenRoomName}号室`)
    : '患者';
  const includePatientName = String((db.system_settings || []).find(s => s.id === 'speech_include_patient_name')?.value || 'false') === 'true';
  const patientName = String(event.patient_name || bed?.patient_name || '').trim();
  const patientPrefix = includePatientName && patientName ? `${patientName}さん、` : '';
  const room = (db.exam_rooms || []).find(r => r.id === event.exam_room_id);
  const roomName = room ? room.name : '検査室';
  const ward = (db.wards || []).find(w => w.id === event.ward_id);
  const wardName = ward ? ward.name : '病棟';

  if (newStatus === 'MOVING') {
    return {
      from: event.ward_id,
      to: event.exam_room_id,
      type: 'speech',
      automatic: true,
      text: `${patientPrefix}${wardName}から、${bedName}が、${roomName}へ移動を開始しました。`,
    };
  }
  if (newStatus === 'ARRIVED' || filledArrivedAtForDirectExamStart) {
    return {
      from: event.exam_room_id,
      to: event.ward_id,
      type: 'speech',
      automatic: true,
      text: `${patientPrefix}${roomName}に、${bedName}が到着しました。`,
    };
  }
  if (newStatus === 'PICKUP_REQUIRED') {
    return {
      from: event.exam_room_id,
      to: event.ward_id,
      type: 'speech',
      automatic: true,
      text: `${patientPrefix}${roomName}から、${bedName}のお迎え要請です。`,
    };
  }
  return null;
}

const TRANSFER_START_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function sanitizeTransferStartString(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

async function processTransferStartRequest(method, bodyStr, isExternal = false, apiToken = null, requestMeta = {}) {
  if (method !== 'POST') {
    return { success: false, message: 'Method Not Allowed' };
  }
  if (!requireExternalAuth(isExternal, apiToken, '移送開始')) {
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }
  if (normalizeTerminalRole(requestMeta.terminalRole) === 'exam') {
    return { success: false, message: '検査室端末では移送を開始できません' };
  }

  const { ok, payload } = parseJsonBody(bodyStr);
  if (!ok) {
    return { success: false, message: 'リクエストボディのJSONが不正です' };
  }

  const eventId = sanitizeTransferStartString(payload.eventId, 128);
  const bedId = sanitizeTransferStartString(payload.bedId, 128);
  const examTypeId = sanitizeTransferStartString(payload.examTypeId, 128);
  const examRoomId = sanitizeTransferStartString(payload.examRoomId, 128);
  const escortStaffId = sanitizeTransferStartString(payload.escortStaffId, 128);
  const note = sanitizeTransferStartString(payload.note, 2000);
  const patientIcTagId = sanitizeTransferStartString(payload.patientIcTagId, 200);

  if (!eventId || !TRANSFER_START_ID_PATTERN.test(eventId)) {
    return { success: false, message: 'eventId is invalid' };
  }
  if (!bedId || !examTypeId || !examRoomId) {
    return { success: false, message: '病床、検査種別、検査室は必須です' };
  }

  const db = readDB();
  const events = db.transfer_events || (db.transfer_events = []);
  const existing = events.find(event => String(event.id) === eventId);
  if (existing) {
    if (String(existing.bed_id) === bedId && ACTIVE_TRANSFER_STATUSES.has(existing.current_status)) {
      return { success: true, idempotent: true, event: existing };
    }
    return {
      success: false,
      conflict: true,
      conflictType: 'event_id_conflict',
      message: '同じ操作IDの別イベントが既に存在します。最新状態に更新してください。',
      existingEventId: existing.id,
      currentStatus: existing.current_status || null,
    };
  }

  const bed = (db.beds || []).find(item => String(item.id) === bedId);
  const examType = (db.exam_types || []).find(item => String(item.id) === examTypeId);
  const examRoom = (db.exam_rooms || []).find(item => String(item.id) === examRoomId && item.is_active !== false);
  const escortStaff = escortStaffId
    ? (db.staffs || []).find(item =>
        String(item.id) === escortStaffId &&
        item.is_active !== false &&
        String(item.ward_id) === String(bed?.ward_id || '')
      )
    : null;

  if (!bed) return { success: false, message: '病床情報が見つかりません。最新状態に更新してください。' };
  if (!bed.patient_name) {
    return {
      success: false,
      conflict: true,
      conflictType: 'patient_changed',
      message: '患者情報が変更されています。最新状態に更新してください。',
    };
  }
  if (!examType) return { success: false, message: '検査種別が見つかりません。設定を確認してください。' };
  if (!examRoom) return { success: false, message: '検査室が無効または削除されています。設定を確認してください。' };
  if (escortStaffId && !escortStaff) {
    return { success: false, message: '付き添いスタッフが無効または病棟と一致しません。' };
  }

  const requestedDuration = Number(payload.expectedDurationMin);
  const defaultDuration = Number(examType.standard_duration_min);
  const durationCandidate = Number.isFinite(requestedDuration)
    ? requestedDuration
    : (Number.isFinite(defaultDuration) ? defaultDuration : 30);
  const durationMin = Math.min(300, Math.max(5, Math.round(durationCandidate)));
  const now = Date.now();
  const eventData = {
    id: eventId,
    bed_id: bed.id,
    ward_id: bed.ward_id,
    exam_type_id: examType.id,
    exam_room_id: examRoom.id,
    escort_staff_id: escortStaff?.id || null,
    current_status: 'MOVING',
    expected_duration_min: durationMin,
    // 出棟時点では移動時間を見込めないため、あくまで仮の目安値。
    // 検査開始(IN_EXAM)時に実際の開始時刻を起点として再計算する
    estimated_pickup_at: now + durationMin * 60 * 1000,
    note,
    patient_name: bed.patient_name || null,
    patient_id: bed.patient_id || null,
    patient_ic_tag_id: patientIcTagId || null,
    registered_at: now,
    created_at: now,
    departed_at: now,
    arrived_at: null,
    exam_started_at: null,
    nearly_done_at: null,
    pickup_ready_at: null,
    returned_at: null,
  };

  const conflict = findActiveBedEventConflict(events, eventData, eventId);
  if (conflict) return activeBedConflictResponse(conflict);

  events.push(eventData);
  pushStatusLog(db, {
    transferEventId: eventId,
    fromStatus: null,
    toStatus: 'MOVING',
    changedBy: isExternal ? 'child_api' : 'local_ui',
    changedAt: now,
  });
  trimTable(events, TRANSFER_EVENTS_MAX_ENTRIES, 'transfer_events');
  appendAuditLog(db, 'TRANSFER_START', {
    targetType: 'transfer_events',
    targetId: eventId,
    actorType: isExternal ? 'child_api' : 'local_ui',
    remoteIp: requestMeta.remoteIp || '',
    after: summarizeAuditRecord('transfer_events', eventData),
    details: { fromStatus: null, toStatus: 'MOVING', scope: 'ward' },
  });

  writeDbOrThrow(db);

  const speechMsg = createStatusSpeechMessage(db, eventData, 'MOVING', false);
  if (speechMsg?.to) {
    processWebrtcRequest('POST', 'webrtc/send', JSON.stringify(speechMsg));
  }

  console.log(`[Transfer] Started: id=${eventId}, bed=${bed.id}, room=${examRoom.id}`);
  return { success: true, idempotent: false, event: eventData };
}

async function processStatusUpdateRequest(method, bodyStr, isExternal = false, apiToken = null, requestMeta = {}) {
  if (method !== 'POST') {
    return { success: false, message: 'Method Not Allowed' };
  }
  if (!requireExternalAuth(isExternal, apiToken, 'ステータス更新')) {
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }

  const { ok, payload } = parseJsonBody(bodyStr);
  if (!ok) {
    return { success: false, message: 'リクエストボディのJSONが不正です' };
  }

  const eventId = payload.eventId;
  const newStatus = payload.newStatus;
  const expectedStatus = payload.expectedStatus || null;
  const extraFields = sanitizeStatusExtraFields(payload.extraFields);
  const scope = payload.scope === 'exam' ? 'exam' : 'ward';
  if (normalizeTerminalRole(requestMeta.terminalRole) === 'exam' && scope !== 'exam') {
    return { success: false, message: '検査室端末では病棟側の状態操作はできません' };
  }
  const knownStatuses = new Set([
    'IN_BED', 'DEPART_REGISTERED', 'MOVING', 'ARRIVED', 'IN_EXAM',
    'NEARLY_DONE', 'PICKUP_REQUIRED', 'RETURNED', 'CANCELLED',
  ]);

  if (!eventId || !newStatus) {
    return { success: false, message: 'eventId and newStatus are required' };
  }
  if (!knownStatuses.has(String(newStatus))) {
    return { success: false, message: `Unknown status: ${newStatus}` };
  }

  const db = readDB();
  const list = db.transfer_events || [];
  const index = list.findIndex(x => String(x.id) === String(eventId));
  if (index === -1) {
    return { success: false, message: 'Not Found' };
  }

  const current = list[index];
  const fromStatus = current.current_status || null;
  const legacyMovingRetry = (
    expectedStatus === 'DEPART_REGISTERED' &&
    fromStatus === 'MOVING' &&
    newStatus === 'MOVING'
  );
  if (expectedStatus && fromStatus !== expectedStatus && !legacyMovingRetry) {
    return statusMismatchConflictResponse(expectedStatus, current);
  }
  if (fromStatus === newStatus || legacyMovingRetry) {
    return { success: true, idempotent: true, event: current };
  }
  if (!isScopedTransferStatusTransitionAllowed(fromStatus, newStatus, db, scope)) {
    return {
      success: false,
      message: `Invalid status transition: ${fromStatus} -> ${newStatus}`,
    };
  }

  const now = Date.now();
  // HTTP経由の子機はpayload.sourceを任意に指定できるため、外部要求の
  // 操作者種別は必ずchild_apiに固定する。ic_scan/maintenanceは信頼済みの
  // ローカルIPCから明示された場合だけ履歴へ記録する。
  const statusActor = isExternal
    ? 'child_api'
    : (['ic_scan', 'maintenance'].includes(payload.source) ? payload.source : 'local_ui');
  const statusTimeMap = {
    MOVING: 'departed_at',
    ARRIVED: 'arrived_at',
    IN_EXAM: 'exam_started_at',
    NEARLY_DONE: 'nearly_done_at',
    PICKUP_REQUIRED: 'pickup_ready_at',
    RETURNED: 'returned_at',
    CANCELLED: 'cancelled_at',
  };
  const patch = { current_status: newStatus, ...extraFields };
  if (statusTimeMap[newStatus]) {
    patch[statusTimeMap[newStatus]] = now;
  }

  const hidden = getHiddenTransferStatuses(db);
  const filledArrivedAtForDirectExamStart = (
    scope === 'exam' &&
    newStatus === 'IN_EXAM' &&
    hidden.has('ARRIVED') &&
    ['DEPART_REGISTERED', 'MOVING'].includes(fromStatus) &&
    !current.arrived_at
  );
  if (filledArrivedAtForDirectExamStart) {
    patch.arrived_at = now;
  }

  // 検査終了の目安(estimated_pickup_at)は出棟時に移動時間を見込めないまま
  // 仮置きしているため、実際に検査が始まったタイミングで
  // 検査開始時刻+標準所要時間へ再計算し、精度を上げる
  if (newStatus === 'IN_EXAM') {
    const durationCandidate = Number(current.expected_duration_min);
    const durationMin = Number.isFinite(durationCandidate) && durationCandidate > 0 ? durationCandidate : 30;
    patch.estimated_pickup_at = now + durationMin * 60 * 1000;
  }

  if (newStatus === 'NEARLY_DONE') {
    const ndMin = getSystemSettingInt(db, 'nearly_done_minutes', 10);
    patch.estimated_pickup_at = now + (ndMin > 0 ? ndMin : 10) * 60 * 1000;
  }

  list[index] = { ...current, ...patch };
  pushStatusLog(db, {
    transferEventId: eventId,
    fromStatus: fromStatus,
    toStatus: newStatus,
    changedBy: statusActor,
    changedAt: now,
  });
  appendAuditLog(db, 'STATUS_CHANGE', {
    targetType: 'transfer_events',
    targetId: eventId,
    actorType: statusActor,
    result: 'success',
    before: summarizeAuditRecord('transfer_events', current),
    after: summarizeAuditRecord('transfer_events', list[index]),
    details: {
      fromStatus,
      toStatus: newStatus,
      scope,
      requestChannel: isExternal ? 'http_api' : 'local_ipc',
    },
  });

  writeDbOrThrow(db);

  const speechMsg = createStatusSpeechMessage(db, list[index], newStatus, filledArrivedAtForDirectExamStart);
  if (speechMsg && speechMsg.to) {
    processWebrtcRequest('POST', 'webrtc/send', JSON.stringify(speechMsg));
  }

  console.log(`[Status] Updated: id=${eventId}, ${fromStatus} -> ${newStatus}, scope=${scope}`);
  return list[index];
}

function processStatusNoteRequest(method, bodyStr, isExternal = false, apiToken = null) {
  if (method !== 'POST') {
    return { success: false, message: 'Method Not Allowed' };
  }
  if (!requireExternalAuth(isExternal, apiToken, 'ステータスメモ')) {
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }

  const { ok, payload } = parseJsonBody(bodyStr);
  if (!ok) {
    return { success: false, message: 'リクエストボディのJSONが不正です' };
  }
  const eventId = String(payload.eventId || '').trim();
  const expectedStatus = payload.expectedStatus == null ? null : String(payload.expectedStatus);
  const note = String(payload.note || '').trim().slice(0, 500);
  if (!eventId || !note) {
    return { success: false, message: 'eventId and note are required' };
  }

  const db = readDB();
  const event = (db.transfer_events || []).find(item => String(item.id) === eventId);
  if (!event) return { success: false, message: 'Not Found' };
  if (expectedStatus && event.current_status !== expectedStatus) {
    return statusMismatchConflictResponse(expectedStatus, event);
  }

  const now = Date.now();
  pushStatusLog(db, {
    transferEventId: event.id,
    fromStatus: event.current_status,
    toStatus: event.current_status,
    changedBy: isExternal ? '子機操作' : 'UI操作',
    changedAt: now,
    note,
  });
  appendAuditLog(db, 'STATUS_NOTE', {
    targetType: 'transfer_events',
    targetId: event.id,
    actorType: isExternal ? 'child_api' : 'local_ui',
    details: { status: event.current_status },
  });
  writeDbOrThrow(db);
  return { success: true };
}

function processStatusAcknowledgeRequest(method, bodyStr, isExternal = false, apiToken = null, requestMeta = {}) {
  if (method !== 'POST') {
    return { success: false, message: 'Method Not Allowed' };
  }
  if (!requireExternalAuth(isExternal, apiToken, '確認応答')) {
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }
  if (normalizeTerminalRole(requestMeta.terminalRole) === 'exam') {
    return { success: false, message: '検査室端末では病棟通知を確認できません' };
  }

  const { ok, payload } = parseJsonBody(bodyStr);
  if (!ok) {
    return { success: false, message: 'リクエストボディのJSONが不正です' };
  }
  const logId = String(payload.logId || '').trim().slice(0, 160);
  const wardId = String(payload.wardId || '').trim().slice(0, 160);
  if (!logId || !wardId) {
    return { success: false, message: 'logId and wardId are required' };
  }

  const db = readDB();
  const log = (db.transfer_status_logs || []).find(item => String(item.id) === logId);
  if (!log) return { success: false, message: '通知履歴が見つかりません' };

  const event = (db.transfer_events || []).find(item => String(item.id) === String(log.transfer_event_id));
  if (!event || String(event.ward_id || '') !== wardId) {
    return { success: false, message: 'この病棟では確認できない通知です' };
  }
  if (!WARD_ACKNOWLEDGEMENT_STATUSES.has(log.to_status) || log.from_status === log.to_status) {
    return { success: false, message: '確認対象ではない通知です' };
  }
  if (log.acknowledged_at) {
    return { success: true, idempotent: true, log };
  }

  const ward = (db.wards || []).find(item => String(item.id) === wardId);
  log.acknowledged_at = Date.now();
  log.acknowledged_by_ward_id = wardId;
  log.acknowledged_by = String(ward?.name || '病棟').slice(0, 120);
  appendAuditLog(db, 'STATUS_NOTIFICATION_ACKNOWLEDGED', {
    targetType: 'transfer_status_logs',
    targetId: log.id,
    actorType: isExternal ? 'child_api' : 'local_ui',
    remoteIp: requestMeta.remoteIp || '',
    details: {
      transferEventId: event.id,
      status: log.to_status,
      wardId,
    },
  });
  if (!writeDB(db)) {
    throw new Error('確認状態の保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
  }
  return { success: true, idempotent: false, log };
}

module.exports = {
  configureTransferStatus,
  ACTIVE_TRANSFER_STATUSES,
  KNOWN_TRANSFER_STATUSES,
  WRITE_HOOKS,
  getJsonSetting,
  getSystemSettingInt,
  applyBedOccupancyTransition,
  pruneBedOccupancyLogFromDb,
  pruneExpiredTransferEventsFromDb,
  statusMismatchConflictResponse,
  createStatusSpeechMessage,
  processTransferStartRequest,
  processStatusUpdateRequest,
  processStatusNoteRequest,
  processStatusAcknowledgeRequest,
  findActiveBedEventConflict,
  shouldCheckActiveBedConflict,
  activeBedConflictResponse,
};
