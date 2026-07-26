const { app, BrowserWindow, ipcMain, powerSaveBlocker, safeStorage, Notification: ElectronNotification, dialog } = require('electron');
const path = require('path');
const { Tray, Menu } = require('electron');
const fs = require('fs');
const chokidar = require('chokidar');
const csv = require('csv-parser');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { execSync, execFileSync, spawn } = require('child_process');

const { Readable } = require('stream');

// Electron 41 (Chromium 146) が導入した Local Network Access (LNA) 制限を無効化する。
// 子機(file://)から親機のプライベートIPへのfetchがパーミッション要求扱いになり、
// 既定拒否のパーミッションハンドラにブロックされて親子間の同期が全断するため、
// 院内LAN専用アプリとして従来通りの挙動に固定する。app.whenReady() より前に呼ぶ必要がある。
// 【フォールバック】実機で本フラグだけではLNAブロックを回避できないケースが確認されたため、
// 子機→親機のHTTP通信自体をレンダラーのfetch()からメインプロセス(Node httpモジュール)経由に
// 変更し、ブラウザのネットワークサービス層を経由しないようにした（parent-http-request参照）。
// このフラグはPNAプリフライト等の副次的な影響を避けるための保険として残す。
app.commandLine.appendSwitch('disable-features', 'LocalNetworkAccessChecks');

let mainWindow;
let tray = null;
let isQuitting = false;
let currentWatcher = null;
let currentWatchDir = null;
let nfcProcess = null;
let powerSaveBlockerId = null;

// chokidar v4 はglob文字列の ignored を廃止したため、監視除外を関数で判定する。
// 「先頭がドットの隠しファイル・フォルダ」と「archiveフォルダ配下」を除外する
// （取り込み済みCSVはarchiveへ退避されるため、再取り込みを防ぐ）。
function isIgnoredWatchPath(p) {
  return String(p).split(/[\\/]/).some(seg => seg.startsWith('.') || seg === 'archive');
}

function startNfcWatcher() {
  if (nfcProcess) return;
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'nfc-reader.ps1')
    : path.join(__dirname, 'nfc-reader.ps1');
  if (!fs.existsSync(scriptPath)) return;

  nfcProcess = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  nfcProcess.on('error', (err) => {
    console.error('[NFC] PowerShellプロセスの起動に失敗しました:', err.message);
    nfcProcess = null;
  });

  nfcProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const m = line.trim().match(/^UID:([0-9A-Fa-f]+)$/);
      if (m && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('card-scanned', m[1].toUpperCase());
      }
    }
  });

  nfcProcess.on('exit', () => { nfcProcess = null; });
}

function stopNfcWatcher() {
  if (nfcProcess) { nfcProcess.kill(); nfcProcess = null; }
}

// 共有設定のパスとデータベースのパスを取得
const USER_DATA_DIR = app.getPath('userData');
const COMMON_DATA_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'transboard');
const GLOBAL_CONFIG_FILE = path.join(COMMON_DATA_DIR, 'storage_mode.json');
const TERMINAL_ROLE_FILE = path.join(USER_DATA_DIR, 'terminal_role.json');

function checkCommonWritePermission() {
  try {
    if (!fs.existsSync(COMMON_DATA_DIR)) {
      fs.mkdirSync(COMMON_DATA_DIR, { recursive: true });
    }
    const testFile = path.join(COMMON_DATA_DIR, '.permission_test');
    fs.writeFileSync(testFile, 'test', 'utf8');
    fs.unlinkSync(testFile);
    return true;
  } catch (err) {
    return false;
  }
}

function getDBPath() {
  let targetDir = USER_DATA_DIR;
  try {
    if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, 'utf8'));
      if (config.mode === 'common') {
        targetDir = COMMON_DATA_DIR;
        console.log(`[DB] 共有データフォルダを保存先に指定されました: ${targetDir}`);
      }
    }
  } catch (err) {
    console.warn('[DB] 共有設定の読み込みに失敗しました。デフォルトのユーザーフォルダを使用します。', err.message);
  }
  return path.join(targetDir, 'db.json');
}

// アトミック書き込みユーティリティ: tmpファイルに書いてからrenameする
// これにより書き込み途中でプロセスが終了してもターゲットファイルが壊れない
function safeWriteFile(targetPath, content) {
  const tmpPath = targetPath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (renameErr) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw renameErr;
  }
}

let DB_FILE = getDBPath();
const DB_BACKUP_MIN_INTERVAL_MS = 30000;
let dbBackupTimer = null;
let lastDbBackupAt = 0;
let dbBackupInFlight = false;

function scheduleDbBackup() {
  const backupPath = DB_FILE + '.bak';
  if (!fs.existsSync(backupPath)) {
    try {
      fs.copyFileSync(DB_FILE, backupPath);
      lastDbBackupAt = Date.now();
    } catch (err) {
      console.warn('[DB] 初回バックアップ作成に失敗:', err.message);
    }
    return;
  }

  if (dbBackupInFlight) {
    if (!dbBackupTimer) {
      dbBackupTimer = setTimeout(() => {
        dbBackupTimer = null;
        scheduleDbBackup();
      }, 1000);
    }
    return;
  }

  const runBackup = () => {
    dbBackupTimer = null;
    dbBackupInFlight = true;
    fs.copyFile(DB_FILE, backupPath, err => {
      dbBackupInFlight = false;
      if (err) {
        console.warn('[DB] バックアップ更新に失敗:', err.message);
        return;
      }
      lastDbBackupAt = Date.now();
    });
  };

  const elapsed = Date.now() - lastDbBackupAt;
  if (elapsed >= DB_BACKUP_MIN_INTERVAL_MS) {
    runBackup();
  } else if (!dbBackupTimer) {
    dbBackupTimer = setTimeout(runBackup, DB_BACKUP_MIN_INTERVAL_MS - elapsed);
  }
}

// 起動時に前回クラッシュで残ったtmpファイルをクリーンアップする
function cleanupStaleTmpFiles() {
  const tmpPath = DB_FILE + '.tmp';
  if (fs.existsSync(tmpPath)) {
    try {
      fs.unlinkSync(tmpPath);
      console.warn('[DB] 前回の異常終了で残留した一時ファイルを削除しました:', tmpPath);
    } catch (err) {
      console.error('[DB] 残留一時ファイルの削除に失敗しました:', err.message);
    }
  }
}
cleanupStaleTmpFiles();

// WebRTCシグナリング用のメモリ内一時キュー
const webrtcSignalingQueue = Object.create(null);
const SIGNALING_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_SIGNALING_ID_LENGTH = 128;

function isSafeSignalingId(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SIGNALING_ID_LENGTH &&
    SIGNALING_ID_PATTERN.test(value);
}

// WebRTCシグナリングキューの定期クリーンアップ（古い未取得メッセージの自動破棄）
setInterval(() => {
  const now = Date.now();
  const EXPIRATION_MS = 30000; // 30秒有効
  for (const clientId in webrtcSignalingQueue) {
    if (Array.isArray(webrtcSignalingQueue[clientId])) {
      webrtcSignalingQueue[clientId] = webrtcSignalingQueue[clientId].filter(
        item => (now - item.timestamp) < EXPIRATION_MS
      );
      if (webrtcSignalingQueue[clientId].length === 0) {
        delete webrtcSignalingQueue[clientId];
      }
    }
  }
}, 60000); // 60秒毎に実行

// データベースの初期シードデータ（マスタデータ）
const SEEDS = {
  wards: [
    { id: "ward-1", name: "7階東病棟", phone: "7101", note: "7階東 ナースステーション" },
    { id: "ward-2", name: "7階西病棟", phone: "7201", note: "7階西 ナースステーション" }
  ],
  beds: [
    { id: "bed-701", ward_id: "ward-1", bed_number: "701", room_number: "701", bed_type: "一般", sort_order: 1, map_col: 0, map_row: 0 },
    { id: "bed-702", ward_id: "ward-1", bed_number: "702", room_number: "701", bed_type: "一般", sort_order: 2, map_col: 1, map_row: 0 },
    { id: "bed-703", ward_id: "ward-1", bed_number: "703", room_number: "702", bed_type: "一般", sort_order: 3, map_col: 3, map_row: 0 },
    { id: "bed-704", ward_id: "ward-1", bed_number: "704", room_number: "702", bed_type: "一般", sort_order: 4, map_col: 4, map_row: 0 },
    { id: "bed-705", ward_id: "ward-1", bed_number: "705", room_number: "703", bed_type: "一般", sort_order: 5, map_col: 6, map_row: 0 },
    { id: "bed-706", ward_id: "ward-1", bed_number: "706", room_number: "703", bed_type: "一般", sort_order: 6, map_col: 7, map_row: 0 },
    { id: "bed-707", ward_id: "ward-1", bed_number: "707", room_number: "704", bed_type: "一般", sort_order: 7, map_col: 0, map_row: 2 },
    { id: "bed-708", ward_id: "ward-1", bed_number: "708", room_number: "704", bed_type: "一般", sort_order: 8, map_col: 1, map_row: 2 },
    { id: "bed-709", ward_id: "ward-1", bed_number: "709", room_number: "705", bed_type: "一般", sort_order: 9, map_col: 3, map_row: 2 },
    { id: "bed-710", ward_id: "ward-1", bed_number: "710", room_number: "705", bed_type: "一般", sort_order: 10, map_col: 4, map_row: 2 },
    { id: "bed-711", ward_id: "ward-1", bed_number: "711", room_number: "706", bed_type: "一般", sort_order: 11, map_col: 6, map_row: 2 },
    { id: "bed-712", ward_id: "ward-1", bed_number: "712", room_number: "706", bed_type: "一般", sort_order: 12, map_col: 7, map_row: 2 },
    { id: "bed-713", ward_id: "ward-1", bed_number: "713", room_number: "707", bed_type: "一般", sort_order: 13, map_col: 0, map_row: 4 },
    { id: "bed-714", ward_id: "ward-1", bed_number: "714", room_number: "707", bed_type: "一般", sort_order: 14, map_col: 1, map_row: 4 },
    { id: "bed-715", ward_id: "ward-1", bed_number: "715", room_number: "708", bed_type: "一般", sort_order: 15, map_col: 3, map_row: 4 },
    { id: "bed-716", ward_id: "ward-1", bed_number: "716", room_number: "708", bed_type: "一般", sort_order: 16, map_col: 4, map_row: 4 },
    { id: "bed-717", ward_id: "ward-1", bed_number: "717", room_number: "709個室", bed_type: "隔離", sort_order: 17, map_col: 6, map_row: 4 },
    { id: "bed-718", ward_id: "ward-1", bed_number: "718", room_number: "709個室", bed_type: "隔離", sort_order: 18, map_col: 7, map_row: 4 }
  ],
  bed_types: [
    { id: "bed-type-normal", code: "normal", name: "一般", sort_order: 1, is_active: true },
    { id: "bed-type-isolation", code: "isolation", name: "隔離", sort_order: 2, is_active: true },
    { id: "bed-type-icu", code: "icu", name: "ICU", sort_order: 3, is_active: true }
  ],
  exam_rooms: [
    { id: "room-ct", name: "CT室", code: "CT", floor: "1F", phone: "2001", icon: "fa-x-ray", is_active: true },
    { id: "room-mri", name: "MRI室", code: "MRI", floor: "1F", phone: "2002", icon: "fa-magnet", is_active: true },
    { id: "room-xp", name: "X線室", code: "XP", floor: "2F", phone: "2010", icon: "fa-radiation", is_active: true },
    { id: "room-endo", name: "内視鏡室", code: "ENDO", floor: "2F", phone: "2030", icon: "fa-procedures", is_active: true },
    { id: "room-echo", name: "エコー室", code: "ECHO", floor: "2F", phone: "2020", icon: "fa-wave-square", is_active: true }
  ],
  exam_types: [
    { id: "exam-ct", name: "CT", code: "CT", standard_duration_min: 30 },
    { id: "exam-mri", name: "MRI", code: "MRI", standard_duration_min: 60 },
    { id: "exam-xp", name: "レントゲン(XP)", code: "XP", standard_duration_min: 20 },
    { id: "exam-endo", name: "内視鏡", code: "ENDO", standard_duration_min: 90 },
    { id: "exam-echo", name: "エコー", code: "ECHO", standard_duration_min: 40 },
    { id: "exam-angio", name: "血管撮影", code: "ANGIO", standard_duration_min: 120 }
  ],
  staffs: [
    { id: "staff-1", name: "看護師A", role: "nurse", ward_id: "ward-1", is_active: true },
    { id: "staff-2", name: "看護師B", role: "nurse", ward_id: "ward-1", is_active: true },
    { id: "staff-3", name: "看護師C", role: "nurse", ward_id: "ward-1", is_active: true },
    { id: "staff-4", name: "看護師D", role: "nurse", ward_id: "ward-1", is_active: true },
    { id: "staff-5", name: "看護師E", role: "nurse", ward_id: "ward-1", is_active: true },
    { id: "staff-6", name: "看護師F", role: "nurse", ward_id: "ward-1", is_active: true }
  ],
  system_settings: [
    { id: "import_directory", value: "" },
    { id: "demo_inserted", value: "false" },
    { id: "import_mapping", value: "{\"bed_number\":\"\",\"room_code\":\"\",\"bed_code\":\"\",\"join_char\":\"-\",\"patient_id\":\"\",\"patient_name\":\"\",\"is_present\":\"\"}" },
    { id: "import_schedule", value: "{\"mode\":\"realtime\",\"intervalMin\":\"10\",\"times\":[]}" },
    { id: "import_retention_policy", value: "{\"action\":\"archive\",\"retentionDays\":\"30\",\"clearUnlisted\":false}" },
    { id: "import_connection_type", value: "csv" },
    { id: "odbc_connection_string", value: "DSN=EMR_DB;UID=admin;PWD=admin_pass;" },
    { id: "odbc_sql_query", value: "SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS" },
    { id: "notification_sounds", value: "{\"PICKUP_REQUIRED\":{\"enabled\":true,\"sound\":\"alarm\"},\"NEARLY_DONE\":{\"enabled\":true,\"sound\":\"chime\"},\"SOON\":{\"enabled\":true,\"sound\":\"chime\"},\"MOVING\":{\"enabled\":false,\"sound\":\"ding\"},\"ARRIVED\":{\"enabled\":false,\"sound\":\"ding\"},\"RETURNED\":{\"enabled\":false,\"sound\":\"ding\"}}" },
    { id: "incoming_ring_sound", value: "ring" },
    { id: "share_mode", value: "parent" },
    { id: "parent_ip", value: "" },
    { id: "api_token", value: "" },
    { id: "enable_webrtc_call", value: "true" },
    { id: "enable_patient_ic_association", value: "false" },
    { id: "default_zoom", value: "1.0" },
    { id: "font_style", value: "ud" },
    { id: "bed_card_size", value: "medium" },
    { id: "theme_style", value: "light" },
    { id: "wizard_completed", value: "false" },
    { id: "show_sync_time", value: "true" },
    { id: "show_import_time", value: "true" },
    { id: "smb_auth_mode", value: "current" },
    { id: "smb_username", value: "" },
    { id: "smb_password", value: "" },
    { id: "admin_passcode", value: "0000" },
    { id: "speech_templates", value: "[\"連絡事項があります。\",\"間もなく、患者が出発します。\",\"患者が到着しました。\",\"検査が終了しました。お迎えをお願いします。\",\"移送をキャンセルします。\",\"至急、ご連絡ください。\"]" },
    { id: "speech_include_patient_name", value: "false" },
    { id: "admission_mode", value: "csv" },
    { id: "notification_volume", value: "80" },
    { id: "notification_scan_sound", value: "true" },
    { id: "notification_mute", value: "{\"enabled\":false,\"start\":\"22:00\",\"end\":\"06:00\"}" },
    { id: "notification_import_toast", value: "true" },
    { id: "notification_os", value: "false" },
    { id: "status_custom_labels", value: "{}" },
    { id: "nearly_done_minutes", value: "10" },
    { id: "soon_threshold_min", value: "15" },
    { id: "status_colors", value: "{}" },
    { id: "action_button_labels", value: "{}" },
    { id: "hidden_statuses", value: "[]" }
  ],
  transfer_events: [],
  transfer_status_logs: [],
  audit_logs: [],
  calls: [],
  import_logs: [],
  schedule_feeds: [],
  schedule_items: [],
  handover_notes: []
};

// センシティブな設定情報の暗号化リストと暗号・復号ヘルパー
const SENSITIVE_SETTING_IDS = ['odbc_connection_string', 'smb_password', 'api_token'];
const AUDIT_SECRET_SETTING_IDS = new Set(['admin_passcode', 'api_token', 'smb_password', 'odbc_connection_string']);
const AUDIT_PATIENT_FIELD_IDS = new Set(['patient_name', 'patient_id', 'patient_ic_tag_id', 'patient_note']);
const AUDIT_LOG_MAX_ENTRIES = 5000;

function encryptSensitiveValue(value) {
  if (!value) return value;
  if (value.startsWith('ENCRYPTED:')) return value; // 既に暗号化済み
  
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const encryptedBuffer = safeStorage.encryptString(value);
      return 'ENCRYPTED:' + encryptedBuffer.toString('base64');
    } catch (err) {
      console.error('[Crypto] Encryption failed:', err);
    }
  }
  return value; // 暗号化不可時のフォールバック（平文保存）
}

function decryptSensitiveValue(value) {
  if (!value) return value;
  if (!value.startsWith('ENCRYPTED:')) return value; // 暗号化されていない
  
  const base64Str = value.substring('ENCRYPTED:'.length);
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const encryptedBuffer = Buffer.from(base64Str, 'base64');
      return safeStorage.decryptString(encryptedBuffer);
    } catch (err) {
      console.error('[Crypto] Decryption failed:', err);
    }
  }
  return ''; // 復号エラー時は空文字
}

// db.jsonファイル全体の暗号化（セキュリティ B-1: 患者データを含む全内容を保護）
// safeStorageはOSユーザー資格情報に紐づくため、暗号化後のファイルは同一PC・同一ユーザーでのみ復号可能
const DB_ENCRYPTION_PREFIX = 'ENCDB1:';

function encryptDbFileContent(jsonStr) {
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(jsonStr);
      return DB_ENCRYPTION_PREFIX + encrypted.toString('base64');
    } catch (err) {
      console.error('[DB] DBファイル全体の暗号化に失敗しました。平文で保存します:', err);
    }
  }
  return jsonStr; // 暗号化不可時のフォールバック（平文保存）
}

