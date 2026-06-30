const { app, BrowserWindow, ipcMain, safeStorage, Notification: ElectronNotification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const csv = require('csv-parser');
const http = require('http');
const os = require('os');
const { execSync, execFileSync, spawn } = require('child_process');

const { Readable } = require('stream');

let mainWindow;
let currentWatcher = null;
let currentWatchDir = null;
let nfcProcess = null;

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

let DB_FILE = getDBPath();

// WebRTCシグナリング用のメモリ内一時キュー
const webrtcSignalingQueue = {};

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
    { id: "room-ct", name: "CT室", code: "CT", floor: "1F", phone: "2001", is_active: true },
    { id: "room-mri", name: "MRI室", code: "MRI", floor: "1F", phone: "2002", is_active: true },
    { id: "room-xp", name: "X線室", code: "XP", floor: "2F", phone: "2010", is_active: true },
    { id: "room-endo", name: "内視鏡室", code: "ENDO", floor: "2F", phone: "2030", is_active: true },
    { id: "room-echo", name: "エコー室", code: "ECHO", floor: "2F", phone: "2020", is_active: true }
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
    { id: "notification_sounds", value: "{\"PICKUP_REQUIRED\":{\"enabled\":true,\"sound\":\"alarm\"},\"NEARLY_DONE\":{\"enabled\":true,\"sound\":\"chime\"},\"SOON\":{\"enabled\":true,\"sound\":\"chime\"},\"DEPART_REGISTERED\":{\"enabled\":false,\"sound\":\"ding\"},\"ARRIVED\":{\"enabled\":false,\"sound\":\"ding\"},\"RETURNED\":{\"enabled\":false,\"sound\":\"ding\"}}" },
    { id: "incoming_ring_sound", value: "ring" },
    { id: "share_mode", value: "parent" },
    { id: "parent_ip", value: "" },
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
    { id: "admission_mode", value: "csv" },
    { id: "notification_volume", value: "80" },
    { id: "notification_scan_sound", value: "true" },
    { id: "notification_mute", value: "{\"enabled\":false,\"start\":\"22:00\",\"end\":\"06:00\"}" },
    { id: "notification_import_toast", value: "true" },
    { id: "notification_os", value: "false" }
  ],
  transfer_events: [],
  transfer_status_logs: [],
  calls: [],
  import_logs: [],
  schedule_feeds: [],
  schedule_items: []
};

// センシティブな設定情報の暗号化リストと暗号・復号ヘルパー
const SENSITIVE_SETTING_IDS = ['odbc_connection_string', 'smb_password'];

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

// ローカルデータベース読み込み（重複防止の自動クリーンアップ機能付き）
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      console.log(`[DB] データベースが存在しないため初期データを書き込みます: ${DB_FILE}`);
      fs.writeFileSync(DB_FILE, JSON.stringify(SEEDS, null, 2), 'utf8');
      return SEEDS;
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    const db = JSON.parse(data);
    
    let hasDuplicates = false;
    let needsEncryptionRewrite = false;

    // 後方互換性：新規テーブル・新規設定項目のパッチ
    if (!db.import_logs) {
      db.import_logs = [];
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
    
    if (hasDuplicates || needsEncryptionRewrite) {
      console.log('[DB] 重複データ検出または暗号化適用のための再書き込みを実施します。');
      writeDB(db);
    }
    
    return db;
  } catch (err) {
    console.error('[DB] データベースの読み込み失敗:', err);
    return SEEDS;
  }
}

// ローカルデータベース書き込み
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

    const tmpFile = DB_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(dbClone, null, 2), 'utf8');
    try {
      fs.renameSync(tmpFile, DB_FILE);
    } catch (renameErr) {
      console.error('[DB] DBファイルのリネームに失敗しました。一時ファイルを削除します:', renameErr);
      try { fs.unlinkSync(tmpFile); } catch {}
      throw renameErr;
    }
  } catch (err) {
    console.error('[DB] データベースの書き込み失敗:', err);
  }
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
      nodeIntegration: false
    }
  });

  mainWindow.setMenu(null); // Hide file menu on Windows/Linux

  // Ctrl+Shift+I で開発者ツールを開く（デバッグ用）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key === 'I') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // マイク・カメラのパーミッション要求を明示的に許可
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('fullscreen-changed', true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('fullscreen-changed', false);
  });

  console.log(`[DB] ローカルデータベースファイルの場所: ${DB_FILE}`);
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
      ignored: [
        /(^|[\/\\])\../,
        '**/archive/**',
        '**/archive'
      ],
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
        ignored: [/(^|[\/\\])\./, '**/archive/**', '**/archive'],
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

