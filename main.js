const { app, BrowserWindow, ipcMain, powerSaveBlocker, safeStorage, dialog } = require('electron');
const path = require('path');
const { Tray, Menu } = require('electron');
const fs = require('fs');
const chokidar = require('chokidar');
const csv = require('csv-parser');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const packageMetadata = require('./package.json');
const { createWebrtcSignalingService } = require('./main-modules/webrtc-signaling');
const {
  MASKED_SECRET_VALUE,
  isFeedSmbPasswordSettingId,
  feedSmbPasswordSettingId,
  normalizeGlobalSmbMode,
  parseUncTarget,
  credentialFingerprint,
  resolveFeedSmbCredentials,
  createSmbSessionRegistry,
} = require('./main-modules/smb-credentials');

const { Readable } = require('stream');
const WINDOWS_SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL_EXE = path.join(
  WINDOWS_SYSTEM_ROOT,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);
const REG_EXE = path.join(WINDOWS_SYSTEM_ROOT, 'System32', 'reg.exe');
const EXPECTED_UPDATE_PUBLISHER = String(
  process.env.TRANSBOARD_UPDATE_PUBLISHER ||
  packageMetadata.transboard?.updatePublisherName ||
  ''
).trim();
const EXPECTED_UPDATE_PUBLISHER_THUMBPRINT = String(
  process.env.TRANSBOARD_UPDATE_PUBLISHER_THUMBPRINT ||
  packageMetadata.transboard?.updatePublisherThumbprint ||
  ''
).replace(/[^0-9a-f]/gi, '').toUpperCase();

let mainWindow;
let tray = null;
let isQuitting = false;
let currentWatcher = null;
let currentWatchDir = null;
let nfcProcess = null;
let nfcStdoutBuffer = '';
let nfcRestartTimer = null;
let nfcStopping = false;
let nfcProcessStartedAt = 0;
let nfcConsecutiveQuickExits = 0;
const NFC_QUICK_EXIT_THRESHOLD_MS = 3000;
const NFC_RESTART_BASE_DELAY_MS = 5000;
const NFC_RESTART_MAX_DELAY_MS = 60000;
let powerSaveBlockerId = null;
// CSV取り込みはrenderer側のDB更新完了後に初めて原本を整理する。
// importIdで複数ファイルを同時処理しても取り違えないようにする。
const pendingImportJobs = new Map();
const IMPORT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const TRUSTED_RENDERER_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;

function isTrustedRendererFrame(frame) {
  if (!frame || !mainWindow || mainWindow.isDestroyed()) return false;
  if (frame !== mainWindow.webContents.mainFrame) return false;
  try {
    const actual = new URL(frame.url);
    actual.hash = '';
    actual.search = '';
    return actual.href === TRUSTED_RENDERER_URL;
  } catch {
    return false;
  }
}

function handleTrusted(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedRendererFrame(event.senderFrame)) {
      console.warn(`[Security] 信頼できないIPC送信元を拒否: channel=${channel}`);
      throw new Error('IPC request was rejected');
    }
    return listener(event, ...args);
  });
}

// chokidar v4 はglob文字列の ignored を廃止したため、監視除外を関数で判定する。
// 「先頭がドットの隠しファイル・フォルダ」と「archiveフォルダ配下」を除外する
// （取り込み済みCSVはarchiveへ退避されるため、再取り込みを防ぐ）。
function isIgnoredWatchPath(p) {
  return String(p).split(/[\\/]/).some(seg => seg.startsWith('.') || seg === 'archive');
}

// バーコードモードはキーボード入力型スキャナーを前提とし、NFCカードリーダーの
// 常時監視プロセス(PowerShell)は不要なため起動しない
function isNfcWatcherEnabled(db) {
  const icEnabled = getSettingRecord(db, 'enable_patient_ic_association')?.value === 'true';
  const scanMode = getSettingRecord(db, 'patient_id_scan_mode')?.value || 'ic_card';
  return icEnabled && scanMode !== 'barcode';
}

function startNfcWatcher() {
  if (nfcProcess) return;
  nfcStopping = false;
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'nfc-reader.ps1')
    : path.join(__dirname, 'nfc-reader.ps1');
  if (!fs.existsSync(scriptPath)) return;

  nfcProcessStartedAt = Date.now();
  nfcProcess = spawn(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  // リーダー未検出時、nfc-reader.ps1は起動直後に即終了する。無条件の固定間隔
  // 再起動だと、リーダーが検出できない状態が続く限りPowerShellランタイム起動＋
  // インラインC#のJITコンパイルという重い処理を延々と繰り返しCPU負荷が高止まりする。
  // 直近の起動が短命終了だった回数に応じて再起動間隔を指数的に伸ばし、逆に
  // ある程度動作していた（＝実際にリーダーを検出しブロッキング待機に入っていた
  // 可能性が高い）場合はカウントをリセットして次回は素早く再検出できるようにする。
  const registerExitAndScheduleRestart = () => {
    const ranMs = Date.now() - nfcProcessStartedAt;
    if (ranMs < NFC_QUICK_EXIT_THRESHOLD_MS) {
      nfcConsecutiveQuickExits += 1;
    } else {
      nfcConsecutiveQuickExits = 0;
    }
    scheduleNfcRestart();
  };

  const scheduleNfcRestart = () => {
    if (nfcStopping || isQuitting || nfcRestartTimer) return;
    const enabled = isNfcWatcherEnabled(readDB());
    if (!enabled) {
      nfcConsecutiveQuickExits = 0;
      return;
    }
    const delay = Math.min(
      NFC_RESTART_MAX_DELAY_MS,
      NFC_RESTART_BASE_DELAY_MS * Math.pow(2, nfcConsecutiveQuickExits)
    );
    nfcRestartTimer = setTimeout(() => {
      nfcRestartTimer = null;
      startNfcWatcher();
    }, delay);
  };

  nfcProcess.on('error', (err) => {
    console.error('[NFC] PowerShellプロセスの起動に失敗しました:', err.message);
    nfcProcess = null;
    registerExitAndScheduleRestart();
  });

  nfcProcess.stdout.on('data', (data) => {
    nfcStdoutBuffer += data.toString();
    const lines = nfcStdoutBuffer.split(/\r?\n/);
    nfcStdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const m = line.trim().match(/^UID:([0-9A-Fa-f]+)$/);
      if (m && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('card-scanned', m[1].toUpperCase());
      }
    }
  });

  nfcProcess.on('exit', (code, signal) => {
    nfcProcess = null;
    nfcStdoutBuffer = '';
    if (!nfcStopping) {
      console.warn(`[NFC] リーダープロセスが終了しました code=${code ?? '-'} signal=${signal ?? '-'}`);
      registerExitAndScheduleRestart();
    }
  });
}

function stopNfcWatcher() {
  nfcStopping = true;
  nfcConsecutiveQuickExits = 0;
  if (nfcRestartTimer) {
    clearTimeout(nfcRestartTimer);
    nfcRestartTimer = null;
  }
  nfcStdoutBuffer = '';
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

// アトミック書き込みユーティリティ: tmpファイルに書いてからrenameする。
// 複数起動（親機＋管理端末など）で同じ保存先を使う場合も、同一ファイルへの
// 書き込みが競合してtmpファイルを上書きしないよう、短時間のロックを取得する。
function safeWriteFile(targetPath, content) {
  const lockPath = targetPath + '.lock';
  const tmpPath = targetPath + '.tmp';
  const lockTimeoutMs = 5000;
  const staleLockMs = 30000;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const startedAt = Date.now();
  let lockFd = null;
  while (lockFd === null) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(lockFd, `${process.pid}\n`, 'utf8');
    } catch (err) {
      if (err.code !== 'EEXIST') {
        if (lockFd !== null) {
          try { fs.closeSync(lockFd); } catch {}
          try { fs.unlinkSync(lockPath); } catch {}
        }
        throw err;
      }
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleLockMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
      }
      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(`ファイルロック取得がタイムアウトしました: ${targetPath}`);
      }
      Atomics.wait(waitBuffer, 0, 0, 25);
    }
  }

  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (renameErr) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw renameErr;
  } finally {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

let DB_FILE = getDBPath();
// 監査ログ(audit_logs)は db.json から分離し、専用ファイルへ1行=1件で追記する。
// db.audit_logsとしてメモリ上のdbオブジェクトには従来通り乗せ続けるため、
// GET・バックアップ出力・診断画面など既存の参照箇所は無改修で動く。
// db.jsonへは書き込まないため、毎回のwriteDB()のstringify/クローンコストから
// audit_logs分(DB全体の数割を占めうる)が外れる。
const AUDIT_LOG_FILE = path.join(path.dirname(DB_FILE), 'audit-log.jsonl');
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
  const lockPath = DB_FILE + '.lock';
  if (fs.existsSync(lockPath)) {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > 30000) {
        fs.unlinkSync(lockPath);
        console.warn('[DB] 前回の異常終了で残留したロックを削除しました:', lockPath);
      }
    } catch (err) {
      console.error('[DB] 残留ロックの確認に失敗しました:', err.message);
    }
  }
}
cleanupStaleTmpFiles();

// WebRTCシグナリングは独立サービスに分離し、キューの上限・入力検証を一箇所で管理する。
const webrtcSignaling = createWebrtcSignalingService();

// データベースの初期シードデータ（マスタデータ）
const SEEDS = {
  wards: [
    { id: "ward-1", name: "7階東病棟", phone: "7101", note: "7階東 ナースステーション", sort_order: 1 },
    { id: "ward-2", name: "7階西病棟", phone: "7201", note: "7階西 ナースステーション", sort_order: 2 }
  ],
  beds: [
    { id: "bed-701", ward_id: "ward-1", bed_number: "701", room_number: "701", sort_order: 1, map_col: 0, map_row: 0 },
    { id: "bed-702", ward_id: "ward-1", bed_number: "702", room_number: "701", sort_order: 2, map_col: 1, map_row: 0 },
    { id: "bed-703", ward_id: "ward-1", bed_number: "703", room_number: "702", sort_order: 3, map_col: 3, map_row: 0 },
    { id: "bed-704", ward_id: "ward-1", bed_number: "704", room_number: "702", sort_order: 4, map_col: 4, map_row: 0 },
    { id: "bed-705", ward_id: "ward-1", bed_number: "705", room_number: "703", sort_order: 5, map_col: 6, map_row: 0 },
    { id: "bed-706", ward_id: "ward-1", bed_number: "706", room_number: "703", sort_order: 6, map_col: 7, map_row: 0 },
    { id: "bed-707", ward_id: "ward-1", bed_number: "707", room_number: "704", sort_order: 7, map_col: 0, map_row: 2 },
    { id: "bed-708", ward_id: "ward-1", bed_number: "708", room_number: "704", sort_order: 8, map_col: 1, map_row: 2 },
    { id: "bed-709", ward_id: "ward-1", bed_number: "709", room_number: "705", sort_order: 9, map_col: 3, map_row: 2 },
    { id: "bed-710", ward_id: "ward-1", bed_number: "710", room_number: "705", sort_order: 10, map_col: 4, map_row: 2 },
    { id: "bed-711", ward_id: "ward-1", bed_number: "711", room_number: "706", sort_order: 11, map_col: 6, map_row: 2 },
    { id: "bed-712", ward_id: "ward-1", bed_number: "712", room_number: "706", sort_order: 12, map_col: 7, map_row: 2 },
    { id: "bed-713", ward_id: "ward-1", bed_number: "713", room_number: "707", sort_order: 13, map_col: 0, map_row: 4 },
    { id: "bed-714", ward_id: "ward-1", bed_number: "714", room_number: "707", sort_order: 14, map_col: 1, map_row: 4 },
    { id: "bed-715", ward_id: "ward-1", bed_number: "715", room_number: "708", sort_order: 15, map_col: 3, map_row: 4 },
    { id: "bed-716", ward_id: "ward-1", bed_number: "716", room_number: "708", sort_order: 16, map_col: 4, map_row: 4 },
    { id: "bed-717", ward_id: "ward-1", bed_number: "717", room_number: "709個室", sort_order: 17, map_col: 6, map_row: 4 },
    { id: "bed-718", ward_id: "ward-1", bed_number: "718", room_number: "709個室", sort_order: 18, map_col: 7, map_row: 4 }
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
    { id: "odbc_connection_string", value: "" },
    { id: "odbc_sql_query", value: "SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS" },
    { id: "notification_sounds", value: "{\"PICKUP_REQUIRED\":{\"enabled\":true,\"sound\":\"alarm\"},\"NEARLY_DONE\":{\"enabled\":true,\"sound\":\"chime\"},\"SOON\":{\"enabled\":true,\"sound\":\"chime\"},\"MOVING\":{\"enabled\":false,\"sound\":\"ding\"},\"ARRIVED\":{\"enabled\":false,\"sound\":\"ding\"},\"IN_EXAM\":{\"enabled\":false,\"sound\":\"ding\"},\"RETURNED\":{\"enabled\":false,\"sound\":\"ding\"}}" },
    { id: "incoming_ring_sound", value: "ring" },
    { id: "share_mode", value: "parent" },
    { id: "parent_ip", value: "" },
    { id: "api_token", value: "" },
    { id: "enable_webrtc_call", value: "true" },
    { id: "enable_patient_ic_association", value: "false" },
    { id: "patient_id_scan_mode", value: "ic_card" },
    { id: "enable_auto_set_patient_id", value: "false" },
    { id: "auto_set_patient_id_default_checked", value: "false" },
    { id: "default_zoom", value: "1.0" },
    { id: "font_style", value: "ud" },
    { id: "bed_card_size", value: "medium" },
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
    { id: "notification_auto_speech", value: "true" },
    { id: "notification_mute", value: "{\"enabled\":false,\"start\":\"22:00\",\"end\":\"06:00\"}" },
    { id: "notification_import_toast", value: "true" },
    { id: "status_custom_labels", value: "{}" },
    { id: "nearly_done_minutes", value: "10" },
    { id: "soon_threshold_min", value: "15" },
    { id: "status_colors", value: "{}" },
    { id: "action_button_labels", value: "{}" },
    { id: "hidden_statuses", value: "[]" },
    { id: "event_retention_days", value: "0" },
    { id: "bed_occupancy_retention_days", value: "7" }
  ],
  transfer_events: [],
  transfer_status_logs: [],
  audit_logs: [],
  calls: [],
  import_logs: [],
  schedule_feeds: [],
  schedule_items: [],
  handover_notes: [],
  bed_occupancy_log: []
};

// センシティブな設定情報の暗号化リストと暗号・復号ヘルパー
const SENSITIVE_SETTING_IDS = ['odbc_connection_string', 'smb_password', 'api_token'];
const AUDIT_SECRET_SETTING_IDS = new Set(['admin_passcode', 'api_token', 'smb_password', 'odbc_connection_string']);
// スケジュールフィード個別のSMBパスワード(smb_password__<feedId>)は動的なIDのため
// 完全一致のリストでは拾えない。暗号化・子機マスク・監査マスク・エクスポート除外の
// 4機構すべてを以下の述語経由にし、フィード用IDも同じ保護を受けるようにする。
function isSensitiveSettingId(id) {
  return SENSITIVE_SETTING_IDS.includes(id) || isFeedSmbPasswordSettingId(id);
}
function isAuditSecretSettingId(id) {
  return AUDIT_SECRET_SETTING_IDS.has(String(id || '')) || isFeedSmbPasswordSettingId(id);
}
const AUDIT_PATIENT_FIELD_IDS = new Set(['patient_name', 'patient_id', 'patient_ic_tag_id', 'patient_note']);
const AUDIT_LOG_MAX_ENTRIES = 20000;
// 監査ログ専用ファイルの間引き(rewriteAuditLogFile、O(n))は追記のたびではなく、
// この閾値を超えたときだけ実行する。MAX_ENTRIESぴったりで間引くと、上限到達後は
// 追記のたびに全件書き直しが走ってしまうため、猶予を持たせて頻度を抑える
const AUDIT_LOG_COMPACT_THRESHOLD = AUDIT_LOG_MAX_ENTRIES + 4000;
// 在室ログの保持は bed_occupancy_retention_days（既定7日）が主軸。この件数上限は
// 通常運用では作動しない安全弁で、最長90日設定でも現実的な回転率に対し十分な余裕がある。
const BED_OCCUPANCY_LOG_MAX_ENTRIES = 20000;
const BED_OCCUPANCY_RETENTION_DAYS_DEFAULT = 7;
// 申し送りは未確認の情報を優先して保持し、確認済みの古いメモだけを安全弁として整理する。
// 上限を超えても未確認メモは削除しないため、業務上の確認漏れを防ぐ。
const HANDOVER_NOTE_MAX_ENTRIES = 1000;

// 上限件数を超えたテーブルを古い順に間引く共通ヘルパー。単純な「新しいN件だけ残す」
// テーブル(audit_logs/import_logs/calls等)で共有する。
// 未確認メモの保護(pruneHandoverNotes)・進行中イベントのログ保護
// (pruneTransferStatusLogs)・保持期間+安全弁の複合ロジック(pruneBedOccupancyLog)
// など、間引く対象の選び方に業務ルールがあるものは対象外
function trimTable(list, max, label) {
  if (!Array.isArray(list) || list.length <= max) return false;
  list.splice(0, list.length - max);
  if (label) console.log(`[DB Cleaner] Trimmed ${label} to ${max} entries.`);
  return true;
}

// ステータス変更ログは移送1件ごとに複数件追記される高頻度テーブルのため、上限を超えたら
// 古い順に間引く。外部からのtransfer_status_logsへの直接書き込みは禁止されている
// （main.js内の processTransferStartRequest / processStatusUpdateRequest /
// processStatusNoteRequest / 旧端末互換のPOST正規化からのみ追記される）ため、
// 各追記箇所の直後でこの関数を呼ぶ必要がある。
// transfer_events の保持は event_retention_days（既定0=無効）が主軸。この件数上限は
// 通常運用では作動しない安全弁で、他の蓄積テーブルと同様にトリムする
const TRANSFER_EVENTS_MAX_ENTRIES = 50000;
// ward-status/exam-room-status表示は進行中イベントの直近ログを参照するため、
// 監査証跡としての保持期間を確保しつつ他の蓄積テーブル(audit_logs等)と揃える。
// 通常運用では作動しない安全弁で、複数病棟の同時稼働でも十分な余裕がある。
const TRANSFER_STATUS_LOG_MAX_ENTRIES = 20000;

// 進行中の移送に属するログは業務表示（ward-status/exam-room-status）が参照するため
// 削除対象から除外し、完了済みイベントのログだけを古い順に間引く安全弁。
function pruneTransferStatusLogs(db) {
  const logs = Array.isArray(db.transfer_status_logs) ? db.transfer_status_logs : [];
  if (logs.length <= TRANSFER_STATUS_LOG_MAX_ENTRIES) return 0;

  const activeEventIds = new Set(
    (Array.isArray(db.transfer_events) ? db.transfer_events : [])
      .filter(event => event && ACTIVE_TRANSFER_STATUSES.has(event.current_status))
      .map(event => String(event.id))
  );
  const removeCount = logs.length - TRANSFER_STATUS_LOG_MAX_ENTRIES;
  const removableIds = new Set(
    logs
      .filter(log => !activeEventIds.has(String(log.transfer_event_id)))
      .slice(0, removeCount)
      .map(log => log.id)
  );
  if (removableIds.size === 0) return 0;
  db.transfer_status_logs = logs.filter(log => !removableIds.has(log.id));
  console.log(`[DB Cleaner] Trimmed transfer_status_logs to ${db.transfer_status_logs.length} entries.`);
  return removableIds.size;
}