function decryptDbFileContent(raw) {
  if (!raw.startsWith(DB_ENCRYPTION_PREFIX)) {
    return raw; // 未暗号化（旧形式・平文）のDBファイル
  }
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    throw new Error('このDBファイルは暗号化されていますが、この環境では復号機能（safeStorage）が利用できません。');
  }
  const base64Str = raw.slice(DB_ENCRYPTION_PREFIX.length);
  const encryptedBuffer = Buffer.from(base64Str, 'base64');
  try {
    return safeStorage.decryptString(encryptedBuffer);
  } catch (err) {
    throw new Error('DBファイルの復号に失敗しました。別のPCまたは別のOSユーザーで暗号化されたファイルの可能性があります。');
  }
}

// ローカルデータベースのメモリキャッシュ（コード#6: 毎リクエストごとのディスク読み込み・JSON.parseを回避）
// Node.jsはシングルスレッドのためIPC/HTTPリクエストはイベントループ上で直列化され、
// キャッシュと実ファイルがズレるような競合は発生しない
let dbCache = null;

function getLegacyDepartureTimestamp(event, statusLogs, migrationTime) {
  const directCandidates = [
    ['departed_at', event.departed_at],
    ['registered_at', event.registered_at],
    ['created_at', event.created_at],
  ];
  for (const [source, value] of directCandidates) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp > 0) return { timestamp, source };
  }

  const firstStatusLog = (statusLogs || [])
    .filter(log =>
      String(log.transfer_event_id) === String(event.id) &&
      ['DEPART_REGISTERED', 'MOVING'].includes(log.to_status) &&
      Number.isFinite(Number(log.changed_at))
    )
    .sort((a, b) => Number(a.changed_at) - Number(b.changed_at))[0];
  if (firstStatusLog) {
    return { timestamp: Number(firstStatusLog.changed_at), source: 'status_log' };
  }

  const idMatch = String(event.id || '').match(/(?:^|[-_:])(\d{13})(?:[-_:]|$)/);
  if (idMatch) {
    const timestamp = Number(idMatch[1]);
    if (Number.isFinite(timestamp) && timestamp > 946684800000 && timestamp <= migrationTime + 86400000) {
      return { timestamp, source: 'event_id' };
    }
  }

  return { timestamp: migrationTime, source: 'migration_time' };
}

function migrateTransferWorkflow(db) {
  db.transfer_events = Array.isArray(db.transfer_events) ? db.transfer_events : [];
  db.transfer_status_logs = Array.isArray(db.transfer_status_logs) ? db.transfer_status_logs : [];

  let changed = false;
  const migrationTime = Date.now();
  const departureTimeSources = {};
  const migratedEventIds = [];

  for (const event of db.transfer_events) {
    if (event.current_status !== 'DEPART_REGISTERED') continue;

    const inferred = getLegacyDepartureTimestamp(event, db.transfer_status_logs, migrationTime);
    event.current_status = 'MOVING';
    event.departed_at = inferred.timestamp;
    if (!event.registered_at) event.registered_at = inferred.timestamp;
    if (!event.created_at) event.created_at = inferred.timestamp;

    db.transfer_status_logs.push({
      id: `log-${migrationTime}-${Math.random().toString(36).slice(2, 7)}`,
      transfer_event_id: event.id,
      from_status: 'DEPART_REGISTERED',
      to_status: 'MOVING',
      changed_by: 'system-migration',
      changed_at: migrationTime,
      note: `出棟登録済から移動中へ統合（出棟時刻: ${inferred.source}）`,
    });
    departureTimeSources[inferred.source] = (departureTimeSources[inferred.source] || 0) + 1;
    migratedEventIds.push(event.id);
    changed = true;
  }

  const hiddenSetting = (db.system_settings || []).find(s => s.id === 'hidden_statuses');
  if (hiddenSetting?.value) {
    try {
      const hidden = JSON.parse(hiddenSetting.value);
      if (Array.isArray(hidden) && hidden.includes('MOVING')) {
        hiddenSetting.value = JSON.stringify(hidden.filter(status => status !== 'MOVING'));
        changed = true;
      }
    } catch {}
  }

  const notificationSetting = (db.system_settings || []).find(s => s.id === 'notification_sounds');
  if (notificationSetting?.value) {
    try {
      const settings = JSON.parse(notificationSetting.value);
      if (
        settings &&
        typeof settings === 'object' &&
        settings.DEPART_REGISTERED &&
        !Object.prototype.hasOwnProperty.call(settings, 'MOVING')
      ) {
        settings.MOVING = { ...settings.DEPART_REGISTERED };
        notificationSetting.value = JSON.stringify(settings);
        changed = true;
      }
    } catch {}
  }

  if (migratedEventIds.length > 0) {
    if (db.transfer_status_logs.length > 1000) {
      db.transfer_status_logs.splice(0, db.transfer_status_logs.length - 1000);
    }
    appendAuditLog(db, 'DATA_MIGRATION', {
      targetType: 'transfer_events',
      actorType: 'system',
      details: {
        migration: 'depart_registered_to_moving',
        migratedCount: migratedEventIds.length,
        eventIds: migratedEventIds,
        departureTimeSources,
      },
    });
  }

  return changed;
}

// ローカルデータベース読み込み（重複防止の自動クリーンアップ機能付き）
function readDB() {
  if (dbCache) {
    return JSON.parse(JSON.stringify(dbCache));
  }
  try {
    if (!fs.existsSync(DB_FILE)) {
      console.log(`[DB] データベースが存在しないため初期データを書き込みます: ${DB_FILE}`);
      safeWriteFile(DB_FILE, encryptDbFileContent(JSON.stringify(SEEDS, null, 2)));
      dbCache = JSON.parse(JSON.stringify(SEEDS));
      return JSON.parse(JSON.stringify(SEEDS));
    }
    const rawFileContent = fs.readFileSync(DB_FILE, 'utf8');
    const wasEncrypted = rawFileContent.startsWith(DB_ENCRYPTION_PREFIX);
    const data = decryptDbFileContent(rawFileContent);
    const db = JSON.parse(data);

    let hasDuplicates = false;
    // 旧形式（平文）のDBを検出した場合、暗号化が使える環境なら次回書き込み時に暗号化形式へ移行する
    let needsEncryptionRewrite = !wasEncrypted && safeStorage && safeStorage.isEncryptionAvailable();

    // 後方互換性：新規テーブル・新規設定項目のパッチ
    if (!db.import_logs) {
      db.import_logs = [];
      hasDuplicates = true;
    }
    if (!db.audit_logs) {
      db.audit_logs = [];
      hasDuplicates = true;
    }
    if (!db.system_settings) {
      db.system_settings = SEEDS.system_settings;
      hasDuplicates = true;
    } else {
      SEEDS.system_settings.forEach(s => {
        if (!db.system_settings.some(x => x.id === s.id)) {
          db.system_settings.push(s);
          hasDuplicates = true;
        }
      });
    }
    if (!db.bed_types) {
      db.bed_types = SEEDS.bed_types;
      hasDuplicates = true;
    } else {
      SEEDS.bed_types.forEach(t => {
        if (!db.bed_types.some(x => x.id === t.id || x.code === t.code)) {
          db.bed_types.push(t);
          hasDuplicates = true;
        }
      });
    }
    if (!db.schedule_feeds) {
      db.schedule_feeds = [];
      hasDuplicates = true;
    }
    if (!db.schedule_items) {
      db.schedule_items = [];
      hasDuplicates = true;
    }
    if (!db.handover_notes) {
      db.handover_notes = [];
      hasDuplicates = true;
    }
    if (!db.transfer_events) {
      db.transfer_events = [];
      hasDuplicates = true;
    }
    if (!db.transfer_status_logs) {
      db.transfer_status_logs = [];
      hasDuplicates = true;
    }

    // センシティブな設定情報の復号化
    if (db.system_settings && Array.isArray(db.system_settings)) {
      db.system_settings.forEach(s => {
        if (SENSITIVE_SETTING_IDS.includes(s.id)) {
          if (s.value && !s.value.startsWith('ENCRYPTED:')) {
            needsEncryptionRewrite = true;
          }
          s.value = decryptSensitiveValue(s.value);
        }
      });
    }
    
    // 全テーブルの重複IDを排除（自己修復プログラム）
    for (const table in db) {
      if (Array.isArray(db[table])) {
        const seen = new Set();
        const uniqueList = [];
        for (const item of db[table]) {
          if (item && item.id) {
            const itemKey = String(item.id);
            if (!seen.has(itemKey)) {
              seen.add(itemKey);
              uniqueList.push(item);
            } else {
              hasDuplicates = true;
            }
          } else {
            uniqueList.push(item);
          }
        }
        db[table] = uniqueList;
      }
    }

    if (migrateTransferWorkflow(db)) {
      hasDuplicates = true;
    }
    
    if (hasDuplicates || needsEncryptionRewrite) {
      console.log('[DB] データ補正または暗号化適用のための再書き込みを実施します。');
      writeDB(db);
    }

    dbCache = JSON.parse(JSON.stringify(db));
    return db;
  } catch (err) {
    console.error('[DB] データベースの読み込み失敗:', err);

    // バックアップファイルからのリカバリを試みる
    const bakPath = DB_FILE + '.bak';
    if (fs.existsSync(bakPath)) {
      try {
        const bakRaw = fs.readFileSync(bakPath, 'utf8');
        const bakData = decryptDbFileContent(bakRaw);
        const recovered = JSON.parse(bakData);
        console.warn('[DB] バックアップファイルからデータを復旧しました:', bakPath);
        dbCache = JSON.parse(JSON.stringify(recovered));
        return recovered;
      } catch (bakErr) {
        console.error('[DB] バックアップファイルの復旧にも失敗しました:', bakErr.message);
      }
    }

    // 破損ファイルを保全してから初期データで再起動できるようにする
    if (fs.existsSync(DB_FILE)) {
      const corruptPath = DB_FILE + '.corrupt';
      try {
        fs.copyFileSync(DB_FILE, corruptPath);
        console.warn('[DB] 破損したDBファイルを保全しました:', corruptPath);
      } catch {}
    }

    console.error('[DB] データを復旧できませんでした。初期データで再構築します。');
    dbCache = JSON.parse(JSON.stringify(SEEDS));
    return JSON.parse(JSON.stringify(SEEDS));
  }
}

// ローカルデータベース書き込み
// 成功時は true、失敗時は false を返す（呼び出し元がハンドリング可能）
function writeDB(data) {
  try {
    // インメモリの元のデータを破壊しないようディープコピーを作成
    const dbClone = JSON.parse(JSON.stringify(data));

    // センシティブな設定情報の暗号化
    if (dbClone.system_settings && Array.isArray(dbClone.system_settings)) {
      dbClone.system_settings.forEach(s => {
        if (SENSITIVE_SETTING_IDS.includes(s.id)) {
          s.value = encryptSensitiveValue(s.value);
        }
      });
    }

    safeWriteFile(DB_FILE, encryptDbFileContent(JSON.stringify(dbClone, null, 2)));

    // 書き込み成功後にローリングバックアップを更新する
    // （破損時のリカバリ用。直前の正常状態を1世代保持）
    scheduleDbBackup();

    // メモリキャッシュを最新の状態（復号化された形）に更新する
    dbCache = JSON.parse(JSON.stringify(data));

    return true;
  } catch (err) {
    console.error('[DB] データベースの書き込み失敗:', err);
    // 書き込み失敗時はキャッシュを更新しない（ディスク上の状態と不整合を避ける）
    return false;
  }
}

function getSettingRecord(db, id) {
  return (db.system_settings || []).find(s => s.id === id);
}

function normalizeShareMode(value) {
  return value === 'client' || value === 'child' ? 'client' : 'parent';
}

function maskAuditValue(table, id, value) {
  if (table === 'system_settings' && AUDIT_SECRET_SETTING_IDS.has(String(id || ''))) {
    return value === undefined ? undefined : '[changed]';
  }
  if (AUDIT_PATIENT_FIELD_IDS.has(String(id || ''))) {
    return value === undefined ? undefined : '[redacted]';
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return value.map(item => maskAuditValue(table, id, item));
    const masked = {};
    Object.entries(value).forEach(([key, val]) => {
      masked[key] = maskAuditValue(table, key, val);
    });
    return masked;
  }
  return value;
}

function summarizeAuditRecord(table, record) {
  if (!record || typeof record !== 'object') return record ?? null;
  const summary = {};
  Object.entries(record).forEach(([key, value]) => {
    summary[key] = maskAuditValue(table, table === 'system_settings' ? record.id : key, value);
  });
  return summary;
}

function appendAuditLog(db, action, {
  targetType = '',
  targetId = null,
  staffId = null,
  actorType = 'system',
  terminalRole = '',
  deviceId = '',
  remoteIp = '',
  result = 'success',
  before = null,
  after = null,
  reason = '',
  details = {},
} = {}) {
  try {
    db.audit_logs = Array.isArray(db.audit_logs) ? db.audit_logs : [];
    const now = Date.now();
    db.audit_logs.push({
      id: `audit-${now}-${Math.random().toString(36).slice(2, 7)}`,
      action,
      target_type: targetType,
      target_id: targetId,
      staff_id: staffId,
      actor_type: actorType,
      terminal_role: terminalRole || normalizeShareMode(getSettingRecord(db, 'share_mode')?.value),
      device_id: deviceId || '',
      remote_ip: remoteIp || '',
      result,
      before: before == null ? '' : JSON.stringify(before),
      after: after == null ? '' : JSON.stringify(after),
      reason,
      details: JSON.stringify(details || {}),
      created_at: now,
    });
    if (db.audit_logs.length > AUDIT_LOG_MAX_ENTRIES) {
      db.audit_logs.splice(0, db.audit_logs.length - AUDIT_LOG_MAX_ENTRIES);
    }
  } catch (err) {
    console.warn('[AuditLog] 追記に失敗:', err.message);
  }
}

function appendParentActionAudit(action, result, requestMeta = {}) {
  const db = readDB();
  appendAuditLog(db, 'PARENT_ACTION', {
    targetType: 'parent-actions',
    targetId: action,
    actorType: 'child_api',
    remoteIp: requestMeta.remoteIp || '',
    result: result && result.success === false ? 'failure' : 'success',
    details: { action, message: result?.message || '' },
  });
  writeDB(db);
  return result;
}

function sanitizeAuditWritePayload(payload) {
  const clean = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const limit = (value, max = 120) => String(value || '').slice(0, max);
  return {
    action: limit(clean.action || 'USER_ACTION', 80),
    targetType: limit(clean.targetType || clean.target_type || '', 80),
    targetId: clean.targetId ?? clean.target_id ?? null,
    staffId: clean.staffId ?? clean.staff_id ?? null,
    details: clean.details && typeof clean.details === 'object' && !Array.isArray(clean.details)
      ? maskAuditValue('', '', clean.details)
      : {},
  };
}