// IPC通信で監視対象フォルダを動的に切り替える
ipcMain.handle('update-watch-directory', (event, newPath) => {
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
});

// IPC通信で手動でのフォルダスキャン・CSV取り込みを実行する
ipcMain.handle('trigger-manual-import', async () => {
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
});

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

// IPC通信でODBC接続経由でテーブル/ビュー一覧を取得する
ipcMain.handle('get-odbc-tables', async (event, { connectionString }) => {
  if (!connectionString) return { success: false, error: '接続文字列が指定されていません', tables: [] };
  const safe = String(connectionString).replace(/'/g, '').slice(0, 500);
  const ps = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Data
  $conn = New-Object System.Data.Odbc.OdbcConnection('${safe}')
  $conn.Open()
  $schema = $conn.GetSchema('Tables')
  $conn.Close()
  $items = $schema | Where-Object { $_.TABLE_TYPE -in @('TABLE','VIEW','SYSTEM TABLE') } |
    Select-Object @{N='name';E={$_.TABLE_NAME}}, @{N='type';E={$_.TABLE_TYPE}} |
    Sort-Object type, name
  $items | ConvertTo-Json -Compress
} catch {
  Write-Output "ERROR:$($_.Exception.Message)"
}`.trim();

  try {
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15000 }).trim();
    if (out.startsWith('ERROR:')) {
      return { success: false, error: out.slice(6), tables: [] };
    }
    const raw = JSON.parse(out);
    const tables = (Array.isArray(raw) ? raw : [raw]).map(r => ({ name: r.name, type: r.type }));
    return { success: true, tables };
  } catch (e) {
    return { success: false, error: e.message, tables: [] };
  }
});

// IPC通信でWindowsレジストリからシステム/ユーザーDSN一覧を取得する
ipcMain.handle('get-odbc-dsns', () => {
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
});

// IPC通信でODBCデータベース接続テストを行う（シミュレーション）
ipcMain.handle('test-odbc-connection', async (event, { connectionString, sqlQuery }) => {
  await new Promise(resolve => setTimeout(resolve, 1000));
  
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
  return { success: true, message: 'ODBCデータベース接続テストに成功しました。(接続先: ' + finalConnStr.split(';')[0] + ' [読み取り専用: 強制適用済])' };
});

// IPC通信でODBC直接同期を実行する（シミュレーション）
ipcMain.handle('run-odbc-sync', async (event, { connectionString, sqlQuery }) => {
  await new Promise(resolve => setTimeout(resolve, 1200));
  
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

  const db = readDB();
  const mappingSetting = db.system_settings?.find(s => s.id === 'import_mapping');
  let mapping = { bed_number: '', room_code: '', bed_code: '', join_char: '-', patient_id: '', patient_name: '', is_present: '' };
  if (mappingSetting && mappingSetting.value) {
    try { mapping = JSON.parse(mappingSetting.value); } catch(e) {}
  }
  
  const mapBed = mapping.bed_number || 'bed_number';
  const mapRoomCode = mapping.room_code || '';
  const mapBedCode = mapping.bed_code || '';
  const mapPatId = mapping.patient_id || 'patient_id';
  const mapPatName = mapping.patient_name || 'patient_name';
  const mapPresent = mapping.is_present || 'is_present';

  const mockRows = [];
  const japaneseNames = ['佐藤 健一', '鈴木 美紀', '高橋 浩', '田中 明美', '渡辺 恵子', '伊藤 淳', '山本 正史', '中村 幸子', '小林 茂', '加藤 陽子'];
  
  const beds = db.beds || [];
  beds.forEach((bed, index) => {
    const row = {};
    
    // Determine bed identification columns
    if (mapRoomCode && mapBedCode) {
      row[mapRoomCode] = bed.room_code || bed.room_number || '';
      row[mapBedCode] = bed.bed_code || '';
    } else {
      row[mapBed] = bed.bed_number || '';
    }
    
    // Generate occupied or empty status (70% occupied)
    const isOccupied = (index % 3 !== 0); 
    if (isOccupied) {
      row[mapPatId] = `P${100000 + index}`;
      row[mapPatName] = japaneseNames[index % japaneseNames.length];
      row[mapPresent] = '在床';
    } else {
      row[mapPatId] = '';
      row[mapPatName] = '空床';
      row[mapPresent] = '不在';
    }
    mockRows.push(row);
  });

  if (mainWindow) {
    mainWindow.webContents.send('data-imported', {
      fileName: 'ODBC DB Sync (Simulated - ReadOnly)',
      rows: mockRows
    });
  }
  
  return { success: true, count: mockRows.length };
});

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
      if (!to || typeof to !== 'string') return { success: false, message: 'Missing "to" field' };
      if (to === '__proto__' || to === 'constructor' || to === 'prototype') return { success: false, message: 'Invalid "to" field' };

      const msgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const entry = { msg: { ...msg, msgId }, timestamp: Date.now() };

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
    if (!id || id === '__proto__' || id === 'constructor' || id === 'prototype') return { success: false, message: 'Missing or invalid "id" parameter' };

    const now = Date.now();
    const EXPIRATION_MS = 30000;

    // ブロードキャストキュー：期限切れ除去のみ（消費しない）
    const bcKey = `bc:${id}`;
    if (webrtcSignalingQueue[bcKey]) {
      webrtcSignalingQueue[bcKey] = webrtcSignalingQueue[bcKey].filter(
        item => (now - item.timestamp) < EXPIRATION_MS
      );
    }
    const bcMessages = (webrtcSignalingQueue[bcKey] || []).map(item => item.msg);

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
  'calls', 'import_logs', 'schedule_feeds', 'schedule_items'
]);

// 共通のデータベース操作処理関数
async function processDbRequest(method, url, bodyStr, isExternal = false) {
  const db = readDB();

  // URL解析 (例: "tables/transfer_events?limit=200" や "tables/beds/bed-701")
  const cleanUrl = url.replace(/^\//, '').replace(/^tables\//, '');
  const urlParts = cleanUrl.split('?')[0].split('/');
  const table = urlParts[0];
  const id = urlParts[1];

  console.log(`[DB Request] ${method} tables/${table}${id ? '/' + id : ''}`);

  // テーブル名の許可リストチェック（不正テーブル名インジェクション防止）
  if (!ALLOWED_TABLES.has(table)) {
    console.warn(`[DB] 未許可のテーブル名へのアクセス: ${table}`);
    return { success: false, message: 'Not Found' };
  }

  // 外部(HTTP)からのアクセスに対するセキュリティ制限（機密データの保護）
  if (isExternal && table === 'system_settings') {
    // admin_passcode は子機の設定画面パスコード認証のため単体GETのみ許可する
    // ODBC接続文字列とSMBパスワードは単体GETも禁止
    const blockedSingleGet = ['odbc_connection_string', 'smb_password'];
    const blockedAll = ['odbc_connection_string', 'smb_password', 'admin_passcode'];

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
      // POST/PUT/PATCH/DELETE による機密設定の更新・削除を禁止
      if (id && blockedAll.includes(id)) {
        return { success: false, message: 'Forbidden' };
      }
      if (bodyStr) {
        try {
          const data = JSON.parse(bodyStr);
          if (Array.isArray(data)) {
            if (data.some(x => blockedAll.includes(x.id))) {
              return { success: false, message: 'Forbidden' };
            }
          } else {
            if (blockedAll.includes(data.id)) {
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
    if (!data.id) {
      data.id = `${table}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    }
    const index = list.findIndex(x => String(x.id) === String(data.id));
    if (index !== -1) {
      list[index] = { ...list[index], ...data };
      console.log(`[DB] POST (Update instead of duplicate): table=${table}, id=${data.id}`);
    } else {
      list.push(data);
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

    writeDB(db);
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
      const updatedItems = [];
      bulkData.forEach(patchItem => {
        const targetId = patchItem.id;
        const index = list.findIndex(x => String(x.id) === String(targetId));
        if (index !== -1) {
          list[index] = { ...list[index], ...patchItem };
          updatedItems.push(list[index]);
        }
      });
      writeDB(db);
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
    list[index] = { ...list[index], ...data };
    writeDB(db);
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
    writeDB(db);
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
  return processDbRequest(method, url, options.body || '', false);
});

