const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const main = read('main.js');
const indexHtml = read('index.html');
const api = read('js/api.js');
const app = read('js/app.js');
const preload = read('preload.js');
const priority = read('js/priority.js');
const call = read('js/call.js');
const wizard = read('js/wizard.js');
const networkSettings = read('js/settings/network.js');
const importNotify = read('js/settings/import-notify.js');
const terminalAccess = read('js/settings/terminal-access.js');
const styles = read('css/style.css');
const modal = read('js/modal.js');

assert(!main.includes('LocalNetworkAccessChecks'), 'Chromium LNA protection must not be disabled');
assert(!/\bexecSync\s*\(/.test(main), 'Shell command strings must not use execSync');
assert(!call.includes('stun.l.google.com'), 'WebRTC must not depend on public STUN servers');
assert(
  indexHtml.includes("connect-src 'self'") &&
  !/connect-src[^;]*https?:\/\/\*/.test(indexHtml),
  'Renderer CSP must not allow arbitrary HTTP(S) connections'
);

const rawHandleCalls = main.match(/\bipcMain\.handle\s*\(/g) || [];
assert(
  rawHandleCalls.length === 1 && main.includes('function handleTrusted(channel, listener)'),
  'All IPC handlers must be registered through handleTrusted'
);

const updateVerifyIndex = main.indexOf('verifyWindowsCodeSignature(installerPath)');
const updateSpawnIndex = main.indexOf("spawn(installerPath, ['/S']");
assert(
  updateVerifyIndex >= 0 && updateSpawnIndex > updateVerifyIndex,
  'The updater must verify Authenticode before launching an installer'
);
assert(
  main.includes("[Security] 更新ファイル配信のAPIトークン認証失敗") &&
  main.includes('EXPECTED_UPDATE_PUBLISHER_THUMBPRINT') &&
  main.includes('signature.thumbprint') &&
  main.includes('confirmUnsignedUpdate') &&
  main.includes('isUnsignedUpdateSourceAllowed'),
  'Updates must use API authentication, hash verification, source restrictions, and explicit unsigned confirmation'
);
assert(
  !main.includes('[ScheduleFeed] "${feed.name}" CSVパース失敗'),
  'Main CSV import must not reference an out-of-scope schedule feed'
);

const apiAuthIndex = main.indexOf('if (!isValidApiToken(apiToken))');
const apiBodyIndex = main.indexOf("req.on('data'", apiAuthIndex);
assert(
  apiAuthIndex >= 0 && apiBodyIndex > apiAuthIndex,
  'The parent API must authenticate before accepting a request body'
);

assert(
  main.includes("'admin_passcode', 'api_token']") &&
  main.includes("cleanUrl === 'auth/verify-passcode'"),
  'Admin passcode hashes must stay on the parent'
);

assert(
  api.includes("'X-API-Token': apiToken") &&
  api.includes('/api/device/heartbeat') &&
  api.includes('/api/device/list'),
  'Device endpoints must send the API token'
);
assert(
  main.includes("handleTrusted('set-terminal-api-token'") &&
  main.includes('safeStorage.encryptString(token)') &&
  !wizard.includes("localStorage.setItem('cfg_api_token'") &&
  !networkSettings.includes("localStorage.setItem('cfg_api_token'"),
  'Terminal API tokens must be stored with safeStorage instead of localStorage'
);
assert(
  app.includes("headers: apiToken ? { 'X-API-Token': apiToken } : {}"),
  'Parent availability checks must authenticate after the API is locked down'
);
assert(
  main.includes("handleTrusted('complete-data-import'") &&
  preload.includes('completeDataImport') &&
  app.includes('completeDataImport({ importId, success: true })') &&
  !main.slice(main.indexOf('async function importCSV'), main.indexOf('function cleanOldArchives')).includes('archiveFile(filePath)'),
  'CSV originals must be archived only after renderer DB update acknowledgement'
);
assert(
  app.includes('startMasterSync()') &&
  app.includes("mode !== 'client' && mode !== 'child'") &&
  api.includes('ensureMutationSuccess'),
  'Child terminals must refresh shared masters and surface parent write failures'
);
assert(
  main.includes('processMasterBulkUpsert') &&
  main.includes('applyMasterRevision') &&
  main.includes("if (table === 'wards')") &&
  api.includes('bulkUpsert'),
  'Master imports must be validated and committed as one parent-side operation'
);
assert(
  app.includes('CallPanel._renderCallPanel()') &&
  importNotify.includes("shareMode === 'child'"),
  'Master sync and legacy child mode handling must remain wired'
);
assert(
  main.includes('function processStatusAcknowledgeRequest') &&
  main.includes("String(event.ward_id || '') !== wardId") &&
  main.includes('WARD_ACKNOWLEDGEMENT_STATUSES.has(log.to_status)') &&
  main.includes("cleanUrl === 'status/ack'") &&
  api.includes('acknowledgeStatusLog(logId, wardId)'),
  'Notification acknowledgements must remain authenticated, ward-scoped, and status-limited'
);

assert(
  priority.includes('UI.escapeHTML(examType.name)') &&
  priority.includes('UI.escapeHTML(examRoom.name)'),
  'Priority labels must be HTML-escaped'
);
assert(
  call.includes('errorMessage.textContent = String(message)'),
  'Call error messages must use textContent'
);
assert(
  wizard.includes('UI.escapeHTML(this.config.parent_ip)'),
  'Wizard network values must be HTML-escaped'
);
assert(
  importNotify.includes('UI.escapeHTML(l.fileName)') &&
  importNotify.includes('UI.escapeHTML(odbcConnSetting.value)'),
  'Import and ODBC values must be HTML-escaped'
);
assert(
  app.includes('API.verifyAdminPasscode(inputVal)') &&
  !app.includes("API.getOne('system_settings', 'admin_passcode')") &&
  !app.includes('PasscodeHash.hash(') &&
  !app.includes('requiredPasscode') &&
  main.includes('crypto.scryptSync') &&
  main.includes("handleTrusted('set-admin-passcode'"),
  'Renderer must not retrieve or generate stored passcode hashes'
);

assert(
  !networkSettings.includes('cfg-theme') &&
  !terminalAccess.includes('cfg-theme') &&
  !wizard.includes('wizard-theme') &&
  !wizard.includes("'theme_style'"),
  'Theme selection must not reappear in settings or the setup wizard'
);
assert(!styles.includes('body.theme-'), 'Legacy theme CSS selectors must not remain');
assert(
  !call.includes('webrtc-chat') &&
  !call.includes('appendChat') &&
  !call.includes("type: 'chat'"),
  'WebRTC chat UI and signaling must remain removed'
);
assert(
  !main.includes('show-os-notification') &&
  !preload.includes('showOsNotification') &&
  !app.includes('showOsNotification') &&
  !importNotify.includes('showOsNotification') &&
  !importNotify.includes('notification_os'),
  'Windows native toast notifications must remain removed'
);

// 患者取り違え・移送の取りこぼしにつながる3つのガード。いずれも processDbRequest や
// fs/chokidar に密結合した経路にあり実行ベースの単体テストが割に合わないため、
// ガードが消えていないことをソース上で担保する。
assert(
  main.includes("if (table === 'beds') {") &&
  /transfer_events[\s\S]{0,200}ACTIVE_TRANSFER_STATUSES[\s\S]{0,400}進行中の移送があります/.test(main),
  'Bed deletion must stay blocked while an active transfer references the bed'
);
assert(
  modal.includes('confirmPatientDischarge') &&
  modal.includes('getActiveEventForBed') &&
  !/if \(!confirm\(`\$\{bedLabel\}の患者/.test(modal),
  'Discharge must keep the active-transfer confirmation (both discharge entry points)'
);
assert(
  /results\.length > 0 && newItems\.length === 0/.test(main) &&
  main.indexOf('const newItems = []') < main.indexOf("db.schedule_items.filter(x => x.feed_id !== feed.id)"),
  'Schedule feed import must validate parsed rows before deleting existing items'
);
assert(
  app.includes('overwrittenActiveBeds') && app.includes('isSameOccupant'),
  'CSV import must warn when it overwrites a bed that has an in-flight transfer'
);

// 親機を別PCへ移す際、DB復元だけでは端末ロールファイル(terminal_role.json)が
// 更新されず、次回起動時にrepairShareModeBeforeServerStart()が復元前の役割で
// share_mode/parent_ipを静かに上書きしてしまう落とし穴を防ぐガード
assert(
  (() => {
    const idx = main.indexOf("handleTrusted('restore-db'");
    const end = main.indexOf("handleTrusted('get-database-storage-info'");
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    return body.includes('writeTerminalRole(') &&
      body.indexOf('writeTerminalRole(') > body.indexOf('appendAuditLog(db,');
  })(),
  'Restoring a DB backup must sync terminal_role.json to the restored share_mode/parent_ip'
);

// NFCリーダー未検出時、nfc-reader.ps1は即終了する。固定間隔の無条件再起動に
// 戻ると、リーダーが検出できない間PowerShellランタイム起動＋JITコンパイルの
// 重い処理を延々と繰り返しCPU負荷が高止まりするため、指数バックオフを保証する
assert(
  main.includes('nfcConsecutiveQuickExits') &&
  /const delay = Math\.min\(\s*NFC_RESTART_MAX_DELAY_MS,\s*NFC_RESTART_BASE_DELAY_MS\s*\*\s*Math\.pow\(2,\s*nfcConsecutiveQuickExits\)\s*\);[\s\S]{0,200}nfcRestartTimer = setTimeout\([\s\S]{0,100}\}, delay\);/.test(main) &&
  (() => {
    const idx = main.indexOf('function stopNfcWatcher');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < 0) return false;
    return main.slice(idx, end).includes('nfcConsecutiveQuickExits = 0');
  })(),
  'NFC watcher restarts must back off exponentially instead of retrying on a fixed interval'
);

console.log('Security regression checks passed.');