function processAuditWriteRequest(method, bodyStr, isExternal = false, apiToken = null, requestMeta = {}) {
  if (method !== 'POST') {
    return { success: false, message: 'Method Not Allowed' };
  }
  if (isExternal && !isValidApiToken(apiToken)) {
    console.warn('[Security] 監査ログAPIトークン認証失敗');
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }

  let payload;
  try { payload = JSON.parse(bodyStr || '{}'); } catch {
    return { success: false, message: 'リクエストボディのJSONが不正です' };
  }

  const audit = sanitizeAuditWritePayload(payload);
  const db = readDB();
  appendAuditLog(db, audit.action, {
    targetType: audit.targetType,
    targetId: audit.targetId,
    staffId: audit.staffId,
    actorType: isExternal ? 'child_api' : 'local_ui',
    remoteIp: requestMeta.remoteIp || '',
    details: audit.details,
  });
  if (!writeDB(db)) {
    throw new Error('データベースの保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
  }
  return { success: true };
}

function resetAdminPasscodeForLocalRecovery(reason = 'local_recovery') {
  const db = readDB();
  db.system_settings = db.system_settings || [];
  const rec = db.system_settings.find(s => s.id === 'admin_passcode');
  if (rec) rec.value = '0000';
  else db.system_settings.push({ id: 'admin_passcode', value: '0000' });
  appendAuditLog(db, 'PASSCODE_RESET_FOR_RECOVERY', {
    targetType: 'system_settings',
    targetId: 'admin_passcode',
    actorType: 'local_recovery',
    after: { id: 'admin_passcode', value: '[changed]' },
    reason,
  });
  return writeDB(db);
}

function readTerminalRole() {
  try {
    if (!fs.existsSync(TERMINAL_ROLE_FILE)) return null;
    const role = JSON.parse(fs.readFileSync(TERMINAL_ROLE_FILE, 'utf8'));
    if (!role || typeof role !== 'object') return null;
    return {
      shareMode: normalizeShareMode(role.shareMode || role.share_mode),
      parentIp: String(role.parentIp || role.parent_ip || ''),
      updatedAt: Number(role.updatedAt || 0) || 0,
    };
  } catch (err) {
    console.warn('[Role] 端末役割ファイルの読み込みに失敗:', err.message);
    return null;
  }
}

function writeTerminalRole({ shareMode, parentIp = '' }) {
  try {
    const role = {
      shareMode: normalizeShareMode(shareMode),
      parentIp: String(parentIp || ''),
      updatedAt: Date.now(),
    };
    safeWriteFile(TERMINAL_ROLE_FILE, JSON.stringify(role, null, 2));
    return role;
  } catch (err) {
    console.warn('[Role] 端末役割ファイルの保存に失敗:', err.message);
    return null;
  }
}

function syncTerminalRoleFromLocalDbRequest(url, method, bodyStr) {
  if (!/^tables\/system_settings\/(share_mode|parent_ip)$/.test(url || '')) return;
  if (method !== 'PATCH' && method !== 'PUT' && method !== 'POST') return;
  try {
    const body = JSON.parse(bodyStr || '{}');
    const current = readTerminalRole() || {};
    const id = url.split('/').pop();
    const next = {
      shareMode: current.shareMode || 'parent',
      parentIp: current.parentIp || '',
    };
    if (id === 'share_mode') next.shareMode = body.value;
    if (id === 'parent_ip') next.parentIp = body.value;
    writeTerminalRole(next);
  } catch (err) {
    console.warn('[Role] 端末役割の同期に失敗:', err.message);
  }
}

function isLocalParentAddress(parentIp) {
  const value = String(parentIp || '').trim().toLowerCase();
  if (!value) return true;
  if (value === 'localhost' || value === '127.0.0.1' || value === '::1') return true;
  const localAddresses = new Set();
  Object.values(os.networkInterfaces()).forEach(addrs => {
    (addrs || []).forEach(addr => {
      if (addr && addr.address) localAddresses.add(String(addr.address).toLowerCase());
    });
  });
  return localAddresses.has(value);
}

function repairShareModeBeforeServerStart() {
  const db = readDB();
  db.system_settings = db.system_settings || [];
  const shareModeSetting = getSettingRecord(db, 'share_mode');
  const parentIpSetting = getSettingRecord(db, 'parent_ip');
  const dbShareMode = normalizeShareMode(shareModeSetting?.value);
  const dbParentIp = String(parentIpSetting?.value || '');
  let terminalRole = readTerminalRole();

  if (!terminalRole) {
    const inferredShareMode = dbShareMode === 'client' && isLocalParentAddress(dbParentIp)
      ? 'parent'
      : dbShareMode;
    terminalRole = writeTerminalRole({ shareMode: inferredShareMode, parentIp: dbParentIp }) ||
      { shareMode: inferredShareMode, parentIp: dbParentIp };
  }

  const roleShareMode = normalizeShareMode(terminalRole.shareMode);
  const roleParentIp = String(terminalRole.parentIp || '');
  let changed = false;

  if (shareModeSetting) {
    if (normalizeShareMode(shareModeSetting.value) !== roleShareMode) {
      shareModeSetting.value = roleShareMode;
      changed = true;
    }
  } else {
    db.system_settings.push({ id: 'share_mode', value: roleShareMode });
    changed = true;
  }

  if (parentIpSetting) {
    if (String(parentIpSetting.value || '') !== roleParentIp) {
      parentIpSetting.value = roleParentIp;
      changed = true;
    }
  } else {
    db.system_settings.push({ id: 'parent_ip', value: roleParentIp });
    changed = true;
  }

  if (changed) {
    writeDB(db);
    console.warn(`[Role] 起動時にshare_modeを端末役割(${roleShareMode})へ自動修復しました`);
  }

  return roleShareMode;
}

// SMBネットワーク共有フォルダの同期認証（Windows用）
function authenticateSMBSync(watchPath) {
  if (!watchPath || !watchPath.startsWith('\\\\')) return;
  const db = readDB();
  const smbModeSetting = db.system_settings?.find(s => s.id === 'smb_auth_mode');
  const smbMode = smbModeSetting ? smbModeSetting.value : 'current';
  if (smbMode !== 'custom') return;

  const usernameSetting = db.system_settings?.find(s => s.id === 'smb_username');
  const passwordSetting = db.system_settings?.find(s => s.id === 'smb_password');
  const username = usernameSetting ? usernameSetting.value.trim() : '';
  const password = passwordSetting ? passwordSetting.value.trim() : '';

  if (!username || !password) return;

  const parts = watchPath.split('\\').filter(p => p.length > 0);
  if (parts.length < 2) return;
  const targetShare = `\\\\${parts[0]}\\${parts[1]}`;

  console.log(`[SMB Auth] 同期認証中: target=${targetShare}, user=${username}`);

  try {
    // 既存セッションの削除
    try {
      execFileSync('net', ['use', targetShare, '/delete', '/y'], { stdio: 'ignore', timeout: 3000 });
    } catch(e) {}
    
    // 新規接続セッションの作成
    execFileSync('net', ['use', targetShare, password, `/user:${username}`, '/persistent:no'], { stdio: 'ignore', timeout: 5000 });
    console.log(`[SMB Auth Success] ネットワークパス認証成功: ${targetShare}`);
  } catch (err) {
    console.error(`[SMB Auth Error] ネットワークパス認証失敗:`, err.message);
  }
}

// 監視フォルダパスの決定
function resolveWatchDir() {
  const db = readDB();
  const setting = db.system_settings?.find(s => s.id === 'import_directory');
  let watchPath = setting && setting.value ? setting.value.trim() : '';
  if (!watchPath) {
    watchPath = path.join(__dirname, 'import_folder');
  }

  // UNCパスの場合のみSMBネットワーク共有フォルダの認証を実行
  authenticateSMBSync(watchPath);

  if (!fs.existsSync(watchPath)) {
    try {
      fs.mkdirSync(watchPath, { recursive: true });
    } catch (err) {
      console.error(`[Watcher] フォルダの作成に失敗しました: ${watchPath}`, err);
    }
  }
  return watchPath;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'TransBoard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    }
  });

  mainWindow.setMenu(null); // Hide file menu on Windows/Linux

  // Ctrl+Shift+I で開発者ツールを開く（デバッグ用）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key === 'I') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // マイク・カメラ・クリップボード書き込み・ローカルネットワークアクセスの
  // パーミッション要求を明示的に許可する。
  // - clipboard-sanitized-write/clipboard-read: APIトークン等の「コピー」ボタン用。
  //   新しいChromiumでは navigator.clipboard.writeText() もこのハンドラ経由で判定される。
  // - local-network-access: Electron 41 (Chromium 146) で導入されたLNA制限用の保険
  //   （実際の無効化は app.commandLine.appendSwitch('disable-features', 'LocalNetworkAccessChecks')
  //   で行っているが、将来そのフラグが廃止された場合に備えてここでも明示許可する）
  // 注: setPermissionCheckHandler は設定しない。checkハンドラ未設定時の既定は「許可」
  // であり、拒否デフォルトのcheckハンドラを設けると fullscreen 等これまで暗黙に
  // 通っていた同期判定まで壊してしまうため（requestハンドラのみで制御する）。
  const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'clipboard-read', 'local-network-access']);
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (event) => {
    const shareMode = normalizeShareMode(getSettingRecord(readDB(), 'share_mode')?.value);
    if (!isQuitting && shareMode === 'parent') {
      event.preventDefault();
      mainWindow.hide();
      if (tray) {
        tray.displayBalloon?.({
          title: 'TransBoard',
          content: '親機サーバーはバックグラウンドで稼働中です。',
        });
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('fullscreen-changed', true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('fullscreen-changed', false);
  });

  console.log(`[DB] ローカルデータベースファイルの場所: ${DB_FILE}`);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  const iconPath = fs.existsSync(path.join(__dirname, 'build', 'icon.ico'))
    ? path.join(__dirname, 'build', 'icon.ico')
    : path.join(__dirname, 'build', 'icon.png');
  tray = new Tray(iconPath);
  tray.setToolTip('TransBoard 親機サーバー');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'TransBoardを開く', click: showMainWindow },
    { type: 'separator' },
    {
      label: '終了',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', showMainWindow);
}

let currentIntervalTimer = null;

// インポート実行のトリガー設定（監視・定期タイマー）
function setupImportTrigger() {
  const db = readDB();
  const scheduleSetting = db.system_settings?.find(s => s.id === 'import_schedule');
  let schedule = { mode: 'realtime' };
  if (scheduleSetting && scheduleSetting.value) {
    try {
      schedule = JSON.parse(scheduleSetting.value);
    } catch (e) {
      console.error('[Watcher] スケジュール設定のパース失敗:', e);
    }
  }

  // 既存の監視・タイマーをクリア
  if (currentWatcher) {
    console.log(`[Watcher] 既存のフォルダ監視を停止します: ${currentWatchDir}`);
    currentWatcher.close();
    currentWatcher = null;
  }
  if (currentIntervalTimer) {
    console.log(`[Watcher] 既存の定期実行タイマーを停止します`);
    clearInterval(currentIntervalTimer);
    currentIntervalTimer = null;
  }

  const watchPath = resolveWatchDir();
  currentWatchDir = watchPath;

  if (schedule.mode === 'realtime') {
    console.log(`[Watcher] リアルタイム監視を開始します: ${currentWatchDir}`);
    currentWatcher = chokidar.watch(currentWatchDir, {
      ignored: isIgnoredWatchPath,
      depth: 0,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100
      }
    });

    currentWatcher.on('add', (filePath) => {
      if (path.extname(filePath).toLowerCase() === '.csv') {
        console.log(`[Watcher] CSV追加検知: ${filePath}`);
        importCSV(filePath).catch(err => console.error(`[Watcher] CSV取り込みエラー: ${filePath}`, err));
      }
    });
  } else if (schedule.mode === 'interval') {
    const mins = parseInt(schedule.intervalMin) || 10;
    console.log(`[Scheduler] 定期インポート（${mins}分ごと）を開始します: ${currentWatchDir}`);
    currentIntervalTimer = setInterval(() => {
      scanAndImportFolder(currentWatchDir);
    }, mins * 60 * 1000);
  } else if (schedule.mode === 'time') {
    const times = schedule.times || [];
    console.log(`[Scheduler] 時刻指定インポート（${times.join(', ')}）を開始します: ${currentWatchDir}`);
    let lastExecutedTimeStr = '';
    currentIntervalTimer = setInterval(() => {
      const d = new Date();
      const timeStr = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
      if (times.includes(timeStr) && lastExecutedTimeStr !== timeStr) {
        lastExecutedTimeStr = timeStr;
        console.log(`[Scheduler] 指定時刻になりました (${timeStr})。フォルダをスキャンします...`);
        scanAndImportFolder(currentWatchDir);
      }
    }, 30000); // 30秒ごとに時刻チェック
  }
}

// フォルダ内にあるCSVをすべてスキャンしてインポート
function scanAndImportFolder(watchPath) {
  if (!fs.existsSync(watchPath)) return;
  fs.readdir(watchPath, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(watchPath, file);
      try {
        if (fs.statSync(filePath).isFile() && path.extname(file).toLowerCase() === '.csv') {
          console.log(`[Scheduler] CSVファイルスキャン検出: ${filePath}`);
          importCSV(filePath);
        }
      } catch (statErr) {
        console.warn(`[Scheduler] ファイル取得スキップ (削除済みの可能性): ${file}`);
      }
    });
  });
}

// ============================================================
// 汎用スケジュール取り込み（schedule_feeds / schedule_items）
// ============================================================

let scheduleFeedWatchers = [];
let scheduleFeedTimers = [];

function setupScheduleFeedTriggers() {
  // 既存の監視・タイマーをすべて停止
  scheduleFeedWatchers.forEach(w => { try { w.close(); } catch (e) {} });
  scheduleFeedWatchers = [];
  scheduleFeedTimers.forEach(t => clearInterval(t));
  scheduleFeedTimers = [];

  const db = readDB();
  const feeds = (db.schedule_feeds || []).filter(f => f.is_active && f.watch_dir);

  feeds.forEach(feed => {
    const watchDir = feed.watch_dir.trim();
    if (!fs.existsSync(watchDir)) return;

    const schedule = feed.schedule || { mode: 'realtime' };

    if (schedule.mode === 'realtime') {
      const watcher = chokidar.watch(watchDir, {
        ignored: isIgnoredWatchPath,
        depth: 0,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 }
      });
      watcher.on('add', filePath => {
        if (path.extname(filePath).toLowerCase() === '.csv') {
          importScheduleFeedCSV(filePath, feed).catch(err => console.error(`[ScheduleFeed] CSV取り込みエラー: ${filePath}`, err));
        }
      });
      scheduleFeedWatchers.push(watcher);
    } else if (schedule.mode === 'interval') {
      const mins = parseInt(schedule.intervalMin) || 10;
      const timer = setInterval(() => scanAndImportScheduleFolder(watchDir, feed), mins * 60 * 1000);
      scheduleFeedTimers.push(timer);
    } else if (schedule.mode === 'time') {
      const times = schedule.times || [];
      let lastRun = '';
      const timer = setInterval(() => {
        const d = new Date();
        const t = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
        if (times.includes(t) && lastRun !== t) {
          lastRun = t;
          scanAndImportScheduleFolder(watchDir, feed);
        }
      }, 30000);
      scheduleFeedTimers.push(timer);
    }
  });

  console.log(`[ScheduleFeed] ${feeds.length}件のスケジュールフィード監視を設定しました`);
}

function scanAndImportScheduleFolder(watchDir, feed) {
  if (!fs.existsSync(watchDir)) return;
  fs.readdir(watchDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      try {
        const filePath = path.join(watchDir, file);
        if (fs.statSync(filePath).isFile() && path.extname(file).toLowerCase() === '.csv') {
          importScheduleFeedCSV(filePath, feed);
        }
      } catch (e) {}
    });
  });
}

function parseScheduleDatetimeMs(dateStr, timeStr) {
  if (!dateStr) return null;
  const combined = timeStr ? `${dateStr.trim()} ${timeStr.trim()}` : dateStr.trim();

  // ISO形式 or ブラウザ互換形式を試みる
  let d = new Date(combined);
  if (!isNaN(d.getTime())) return d.getTime();

  // YYYY/MM/DD HH:mm or YYYY-MM-DD HH:mm
  const m1 = combined.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[\s　T]+(\d{1,2})[：:](\d{2}))?/);
  if (m1) {
    const [, y, mo, dy, h = '0', mi = '0'] = m1;
    d = new Date(Number(y), Number(mo) - 1, Number(dy), Number(h), Number(mi));
    if (!isNaN(d.getTime())) return d.getTime();
  }

  // MM/DD/YYYY HH:mm
  const m2 = combined.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m2) {
    const [, mo, dy, y, h = '0', mi = '0'] = m2;
    d = new Date(Number(y), Number(mo) - 1, Number(dy), Number(h), Number(mi));
    if (!isNaN(d.getTime())) return d.getTime();
  }

  return null;
}

function importScheduleFeedCSV(filePath, feed) {
  try {
    const buffer = fs.readFileSync(filePath);
    let encoding = 'shift-jis';
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      encoding = 'utf-8';
    } else if (isUtf8(buffer)) {
      encoding = 'utf-8';
    }
    const decodedText = new TextDecoder(encoding).decode(buffer);

    const mapping = feed.mapping || {};
    const results = [];
    Readable.from([decodedText])
      .pipe(csv())
      .on('data', row => results.push(row))
      .on('end', () => {
        const db = readDB();
        if (!db.schedule_items) db.schedule_items = [];

        // このフィードの既存アイテムをすべて削除してから再挿入
        db.schedule_items = db.schedule_items.filter(x => x.feed_id !== feed.id);

        let count = 0;
        results.forEach(row => {
          const dateVal = mapping.col_date ? row[mapping.col_date] : null;
          const timeVal = mapping.col_time ? row[mapping.col_time] : null;
          const dtVal = mapping.col_datetime ? row[mapping.col_datetime] : null;

          const startMs = parseScheduleDatetimeMs(dtVal || dateVal, dtVal ? null : timeVal);
          if (!startMs) return;

          const title = mapping.col_title ? (row[mapping.col_title] || '') : '';
          const identifier = mapping.col_id ? (row[mapping.col_id] || '') : '';
          const durationMin = mapping.col_duration_min ? parseInt(row[mapping.col_duration_min]) || null : null;

          db.schedule_items.push({
            id: `sched-${feed.id}-${startMs}-${count}`,
            feed_id: feed.id,
            feed_name: feed.name || '取り込みスケジュール',
            color: feed.color || '#7c3aed',
            ward_ids: feed.ward_ids || [], // 空配列 = 全病棟
            title,
            identifier,
            start_ms: startMs,
            duration_min: durationMin,
            raw: row,
            imported_at: Date.now()
          });
          count++;
        });

        writeDB(db);
        console.log(`[ScheduleFeed] "${feed.name}" 取り込み完了: ${count}件 (${path.basename(filePath)})`);

        if (mainWindow) {
          mainWindow.webContents.send('schedule-imported', {
            feedId: feed.id,
            feedName: feed.name,
            fileName: path.basename(filePath),
            count
          });
        }

        // アーカイブ処理（メイン取り込みと同様）
        const policy = feed.retention_policy || { action: 'archive', retentionDays: '30' };
        archiveScheduleFeedFile(filePath, feed, policy);
      })
      .on('error', err => {
        console.error(`[ScheduleFeed] "${feed.name}" パースエラー:`, err);
      });
  } catch (err) {
    console.error(`[ScheduleFeed] "${feed.name}" 読み込みエラー:`, err);
  }
}

function archiveScheduleFeedFile(filePath, feed, policy) {
  if (policy.action === 'skip') return;
  if (policy.action === 'delete') {
    try { fs.unlinkSync(filePath); } catch (e) {}
    return;
  }
  // archive
  const archiveDir = path.join(path.dirname(filePath), 'archive');
  try { fs.mkdirSync(archiveDir, { recursive: true }); } catch (e) {}
  const baseName = path.basename(filePath);
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let destPath = path.join(archiveDir, baseName);
  if (fs.existsSync(destPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    destPath = path.join(archiveDir, `${stem}_${ts}${ext}`);
  }
  try { fs.renameSync(filePath, destPath); } catch (e) {}
}

// UTF-8 のバイナリパターン検証（日本語対応）
function isUtf8(buf) {
  let i = 0;
  while (i < buf.length) {
    if (buf[i] <= 0x7F) { // 0xxxxxxx
      i += 1;
    } else if ((buf[i] & 0xE0) === 0xC0) { // 110xxxxx 10xxxxxx
      if (i + 1 >= buf.length || (buf[i + 1] & 0xC0) !== 0x80) return false;
      i += 2;
    } else if ((buf[i] & 0xF0) === 0xE0) { // 1110xxxx 10xxxxxx 10xxxxxx
      if (i + 2 >= buf.length || (buf[i + 1] & 0xC0) !== 0x80 || (buf[i + 2] & 0xC0) !== 0x80) return false;
      i += 3;
    } else if ((buf[i] & 0xF8) === 0xF0) { // 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
      if (i + 3 >= buf.length || (buf[i + 1] & 0xC0) !== 0x80 || (buf[i + 2] & 0xC0) !== 0x80 || (buf[i + 3] & 0xC0) !== 0x80) return false;
      i += 4;
    } else {
      return false;
    }
  }
  return true;
}

// CSVファイルをパースしてレンダラーへ送信
function importCSV(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    
    // 文字コードの自動判定（BOM判定 または UTF-8バイナリ判定）
    let encoding = 'shift-jis'; // デフォルトは Shift-JIS
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      encoding = 'utf-8';
    } else if (isUtf8(buffer)) {
      encoding = 'utf-8';
    } else {
      // マッピング設定に保存されている設定値があればフォールバック
      const db = readDB();
      const mappingSetting = db.system_settings?.find(s => s.id === 'import_mapping');
      if (mappingSetting && mappingSetting.value) {
        try {
          const mapping = JSON.parse(mappingSetting.value);
          if (mapping.encoding) {
            encoding = mapping.encoding;
          }
        } catch (e) {}
      }
    }
    
    const decoder = new TextDecoder(encoding);
    const decodedText = decoder.decode(buffer);

    const results = [];
    Readable.from([decodedText])
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        console.log(`[Watcher] パース完了 (${encoding}): ${results.length} 件`);
        if (mainWindow) {
          mainWindow.webContents.send('data-imported', {
            fileName: path.basename(filePath),
            rows: results
          });
        }
        archiveFile(filePath);
      })
      .on('error', (err) => {
        console.error('[Watcher] パースエラー:', err);
        if (mainWindow) {
          mainWindow.webContents.send('data-import-failed', {
            fileName: path.basename(filePath),
            error: err.message
          });
        }
      });
  } catch (err) {
    console.error('[Watcher] ファイル読み込みまたはデコードエラー:', err);
    if (mainWindow) {
      mainWindow.webContents.send('data-import-failed', {
        fileName: path.basename(filePath),
        error: err.message
      });
    }
  }
}