// IPC通信でフロントからのWebRTCシグナリング操作を仲介する
ipcMain.handle('webrtc-request', async (event, { url, options }) => {
  const method = (options.method || 'GET').toUpperCase();
  return processWebrtcRequest(method, url, options.body || '');
});

// アプリバージョンを返す
ipcMain.handle('get-app-version', () => app.getVersion());

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

// スケジュールフィードの手動取り込みとウォッチャー再起動
ipcMain.handle('trigger-schedule-feed-import', async (event, feedId) => {
  const db = readDB();
  const feed = (db.schedule_feeds || []).find(f => f.id === feedId);
  if (!feed) return { success: false, message: 'フィードが見つかりません' };
  if (!feed.watch_dir || !fs.existsSync(feed.watch_dir)) {
    return { success: false, message: '監視フォルダが存在しません' };
  }
  scanAndImportScheduleFolder(feed.watch_dir, feed);
  return { success: true };
});

ipcMain.handle('reload-schedule-feed-triggers', () => {
  setupScheduleFeedTriggers();
  return { success: true };
});

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

// IPC通信でデータベースのバックアップファイルをエクスポートする
ipcMain.handle('backup-db', async () => {
  if (!mainWindow) return { success: false, message: 'Window not found' };
  const { dialog } = require('electron');
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'データベースバックアップの保存',
    defaultPath: `ward_dashboard_backup_${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  });
  if (!filePath) return { success: false, message: 'Cancelled' };
  try {
    const dbData = fs.readFileSync(DB_FILE, 'utf8');
    fs.writeFileSync(filePath, dbData, 'utf8');
    return { success: true, filePath };
  } catch (err) {
    console.error('[DB Backup Error]', err);
    return { success: false, message: err.message };
  }
});

// IPC通信でデータベースバックアップファイルから復元（リストア）する
ipcMain.handle('restore-db', async () => {
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
    const parsed = JSON.parse(fileContent);
    // バックアップファイルの整合性を検証（親機や別設定を壊さない工夫）
    if (!parsed.system_settings || !parsed.beds || !parsed.wards) {
      throw new Error('無効なバックアップファイルフォーマットです。');
    }
    fs.writeFileSync(DB_FILE, fileContent, 'utf8');
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

// IPC通信でデータベースの保存先設定を変更する
ipcMain.handle('change-database-storage-mode', async (event, mode) => {
  if (mode === 'common') {
    // 書き込み権限チェック
    try {
      if (!fs.existsSync(COMMON_DATA_DIR)) {
        fs.mkdirSync(COMMON_DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify({ mode: 'common' }, null, 2), 'utf8');
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
      fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify({ mode: 'user' }, null, 2), 'utf8');
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
const connectedDevices = {}; // { deviceId: { name, ip, mode, lastSeen, wardId } }
const DEVICE_TIMEOUT_MS = 30000; // 30秒無応答で切断扱い

function getActiveDevices() {
  const now = Date.now();
  return Object.values(connectedDevices).filter(d => (now - d.lastSeen) < DEVICE_TIMEOUT_MS);
}

// 親機としてのHTTP共有サーバー起動
let parentHttpServer = null;
function startParentServer() {
  if (parentHttpServer) return;
  
  parentHttpServer = http.createServer((req, res) => {
    // CORSヘッダーを追加し、他のPC（子機）からの接続を許可
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    
    // リクエストボディの受信
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        let result;
        if (cleanUrl.startsWith('webrtc/')) {
          result = processWebrtcRequest(req.method, cleanUrl, body);
        } else if (cleanUrl.startsWith('device/')) {
          const action = cleanUrl.replace(/^device\//, '').split('?')[0];
          if (action === 'heartbeat' && req.method === 'POST') {
            let info;
            try { info = JSON.parse(body || '{}'); } catch { info = {}; }
            const deviceId = info.deviceId;
            if (deviceId && typeof deviceId === 'string' && deviceId.length < 64) {
              const clientIp = req.socket?.remoteAddress || '';
              connectedDevices[deviceId] = {
                ...info,
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
          result = await processDbRequest(req.method, cleanUrl, body, true);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[Parent Server Error]', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

app.whenReady().then(() => {
  createWindow();
  setupImportTrigger();
  setupScheduleFeedTriggers();

  // ネットワーク共有モードに基づき、必要に応じて親機サーバーを起動
  const db = readDB();
  const shareModeSetting = db.system_settings?.find(s => s.id === 'share_mode') || { value: 'parent' };
  if (shareModeSetting.value !== 'client') {
    startParentServer();
  }

  const icSetting = db.system_settings?.find(s => s.id === 'enable_patient_ic_association');
  if (icSetting && icSetting.value === 'true') {
    startNfcWatcher();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(err => {
  console.error('[App] 起動中にエラーが発生しました:', err);
  dialog.showErrorBox('起動エラー', `アプリの起動に失敗しました。\n\n${err.message}`);
  app.quit();
});

} // end of gotTheLock else block

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