function pruneHandoverNotes(db) {
  const notes = Array.isArray(db.handover_notes) ? db.handover_notes : [];
  if (notes.length <= HANDOVER_NOTE_MAX_ENTRIES) return 0;

  const removeCount = notes.length - HANDOVER_NOTE_MAX_ENTRIES;
  const resolved = notes
    .filter(note => note && (note.is_resolved === true || note.is_resolved === 1 || note.is_resolved === '1'))
    .sort((a, b) => {
      const aTime = Number(a.updated_at || a.resolved_at || a.created_at || 0);
      const bTime = Number(b.updated_at || b.resolved_at || b.created_at || 0);
      return aTime - bTime;
    });
  const removableIds = new Set(resolved.slice(0, removeCount).map(note => String(note.id)));
  if (removableIds.size === 0) return 0;
  db.handover_notes = notes.filter(note => !removableIds.has(String(note.id)));
  return removableIds.size;
}

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

function getTerminalSecretsPath() {
  return path.join(app.getPath('userData'), 'terminal-secrets.json');
}

function getTerminalApiToken() {
  const secretsPath = getTerminalSecretsPath();
  if (!fs.existsSync(secretsPath)) return { success: true, token: '', secure: true };
  try {
    const stored = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    const encryptedToken = String(stored.encryptedApiToken || '');
    if (!encryptedToken) return { success: true, token: '', secure: true };
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      return { success: false, token: '', secure: false, message: 'OSの資格情報保護機能を利用できません' };
    }
    const token = safeStorage.decryptString(Buffer.from(encryptedToken, 'base64'));
    return { success: true, token, secure: true };
  } catch (error) {
    console.warn('[Security] 端末APIトークンの読み込みに失敗:', error.message);
    return { success: false, token: '', secure: false, message: '端末APIトークンを読み込めませんでした' };
  }
}

function setTerminalApiToken(rawToken) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (token.length > 256) {
    return { success: false, secure: false, message: 'APIトークンが長すぎます' };
  }
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    return { success: false, secure: false, message: 'OSの資格情報保護機能を利用できません' };
  }
  try {
    const encryptedApiToken = token
      ? safeStorage.encryptString(token).toString('base64')
      : '';
    safeWriteFile(
      getTerminalSecretsPath(),
      JSON.stringify({ version: 1, encryptedApiToken }, null, 2)
    );
    return { success: true, secure: true };
  } catch (error) {
    console.warn('[Security] 端末APIトークンの保存に失敗:', error.message);
    return { success: false, secure: false, message: '端末APIトークンを安全に保存できませんでした' };
  }
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

// 監査ログ専用ファイル(AUDIT_LOG_FILE)を1行ずつ読み込む。1行=暗号化された
// JSON1件で、既存のdb.json暗号化(encryptDbFileContent/decryptDbFileContent)と
// 同じ方式を1件単位に適用する。行単位で壊れていても他の行は読み続ける
function loadAuditLogFile() {
  try {
    if (!fs.existsSync(AUDIT_LOG_FILE)) return [];
    const raw = fs.readFileSync(AUDIT_LOG_FILE, 'utf8');
    const entries = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(decryptDbFileContent(line)));
      } catch (err) {
        console.warn('[AuditLog] 1行の読み込みに失敗したためスキップします:', err.message);
      }
    }
    return entries;
  } catch (err) {
    console.error('[AuditLog] ファイルの読み込みに失敗:', err.message);
    return [];
  }
}

// 監査ログ1件をO(1)で追記する。呼び出し元のdb.audit_logs配列への
// push直後に呼ぶことで、db.json側の書き込み頻度に関わらず即座に永続化する
function appendAuditLogFile(entry) {
  try {
    fs.appendFileSync(AUDIT_LOG_FILE, encryptDbFileContent(JSON.stringify(entry)) + '\n', 'utf8');
  } catch (err) {
    console.warn('[AuditLog] ファイルへの追記に失敗しました:', err.message);
  }
}

// 監査ログ専用ファイルをentriesの内容で丸ごと置き換える(O(n))。
// 上限超過時の間引き・DBリストア時の反映・旧形式からの一度きりの移行で使う
function rewriteAuditLogFile(entries) {
  try {
    const list = Array.isArray(entries) ? entries : [];
    const content = list.map(e => encryptDbFileContent(JSON.stringify(e))).join('\n') + (list.length ? '\n' : '');
    safeWriteFile(AUDIT_LOG_FILE, content);
  } catch (err) {
    console.warn('[AuditLog] ファイルの再構築に失敗しました:', err.message);
  }
}

// 2つの監査ログ列をid基準の和集合でマージし、created_at昇順で返す。
// 同じ共有DBフォルダを複数プロセスが指す運用で、あるプロセスのメモリ上の
// スナップショットには無いが、別プロセスが既にファイルへ追記済みのエントリを
// 圧縮(rewriteAuditLogFile)で消してしまわないようにするために使う
function mergeAuditLogEntries(a, b) {
  const byId = new Map();
  for (const entry of Array.isArray(a) ? a : []) {
    if (entry && entry.id != null) byId.set(String(entry.id), entry);
  }
  for (const entry of Array.isArray(b) ? b : []) {
    if (entry && entry.id != null && !byId.has(String(entry.id))) byId.set(String(entry.id), entry);
  }
  return Array.from(byId.values()).sort((x, y) => Number(x.created_at || 0) - Number(y.created_at || 0));
}

// db.jsonに埋め込まれた旧形式のaudit_logsを検出したら、専用ファイルが
// まだ無い場合に限り一度だけ移行する。専用ファイルが既に存在する場合は
// そちらを正として使う(db.json側の内容は無視する)
function loadOrMigrateAuditLogs(embeddedAuditLogs) {
  if (!fs.existsSync(AUDIT_LOG_FILE) && Array.isArray(embeddedAuditLogs) && embeddedAuditLogs.length > 0) {
    console.log(`[AuditLog] db.json内の${embeddedAuditLogs.length}件を専用ファイルへ移行します`);
    rewriteAuditLogFile(embeddedAuditLogs);
  }
  return loadAuditLogFile();
}

// ローカルデータベースのメモリキャッシュ（毎リクエストごとのディスク読み込み・JSON.parseを回避）。
// 親機・子機や複数端末が同じ共有DBを使う場合は別プロセスから更新されるため、
// ファイルサイズと更新時刻を署名として確認し、外部更新時にはキャッシュを破棄する。
let dbCache = null;
let dbCacheSignature = null;

function getDbFileSignature() {
  try {
    const stat = fs.statSync(DB_FILE);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}
// ユーザーがフォルダ選択ダイアログで明示的に選択したCSVフォルダ。
// read-csv-headersはこの一覧または保存済みフィードのフォルダだけを読めるようにする。
const approvedCsvHeaderFolders = new Set();

function normalizeLocalFolderPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.resolve(raw).replace(/[\\/]+$/, '').toLowerCase();
}