// 古いアーカイブファイルを整理
function cleanOldArchives() {
  const db = readDB();
  const policySetting = db.system_settings?.find(s => s.id === 'import_retention_policy');
  let policy = { action: 'archive', retentionDays: '30' };
  if (policySetting && policySetting.value) {
    try {
      policy = JSON.parse(policySetting.value);
    } catch (e) {
      console.error('[Watcher] ポリシー設定のパース失敗:', e);
    }
  }

  if (policy.action !== 'archive') return;
  const days = parseInt(policy.retentionDays) || 30;
  if (days <= 0) return; // 0は無制限

  const watchDir = resolveWatchDir();
  const archiveDir = path.join(watchDir, 'archive');
  if (!fs.existsSync(archiveDir)) return;

  const now = Date.now();
  const maxAgeMs = days * 24 * 60 * 60 * 1000;

  fs.readdir(archiveDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(archiveDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        const ageMs = now - stats.mtimeMs;
        if (ageMs > maxAgeMs) {
          fs.unlink(filePath, (err) => {
            if (err) console.error(`[Cleaner] 古いアーカイブファイルの削除失敗: ${file}`, err);
            else console.log(`[Cleaner] 古いアーカイブファイルを削除しました: ${file}`);
          });
        }
      });
    });
  });
}

// ファイルをアーカイブ移動または削除
function archiveFile(filePath) {
  const db = readDB();
  const policySetting = db.system_settings?.find(s => s.id === 'import_retention_policy');
  let policy = { action: 'archive', retentionDays: '30' };
  if (policySetting && policySetting.value) {
    try {
      policy = JSON.parse(policySetting.value);
    } catch (e) {
      console.error('[Watcher] ポリシー設定のパース失敗:', e);
    }
  }

  if (policy.action === 'skip') {
    console.log(`[Watcher] ポリシー: そのまま残す (スキップ): ${filePath}`);
    return;
  }

  if (policy.action === 'delete') {
    // 即時物理削除
    setTimeout(() => {
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error('[Watcher] ファイル即時削除失敗 (リトライします):', err);
          setTimeout(() => {
            fs.unlink(filePath, (err2) => {
              if (err2) console.error('[Watcher] ファイル即時削除リトライ失敗:', err2);
              else console.log(`[Watcher] ファイル即時削除完了 (リトライ成功): ${filePath}`);
            });
          }, 1000);
        } else {
          console.log(`[Watcher] ファイル即時削除完了: ${filePath}`);
        }
      });
    }, 200);
    return;
  }

  const baseDir = path.dirname(filePath);
  const archiveDir = path.join(baseDir, 'archive');
  if (!fs.existsSync(archiveDir)) {
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
    } catch (mkdirErr) {
      const msg = `archiveフォルダの作成に失敗しました。権限を確認してください。\nフォルダ: ${archiveDir}\n理由: ${mkdirErr.message}`;
      console.error('[Watcher]', msg, mkdirErr);
      if (mainWindow) {
        mainWindow.webContents.send('archive-error', {
          fileName: path.basename(filePath),
          archiveDir,
          error: msg,
          code: mkdirErr.code
        });
      }
      return;
    }
  }
  const baseName = path.basename(filePath);
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let destPath = path.join(archiveDir, baseName);
  if (fs.existsSync(destPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    destPath = path.join(archiveDir, `${stem}_${ts}${ext}`);
  }

  function sendArchiveError(err) {
    let hint = '';
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      hint = ' (アクセス権限がありません。設定でポリシーを「そのまま残す」に変更することで回避できます)';
    } else if (err.code === 'EBUSY') {
      hint = ' (ファイルが他のプロセスに使用中です)';
    } else if (err.code === 'EXDEV') {
      hint = ' (異なるドライブ間の移動はできません)';
    }
    const msg = `archiveフォルダへの移動に失敗しました${hint}\nファイル: ${path.basename(filePath)}\n理由: ${err.message}`;
    console.error('[Watcher]', msg);
    if (mainWindow) {
      mainWindow.webContents.send('archive-error', {
        fileName: path.basename(filePath),
        archiveDir,
        error: msg,
        code: err.code
      });
    }
  }

  // Windowsのファイル排他ロック問題を回避するため、少し待ってから移動する
  setTimeout(() => {
    fs.rename(filePath, destPath, (err) => {
      if (err) {
        console.error('[Watcher] アーカイブ移動失敗 (リトライします):', err);
        setTimeout(() => {
          fs.rename(filePath, destPath, (err2) => {
            if (err2) {
              console.error('[Watcher] アーカイブ移動リトライ失敗:', err2);
              sendArchiveError(err2);
            } else {
              console.log(`[Watcher] アーカイブ移動完了 (リトライ成功): ${destPath}`);
              cleanOldArchives();
            }
          });
        }, 1000);
      } else {
        console.log(`[Watcher] アーカイブ移動完了: ${destPath}`);
        cleanOldArchives();
      }
    });
  }, 200);
}

// IPC通信で監視対象フォルダパスをフロントに返す
ipcMain.handle('get-watch-directory', () => {
  return currentWatchDir;
});

function updateWatchDirectoryOnParent(newPath) {
  const resolved = newPath && newPath.trim() ? newPath.trim() : path.join(__dirname, 'import_folder');
  
  // UNCパスの場合のみSMBネットワーク共有フォルダの認証を実行
  authenticateSMBSync(resolved);

  if (!fs.existsSync(resolved)) {
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (err) {
      console.error(`[Watcher] フォルダの自動作成失敗:`, err);
    }
  }
  setupImportTrigger();
  setupScheduleFeedTriggers();
  return { success: true, path: resolved };
}

// IPC通信で監視対象フォルダを動的に切り替える
ipcMain.handle('update-watch-directory', (event, newPath) => updateWatchDirectoryOnParent(newPath));

async function triggerManualImportOnParent() {
  const watchPath = resolveWatchDir();
  if (!fs.existsSync(watchPath)) {
    return { success: false, message: '監視フォルダが存在しません。' };
  }
  try {
    const files = fs.readdirSync(watchPath);
    const csvFiles = files.filter(file => {
      const filePath = path.join(watchPath, file);
      return fs.statSync(filePath).isFile() && path.extname(file).toLowerCase() === '.csv';
    });
    if (csvFiles.length === 0) {
      return { success: true, count: 0, message: '監視フォルダに未処理のCSVファイルはありません。' };
    }
    await Promise.all(csvFiles.map(file => {
      const filePath = path.join(watchPath, file);
      return importCSV(filePath).catch(err => console.error(`[Manual Import] CSV取り込みエラー: ${filePath}`, err));
    }));
    return { success: true, count: csvFiles.length, message: `${csvFiles.length}件のCSVファイルを取り込み開始しました。` };
  } catch (err) {
    console.error('[Manual Import] エラー:', err);
    return { success: false, message: err.message };
  }
}

// IPC通信で手動でのフォルダスキャン・CSV取り込みを実行する
ipcMain.handle('trigger-manual-import', () => triggerManualImportOnParent());

// ODBC読み取り専用安全対策: SQLクエリバリデーション
function validateReadOnlyQuery(sql) {
  if (!sql) return { valid: false, message: 'SQLクエリが空です。' };
  
  // コメントの除去 (ブロックコメントと行コメント)
  const cleanSql = sql.trim().replace(/\/\*[\s\S]*?\*\/|--.*$/gm, '');
  
  // SELECTまたはWITHで開始しているか検証 (先頭の括弧やスペースを考慮)
  if (!/^\(?(SELECT|WITH)\b/i.test(cleanSql)) {
    return { valid: false, message: '安全対策のため、SQLクエリは SELECT または WITH で開始する必要があります。' };
  }
  
  // 文字列リテラルを除去してからキーワード検証（リテラル内の単語への誤検知防止）
  const sqlWithoutStrings = cleanSql.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

  // 書き込み・変更系のキーワードを検出 (単語境界を使用)
  const forbiddenKeywords = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create',
    'truncate', 'replace', 'merge', 'grant', 'revoke',
    'exec', 'execute', 'into'
  ];

  for (const keyword of forbiddenKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(sqlWithoutStrings)) {
      return {
        valid: false,
        message: `安全対策のため、データベース書き込み/変更を伴う可能性のあるキーワード「${keyword.toUpperCase()}」は使用できません。`
      };
    }
  }

  // セミコロンによる複数ステートメントの検証 (文字列リテラル内を除く)
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let hasStatementsAfterSemicolon = false;
  
  for (let i = 0; i < cleanSql.length; i++) {
    const char = cleanSql[i];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      // セミコロンの後に空白以外の文字が続いているか検証
      const remaining = cleanSql.slice(i + 1).trim();
      if (remaining.length > 0) {
        hasStatementsAfterSemicolon = true;
        break;
      }
    }
  }
  
  if (hasStatementsAfterSemicolon) {
    return { valid: false, message: '安全対策のため、複数SQLステートメントの同時実行は禁止されています。' };
  }
  
  return { valid: true };
}

// ODBC読み取り専用安全対策: 接続文字列の強制付与
function enforceReadOnlyConnectionString(connStr) {
  if (!connStr) return { valid: false, message: '接続文字列が空です。' };
  
  const lowerConn = connStr.toLowerCase();
  
  // すでに何らかの読み取り専用オプションが指定されているか確認
  const hasReadOnly = 
    lowerConn.includes('readonly=1') ||
    lowerConn.includes('readonly=true') ||
    lowerConn.includes('mode=read') ||
    lowerConn.includes('applicationintent=readonly');
    
  let finalConnStr = connStr;
  if (!hasReadOnly) {
    const base = connStr.trim();
    const separator = base.endsWith(';') ? '' : ';';
    finalConnStr = `${base}${separator}ReadOnly=1;`;
  }
  
  return { valid: true, connectionString: finalConnStr };
}

function execOdbcPowerShell(connectionString, scriptBody, timeoutMs = 15000) {
  const safe = String(connectionString).slice(0, 500).replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Data
  $conn = New-Object System.Data.Odbc.OdbcConnection('${safe}')
  $conn.Open()
${scriptBody}
  $conn.Close()
} catch {
  Write-Output "ERROR:$($_.Exception.Message)"
}`.trim();

  try {
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: timeoutMs }).trim();
    if (!out || out.startsWith('ERROR:')) {
      return { success: false, error: out ? out.slice(6) : '接続に失敗しました' };
    }
    return { success: true, output: out };
  } catch (e) {
    if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
      return {
        success: false,
        error: `処理がタイムアウトしました（${Math.round(timeoutMs / 1000)}秒）。データベースの応答が遅いか、ネットワーク/権限の問題が考えられます。`
      };
    }
    return { success: false, error: e.message };
  }
}

async function getOdbcTablesOnParent({ connectionString }) {
  if (!connectionString) return { success: false, error: '接続文字列が指定されていません', tables: [] };
  const connResult = enforceReadOnlyConnectionString(connectionString);
  if (!connResult.valid) {
    return { success: false, error: connResult.message, tables: [] };
  }

  const result = execOdbcPowerShell(connResult.connectionString, `
  $schema = $conn.GetSchema('Tables')
  $items = @($schema | Where-Object { $_.TABLE_TYPE -in @('TABLE','VIEW','SYSTEM TABLE') } |
    Select-Object @{N='name';E={$_.TABLE_NAME}}, @{N='type';E={$_.TABLE_TYPE}} |
    Sort-Object type, name)
  if ($items.Count -eq 0) { Write-Output '[]' } else { $items | ConvertTo-Json -Compress }`, 25000);
  if (!result.success) {
    const hint = 'テーブル一覧の取得に失敗しました。ODBCドライバがテーブル一覧の取得に対応していないか、データベースアカウントにメタデータ参照権限がない可能性があります。手動入力も利用できます。';
    return { success: false, error: `${hint}\n詳細: ${result.error}`, tables: [] };
  }
  try {
    const raw = JSON.parse(result.output);
    const tables = (Array.isArray(raw) ? raw : [raw]).map(r => ({ name: r.name, type: r.type }));
    return { success: true, tables };
  } catch (e) {
    return { success: false, error: e.message, tables: [] };
  }
}

// IPC通信でODBC接続経由でテーブル/ビュー一覧を取得する
ipcMain.handle('get-odbc-tables', (event, config) => getOdbcTablesOnParent(config || {}));

function getOdbcDsnsOnParent() {
  const result = { system: [], user: [], drivers: [] };
  const regQuery = (hive, subkey) => {
    try {
      const out = execSync(`reg query "${hive}\\SOFTWARE\\ODBC\\ODBC.INI\\${subkey}"`, { encoding: 'utf8', timeout: 5000 });
      return out.split('\r\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith(hive) && !l.startsWith('HKEY'))
        .map(l => { const m = l.match(/^(.+?)\s+REG_SZ\s+(.+)$/); return m ? { name: m[1].trim(), driver: m[2].trim() } : null; })
        .filter(Boolean);
    } catch { return []; }
  };
  const driverQuery = (hive) => {
    try {
      const out = execSync(`reg query "${hive}\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers"`, { encoding: 'utf8', timeout: 5000 });
      return out.split('\r\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith(hive) && !l.startsWith('HKEY'))
        .map(l => { const m = l.match(/^(.+?)\s+REG_SZ\s+Installed$/i); return m ? m[1].trim() : null; })
        .filter(Boolean);
    } catch { return []; }
  };

  result.system  = regQuery('HKLM', 'ODBC Data Sources');
  result.user    = regQuery('HKCU', 'ODBC Data Sources');
  result.drivers = [...new Set([...driverQuery('HKLM'), ...driverQuery('HKCU')])];
  return result;
}

// IPC通信でWindowsレジストリからシステム/ユーザーDSN一覧を取得する
ipcMain.handle('get-odbc-dsns', () => getOdbcDsnsOnParent());

async function testOdbcConnectionOnParent({ connectionString, sqlQuery }) {
  // 接続文字列の検証 & 読み取り専用属性の付与
  const connResult = enforceReadOnlyConnectionString(connectionString);
  if (!connResult.valid) {
    return { success: false, message: connResult.message };
  }
  const finalConnStr = connResult.connectionString;

  // SQLクエリの安全検証
  const queryResult = validateReadOnlyQuery(sqlQuery);
  if (!queryResult.valid) {
    return { success: false, message: queryResult.message };
  }

  if (!finalConnStr || !finalConnStr.includes('DSN=')) {
    return { success: false, message: '接続文字列にDSN指定が見つかりません。例: DSN=EMR_DB;UID=admin;PWD=pass;' };
  }

  const result = execOdbcPowerShell(finalConnStr, "  Write-Output 'OK'", 15000);
  if (!result.success) {
    return { success: false, message: 'ODBCデータベース接続テストに失敗しました: ' + result.error };
  }
  return { success: true, message: 'ODBCデータベース接続テストに成功しました。(接続先: ' + finalConnStr.split(';')[0] + ' [読み取り専用: 強制適用済、実接続確認済])' };
}

// IPC通信でODBCデータベース接続テストを行う
ipcMain.handle('test-odbc-connection', (event, config) => testOdbcConnectionOnParent(config || {}));

function buildOdbcRowFetchScript(sqlQuery, maxRows = null) {
  const safeQuery = String(sqlQuery).replace(/'/g, "''");
  const breakCheck = maxRows ? `if ($rows.Count -ge ${maxRows}) { $hasMore = $true; break }` : '';
  return `
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = '${safeQuery}'
  $cmd.CommandTimeout = 25
  $reader = $cmd.ExecuteReader()
  $cols = @()
  for ($i = 0; $i -lt $reader.FieldCount; $i++) { $cols += $reader.GetName($i) }
  $rows = New-Object System.Collections.ArrayList
  $hasMore = $false
  while ($reader.Read()) {
    ${breakCheck}
    $obj = [ordered]@{}
    foreach ($c in $cols) {
      $v = $reader[$c]
      if ($v -is [DBNull]) { $obj[$c] = '' } else { $obj[$c] = "$v" }
    }
    [void]$rows.Add((New-Object PSObject -Property $obj))
  }
  $reader.Close()
  $result = [ordered]@{ columns = @($cols); rows = @($rows); truncated = $hasMore }
  $result | ConvertTo-Json -Compress -Depth 6`;
}

function parseOdbcRows(output) {
  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed.rows) ? parsed.rows : (parsed.rows ? [parsed.rows] : []);
  const columns = Array.isArray(parsed.columns) ? parsed.columns : (parsed.columns ? [parsed.columns] : []);
  return {
    columns,
    rows,
    truncated: !!parsed.truncated,
  };
}

async function runOdbcSyncOnParent({ connectionString, sqlQuery }) {
  // 接続文字列の検証 & 読み取り専用属性の付与
  const connResult = enforceReadOnlyConnectionString(connectionString);
  if (!connResult.valid) {
    return { success: false, message: connResult.message };
  }
  const finalConnStr = connResult.connectionString;

  // SQLクエリの安全検証
  const queryResult = validateReadOnlyQuery(sqlQuery);
  if (!queryResult.valid) {
    return { success: false, message: queryResult.message };
  }

  if (!finalConnStr || !finalConnStr.includes('DSN=')) {
    return { success: false, message: '接続文字列にDSN指定が見つかりません。' };
  }

  const result = execOdbcPowerShell(finalConnStr, buildOdbcRowFetchScript(sqlQuery, null), 30000);
  if (!result.success) {
    return { success: false, message: 'ODBC同期に失敗しました: ' + result.error };
  }

  let rows;
  try {
    rows = parseOdbcRows(result.output).rows;
  } catch (e) {
    return { success: false, message: '取得結果の解析に失敗しました: ' + e.message };
  }

  if (mainWindow) {
    mainWindow.webContents.send('data-imported', {
      fileName: `ODBC同期 (${new Date().toLocaleString('ja-JP')})`,
      rows
    });
  }
  
  return { success: true, count: rows.length };
}

// IPC通信でODBC直接同期を実行する
ipcMain.handle('run-odbc-sync', (event, config) => runOdbcSyncOnParent(config || {}));

async function previewOdbcQueryOnParent({ connectionString, sqlQuery } = {}) {
  const connResult = enforceReadOnlyConnectionString(connectionString);
  if (!connResult.valid) {
    return { success: false, message: connResult.message };
  }
  const finalConnStr = connResult.connectionString;

  const queryResult = validateReadOnlyQuery(sqlQuery);
  if (!queryResult.valid) {
    return { success: false, message: queryResult.message };
  }

  if (!finalConnStr || !finalConnStr.includes('DSN=')) {
    return { success: false, message: '接続文字列にDSN指定が見つかりません。' };
  }

  const result = execOdbcPowerShell(finalConnStr, buildOdbcRowFetchScript(sqlQuery, 15), 20000);
  if (!result.success) {
    return { success: false, message: 'プレビューの取得に失敗しました: ' + result.error };
  }

  try {
    return { success: true, ...parseOdbcRows(result.output) };
  } catch (e) {
    return { success: false, message: '取得結果の解析に失敗しました: ' + e.message };
  }
}

// IPC通信でODBCクエリのプレビューを取得する。本番データには書き込まない。
ipcMain.handle('preview-odbc-query', (event, config) => previewOdbcQueryOnParent(config || {}));

// IPC通信で出棟中（進行中）の移送情報をリセットする
ipcMain.handle('reset-database', () => {
  const db = readDB();
  
  // 進行中のステータス一覧
  const activeStatuses = ['DEPART_REGISTERED', 'MOVING', 'ARRIVED', 'IN_EXAM', 'NEARLY_DONE', 'PICKUP_REQUIRED'];
  
  if (Array.isArray(db.transfer_events)) {
    // 進行中のイベントIDを取得
    const activeEventIds = db.transfer_events
      .filter(e => activeStatuses.includes(e.current_status))
      .map(e => e.id);

    // 進行中のイベントのみを削除（完了・キャンセル済みは残す）
    db.transfer_events = db.transfer_events.filter(e => !activeStatuses.includes(e.current_status));

    // 進行中イベントに対応するステータス変更ログを削除
    if (Array.isArray(db.transfer_status_logs)) {
      db.transfer_status_logs = db.transfer_status_logs.filter(log => !activeEventIds.includes(log.transfer_event_id));
    }
  }

  // ※ 患者情報 (beds の patient_name, patient_id, is_present) は消去しません。
  // ※ 通話履歴 (calls) や 取り込み履歴 (import_logs) も消去しません。

  // デモデータ挿入フラグを true にして、再起動時にデモデータが読み込まれないようにする
  const flagIndex = db.system_settings.findIndex(s => s.id === 'demo_inserted');
  if (flagIndex !== -1) {
    db.system_settings[flagIndex].value = 'true';
  } else {
    db.system_settings.push({ id: 'demo_inserted', value: 'true' });
  }
  
  writeDB(db);
  console.log('[DB] 進行中の移送情報と関連ログをクリアしました');
  return { success: true };
});

// WebRTCシグナリング処理関数
function processWebrtcRequest(method, urlPath, bodyStr) {
  const cleanUrl = urlPath.replace(/^\//, '');
  const [pathname, search] = cleanUrl.split('?');
  const action = pathname.replace(/^webrtc\//, ''); // 'send' や 'poll'
  const searchParams = new URLSearchParams(search || '');

  // ブロードキャスト型（offer/speech/answered）: 全端末受信・消費しない
  // ユニキャスト型（answer/ice/hangup/busy）: 1台受信・消費する
  const BROADCAST_TYPES = new Set(['offer', 'speech', 'answered']);

  if (action === 'send') {
    if (method !== 'POST') return { success: false, message: 'Method Not Allowed' };
    try {
      const msg = JSON.parse(bodyStr);
      const to = msg.to;
      const from = msg.from;
      if (!isSafeSignalingId(to)) return { success: false, message: 'Missing or invalid "to" field' };
      if (from !== undefined && !isSafeSignalingId(from)) return { success: false, message: 'Invalid "from" field' };

      const msgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const entry = { msg: { ...msg, msgId }, timestamp: Date.now(), ackedBy: Object.create(null) };

      if (BROADCAST_TYPES.has(msg.type)) {
        // ブロードキャストキュー（消費しない）
        if (!webrtcSignalingQueue[`bc:${to}`]) webrtcSignalingQueue[`bc:${to}`] = [];
        const MAX_BC = 100;
        if (webrtcSignalingQueue[`bc:${to}`].length >= MAX_BC) {
          webrtcSignalingQueue[`bc:${to}`].shift();
        }
        webrtcSignalingQueue[`bc:${to}`].push(entry);
      } else {
        // ユニキャストキュー（消費する）
        if (!webrtcSignalingQueue[to]) webrtcSignalingQueue[to] = [];
        const MAX_UC = 50;
        if (webrtcSignalingQueue[to].length >= MAX_UC) {
          webrtcSignalingQueue[to].shift();
        }
        webrtcSignalingQueue[to].push(entry);
      }
      console.log(`[WebRTC Signaling] Sent ${msg.type} from ${msg.from} to ${to}`);
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  if (action === 'poll') {
    if (method !== 'GET') return { success: false, message: 'Method Not Allowed' };
    const id = searchParams.get('id');
    const client = searchParams.get('client') || id;
    if (!isSafeSignalingId(id)) return { success: false, message: 'Missing or invalid "id" parameter' };
    if (!isSafeSignalingId(client)) return { success: false, message: 'Missing or invalid "client" parameter' };

    const now = Date.now();
    const EXPIRATION_MS = 30000;

    // ブロードキャストキュー：期限切れ除去のみ（消費しない）
    const bcKey = `bc:${id}`;
    if (webrtcSignalingQueue[bcKey]) {
      webrtcSignalingQueue[bcKey] = webrtcSignalingQueue[bcKey].filter(
        item => (now - item.timestamp) < EXPIRATION_MS
      );
    }
    const bcItems = (webrtcSignalingQueue[bcKey] || []).filter(item => {
      if (!item.ackedBy) item.ackedBy = Object.create(null);
      return !item.ackedBy[client];
    });
    bcItems.forEach(item => { item.ackedBy[client] = now; });
    const bcMessages = bcItems.map(item => item.msg);

    // ユニキャストキュー：取得して消費する
    const ucItems = webrtcSignalingQueue[id] || [];
    webrtcSignalingQueue[id] = [];
    const ucMessages = ucItems
      .filter(item => (now - item.timestamp) < EXPIRATION_MS)
      .map(item => item.msg);

    return { success: true, messages: [...bcMessages, ...ucMessages] };
  }
  
  return { success: false, message: 'Not Found' };
}

const ALLOWED_TABLES = new Set([
  'wards', 'beds', 'bed_types', 'exam_rooms', 'exam_types', 'staffs',
  'system_settings', 'transfer_events', 'transfer_status_logs',
  'calls', 'import_logs', 'schedule_feeds', 'schedule_items',
  'audit_logs', 'handover_notes',
]);

// 患者情報（氏名・ID）を含むテーブル。外部HTTPアクセス時はAPIトークン必須（セキュリティ: A-2）
// 申し送りメモ(handover_notes)は本文に患者名等が入りうるため患者データ扱いとする
const PATIENT_DATA_TABLES = new Set(['beds', 'transfer_events', 'audit_logs', 'handover_notes']);
const ACTIVE_TRANSFER_STATUSES = new Set([
  'DEPART_REGISTERED',
  'MOVING',
  'ARRIVED',
  'IN_EXAM',
  'NEARLY_DONE',
  'PICKUP_REQUIRED',
]);
const HIDEABLE_TRANSFER_STATUSES = new Set(['ARRIVED', 'NEARLY_DONE']);
const WARD_STATUS_ACTIONS = {
  DEPART_REGISTERED: ['MOVING', 'IN_EXAM', 'CANCELLED'],
  MOVING: ['ARRIVED', 'IN_EXAM', 'CANCELLED'],
  ARRIVED: ['IN_EXAM', 'CANCELLED'],
  IN_EXAM: ['NEARLY_DONE', 'PICKUP_REQUIRED', 'CANCELLED'],
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
  const setting = (db.system_settings || []).find(s => s.id === 'hidden_statuses');
  if (!setting || !setting.value) return new Set();
  try {
    const parsed = JSON.parse(setting.value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(status => HIDEABLE_TRANSFER_STATUSES.has(status)));
  } catch {
    return new Set();
  }
}

function getAllowedTransferTargets(fromStatus, db, actionMap = WARD_STATUS_ACTIONS) {
  const hidden = getHiddenTransferStatuses(db);
  const result = [];
  const seen = new Set();
  const visit = (targets) => {
    targets.forEach(status => {
      if (hidden.has(status)) {
        visit(actionMap[status] || []);
        return;
      }
      if (seen.has(status)) return;
      seen.add(status);
      result.push(status);
    });
  };
  visit(actionMap[fromStatus] || []);
  return result;
}

function isTransferStatusTransitionAllowed(fromStatus, toStatus, db) {
  if (!fromStatus || !toStatus) return false;
  if (fromStatus === toStatus) return true;
  return getAllowedTransferTargets(fromStatus, db, WARD_STATUS_ACTIONS).includes(toStatus) ||
    getAllowedTransferTargets(fromStatus, db, EXAM_STATUS_ACTIONS).includes(toStatus);
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

function sanitizeStatusExtraFields(extraFields) {
  const allowed = new Set(['patient_ic_tag_id', 'note', 'escort_staff_id', 'estimated_pickup_at']);
  const clean = {};
  if (!extraFields || typeof extraFields !== 'object' || Array.isArray(extraFields)) return clean;
  Object.entries(extraFields).forEach(([key, value]) => {
    if (allowed.has(key)) clean[key] = value;
  });
  return clean;
}

function createStatusSpeechMessage(db, event, newStatus, filledArrivedAtForDirectExamStart) {
  const bed = (db.beds || []).find(b => b.id === event.bed_id);
  const bedName = bed ? `${bed.bed_number}号床` : '患者';
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
      text: `${patientPrefix}${wardName}から、${bedName}が、${roomName}へ移動を開始しました。`,
    };
  }
  if (newStatus === 'ARRIVED' || filledArrivedAtForDirectExamStart) {
    return {
      from: event.exam_room_id,
      to: event.ward_id,
      type: 'speech',
      text: `${patientPrefix}${roomName}に、${bedName}が到着しました。`,
    };
  }
  if (newStatus === 'PICKUP_REQUIRED') {
    return {
      from: event.exam_room_id,
      to: event.ward_id,
      type: 'speech',
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
  if (isExternal && !isValidApiToken(apiToken)) {
    console.warn('[Security] 移送開始APIトークン認証失敗');
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }

  let payload;
  try { payload = JSON.parse(bodyStr || '{}'); } catch {
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
  db.transfer_status_logs = db.transfer_status_logs || [];
  db.transfer_status_logs.push({
    id: `log-${now}-${Math.random().toString(36).slice(2, 7)}`,
    transfer_event_id: eventId,
    from_status: null,
    to_status: 'MOVING',
    changed_by: 'UI操作',
    changed_at: now,
    note: '',
  });
  if (db.transfer_status_logs.length > 1000) {
    db.transfer_status_logs.splice(0, db.transfer_status_logs.length - 1000);
  }
  appendAuditLog(db, 'TRANSFER_START', {
    targetType: 'transfer_events',
    targetId: eventId,
    actorType: isExternal ? 'child_api' : 'local_ui',
    remoteIp: requestMeta.remoteIp || '',
    after: summarizeAuditRecord('transfer_events', eventData),
    details: { fromStatus: null, toStatus: 'MOVING', scope: 'ward' },
  });

  if (!writeDB(db)) {
    throw new Error('データベースの保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
  }

  const speechMsg = createStatusSpeechMessage(db, eventData, 'MOVING', false);
  if (speechMsg?.to) {
    processWebrtcRequest('POST', 'webrtc/send', JSON.stringify(speechMsg));
  }

  console.log(`[Transfer] Started: id=${eventId}, bed=${bed.id}, room=${examRoom.id}`);
  return { success: true, idempotent: false, event: eventData };
}

async function processStatusUpdateRequest(method, bodyStr, isExternal = false, apiToken = null) {
  if (method !== 'POST') {
    return { success: false, message: 'Method Not Allowed' };
  }
  if (isExternal && !isValidApiToken(apiToken)) {
    console.warn('[Security] ステータス更新APIトークン認証失敗');
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }

  let payload;
  try { payload = JSON.parse(bodyStr || '{}'); } catch {
    return { success: false, message: 'リクエストボディのJSONが不正です' };
  }

  const eventId = payload.eventId;
  const newStatus = payload.newStatus;
  const expectedStatus = payload.expectedStatus || null;
  const extraFields = sanitizeStatusExtraFields(payload.extraFields);
  const scope = payload.scope === 'exam' ? 'exam' : 'ward';

  if (!eventId || !newStatus) {
    return { success: false, message: 'eventId and newStatus are required' };
  }

  const db = readDB();
  const list = db.transfer_events || [];
  const index = list.findIndex(x => String(x.id) === String(eventId));
  if (index === -1) {
    return { success: false, message: 'Not Found' };
  }

  const current = list[index];
  const fromStatus = current.current_status || null;
  const maintenanceComplete = (
    payload.maintenance === true &&
    newStatus === 'RETURNED' &&
    ACTIVE_TRANSFER_STATUSES.has(fromStatus)
  );
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
  if (!maintenanceComplete && !isScopedTransferStatusTransitionAllowed(fromStatus, newStatus, db, scope)) {
    return {
      success: false,
      message: `Invalid status transition: ${fromStatus} -> ${newStatus}`,
    };
  }

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
  if (maintenanceComplete) {
    patch.patient_ic_tag_id = null;
  }
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

  if (newStatus === 'NEARLY_DONE') {
    const ndMin = getSystemSettingInt(db, 'nearly_done_minutes', 10);
    patch.estimated_pickup_at = now + (ndMin > 0 ? ndMin : 10) * 60 * 1000;
  }

  list[index] = { ...current, ...patch };
  db.transfer_status_logs = db.transfer_status_logs || [];
  db.transfer_status_logs.push({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    transfer_event_id: eventId,
    from_status: fromStatus,
    to_status: newStatus,
    changed_by: 'UI操作',
    changed_at: now,
    note: '',
  });
  if (db.transfer_status_logs.length > 1000) {
    db.transfer_status_logs.splice(0, db.transfer_status_logs.length - 1000);
  }
  appendAuditLog(db, 'STATUS_CHANGE', {
    targetType: 'transfer_events',
    targetId: eventId,
    actorType: isExternal ? 'child_api' : 'local_ui',
    result: 'success',
    before: summarizeAuditRecord('transfer_events', current),
    after: summarizeAuditRecord('transfer_events', list[index]),
    details: { fromStatus, toStatus: newStatus, scope, maintenance: maintenanceComplete },
  });

  if (!writeDB(db)) {
    throw new Error('データベースの保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
  }

  const speechMsg = createStatusSpeechMessage(db, list[index], newStatus, filledArrivedAtForDirectExamStart);
  if (speechMsg && speechMsg.to) {
    processWebrtcRequest('POST', 'webrtc/send', JSON.stringify(speechMsg));
  }

  console.log(`[Status] Updated: id=${eventId}, ${fromStatus} -> ${newStatus}, scope=${scope}${maintenanceComplete ? ', maintenance=true' : ''}`);
  return list[index];
}

// 共通のデータベース操作処理関数
async function processDbRequest(method, url, bodyStr, isExternal = false, apiToken = null, requestMeta = {}) {
  const db = readDB();

  // URL解析 (例: "tables/transfer_events?limit=200" や "tables/beds/bed-701")
  const cleanUrl = url.replace(/^\//, '').replace(/^tables\//, '');
  const [urlPath, queryString] = cleanUrl.split('?');
  const searchParams = new URLSearchParams(queryString || '');
  const urlParts = urlPath.split('/');
  const table = urlParts[0];
  const id = urlParts[1];

  console.log(`[DB Request] ${method} tables/${table}${id ? '/' + id : ''}`);

  // テーブル名の許可リストチェック（不正テーブル名インジェクション防止）
  if (!ALLOWED_TABLES.has(table)) {
    console.warn(`[DB] 未許可のテーブル名へのアクセス: ${table}`);
    return { success: false, message: 'Not Found' };
  }

  if (table === 'audit_logs' && method !== 'GET') {
    return { success: false, message: 'Audit logs are append-only' };
  }

  // 患者情報を含むテーブルへの外部アクセスはAPIトークンで保護する
  if (isExternal && PATIENT_DATA_TABLES.has(table)) {
    const tokenSetting = (db.system_settings || []).find(s => s.id === 'api_token');
    const expectedToken = tokenSetting?.value || '';
    if (!expectedToken || apiToken !== expectedToken) {
      console.warn(`[Security] APIトークン認証失敗: table=${table}`);
      return { success: false, message: 'Unauthorized', unauthorized: true };
    }
  }

  // 外部(HTTP)からのアクセスに対するセキュリティ制限（機密データの保護）
  if (isExternal && table === 'system_settings') {
    // admin_passcode は子機の設定画面パスコード認証のため単体GETのみ許可する
    // ODBC接続文字列・SMBパスワード・APIトークンは単体GETも禁止（APIトークンは親機画面から手動で子機に設定する運用）
    const blockedSingleGet = ['odbc_connection_string', 'smb_password', 'api_token'];
    const blockedAll = ['odbc_connection_string', 'smb_password', 'admin_passcode', 'api_token'];
    // 稼働モード・親機IPは各端末ローカルの設定。外部（子機）からの書き換えを許すと
    // 親機のDBの share_mode が'client'に上書きされ、再起動後に共有サーバーが
    // 起動しなくなるため、書き込みのみ遮断する（読み取りは従来どおり許可）
    const writeBlocked = [...blockedAll, 'share_mode', 'parent_ip', 'wizard_completed'];

    if (method === 'GET') {
      if (id) {
        if (blockedSingleGet.includes(id)) {
          return { success: false, message: 'Forbidden' };
        }
      } else {
        // 全件取得時は機密設定の値をマスクして返す
        const list = db[table] || [];
        const filteredList = list.map(s => {
          if (blockedAll.includes(s.id)) {
            return { ...s, value: '********' };
          }
          return s;
        });
        return { data: filteredList };
      }
    } else {
      // POST/PUT/PATCH/DELETE による機密設定・端末ローカル設定の更新・削除を禁止
      if (id && writeBlocked.includes(id)) {
        return { success: false, message: 'Forbidden' };
      }
      if (bodyStr) {
        try {
          const data = JSON.parse(bodyStr);
          if (Array.isArray(data)) {
            if (data.some(x => writeBlocked.includes(x.id))) {
              return { success: false, message: 'Forbidden' };
            }
          } else {
            if (writeBlocked.includes(data.id)) {
              return { success: false, message: 'Forbidden' };
            }
          }
        } catch (e) {}
      }
    }
  }

  if (!db[table]) {
    db[table] = [];
  }

  const list = db[table];

  if (method === 'GET') {
    if (table === 'transfer_events' && id === 'ward-status') {
      const wardId = searchParams.get('ward_id') || '';
      const todayMs = Number(searchParams.get('today_ms') || 0);
      const scoped = wardId ? list.filter(e => e.ward_id === wardId) : list;
      const activeEvents = scoped.filter(e => ACTIVE_TRANSFER_STATUSES.has(e.current_status));
      const todayEvents = scoped.filter(e => {
        if (ACTIVE_TRANSFER_STATUSES.has(e.current_status)) return true;
        return Number.isFinite(todayMs) && todayMs > 0 && e.departed_at != null && e.departed_at >= todayMs;
      });
      return { success: true, activeEvents, todayEvents };
    }

    if (id) {
      const item = list.find(x => String(x.id) === String(id));
      if (!item) {
        console.warn(`[DB] GET Not Found: table=${table}, id=${id}`);
        return { success: false, message: 'Not Found' };
      }
      return item;
    } else {
      return { data: list };
    }
  }

  if (method === 'POST') {
    let data;
    try { data = JSON.parse(bodyStr); } catch {
      return { success: false, message: 'リクエストボディのJSONが不正です' };
    }
    let normalizedLegacyTransfer = false;
    if (table === 'transfer_events' && data.current_status === 'DEPART_REGISTERED') {
      const now = Date.now();
      const inferred = getLegacyDepartureTimestamp(data, db.transfer_status_logs || [], now);
      data.current_status = 'MOVING';
      data.departed_at = inferred.timestamp;
      if (!data.registered_at) data.registered_at = inferred.timestamp;
      if (!data.created_at) data.created_at = inferred.timestamp;
      normalizedLegacyTransfer = true;
    }
    if (
      table === 'transfer_status_logs' &&
      !data.from_status &&
      data.to_status === 'DEPART_REGISTERED'
    ) {
      const event = (db.transfer_events || []).find(item =>
        String(item.id) === String(data.transfer_event_id) &&
        item.current_status === 'MOVING'
      );
      if (event) {
        const existingInitialLog = list.find(log =>
          String(log.transfer_event_id) === String(event.id) &&
          !log.from_status &&
          log.to_status === 'MOVING'
        );
        if (existingInitialLog) return existingInitialLog;
        data.to_status = 'MOVING';
        data.note = data.note || '旧端末の出棟登録ログを移動中へ統合';
      }
    }
    if (!data.id) {
      data.id = `${table}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    }
    const index = list.findIndex(x => String(x.id) === String(data.id));
    const beforeItem = index !== -1 ? JSON.parse(JSON.stringify(list[index])) : null;
    if (index !== -1) {
      if (
        isExternal &&
        table === 'transfer_events' &&
        Object.prototype.hasOwnProperty.call(data, 'current_status')
      ) {
        return { success: false, message: 'Use status/update for status changes' };
      }
      if (
        table === 'transfer_events' &&
        Object.prototype.hasOwnProperty.call(data, 'current_status') &&
        !isTransferStatusTransitionAllowed(list[index].current_status, data.current_status, db)
      ) {
        return {
          success: false,
          message: `Invalid status transition: ${list[index].current_status} -> ${data.current_status}`,
        };
      }
      if (table === 'transfer_events') {
        const merged = { ...list[index], ...data };
        if (shouldCheckActiveBedConflict(list[index], merged, false)) {
          const conflict = findActiveBedEventConflict(list, merged, merged.id);
          if (conflict) return activeBedConflictResponse(conflict);
        }
      }
      list[index] = { ...list[index], ...data };
      console.log(`[DB] POST (Update instead of duplicate): table=${table}, id=${data.id}`);
    } else {
      if (table === 'transfer_events' && shouldCheckActiveBedConflict(null, data, true)) {
        const conflict = findActiveBedEventConflict(list, data, data.id);
        if (conflict) return activeBedConflictResponse(conflict);
      }
      list.push(data);
      if (table === 'transfer_events' && normalizedLegacyTransfer) {
        const changedAt = data.departed_at || Date.now();
        db.transfer_status_logs = db.transfer_status_logs || [];
        db.transfer_status_logs.push({
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          transfer_event_id: data.id,
          from_status: null,
          to_status: 'MOVING',
          changed_by: 'legacy-client',
          changed_at: changedAt,
          note: '旧端末の出棟登録を移動中へ統合',
        });
        if (db.transfer_status_logs.length > 1000) {
          db.transfer_status_logs.splice(0, db.transfer_status_logs.length - 1000);
        }
      }
      console.log(`[DB] POST Created: table=${table}, id=${data.id}`);
    }

    // ディスク・メモリの管理：ログ・通話などの蓄積データテーブルの肥大化防止（自動トリム）
    if (table === 'import_logs' && list.length > 100) {
      list.splice(0, list.length - 100);
      console.log(`[DB Cleaner] Trimmed import_logs to 100 entries to prevent memory/disk bloat.`);
    }
    if (table === 'transfer_status_logs' && list.length > 1000) {
      list.splice(0, list.length - 1000);
      console.log(`[DB Cleaner] Trimmed transfer_status_logs to 1000 entries.`);
    }
    if (table === 'calls' && list.length > 500) {
      list.splice(0, list.length - 500);
      console.log(`[DB Cleaner] Trimmed calls to 500 entries.`);
    }

    appendAuditLog(db, index !== -1 ? 'DB_UPDATE' : 'DB_CREATE', {
      targetType: table,
      targetId: data.id,
      actorType: isExternal ? 'child_api' : 'local_ui',
      remoteIp: requestMeta.remoteIp || '',
      before: summarizeAuditRecord(table, beforeItem),
      after: summarizeAuditRecord(table, list.find(x => String(x.id) === String(data.id))),
      details: { method: 'POST' },
    });

    if (!writeDB(db)) {
      throw new Error('データベースの保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
    }
    if (table === 'transfer_events' && normalizedLegacyTransfer && index === -1) {
      const speechMsg = createStatusSpeechMessage(db, data, 'MOVING', false);
      if (speechMsg?.to) {
        processWebrtcRequest('POST', 'webrtc/send', JSON.stringify(speechMsg));
      }
    }
    return data;
  }

  if (method === 'PUT' || method === 'PATCH') {
    if (id === 'bulk') {
      let bulkData;
      try { bulkData = JSON.parse(bodyStr); } catch {
        return { success: false, message: 'リクエストボディのJSONが不正です' };
      }
      if (!Array.isArray(bulkData)) {
        return { success: false, message: 'Body must be an array for bulk updates' };
      }
      if (table === 'transfer_events') {
        if (isExternal && bulkData.some(patchItem => Object.prototype.hasOwnProperty.call(patchItem, 'current_status'))) {
          return { success: false, message: 'Use status/update for status changes' };
        }
        const simulated = list.map(item => ({ ...item }));
        for (const patchItem of bulkData) {
          const targetId = patchItem.id;
          const index = simulated.findIndex(x => String(x.id) === String(targetId));
          if (index === -1) continue;
          const before = simulated[index];
          if (
            Object.prototype.hasOwnProperty.call(patchItem, 'current_status') &&
            !isTransferStatusTransitionAllowed(before.current_status, patchItem.current_status, db)
          ) {
            return {
              success: false,
              message: `Invalid status transition: ${before.current_status} -> ${patchItem.current_status}`,
            };
          }
          const merged = { ...before, ...patchItem };
          if (shouldCheckActiveBedConflict(before, merged, false)) {
            const conflict = findActiveBedEventConflict(simulated, merged, merged.id);
            if (conflict) return activeBedConflictResponse(conflict);
          }
          simulated[index] = merged;
        }
      }
      const updatedItems = [];
      const beforeItems = [];
      bulkData.forEach(patchItem => {
        const targetId = patchItem.id;
        const index = list.findIndex(x => String(x.id) === String(targetId));
        if (index !== -1) {
          beforeItems.push(JSON.parse(JSON.stringify(list[index])));
          list[index] = { ...list[index], ...patchItem };
          updatedItems.push(list[index]);
        }
      });
      appendAuditLog(db, 'DB_BULK_UPDATE', {
        targetType: table,
        targetId: 'bulk',
        actorType: isExternal ? 'child_api' : 'local_ui',
        remoteIp: requestMeta.remoteIp || '',
        before: beforeItems.map(item => summarizeAuditRecord(table, item)),
        after: updatedItems.map(item => summarizeAuditRecord(table, item)),
        details: { method, count: updatedItems.length },
      });
      if (!writeDB(db)) {
        throw new Error('データベースの保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
      }
      console.log(`[DB] Bulk ${method} Updated: table=${table}, items=${updatedItems.length}`);
      return { success: true, count: updatedItems.length, data: updatedItems };
    }

    let data;
    try { data = JSON.parse(bodyStr); } catch {
      return { success: false, message: 'リクエストボディのJSONが不正です' };
    }
    const index = list.findIndex(x => String(x.id) === String(id));
    if (index === -1) {
      console.warn(`[DB] PATCH Not Found: table=${table}, id=${id}`);
      return { success: false, message: 'Not Found' };
    }
    if (
      isExternal &&
      table === 'transfer_events' &&
      Object.prototype.hasOwnProperty.call(data, 'current_status')
    ) {
      return { success: false, message: 'Use status/update for status changes' };
    }
    let expectedStatus = null;
    if (table === 'transfer_events' && Object.prototype.hasOwnProperty.call(data, 'expectedStatus')) {
      expectedStatus = data.expectedStatus || null;
      delete data.expectedStatus;
    }
    if (expectedStatus && list[index].current_status !== expectedStatus) {
      return statusMismatchConflictResponse(expectedStatus, list[index]);
    }
    if (
      table === 'transfer_events' &&
      Object.prototype.hasOwnProperty.call(data, 'current_status') &&
      !isTransferStatusTransitionAllowed(list[index].current_status, data.current_status, db)
    ) {
      return {
        success: false,
        message: `Invalid status transition: ${list[index].current_status} -> ${data.current_status}`,
      };
    }
    if (table === 'transfer_events') {
      const merged = { ...list[index], ...data };
      if (shouldCheckActiveBedConflict(list[index], merged, false)) {
        const conflict = findActiveBedEventConflict(list, merged, merged.id);
        if (conflict) return activeBedConflictResponse(conflict);
      }
    }
    const beforeItem = JSON.parse(JSON.stringify(list[index]));
    list[index] = { ...list[index], ...data };
    appendAuditLog(db, 'DB_UPDATE', {
      targetType: table,
      targetId: id,
      actorType: isExternal ? 'child_api' : 'local_ui',
      remoteIp: requestMeta.remoteIp || '',
      before: summarizeAuditRecord(table, beforeItem),
      after: summarizeAuditRecord(table, list[index]),
      details: { method, fields: Object.keys(data) },
    });
    if (!writeDB(db)) {
      throw new Error('データベースの保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
    }
    console.log(`[DB] PATCH Updated: table=${table}, id=${id}, updated fields:`, Object.keys(data));
    return list[index];
  }

  if (method === 'DELETE') {
    const index = list.findIndex(x => String(x.id) === String(id));
    if (index === -1) {
      console.warn(`[DB] DELETE Not Found: table=${table}, id=${id}`);
      return { success: false, message: 'Not Found' };
    }
    const removed = list.splice(index, 1)[0];
    appendAuditLog(db, 'DB_DELETE', {
      targetType: table,
      targetId: id,
      actorType: isExternal ? 'child_api' : 'local_ui',
      remoteIp: requestMeta.remoteIp || '',
      before: summarizeAuditRecord(table, removed),
      details: { method: 'DELETE' },
    });
    if (!writeDB(db)) {
      throw new Error('データベースの保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
    }
    console.log(`[DB] DELETE Success: table=${table}, id=${id}`);
    return removed;
  }

  return { success: false, message: 'Unsupported Method' };
}

// IPC通信でフロントからのREST-likeなデータベース操作を仲介する（ローカル処理のため isExternal = false）
ipcMain.handle('db-request', async (event, { url, options }) => {
  // デバイス管理エンドポイント（DBを使わず親機メモリで処理）
  if (url === 'device/list') return { success: true, devices: getActiveDevices() };
  if (url === 'device/disconnect') {
    let info;
    try { info = JSON.parse((options && options.body) || '{}'); } catch { info = {}; }
    delete connectedDevices[info.deviceId];
    return { success: true };
  }
  const method = (options.method || 'GET').toUpperCase();
  if (url === 'audit/write') {
    return processAuditWriteRequest(method, options.body || '', false);
  }
  if (url === 'status/update') {
    return processStatusUpdateRequest(method, options.body || '', false);
  }
  if (url === 'transfer/start') {
    return processTransferStartRequest(method, options.body || '', false);
  }
  const result = await processDbRequest(method, url, options.body || '', false);
  syncTerminalRoleFromLocalDbRequest(url, method, options.body || '');
  return result;
});

// IPC通信でフロントからのWebRTCシグナリング操作を仲介する
ipcMain.handle('webrtc-request', async (event, { url, options }) => {
  const method = (options.method || 'GET').toUpperCase();
  return processWebrtcRequest(method, url, options.body || '');
});

// 子機(レンダラーのfile://ページ)からの親機へのHTTPリクエストをメインプロセス経由で中継する。
// ChromiumのLocal Network Access(LNA)はレンダラーのfetch()をサブリソースとしてブロックし得るが、
// メインプロセス(Node.js)のhttpモジュールはブラウザのネットワークサービス層を経由しないためLNAの対象外。
// disable-featuresフラグだけでは環境によりLNAを完全に無効化できない実機報告があったための恒久対策。
function parentHttpRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let req;
    try {
      req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          finish({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            bodyText: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      });
    } catch (e) {
      finish({ ok: false, status: 0, error: e.message || 'REQUEST_ERROR' });
      return;
    }

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, status: 0, error: 'TIMEOUT' });
    });
    req.on('error', (e) => {
      finish({ ok: false, status: 0, error: e.message || 'NETWORK_ERROR' });
    });

    if (body) req.write(body);
    req.end();
  });
}