function isApprovedCsvHeaderFolder(folderPath) {
  const requested = normalizeLocalFolderPath(folderPath);
  if (!requested) return false;
  if (approvedCsvHeaderFolders.has(requested)) return true;
  const db = readDB();
  const configured = [
    getSettingRecord(db, 'import_directory')?.value,
    ...(db.schedule_feeds || []).map(feed => feed.watch_dir),
  ].map(normalizeLocalFolderPath).filter(Boolean);
  return configured.includes(requested);
}

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

  const systemSettings = db.system_settings || (db.system_settings = []);
  const notificationSetting = systemSettings.find(s => s.id === 'notification_sounds');
  if (notificationSetting?.value) {
    try {
      const settings = JSON.parse(notificationSetting.value);
      let notificationSettingsChanged = false;
      if (
        settings &&
        typeof settings === 'object' &&
        settings.DEPART_REGISTERED &&
        !Object.prototype.hasOwnProperty.call(settings, 'MOVING')
      ) {
        settings.MOVING = { ...settings.DEPART_REGISTERED };
        notificationSettingsChanged = true;
      }
      if (
        settings &&
        typeof settings === 'object' &&
        !Object.prototype.hasOwnProperty.call(settings, 'IN_EXAM')
      ) {
        settings.IN_EXAM = { enabled: false, sound: 'ding', toast: true };
        notificationSettingsChanged = true;
      }
      if (notificationSettingsChanged) {
        notificationSetting.value = JSON.stringify(settings);
        changed = true;
      }
    } catch {}
  }

  if (!systemSettings.some(s => s.id === 'notification_auto_speech')) {
    systemSettings.push({ id: 'notification_auto_speech', value: 'true' });
    changed = true;
  }

  // 旧バージョンのDBには履歴保持期間が存在しない。設定画面はPATCHで保存するため、
  // 読み込み時に不足レコードを追加して「Not Found」で保存できない状態を修復する。
  const retentionSettingDefaults = {
    event_retention_days: '0',
    bed_occupancy_retention_days: '7',
  };
  Object.entries(retentionSettingDefaults).forEach(([id, value]) => {
    if (!systemSettings.some(setting => setting.id === id)) {
      systemSettings.push({ id, value });
      changed = true;
    }
  });

  if (migratedEventIds.length > 0) {
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

// ローカルデータベース読み込み（重複防止の自動クリーンアップ機能付き）。
// dbCacheそのもの、またはキャッシュと共有していない新規オブジェクトを返すため、
// 呼び出し元は返り値をミューテーションしてはならない（読み取り専用アクセサ）。
// 書き込みを行う場合は必ず readDB() を使うこと。
function readDbShared() {
  const currentSignature = getDbFileSignature();
  if (dbCache && dbCacheSignature === currentSignature) {
    return dbCache;
  }
  if (dbCache && dbCacheSignature !== currentSignature) {
    console.info('[DB] 外部プロセスによる更新を検知したため、キャッシュを再読み込みします。');
    dbCache = null;
    dbCacheSignature = null;
  }
  try {
    if (!fs.existsSync(DB_FILE)) {
      console.log(`[DB] データベースが存在しないため初期データを書き込みます: ${DB_FILE}`);
      safeWriteFile(DB_FILE, encryptDbFileContent(JSON.stringify(SEEDS, null, 2)));
      dbCache = JSON.parse(JSON.stringify(SEEDS));
      dbCacheSignature = getDbFileSignature();
      return JSON.parse(JSON.stringify(SEEDS));
    }
    const rawFileContent = fs.readFileSync(DB_FILE, 'utf8');
    const wasEncrypted = rawFileContent.startsWith(DB_ENCRYPTION_PREFIX);
    const data = decryptDbFileContent(rawFileContent);
    const db = JSON.parse(data);

    let hasDuplicates = false;
    // 病床タイプ機能を廃止した際の一回限りのデータ移行。
    if (!db._migrations || !db._migrations.bed_type_removed_v1) {
      if (Array.isArray(db.beds)) {
        db.beds.forEach(bed => { if (bed && typeof bed === 'object') delete bed.bed_type; });
      }
      delete db.bed_types;
      db._migrations = { ...(db._migrations || {}), bed_type_removed_v1: Date.now() };
      hasDuplicates = true;
    }
    // 旧形式（平文）のDBを検出した場合、暗号化が使える環境なら次回書き込み時に暗号化形式へ移行する
    let needsEncryptionRewrite = !wasEncrypted && safeStorage && safeStorage.isEncryptionAvailable();

    // 後方互換性：新規テーブル・新規設定項目のパッチ
    if (!db.import_logs) {
      db.import_logs = [];
      hasDuplicates = true;
    }
    // audit_logsは専用ファイル(AUDIT_LOG_FILE)側を正として読み込む。
    // db.json不在は正常な状態(分離後は書き込まれない)なので、書き直し要求(hasDuplicates)は立てない
    db.audit_logs = loadOrMigrateAuditLogs(db.audit_logs);
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
    if (!db.bed_occupancy_log) {
      db.bed_occupancy_log = [];
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
        if (isSensitiveSettingId(s.id)) {
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

    // 既存DBへマスター更新時刻を後付けし、古い端末からの無条件上書きを検知できるようにする。
    let revisionSeed = Date.now();
    for (const table of MASTER_REVISION_TABLES) {
      if (!Array.isArray(db[table])) continue;
      for (const item of db[table]) {
        if (item && item.id && !Number.isFinite(Number(item.updated_at))) {
          item.updated_at = revisionSeed++;
          hasDuplicates = true;
        }
      }
    }
    
    if (hasDuplicates || needsEncryptionRewrite) {
      console.log('[DB] データ補正または暗号化適用のための再書き込みを実施します。');
      writeDB(db);
    }

    dbCache = structuredClone(db);
    dbCacheSignature = getDbFileSignature();
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
        // .bakが分離前の旧形式(audit_logs埋め込み)だった場合に備え、
        // 通常の読み込みパスと同じ移行処理を通す
        recovered.audit_logs = loadOrMigrateAuditLogs(recovered.audit_logs);
        console.warn('[DB] バックアップファイルからデータを復旧しました:', bakPath);
        if (!writeDB(recovered)) {
          throw new Error('バックアップデータの復旧保存に失敗しました');
        }
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

    console.error('[DB] データを復旧できませんでした。破損したDBを初期データで上書きせず、起動を停止します。');
    dbCache = null;
    dbCacheSignature = null;
    throw new Error('データベースを読み込めませんでした。*.corrupt と *.bak を保全したため、管理者が復旧状態を確認してください。', { cause: err });
  }
}

// readDbShared()のディープコピーを返す、書き込み用の読み込みアクセサ。
// 返り値は呼び出し元が自由にミューテーションしてよい（dbCacheと共有しない）。
function readDB() {
  return structuredClone(readDbShared());
}

// ローカルデータベース書き込み
// 成功時は true、失敗時は false を返す（呼び出し元がハンドリング可能）
function writeDB(data) {
  try {
    // 読み込み後に別プロセスが更新していた場合、古いスナップショットで
    // 上書きしてしまわないよう保存を拒否する。呼び出し側はfalseを受けて
    // 再読み込み・再試行できる。
    if (dbCache && dbCacheSignature) {
      const currentSignature = getDbFileSignature();
      if (currentSignature !== dbCacheSignature) {
        console.warn('[DB] 保存前に外部更新を検知したため、古いデータの上書きを中止しました。');
        dbCache = null;
        dbCacheSignature = null;
        return false;
      }
    }
    // ディスク書き込み用オブジェクトを組み立てる。dataやsystem_settingsの
    // 各要素を直接ミューテーションせず、system_settingsの機微な要素だけ
    // 新規オブジェクト化するため、DB全体のディープコピーは不要
    // （読み取り専用のJSON.stringifyに渡すだけの使い捨てローカル変数）。
    // audit_logsはこの関数の下部でAUDIT_LOG_FILEへ個別に永続化するため、
    // db.json側には含めない(肥大化するとDB全体の数割を占め、毎回のstringify/暗号化
    // コストを不必要に増やすため)。_pendingAuditLogEntriesも同様に除外する
    // （appendAuditLog()が積んだ、まだファイル未反映の監査エントリの一時リスト）。
    const { audit_logs, _pendingAuditLogEntries, ...dbWithoutAuditLogs } = data;
    const dbForDisk = (dbWithoutAuditLogs.system_settings && Array.isArray(dbWithoutAuditLogs.system_settings))
      ? {
          ...dbWithoutAuditLogs,
          system_settings: dbWithoutAuditLogs.system_settings.map(s => (
            isSensitiveSettingId(s.id)
              ? { ...s, value: encryptSensitiveValue(s.value) }
              : s
          )),
        }
      : dbWithoutAuditLogs;

    // 保存先は基本的にsafeStorageで暗号化されるため整形(pretty-print)に
    // 可読性上の意味はなく、書き込みのたびに発生するコストなので省略する。
    safeWriteFile(DB_FILE, encryptDbFileContent(JSON.stringify(dbForDisk)));

    // 監査ログの永続化は、対応するDB書き込みが実際に成功した後にだけ行う。
    // ここより前(safeWriteFile失敗時や、この関数の先頭にある署名不一致による
    // 早期return false)でappendAuditLog()の分だけが先に永続化されてしまうと、
    // 「成功した」と主張する監査エントリだけが残り、実際の変更は
    // 書き込まれていないという矛盾した監査証跡になってしまうため
    const pendingAuditEntries = Array.isArray(_pendingAuditLogEntries) ? _pendingAuditLogEntries : [];
    for (const entry of pendingAuditEntries) {
      appendAuditLogFile(entry);
    }
    if (pendingAuditEntries.length > 0 && Array.isArray(audit_logs) && audit_logs.length > AUDIT_LOG_COMPACT_THRESHOLD) {
      // 圧縮前にディスクの最新内容を読み直してマージする。共有DBフォルダ運用で
      // 他プロセスが追記済みのエントリを、このプロセスの古いメモリ状態で
      // 上書き消去してしまわないようにするため(このプロセスのメモリだけを
      // 正として丸ごと書き換えると、他プロセスの追記分がサイレントに失われる)
      const merged = mergeAuditLogEntries(audit_logs, loadAuditLogFile());
      data.audit_logs = merged.slice(Math.max(0, merged.length - AUDIT_LOG_MAX_ENTRIES));
      rewriteAuditLogFile(data.audit_logs);
    }

    // 書き込み成功後にローリングバックアップを更新する
    // （破損時のリカバリ用。直前の正常状態を1世代保持）
    scheduleDbBackup();

    // メモリキャッシュを最新の状態（復号化された形）に更新する。
    // audit_logsはdb.json側に含めないためディープコピー対象から外し、
    // 配列だけ複製(浅いコピー)して引き継ぐ。要素(監査ログ1件ずつ)は
    // 生成後にミューテーションされない(appendAuditLog()が新規pushするのみ)ため、
    // 参照共有で問題ない
    dbCache = structuredClone(dbWithoutAuditLogs);
    dbCache.audit_logs = Array.isArray(data.audit_logs) ? data.audit_logs.slice() : [];
    dbCacheSignature = getDbFileSignature();

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

function normalizeTerminalRole(value) {
  return value === 'exam' ? 'exam' : 'ward';
}

// 端末が子機かどうか（渡されたdbのshare_modeで判定する）。
// CSV/スケジュールの取り込みなど「親機だけが行うべき処理」のガードに使う。
function isClientTerminal(db) {
  return normalizeShareMode(getSettingRecord(db, 'share_mode')?.value) === 'client';
}

function maskAuditValue(table, id, value) {
  if (table === 'system_settings' && isAuditSecretSettingId(id)) {
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
    const entry = {
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
    };
    db.audit_logs.push(entry);
    // 専用ファイル(AUDIT_LOG_FILE)への実際の永続化はここでは行わず、
    // writeDB()が対応するdb.json書き込みに成功した後にまとめて行う
    // （このappendAuditLog単体では、呼び出し元のwriteDB(db)が失敗しても
    // 「成功した」と主張する監査エントリだけが残ってしまうため）。
    // ここではwriteDB()に渡すための一時的な保留リストに積むだけ。
    db._pendingAuditLogEntries = Array.isArray(db._pendingAuditLogEntries) ? db._pendingAuditLogEntries : [];
    db._pendingAuditLogEntries.push(entry);
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

function readTerminalRole() {
  try {
    if (!fs.existsSync(TERMINAL_ROLE_FILE)) return null;
    const role = JSON.parse(fs.readFileSync(TERMINAL_ROLE_FILE, 'utf8'));
    if (!role || typeof role !== 'object') return null;
    return {
      shareMode: normalizeShareMode(role.shareMode || role.share_mode),
      parentIp: String(role.parentIp || role.parent_ip || ''),
      terminalRole: normalizeTerminalRole(role.terminalRole || role.terminal_role),
      updatedAt: Number(role.updatedAt || 0) || 0,
    };
  } catch (err) {
    console.warn('[Role] 端末役割ファイルの読み込みに失敗:', err.message);
    return null;
  }
}

function writeTerminalRole({ shareMode, parentIp = '', terminalRole } = {}) {
  try {
    const existing = readTerminalRole();
    const role = {
      shareMode: normalizeShareMode(shareMode),
      parentIp: String(parentIp || ''),
      terminalRole: normalizeTerminalRole(terminalRole || existing?.terminalRole),
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

// このプロセスが張ったSMBセッションの記録。無用な張り直し（稼働中のchokidarが
// 掴んでいる共有を切ると、監視は生きたままイベントが二度と来ない無言故障になる）と、
// 同一サーバーへの資格情報競合（Windowsのシステムエラー1219）を避けるために使う。
const smbSessionRegistry = createSmbSessionRegistry();
// 直近のsetupScheduleFeedTriggers実行で発生した資格情報の競合。UIへ返して通知する。
let smbAuthWarnings = [];

// 共通のSMB認証情報（system_settings）を読む
function readGlobalSmbCredentials(db) {
  const mode = normalizeGlobalSmbMode(getSettingRecord(db, 'smb_auth_mode')?.value);
  return {
    mode,
    username: String(getSettingRecord(db, 'smb_username')?.value || '').trim(),
    password: String(getSettingRecord(db, 'smb_password')?.value || '').trim(),
  };
}

// スケジュールフィードが実際に使う認証情報を決める（inherit=共通設定を継承）。
// パスワードはフィード行ではなくsystem_settingsのフィード専用IDに入っている。
function readFeedSmbCredentials(db, feed) {
  const feedWithPassword = {
    smb_auth_mode: feed?.smb_auth_mode,
    smb_username: feed?.smb_username,
    smb_password: getSettingRecord(db, feedSmbPasswordSettingId(feed?.id))?.value || '',
  };
  return resolveFeedSmbCredentials(feedWithPassword, readGlobalSmbCredentials(db));
}

// SMBネットワーク共有フォルダの同期認証（Windows用）
// credentials省略時は共通設定を使う（従来の呼び出し元はそのまま動く）。
function authenticateSMBSync(watchPath, credentials = null) {
  if (!watchPath || !watchPath.startsWith('\\\\')) return { skipped: true };
  const cred = credentials || readGlobalSmbCredentials(readDB());
  if (cred.mode !== 'custom') return { skipped: true };

  const username = String(cred.username || '').trim();
  const password = String(cred.password || '').trim();
  if (!username || !password) return { skipped: true };

  const uncTarget = parseUncTarget(watchPath);
  if (!uncTarget) return { skipped: true };
  const targetShare = uncTarget.target;

  const fingerprint = credentialFingerprint(username, password);
  const planned = smbSessionRegistry.plan(uncTarget, fingerprint);
  if (planned.action === 'skip') {
    return { success: true, reused: true };
  }
  if (planned.action === 'conflict') {
    console.warn(`[SMB Auth Conflict] ${planned.message}`);
    return { success: false, conflict: true, message: planned.message };
  }

  console.log(`[SMB Auth] 同期認証中: target=${targetShare}, user=${username}`);

  try {
    // 前回起動の残骸を掃除する。同一資格情報で共有を追加するだけのときは
    // 切断すると稼働中の監視まで巻き添えにするため、初回だけに限定する。
    if (planned.deleteFirst) {
      try {
        execFileSync('net', ['use', targetShare, '/delete', '/y'], { stdio: 'ignore', timeout: 3000 });
      } catch(e) {}
    }

    // 新規接続セッションの作成
    // 注: パスワードはargv要素として渡るため、実行中はローカル管理者から
    // Win32_Process.CommandLineで見えうる（既存実装からの継承事項）。
    execFileSync('net', ['use', targetShare, password, `/user:${username}`, '/persistent:no'], { stdio: 'ignore', timeout: 5000 });
    smbSessionRegistry.commit(uncTarget, fingerprint);
    console.log(`[SMB Auth Success] ネットワークパス認証成功: ${targetShare}`);
    return { success: true };
  } catch (err) {
    console.error(`[SMB Auth Error] ネットワークパス認証失敗:`, err.message);
    return { success: false, message: `ネットワークパスの認証に失敗しました: ${targetShare}` };
  }
}

// 利用されなくなったサーバーのセッションを解放する。放置すると、フィード削除後に
// 同じサーバーを別の資格情報で使おうとした瞬間にOSレベルで1219になる。
function pruneUnusedSmbSessions(db) {
  const activeServerKeys = new Set();
  const collect = (p) => {
    const t = parseUncTarget(p);
    if (t) activeServerKeys.add(t.serverKey);
  };
  collect(getSettingRecord(db, 'import_directory')?.value || '');
  (db.schedule_feeds || []).forEach(feed => {
    if (feed?.is_active && feed?.watch_dir) collect(String(feed.watch_dir).trim());
  });
  smbSessionRegistry.prune([...activeServerKeys]).forEach(target => {
    try {
      execFileSync('net', ['use', target, '/delete', '/y'], { stdio: 'ignore', timeout: 3000 });
      console.log(`[SMB Auth] 未使用のセッションを解放しました: ${target}`);
    } catch (e) {}
  });
}

// 監視フォルダパスの決定
function resolveWatchDir() {
  const db = readDB();
  const setting = db.system_settings?.find(s => s.id === 'import_directory');
  let watchPath = setting && setting.value ? setting.value.trim() : '';
  if (!watchPath) {
    // パッケージ後のASARは読み取り専用のため、既定の監視先はuserData配下に置く。
    watchPath = path.join(app.getPath('userData'), 'import_folder');
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
    minWidth: 1024,
    minHeight: 700,
    title: 'TransBoard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    }
  });

  mainWindow.setMenu(null); // Hide file menu on Windows/Linux

  if (!app.isPackaged) {
    // 開発時だけ Ctrl+Shift+I で開発者ツールを開く
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.control && input.shift && input.key === 'I') {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }

  // このウィンドウは同梱したindex.htmlだけを表示する。外部ページや子ウィンドウへ
  // preload権限が引き継がれないよう、画面遷移とwindow.openを既定拒否する。
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const target = new URL(navigationUrl);
      target.hash = '';
      target.search = '';
      if (target.href === TRUSTED_RENDERER_URL) return;
    } catch {}
    event.preventDefault();
    console.warn('[Security] 予期しないナビゲーションを拒否しました');
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // マイク・カメラ・クリップボード等は、同梱rendererからの要求に限って許可する。
  const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'clipboard-read', 'local-network-access']);
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(
      webContents === mainWindow?.webContents &&
      isTrustedRendererFrame(webContents.mainFrame) &&
      ALLOWED_PERMISSIONS.has(permission)
    );
  });
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => (
    webContents === mainWindow?.webContents &&
    isTrustedRendererFrame(webContents.mainFrame) &&
    ALLOWED_PERMISSIONS.has(permission)
  ));

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (event) => {
    let shareMode = 'client';
    try {
      shareMode = normalizeShareMode(getSettingRecord(readDB(), 'share_mode')?.value);
    } catch (err) {
      // DB障害時にcloseイベント自体を失敗させず、安全に終了させる。
      console.error('[App] 終了時の設定読み込みに失敗しました:', err);
      isQuitting = true;
    }
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
  const schedule = getJsonSetting(db, 'import_schedule', { mode: 'realtime' });

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

  // 取り込みは親機だけが行う。import_directoryは共有DBにあるため、ガードが無いと
  // 全子機が親機と同じフォルダを監視し、取り込み後のアーカイブ/削除
  // (archiveFile)でソースCSVを先に消してしまい、親機が取り込めなくなる。
  // 停止処理のあとに置くことで、親機→子機へ切り替えた直後の呼び出しでも
  // 既存の監視を確実に止めてから抜ける。
  if (isClientTerminal(db)) {
    console.log('[Watcher] 子機のため取り込み監視は開始しません');
    return;
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
          importCSV(filePath).catch(err => console.error(`[Scheduler] CSV取り込みエラー: ${filePath}`, err));
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
let scheduleFeedRetryTimer = null;

function setupScheduleFeedTriggers() {
  if (scheduleFeedRetryTimer) {
    clearTimeout(scheduleFeedRetryTimer);
    scheduleFeedRetryTimer = null;
  }
  // 既存の監視・タイマーをすべて停止
  scheduleFeedWatchers.forEach(w => { try { w.close(); } catch (e) {} });
  scheduleFeedWatchers = [];
  scheduleFeedTimers.forEach(t => clearInterval(t));
  scheduleFeedTimers = [];

  const db = readDB();

  // 取り込みは親機だけが行う。schedule_feedsは共有DBにあるため、ガードが無いと
  // 全子機が親機と同じフォルダを監視し、取り込み後のアーカイブ/削除
  // (archiveScheduleFeedFile)でソースCSVを先に消してしまう。
  // 既存の監視・タイマーを停止したあとに置く（上部の停止処理を参照）。
  if (isClientTerminal(db)) {
    console.log('[ScheduleFeed] 子機のためスケジュール監視は開始しません');
    return;
  }

  const feeds = (db.schedule_feeds || []).filter(f => f.is_active && f.watch_dir);
  let retryRequired = false;

  // 使われなくなったサーバーのセッションを先に解放する
  pruneUnusedSmbSessions(db);

  // パス1: 先に全フィードの認証を済ませる。認証と監視作成を1ループで混ぜると、
  // 後続フィードの net use がすでに稼働中のwatcherの共有を切りうるため分ける。
  smbAuthWarnings = [];
  feeds.forEach(feed => {
    const watchDir = feed.watch_dir.trim();
    if (!watchDir.startsWith('\\\\')) return;
    const result = authenticateSMBSync(watchDir, readFeedSmbCredentials(db, feed));
    if (result && result.success === false) {
      smbAuthWarnings.push({ feedId: feed.id, feedName: feed.name || '', message: result.message });
    }
  });

  // パス2: 監視・タイマーを作成する
  feeds.forEach(feed => {
    const watchDir = feed.watch_dir.trim();
    if (!fs.existsSync(watchDir)) {
      retryRequired = true;
      console.warn(`[ScheduleFeed] 監視フォルダが見つかりません。30秒後に再確認します: ${watchDir}`);
      return;
    }

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
  if (retryRequired) {
    scheduleFeedRetryTimer = setTimeout(() => {
      scheduleFeedRetryTimer = null;
      setupScheduleFeedTriggers();
    }, 30000);
  }
}

// 手動取り込みAPI(triggerScheduleFeedImportOnParent)がフォルダ内のCSV全件の
// 取り込み完了を待ってから結果を返せるよう、Promiseを返す。同期例外・各CSVの
// 個別エラーはimportScheduleFeedCSV側で吸収されるためここではthrowしない
// (setInterval等のfire-and-forgetな呼び出し元でも安全に使える)
async function scanAndImportScheduleFolder(watchDir, feed) {
  // UNC監視先はセッションが切れていることがあるため都度確認する
  // （同一資格情報で接続済みならレジストリがskipするので実質無コスト）
  if (String(watchDir || '').startsWith('\\\\')) {
    authenticateSMBSync(watchDir, readFeedSmbCredentials(readDB(), feed));
  }
  if (!fs.existsSync(watchDir)) return { success: false, importedCount: 0, message: '監視フォルダが存在しません' };
  let files;
  try {
    files = await fs.promises.readdir(watchDir);
  } catch (e) {
    return { success: false, importedCount: 0, message: e.message };
  }
  const results = [];
  for (const file of files) {
    try {
      const filePath = path.join(watchDir, file);
      if (fs.statSync(filePath).isFile() && path.extname(file).toLowerCase() === '.csv') {
        results.push(await importScheduleFeedCSV(filePath, feed));
      }
    } catch (e) {}
  }
  const importedCount = results.reduce((sum, r) => sum + (r?.count || 0), 0);
  const failed = results.find(r => r && r.success === false);
  if (failed) return { success: false, importedCount, message: failed.message || '取り込みに失敗したCSVファイルがあります' };
  return { success: true, importedCount, message: null };
}

// 時刻部分の区切り文字は現場のCSV/機器出力によって : (半角/全角) と . が
// 混在するため、いずれも許容する（例: 13:05:30 / 13：05 / 13.05.30 / 13.05）
const SCHEDULE_TIME_RE_SRC = '(\\d{1,2})[：:.](\\d{2})(?:[：:.](\\d{2}))?';

function parseScheduleDatetimeMs(dateStr, timeStr) {
  if (!dateStr) return null;
  const combined = timeStr ? `${dateStr.trim()} ${timeStr.trim()}` : dateStr.trim();

  // ISO形式 or ブラウザ互換形式を試みる
  // (ドット区切り時刻は Date コンストラクタでは常に Invalid Date になるため、
  // ここで誤った日時が拾われる心配はない)
  let d = new Date(combined);
  if (!isNaN(d.getTime())) return d.getTime();

  // YYYY/MM/DD HH:mm[:ss] (時刻区切りは : ： . のいずれも可)
  const m1 = combined.match(new RegExp(`^(\\d{4})[\\/\\-](\\d{1,2})[\\/\\-](\\d{1,2})(?:[\\s　T]+${SCHEDULE_TIME_RE_SRC})?`));
  if (m1) {
    const [, y, mo, dy, h = '0', mi = '0', se = '0'] = m1;
    d = new Date(Number(y), Number(mo) - 1, Number(dy), Number(h), Number(mi), Number(se));
    if (!isNaN(d.getTime())) return d.getTime();
  }

  // MM/DD/YYYY HH:mm[:ss] (時刻区切りは : ： . のいずれも可)
  const m2 = combined.match(new RegExp(`^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})(?:\\s+${SCHEDULE_TIME_RE_SRC})?`));
  if (m2) {
    const [, mo, dy, y, h = '0', mi = '0', se = '0'] = m2;
    d = new Date(Number(y), Number(mo) - 1, Number(dy), Number(h), Number(mi), Number(se));
    if (!isNaN(d.getTime())) return d.getTime();
  }

  return null;
}

const MAX_CSV_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CSV_ROWS = 100000;
const MAX_BACKUP_FILE_BYTES = 100 * 1024 * 1024;

function assertCsvFileSize(filePath) {
  const size = fs.statSync(filePath).size;
  if (size > MAX_CSV_FILE_BYTES) {
    throw new Error(`CSVファイルが大きすぎます（上限${MAX_CSV_FILE_BYTES / 1024 / 1024}MB）`);
  }
}

const SCHEDULE_CSV_ENCODINGS = new Set([
  'auto',
  'utf-8',
  'shift-jis',
  'utf-16le',
  'utf-16be',
  'euc-jp',
]);

function normalizeScheduleCsvEncoding(value) {
  const normalized = String(value || 'auto').trim().toLowerCase();
  return SCHEDULE_CSV_ENCODINGS.has(normalized) ? normalized : 'auto';
}

function decodeScheduleCsvBuffer(buffer, requestedEncoding = 'auto') {
  let encoding = normalizeScheduleCsvEncoding(requestedEncoding);
  if (encoding === 'auto') {
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      encoding = 'utf-8';
    } else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      encoding = 'utf-16le';
    } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      encoding = 'utf-16be';
    } else if (isUtf8(buffer)) {
      encoding = 'utf-8';
    } else {
      encoding = 'shift-jis';
    }
  }

  let text = new TextDecoder(encoding).decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, encoding };
}

// 監視フォルダのパスから、それを使っているスケジュールフィードを引き当てる。
// ヘッダ読み込み時にそのフィードのSMB認証情報を使うために必要。
function findFeedForFolder(db, folderPath) {
  const target = String(folderPath || '').trim();
  if (!target) return null;
  const resolved = path.resolve(target).toLowerCase();
  return (db.schedule_feeds || []).find(feed => {
    const dir = String(feed?.watch_dir || '').trim();
    return dir && path.resolve(dir).toLowerCase() === resolved;
  }) || null;
}

function readScheduleCsvHeaders(folderPath, requestedEncoding = 'auto', credentials = null) {
  try {
    const authResult = authenticateSMBSync(folderPath, credentials);
    if (authResult && authResult.success === false) {
      return { success: false, ok: false, reason: authResult.message };
    }
    const files = fs.readdirSync(folderPath).filter(f => f.toLowerCase().endsWith('.csv'));
    if (files.length === 0) return { success: false, ok: false, reason: 'no_csv' };
    const firstFile = path.join(folderPath, files[0]);
    assertCsvFileSize(firstFile);
    const buffer = fs.readFileSync(firstFile);
    const { text, encoding } = decodeScheduleCsvBuffer(buffer, requestedEncoding);
    const firstLine = text.split(/\r?\n/)[0] || '';
    // カンマ区切りとタブ区切りを自動判定
    const sep = firstLine.includes('\t') ? '\t' : ',';
    const headers = firstLine.split(sep).map(h => h.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
    return { success: true, ok: true, headers, filename: files[0], encoding };
  } catch (e) {
    return { success: false, ok: false, reason: e.message };
  }
}

// この関数は失敗時も例外をthrow/rejectしない(全て内部でcatchしIPC/ログへ報告する)。
// スケジュール監視のイベントハンドラ(setInterval・chokidarの'add')から呼ばれた際に
// 未処理のPromise拒否や同期例外でプロセス全体が落ちるのを避けるため。
// 呼び出し元(手動取り込みAPI等)は返り値の{success, count, message}で結果を判定できる
function importScheduleFeedCSV(filePath, feed) {
  return new Promise(resolve => {
    try {
      assertCsvFileSize(filePath);
      const buffer = fs.readFileSync(filePath);
      const { text: decodedText, encoding } = decodeScheduleCsvBuffer(buffer, feed.encoding);

      const mapping = feed.mapping || {};
      const results = [];
      const parser = csv();
      parser.on('data', row => {
        if (results.length >= MAX_CSV_ROWS) {
          parser.destroy(new Error(`CSVの行数が上限${MAX_CSV_ROWS}件を超えています`));
          return;
        }
        results.push(row);
      });
      Readable.from([decodedText])
        .pipe(parser)
        .on('end', () => {
          const db = readDB();
          if (!db.schedule_items) db.schedule_items = [];

          // 取り込みは「このフィードの既存アイテムを全削除してから再挿入」する方式のため、
          // 先に新しいアイテムを組み立て、既存を消す前に妥当性を確認する
          const newItems = [];
          results.forEach(row => {
            const dateVal = mapping.col_date ? row[mapping.col_date] : null;
            const timeVal = mapping.col_time ? row[mapping.col_time] : null;
            const dtVal = mapping.col_datetime ? row[mapping.col_datetime] : null;

            const startMs = parseScheduleDatetimeMs(dtVal || dateVal, dtVal ? null : timeVal);
            if (!startMs) return;

            const title = mapping.col_title ? (row[mapping.col_title] || '') : '';
            const identifier = mapping.col_id ? (row[mapping.col_id] || '') : '';
            const durationMin = mapping.col_duration_min ? parseInt(row[mapping.col_duration_min]) || null : null;

            newItems.push({
              id: `sched-${feed.id}-${startMs}-${newItems.length}`,
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
          });

          // 行はあるのに日時を1件も解釈できなかった場合、列マッピングの誤りやCSV形式の
          // 変更である可能性が高い。このまま進めるとそのフィードの予定が全て消えるため、
          // 既存アイテムには触れずに中止する（患者CSV取り込み側の空振りガードと同じ方針）
          if (results.length > 0 && newItems.length === 0) {
            const message = `${results.length}行すべてで日時を解釈できなかったため、取り込みを中止しました。日付・時刻の列マッピングを確認してください。`;
            console.warn(`[ScheduleFeed] "${feed.name}" ${message}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('schedule-imported', {
                success: false,
                feedId: feed.id,
                feedName: feed.name,
                fileName: path.basename(filePath),
                count: 0,
                encoding,
                message,
              });
            }
            resolve({ success: false, count: 0, message });
            return;
          }

          db.schedule_items = db.schedule_items.filter(x => x.feed_id !== feed.id);
          db.schedule_items.push(...newItems);
          const count = newItems.length;

          const saved = writeDB(db);
          if (!saved) {
            const message = 'スケジュールの保存に失敗しました。ディスク容量や書き込み権限を確認してください。';
            console.error(`[ScheduleFeed] "${feed.name}" ${message}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('schedule-imported', {
                success: false,
                feedId: feed.id,
                feedName: feed.name,
                fileName: path.basename(filePath),
                count: 0,
                encoding,
                message,
              });
            }
            resolve({ success: false, count: 0, message });
            return;
          }
          console.log(`[ScheduleFeed] "${feed.name}" 取り込み完了: ${count}件 (${path.basename(filePath)}, ${encoding})`);

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('schedule-imported', {
              success: true,
              feedId: feed.id,
              feedName: feed.name,
              fileName: path.basename(filePath),
              count,
              encoding
            });
          }

          // アーカイブ処理（メイン取り込みと同様）
          const policy = feed.retention_policy || { action: 'archive', retentionDays: '30' };
          archiveScheduleFeedFile(filePath, feed, policy);
          resolve({ success: true, count, message: null });
        })
        .on('error', err => {
          console.error(`[ScheduleFeed] "${feed.name}" パースエラー:`, err);
          resolve({ success: false, count: 0, message: err.message });
        });
    } catch (err) {
      console.error(`[ScheduleFeed] "${feed.name}" 読み込みエラー:`, err);
      resolve({ success: false, count: 0, message: err.message });
    }
  });
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

function registerImportJob(filePath) {
  for (const job of pendingImportJobs.values()) {
    if (job.filePath === filePath) {
      console.warn(`[Watcher] 同じCSVの取り込みが進行中のため重複実行を抑止しました: ${filePath}`);
      return null;
    }
  }
  const importId = `import-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const timer = setTimeout(() => {
    if (!pendingImportJobs.has(importId)) return;
    pendingImportJobs.delete(importId);
    console.warn(`[Watcher] インポート完了応答がないため原本を残します: ${filePath}`);
  }, IMPORT_JOB_TIMEOUT_MS);
  pendingImportJobs.set(importId, { filePath, timer, createdAt: Date.now() });
  return importId;
}

// renderer側のDB更新結果を受けてから、CSV原本をアーカイブ／削除する。
handleTrusted('complete-data-import', (event, payload = {}) => {
  const importId = typeof payload.importId === 'string' ? payload.importId.trim() : '';
  const success = payload.success === true;
  if (!importId || importId.length > 160) return { success: false, message: '不正なインポートIDです。' };
  const job = pendingImportJobs.get(importId);
  if (!job) return { success: false, message: 'インポートジョブが見つからないか、期限切れです。' };
  clearTimeout(job.timer);
  pendingImportJobs.delete(importId);
  if (!success) {
    console.warn(`[Watcher] DB更新失敗のため原本を残します: ${job.filePath}`);
    return { success: true, archived: false };
  }
  archiveFile(job.filePath);
  return { success: true, archived: true };
});

// CSVファイルをパースしてレンダラーへ送信
async function importCSV(filePath) {
  const importId = registerImportJob(filePath);
  if (!importId) return;
  try {
    assertCsvFileSize(filePath);
    const buffer = await fs.promises.readFile(filePath);
    
    // 文字コードの自動判定（BOM判定 または UTF-8バイナリ判定）
    let encoding = 'shift-jis'; // デフォルトは Shift-JIS
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      encoding = 'utf-8';
    } else if (isUtf8(buffer)) {
      encoding = 'utf-8';
    } else {
      // マッピング設定に保存されている設定値があればフォールバック
      const db = readDB();
      const mapping = getJsonSetting(db, 'import_mapping', {});
      if (mapping.encoding) {
        encoding = mapping.encoding;
      }
    }
    
    const decoder = new TextDecoder(encoding);
    const decodedText = decoder.decode(buffer);

    const results = [];
    const parser = csv();
    parser.on('data', data => {
      if (results.length >= MAX_CSV_ROWS) {
        parser.destroy(new Error(`CSVの行数が上限${MAX_CSV_ROWS}件を超えています`));
        return;
      }
      results.push(data);
    });
    Readable.from([decodedText])
      .pipe(parser)
      .on('end', () => {
        console.log(`[Watcher] パース完了 (${encoding}): ${results.length} 件`);
        if (mainWindow) {
          mainWindow.webContents.send('data-imported', {
            importId,
            fileName: path.basename(filePath),
            rows: results
          });
        }
      })
      .on('error', (err) => {
        console.error('[Watcher] パースエラー:', err);
        if (mainWindow) {
          mainWindow.webContents.send('data-import-failed', {
            importId,
            fileName: path.basename(filePath),
            error: err.message
          });
        }
      });
  } catch (err) {
    console.error('[Watcher] ファイル読み込みまたはデコードエラー:', err);
    if (mainWindow) {
      mainWindow.webContents.send('data-import-failed', {
        importId,
        fileName: path.basename(filePath),
        error: err.message
      });
    }
  }
}

// 古いアーカイブファイルを整理
function cleanOldArchives() {
  const db = readDB();
  const policy = getJsonSetting(db, 'import_retention_policy', { action: 'archive', retentionDays: '30' });

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
  const policy = getJsonSetting(db, 'import_retention_policy', { action: 'archive', retentionDays: '30' });

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
handleTrusted('get-watch-directory', () => {
  return currentWatchDir;
});

// 親機が既にSMB接続するよう設定されているサーバーの集合。
// 子機が指定したパスに対して親機の資格情報で net use するのは、
// 「既に設定済みのサーバーへ接続し直す」場合に限る。
function getConfiguredSmbServerKeys(db) {
  const keys = new Set();
  const collect = (p) => {
    const t = parseUncTarget(p);
    if (t) keys.add(t.serverKey);
  };
  collect(getSettingRecord(db, 'import_directory')?.value || '');
  (db.schedule_feeds || []).forEach(feed => collect(String(feed?.watch_dir || '').trim()));
  return keys;
}

function validateWatchDirectoryOnParent(newPath, { isExternal = false } = {}) {
  const resolved = newPath && newPath.trim()
    ? newPath.trim()
    : path.join(app.getPath('userData'), 'import_folder');

  // 子機からの要求で、まだ設定されていないサーバーのUNCパスが来た場合は拒否する。
  // ここを通すと、子機が指定した任意のホストへ親機が保存済みのSMB資格情報で
  // net use しに行き（authenticateSMBSync）、さらに mkdirSync まで実行してしまう。
  // 設定済みのフィード/監視先だけを触るという schedule-feed-headers と同じ方針。
  if (isExternal) {
    const target = parseUncTarget(resolved);
    if (target && !getConfiguredSmbServerKeys(readDB()).has(target.serverKey)) {
      return {
        success: false,
        message: `新しいネットワーク共有（\\\\${target.server}）の追加は親機で行ってください。`,
      };
    }
  }

  // UNCパスの場合のみSMBネットワーク共有フォルダの認証を実行
  authenticateSMBSync(resolved);

  if (!fs.existsSync(resolved)) {
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (err) {
      console.error(`[Watcher] フォルダの自動作成失敗:`, err);
      return { success: false, message: `監視フォルダを作成できません: ${err.message}` };
    }
  }

  try {
    if (!fs.statSync(resolved).isDirectory()) {
      return { success: false, message: '指定された監視先はフォルダではありません。' };
    }
    // 保存時点で一覧を取得できることまで確認し、「保存成功後に手動スキャンだけ失敗」
    // する状態を防ぐ。UNC切断・権限不足もここで利用者へ返す。
    fs.readdirSync(resolved);
    approvedCsvHeaderFolders.add(normalizeLocalFolderPath(resolved));
  } catch (err) {
    console.error('[Watcher] 監視フォルダを開けません:', err);
    return { success: false, message: `監視フォルダを開けません: ${err.message}` };
  }

  return { success: true, path: resolved };
}

function updateWatchDirectoryOnParent(newPath, { isExternal = false } = {}) {
  const validation = validateWatchDirectoryOnParent(newPath, { isExternal });
  if (!validation.success) return validation;
  setupImportTrigger();
  setupScheduleFeedTriggers();
  return validation;
}

// IPC通信で監視対象フォルダを動的に切り替える
handleTrusted('update-watch-directory', (event, newPath) => updateWatchDirectoryOnParent(newPath));

// 子機へ切り替えたとき、再起動を待たずに共有サーバーを閉じるためのIPC。
// あわせて取り込み監視も止める（setupImportTrigger/setupScheduleFeedTriggersは
// 子機なら停止処理だけ行って抜ける）。
handleTrusted('stop-parent-server', () => {
  const result = stopParentServer();
  setupImportTrigger();
  setupScheduleFeedTriggers();
  return result;
});

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
handleTrusted('trigger-manual-import', () => triggerManualImportOnParent());

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

function sanitizeOdbcError(message, connectionString = '') {
  return String(message || 'ODBC処理に失敗しました')
    .replaceAll(String(connectionString || ''), '[接続文字列]')
    .replace(/((?:PWD|Password)\s*=\s*)[^;\s]*/ig, '$1***');
}

function execOdbcPowerShell(connectionString, scriptBody, timeoutMs = 15000) {
  const safe = String(connectionString).slice(0, 500).replace(/'/g, "''");
  const ps = `
# Windows PowerShell 5.1 uses the active Windows code page for redirected
# stdout by default. Node decodes this stream as UTF-8, so force the encoding
# before emitting Japanese ODBC errors or table names.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
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

  // cmd.exeを介さず固定実行ファイルへ引数配列で渡す。EncodedCommandにより、
  // 接続文字列やSQL中の記号がコマンドラインとして再解釈されない。
  const encodedCommand = Buffer.from(ps, 'utf16le').toString('base64');
  const timeout = Math.min(Math.max(Number(timeoutMs) || 15000, 1000), 60000);
  return new Promise(resolve => {
    execFile(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
      { encoding: 'utf8', timeout, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        const out = String(stdout || '').trim();
        if (error && (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT')) {
          resolve({ success: false, error: `処理がタイムアウトしました（${Math.round(timeout / 1000)}秒）。データベースの応答が遅いか、ネットワーク/権限の問題が考えられます。` });
          return;
        }
        if (error) {
          resolve({ success: false, error: sanitizeOdbcError(error.message, connectionString) });
          return;
        }
        if (!out || out.startsWith('ERROR:')) {
          resolve({ success: false, error: sanitizeOdbcError(out ? out.slice(6) : '接続に失敗しました', connectionString) });
          return;
        }
        resolve({ success: true, output: out });
      }
    );
  });
}

async function getOdbcTablesOnParent({ connectionString }) {
  if (!connectionString) return { success: false, error: '接続文字列が指定されていません', tables: [] };
  const connResult = enforceReadOnlyConnectionString(connectionString);
  if (!connResult.valid) {
    return { success: false, error: connResult.message, tables: [] };
  }
  // 他のODBC操作（test/preview/sync）と同じくDSN指定を必須にする。
  // これが無いと、子機が任意の接続文字列（Driver=…;Server=…）を指定して
  // 親機に外部ホストへ接続させられる。
  if (!connResult.connectionString.includes('DSN=')) {
    return { success: false, error: '接続文字列にDSN指定が見つかりません。例: DSN=EMR_DB;UID=admin;PWD=pass;', tables: [] };
  }

  const result = await execOdbcPowerShell(connResult.connectionString, `
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
handleTrusted('get-odbc-tables', (event, config) => getOdbcTablesOnParent(config || {}));

function getOdbcDsnsOnParent() {
  const result = { system: [], user: [], drivers: [] };
  const regQuery = (hive, subkey) => {
    try {
      const registryPath = `${hive}\\SOFTWARE\\ODBC\\ODBC.INI\\${subkey}`;
      const out = execFileSync(REG_EXE, ['query', registryPath], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      return out.split('\r\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith(hive) && !l.startsWith('HKEY'))
        .map(l => { const m = l.match(/^(.+?)\s+REG_SZ\s+(.+)$/); return m ? { name: m[1].trim(), driver: m[2].trim() } : null; })
        .filter(Boolean);
    } catch { return []; }
  };
  const driverQuery = (hive) => {
    try {
      const registryPath = `${hive}\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers`;
      const out = execFileSync(REG_EXE, ['query', registryPath], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
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
handleTrusted('get-odbc-dsns', () => getOdbcDsnsOnParent());

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

  const result = await execOdbcPowerShell(finalConnStr, "  Write-Output 'OK'", 15000);
  if (!result.success) {
    return { success: false, message: 'ODBCデータベース接続テストに失敗しました: ' + result.error };
  }
  return { success: true, message: 'ODBCデータベース接続テストに成功しました。(接続先: ' + finalConnStr.split(';')[0] + ' [読み取り専用: 強制適用済、実接続確認済])' };
}

// IPC通信でODBCデータベース接続テストを行う
handleTrusted('test-odbc-connection', (event, config) => testOdbcConnectionOnParent(config || {}));

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

  const result = await execOdbcPowerShell(finalConnStr, buildOdbcRowFetchScript(sqlQuery, null), 30000);
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
handleTrusted('run-odbc-sync', (event, config) => runOdbcSyncOnParent(config || {}));

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

  const result = await execOdbcPowerShell(finalConnStr, buildOdbcRowFetchScript(sqlQuery, 15), 20000);
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
handleTrusted('preview-odbc-query', (event, config) => previewOdbcQueryOnParent(config || {}));

// IPC通信で出棟中（進行中）の移送情報をリセットする
handleTrusted('reset-database', () => {
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

// WebRTCシグナリング処理は、入力検証とキュー上限を含む専用サービスへ委譲する。
function processWebrtcRequest(method, urlPath, bodyStr) {
  return webrtcSignaling.handle(method, urlPath, bodyStr);
}

const ALLOWED_TABLES = new Set([
  'wards', 'beds', 'exam_rooms', 'exam_types', 'staffs',
  'system_settings', 'transfer_events', 'transfer_status_logs',
  'calls', 'import_logs', 'schedule_feeds', 'schedule_items',
  'audit_logs', 'handover_notes', 'bed_occupancy_log',
]);

// 共有マスターは親機を唯一の書き込み元とし、更新時刻で子機同士の上書きを検知する。
const MASTER_REVISION_TABLES = new Set([
  'wards', 'beds', 'exam_rooms', 'exam_types', 'staffs', 'system_settings',
]);

function checkMasterRevision(table, existing, payload) {
  if (!MASTER_REVISION_TABLES.has(table) || !payload || typeof payload !== 'object') return null;
  const expected = Object.prototype.hasOwnProperty.call(payload, '_expectedUpdatedAt')
    ? payload._expectedUpdatedAt
    : undefined;
  if (expected !== undefined && String(existing?.updated_at || '') !== String(expected || '')) {
    return {
      success: false,
      conflict: true,
      message: '他の端末でマスターが更新されています。最新データを取得してから再度保存してください。',
    };
  }
  return null;
}

function applyMasterRevision(table, existing, payload) {
  if (!MASTER_REVISION_TABLES.has(table) || !payload || typeof payload !== 'object') return null;
  const conflict = checkMasterRevision(table, existing, payload);
  if (conflict) return conflict;
  delete payload._expectedUpdatedAt;
  payload.updated_at = Math.max(Date.now(), Number(existing?.updated_at || 0) + 1);
  return null;
}

function validateMasterReferences(db, table, existing, payload) {
  if (table !== 'beds' || !payload || typeof payload !== 'object') return null;
  delete payload.bed_type;
  if (Object.prototype.hasOwnProperty.call(payload, 'bed_number')) {
    const bedNumber = String(payload.bed_number || '').trim();
    if (!bedNumber) {
      return { success: false, message: '病床番号は必須です。' };
    }
    const duplicate = (db.beds || []).find(bed =>
      String(bed.id) !== String(existing?.id || '') &&
      String(bed.bed_number || '').trim().toLowerCase() === bedNumber.toLowerCase()
    );
    if (duplicate) {
      return { success: false, conflict: true, message: `病床番号が重複しています: ${bedNumber}` };
    }
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'ward_id') || !payload.ward_id) return null;
  const wardExists = (db.wards || []).some(ward => String(ward.id) === String(payload.ward_id));
  if (!wardExists) {
    return {
      success: false,
      conflict: true,
      message: '指定された病棟が存在しないため、病床を保存できません。最新の病棟マスターを取得してください。',
    };
  }
  return null;
}

// 患者情報（氏名・ID）を含むテーブル。追加のマスキング判断にも使用する。
// 申し送りメモ(handover_notes)は本文に患者名等が入りうるため患者データ扱いとする
// bed_occupancy_logは非マスクの氏名・IDを保持するため同様に患者データ扱いとする
const PATIENT_DATA_TABLES = new Set(['beds', 'transfer_events', 'audit_logs', 'handover_notes', 'bed_occupancy_log']);
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

// テーブルへの書き込みに付随する副作用(在室ログの反映・申し送りメモの間引き等)を
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
  handover_notes: {
    finalize: (db) => {
      const removedNotes = pruneHandoverNotes(db);
      if (removedNotes > 0) {
        console.log(`[DB Cleaner] Trimmed ${removedNotes} resolved handover notes.`);
      }
    },
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
  if (isExternal && !isValidApiToken(apiToken)) {
    console.warn('[Security] 移送開始APIトークン認証失敗');
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }
  if (normalizeTerminalRole(requestMeta.terminalRole) === 'exam') {
    return { success: false, message: '検査室端末では移送を開始できません' };
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
  db.transfer_status_logs = db.transfer_status_logs || [];
  db.transfer_status_logs.push({
    id: `log-${now}-${Math.random().toString(36).slice(2, 7)}`,
    transfer_event_id: eventId,
    from_status: null,
    to_status: 'MOVING',
    changed_by: isExternal ? 'child_api' : 'local_ui',
    changed_at: now,
    note: '',
  });
  pruneTransferStatusLogs(db);
  trimTable(events, TRANSFER_EVENTS_MAX_ENTRIES, 'transfer_events');
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

async function processStatusUpdateRequest(method, bodyStr, isExternal = false, apiToken = null, requestMeta = {}) {
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
  db.transfer_status_logs = db.transfer_status_logs || [];
  db.transfer_status_logs.push({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    transfer_event_id: eventId,
    from_status: fromStatus,
    to_status: newStatus,
    changed_by: statusActor,
    changed_at: now,
    note: '',
  });
  pruneTransferStatusLogs(db);
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

  if (!writeDB(db)) {
    throw new Error('データベースの保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
  }

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
  if (isExternal && !isValidApiToken(apiToken)) {
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }

  let payload;
  try { payload = JSON.parse(bodyStr || '{}'); } catch {
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
  db.transfer_status_logs = Array.isArray(db.transfer_status_logs) ? db.transfer_status_logs : [];
  db.transfer_status_logs.push({
    id: `log-${now}-${Math.random().toString(36).slice(2, 7)}`,
    transfer_event_id: event.id,
    from_status: event.current_status,
    to_status: event.current_status,
    changed_by: isExternal ? '子機操作' : 'UI操作',
    changed_at: now,
    note,
  });
  pruneTransferStatusLogs(db);
  appendAuditLog(db, 'STATUS_NOTE', {
    targetType: 'transfer_events',
    targetId: event.id,
    actorType: isExternal ? 'child_api' : 'local_ui',
    details: { status: event.current_status },
  });
  if (!writeDB(db)) {
    throw new Error('データベースの保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
  }
  return { success: true };
}

function processStatusAcknowledgeRequest(method, bodyStr, isExternal = false, apiToken = null, requestMeta = {}) {
  if (method !== 'POST') {
    return { success: false, message: 'Method Not Allowed' };
  }
  if (isExternal && !isValidApiToken(apiToken)) {
    return { success: false, message: 'Unauthorized', unauthorized: true };
  }
  if (normalizeTerminalRole(requestMeta.terminalRole) === 'exam') {
    return { success: false, message: '検査室端末では病棟通知を確認できません' };
  }

  let payload;
  try { payload = JSON.parse(bodyStr || '{}'); } catch {
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

function processMasterBulkUpsert(table, records, db, isExternal, requestMeta = {}) {
  const bulkTables = new Set(['wards', 'beds', 'exam_rooms', 'exam_types', 'staffs']);
  if (!bulkTables.has(table)) {
    return { success: false, message: 'このテーブルの一括マスター更新は許可されていません。' };
  }
  if (!Array.isArray(records) || records.length === 0 || records.length > 1000) {
    return { success: false, message: '一括マスター更新の件数が不正です。' };
  }

  const list = db[table] || [];
  const workingList = list.map(item => ({ ...item }));
  const seenIds = new Set();
  const operations = [];
  for (const raw of records) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { success: false, message: 'マスターデータの形式が不正です。' };
    }
    const data = { ...raw };
    if (!data.id) data.id = `${table}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const key = String(data.id);
    if (seenIds.has(key)) {
      return { success: false, conflict: true, message: '同じIDのマスターが複数含まれています。' };
    }
    seenIds.add(key);
    const index = workingList.findIndex(item => String(item.id) === key);
    const before = index === -1 ? null : workingList[index];
    const revisionError = applyMasterRevision(table, before, data);
    if (revisionError) return revisionError;
    const referenceError = validateMasterReferences(db, table, before, data);
    if (referenceError) return referenceError;
    const after = index === -1 ? data : { ...before, ...data };
    if (table === 'beds' && Object.prototype.hasOwnProperty.call(data, 'bed_number')) {
      const duplicate = workingList.find(item =>
        String(item.id) !== key &&
        String(item.bed_number || '').trim().toLowerCase() === String(data.bed_number || '').trim().toLowerCase()
      );
      if (duplicate) return { success: false, conflict: true, message: `病床番号が重複しています: ${data.bed_number}` };
    }
    if (index === -1) workingList.push(after);
    else workingList[index] = after;
    operations.push({ before: before ? JSON.parse(JSON.stringify(before)) : null, after });
  }

  const now = Date.now();
  if (table === 'beds') {
    db.bed_occupancy_log = db.bed_occupancy_log || [];
    for (const operation of operations) {
      WRITE_HOOKS.beds.onUpsert(db, operation.after.id, operation.after.ward_id, operation.before, operation.after, operation.after, now, null);
    }
    WRITE_HOOKS.beds.finalize(db, now);
  }
  db[table] = workingList;
  appendAuditLog(db, 'DB_BULK_UPSERT', {
    targetType: table,
    targetId: 'bulk',
    actorType: isExternal ? 'child_api' : 'local_ui',
    remoteIp: requestMeta.remoteIp || '',
    before: operations.map(operation => operation.before ? summarizeAuditRecord(table, operation.before) : null),
    after: operations.map(operation => summarizeAuditRecord(table, operation.after)),
    details: { method: 'POST', count: operations.length },
  });
  if (!writeDB(db)) {
    throw new Error('データベースの保存に失敗しました。ディスク容量や書き込み権限を確認してください。');
  }
  return { success: true, count: operations.length, data: operations.map(operation => operation.after) };
}

// 共通のデータベース操作処理関数
async function processDbRequest(method, url, bodyStr, isExternal = false, apiToken = null, requestMeta = {}) {
  // GETはDB全体をディープコピーせずキャッシュを直接参照する（高頻度ポーリングでの
  // CPU負荷対策）。GET経路はdbやdb[table]の中身をミューテーションしてはならない。
  // 書き込み系メソッドは従来どおりreadDB()で専用のディープコピーを取得する。
  const db = method === 'GET' ? readDbShared() : readDB();

  // URL解析 (例: "tables/transfer_events?limit=200" や "tables/beds/bed-701")
  const cleanUrl = url.replace(/^\//, '').replace(/^tables\//, '');
  const [urlPath, queryString] = cleanUrl.split('?');
  const searchParams = new URLSearchParams(queryString || '');
  const urlParts = urlPath.split('/');
  const table = urlParts[0];
  const id = urlParts[1];

  // 高頻度・低診断価値なGETポーリング(ダッシュボード5秒間隔等、接続端末数×
  // ポーリング頻度に比例して呼ばれる)では出力せず、書き込み系のみログする
  if (method !== 'GET') {
    console.log(`[DB Request] ${method} tables/${table}${id ? '/' + id : ''}`);
  }

  // テーブル名の許可リストチェック（不正テーブル名インジェクション防止）
  if (!ALLOWED_TABLES.has(table)) {
    console.warn(`[DB] 未許可のテーブル名へのアクセス: ${table}`);
    return { success: false, message: 'Not Found' };
  }

  if (table === 'audit_logs' && method !== 'GET') {
    return { success: false, message: 'Audit logs are append-only' };
  }

  // bed_occupancy_logはbedsへの書き込みの副作用として内部でのみ更新される
  // サーバー管理テーブル（applyBedOccupancyTransition等がdb.bed_occupancy_logを
  // 直接書き換える。このtableに対するPOST/PATCH/DELETEは経由しない）。
  // 外部からの直接書き換え・改ざんを防ぐため、GET以外は拒否する
  if (table === 'bed_occupancy_log' && method !== 'GET') {
    return { success: false, message: 'bed_occupancy_log is server-managed and cannot be written directly' };
  }

  // 状態変更ログは status/update / status/note からmainプロセスだけが追加する。
  // 汎用テーブルAPIを開けたままにすると、履歴の状態や操作者を任意に偽装できる。
  if (table === 'transfer_status_logs' && method !== 'GET') {
    return { success: false, message: 'transfer_status_logs is server-managed' };
  }

  // 管理者パスコードは専用IPCでのみ扱う。汎用DB APIからハッシュを取得・更新できると、
  // renderer上のXSSがオフライン解析やロックの無効化に悪用できるため、ローカルでも拒否する。
  if (table === 'system_settings') {
    if (id === 'admin_passcode') {
      return { success: false, message: 'Forbidden' };
    }
    if (method !== 'GET' && bodyStr) {
      try {
        const payload = JSON.parse(bodyStr);
        const records = Array.isArray(payload) ? payload : [payload];
        if (records.some(record => record?.id === 'admin_passcode')) {
          return { success: false, message: 'Forbidden' };
        }
      } catch {}
    }
  }

  // 患者情報を含むテーブルへの外部アクセスはAPIトークンで保護する
  if (isExternal && PATIENT_DATA_TABLES.has(table)) {
    if (!isValidApiToken(apiToken)) {
      console.warn(`[Security] APIトークン認証失敗: table=${table}`);
      return { success: false, message: 'Unauthorized', unauthorized: true };
    }
  }

  // 外部(HTTP)からのアクセスに対するセキュリティ制限（機密データの保護）
  if (isExternal && table === 'system_settings') {
    // パスコードは検証APIで照合し、ハッシュ自体は子機へ返さない。
    // ODBC接続文字列・SMBパスワード・APIトークンも単体GETを禁止する。
    // フィード個別のSMBパスワード(smb_password__<feedId>)も同じ扱いにするため、
    // 完全一致の配列ではなく述語で判定する
    const isBlockedSecret = (settingId) =>
      ['odbc_connection_string', 'smb_password', 'admin_passcode', 'api_token'].includes(settingId)
      || isFeedSmbPasswordSettingId(settingId);
    // 稼働モード・親機IPは各端末ローカルの設定。外部（子機）からの書き換えを許すと
    // 親機のDBの share_mode が'client'に上書きされ、再起動後に共有サーバーが
    // 起動しなくなるため、書き込みのみ遮断する（読み取りは従来どおり許可）
    const isWriteBlocked = (settingId) =>
      isBlockedSecret(settingId) || ['share_mode', 'parent_ip', 'wizard_completed'].includes(settingId);

    if (method === 'GET') {
      if (id) {
        if (isBlockedSecret(id)) {
          return { success: false, message: 'Forbidden' };
        }
      } else {
        // 全件取得時は機密設定の値をマスクして返す
        const list = db[table] || [];
        const filteredList = list.map(s => {
          if (isBlockedSecret(s.id)) {
            return { ...s, value: MASKED_SECRET_VALUE };
          }
          return s;
        });
        return { data: filteredList };
      }
    } else {
      // POST/PUT/PATCH/DELETE による機密設定・端末ローカル設定の更新・削除を禁止
      if (id && isWriteBlocked(id)) {
        return { success: false, message: 'Forbidden' };
      }
      if (bodyStr) {
        try {
          const data = JSON.parse(bodyStr);
          if (Array.isArray(data)) {
            if (data.some(x => isWriteBlocked(x.id))) {
              return { success: false, message: 'Forbidden' };
            }
          } else {
            if (isWriteBlocked(data.id)) {
              return { success: false, message: 'Forbidden' };
            }
          }
        } catch (e) {}
      }
    }
  }

  // GETはdbがdbCacheと共有されている可能性があるため、db[table]への代入で
  // キャッシュをミューテーションしない。書き込み系は従来どおりdb[table]を初期化する。
  if (!db[table] && method !== 'GET') {
    db[table] = [];
  }

  const list = db[table] || [];

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
      const scopedEventById = new Map(scoped.map(event => [String(event.id), event]));
      const recentStatusLogs = (db.transfer_status_logs || [])
        .filter(log => {
          const event = scopedEventById.get(String(log.transfer_event_id));
          const changedToday = !Number.isFinite(todayMs) || todayMs <= 0 || Number(log.changed_at || 0) >= todayMs;
          const isCurrentActiveStatus = event &&
            ACTIVE_TRANSFER_STATUSES.has(event.current_status) &&
            log.to_status === event.current_status;
          return event && log.from_status !== log.to_status && (changedToday || isCurrentActiveStatus);
        })
        .sort((a, b) => Number(b.changed_at || 0) - Number(a.changed_at || 0))
        .slice(0, 20)
        .map(log => {
          const event = scopedEventById.get(String(log.transfer_event_id));
          return {
            ...log,
            bed_id: event?.bed_id || null,
            exam_room_id: event?.exam_room_id || null,
            patient_name: event?.patient_name || null,
          };
        });
      return { success: true, activeEvents, todayEvents, recentStatusLogs };
    }

    // 検査室一覧の件数集計専用。検査室は病棟横断で共有されるが、一覧表示に
    // 患者名・患者ID・病床・イベントIDは不要なため、最小限の項目だけを返す。
    // transfer_events全件をrendererへ渡すと、別病棟の患者情報まで露出する。
    if (table === 'transfer_events' && id === 'exam-room-grid-status') {
      return {
        data: list
          .filter(event => ACTIVE_TRANSFER_STATUSES.has(event.current_status))
          .map(event => ({
            exam_room_id: event.exam_room_id || null,
            current_status: event.current_status,
          })),
      };
    }

    if (table === 'transfer_events' && id === 'exam-room-status') {
      const examRoomId = String(searchParams.get('exam_room_id') || '');
      const todayMs = Number(searchParams.get('today_ms') || 0);
      // exam_room_id未指定時は「全検査室の患者一覧」表示向けに、検査室が
      // 割り当てられている全イベントを対象にする(以降のロジックはscopedEvents
      // を汎用的に処理しているため変更不要)
      const scopedEvents = examRoomId
        ? list.filter(event => String(event.exam_room_id || '') === examRoomId)
        : list.filter(event => !!event.exam_room_id);
      const activeEvents = scopedEvents.filter(event => ACTIVE_TRANSFER_STATUSES.has(event.current_status));
      const scopedEventById = new Map(scopedEvents.map(event => [String(event.id), event]));
      const eventById = new Map(activeEvents.map(event => [String(event.id), event]));
      const latestLogByEventId = new Map();
      // 対象診察室に無関係なログはlatestLogByEventId/recentStatusLogsの
      // どちらにも影響しないため、全件ソートの前にscopedEventByIdで
      // 絞り込んでからソートし、ソート対象を縮小する。
      const sortedLogs = (db.transfer_status_logs || [])
        .filter(log => scopedEventById.has(String(log.transfer_event_id)))
        .sort((a, b) => Number(b.changed_at || 0) - Number(a.changed_at || 0));
      sortedLogs.forEach(log => {
          const key = String(log.transfer_event_id);
          const event = eventById.get(key);
          if (
            event &&
            !latestLogByEventId.has(key) &&
            log.from_status !== log.to_status &&
            log.to_status === event.current_status
          ) {
            latestLogByEventId.set(key, log);
          }
        });
      const recentStatusLogs = sortedLogs
        .filter(log => {
          const event = scopedEventById.get(String(log.transfer_event_id));
          const changedToday = !Number.isFinite(todayMs) || todayMs <= 0 || Number(log.changed_at || 0) >= todayMs;
          const isCurrentActiveStatus = event &&
            ACTIVE_TRANSFER_STATUSES.has(event.current_status) &&
            log.to_status === event.current_status;
          return event && log.from_status !== log.to_status && (changedToday || isCurrentActiveStatus);
        })
        .slice(0, 20)
        .map(log => {
          const event = scopedEventById.get(String(log.transfer_event_id));
          return {
            ...log,
            bed_id: event?.bed_id || null,
            ward_id: event?.ward_id || null,
            patient_name: event?.patient_name || null,
          };
        });
      return {
        success: true,
        data: activeEvents.map(event => ({
          ...event,
          latest_status_log: latestLogByEventId.get(String(event.id)) || null,
        })),
        recentStatusLogs,
      };
    }

    if (id) {
      const item = list.find(x => String(x.id) === String(id));
      if (!item) {
        console.warn(`[DB] GET Not Found: table=${table}, id=${id}`);
        return { success: false, message: 'Not Found' };
      }
      return item;
    } else {
      if (table === 'transfer_events') {
        const wardId = searchParams.get('ward_id');
        const bedId = searchParams.get('bed_id');
        const completedOnly = searchParams.get('completed_only') === 'true';
        // CSVインポート時の病床競合チェック等、全病棟横断で進行中イベントだけを
        // 必要とする場面向け。event_retention_daysが未設定の長期運用でtransfer_events
        // が肥大化しても、MAX_PARENT_RESPONSE_BYTES(5MB)超過で子機取得が失敗しないよう、
        // 全件返却ではなくサーバー側で進行中分だけに絞る
        const activeOnly = searchParams.get('active_only') === 'true';
        const completedStatuses = new Set(['RETURNED', 'CANCELLED']);
        const filtered = list.filter(event => (
          (!wardId || String(event.ward_id) === String(wardId)) &&
          (!bedId || String(event.bed_id) === String(bedId)) &&
          (!completedOnly || completedStatuses.has(event.current_status)) &&
          (!activeOnly || ACTIVE_TRANSFER_STATUSES.has(event.current_status))
        ));
        return { data: filtered };
      }
      if (table === 'transfer_status_logs') {
        const wardId = searchParams.get('ward_id');
        const eventId = searchParams.get('transfer_event_id');
        const eventWardById = new Map((db.transfer_events || []).map(event => [String(event.id), String(event.ward_id || '')]));
        const filtered = list.filter(log => (
          (!wardId || eventWardById.get(String(log.transfer_event_id)) === String(wardId)) &&
          (!eventId || String(log.transfer_event_id) === String(eventId))
        ));
        return { data: filtered };
      }
      // 在室ログは全件だと最大2万件になりうるため、病床指定時はサーバー側で絞る
      // （病床履歴パネルは1病床分しか使わない。子機では転送量にも効く）
      if (table === 'bed_occupancy_log') {
        const bedId = searchParams.get('bed_id');
        if (bedId) {
          return { data: list.filter(o => String(o.bed_id) === String(bedId)) };
        }
      }
      if (table === 'system_settings') {
        return {
          data: list.map(setting => (
            setting.id === 'admin_passcode'
              ? { ...setting, value: '********' }
              : setting
          )),
        };
      }
      // 申し送りメモは病棟指定時にサーバー側で絞る（ダッシュボードは常に自病棟分しか
      // 使わない。子機では5秒ポーリングごとの転送量にも効く）
      if (table === 'handover_notes') {
        const wardId = searchParams.get('ward_id');
        if (wardId) {
          return { data: list.filter(note => String(note.ward_id) === String(wardId)) };
        }
      }
      // スケジュール項目は日次表示のたびに当日分しか使わないため、範囲指定時は
      // サーバー側で絞る（5秒ポーリングごとの全件転送・全件クローンを避ける）
      if (table === 'schedule_items' && searchParams.has('start_ms') && searchParams.has('end_ms')) {
        const startMs = Number(searchParams.get('start_ms'));
        const endMs = Number(searchParams.get('end_ms'));
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          return { data: list.filter(item => item.start_ms != null && item.start_ms >= startMs && item.start_ms < endMs) };
        }
      }
      return { data: list };
    }
  }

  if (method === 'POST') {
    let data;
    try { data = JSON.parse(bodyStr); } catch {
      return { success: false, message: 'リクエストボディのJSONが不正です' };
    }
    if (id === 'bulk') {
      return processMasterBulkUpsert(table, data, db, isExternal, requestMeta);
    }
    // _occupancySourceは在室ログ用の内部ヒントであり、他のテーブルにも誤って
    // 送られた場合にレコード本体へ紛れ込まないよう、テーブルを問わず必ず除去する
    let postOccupancySource = null;
    if (Object.prototype.hasOwnProperty.call(data, '_occupancySource')) {
      postOccupancySource = data._occupancySource || null;
      delete data._occupancySource;
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
    const masterRevisionError = applyMasterRevision(table, beforeItem, data);
    if (masterRevisionError) return masterRevisionError;
    const referenceError = validateMasterReferences(db, table, beforeItem, data);
    if (referenceError) return referenceError;
    if (index !== -1) {
      // current_statusの変更はstatus/update(processStatusUpdateRequest)の1経路に
      // 集約する。ここを素通しにすると、スコープ別ルールではなく緩い和集合の判定
      // だけで通ってしまい、タイムスタンプ・transfer_status_logs行・監査ログ・
      // 音声通知の副作用も一切伴わない状態変更が発生しうる(isExternalかどうかを
      // 問わない。ローカル(親機UI)側もこの経路を使っていないことを確認済み)
      if (
        table === 'transfer_events' &&
        Object.prototype.hasOwnProperty.call(data, 'current_status')
      ) {
        return { success: false, message: 'Use status/update for status changes' };
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
      if (
        table === 'transfer_events' &&
        Object.prototype.hasOwnProperty.call(data, 'current_status') &&
        !KNOWN_TRANSFER_STATUSES.has(data.current_status)
      ) {
        return { success: false, message: `Invalid current_status: ${data.current_status}` };
      }
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
        pruneTransferStatusLogs(db);
      }
      console.log(`[DB] POST Created: table=${table}, id=${data.id}`);
    }

    // beds はPATCHだけでなくPOSTでも患者情報が入りうるため、同じ経路で在室ログへ反映する
    if (table === 'beds') {
      const occupancyNow = Date.now();
      const afterRecord = index !== -1 ? list[index] : data;
      WRITE_HOOKS.beds.onUpsert(db, data.id, afterRecord.ward_id, beforeItem, afterRecord, data, occupancyNow, postOccupancySource);
      WRITE_HOOKS.beds.finalize(db, occupancyNow);
    }

    // ディスク・メモリの管理：ログ・通話などの蓄積データテーブルの肥大化防止（自動トリム）
    if (table === 'import_logs') {
      trimTable(list, 100, 'import_logs');
    }
    // transfer_status_logsは外部からの直接POST/PATCH/DELETEを拒否しているため
    // (table === 'transfer_status_logs' && method !== 'GET' のガード)、ここには
    // 到達しない。トリムは pruneTransferStatusLogs() が各追記箇所で行う
    if (table === 'calls') {
      trimTable(list, 500, 'calls');
    }
    if (table === 'transfer_events') {
      trimTable(list, TRANSFER_EVENTS_MAX_ENTRIES, 'transfer_events');
    }
    if (table === 'handover_notes') {
      WRITE_HOOKS.handover_notes.finalize(db);
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
      const bulkTargetIds = new Set();
      for (const patchItem of bulkData) {
        const targetId = patchItem?.id;
        if (targetId == null) continue;
        const targetKey = String(targetId);
        if (bulkTargetIds.has(targetKey)) {
          return { success: false, conflict: true, message: '同じマスターを複数回更新する要求は処理できません。' };
        }
        bulkTargetIds.add(targetKey);
        const existing = list.find(item => String(item.id) === targetKey);
        if (existing) {
          const revisionError = checkMasterRevision(table, existing, patchItem);
          if (revisionError) return revisionError;
          const referenceError = validateMasterReferences(db, table, existing, patchItem);
          if (referenceError) return referenceError;
        }
      }
      if (table === 'transfer_events') {
        // current_statusの変更はstatus/update(processStatusUpdateRequest)の
        // 1経路に集約する(isExternalを問わない。理由は単体PATCH分岐と同じ)
        if (bulkData.some(patchItem => Object.prototype.hasOwnProperty.call(patchItem, 'current_status'))) {
          return { success: false, message: 'Use status/update for status changes' };
        }
        const simulated = list.map(item => ({ ...item }));
        for (const patchItem of bulkData) {
          const targetId = patchItem.id;
          const index = simulated.findIndex(x => String(x.id) === String(targetId));
          if (index === -1) continue;
          const before = simulated[index];
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
      const bulkOccupancyNow = Date.now();
      // Array.prototype.forEach ではコールバック内のreturnがforEach自身に対する
      // ものになり、processDbRequest本体へ伝播しない（＝revisionError/referenceError
      // をここでreturnしても呼び出し元には返らず握りつぶされる）。事前チェックループ
      // (上のfor...of)が同じ組み合わせを検証済みのため現状は到達しないはずだが、
      // 万一到達した場合に正しくエラーを返せるようfor...ofで統一する
      for (const patchItem of bulkData) {
        const targetId = patchItem.id;
        const occupancySource = patchItem._occupancySource;
        if (Object.prototype.hasOwnProperty.call(patchItem, '_occupancySource')) {
          delete patchItem._occupancySource;
        }
        const index = list.findIndex(x => String(x.id) === String(targetId));
        if (index !== -1) {
          const beforeSnap = JSON.parse(JSON.stringify(list[index]));
          const revisionError = applyMasterRevision(table, list[index], patchItem);
          if (revisionError) return revisionError;
          const referenceError = validateMasterReferences(db, table, beforeSnap, patchItem);
          if (referenceError) return referenceError;
          beforeItems.push(beforeSnap);
          list[index] = { ...list[index], ...patchItem };
          updatedItems.push(list[index]);
          if (table === 'beds') {
            WRITE_HOOKS.beds.onUpsert(db, targetId, list[index].ward_id, beforeSnap, list[index], patchItem, bulkOccupancyNow, occupancySource);
          }
        }
      }
      if (table === 'beds') {
        WRITE_HOOKS.beds.finalize(db, bulkOccupancyNow);
      }
      if (table === 'handover_notes') {
        WRITE_HOOKS.handover_notes.finalize(db);
      }
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
    const masterRevisionError = applyMasterRevision(table, list[index], data);
    if (masterRevisionError) return masterRevisionError;
    const referenceError = validateMasterReferences(db, table, list[index], data);
    if (referenceError) return referenceError;
    // current_statusの変更はstatus/update(processStatusUpdateRequest)の1経路に
    // 集約する(isExternalを問わない。理由は上のPOST-as-update分岐と同じ)
    if (
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
    // _occupancySourceは在室ログ用の内部ヒントであり、他のテーブルにも誤って
    // 送られた場合にレコード本体へ紛れ込まないよう、テーブルを問わず必ず除去する
    let occupancySource = null;
    if (Object.prototype.hasOwnProperty.call(data, '_occupancySource')) {
      occupancySource = data._occupancySource || null;
      delete data._occupancySource;
    }
    if (expectedStatus && list[index].current_status !== expectedStatus) {
      return statusMismatchConflictResponse(expectedStatus, list[index]);
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
    if (table === 'beds') {
      const occupancyNow = Date.now();
      WRITE_HOOKS.beds.onUpsert(db, id, list[index].ward_id, beforeItem, list[index], data, occupancyNow, occupancySource);
      WRITE_HOOKS.beds.finalize(db, occupancyNow);
    }
    if (table === 'handover_notes') {
      WRITE_HOOKS.handover_notes.finalize(db);
    }
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
    // 病棟は病床が残った状態で削除しない。renderer側の確認だけでは、
    // 別の子機が直前に病床を追加した競合を防げないため、親機DBで再確認する。
    if (table === 'wards') {
      const linkedBeds = (db.beds || []).filter(bed => String(bed.ward_id) === String(id));
      if (linkedBeds.length > 0) {
        return {
          success: false,
          conflict: true,
          message: `この病棟には${linkedBeds.length}件の病床が登録されています。病床を先に削除してください。`,
        };
      }
    }
    // 進行中の移送がある病床は削除しない。削除すると移送イベントのbed_idが宙に浮き、
    // 迎え要請が「病床不明」となって帰棟先を追えなくなる。病棟の削除と同様、
    // renderer側の確認だけでは他端末との競合を防げないため親機DBで再確認する。
    if (table === 'beds') {
      const activeEvents = (db.transfer_events || []).filter(event =>
        String(event.bed_id) === String(id) && ACTIVE_TRANSFER_STATUSES.has(event.current_status)
      );
      if (activeEvents.length > 0) {
        return {
          success: false,
          conflict: true,
          message: 'この病床には進行中の移送があります。帰棟またはキャンセルしてから削除してください。',
        };
      }
    }
    const removed = list.splice(index, 1)[0];
    if (table === 'beds') {
      const occupancyNow = Date.now();
      WRITE_HOOKS.beds.onDelete(db, id, occupancyNow);
      WRITE_HOOKS.beds.finalize(db, occupancyNow);
    }
    if (table === 'schedule_feeds') {
      // フィード個別のSMBパスワードはsystem_settings側にあるため、
      // フィードを消したら資格情報も残さない（親機・子機どちらの削除経路も通る）
      const settingId = feedSmbPasswordSettingId(id);
      if (Array.isArray(db.system_settings)) {
        db.system_settings = db.system_settings.filter(s => s.id !== settingId);
      }
    }
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
handleTrusted('db-request', async (event, { url, options }) => {
  // デバイス管理エンドポイント（DBを使わず親機メモリで処理）
  if (url === 'device/list') return { success: true, devices: getActiveDevices() };
  if (url === 'device/disconnect') {
    let info;
    try { info = JSON.parse((options && options.body) || '{}'); } catch { info = {}; }
    delete connectedDevices[info.deviceId];
    return { success: true };
  }
  const method = (options.method || 'GET').toUpperCase();
  const terminalRole = readTerminalRole()?.terminalRole || 'ward';
  if (url === 'audit/write') {
    return processAuditWriteRequest(method, options.body || '', false);
  }
  if (url === 'status/update') {
    return processStatusUpdateRequest(method, options.body || '', false, null, { terminalRole });
  }
  if (url === 'status/note') {
    return processStatusNoteRequest(method, options.body || '', false);
  }
  if (url === 'status/ack') {
    return processStatusAcknowledgeRequest(method, options.body || '', false, null, { terminalRole });
  }
  if (url === 'transfer/start') {
    return processTransferStartRequest(method, options.body || '', false, null, { terminalRole });
  }
  const result = await processDbRequest(method, url, options.body || '', false);
  syncTerminalRoleFromLocalDbRequest(url, method, options.body || '');
  return result;
});

// IPC通信でフロントからのWebRTCシグナリング操作を仲介する
handleTrusted('webrtc-request', async (event, { url, options }) => {
  const method = (options.method || 'GET').toUpperCase();
  return processWebrtcRequest(method, url, options.body || '');
});

// 子機から親機へのHTTPリクエストはmainプロセスで中継する。ただしrendererが
// 任意のLAN/ローカルサービスへ接続できないよう、設定済み親機のAPIだけに制限する。
const ALLOWED_PARENT_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_PARENT_HTTP_HEADERS = new Set(['content-type', 'x-api-token', 'x-terminal-role']);
const MAX_PARENT_REQUEST_BYTES = 1024 * 1024;
const MAX_PARENT_RESPONSE_BYTES = 5 * 1024 * 1024;

function isPrivateOrLoopbackIpv4(hostname) {
  const parts = String(hostname || '').split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function normalizeParentHttpRequest(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new Error('INVALID_REQUEST');
  }

  // 子機→親機への全リクエストが通る中継経路であり、read-onlyでshare_mode/parent_ipの
  // 2設定を読むだけのため、DB全体のディープコピーは不要
  const db = readDbShared();
  const shareMode = normalizeShareMode(getSettingRecord(db, 'share_mode')?.value);
  const configuredParentIp = String(getSettingRecord(db, 'parent_ip')?.value || '').trim();
  const allowedHosts = new Set();
  if (shareMode === 'parent') {
    allowedHosts.add('127.0.0.1');
    allowedHosts.add('localhost');
  } else if (configuredParentIp) {
    allowedHosts.add(configuredParentIp.toLowerCase());
  }

  let parsed;
  try {
    parsed = new URL(String(opts.url || ''));
  } catch {
    throw new Error('INVALID_URL');
  }
  const isConnectionTest = opts.purpose === 'connection-test';
  const isAllowedConnectionTest = (
    isConnectionTest &&
    isPrivateOrLoopbackIpv4(parsed.hostname) &&
    (parsed.pathname === '/api/tables/wards' || parsed.pathname === '/api/tables/beds')
  );
  const isConfiguredEndpoint = (
    allowedHosts.has(parsed.hostname.toLowerCase()) &&
    (parsed.pathname.startsWith('/api/') || parsed.pathname.startsWith('/updates/'))
  );
  if (
    parsed.protocol !== 'http:' ||
    parsed.port !== '3005' ||
    (!isConfiguredEndpoint && !isAllowedConnectionTest)
  ) {
    throw new Error('ENDPOINT_NOT_ALLOWED');
  }
  if (parsed.username || parsed.password) {
    throw new Error('ENDPOINT_NOT_ALLOWED');
  }

  const method = String(opts.method || 'GET').toUpperCase();
  if (!ALLOWED_PARENT_HTTP_METHODS.has(method)) {
    throw new Error('METHOD_NOT_ALLOWED');
  }
  if (isConnectionTest && method !== 'GET') {
    throw new Error('METHOD_NOT_ALLOWED');
  }

  const body = typeof opts.body === 'string' ? opts.body : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_PARENT_REQUEST_BYTES) {
    throw new Error('REQUEST_TOO_LARGE');
  }

  const headers = {};
  if (opts.headers && typeof opts.headers === 'object' && !Array.isArray(opts.headers)) {
    for (const [name, value] of Object.entries(opts.headers)) {
      const normalizedName = String(name).toLowerCase();
      if (!ALLOWED_PARENT_HTTP_HEADERS.has(normalizedName)) continue;
      if (typeof value !== 'string' || value.length > 1024) {
        throw new Error('INVALID_HEADER');
      }
      headers[normalizedName] = value;
    }
  }

  const requestedTimeout = Number(opts.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(Math.max(Math.trunc(requestedTimeout), 1000), 30000)
    : 8000;

  return { url: parsed, method, headers, body, timeoutMs };
}

function parentHttpRequest(opts) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let request;
    try {
      request = normalizeParentHttpRequest(opts);
    } catch (e) {
      finish({ ok: false, status: 0, error: e.message || 'INVALID_REQUEST' });
      return;
    }

    let req;
    try {
      req = http.request(request.url, {
        method: request.method,
        headers: request.headers,
        timeout: request.timeoutMs,
      }, (res) => {
        const chunks = [];
        let responseBytes = 0;
        res.on('data', (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > MAX_PARENT_RESPONSE_BYTES) {
            req.destroy(new Error('RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
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

    if (request.body) req.write(request.body);
    req.end();
  });
}

handleTrusted('parent-http-request', async (event, opts) => {
  return parentHttpRequest(opts);
});

// アプリバージョンを返す
handleTrusted('get-app-version', () => app.getVersion());
handleTrusted('get-hostname', () => os.hostname());
handleTrusted('get-passcode-status', () => getAdminPasscodeStatus());
handleTrusted('verify-admin-passcode', (event, passcode) => (
  verifyAdminPasscodeAttempt(passcode, 'local-renderer')
));
handleTrusted('set-admin-passcode', (event, passcode) => setAdminPasscode(passcode));
handleTrusted('get-terminal-api-token', () => getTerminalApiToken());
handleTrusted('set-terminal-api-token', (event, token) => setTerminalApiToken(token));
handleTrusted('get-terminal-role', () => ({
  success: true,
  terminalRole: normalizeTerminalRole(readTerminalRole()?.terminalRole),
}));
handleTrusted('set-terminal-role', (event, value) => {
  const current = readTerminalRole() || {};
  const db = readDB();
  const saved = writeTerminalRole({
    shareMode: current.shareMode || getSettingRecord(db, 'share_mode')?.value,
    parentIp: current.parentIp ?? getSettingRecord(db, 'parent_ip')?.value ?? '',
    terminalRole: value,
  });
  return saved
    ? { success: true, terminalRole: saved.terminalRole }
    : { success: false, message: '端末役割を保存できませんでした' };
});
handleTrusted('cleanup-event-retention', () => {
  const db = readDB();
  if (normalizeShareMode(getSettingRecord(db, 'share_mode')?.value) !== 'parent') {
    return { success: false, message: '親機でのみ実行できます' };
  }
  const removed = pruneExpiredTransferEventsFromDb(db);
  if (removed > 0 && !writeDB(db)) {
    return { success: false, message: 'クリーンアップ結果を保存できませんでした' };
  }
  return { success: true, removed };
});

// event_retention_days（既定"0"=無効）は設定しても管理者が上記ハンドラを
// 手動実行しない限り適用されないため、無期限に蓄積したtransfer_events/
// transfer_status_logsが各種ステータス取得エンドポイントの走査コストを
// 押し上げ続けてしまう。設定済みの場合のみ効果を持つ、24時間毎の自動実行を追加する。
const EVENT_RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  try {
    const db = readDB();
    if (normalizeShareMode(getSettingRecord(db, 'share_mode')?.value) !== 'parent') return;
    const removed = pruneExpiredTransferEventsFromDb(db);
    if (removed > 0) writeDB(db);
  } catch (err) {
    console.warn('[DB] 保持期間クリーンアップの自動実行に失敗:', err.message);
  }
}, EVENT_RETENTION_CHECK_INTERVAL_MS);

// ── 診断用デバッグログ ──
// パッケージ版（.exe）はターミナルが無くコンソール出力を確認できないため、
// 接続テスト等の失敗時にレンダラーから追記できる簡易ログファイルを用意する。
// ボタン一つでエクスプローラー/メモ帳から開けるようにし、DevTools操作を不要にする。
function getDebugLogPath() {
  return path.join(app.getPath('userData'), 'debug.log');
}

handleTrusted('append-debug-log', (event, line) => {
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

handleTrusted('open-debug-log', () => {
  const { shell } = require('electron');
  const logPath = getDebugLogPath();
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] (ログはまだありません)\n`, 'utf-8');
  }
  shell.openPath(logPath);
  return { success: true, path: logPath };
});

// フォルダ選択ダイアログ（スケジュール取り込みの監視フォルダ選択用）
handleTrusted('select-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '監視フォルダを選択',
  });
  if (canceled || !filePaths[0]) return null;
  const selected = filePaths[0];
  approvedCsvHeaderFolders.add(normalizeLocalFolderPath(selected));
  return selected;
});

// CSVのヘッダ行を読み取る（スケジュール取り込みの列マッピング補助用）
handleTrusted('read-csv-headers', async (event, request) => {
  const folderPath = typeof request === 'string' ? request : request?.folderPath;
  const encoding = typeof request === 'string' ? 'auto' : request?.encoding;
  if (!isApprovedCsvHeaderFolder(folderPath)) {
    return {
      success: false,
      ok: false,
      reason: 'not_approved',
      message: 'フォルダを選択ダイアログで選ぶか、スケジュール設定を保存してから読み込んでください。',
    };
  }
  // UNCフォルダの場合、そのフォルダを使うフィードの認証情報で接続してから読む
  const db = readDB();
  const ownerFeed = findFeedForFolder(db, folderPath);
  const credentials = ownerFeed ? readFeedSmbCredentials(db, ownerFeed) : readGlobalSmbCredentials(db);
  return readScheduleCsvHeaders(folderPath, encoding, credentials);
});

// 開発/本番モード判定 (インフラ #4: 環境分離)
handleTrusted('is-dev-mode', () => !app.isPackaged || process.env.NODE_ENV === 'development');



// IPC通信でアプリの再起動を実行する
handleTrusted('relaunch-app', () => {
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

function validateUpdateInfo(info) {
  if (!info || typeof info !== 'object') return false;
  if (!/^\d+\.\d+\.\d+$/.test(String(info.version || ''))) return false;
  const fileName = String(info.path || '');
  if (!fileName || fileName !== path.basename(fileName) || !fileName.toLowerCase().endsWith('.exe')) {
    return false;
  }
  return /^[A-Za-z0-9+/]{80,}={0,2}$/.test(String(info.sha512 || ''));
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

function getUpdateApiToken() {
  const db = readDB();
  const shareMode = normalizeShareMode(getSettingRecord(db, 'share_mode')?.value);
  if (shareMode === 'parent') return ensureApiToken();
  const terminalToken = getTerminalApiToken();
  if (!terminalToken.success || !terminalToken.token) {
    throw new Error('更新用APIトークンを取得できません');
  }
  return terminalToken.token;
}

function getUpdateRequestHeaders() {
  return { 'X-API-Token': getUpdateApiToken() };
}

function getUpdateRequestOptions(url, headers) {
  const requestOptions = { headers };
  if (String(url).startsWith('https:') && process.env.TRANSBOARD_UPDATE_CA_FILE) {
    const caPath = path.resolve(process.env.TRANSBOARD_UPDATE_CA_FILE);
    requestOptions.ca = fs.readFileSync(caPath);
  }
  return requestOptions;
}

function httpGetText(url, { timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const transport = String(url).startsWith('https:') ? https : http;
    const req = transport.get(url, getUpdateRequestOptions(url, headers), res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let totalBytes = 0;
      res.on('data', c => {
        totalBytes += c.length;
        if (totalBytes > 128 * 1024) {
          req.destroy(new Error('更新メタデータが大きすぎます'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('接続がタイムアウトしました')));
  });
}

// URLからファイルへストリーム保存しつつsha512(base64)を計算して返す
function downloadToFileWithHash(url, destPath, { timeoutMs = 300000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (error) => {
      try { fs.unlinkSync(destPath); } catch {}
      reject(error);
    };
    const transport = String(url).startsWith('https:') ? https : http;
    const req = transport.get(url, getUpdateRequestOptions(url, headers), res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const hash = crypto.createHash('sha512');
      const out = fs.createWriteStream(destPath);
      let totalBytes = 0;
      res.on('data', c => {
        totalBytes += c.length;
        if (totalBytes > 250 * 1024 * 1024) {
          req.destroy(new Error('更新ファイルが許容サイズを超えています'));
          out.destroy();
          return;
        }
        hash.update(c);
      });
      res.pipe(out);
      out.on('finish', () => resolve(hash.digest('base64')));
      out.on('error', fail);
      res.on('error', fail);
    });
    req.on('error', fail);
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

function verifyWindowsCodeSignature(filePath) {
  if (process.platform !== 'win32') {
    return { success: false, message: '更新署名の検証はWindowsでのみ実行できます' };
  }
  if (!EXPECTED_UPDATE_PUBLISHER && !EXPECTED_UPDATE_PUBLISHER_THUMBPRINT) {
    return {
      success: false,
      unsigned: true,
      message: '更新署名の発行者または証明書フィンガープリントが未設定です。管理者に連絡してください',
    };
  }

  const script = `
$ErrorActionPreference = 'Stop'
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRANSBOARD_SIGNATURE_PATH_B64))
$sig = Get-AuthenticodeSignature -LiteralPath $path
$name = if ($sig.SignerCertificate) {
  $sig.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
} else { '' }
$thumbprint = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { '' }
[PSCustomObject]@{ status = [string]$sig.Status; publisher = [string]$name; thumbprint = [string]$thumbprint } | ConvertTo-Json -Compress
`.trim();

  try {
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    const output = execFileSync(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          TRANSBOARD_SIGNATURE_PATH_B64: Buffer.from(filePath, 'utf8').toString('base64'),
        },
      }
    ).trim();
    const signature = JSON.parse(output);
    const publisherConfigured = Boolean(EXPECTED_UPDATE_PUBLISHER);
    const thumbprintConfigured = Boolean(EXPECTED_UPDATE_PUBLISHER_THUMBPRINT);
    const publisherMatches = !publisherConfigured || String(signature.publisher || '').localeCompare(
      EXPECTED_UPDATE_PUBLISHER,
      undefined,
      { sensitivity: 'accent' }
    ) === 0;
    const thumbprintMatches = !thumbprintConfigured ||
      String(signature.thumbprint || '').replace(/[^0-9a-f]/gi, '').toUpperCase() === EXPECTED_UPDATE_PUBLISHER_THUMBPRINT;
    if (signature.status !== 'Valid' || !publisherMatches || !thumbprintMatches) {
      return { success: false, message: '更新ファイルのデジタル署名を確認できませんでした' };
    }
    return {
      success: true,
      publisher: signature.publisher,
      thumbprint: signature.thumbprint,
      matchedBy: thumbprintConfigured ? 'thumbprint' : 'publisher'
    };
  } catch (error) {
    console.warn('[Updater] Authenticode検証に失敗:', error.message);
    return { success: false, message: '更新ファイルのデジタル署名検証に失敗しました' };
  }
}

// 未署名更新を「そもそも許可するか」のゆるいゲート。公開IPv4アドレスへの
// 平文HTTP（中間者攻撃を受けやすい典型例）だけを明確に拒否し、ホスト名
// （形式だけでは院内LANか公開ホストか判別できない）は通す。
// parent_ip は機器名・mDNS/WINS名等で運用されることもあり、ドット区切り
// IPv4の見た目チェックだけだと一律で拒否され、子機側で回復手段が無いまま
// 更新が永久にブロックされてしまう。ここを通過しても即座に無条件で
// 許可されるわけではなく、この先で人手のダイアログ確認（もしくは
// isStronglyTrustedUpdateSourceを満たす場合のみ子機の自動承認）を経る。
function isUnsignedUpdateSourceAllowed(feedBase) {
  if (!feedBase) return true;
  try {
    const source = new URL(feedBase);
    if (source.protocol === 'https:' ||
        source.hostname === 'localhost' ||
        isPrivateOrLoopbackIpv4(source.hostname)) {
      return true;
    }
    return !/^\d{1,3}(\.\d{1,3}){3}$/.test(source.hostname);
  } catch {
    return false;
  }
}

// 子機の自動承認に使う、より厳格な判定。HTTPS・localhost・プライベートIPv4
// アドレスなど「形式から明確に院内LAN/暗号化通信と分かるもの」のみを対象とし、
// ホスト名（parent_ipが機器名等で運用されているケース）はここでは対象外とする。
// ホスト名は文字列の形だけでは実際に院内LAN上のものか判別できないため
// （isUnsignedUpdateSourceAllowedで一律拒否はしないが）、子機であっても
// 人手のダイアログ確認を残す。これにより、子機の自動承認は「明確に安全な
// 経路」に限定しつつ、ホスト名運用の場合でも従来のように更新自体が
// 完全にブロックされることはない（人手で1回確認すれば通せる）。
function isStronglyTrustedUpdateSource(feedBase) {
  if (!feedBase) return true;
  try {
    const source = new URL(feedBase);
    return source.protocol === 'https:' ||
      source.hostname === 'localhost' ||
      isPrivateOrLoopbackIpv4(source.hostname);
  } catch {
    return false;
  }
}

async function confirmUnsignedUpdate({ version, fileName, sha512, feedBase = null, autoAcceptForChild = false } = {}) {
  if (!isUnsignedUpdateSourceAllowed(feedBase)) {
    return {
      accepted: false,
      message: '署名なし更新は院内LANまたはHTTPSの更新元からのみ許可されます',
    };
  }

  // 子機が親機から取得する更新ファイルは、親機側で取込時(import-update-files)に
  // 管理者が同じ確認ダイアログを既に一度通過しており、SHA-512整合性検証も
  // 呼び出し元で実施済みのため、子機ごとに同じ警告への再クリックを求めるのは
  // 実質的な安全性向上を伴わない手間であり、無人稼働中の子機で誤って
  // 「更新を中止」を押してしまう(＝更新が終わらない)主要因になっていた。
  // 子機ではこの人手による再確認を省略し、自動的に許可する。
  // ただし、この自動承認は isStronglyTrustedUpdateSource を満たす場合のみに
  // 限定する。parent_ipがホスト名で運用されている等、形式からは院内LANかを
  // 判別できないケースでは、子機であっても引き続き人手のダイアログ確認を求める
  // (isUnsignedUpdateSourceAllowed自体はホスト名も通すため、更新自体が完全に
  // ブロックされることはないが、無人での自動承認はしない)。
  if (autoAcceptForChild && isStronglyTrustedUpdateSource(feedBase)) {
    console.warn(`[Updater] 子機更新: 親機で検証済みの配布ファイルのため署名なし確認をスキップして続行します: v${version || '?'}`);
    return { accepted: true };
  }

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '署名なし更新の確認',
    buttons: ['更新を中止', '署名なしで続行'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: `v${version || '?'} の更新ファイルにコード署名がありません`,
    detail: [
      feedBase
        ? 'APIトークン認証とSHA-512整合性検証は実施済みです。'
        : '選択したlatest.ymlとインストーラーのSHA-512整合性検証は実施済みです。',
      '配布元とハッシュ値を管理者が確認した場合のみ続行してください。',
      `ファイル: ${fileName || '?'}`,
      `SHA-512: ${sha512 || '?'}`,
    ].join('\n'),
  });
  return result.response === 1
    ? { accepted: true }
    : { accepted: false, message: '署名なし更新はキャンセルされました' };
}

// 更新フィードURLの組み立て。子機はparentIp指定、親機は自分自身(ループバック)を参照
function buildUpdateFeedBase(parentIp) {
  const configuredBase = String(process.env.TRANSBOARD_UPDATE_BASE_URL || '').trim();
  if (configuredBase) {
    let parsed;
    try { parsed = new URL(configuredBase); } catch { throw new Error('更新URLの形式が不正です'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('更新URLの形式が不正です');
    }
    return parsed.href.replace(/\/+$/, '');
  }
  const db = readDB();
  const shareMode = normalizeShareMode(getSettingRecord(db, 'share_mode')?.value);
  const configuredParentIp = String(getSettingRecord(db, 'parent_ip')?.value || '').trim();
  const requestedHost = String(parentIp || '').trim();
  const host = shareMode === 'parent' ? '127.0.0.1' : configuredParentIp;
  if (!host || (requestedHost && requestedHost !== host)) {
    throw new Error('更新元の親機アドレスが設定と一致しません');
  }
  return `http://${host}:3005/updates`;
}

// 更新チェック: latest.yml を取得し現行バージョンと比較する
handleTrusted('check-for-update', async (event, { parentIp } = {}) => {
  try {
    const ymlText = await httpGetText(`${buildUpdateFeedBase(parentIp)}/latest.yml`, {
      headers: getUpdateRequestHeaders(),
    });
    const info = parseLatestYml(ymlText);
    if (!validateUpdateInfo(info)) {
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

// インストーラを直接spawnした直後にapp.quit()すると、旧exeのファイルロックが
// まだ解放されていないうちに新インストーラのサイレントアンインストール
// (electron-builder製NSISは旧バージョンを検出すると新規インストール前に
// 自動でこれを実行する)が走ってしまい、「古いアプリをアンインストールできません」
// という失敗の主因になっていた。app.quit()自体は非同期(before-quitでの
// HTTPサーバー停止・ウォッチャー停止等の後始末を含む)で、その所要時間は
// 接続端末数や状況によって変動するため、固定の待機時間では確実性が無い。
// PowerShellのWait-Processで自プロセス(PID)の実際の終了をポーリングし、
// それを確認してからインストーラを起動するラッパーを挟むことで、
// シャットダウン処理の所要時間に関わらずファイルロックの解放を待ってから
// インストーラが走るようにする(最大30秒待って、それでも終了しなければ
// 諦めて起動する。無期限にハングしないための安全弁)。
function spawnInstallerAfterOwnExit(installerPath) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$installerPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRANSBOARD_INSTALLER_PATH_B64))
$parentPid = [int]$env:TRANSBOARD_WAIT_PID
try { Wait-Process -Id $parentPid -Timeout 30 } catch {}
Start-Process -FilePath $installerPath -ArgumentList '/S' -WindowStyle Hidden
`.trim();
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(
    POWERSHELL_EXE,
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedCommand],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        TRANSBOARD_INSTALLER_PATH_B64: Buffer.from(installerPath, 'utf8').toString('base64'),
        TRANSBOARD_WAIT_PID: String(process.pid),
      },
    }
  );
  child.unref();
}

// 更新のダウンロード → sha512検証 → DB退避 → サイレントインストール起動
handleTrusted('download-and-install-update', async (event, { parentIp } = {}) => {
  try {
    const feedBase = buildUpdateFeedBase(parentIp);
    const shareMode = normalizeShareMode(getSettingRecord(readDB(), 'share_mode')?.value);
    const isChildTerminal = shareMode !== 'parent';
    const ymlText = await httpGetText(`${feedBase}/latest.yml`, {
      headers: getUpdateRequestHeaders(),
    });
    const info = parseLatestYml(ymlText);
    if (!validateUpdateInfo(info)) {
      return { success: false, message: 'latest.ymlの形式が不正です' };
    }
    if (compareVersions(info.version, app.getVersion()) <= 0) {
      return { success: false, message: '配信中のバージョンは現行より新しくありません' };
    }

    const tmpDir = path.join(app.getPath('temp'), 'transboard-update');
    fs.mkdirSync(tmpDir, { recursive: true });
    const installerPath = path.join(tmpDir, path.basename(info.path));
    const actualSha512 = await downloadToFileWithHash(
      `${feedBase}/${encodeURIComponent(path.basename(info.path))}`,
      installerPath,
      { headers: getUpdateRequestHeaders() }
    );

    if (actualSha512 !== info.sha512) {
      try { fs.unlinkSync(installerPath); } catch {}
      return { success: false, message: 'ダウンロードファイルの検証(sha512)に失敗しました。ファイルが破損しているか、改ざんされている可能性があります' };
    }

    const signatureResult = verifyWindowsCodeSignature(installerPath);
    if (!signatureResult.success) {
      if (!signatureResult.unsigned) {
        try { fs.unlinkSync(installerPath); } catch {}
        return signatureResult;
      }
      const unsignedConfirmation = await confirmUnsignedUpdate({
        version: info.version,
        fileName: info.path,
        sha512: info.sha512,
        feedBase,
        autoAcceptForChild: isChildTerminal,
      });
      if (!unsignedConfirmation.accepted) {
        try { fs.unlinkSync(installerPath); } catch {}
        return { success: false, message: unsignedConfirmation.message };
      }
      if (!isChildTerminal) {
        console.warn(`[Updater] 署名なし更新を管理者確認により許可: v${info.version}`);
      }
    }

    // 更新起因の万一の破損に備え、既存の.bakローリングとは別にDBを退避
    try {
      if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, `${DB_FILE}.before_update`);
    } catch (e) {
      console.warn('[Updater] 更新前バックアップに失敗:', e.message);
    }

    console.log(`[Updater] v${info.version} のインストールを開始します`);
    spawnInstallerAfterOwnExit(installerPath);
    app.quit();
    return { success: true, version: info.version };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// ── 親機の配信管理（取込・状況・ロールバック） ──

// updatesフォルダ内の配信状況を返す
handleTrusted('get-update-dist-info', () => {
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
handleTrusted('import-update-files', async () => {
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
    if (!validateUpdateInfo(info)) {
      return { success: false, message: 'latest.ymlの形式が不正です（version/path/sha512が必要）' };
    }
    if (path.basename(exeSrc) !== info.path) {
      return { success: false, message: 'latest.ymlに記載されたファイル名とインストーラ名が一致しません' };
    }

    // 壊れた・組み合わせ違いのファイルを配信しないよう、取込時点でsha512を照合
    const actualSha512 = await sha512OfFile(exeSrc);
    if (actualSha512 !== info.sha512) {
      return { success: false, message: 'インストーラとlatest.ymlのsha512が一致しません。ダウンロードし直すか、同じリリースの組み合わせか確認してください' };
    }
    const signatureResult = verifyWindowsCodeSignature(exeSrc);
    if (!signatureResult.success) {
      if (!signatureResult.unsigned) return signatureResult;
      const unsignedConfirmation = await confirmUnsignedUpdate({
        version: info.version,
        fileName: info.path,
        sha512: info.sha512,
      });
      if (!unsignedConfirmation.accepted) {
        return { success: false, message: unsignedConfirmation.message };
      }
      console.warn(`[Updater] 署名なし配信を管理者確認により許可: v${info.version}`);
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
handleTrusted('rollback-update-dist', () => {
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
  if (!feed.watch_dir) return { success: false, message: '監視フォルダが存在しません' };
  // 認証に失敗した場合は「フォルダが存在しません」ではなく実際の理由を返す
  const authResult = authenticateSMBSync(feed.watch_dir, readFeedSmbCredentials(db, feed));
  if (authResult && authResult.success === false) {
    return { success: false, message: authResult.message };
  }
  if (!fs.existsSync(feed.watch_dir)) {
    return { success: false, message: '監視フォルダが存在しません' };
  }
  // 取り込み完了を待たずに{success:true}を返すと、子機（親機アクション経由）
  // では「取り込みました」と表示された直後にまだ結果が反映されていない
  // ことがある。実際にCSVを読み終えるまで待ってから結果を返す
  const result = await scanAndImportScheduleFolder(feed.watch_dir, feed);
  return { success: result.success, count: result.importedCount, message: result.message || undefined };
}

function reloadScheduleFeedTriggersOnParent() {
  setupScheduleFeedTriggers();
  return { success: true, warnings: smbAuthWarnings.slice() };
}

// スケジュールフィードの手動取り込みとウォッチャー再起動
handleTrusted('trigger-schedule-feed-import', (event, feedId) => triggerScheduleFeedImportOnParent(feedId));

handleTrusted('reload-schedule-feed-triggers', () => reloadScheduleFeedTriggersOnParent());

// スタートアップ登録の取得・設定
handleTrusted('get-startup-setting', () => {
  const settings = app.getLoginItemSettings();
  return { openAtLogin: settings.openAtLogin };
});

handleTrusted('set-startup-setting', (event, { openAtLogin }) => {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(openAtLogin) });
    return { success: true, openAtLogin: Boolean(openAtLogin) };
  } catch (err) {
    console.error('[Startup] スタートアップ設定の変更に失敗しました:', err.message);
    return { success: false, message: err.message };
  }
});

// IPC通信でフルスクリーン表示を切り替える
handleTrusted('toggle-fullscreen', () => {
  if (mainWindow) {
    const isFS = mainWindow.isFullScreen();
    mainWindow.setFullScreen(!isFS);
    return !isFS;
  }
  return false;
});

// スクリーンセイバー・ディスプレイスリープを抑制する
handleTrusted('set-power-save', (event, prevent) => {
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
handleTrusted('set-always-on-top', (event, value) => {
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
function isExportRedactedSettingId(id) {
  return EXPORT_REDACTED_SETTING_IDS.includes(id) || isFeedSmbPasswordSettingId(id);
}
function redactCredentials(dbObj) {
  if (Array.isArray(dbObj.system_settings)) {
    dbObj.system_settings.forEach(s => {
      if (isExportRedactedSettingId(s.id) && s.value) {
        s.value = '[REDACTED]';
      }
    });
  }
  return dbObj;
}

// IPC通信でデータベースをバックアップファイルとして保存する
// mode: 'encrypted'（パスワード保護・患者情報含む・既定）| 'redacted'（平文だが患者情報・認証情報を除去）
handleTrusted('backup-db', async (event, { mode = 'encrypted', password = '' } = {}) => {
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
handleTrusted('restore-db', async (event, { password = '' } = {}) => {
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
    if (fs.statSync(filePath).size > MAX_BACKUP_FILE_BYTES) {
      return { success: false, message: 'バックアップファイルが大きすぎます（上限100MB）' };
    }
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
    // 監査ログ専用ファイルも同様に復元前の状態を保全する
    // (db.jsonと違い、リストア操作自体はこのファイルを直接上書きしないため、
    // 保全しておかないと復元後に反映したバックアップ内容で無条件に置き換わってしまう)
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      try {
        fs.copyFileSync(AUDIT_LOG_FILE, AUDIT_LOG_FILE + '.before_restore');
      } catch (bakErr) {
        console.warn('[AuditLog] 復元前バックアップの作成に失敗しました:', bakErr.message);
      }
    }
    // アトミックに上書きして復元する（自機のDB暗号化形式で保存）
    safeWriteFile(DB_FILE, encryptDbFileContent(plaintextJson));
    // リストアはDB全体を置き換える操作のため、バックアップにaudit_logsが
    // 埋め込まれていれば監査ログ専用ファイルも無条件に置き換える
    // (loadOrMigrateAuditLogsは「専用ファイルが無いときだけ移行」なので、
    // 既に専用ファイルがある通常運用でのリストアではこちらを使う必要がある)
    if (Array.isArray(parsed.audit_logs)) {
      rewriteAuditLogFile(parsed.audit_logs);
    }
    // writeDB()を経由しない直接書き込みのため、メモリキャッシュを無効化して次回読み込み時にディスクから再読込させる
    dbCache = null;
    dbCacheSignature = null;
    {
      const db = readDB();
      appendAuditLog(db, 'BACKUP_RESTORE', {
        targetType: 'database',
        targetId: path.basename(filePath),
        actorType: 'local_ui',
        details: { encrypted: fileContent.startsWith(BACKUP_ENCRYPTION_MAGIC), fileName: path.basename(filePath) },
      });
      writeDB(db);

      // 端末役割ファイル(terminal_role.json)を復元後のDBに同期する。ここで揃えないと、
      // 次回起動時に repairShareModeBeforeServerStart() が「復元前の役割」を正としてDBを
      // 上書きしてしまい、バックアップに含まれるshare_mode/parent_ipが復元直後の1回しか
      // 有効にならない（次回起動で静かに元へ戻る）落とし穴になる。
      const restoredShareMode = normalizeShareMode(getSettingRecord(db, 'share_mode')?.value);
      const restoredParentIp = String(getSettingRecord(db, 'parent_ip')?.value || '');
      writeTerminalRole({ shareMode: restoredShareMode, parentIp: restoredParentIp });
      // localStorageはメインプロセスから触れないため、復元後の役割をrendererへ返して
      // 再起動の前に cfg_share_mode / cfg_parent_ip を揃えてもらう。これが無いと
      // 「DBと役割ファイルは親機／localStorageは子機」のような食い違いが残り、
      // 3005で配信しつつ子機として振る舞う状態になる。
      return { success: true, shareMode: restoredShareMode, parentIp: restoredParentIp };
    }
  } catch (err) {
    console.error('[DB Restore Error]', err);
    return { success: false, message: err.message };
  }
});

// IPC通信で親機PC自身のローカルIPアドレス一覧を取得する
handleTrusted('get-local-ips', () => {
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
handleTrusted('get-database-storage-info', () => {
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
handleTrusted('get-archive-info', () => {
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
handleTrusted('get-db-info', () => {
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
handleTrusted('export-diagnostics-bundle', async () => {
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
  handleTrusted('get-encryption-status', () => {
    const available = !!(safeStorage && safeStorage.isEncryptionAvailable());
    let dbIsEncrypted = false;
    let dbExists = false;
    try {
      dbExists = fs.existsSync(DB_FILE);
      if (dbExists) {
      const head = Buffer.alloc(DB_ENCRYPTION_PREFIX.length);
      const fd = fs.openSync(DB_FILE, 'r');
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      dbIsEncrypted = head.toString('utf8') === DB_ENCRYPTION_PREFIX;
    }
  } catch {}
    return { available, dbIsEncrypted, dbExists };
  });

// IPC通信でデータベースの保存先設定を変更する
handleTrusted('change-database-storage-mode', async (event, mode) => {
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

const PASSCODE_SALT = 'transboard-passcode-v1';
const PASSCODE_MAX_ATTEMPTS = 5;
const PASSCODE_LOCKOUT_MS = 60 * 1000;
const passcodeAttempts = new Map();

function hashLegacyAdminPasscode(raw) {
  return `SHA256:${crypto.createHash('sha256')
    .update(`${String(raw)}${PASSCODE_SALT}`, 'utf8')
    .digest('hex')}`;
}

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getStoredAdminPasscode() {
  const db = readDB();
  return String(getSettingRecord(db, 'admin_passcode')?.value || '');
}

function isWeakAdminPasscode(raw) {
  const value = String(raw || '').trim();
  if (value.length < 6 || value.length > 128) return true;
  if (/^(\d)\1+$/.test(value)) return true;
  if (['000000', '111111', '123456', '654321', '12345678', 'password', 'passcode'].includes(value.toLowerCase())) {
    return true;
  }
  const digits = value.split('').map(character => Number(character));
  if (digits.every(number => Number.isInteger(number))) {
    const ascending = digits.every((number, index) => (
      index === 0 || number === digits[index - 1] + 1
    ));
    const descending = digits.every((number, index) => (
      index === 0 || number === digits[index - 1] - 1
    ));
    if (ascending || descending) return true;
  }
  return false;
}

function hashAdminPasscode(raw) {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(String(raw), salt, 64);
  return `SCRYPT:${salt.toString('base64')}:${derivedKey.toString('base64')}`;
}

function verifyStoredAdminPasscode(rawPasscode, stored) {
  if (stored.startsWith('SCRYPT:')) {
    const [, saltBase64, hashBase64, ...extra] = stored.split(':');
    if (!saltBase64 || !hashBase64 || extra.length > 0) return false;
    try {
      const salt = Buffer.from(saltBase64, 'base64');
      const expected = Buffer.from(hashBase64, 'base64');
      const actual = crypto.scryptSync(String(rawPasscode), salt, expected.length);
      return expected.length > 0 &&
        actual.length === expected.length &&
        crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  const candidate = stored.startsWith('SHA256:')
    ? hashLegacyAdminPasscode(rawPasscode)
    : String(rawPasscode);
  return timingSafeStringEqual(candidate, stored);
}

function getAdminPasscodeStatus() {
  const stored = getStoredAdminPasscode();
  const defaultHash = hashLegacyAdminPasscode('0000');
  return {
    success: true,
    requiresSetup:
      !stored ||
      stored === '0000' ||
      timingSafeStringEqual(stored, defaultHash) ||
      (!stored.startsWith('SCRYPT:') && !stored.startsWith('SHA256:') && isWeakAdminPasscode(stored)),
  };
}

function setAdminPasscode(rawPasscode) {
  const passcode = typeof rawPasscode === 'string' ? rawPasscode.trim() : '';
  if (isWeakAdminPasscode(passcode)) {
    return {
      success: false,
      message: 'パスコードは6文字以上で、連番・同一数字のみ・推測されやすい値は避けてください',
    };
  }

  const db = readDB();
  if (normalizeShareMode(getSettingRecord(db, 'share_mode')?.value) !== 'parent') {
    return { success: false, message: '管理者パスコードは親機でのみ変更できます' };
  }
  const record = getSettingRecord(db, 'admin_passcode');
  const newValue = hashAdminPasscode(passcode);
  if (record) record.value = newValue;
  else {
    db.system_settings = db.system_settings || [];
    db.system_settings.push({ id: 'admin_passcode', value: newValue });
  }
  appendAuditLog(db, 'UPDATE', {
    targetType: 'system_settings',
    targetId: 'admin_passcode',
    actorType: 'local_ui',
    before: { id: 'admin_passcode', value: '[changed]' },
    after: { id: 'admin_passcode', value: '[changed]' },
  });
  if (!writeDB(db)) {
    return { success: false, message: 'パスコードを保存できませんでした' };
  }
  passcodeAttempts.clear();
  return { success: true };
}

function verifyAdminPasscodeAttempt(rawPasscode, rateKey) {
  const passcode = typeof rawPasscode === 'string' ? rawPasscode : '';
  if (passcode.length > 128) {
    return { success: false, valid: false, message: 'Invalid passcode' };
  }

  const key = String(rateKey || 'unknown').slice(0, 160);
  const now = Date.now();
  const state = passcodeAttempts.get(key) || { attempts: 0, lockedUntil: 0 };
  if (state.lockedUntil > now) {
    return {
      success: false,
      valid: false,
      locked: true,
      retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
    };
  }

  const stored = getStoredAdminPasscode();
  const valid = Boolean(stored && verifyStoredAdminPasscode(passcode, stored));

  if (valid) {
    passcodeAttempts.delete(key);
    return { success: true, valid: true };
  }

  state.attempts += 1;
  if (state.attempts >= PASSCODE_MAX_ATTEMPTS) {
    state.attempts = 0;
    state.lockedUntil = now + PASSCODE_LOCKOUT_MS;
  }
  passcodeAttempts.set(key, state);
  return {
    success: true,
    valid: false,
    locked: state.lockedUntil > now,
    retryAfterSeconds: state.lockedUntil > now
      ? Math.ceil((state.lockedUntil - now) / 1000)
      : 0,
  };
}

// APIトークンの生成・確保（外部HTTP API全体のアクセス保護）
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

// 親機を識別するID。APIトークンは全機共通のため、別マシンが親機になっても
// 子機は何の警告もなくそちらへ接続してしまう。子機がこの値の変化を見て
// 「接続先の親機が入れ替わった」ことに気づけるようにする。
// 注: これは切り替わりの検知であって、同一LAN上に親機が同時に2台存在する
// 状態そのものの検知ではない（それにはmDNS等の探索が必要）。
function ensureParentInstanceId() {
  const db = readDB();
  const setting = getSettingRecord(db, 'parent_instance_id');
  if (setting && setting.value) return setting.value;

  const instanceId = crypto.randomBytes(16).toString('hex');
  if (setting) {
    setting.value = instanceId;
  } else {
    db.system_settings = db.system_settings || [];
    db.system_settings.push({ id: 'parent_instance_id', value: instanceId });
  }
  writeDB(db);
  console.log('[Server] 親機インスタンスIDを生成しました');
  return instanceId;
}

function isValidApiToken(apiToken) {
  // system_settingsの1レコードを読むだけで一切ミューテーションしないため、
  // DB全体をディープコピーするreadDB()ではなく非クローン版で十分。
  // isExternal経路では複数箇所(HTTPサーバー入口・処理内の冗長な再チェック・
  // 各ハンドラ)で毎リクエスト呼ばれるため、ここのクローンコストが
  // 子機ポーリング頻度×接続台数に比例して親機側に積み重なっていた。
  const db = readDbShared();
  const tokenSetting = (db.system_settings || []).find(s => s.id === 'api_token');
  const expectedToken = String(tokenSetting?.value || '');
  const receivedToken = typeof apiToken === 'string' ? apiToken : '';
  if (!expectedToken || !receivedToken) return false;
  const expected = Buffer.from(expectedToken, 'utf8');
  const received = Buffer.from(receivedToken, 'utf8');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
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
      const hasImportDirectory = Object.prototype.hasOwnProperty.call(settings, 'import_directory');
      // DBへ書き込む前に監視先を検証し、設定だけ保存されて監視が壊れる状態を防ぐ。
      let watchValidation = null;
      if (hasImportDirectory) {
        watchValidation = validateWatchDirectoryOnParent(String(settings.import_directory || ''), { isExternal: true });
        if (!watchValidation.success) return watchValidation;
      }
      const db = readDB();
      db.system_settings = db.system_settings || [];
      for (const [id, value] of Object.entries(settings)) {
        if (!allowed.has(id)) continue;
        // 子機は機密設定をマスク値で受け取る(GETのisBlockedSecret参照)。設定画面を
        // 開いて保存しただけでそのマスク値が送り返され、実際のパスワードを文字列
        // '********' で上書きしてしまうため、マスク値は「変更なし」として無視する。
        if (String(value ?? '') === MASKED_SECRET_VALUE) continue;
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
      if (!writeDB(db)) {
        return { success: false, message: '連携設定を保存できませんでした。' };
      }
      // 監視に影響しうる項目(import_directory以外にもimport_schedule・
      // import_connection_type・ODBC/SMB関連等)が部分的に送られてきた場合でも
      // 監視が古いままにならないよう、書き込み成功後は無条件で再読み込みする。
      // setupImportTrigger/setupScheduleFeedTriggersは冒頭で既存の監視を必ず
      // 停止してから張り直すため、変更が無かった場合でも安全な冪等操作である。
      setupImportTrigger();
      setupScheduleFeedTriggers();
      return { success: true };
    }
    case 'manual-import':
      return appendParentActionAudit(action, await triggerManualImportOnParent(), requestMeta);
    case 'update-watch-directory':
      return appendParentActionAudit(action, updateWatchDirectoryOnParent(payload.path || payload.newPath || '', { isExternal: true }), requestMeta);
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
    case 'schedule-feed-headers': {
      const requestedFolder = String(payload.folderPath || '').trim();
      const headerDb = readDB();
      const ownerFeed = findFeedForFolder(headerDb, requestedFolder);
      const result = ownerFeed
        ? readScheduleCsvHeaders(requestedFolder, payload.encoding, readFeedSmbCredentials(headerDb, ownerFeed))
        : { success: false, ok: false, reason: 'not_configured', message: '子機では監視フォルダを保存してからヘッダを読み込んでください。' };
      return appendParentActionAudit(action, result, requestMeta);
    }
    case 'save-schedule-feed-smb-password': {
      // フィード個別のSMBパスワードはsystem_settingsのフィード専用IDへ入るため、
      // 子機からは通常の書き込み経路(isWriteBlocked)で拒否される。ここを唯一の
      // 入口にして、実在するフィードのIDに対してのみ書き込む。
      const feedId = String(payload.feedId || '').trim();
      const passwordDb = readDB();
      if (!feedId || !(passwordDb.schedule_feeds || []).some(f => String(f.id) === feedId)) {
        return appendParentActionAudit(action, { success: false, message: 'フィードが見つかりません' }, requestMeta);
      }
      const settingId = feedSmbPasswordSettingId(feedId);
      const rawPassword = String(payload.password ?? '');
      passwordDb.system_settings = passwordDb.system_settings || [];
      if (rawPassword === MASKED_SECRET_VALUE) {
        // マスク値は「変更なし」。既存の値をそのまま残す
        return appendParentActionAudit(action, { success: true, unchanged: true }, requestMeta);
      }
      const existing = passwordDb.system_settings.find(s => s.id === settingId);
      if (rawPassword === '') {
        if (existing) passwordDb.system_settings = passwordDb.system_settings.filter(s => s.id !== settingId);
      } else if (existing) {
        existing.value = rawPassword;
      } else {
        passwordDb.system_settings.push({ id: settingId, value: rawPassword });
      }
      if (!writeDB(passwordDb)) {
        return appendParentActionAudit(action, { success: false, message: 'データベースの保存に失敗しました' }, requestMeta);
      }
      return appendParentActionAudit(action, { success: true }, requestMeta);
    }
    case 'reload-schedule-feed-triggers':
      return appendParentActionAudit(action, reloadScheduleFeedTriggersOnParent(), requestMeta);
    default:
      return { success: false, message: 'Unknown parent action' };
  }
}

// 親機としてのHTTP共有サーバー起動
let parentHttpServer = null;

// 共有サーバーを停止する。親機→子機へ切り替えたとき、再起動を促すだけでは
// 断られた場合に3005で配信を続けたまま子機として振る舞う（＝実質2台目の親機）
// ため、役割変更時にその場で閉じられる手段を用意する。
function stopParentServer() {
  if (!parentHttpServer) return { success: true, stopped: false };
  try { parentHttpServer.close(); } catch {}
  parentHttpServer = null;
  console.log('[Server] 共有サーバー（ポート3005）を停止しました');
  return { success: true, stopped: true };
}

function startParentServer() {
  if (parentHttpServer) return;
  ensureApiToken();
  ensureParentInstanceId();
  
  parentHttpServer = http.createServer((req, res) => {
    // CORSヘッダーを追加し、他のPC（子機）からの接続を許可
    // 子機はfile://から読み込まれ、Origin: null としてリクエストするためオリジン限定はできない。
    // 実質的なアクセス制御は、後段のAPIトークン検証で全/apiリクエストに対して行う。
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
      const updateToken = typeof req.headers['x-api-token'] === 'string'
        ? req.headers['x-api-token']
        : '';
      if (!isValidApiToken(updateToken)) {
        console.warn('[Security] 更新ファイル配信のAPIトークン認証失敗');
        sendJson(res, 401, { success: false, message: 'Unauthorized', unauthorized: true });
        return;
      }

      // ダウンロード側（download-and-install-update）はファイル名を
      // encodeURIComponentしてリクエストするため、ここでも対称にデコードする。
      // デコード後の文字列にパス区切りが混入し得るため、拡張子チェックだけでなく
      // 実際の解決先がupdatesDir配下に収まっていることも別途検証する。
      let fileName;
      try {
        fileName = decodeURIComponent(path.basename(req.url.split('?')[0]));
      } catch {
        sendJson(res, 404, { success: false, message: 'Update File Not Found' });
        return;
      }
      if (!/^(latest\.yml|.+\.(?:exe|blockmap))$/i.test(fileName)) {
        sendJson(res, 404, { success: false, message: 'Update File Not Found' });
        return;
      }
      const updatesDir = path.join(app.getPath('userData'), 'updates');
      const filePath = path.join(updatesDir, fileName);
      const updatesDirWithSep = path.resolve(updatesDir) + path.sep;
      if (!path.resolve(filePath).startsWith(updatesDirWithSep)) {
        sendJson(res, 404, { success: false, message: 'Update File Not Found' });
        return;
      }

      // updatesディレクトリが存在しない場合は作成
      if (!fs.existsSync(updatesDir)) {
        fs.mkdirSync(updatesDir, { recursive: true });
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        let contentType = 'application/octet-stream';
        if (fileName.endsWith('.yml')) contentType = 'text/yaml; charset=utf-8';
        else if (fileName.endsWith('.json')) contentType = 'application/json; charset=utf-8';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
        });
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

    // マスター、端末一覧、WebRTCを含む全APIを認証する。患者情報だけを保護すると、
    // 未認証端末から業務設定や表示内容を改変できるため、例外は設けない。
    const apiToken = typeof req.headers['x-api-token'] === 'string'
      ? req.headers['x-api-token']
      : '';
    if (!isValidApiToken(apiToken)) {
      console.warn(`[Security] APIトークン認証失敗: path=${cleanUrl.split('?')[0]}`);
      sendJson(res, 401, { success: false, message: 'Unauthorized', unauthorized: true });
      return;
    }
    
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
      sendJson(res, 413, { success: false, message: 'Request body too large' });
      return;
    }

    // リクエストボディの受信
    const bodyChunks = [];
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
      bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', async () => {
      if (bodyTooLarge) return;
      // Nodeのdataイベント境界はUTF-8文字境界を保証しないため、Bufferで結合してから一度だけ復号する。
      const body = Buffer.concat(bodyChunks).toString('utf8');
      try {
        let result;
        const remoteIp = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
        if (cleanUrl === 'auth/passcode-status' && req.method === 'GET') {
          result = getAdminPasscodeStatus();
        } else if (cleanUrl === 'auth/verify-passcode' && req.method === 'POST') {
          let payload;
          try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
          result = verifyAdminPasscodeAttempt(payload.passcode, `remote:${remoteIp}`);
        } else if (cleanUrl.startsWith('webrtc/')) {
          if (!isValidApiToken(req.headers['x-api-token'])) {
            console.warn('[Security] WebRTCシグナリングのAPIトークン認証失敗');
            result = { success: false, message: 'Unauthorized', unauthorized: true };
          } else {
            result = processWebrtcRequest(req.method, cleanUrl, body);
          }
        } else if (cleanUrl === 'audit/write') {
          result = processAuditWriteRequest(req.method, body, true, req.headers['x-api-token'], {
            remoteIp,
          });
        } else if (cleanUrl === 'status/update') {
          result = await processStatusUpdateRequest(req.method, body, true, req.headers['x-api-token'], {
            terminalRole: req.headers['x-terminal-role'],
          });
        } else if (cleanUrl === 'status/note') {
          result = processStatusNoteRequest(req.method, body, true, req.headers['x-api-token']);
        } else if (cleanUrl === 'status/ack') {
          result = processStatusAcknowledgeRequest(req.method, body, true, req.headers['x-api-token'], {
            remoteIp,
            terminalRole: req.headers['x-terminal-role'],
          });
        } else if (cleanUrl === 'transfer/start') {
          result = await processTransferStartRequest(req.method, body, true, req.headers['x-api-token'], {
            remoteIp,
            terminalRole: req.headers['x-terminal-role'],
          });
        } else if (cleanUrl.startsWith('parent-actions/')) {
          const action = cleanUrl.replace(/^parent-actions\//, '').split('?')[0];
          result = await processParentActionRequest(req.method, action, body, req.headers['x-api-token'], {
            remoteIp,
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
            // 認証は全端末共通のAPIトークン1個のみで、プロトコル上「どの子機か」を
            // 識別できない。そのためHTTP経由で許すと、任意の子機が他端末のdeviceIdを
            // 指定して一覧から消せてしまう（しかも消えた端末は約10秒後の
            // ハートビートで再登録されるだけで実効性も無い）。親機のUIからのみ行う。
            result = { success: false, message: '接続端末の切断は親機で行ってください' };
          } else {
            result = { success: false, message: 'Unknown device action' };
          }
        } else {
          // 外部からのHTTP APIリクエストのため isExternal = true
          result = await processDbRequest(req.method, cleanUrl, body, true, req.headers['x-api-token'], {
            remoteIp,
          });
        }
        res.writeHead(result && result.unauthorized ? 401 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[Parent Server Error]', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: 'Internal Server Error' }));
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
    stopNfcWatcher();
    if (currentWatcher) {
      try { currentWatcher.close(); } catch {}
      currentWatcher = null;
    }
    if (scheduleFeedRetryTimer) {
      clearTimeout(scheduleFeedRetryTimer);
      scheduleFeedRetryTimer = null;
    }
    stopParentServer();
    if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId);
      powerSaveBlockerId = null;
    }
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

  // 病床の更新が長期間発生しない環境でも保持期間が守られるよう、起動時に1回掃除する。
  // 実際に削除が発生したときだけ書き込む
  const prunedOccupancy = pruneBedOccupancyLogFromDb(db);
  const prunedEvents = shareMode === 'parent' ? pruneExpiredTransferEventsFromDb(db) : 0;
  if (prunedOccupancy > 0 || prunedEvents > 0) {
    console.log(`[DB Cleaner] Pruned ${prunedOccupancy} expired bed_occupancy_log entries at startup.`);
    console.log(`[DB Cleaner] Pruned ${prunedEvents} expired transfer_events entries at startup.`);
    writeDB(db);
  }

  const shareModeSetting = db.system_settings?.find(s => s.id === 'share_mode') || { value: shareMode };
  if (normalizeShareMode(shareModeSetting.value) !== 'client') {
    startParentServer();
  }

  if (isNfcWatcherEnabled(db)) {
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
  let shareMode = 'client';
  try {
    shareMode = normalizeShareMode(getSettingRecord(readDB(), 'share_mode')?.value);
  } catch (err) {
    console.error('[App] 終了時の設定読み込みに失敗しました:', err);
  }
  if (shareMode === 'parent') return;
  if (process.platform !== 'darwin') app.quit();
});