ipcMain.handle('parent-http-request', async (event, opts) => {
  return parentHttpRequest(opts);
});

// アプリバージョンを返す
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-hostname', () => os.hostname());

// ── 診断用デバッグログ ──
// パッケージ版（.exe）はターミナルが無くコンソール出力を確認できないため、
// 接続テスト等の失敗時にレンダラーから追記できる簡易ログファイルを用意する。
// ボタン一つでエクスプローラー/メモ帳から開けるようにし、DevTools操作を不要にする。
function getDebugLogPath() {
  return path.join(app.getPath('userData'), 'debug.log');
}

ipcMain.handle('append-debug-log', (event, line) => {
  try {
    const logPath = getDebugLogPath();
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${String(line).slice(0, 2000)}\n`;
    fs.appendFileSync(logPath, entry, 'utf-8');

    // 肥大化防止: 500行を超えたら直近500行に切り詰める
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > 500) {
      fs.writeFileSync(logPath, lines.slice(-500).join('\n'), 'utf-8');
    }
    return { success: true, path: logPath };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

ipcMain.handle('open-debug-log', () => {
  const { shell } = require('electron');
  const logPath = getDebugLogPath();
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] (ログはまだありません)\n`, 'utf-8');
  }
  shell.openPath(logPath);
  return { success: true, path: logPath };
});

// フォルダ選択ダイアログ（スケジュール取り込みの監視フォルダ選択用）
ipcMain.handle('select-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '監視フォルダを選択',
  });
  return canceled ? null : filePaths[0];
});

// CSVのヘッダ行を読み取る（スケジュール取り込みの列マッピング補助用）
ipcMain.handle('read-csv-headers', async (event, folderPath) => {
  try {
    const files = fs.readdirSync(folderPath).filter(f => f.toLowerCase().endsWith('.csv'));
    if (files.length === 0) return { ok: false, reason: 'no_csv' };
    const firstFile = path.join(folderPath, files[0]);
    const content = fs.readFileSync(firstFile, 'utf-8');
    const firstLine = content.split(/\r?\n/)[0] || '';
    // カンマ区切りとタブ区切りを自動判定
    const sep = firstLine.includes('\t') ? '\t' : ',';
    const headers = firstLine.split(sep).map(h => h.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
    return { ok: true, headers, filename: files[0] };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// 開発/本番モード判定 (インフラ #4: 環境分離)
ipcMain.handle('is-dev-mode', () => !app.isPackaged || process.env.NODE_ENV === 'development');

// OSデスクトップ通知を表示（メインプロセス経由 — Windowsで確実に動作）
ipcMain.handle('show-os-notification', (event, { title, body }) => {
  if (!ElectronNotification.isSupported()) return;
  const safeTitle = String(title || '').slice(0, 100);
  const safeBody  = String(body  || '').slice(0, 300);
  const iconPath = path.join(__dirname, 'build', 'icon.svg');
  const n = new ElectronNotification({ title: safeTitle, body: safeBody, icon: iconPath, silent: false });
  n.show();
});


// IPC通信でアプリの再起動を実行する
ipcMain.handle('relaunch-app', () => {
  app.relaunch();
  app.exit(0);
});

// ── アプリ自動更新（自前軽量アップデータ） ──
// 親機の /updates/ から electron-builder 標準の latest.yml を取得し、
// バージョン比較 → sha512検証付きダウンロード → per-userインストーラのサイレント起動を行う。
// per-userインストール（nsis.perMachine:false）のためUAC昇格は発生しない。

// latest.yml から必要フィールドのみ抽出する簡易パーサ（YAML全文法は不要）
function parseLatestYml(text) {
  const result = { version: null, path: null, sha512: null };
  for (const rawLine of String(text).split(/\r?\n/)) {
    // トップレベルのキーのみ対象（インデント行は files: 配下なので無視）
    const m = rawLine.match(/^(version|path|sha512):\s*(.+)$/);
    if (m && result[m[1]] === null) {
      result[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return result;
}

// セマンティックバージョン比較: a > b なら正、a < b なら負、同じなら0
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function httpGetText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('接続がタイムアウトしました')));
  });
}

// URLからファイルへストリーム保存しつつsha512(base64)を計算して返す
function downloadToFileWithHash(url, destPath, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const hash = crypto.createHash('sha512');
      const out = fs.createWriteStream(destPath);
      res.on('data', c => hash.update(c));
      res.pipe(out);
      out.on('finish', () => resolve(hash.digest('base64')));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('ダウンロードがタイムアウトしました')));
  });
}

function sha512OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const s = fs.createReadStream(filePath);
    s.on('data', c => hash.update(c));
    s.on('end', () => resolve(hash.digest('base64')));
    s.on('error', reject);
  });
}

function getUpdatesDir() {
  return path.join(app.getPath('userData'), 'updates');
}

// 更新フィードURLの組み立て。子機はparentIp指定、親機は自分自身(ループバック)を参照
function buildUpdateFeedBase(parentIp) {
  const host = (parentIp || '').trim() || '127.0.0.1';
  return `http://${host}:3005/updates`;
}

// 更新チェック: latest.yml を取得し現行バージョンと比較する
ipcMain.handle('check-for-update', async (event, { parentIp } = {}) => {
  try {
    const ymlText = await httpGetText(`${buildUpdateFeedBase(parentIp)}/latest.yml`);
    const info = parseLatestYml(ymlText);
    if (!info.version || !info.path || !info.sha512) {
      return { success: false, message: 'latest.ymlの形式が不正です' };
    }
    const currentVersion = app.getVersion();
    return {
      success: true,
      updateAvailable: compareVersions(info.version, currentVersion) > 0,
      latestVersion: info.version,
      currentVersion,
      fileName: info.path
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// 更新のダウンロード → sha512検証 → DB退避 → サイレントインストール起動
ipcMain.handle('download-and-install-update', async (event, { parentIp } = {}) => {
  try {
    const feedBase = buildUpdateFeedBase(parentIp);
    const ymlText = await httpGetText(`${feedBase}/latest.yml`);
    const info = parseLatestYml(ymlText);
    if (!info.version || !info.path || !info.sha512) {
      return { success: false, message: 'latest.ymlの形式が不正です' };
    }
    if (compareVersions(info.version, app.getVersion()) <= 0) {
      return { success: false, message: '配信中のバージョンは現行より新しくありません' };
    }

    const tmpDir = path.join(app.getPath('temp'), 'transboard-update');
    fs.mkdirSync(tmpDir, { recursive: true });
    const installerPath = path.join(tmpDir, path.basename(info.path));
    const actualSha512 = await downloadToFileWithHash(
      `${feedBase}/${encodeURIComponent(path.basename(info.path))}`, installerPath);

    if (actualSha512 !== info.sha512) {
      try { fs.unlinkSync(installerPath); } catch {}
      return { success: false, message: 'ダウンロードファイルの検証(sha512)に失敗しました。ファイルが破損しているか、改ざんされている可能性があります' };
    }

    // 更新起因の万一の破損に備え、既存の.bakローリングとは別にDBを退避
    try {
      if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, `${DB_FILE}.before_update`);
    } catch (e) {
      console.warn('[Updater] 更新前バックアップに失敗:', e.message);
    }

    console.log(`[Updater] v${info.version} のインストールを開始します`);
    const child = spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => app.quit(), 500);
    return { success: true, version: info.version };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// ── 親機の配信管理（取込・状況・ロールバック） ──

// updatesフォルダ内の配信状況を返す
ipcMain.handle('get-update-dist-info', () => {
  try {
    const updatesDir = getUpdatesDir();
    const ymlPath = path.join(updatesDir, 'latest.yml');
    let serving = null;
    if (fs.existsSync(ymlPath)) {
      const info = parseLatestYml(fs.readFileSync(ymlPath, 'utf8'));
      const exeExists = info.path && fs.existsSync(path.join(updatesDir, path.basename(info.path)));
      serving = { version: info.version, fileName: info.path, fileExists: exeExists };
    }
    const archiveDir = path.join(updatesDir, 'archive');
    let archived = null;
    if (fs.existsSync(path.join(archiveDir, 'latest.yml'))) {
      const info = parseLatestYml(fs.readFileSync(path.join(archiveDir, 'latest.yml'), 'utf8'));
      archived = { version: info.version };
    }
    return { success: true, serving, archived, currentVersion: app.getVersion() };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// 更新ファイルの取込: latest.yml と .exe を選択させ、sha512整合を検証してから配信位置へコピー
ipcMain.handle('import-update-files', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '更新ファイルを選択（latest.yml とインストーラ .exe の両方）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '更新ファイル (latest.yml, *.exe)', extensions: ['yml', 'exe'] }]
    });
    if (canceled || !filePaths || filePaths.length === 0) return { success: false, canceled: true };

    const ymlSrc = filePaths.find(f => f.toLowerCase().endsWith('.yml'));
    const exeSrc = filePaths.find(f => f.toLowerCase().endsWith('.exe'));
    if (!ymlSrc || !exeSrc) {
      return { success: false, message: 'latest.yml とインストーラ(.exe)の両方を選択してください' };
    }

    const info = parseLatestYml(fs.readFileSync(ymlSrc, 'utf8'));
    if (!info.version || !info.path || !info.sha512) {
      return { success: false, message: 'latest.ymlの形式が不正です（version/path/sha512が必要）' };
    }
    if (!/^\d+\.\d+\.\d+$/.test(info.version)) {
      return { success: false, message: `バージョン形式が不正です: ${info.version}` };
    }

    // 壊れた・組み合わせ違いのファイルを配信しないよう、取込時点でsha512を照合
    const actualSha512 = await sha512OfFile(exeSrc);
    if (actualSha512 !== info.sha512) {
      return { success: false, message: 'インストーラとlatest.ymlのsha512が一致しません。ダウンロードし直すか、同じリリースの組み合わせか確認してください' };
    }

    const updatesDir = getUpdatesDir();
    const archiveDir = path.join(updatesDir, 'archive');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    // 現在配信中のファイルを archive へ退避（1世代・ロールバック用）
    const currentYml = path.join(updatesDir, 'latest.yml');
    if (fs.existsSync(currentYml)) {
      for (const f of fs.readdirSync(archiveDir)) {
        try { fs.unlinkSync(path.join(archiveDir, f)); } catch {}
      }
      for (const f of fs.readdirSync(updatesDir)) {
        const p = path.join(updatesDir, f);
        if (fs.statSync(p).isFile()) fs.renameSync(p, path.join(archiveDir, f));
      }
    }

    // 子機は latest.yml の path 名で取得するため、exeはその名前で配置する
    fs.copyFileSync(exeSrc, path.join(updatesDir, path.basename(info.path)));
    fs.copyFileSync(ymlSrc, path.join(updatesDir, 'latest.yml'));

    {
      const db = readDB();
      appendAuditLog(db, 'UPDATE_DIST_IMPORT', {
        targetType: 'updates',
        targetId: info.version,
        actorType: 'local_ui',
        details: { version: info.version, fileName: path.basename(info.path) },
      });
      writeDB(db);
    }
    console.log(`[Updater] 配信ファイルを取込: v${info.version}`);
    return { success: true, version: info.version };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// ロールバック: archive内の旧配信ファイルを配信位置へ戻す
ipcMain.handle('rollback-update-dist', () => {
  try {
    const updatesDir = getUpdatesDir();
    const archiveDir = path.join(updatesDir, 'archive');
    if (!fs.existsSync(path.join(archiveDir, 'latest.yml'))) {
      return { success: false, message: 'ロールバック可能な旧バージョンがありません' };
    }
    // 現行の配信ファイルを削除し、archiveの内容を昇格
    for (const f of fs.readdirSync(updatesDir)) {
      const p = path.join(updatesDir, f);
      if (fs.statSync(p).isFile()) fs.unlinkSync(p);
    }
    for (const f of fs.readdirSync(archiveDir)) {
      fs.renameSync(path.join(archiveDir, f), path.join(updatesDir, f));
    }
    const info = parseLatestYml(fs.readFileSync(path.join(updatesDir, 'latest.yml'), 'utf8'));
    {
      const db = readDB();
      appendAuditLog(db, 'UPDATE_DIST_ROLLBACK', {
        targetType: 'updates',
        targetId: info.version,
        actorType: 'local_ui',
        details: { version: info.version },
      });
      writeDB(db);
    }
    console.log(`[Updater] 配信をロールバック: v${info.version}`);
    return { success: true, version: info.version };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

async function triggerScheduleFeedImportOnParent(feedId) {
  const db = readDB();
  const feed = (db.schedule_feeds || []).find(f => f.id === feedId);
  if (!feed) return { success: false, message: 'フィードが見つかりません' };
  if (!feed.watch_dir || !fs.existsSync(feed.watch_dir)) {
    return { success: false, message: '監視フォルダが存在しません' };
  }
  scanAndImportScheduleFolder(feed.watch_dir, feed);
  return { success: true };
}

function reloadScheduleFeedTriggersOnParent() {
  setupScheduleFeedTriggers();
  return { success: true };
}

// スケジュールフィードの手動取り込みとウォッチャー再起動
ipcMain.handle('trigger-schedule-feed-import', (event, feedId) => triggerScheduleFeedImportOnParent(feedId));

ipcMain.handle('reload-schedule-feed-triggers', () => reloadScheduleFeedTriggersOnParent());

// スタートアップ登録の取得・設定
ipcMain.handle('get-startup-setting', () => {
  const settings = app.getLoginItemSettings();
  return { openAtLogin: settings.openAtLogin };
});

ipcMain.handle('set-startup-setting', (event, { openAtLogin }) => {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(openAtLogin) });
    return { success: true, openAtLogin: Boolean(openAtLogin) };
  } catch (err) {
    console.error('[Startup] スタートアップ設定の変更に失敗しました:', err.message);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('set-nfc-watcher', (event, enabled) => {
  if (enabled) startNfcWatcher();
  else stopNfcWatcher();
});

// IPC通信でフルスクリーン表示を切り替える
ipcMain.handle('toggle-fullscreen', () => {
  if (mainWindow) {
    const isFS = mainWindow.isFullScreen();
    mainWindow.setFullScreen(!isFS);
    return !isFS;
  }
  return false;
});

// スクリーンセイバー・ディスプレイスリープを抑制する
ipcMain.handle('set-power-save', (event, prevent) => {
  if (prevent) {
    if (powerSaveBlockerId === null) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    }
  } else {
    if (powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(powerSaveBlockerId);
      powerSaveBlockerId = null;
    }
  }
  return { ok: true };
});

// ウィンドウを常に最前面に表示する
ipcMain.handle('set-always-on-top', (event, value) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(value, 'floating');
  }
  return { ok: true };
});

// IPC通信でデータベースのバックアップファイルをエクスポートする
// バックアップエクスポート用のパスワードベース暗号化（セキュリティ B-2: PC間移行時も患者データを保護）
// AES-256-GCM + scrypt鍵導出。safeStorageと異なりOS資格情報に依存しないため、他PCへの移行にも使える
const BACKUP_ENCRYPTION_MAGIC = 'TBENCV1:';

function encryptBackupContent(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([salt, iv, authTag, encrypted]);
  return BACKUP_ENCRYPTION_MAGIC + payload.toString('base64');
}

function decryptBackupContent(fileContent, password) {
  const payload = Buffer.from(fileContent.slice(BACKUP_ENCRYPTION_MAGIC.length), 'base64');
  const salt = payload.subarray(0, 16);
  const iv = payload.subarray(16, 28);
  const authTag = payload.subarray(28, 44);
  const encrypted = payload.subarray(44);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  // パスワード誤りの場合はGCM認証タグの検証に失敗し、ここで例外が投げられる
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function redactAuditLogJsonField(record, field) {
  if (!record || !record[field]) return;
  try {
    const parsed = JSON.parse(record[field]);
    record[field] = JSON.stringify(maskAuditValue('', '', parsed));
  } catch {}
}

// エクスポート用に患者情報（氏名・ID等）を除去した複製を作る（セキュリティ B-2: 匿名化エクスポート）
function redactPatientData(dbObj) {
  const clone = JSON.parse(JSON.stringify(dbObj));
  if (Array.isArray(clone.beds)) {
    clone.beds.forEach(b => {
      b.patient_name = null;
      b.patient_id = null;
      if ('patient_ic_tag_id' in b) b.patient_ic_tag_id = null;
    });
  }
  if (Array.isArray(clone.audit_logs)) {
    clone.audit_logs.forEach(a => {
      redactAuditLogJsonField(a, 'before');
      redactAuditLogJsonField(a, 'after');
      redactAuditLogJsonField(a, 'details');
    });
  }
  return clone;
}

const EXPORT_REDACTED_SETTING_IDS = [...SENSITIVE_SETTING_IDS, 'admin_passcode'];
function redactCredentials(dbObj) {
  if (Array.isArray(dbObj.system_settings)) {
    dbObj.system_settings.forEach(s => {
      if (EXPORT_REDACTED_SETTING_IDS.includes(s.id) && s.value) {
        s.value = '[REDACTED]';
      }
    });
  }
  return dbObj;
}

// IPC通信でデータベースをバックアップファイルとして保存する
// mode: 'encrypted'（パスワード保護・患者情報含む・既定）| 'redacted'（平文だが患者情報・認証情報を除去）
ipcMain.handle('backup-db', async (event, { mode = 'encrypted', password = '' } = {}) => {
  if (!mainWindow) return { success: false, message: 'Window not found' };
  if (mode === 'encrypted' && !password) {
    return { success: false, message: 'パスワードを入力してください' };
  }
  const { dialog } = require('electron');
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'データベースバックアップの保存',
    defaultPath: `ward_dashboard_backup_${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  });
  if (!filePath) return { success: false, message: 'Cancelled' };
  try {
    const dbObj = readDB();

    let outputContent;
    if (mode === 'redacted') {
      outputContent = JSON.stringify(redactCredentials(redactPatientData(dbObj)), null, 2);
    } else {
      outputContent = encryptBackupContent(JSON.stringify(dbObj), password);
    }
    fs.writeFileSync(filePath, outputContent, 'utf8');

    dbObj.system_settings = dbObj.system_settings || [];
    const backupTsSetting = dbObj.system_settings.find(s => s.id === 'last_backup_at');
    if (backupTsSetting) {
      backupTsSetting.value = String(Date.now());
    } else {
      dbObj.system_settings.push({ id: 'last_backup_at', value: String(Date.now()) });
    }
    appendAuditLog(dbObj, 'BACKUP_EXPORT', {
      targetType: 'database',
      targetId: mode,
      actorType: 'local_ui',
      details: { mode, fileName: path.basename(filePath) },
    });
    writeDB(dbObj);
    return { success: true, filePath };
  } catch (err) {
    console.error('[DB Backup Error]', err);
    return { success: false, message: err.message };
  }
});

// IPC通信でデータベースバックアップファイルから復元（リストア）する
ipcMain.handle('restore-db', async (event, { password = '' } = {}) => {
  if (!mainWindow) return { success: false, message: 'Window not found' };
  const { dialog } = require('electron');
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'データベースバックアップの復元',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (!filePaths || filePaths.length === 0) return { success: false, message: 'Cancelled' };
  const filePath = filePaths[0];
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    let plaintextJson;
    if (fileContent.startsWith(BACKUP_ENCRYPTION_MAGIC)) {
      if (!password) {
        return { success: false, message: 'パスワードが必要です', passwordRequired: true };
      }
      try {
        plaintextJson = decryptBackupContent(fileContent, password);
      } catch (e) {
        return { success: false, message: 'パスワードが正しくないか、ファイルが破損しています。' };
      }
    } else if (fileContent.startsWith(DB_ENCRYPTION_PREFIX)) {
      // 自機のsafeStorageで暗号化されたdb.jsonをそのまま指定した場合
      plaintextJson = decryptDbFileContent(fileContent);
    } else {
      plaintextJson = fileContent; // 平文JSON（従来形式・匿名化エクスポート）
    }

    const parsed = JSON.parse(plaintextJson);
    // バックアップファイルの整合性を検証（親機や別設定を壊さない工夫）
    if (!parsed.system_settings || !parsed.beds || !parsed.wards) {
      throw new Error('無効なバックアップファイルフォーマットです。');
    }
    // 復元前に現在のDBを保全する
    if (fs.existsSync(DB_FILE)) {
      try {
        fs.copyFileSync(DB_FILE, DB_FILE + '.before_restore');
        console.log('[DB] 復元前のDBをバックアップしました:', DB_FILE + '.before_restore');
      } catch (bakErr) {
        console.warn('[DB] 復元前バックアップの作成に失敗しました:', bakErr.message);
      }
    }
    // アトミックに上書きして復元する（自機のDB暗号化形式で保存）
    safeWriteFile(DB_FILE, encryptDbFileContent(plaintextJson));
    // writeDB()を経由しない直接書き込みのため、メモリキャッシュを無効化して次回読み込み時にディスクから再読込させる
    dbCache = null;
    {
      const db = readDB();
      appendAuditLog(db, 'BACKUP_RESTORE', {
        targetType: 'database',
        targetId: path.basename(filePath),
        actorType: 'local_ui',
        details: { encrypted: fileContent.startsWith(BACKUP_ENCRYPTION_MAGIC), fileName: path.basename(filePath) },
      });
      writeDB(db);
    }
    return { success: true };
  } catch (err) {
    console.error('[DB Restore Error]', err);
    return { success: false, message: err.message };
  }
});

// IPC通信で親機PC自身のローカルIPアドレス一覧を取得する
ipcMain.handle('get-local-ips', () => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ name, address: iface.address });
      }
    }
  }
  return addresses;
});

// IPC通信でデータベースの保存先設定情報を取得する
ipcMain.handle('get-database-storage-info', () => {
  const currentMode = DB_FILE.includes(COMMON_DATA_DIR) ? 'common' : 'user';
  return {
    currentMode,
    userPath: path.join(USER_DATA_DIR, 'db.json'),
    commonPath: path.join(COMMON_DATA_DIR, 'db.json'),
    currentPath: DB_FILE,
    hasCommonWritePermission: checkCommonWritePermission()
  };
});

// IPC通信で取り込み元CSVのアーカイブフォルダの状況を返す（セキュリティ C-1: 平文残留の可視化）
ipcMain.handle('get-archive-info', () => {
  try {
    const watchDir = resolveWatchDir();
    if (!watchDir) return { exists: false, count: 0 };
    const archiveDir = path.join(watchDir, 'archive');
    if (!fs.existsSync(archiveDir)) return { exists: false, count: 0 };
    const files = fs.readdirSync(archiveDir).filter(f => {
      try { return fs.statSync(path.join(archiveDir, f)).isFile(); } catch { return false; }
    });
    return { exists: true, count: files.length, path: archiveDir };
  } catch (err) {
    return { exists: false, count: 0, error: err.message };
  }
});

// IPC通信で保守画面向けの概況情報を返す
ipcMain.handle('get-db-info', () => {
  const db = readDB();
  let fileSizeBytes = 0;
  try { fileSizeBytes = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0; } catch {}
  const lastBackupSetting = db.system_settings?.find(s => s.id === 'last_backup_at');
  return {
    appVersion: app.getVersion(),
    dbPath: DB_FILE,
    fileSizeBytes,
    counts: {
      transfer_events: (db.transfer_events || []).length,
      transfer_status_logs: (db.transfer_status_logs || []).length,
      audit_logs: (db.audit_logs || []).length,
      import_logs: (db.import_logs || []).length,
      calls: (db.calls || []).length,
      beds: (db.beds || []).length,
      wards: (db.wards || []).length,
    },
    lastBackupAt: lastBackupSetting?.value ? Number(lastBackupSetting.value) : null,
  };
});

// IPC通信でトラブルシューティング用の診断情報を1ファイルに出力する
ipcMain.handle('export-diagnostics-bundle', async () => {
  if (!mainWindow) return { success: false, message: 'Window not found' };
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '診断情報の保存',
    defaultPath: `transboard_diagnostics_${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Text Files', extensions: ['txt'] }]
  });
  if (!filePath) return { success: false, message: 'Cancelled' };

  try {
    const db = readDB();
    let fileSizeBytes = 0;
    try { fileSizeBytes = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0; } catch {}

    const importLogsTail = (db.import_logs || []).slice(-30);
    const redactedForDiag = redactCredentials(redactPatientData({ import_logs: importLogsTail }));

    let debugLogTail = '(debug.logはまだありません)';
    try {
      const logPath = getDebugLogPath();
      if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        debugLogTail = lines.slice(-200).join('\n');
      }
    } catch (e) {
      debugLogTail = `(debug.logの読み込みに失敗: ${e.message})`;
    }

    const shareMode = db.system_settings?.find(s => s.id === 'share_mode')?.value || 'parent';
    const lines = [
      '=== TransBoard 診断情報バンドル ===',
      `出力日時: ${new Date().toISOString()}`,
      `アプリバージョン: ${app.getVersion()}`,
      `OS: ${os.platform()} ${os.release()} (${os.arch()})`,
      `ホスト名: ${os.hostname()}`,
      `稼働モード: ${shareMode}`,
      `DBパス: ${DB_FILE}`,
      `DBファイルサイズ: ${fileSizeBytes} bytes`,
      `テーブル件数: transfer_events=${(db.transfer_events || []).length}, transfer_status_logs=${(db.transfer_status_logs || []).length}, audit_logs=${(db.audit_logs || []).length}, import_logs=${(db.import_logs || []).length}, calls=${(db.calls || []).length}, beds=${(db.beds || []).length}, wards=${(db.wards || []).length}`,
      '',
      '=== 直近の取り込みログ（最大30件、患者情報は除去済み） ===',
      JSON.stringify(redactedForDiag.import_logs || [], null, 2),
      '',
      '=== debug.log（直近200行） ===',
      debugLogTail,
    ];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return { success: true, filePath };
  } catch (err) {
    console.error('[Diagnostics Export Error]', err);
    return { success: false, message: err.message };
  }
});

// IPC通信でDBファイル暗号化（safeStorage）の可用性を返す（セキュリティ B-3: 平文フォールバック時の警告表示用）
ipcMain.handle('get-encryption-status', () => {
  const available = !!(safeStorage && safeStorage.isEncryptionAvailable());
  let dbIsEncrypted = false;
  try {
    if (fs.existsSync(DB_FILE)) {
      const head = Buffer.alloc(DB_ENCRYPTION_PREFIX.length);
      const fd = fs.openSync(DB_FILE, 'r');
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      dbIsEncrypted = head.toString('utf8') === DB_ENCRYPTION_PREFIX;
    }
  } catch {}
  return { available, dbIsEncrypted };
});

// IPC通信でデータベースの保存先設定を変更する
ipcMain.handle('change-database-storage-mode', async (event, mode) => {
  if (mode === 'common') {
    // 書き込み権限チェック
    try {
      if (!fs.existsSync(COMMON_DATA_DIR)) {
        fs.mkdirSync(COMMON_DATA_DIR, { recursive: true });
      }
      safeWriteFile(GLOBAL_CONFIG_FILE, JSON.stringify({ mode: 'common' }, null, 2));
    } catch (err) {
      console.error('[DB] Storage mode change to common failed:', err);
      return { 
        success: false, 
        message: '共有フォルダ（ProgramData）への書き込み権限がありません。管理者として実行するか、フォルダのアクセス権限を確認してください。',
        error: err.message 
      };
    }

    // db.jsonが存在しない場合のみコピー
    const sourceDb = path.join(USER_DATA_DIR, 'db.json');
    const destDb = path.join(COMMON_DATA_DIR, 'db.json');
    try {
      if (fs.existsSync(sourceDb) && !fs.existsSync(destDb)) {
        fs.copyFileSync(sourceDb, destDb);
        console.log(`[DB] データベースファイルをコピーしました: ${sourceDb} -> ${destDb}`);
      }
    } catch (copyErr) {
      console.warn('[DB] データベースファイルのコピー失敗 (新規作成されます):', copyErr.message);
    }

    return { success: true, message: '保存先を「全ユーザー共有フォルダ」に変更しました。アプリを再起動します。' };
  } else {
    // ユーザー個別モードへ変更
    try {
      if (!fs.existsSync(COMMON_DATA_DIR)) {
        fs.mkdirSync(COMMON_DATA_DIR, { recursive: true });
      }
      safeWriteFile(GLOBAL_CONFIG_FILE, JSON.stringify({ mode: 'user' }, null, 2));
    } catch (err) {
      console.error('[DB] Storage mode change to user failed:', err);
      return { 
        success: false, 
        message: '共有フォルダ（ProgramData）の設定変更権限がありません。',
        error: err.message 
      };
    }

    // db.jsonが存在しない場合のみコピー
    const sourceDb = path.join(COMMON_DATA_DIR, 'db.json');
    const destDb = path.join(USER_DATA_DIR, 'db.json');
    try {
      if (fs.existsSync(sourceDb) && !fs.existsSync(destDb)) {
        fs.copyFileSync(sourceDb, destDb);
        console.log(`[DB] データベースファイルをコピーしました: ${sourceDb} -> ${destDb}`);
      }
    } catch (copyErr) {
      console.warn('[DB] データベースファイルのコピー失敗:', copyErr.message);
    }

    return { success: true, message: '保存先を「ユーザー専用フォルダ」に変更しました。アプリを再起動します。' };
  }
});

// 接続中デバイス管理（ハートビート方式）
const connectedDevices = Object.create(null); // { deviceId: { name, ip, mode, lastSeen, wardId } }
const DEVICE_TIMEOUT_MS = 30000; // 30秒無応答で切断扱い
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024; // 外部HTTP APIの最大リクエストボディ (5MB)
const MAX_DEVICE_ID_LENGTH = 64;
const MAX_HEARTBEAT_FIELD_LENGTH = 200;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const HEARTBEAT_TEXT_FIELDS = ['name', 'hostname', 'wardId', 'mode', 'page', 'appVersion'];

function sanitizeHeartbeatText(value) {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, MAX_HEARTBEAT_FIELD_LENGTH);
}

function sanitizeHeartbeatInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const deviceId = typeof info.deviceId === 'string' ? info.deviceId.trim() : '';
  if (!deviceId || deviceId.length >= MAX_DEVICE_ID_LENGTH) return null;
  if (!DEVICE_ID_PATTERN.test(deviceId)) return null;

  const sanitized = { deviceId };
  HEARTBEAT_TEXT_FIELDS.forEach(field => {
    const value = sanitizeHeartbeatText(info[field]);
    if (value !== undefined) sanitized[field] = value;
  });
  return sanitized;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function getActiveDevices() {
  const now = Date.now();
  return Object.values(connectedDevices).filter(d => (now - d.lastSeen) < DEVICE_TIMEOUT_MS);
}

// 接続機器レジストリの定期クリーンアップ（切断・再インストール等で使われなくなった
// deviceIdがconnectedDevicesに残り続けメモリを圧迫するのを防ぐ。表示側の
// getActiveDevicesは読み取り時にフィルタするだけで削除しないため、別途GCする）
const DEVICE_ENTRY_MAX_AGE_MS = 10 * 60 * 1000; // 10分無応答でレジストリから削除
setInterval(() => {
  const now = Date.now();
  for (const deviceId in connectedDevices) {
    if ((now - connectedDevices[deviceId].lastSeen) >= DEVICE_ENTRY_MAX_AGE_MS) {
      delete connectedDevices[deviceId];
    }
  }
}, 60000); // 60秒毎に実行

// APIトークンの生成・確保（セキュリティ: 患者データを含むテーブルへの外部アクセス保護）
// 未設定の場合のみランダムトークンを生成して保存する（既存トークンは維持）
function ensureApiToken() {
  const db = readDB();
  const setting = (db.system_settings || []).find(s => s.id === 'api_token');
  if (setting && setting.value) return setting.value;

  const token = crypto.randomBytes(32).toString('hex');
  if (setting) {
    setting.value = token;
  } else {
    db.system_settings = db.system_settings || [];
    db.system_settings.push({ id: 'api_token', value: token });
  }
  writeDB(db);
  console.log('[Security] APIトークンを生成しました（子機側の共有・ネットワーク設定に同じ値を入力してください）');
  return token;
}

function isValidApiToken(apiToken) {
  const db = readDB();
  const tokenSetting = (db.system_settings || []).find(s => s.id === 'api_token');
  const expectedToken = tokenSetting?.value || '';
  return Boolean(expectedToken && apiToken === expectedToken);
}

async function processParentActionRequest(method, action, bodyStr, apiToken, requestMeta = {}) {
  if (!isValidApiToken(apiToken)) {
    console.warn(`[Security] 親機操作APIトークン認証失敗: action=${action}`);
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }
  if (method !== 'GET' && method !== 'POST') {
    return { success: false, message: 'Method Not Allowed' };
  }

  let payload = {};
  if (bodyStr) {
    try { payload = JSON.parse(bodyStr); } catch { payload = {}; }
  }

  switch (action) {
    case 'save-import-settings': {
      const settings = payload.settings || {};
      const allowed = new Set([
        'import_directory',
        'import_mapping',
        'import_schedule',
        'import_retention_policy',
        'import_connection_type',
        'odbc_connection_string',
        'odbc_sql_query',
        'smb_auth_mode',
        'smb_username',
        'smb_password',
        'show_sync_time',
        'show_import_time',
      ]);
      const db = readDB();
      db.system_settings = db.system_settings || [];
      for (const [id, value] of Object.entries(settings)) {
        if (!allowed.has(id)) continue;
        const rec = db.system_settings.find(s => s.id === id);
        if (rec) rec.value = String(value ?? '');
        else db.system_settings.push({ id, value: String(value ?? '') });
      }
      appendAuditLog(db, 'PARENT_ACTION', {
        targetType: 'parent-actions',
        targetId: action,
        actorType: 'child_api',
        remoteIp: requestMeta.remoteIp || '',
        after: { settingIds: Object.keys(settings).filter(id => allowed.has(id)) },
        details: { action },
      });
      writeDB(db);
      updateWatchDirectoryOnParent(settings.import_directory || '');
      return { success: true };
    }
    case 'manual-import':
      return appendParentActionAudit(action, await triggerManualImportOnParent(), requestMeta);
    case 'update-watch-directory':
      return appendParentActionAudit(action, updateWatchDirectoryOnParent(payload.path || payload.newPath || ''), requestMeta);
    case 'odbc-dsns':
      return appendParentActionAudit(action, { success: true, ...getOdbcDsnsOnParent() }, requestMeta);
    case 'odbc-tables':
      return appendParentActionAudit(action, await getOdbcTablesOnParent(payload), requestMeta);
    case 'odbc-test':
      return appendParentActionAudit(action, await testOdbcConnectionOnParent(payload), requestMeta);
    case 'odbc-preview':
      return appendParentActionAudit(action, await previewOdbcQueryOnParent(payload), requestMeta);
    case 'odbc-sync':
      return appendParentActionAudit(action, await runOdbcSyncOnParent(payload), requestMeta);
    case 'schedule-feed-import':
      return appendParentActionAudit(action, await triggerScheduleFeedImportOnParent(payload.feedId), requestMeta);
    case 'reload-schedule-feed-triggers':
      return appendParentActionAudit(action, reloadScheduleFeedTriggersOnParent(), requestMeta);
    default:
      return { success: false, message: 'Unknown parent action' };
  }
}

// 親機としてのHTTP共有サーバー起動
let parentHttpServer = null;
function startParentServer() {
  if (parentHttpServer) return;
  ensureApiToken();
  
  parentHttpServer = http.createServer((req, res) => {
    // CORSヘッダーを追加し、他のPC（子機）からの接続を許可
    // 子機はfile://から読み込まれ、Origin: null としてリクエストするためオリジン限定はできない。
    // 実質的なアクセス制御は患者データを含むテーブルへのAPIトークン検証（PATIENT_DATA_TABLES）で行う
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Token');

    // Chromium の Private Network Access (PNA) 対応:
    // file:// 等の「不明なアドレス空間」からLAN内プライベートIPへの fetch は、
    // Chrome 130+ で明示許可のプリフライトが必須になった（Access-Control-Allow-Origin だけでは不可）。
    // これが無いと、子機からの通信がプリフライト段階で無言でブロックされる。
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 静的アップデートファイルの配信 (親機配信サーバー機能)
    if (req.url.startsWith('/updates/')) {
      const fileName = path.basename(req.url.split('?')[0]);
      const updatesDir = path.join(app.getPath('userData'), 'updates');
      const filePath = path.join(updatesDir, fileName);

      // updatesディレクトリが存在しない場合は作成
      if (!fs.existsSync(updatesDir)) {
        fs.mkdirSync(updatesDir, { recursive: true });
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        let contentType = 'application/octet-stream';
        if (fileName.endsWith('.yml')) contentType = 'text/yaml; charset=utf-8';
        else if (fileName.endsWith('.json')) contentType = 'application/json; charset=utf-8';

        res.writeHead(200, { 'Content-Type': contentType });
        const readStream = fs.createReadStream(filePath);
        readStream.on('error', (err) => {
          console.error('[Parent Server] ファイル配信エラー:', err.message);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ success: false, message: 'File read error' }));
        });
        readStream.pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Update File Not Found' }));
      }
      return;
    }

    // "/api/"で始まるリクエストのみ処理
    if (!req.url.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Not Found' }));
      return;
    }

    const cleanUrl = req.url.replace(/^\/api\//, '');
    
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
      sendJson(res, 413, { success: false, message: 'Request body too large' });
      return;
    }

    // リクエストボディの受信
    let body = '';
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', chunk => {
      if (bodyTooLarge) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
        bodyTooLarge = true;
        sendJson(res, 413, { success: false, message: 'Request body too large' });
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      if (bodyTooLarge) return;
      try {
        let result;
        if (cleanUrl.startsWith('webrtc/')) {
          const wdb = readDB();
          const expectedToken = (wdb.system_settings || []).find(s => s.id === 'api_token')?.value || '';
          if (expectedToken && req.headers['x-api-token'] !== expectedToken) {
            console.warn('[Security] WebRTCシグナリングのAPIトークン認証失敗');
            result = { success: false, message: 'Unauthorized', unauthorized: true };
          } else {
            result = processWebrtcRequest(req.method, cleanUrl, body);
          }
        } else if (cleanUrl === 'audit/write') {
          result = processAuditWriteRequest(req.method, body, true, req.headers['x-api-token'], {
            remoteIp: (req.socket?.remoteAddress || '').replace(/^::ffff:/, ''),
          });
        } else if (cleanUrl === 'status/update') {
          result = await processStatusUpdateRequest(req.method, body, true, req.headers['x-api-token']);
        } else if (cleanUrl === 'transfer/start') {
          result = await processTransferStartRequest(req.method, body, true, req.headers['x-api-token'], {
            remoteIp: (req.socket?.remoteAddress || '').replace(/^::ffff:/, ''),
          });
        } else if (cleanUrl.startsWith('parent-actions/')) {
          const action = cleanUrl.replace(/^parent-actions\//, '').split('?')[0];
          result = await processParentActionRequest(req.method, action, body, req.headers['x-api-token'], {
            remoteIp: (req.socket?.remoteAddress || '').replace(/^::ffff:/, ''),
          });
        } else if (cleanUrl.startsWith('device/')) {
          const action = cleanUrl.replace(/^device\//, '').split('?')[0];
          if (action === 'heartbeat' && req.method === 'POST') {
            let info;
            try { info = JSON.parse(body || '{}'); } catch { info = {}; }
            const sanitizedInfo = sanitizeHeartbeatInfo(info);
            if (sanitizedInfo) {
              const clientIp = req.socket?.remoteAddress || '';
              connectedDevices[sanitizedInfo.deviceId] = {
                ...sanitizedInfo,
                ip: clientIp.replace(/^::ffff:/, ''),
                lastSeen: Date.now()
              };
            }
            result = { success: true };
          } else if (action === 'list' && req.method === 'GET') {
            result = { success: true, devices: getActiveDevices() };
          } else if (action === 'disconnect' && req.method === 'POST') {
            let info;
            try { info = JSON.parse(body || '{}'); } catch { info = {}; }
            delete connectedDevices[info.deviceId];
            result = { success: true };
          } else {
            result = { success: false, message: 'Unknown device action' };
          }
        } else {
          // 外部からのHTTP APIリクエストのため isExternal = true
          result = await processDbRequest(req.method, cleanUrl, body, true, req.headers['x-api-token'], {
            remoteIp: (req.socket?.remoteAddress || '').replace(/^::ffff:/, ''),
          });
        }
        res.writeHead(result && result.unauthorized ? 401 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[Parent Server Error]', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
  });

  parentHttpServer.requestTimeout = 30000;
  parentHttpServer.headersTimeout = 10000;
  parentHttpServer.keepAliveTimeout = 5000;

  parentHttpServer.on('clientError', (err, socket) => {
    console.warn('[Parent Server] クライアント接続エラー:', err.message);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  parentHttpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      dialog.showMessageBox({
        type: 'warning',
        title: 'アプリが既に起動しています',
        message: 'アプリは既に起動しています。\nタスクバーまたはタスクトレイをご確認ください。',
        buttons: ['OK'],
      }).then(() => app.quit());
    } else {
      console.error('[Parent Server] サーバーエラー:', err.message);
    }
  });

  parentHttpServer.listen(3005, '0.0.0.0', () => {
    console.log('[Parent Server] 共有サーバーが起動しました: http://0.0.0.0:3005');
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

app.whenReady().then(() => {
  const shareMode = repairShareModeBeforeServerStart();
  createWindow();
  if (shareMode === 'parent') {
    createTray();
  }
  setupImportTrigger();
  setupScheduleFeedTriggers();

  // ネットワーク共有モードに基づき、必要に応じて親機サーバーを起動
  const db = readDB();
  const shareModeSetting = db.system_settings?.find(s => s.id === 'share_mode') || { value: shareMode };
  if (normalizeShareMode(shareModeSetting.value) !== 'client') {
    startParentServer();
  }

  const icSetting = db.system_settings?.find(s => s.id === 'enable_patient_ic_association');
  if (icSetting && icSetting.value === 'true') {
    startNfcWatcher();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) showMainWindow();
  });
}).catch(err => {
  console.error('[App] 起動中にエラーが発生しました:', err);
  dialog.showErrorBox('起動エラー', `アプリの起動に失敗しました。\n\n${err.message}`);
  app.quit();
});

} // end of gotTheLock else block

app.on('window-all-closed', () => {
  const shareMode = normalizeShareMode(getSettingRecord(readDB(), 'share_mode')?.value);
  if (shareMode === 'parent') return;
  if (process.platform !== 'darwin') app.quit();
});
