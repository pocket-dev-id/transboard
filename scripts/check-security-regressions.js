const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ソース中の「NAME = {」または「NAME: {」で始まるオブジェクトリテラルを
// 波括弧の対応を数えて抽出し、安全にvmで評価してプレーンオブジェクトとして返す。
// 状態遷移表のようにクライアント/サーバーで独立に手書き複製されている定数を
// 比較する回帰ガードで使う
function extractObjectLiteral(src, marker) {
  const markerIdx = src.indexOf(marker);
  if (markerIdx < 0) throw new Error('marker not found: ' + marker);
  const braceStart = src.indexOf('{', markerIdx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        const literal = src.slice(braceStart, i + 1);
        const sandbox = { module: { exports: null } };
        vm.createContext(sandbox);
        vm.runInContext(`module.exports = ${literal};`, sandbox, { filename: 'extract-object-literal.js' });
        return sandbox.module.exports;
      }
    }
  }
  throw new Error('unbalanced braces for: ' + marker);
}

const main = read('main.js');
const config = read('js/config.js');
const indexHtml = read('index.html');
const api = read('js/api.js');
const app = read('js/app.js');
const preload = read('preload.js');
const priority = read('js/priority.js');
const call = read('js/call.js');
const bedmap = read('js/bedmap.js');
const timeline = read('js/timeline.js');
const wizard = read('js/wizard.js');
const networkSettings = read('js/settings/network.js');
const importNotify = read('js/settings/import-notify.js');
const terminalAccess = read('js/settings/terminal-access.js');
const statusCustomize = read('js/settings/status-customize.js');
const history = read('js/history.js');
const styles = read('css/style.css');
const modal = read('js/modal.js');
const carryover = read('js/carryover.js');
const maintenance = read('js/settings/maintenance.js');
const examroom = read('js/examroom.js');
const ui = read('js/ui.js');
const webrtcSignaling = read('main-modules/webrtc-signaling.js');
const devicePresence = read('js/device-presence.js');

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

const updateHandlerIdx = main.indexOf("handleTrusted('download-and-install-update'");
const updateVerifyIndex = main.indexOf('verifyWindowsCodeSignature(installerPath)', updateHandlerIdx);
const updateSpawnIndex = main.indexOf('spawnInstallerAfterOwnExit(installerPath)', updateHandlerIdx);
assert(
  updateHandlerIdx >= 0 && updateVerifyIndex >= 0 && updateSpawnIndex > updateVerifyIndex,
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
// 現行ビルドは未署名のため、親機自身の更新は毎回confirmUnsignedUpdateの
// ネイティブダイアログを経由する(main.js側。子機はautoAcceptForChildで
// このダイアログをスキップする、別項のガード参照)。親機向けの事前確認
// モーダルの説明文がこれに一切触れないと、予告なく現れたダイアログを
// ユーザーが反射的に「中止」してしまい「ダウンロードしたのに更新が
// 失敗する」体感を生む。事前に案内する文言(親機分岐)が後退していないことを保証する。
assert(
  (() => {
    const idx = app.indexOf('_promptInstallUpdate(info)');
    const end = app.indexOf('UI.toast(\'更新をダウンロードしています', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = app.slice(idx, end);
    return body.includes('署名なし') && body.includes('続行');
  })(),
  'The pre-download update confirmation must warn that a second native Windows dialog (unsigned-update confirmation) will follow for the parent terminal'
);

// 子機は親機から取得する更新ファイルについて、親機側の取込時(import-update-files)
// 管理者確認とSHA-512検証が既に済んでいるため、confirmUnsignedUpdateの
// ネイティブダイアログを自動承認でスキップしてよい。ただしこれは
// isUnsignedUpdateSourceAllowed(LAN/HTTPS制限)を満たす場合に限られ、
// SHA-512検証(呼び出し元)・署名検証そのものは一切省略しないことを保証する
// isUnsignedUpdateSourceAllowedはホスト名運用のparent_ipも通すため、子機の
// 無人自動承認をそのゲートだけに委ねると、形式上は院内LANかどうか判別できない
// ホスト名の配信元でも人手を介さず承認されてしまう。自動承認は
// isStronglyTrustedUpdateSource(HTTPS/localhost/プライベートIPv4のみ)を
// 満たす場合に限定し、ホスト名運用の場合は子機であっても引き続き
// ダイアログ確認を求める(更新自体がブロックされるわけではない)ことを保証する
assert(
  (() => {
    const idx = main.indexOf('async function confirmUnsignedUpdate({');
    const end = main.indexOf('const result = await dialog.showMessageBox', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    const allowedCheckIdx = body.indexOf('isUnsignedUpdateSourceAllowed(feedBase)');
    const autoAcceptIdx = body.indexOf('if (autoAcceptForChild && isStronglyTrustedUpdateSource(feedBase))');
    return allowedCheckIdx >= 0 && autoAcceptIdx > allowedCheckIdx &&
      body.includes('return { accepted: true };');
  })(),
  'confirmUnsignedUpdate must only auto-accept for child terminals when the source is strongly trusted (isStronglyTrustedUpdateSource), and must still show the native dialog otherwise'
);
assert(
  (() => {
    const idx = main.indexOf('function isStronglyTrustedUpdateSource(feedBase) {');
    if (idx < 0) return false;
    const end = main.indexOf('async function confirmUnsignedUpdate', idx);
    if (end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    // ホスト名(ドット区切りIPv4でない値)を許可する分岐が無いこと、
    // つまりisUnsignedUpdateSourceAllowedのようなホスト名フォールバックが
    // 混入していないことを確認する
    return body.includes("source.protocol === 'https:'") &&
      body.includes("source.hostname === 'localhost'") &&
      body.includes('isPrivateOrLoopbackIpv4(source.hostname)') &&
      !body.includes('dotted-IPv4') &&
      !/return\s*!\s*\/\^/.test(body);
  })(),
  'isStronglyTrustedUpdateSource must only accept https/localhost/private-IPv4 sources, without the hostname fallback used by isUnsignedUpdateSourceAllowed'
);
assert(
  (() => {
    const idx = main.indexOf("handleTrusted('download-and-install-update'");
    const end = main.indexOf("handleTrusted('get-update-dist-info'", idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    return body.includes('autoAcceptForChild: isChildTerminal') &&
      /shareMode\s*!==\s*'parent'/.test(body);
  })(),
  'The download-and-install-update handler must pass autoAcceptForChild based on whether the terminal is a child (share_mode !== parent)'
);
// isUnsignedUpdateSourceAllowedは公開IPv4リテラルへの平文HTTPは引き続き拒否しつつ、
// parent_ipがホスト名(mDNS/WINS名等)で運用されるケースを新たに許可する。
// ドット区切りIPv4形式の判定自体が失われていないことを保証する
assert(
  (() => {
    const idx = main.indexOf('function isUnsignedUpdateSourceAllowed(feedBase) {');
    const end = main.indexOf('async function confirmUnsignedUpdate', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    return body.includes('\\d{1,3}(\\.\\d{1,3}){3}');
  })(),
  'isUnsignedUpdateSourceAllowed must still reject plain-HTTP dotted-IPv4 literals that are not private/loopback'
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
  main.includes('function normalizeTerminalRole(value)') &&
  main.includes('検査室端末では移送を開始できません') &&
  main.includes('検査室端末では病棟側の状態操作はできません') &&
  main.includes('検査室端末では病棟通知を確認できません') &&
  main.includes("handleTrusted('set-terminal-role'") &&
  preload.includes("setTerminalRole: (role) => ipcRenderer.invoke('set-terminal-role', role)"),
  'Exam terminals must have a persisted role and must not use ward transfer or acknowledgement operations'
);
assert(
  app.includes("localStorage.getItem('cfg_terminal_role') === 'exam'") &&
  app.includes("document.body.classList.toggle('exam-terminal-mode', exam)") &&
  app.includes("API.getWardStatusEvents(wardId, todayMs)") &&
  app.includes("Promise.resolve({ activeEvents: [], todayEvents: [], recentStatusLogs: [] })") &&
  api.includes("'X-Terminal-Role': terminalRole") &&
  terminalAccess.includes("name=\"terminal-role\"") &&
  wizard.includes("name=\"terminal_role\"") &&
  styles.includes('body.exam-terminal-mode .ward-selector'),
  'Exam terminal mode must hide ward selection, avoid ward notification polling, and propagate the role to the parent'
);

assert(
  examroom.includes("this._eventWardById = new Map(relevant.map(event => [String(event.id), String(event.ward_id || '')]))") &&
  examroom.includes("const wardId = this._eventWardById?.get(String(btn.dataset.eventId || '')) || ''") &&
  examroom.includes('String(w.id) === wardId') &&
  !examroom.includes('AppState.wards.find(w => w.id === AppState.currentWardId)'),
  'Exam-room ward calls must target the event ward rather than the currently selected ward'
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
  main.includes('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8') &&
  main.includes('$OutputEncoding = [System.Text.Encoding]::UTF8'),
  'ODBC PowerShell output must be emitted as UTF-8 for Japanese errors and table names'
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

// ステータス遷移はmainプロセスの検証を必ず通し、クライアント入力の
// maintenanceフラグで通常ルールを迂回できないようにする。
const statusUpdateIndex = main.indexOf('async function processStatusUpdateRequest');
const statusUpdateEnd = main.indexOf('\nfunction processStatusNoteRequest', statusUpdateIndex);
assert(statusUpdateIndex >= 0 && statusUpdateEnd > statusUpdateIndex, 'Status update handler must remain present');
const statusUpdateBody = main.slice(statusUpdateIndex, statusUpdateEnd);
assert(
  statusUpdateBody.includes('Unknown status:') &&
  statusUpdateBody.includes('isScopedTransferStatusTransitionAllowed') &&
  !statusUpdateBody.includes('payload.maintenance') &&
  !statusUpdateBody.includes('maintenanceComplete'),
  'Status updates must reject unknown states and must not bypass transition validation via a client maintenance flag'
);
assert(
  main.includes("const statusActor = isExternal") &&
  main.includes("? 'child_api'") &&
  main.includes("['ic_scan', 'maintenance'].includes(payload.source)") &&
  main.includes('changed_by: statusActor') &&
  main.includes('actorType: statusActor'),
  'Status history must preserve trusted local operation sources while forcing external requests to child_api'
);
assert(
  main.includes("hidden.has('ARRIVED')") &&
  !api.includes('maintenance: true'),
  'Arrival/exam-start integration must be conditional and the removed maintenance payload must not be sent'
);
assert(
  (() => {
    const idx = config.indexOf('getAllowedActions(status, scope = \'ward\') {');
    const end = config.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = config.slice(idx, end);
    return body.includes('for (const hiddenStatus of this.HIDEABLE_STATUSES)') &&
      body.includes("source[hiddenStatus] || []");
  })(),
  'Renderer action availability must expand hidden-status actions (ARRIVED and NEARLY_DONE) generically via HIDEABLE_STATUSES, not just ARRIVED, or hiding "あと10分" leaves its button visible'
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
  (() => {
    const idx = main.indexOf('function commitScheduleFeedImport(feed, parsedFiles)');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    const guardIdx = body.indexOf('totalRowCount > 0 && allItems.length === 0');
    const filterIdx = body.indexOf("db.schedule_items.filter(x => x.feed_id !== feed.id)");
    return guardIdx >= 0 && filterIdx > guardIdx;
  })(),
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

// readDbShared()/readDB()はJSON往復クローンではなくstructuredCloneを使い続ける必要がある
// （DBが肥大化した運用でメインプロセスのCPU負荷が高止まりするため）。
// readDB()はreadDbShared()の結果をstructuredCloneで包むだけの薄いラッパーであることも保証する
// （書き込み系がキャッシュと共有しない専用コピーを受け取れなくなる回帰を防ぐ）。
assert(
  (() => {
    const sharedStart = main.indexOf('function readDbShared()');
    const sharedEnd = main.indexOf('function readDB()');
    const readEnd = main.indexOf('function writeDB(');
    const writeEnd = main.indexOf('function getSettingRecord(');
    if (sharedStart < 0 || sharedEnd < 0 || readEnd < 0 || writeEnd < 0 ||
        sharedEnd <= sharedStart || readEnd <= sharedEnd || writeEnd <= readEnd) return false;
    const sharedBody = main.slice(sharedStart, sharedEnd);
    const readBody = main.slice(sharedEnd, readEnd);
    const writeBody = main.slice(readEnd, writeEnd);
    const hasJsonRoundTripClone = /JSON\.parse\(JSON\.stringify\((dbCache|db|data|recovered)\)\)/.test(sharedBody) ||
      /JSON\.parse\(JSON\.stringify\((dbCache|db|data|recovered)\)\)/.test(writeBody);
    return !hasJsonRoundTripClone &&
      sharedBody.includes('structuredClone(db)') &&
      readBody.includes('structuredClone(readDbShared())') &&
      writeBody.includes('structuredClone(dbWithoutAuditLogs)');
  })(),
  'readDB/writeDB must deep-clone the whole DB with structuredClone, not a JSON.stringify/parse round trip (this cost scales with DB size and is paid on every poll from every terminal)'
);

// audit_logsはdb.jsonから分離し、専用ファイル(AUDIT_LOG_FILE)へ永続化することで、
// writeDB()の毎回のstringify/クローンコストから外している。writeDB()が
// audit_logs/_pendingAuditLogEntriesをdb.json書き込み対象から除外し続けることを
// 保証する。ここが崩れると、audit_logsが再びdb.json経由の全件書き直しに戻る。
assert(
  (() => {
    const writeStart = main.indexOf('function writeDB(');
    const writeEnd = main.indexOf('function getSettingRecord(');
    if (writeStart < 0 || writeEnd < 0 || writeEnd <= writeStart) return false;
    const writeBody = main.slice(writeStart, writeEnd);

    return writeBody.includes('const { audit_logs, _pendingAuditLogEntries, ...dbWithoutAuditLogs } = data;') &&
      writeBody.includes('JSON.stringify(dbForDisk)') &&
      !/JSON\.stringify\(dbForDisk\)[\s\S]{0,80}audit_logs/.test(writeBody);
  })(),
  'writeDB must exclude audit_logs and _pendingAuditLogEntries from the db.json payload, or audit_logs bloats every DB write again'
);

// 監査ログの専用ファイルへの永続化は、対応するDB書き込み(safeWriteFile)が
// 実際に成功した後にだけ行う必要がある。appendAuditLog()の時点で即座に
// ファイルへ書いてしまうと、その後writeDB()が失敗(署名不一致等)して実際の
// 変更が破棄されても、「成功した」と主張する監査エントリだけが残ってしまう
// (=起きなかった変更を成功として記録する、意味的に誤った監査証跡になる)。
// appendAuditLogは保留リストに積むだけにし、writeDBがsafeWriteFile成功後に
// フラッシュすることを保証する。
assert(
  (() => {
    const appendStart = main.indexOf('function appendAuditLog(db, action, {');
    const appendEnd = main.indexOf('function appendParentActionAudit(');
    if (appendStart < 0 || appendEnd < 0 || appendEnd <= appendStart) return false;
    const appendBody = main.slice(appendStart, appendEnd);

    const writeStart = main.indexOf('function writeDB(');
    const writeEnd = main.indexOf('function getSettingRecord(');
    if (writeStart < 0 || writeEnd < 0 || writeEnd <= writeStart) return false;
    const writeBody = main.slice(writeStart, writeEnd);

    const safeWriteIdx = writeBody.indexOf('safeWriteFile(DB_FILE, encryptDbFileContent(JSON.stringify(dbForDisk)));');
    const flushIdx = writeBody.indexOf('appendAuditLogFile(entry)');

    return !appendBody.includes('appendAuditLogFile(entry)') &&
      appendBody.includes('db._pendingAuditLogEntries') &&
      appendBody.indexOf('db.audit_logs.push(entry)') < appendBody.indexOf('db._pendingAuditLogEntries.push(entry)') &&
      safeWriteIdx >= 0 && flushIdx >= 0 && safeWriteIdx < flushIdx;
  })(),
  'appendAuditLog must only queue entries in _pendingAuditLogEntries (not write them immediately), and writeDB must flush them via appendAuditLogFile only after safeWriteFile succeeds, or a failed DB write can leave a misleading audit-log entry claiming success for a change that was never persisted'
);

// readDbShared()はキャッシュヒット時にdbCacheをディープコピーせず直接返す
// （高頻度ポーリングでDB全体のstructuredCloneを繰り返すコストを避けるため）。
// GET専用アクセサに戻り値のクローンが復活すると、5台・5病棟規模で
// 親機のCPU負荷が飽和する回帰につながるため、キャッシュヒット経路が
// 参照をそのまま返すことを保証する。
assert(
  (() => {
    const sharedStart = main.indexOf('function readDbShared()');
    const sharedEnd = main.indexOf('function readDB()');
    if (sharedStart < 0 || sharedEnd < 0 || sharedEnd <= sharedStart) return false;
    const sharedBody = main.slice(sharedStart, sharedEnd);
    return sharedBody.includes('return dbCache;') &&
      !sharedBody.includes('return structuredClone(dbCache)');
  })(),
  'readDbShared() cache-hit path must return dbCache directly without structuredClone, or GET polling from every terminal pays a full DB clone again'
);

// processDbRequestはGET(読み取り専用)のときだけクローンしないreadDbShared()を使い、
// 書き込み系メソッドは従来どおりreadDB()で専用のディープコピーを取得する必要がある。
// GET経路が誤ってreadDB()に戻ると、5台・5病棟規模のポーリング負荷で
// 親機のCPU負荷が飽和する回帰につながる。
assert(
  (() => {
    const idx = main.indexOf('async function processDbRequest(');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < 0) return false;
    const body = main.slice(idx, end);
    return /const db = method === 'GET' \? readDbShared\(\) : readDB\(\);/.test(body) &&
      /if \(!db\[table\] && method !== 'GET'\) \{/.test(body);
  })(),
  'processDbRequest must use readDbShared() (no full-DB clone) for GET and must not mutate db[table] on the GET path, which may share the live dbCache object'
);

// normalizeParentHttpRequestは子機→親機への全リクエストが通る中継経路で、
// share_mode/parent_ipの2設定を読むだけの読み取り専用処理。readDB()に戻ると
// このリクエストのたびにDB全体をディープコピーすることになる
assert(
  (() => {
    const idx = main.indexOf('function normalizeParentHttpRequest(');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < 0) return false;
    const body = main.slice(idx, end);
    return body.includes('const db = readDbShared();') && !body.includes('const db = readDB();');
  })(),
  'normalizeParentHttpRequest must use readDbShared() (no full-DB clone) since it only reads share_mode/parent_ip on every parent-relayed request'
);

// 監査ログの圧縮(閾値超過時のrewriteAuditLogFile、writeDB内に移設済み)は、
// このプロセスのメモリ上のaudit_logsだけを正として書き換えると、共有DBフォルダ
// 運用で他プロセスが既に専用ファイルへ追記済みのエントリをサイレントに消して
// しまう。圧縮前にloadAuditLogFile()でディスクの最新内容を読み直し、
// mergeAuditLogEntriesでマージしてから間引くことを保証する。
assert(
  (() => {
    const idx = main.indexOf('function writeDB(');
    const end = main.indexOf('function getSettingRecord(');
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    const compactIdx = body.indexOf('AUDIT_LOG_COMPACT_THRESHOLD');
    if (compactIdx < 0) return false;
    const compactBody = body.slice(compactIdx);
    return compactBody.includes('mergeAuditLogEntries(audit_logs, loadAuditLogFile())');
  })(),
  'writeDB must merge with the on-disk audit log file (loadAuditLogFile + mergeAuditLogEntries) before compacting, or entries appended by another process sharing the same DB folder can be silently lost'
);

// loadMasters()のstaffs取得(getAllStaffs)は、単発の一時的な失敗でwards/beds等を
// 含むマスタ読み込み全体を失敗させてはならない。.catch()で吸収し、
// 前回ロード分(AppState.allStaffs/staffs)へフォールバックすることを保証する。
assert(
  (() => {
    const idx = app.indexOf('async loadMasters(');
    const end = app.indexOf('\n  async ', idx + 10);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = app.slice(idx, end);
    return body.includes('API.getAllStaffs().catch(() => null)') &&
      body.includes('if (Array.isArray(allStaffs)) {') &&
      body.includes('AppState.allStaffs = AppState.allStaffs || [];');
  })(),
  'loadMasters() must catch getAllStaffs() failures and fall back to the previous AppState.allStaffs/staffs instead of letting the whole Promise.all (wards/beds/examRooms/etc.) reject on a single transient staff-fetch failure'
);

// transfer_status_logsは進行中イベント(ACTIVE_TRANSFER_STATUSES)のログを保護せずに
// 古い順一律で間引くと、5病棟規模の運用で監査証跡が数日で失われ、
// ward-status/exam-room-status表示が参照する進行中イベントの直近ログも
// 消えかねない。完了済みイベントのログだけを間引く設計を維持することを保証する。
assert(
  (() => {
    const idx = main.indexOf('function pruneTransferStatusLogs(');
    const end = main.indexOf('\nfunction pruneHandoverNotes(');
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    return body.includes('ACTIVE_TRANSFER_STATUSES.has(event.current_status)') &&
      body.includes('!activeEventIds.has(String(log.transfer_event_id))') &&
      !/^\s*trimTable\(db\.transfer_status_logs/m.test(body);
  })(),
  'pruneTransferStatusLogs must protect logs belonging to in-progress transfer events instead of trimming the table with a plain oldest-first cutoff'
);

// event_retention_daysは既定"0"(無効)のため、transfer_eventsは長期運用で
// TRANSFER_EVENTS_MAX_ENTRIES(安全弁)まで肥大化しうる。CSVインポート時の
// 病床競合チェックが全件取得のままだと、MAX_PARENT_RESPONSE_BYTES(5MB)超過で
// 子機のインポートが恒久的に失敗する。active_onlyフィルタで進行中イベントだけに
// 絞って取得することを保証する。
assert(
  (() => {
    const idx = main.indexOf("if (table === 'transfer_events') {", main.indexOf('async function processDbRequest'));
    const end = main.indexOf('return { data: filtered };', idx);
    if (idx < 0 || end < 0) return false;
    const body = main.slice(idx, end);
    return body.includes("searchParams.get('active_only') === 'true'") &&
      body.includes('!activeOnly || ACTIVE_TRANSFER_STATUSES.has(event.current_status)') &&
      app.includes("API.getAll('transfer_events', { active_only: 'true' })");
  })(),
  'processDbRequest must support transfer_events?active_only=true and the CSV-import active-bed check must use it, or the parent response can exceed MAX_PARENT_RESPONSE_BYTES once transfer_events grows unbounded'
);

// download-and-install-updateはインストーラ名をencodeURIComponentしてリクエストする
// (electron-builderの既定命名"TransBoard Setup <version>.exe"はスペースを含む)。
// 配信側の/updates/ルートがdecodeURIComponentしないと、スペース入りファイル名の
// 配信が常にHTTP 404になる。decodeURIComponent追加時にパストラバーサルを防ぐ
// updatesDir containmentチェックも併せて保証する。
assert(
  (() => {
    const idx = main.indexOf("req.url.startsWith('/updates/')");
    const end = main.indexOf('// "/api/"で始まるリクエストのみ処理');
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    return body.includes('decodeURIComponent(path.basename(') &&
      /path\.resolve\(filePath\)\.startsWith\(updatesDirWithSep\)/.test(body) &&
      body.indexOf('decodeURIComponent(path.basename(') < body.indexOf('const filePath = path.join(updatesDir, fileName)');
  })(),
  'The /updates/ static file route must decodeURIComponent the requested filename (symmetric with the encodeURIComponent on the download side) and verify the resolved path stays within updatesDir'
);

// writeDB()は書き込みのたびに呼ばれるため、暗号化前提で可読性の意味が薄い
// pretty-print(インデント付きJSON.stringify)へ戻ると無駄なCPUコストが復活する
assert(
  !/JSON\.stringify\(dbForDisk,\s*null,\s*2\)/.test(main) &&
  main.includes('JSON.stringify(dbForDisk)'),
  'writeDB must write compact JSON, not a pretty-printed (indented) JSON.stringify'
);

// writeDB()は以前、system_settingsの暗号化のためだけにDB全体を
// structuredCloneしていた（書き込みごとに2回のフルクローン）。system_settings
// 配列だけを部分コピーすれば十分なため、暗号化用の全体クローンが復活していない
// ことを保証する（この最適化はDBが肥大化するほど効く）。
assert(
  (() => {
    const writeStart = main.indexOf('function writeDB(');
    const writeEnd = main.indexOf('function getSettingRecord(');
    if (writeStart < 0 || writeEnd < 0 || writeEnd <= writeStart) return false;
    const writeBody = main.slice(writeStart, writeEnd);
    const structuredCloneCalls = writeBody.match(/structuredClone\(/g) || [];
    return structuredCloneCalls.length === 1 &&
      writeBody.includes('structuredClone(dbWithoutAuditLogs)') &&
      writeBody.includes('system_settings: dbWithoutAuditLogs.system_settings.map(');
  })(),
  'writeDB must not deep-clone the whole DB a second time just to encrypt system_settings; only the settings array should be copied'
);

// event_retention_daysは管理者が手動実行しない限り適用されず、放置すると
// transfer_events/transfer_status_logsが無期限に蓄積してステータス取得
// エンドポイントの走査コストが増え続ける。24時間毎の自動クリーンアップが
// 存在することを保証する。
assert(
  main.includes('EVENT_RETENTION_CHECK_INTERVAL_MS') &&
  main.includes('pruneExpiredTransferEventsFromDb(db)') &&
  /setInterval\(\(\) => \{[\s\S]{0,400}pruneExpiredTransferEventsFromDb\(db\)/.test(main),
  'A periodic (daily) automatic cleanup of expired transfer events must exist so event_retention_days takes effect without manual action'
);

// exam-room-statusは以前、対象診察室に無関係なログも含めtransfer_status_logs
// 全件をソートしてから絞り込んでいた(O(N log N) full sort)。対象診察室の
// イベントに絞り込んでからソートするよう順序が戻っていないことを保証する。
assert(
  (() => {
    const idx = main.indexOf("id === 'exam-room-status'");
    const end = main.indexOf("if (id) {", idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    const filterIdx = body.indexOf('.filter(log => scopedEventById.has(');
    const sortIdx = body.indexOf('.sort((a, b) => Number(b.changed_at');
    return filterIdx >= 0 && sortIdx >= 0 && filterIdx < sortIdx;
  })(),
  'exam-room-status must filter transfer_status_logs down to the requested exam room before sorting, not sort the entire table first'
);

// 30秒間隔の_uiRefreshTimerは病棟ダッシュボード専用のDOM(病床マップ・優先度
// パネル)を対象にしており、他ページ表示中に無条件で呼ぶのは無駄なCPU消費に
// なる。ward-dashboard表示中のみ実行するガードを保証する
assert(
  (() => {
    const idx = app.indexOf('_uiRefreshTimer = setInterval');
    const end = app.indexOf('}, 30000);');
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = app.slice(idx, end);
    return body.includes("currentPage === 'ward-dashboard'") &&
      body.indexOf("currentPage === 'ward-dashboard'") < body.indexOf('Priority.renderKpi()');
  })(),
  '_uiRefreshTimer must only re-render dashboard-only panels while the ward-dashboard tab is active'
);

// 5秒間隔ポーリングは毎tickで病床マップ全体・優先度一覧を無条件に再構築して
// おり、DBが肥大化するほど無駄な再描画コストが積み上がる。取得データが
// 前回描画時と同一なら重い再描画をスキップしつつ、BedMap.updateTimers()による
// 時刻依存表示の更新だけは毎tick必ず行うことを保証する（さもないと残り時間・
// 遅延判定の表示が固まって見える）
assert(
  app.includes('renderIfChanged(signature)') &&
  app.includes('renderIfChanged(this._dashboardDataSignature())') &&
  (() => {
    const idx = app.indexOf('renderIfChanged(signature)');
    const end = app.indexOf('this.render();', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    return app.slice(idx, end).includes('BedMap.updateTimers();');
  })() &&
  /FULL_RENDER_FALLBACK_MS/.test(app),
  'The ward-dashboard poll-tick render must skip the expensive full re-render only when data is unchanged, always keep BedMap.updateTimers() ticking, and force a periodic fallback re-render'
);

// 親機疎通の失敗はポーリング(5秒)・ハートビート(10秒)・ParentServerMonitor(30秒)の
// 3系統が独立に検知して_setConnectionStatus(false, ...)を呼ぶ。単発の失敗で
// 即座にバナーを出す実装に戻ると、瞬間的な遅延だけで頻繁に点滅してしまうため、
// 連続2回のシグナルを要求するデバウンスを保証する
assert(
  (() => {
    const idx = app.indexOf('_setConnectionStatus(ok, reason');
    const end = app.indexOf("if (ok === !this._connectionLost", idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = app.slice(idx, end);
    return body.includes('_disconnectSignalCount = 0') &&
      /_disconnectSignalCount \+= 1;\s*\n\s*if \(this\._disconnectSignalCount < 2\) return;/.test(body);
  })(),
  '_setConnectionStatus must debounce new disconnect signals (require 2 consecutive failures) instead of showing the banner on a single transient failure'
);

// 病床マップエディタで列・行を減らしたとき、範囲外になったセルを_grid.cellsに
// 残したままにすると、その病床は「配置済み」扱いのままエディタにもダッシュボードにも
// 表示されず（どちらも c < cols / r < rows でしか描画しない）、パレットにも戻らないため
// 二度と再配置できなくなる。縮小時とエディタ起動時の両方で範囲外セルを取り除き、
// 該当病床を未配置へ戻すことを保証する
const masters = read('js/settings/masters.js');
assert(
  (() => {
    const idx = masters.indexOf('_pruneOutOfRangeCells()');
    if (idx < 0) return false;
    const end = masters.indexOf('_bedsOutsideRange', idx);
    if (end < 0 || end <= idx) return false;
    const body = masters.slice(idx, end);
    // 範囲外判定と、病床を未配置へ戻す処理の両方が必要
    return body.includes('col < g.cols && row < g.rows') &&
      body.includes('bed.map_col = null') &&
      body.includes('delete g.cells[key]');
  })() &&
  // 縮小ボタンは範囲外セルを刈る_resizeGrid経由でなければならない
  /map-size-down-col'\)\.onclick\s*=\s*\(\)\s*=>\s*this\._resizeGrid\(/.test(masters) &&
  /map-size-down-row'\)\.onclick\s*=\s*\(\)\s*=>\s*this\._resizeGrid\(/.test(masters) &&
  masters.includes('this._pruneOutOfRangeCells();\n    this._drawMapEditor();') &&
  // 既存データ救済: エディタ起動時にも刈る
  masters.includes('const recovered = this._pruneOutOfRangeCells();'),
  'The bed map editor must drop out-of-range cells (on shrink and on open) and return those beds to the unplaced palette, otherwise they become permanently unreachable'
);

// パレットの「未配置」判定はグリッドの実状態を基準にする必要がある。map_colだけを
// 見ていると、レイアウトJSON(system_settings)と病床マスタがずれた病床（範囲外に
// 取り残された等）がパレットにもグリッドにも現れず、再配置できなくなる。
// これは保存時にmap_colをnullにする条件(_saveMapLayout)とも一致していなければならない
assert(
  (() => {
    const idx = masters.indexOf('_drawPalette()');
    if (idx < 0) return false;
    const end = masters.indexOf('unplaced.length === 0', idx);
    if (end < 0 || end <= idx) return false;
    const body = masters.slice(idx, end);
    return body.includes('placedBedIds') && body.includes('!placedBedIds.has(b.id)');
  })(),
  '_drawPalette must derive "unplaced" from the current grid cells, not from bed.map_col alone'
);

// 通話パネルの病棟発信ボタン一覧は「自分自身の病棟」(CallPanel.getMyId() =
// AppState.currentWardId)を除外して描画するため、病棟セレクトで切り替えても
// CallPanel._renderCallPanel()を呼び直さないと除外対象が古いままになり、
// 切り替え後の病棟が電話ボタンに反映されない
assert(
  (() => {
    const marker = "document.getElementById('ward-select').addEventListener('change', async (e) => {";
    const idx = app.indexOf(marker);
    if (idx < 0) return false;
    const bodyStart = app.indexOf('{', idx + marker.length - 1);
    let depth = 0, end = -1;
    for (let i = bodyStart; i < app.length; i++) {
      if (app[i] === '{') depth++;
      else if (app[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return false;
    const body = app.slice(bodyStart, end + 1);
    const assignIdx = body.indexOf('AppState.currentWardId = e.target.value;');
    const renderIdx = body.indexOf('CallPanel._renderCallPanel()');
    return assignIdx >= 0 && renderIdx > assignIdx;
  })(),
  'The ward-select change handler must re-render CallPanel after updating AppState.currentWardId, otherwise the call panel keeps excluding the previous ward instead of the newly selected one'
);

// 病棟マスタの追加・改名・削除は syncWardSelect() 経由(masters.js の
// ward作成/更新/削除ハンドラが呼ぶ)で #ward-select には反映されるが、
// 通話パネルの病棟発信ボタン一覧は描画時にAppState.wardsのスナップショットを
// DOMへ固定するため、syncWardSelect自身がCallPanelを再描画しないと
// 削除済み病棟がボタンに残り続け、新規/改名した病棟は反映されない
assert(
  (() => {
    const idx = app.indexOf('syncWardSelect() {');
    if (idx < 0) return false;
    const end = app.indexOf('async loadMasters(', idx);
    if (end < 0 || end <= idx) return false;
    const body = app.slice(idx, end);
    return body.includes('CallPanel._renderCallPanel()');
  })(),
  'syncWardSelect() must re-render CallPanel so ward master changes (add/rename/delete) propagate to the call panel button list, not just to the #ward-select dropdown'
);

// スケジュール取り込みCSVの時刻列は現場ごとに区切り文字が : ： . と
// 混在するため、parseScheduleDatetimeMsの時刻部分は3種いずれも許容し、
// 秒も任意で拾えることを保証する(hh.mm.ss形式のみ通せなくなる退行を防ぐ)
assert(
  (() => {
    const idx = main.indexOf('function parseScheduleDatetimeMs(dateStr, timeStr) {');
    if (idx < 0) return false;
    const constIdx = main.indexOf('const SCHEDULE_TIME_RE_SRC');
    if (constIdx < 0 || constIdx > idx) return false;
    const timeReLine = main.slice(constIdx, main.indexOf('\n', constIdx));
    return /\[.*：.*:.*\.\s*\]/.test(timeReLine) &&
      main.slice(idx).includes('SCHEDULE_TIME_RE_SRC');
  })(),
  'parseScheduleDatetimeMs must accept :, ：, and . as the time separator (e.g. hh.mm.ss) via SCHEDULE_TIME_RE_SRC'
);

// JavaScriptのDateコンストラクタは範囲外の値(2月31日→3月3日、25時→翌日1時等)
// を拒否せず自動的に繰り上げるため、range検証だけでなく構築後の値を入力値と
// 突き合わせて食い違いを検出しなければ、CSVの入力ミスが取り込みエラーになら
// ず全く別の日時の予定として黙って取り込まれてしまう
assert(
  (() => {
    const idx = main.indexOf('function buildValidatedScheduleDateMs(y, mo, dy, h, mi, se) {');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('mo >= 1 && mo <= 12') &&
      body.includes('dy >= 1 && dy <= 31') &&
      body.includes('h >= 0 && h <= 23') &&
      body.includes('mi >= 0 && mi <= 59') &&
      body.includes('se >= 0 && se <= 59') &&
      body.includes('d.getFullYear() !== y') &&
      body.includes('d.getMonth() !== mo - 1') &&
      body.includes('d.getDate() !== dy');
  })(),
  'buildValidatedScheduleDateMs must range-check the numeric components AND re-verify the constructed Date against the input (getFullYear/getMonth/getDate/...), or an out-of-range value like Feb 31 silently rolls over to Mar 3 and gets imported as a different, wrong date'
);
assert(
  (() => {
    const idx = main.indexOf('function parseScheduleDatetimeMs(dateStr, timeStr) {');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return !body.includes('new Date(combined)') &&
      body.includes('buildValidatedScheduleDateMs(');
  })(),
  'parseScheduleDatetimeMs must not trust a bare `new Date(combined)` parse of the raw CSV string (V8 silently rolls a day-of-month overflow like "2026-02-31" into a valid-looking "2026-03-03"); it must route every match through buildValidatedScheduleDateMs instead'
);

// インストーラをspawnした直後に固定時間(setTimeout)でapp.quit()すると、
// 旧exeのファイルロックがまだ解放されていないうちに新インストーラの
// サイレントアンインストール(electron-builder製NSISが旧バージョン検出時に
// 自動実行)が走り、「古いアプリをアンインストールできません」という
// 失敗の原因になる。spawnInstallerAfterOwnExitがPowerShellのWait-Processで
// 自プロセスの実際の終了を待ってからインストーラを起動することを保証する
assert(
  (() => {
    const idx = main.indexOf('function spawnInstallerAfterOwnExit(installerPath) {');
    if (idx < 0) return false;
    const end = main.indexOf('handleTrusted(\'download-and-install-update\'', idx);
    if (end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    const waitIdx = body.indexOf('Wait-Process');
    const startIdx = body.indexOf('Start-Process');
    return waitIdx >= 0 && startIdx > waitIdx &&
      body.includes('TRANSBOARD_WAIT_PID') &&
      body.includes('process.pid') &&
      body.includes("detached: true");
  })(),
  'spawnInstallerAfterOwnExit must wait for this process to actually exit (Wait-Process on its own PID) before launching the installer'
);
assert(
  !main.includes('setTimeout(() => app.quit(), 500)'),
  'The updater must not rely on a fixed 500ms delay before quitting; the installer launch must be sequenced after this process actually exits'
);

// 病床マップの配置保存(_saveMapLayout)は、以前は病床ごとに独立したPATCH
// リクエストをPromise.allで並列送信しており、親機側では各リクエストが個別に
// DB全体を読み書きするため実質的に直列化し、病床数が多い病棟では合計の
// 所要時間が伸びてリクエストタイムアウト(8秒)を超え、子機からの保存が
// 失敗・画面が固まる不具合の原因になっていた。1回のbulkPatchにまとめる
// ことで、親機側のDB書き込みが1回のリクエストにつき1回で済むことを保証する
assert(
  (() => {
    const idx = masters.indexOf('async _saveMapLayout() {');
    if (idx < 0) return false;
    const end = masters.indexOf('await Promise.all(promises);', idx);
    if (end < 0 || end <= idx) return false;
    const body = masters.slice(idx, end);
    return body.includes("API.bulkPatch('beds', bedUpdates, { skipRevisionCheck: true })") &&
      !body.includes("API.patch('beds',");
  })(),
  '_saveMapLayout must batch all bed position updates into a single bulkPatch request instead of one API.patch call per bed'
);
assert(
  api.includes('async bulkPatch(table, data, { skipRevisionCheck = false } = {})') &&
  /skipRevisionCheck\s*\?\s*data\s*:/.test(api),
  'API.bulkPatch must support skipRevisionCheck so map-layout-style bulk saves are not blocked by unrelated concurrent master edits'
);
assert(
  masters.includes("const wards = [...AppState.wards].sort") &&
  masters.includes("data-direction=\"up\"") &&
  masters.includes("data-direction=\"down\"") &&
  masters.includes("async _moveWard(wardId, direction)") &&
  masters.includes("API.patch('wards', ward.id, { sort_order: order + 1 })") &&
  masters.includes("['id', 'name', 'phone', 'note', 'sort_order']") &&
  app.includes("AppState.wards = wards.slice().sort"),
  'Ward master order must be persisted with move controls and applied to shared ward selectors'
);

// isValidApiTokenはsystem_settingsの1レコードを読むだけで一切
// ミューテーションしないため、DB全体をディープコピーするreadDB()は不要。
// この関数は子機からの外部HTTPリクエスト(isExternal=true)の経路で
// 1リクエストあたり最大3回呼ばれる(HTTPサーバー入口・processDbRequest内の
// 冗長な再チェック・各書き込みハンドラ)ため、ここがクローンする実装に
// 戻ると子機接続台数×ポーリング頻度に比例して親機側のCPU負荷が
// 積み上がる退行になる
assert(
  (() => {
    const idx = main.indexOf('function isValidApiToken(apiToken) {');
    if (idx < 0) return false;
    const end = main.indexOf('async function processParentActionRequest', idx);
    if (end < 0 || end <= idx) return false;
    const body = main.slice(idx, end);
    return body.includes('readDbShared()') && !/const db = readDB\(\)/.test(body);
  })(),
  'isValidApiToken must use the non-cloning readDbShared(), not readDB(), since it never mutates the returned object'
);

// processDbRequestの冒頭ログは内部IPC・外部HTTP、GET/書き込み問わず毎回
// 呼ばれる関数のため、5秒間隔のダッシュボードポーリング等の高頻度GETで
// 無条件に出力すると接続端末数×ポーリング頻度に比例したオーバーヘッドに
// なる。書き込み系(低頻度・高診断価値)のみログすることを保証する
assert(
  (() => {
    const idx = main.indexOf('console.log(`[DB Request]');
    if (idx < 0) return false;
    const before = main.slice(Math.max(0, idx - 120), idx);
    return before.includes("if (method !== 'GET')");
  })(),
  'The [DB Request] log in processDbRequest must be gated to non-GET methods to avoid per-poll logging overhead scaling with connected terminals'
);

// スケジュールフィードを無効化(is_active=false)しても、取り込み済みの
// schedule_itemsはDBから削除されない(setupScheduleFeedTriggersが今後の
// 自動取り込みを止めるだけ)。描画側でis_activeを見ていないと、無効化
// したフィードの予定が病床マップ・タイムラインに残り続けてしまう
assert(
  (() => {
    const idx = bedmap.indexOf('_getTodaySchedulesForBed(bed) {');
    if (idx < 0) return false;
    const end = bedmap.indexOf('_renderTodayScheduleBadges(bed) {', idx);
    if (end < 0 || end <= idx) return false;
    const body = bedmap.slice(idx, end);
    return body.includes('feed?.is_active === false');
  })(),
  '_getTodaySchedulesForBed must hide items whose feed has is_active === false, otherwise disabled feeds keep showing stale badges on the bed map'
);
assert(
  (() => {
    const idx = timeline.indexOf('const allItems = await API.getScheduleItemsForRange(dayStart, dayEnd);');
    if (idx < 0) return false;
    const end = timeline.indexOf('this._scheduleItems = schedItems;', idx);
    if (end < 0 || end <= idx) return false;
    const body = timeline.slice(idx, end);
    return body.includes('AppState.scheduleFeeds') && body.includes('feed?.is_active === false');
  })(),
  'Timeline schedule item fetch must look up the parent feed and hide items whose feed has is_active === false'
);

// タイムラインのward_idsフィルタは病床マップ(js/bedmap.js)と同じく
// フィードの現在の設定を優先しなければならない。アイテムのインポート時
// スナップショット(item.ward_ids)だけを見ると、管理者がフィード保存後に
// 病棟制限を変更しても次の再取り込みまで反映されず、病床マップとの
// 表示件数が食い違う
assert(
  (() => {
    const idx = timeline.indexOf('const feedsById = new Map(');
    const end = timeline.indexOf('this._scheduleItems = schedItems;', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = timeline.slice(idx, end);
    return /Array\.isArray\(feed\?\.ward_ids\)\s*\n\s*\?\s*feed\.ward_ids/.test(body);
  })(),
  'Timeline schedule item filter must prefer the feed\'s current ward_ids over the stale per-item snapshot, matching bedmap.js'
);

// タイムラインの患者ID連携(病床紐付け)は現在病棟にスコープしなければ
// ならない。病棟を問わず検索すると、他病棟の在床患者とidentifierが
// 偶然一致した場合に、その病床の予定行が現在のタイムラインへ紛れ込んで
// 表示されてしまう(病床マップは病床一覧自体が現在病棟で絞り込み済みの
// ため、この問題が構造的に起きない)
assert(
  (() => {
    const idx = timeline.indexOf('schedItems.forEach(item => {');
    const end = timeline.indexOf('unlinkedSchedItems.push(item);', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = timeline.slice(idx, end);
    return body.includes('b.ward_id === AppState.currentWardId');
  })(),
  'Timeline bed-linking must scope the bed search to AppState.currentWardId, otherwise a same-identifier patient in another ward leaks into this ward\'s timeline'
);

// _buildSegmentsの区間終端は、次の段階がまだ到達していない(=現在進行中)
// 場合に現在時刻へフォールバックしなければならない。三項演算子の`p.to ?`
// 判定は常に真(pairs配列のtoは常に非空文字列)のため、`event[p.to] || now`
// でなければ進行中の段階(移動中以外)が現在時刻まで描画されず、タイムライン
// 上でその区間が丸ごと消えてしまう
assert(
  (() => {
    const idx = timeline.indexOf('_buildSegments(event, winStart, winEnd, toPercent) {');
    const end = timeline.indexOf('return segments;', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = timeline.slice(idx, end);
    return body.includes("event[p.to] || now") && !/p\.to\s*\?\s*event\[p\.to\]\s*:\s*now/.test(body);
  })(),
  'Timeline _buildSegments must fall back to "now" when the next milestone has not happened yet, otherwise in-progress stages beyond MOVING vanish from the timeline'
);

// タイムラインの「検査終了目安」時刻変更は、病床詳細モーダル(js/modal.js)の
// 同じフィールドの変更と同様にexpectedStatusを伴うpatchEventFieldsを
// 使わなければならない。生のAPI.patchだとサーバー側の楽観的排他チェックが
// 発動せず、他端末が既にその移送を完了/キャンセルしていても検知できない
assert(
  (() => {
    const idx = timeline.indexOf("document.getElementById('tl-popup-save')?.addEventListener");
    const end = timeline.indexOf('_showScheduleItemPopup(item, x, y) {', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = timeline.slice(idx, end);
    return body.includes('API.patchEventFields(event.id, { estimated_pickup_at: base.getTime() }, event.current_status)') &&
      body.includes('App.handleDataConflict(err)');
  })(),
  'Timeline pickup-time update must use API.patchEventFields with expectedStatus and handle conflicts, matching js/modal.js'
);

// スケジュールバーのツールチップ(title属性)に埋め込むitem.identifierは、
// 同じフィールドを表示する_showScheduleItemPopupと同様にエスケープしな
// ければならない。CSV/ODBC取り込みの外部データがそのまま入る値のため、
// 未エスケープだと属性値からのマークアップ注入を許してしまう
assert(
  (() => {
    const idx = timeline.indexOf('const _schedBarHtml = (item, color) => {');
    const end = timeline.indexOf('// ── HTML構築 ──', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = timeline.slice(idx, end);
    return body.includes("UI.escapeHTML(item.identifier)");
  })(),
  'Timeline schedule bar tooltip must escape item.identifier, otherwise externally-imported data can break out of the title attribute'
);

// スケジュールバーのクリックハンドラは、右クリックのコンテキストメニュー
// (TimelineContextMenu)が開いたままになっていないよう、ポップアップを
// 開く前に必ず非表示にしなければならない(他の2つのクリック/右クリック
// ハンドラは対になるオーバーレイを既に非表示にしている)
assert(
  (() => {
    const idx = timeline.indexOf('_bindScheduleClickHandlers(container) {');
    const end = timeline.indexOf('},', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = timeline.slice(idx, end);
    return body.includes('TimelineContextMenu.hide();');
  })(),
  'Timeline schedule bar click handler must hide TimelineContextMenu before opening the schedule popup'
);

// 病棟セレクトの変更ハンドラは、現在タイムラインを表示中であれば
// Timeline.renderを呼ばなければならない。呼ばないと病棟切替後、次の
// ポーリングtickまで前の病棟のタイムラインが表示され続ける
assert(
  (() => {
    const idx = app.indexOf("document.getElementById('ward-select').addEventListener('change'");
    const end = app.indexOf('_renderDevicePresence', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = app.slice(idx, end);
    return body.includes('Timeline.render()') && body.includes("dataset.page === 'timeline'");
  })(),
  'Ward-select change handler must call Timeline.render() when the timeline tab is active, otherwise switching wards leaves stale timeline data on screen'
);

// タイムラインの検査終了目安マーカーは、病床マップ/優先度パネル/病床詳細
// モーダルと同じくUI.remainingClassで遅延度合いを強調しなければならない
assert(
  (() => {
    const idx = timeline.indexOf("filtered.forEach(e => {");
    const end = timeline.indexOf('linkedItems.length > 0', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = timeline.slice(idx, end);
    return body.includes('UI.remainingClass(e.estimated_pickup_at - now)') &&
      body.includes('timeline-pickup-marker${pickupClass');
  })(),
  'Timeline pickup marker must be highlighted via UI.remainingClass based on how overdue the estimated pickup time is'
);

// current_statusの変更はstatus/update(processStatusUpdateRequest)の1経路に
// 集約しなければならない。単体PATCH・一括PATCH・POST-as-updateのいずれかが
// current_status変更を素通しにすると、スコープ別ルールではなく緩い判定
// (またはノーチェック)のみで通ってしまい、タイムスタンプ・
// transfer_status_logs行・監査ログ・音声通知の副作用も伴わない状態変更が
// 発生しうる。isExternalを問わず一律拒否することを保証する
assert(
  (() => {
    const postIdx = main.indexOf("if (method === 'POST') {");
    const patchIdx = main.indexOf("if (method === 'PUT' || method === 'PATCH') {", postIdx);
    const deleteIdx = main.indexOf("if (method === 'DELETE') {", patchIdx);
    if (postIdx < 0 || patchIdx < 0 || deleteIdx < 0) return false;
    const postBody = main.slice(postIdx, patchIdx);
    const patchBody = main.slice(patchIdx, deleteIdx);
    const directGuard = /if\s*\(\s*table === 'transfer_events'\s*&&\s*Object\.prototype\.hasOwnProperty\.call\(data, 'current_status'\)\s*\)/;
    const postGuarded = directGuard.test(postBody) &&
      postBody.includes('Use status/update for status changes');
    const patchGuarded = directGuard.test(patchBody) &&
      patchBody.includes('Use status/update for status changes');
    const bulkGuarded =
      patchBody.includes("bulkData.some(patchItem => Object.prototype.hasOwnProperty.call(patchItem, 'current_status'))") &&
      !/isExternal\s*&&[^\n]*bulkData\.some/.test(patchBody);

    return patchGuarded && bulkGuarded && postGuarded;
  })(),
  'Single-record PATCH, bulk PATCH, and POST-as-update for transfer_events must reject current_status changes regardless of isExternal, forcing all status transitions through status/update'
);

// 新規transfer_events作成時、current_statusが指定されていれば既知の状態値
// (進行中の状態＋終端状態)であることを検証する。任意の文字列(例:
// クライアント側の派生疑似ステータスIN_BED)を許すと、その後どの遷移
// ルールにも合致せず永久に動かせないレコードが作られてしまう
assert(
  (() => {
    const idx = main.indexOf('const KNOWN_TRANSFER_STATUSES');
    if (idx < 0) return false;
    return main.includes("!KNOWN_TRANSFER_STATUSES.has(data.current_status)") &&
      main.includes('Invalid current_status');
  })(),
  'transfer_events creation via generic POST must validate current_status against KNOWN_TRANSFER_STATUSES'
);

// carryover.jsのCANCELLED操作もRETURNED操作と同様にexpectedStatusを
// 渡さなければならない。CANCELLEDはどの状態からも遷移可能なため、
// 渡し忘れると他端末が既に進めたイベントを検知なくキャンセルできてしまう
assert(
  (() => {
    const idx = carryover.indexOf("await API.updateEventStatus(eventId, action");
    if (idx < 0) return false;
    const lineEnd = carryover.indexOf(');', idx);
    const call = carryover.slice(idx, lineEnd);
    return call.includes('target?.current_status');
  })(),
  "carryover.js's CANCELLED action must pass expectedStatus (target?.current_status) to detect conflicts, matching the RETURNED branch"
);

// ICカード紐づけ解除(RETURNED/CANCELLED時)はAPI.updateEventStatusに
// 一元化し、呼び出し元(タイムライン・carryover等)ごとの対応漏れを防ぐ
assert(
  (() => {
    const idx = api.indexOf('async updateEventStatus(');
    const end = api.indexOf('return result;', idx);
    if (idx < 0 || end < 0) return false;
    const body = api.slice(idx, end);
    return body.includes("newStatus === 'RETURNED' || newStatus === 'CANCELLED'") &&
      body.includes('patient_ic_tag_id: null');
  })(),
  'API.updateEventStatus must centrally clear patient_ic_tag_id for RETURNED/CANCELLED so all callers (timeline, carryover, modal) get consistent behavior'
);

// タイムラインの右クリックメニューは病床詳細モーダルと同じ破壊的操作の
// 確認(キャンセル・迎え要省略の帰棟完了)を経なければならない
assert(
  (() => {
    const idx = timeline.indexOf("el.querySelectorAll('[data-to]').forEach(btn => {");
    const end = timeline.indexOf('try {', idx);
    if (idx < 0 || end < 0) return false;
    const body = timeline.slice(idx, end);
    return body.includes("newStatus === 'CANCELLED'") &&
      body.includes("newStatus === 'RETURNED' && event.current_status === 'IN_EXAM'") &&
      (body.match(/confirm\(/g) || []).length === 2;
  })(),
  'Timeline context menu must confirm CANCELLED and skip-to-RETURNED transitions like the bed detail modal'
);

// 検査室の操作ボタンは連打防止のため、リクエスト中は同じカードの
// 全ボタンを無効化しなければならない
assert(
  (() => {
    const idx = examroom.indexOf("_bindQueueEvents(container) {");
    const end = examroom.indexOf('_updateStatus(eventId, newStatus,', idx);
    if (idx < 0 || end < 0) return false;
    const body = examroom.slice(idx, end);
    return body.includes("card.querySelectorAll('button').forEach(b => (b.disabled = true))");
  })(),
  'Exam room action buttons must disable the whole card while a status update is in flight to prevent double-submit'
);

// js/config.jsのACTION_BUTTONS/EXAM_ROOM_ACTIONSとmain.jsの
// WARD_STATUS_ACTIONS/EXAM_STATUS_ACTIONSは独立した手書きの複製であり、
// 共通の情報源が無い。片方だけ変更されてずれるとクライアントが提示する
// ボタンとサーバーが許可する遷移が食い違いかねないため、from→toの
// 集合が完全に一致することを保証する
assert(
  (() => {
    const wardActions = extractObjectLiteral(main, 'const WARD_STATUS_ACTIONS = {');
    const examActions = extractObjectLiteral(main, 'const EXAM_STATUS_ACTIONS = {');
    const actionButtons = extractObjectLiteral(config, 'ACTION_BUTTONS: {');
    const examRoomActions = extractObjectLiteral(config, 'EXAM_ROOM_ACTIONS: {');
    const toSets = obj => Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, (v || []).map(a => a.toStatus).sort()])
    );
    const sortedWard = Object.fromEntries(Object.entries(wardActions).map(([k, v]) => [k, [...v].sort()]));
    const sortedExam = Object.fromEntries(Object.entries(examActions).map(([k, v]) => [k, [...v].sort()]));
    return JSON.stringify(sortedWard) === JSON.stringify(toSets(actionButtons)) &&
      JSON.stringify(sortedExam) === JSON.stringify(toSets(examRoomActions));
  })(),
  'js/config.js ACTION_BUTTONS/EXAM_ROOM_ACTIONS must have the exact same from->to status sets as main.js WARD_STATUS_ACTIONS/EXAM_STATUS_ACTIONS'
);

// 未使用かつ実態(サーバーの状態機械にIN_BEDは存在しない)と矛盾する
// STATUS_TRANSITIONS表が復活していないことを保証する
assert(
  !config.includes('STATUS_TRANSITIONS'),
  'js/config.js must not reintroduce the unused STATUS_TRANSITIONS table (it drifted from the real transition tables, e.g. a phantom IN_BED entry)'
);

// 検査室は病棟をまたいで共有されるため病棟横断集計が必要だが、一覧に患者情報は
// 不要。専用APIはexam_room_id/current_statusだけを返し、イベント本体を露出しない。
assert(
  (() => {
    const idx = main.indexOf("id === 'exam-room-grid-status'");
    const end = main.indexOf("id === 'exam-room-status'", idx);
    if (idx < 0 || end < 0) return false;
    const body = main.slice(idx, end);
    return body.includes('ACTIVE_TRANSFER_STATUSES.has(event.current_status)') &&
      body.includes('exam_room_id: event.exam_room_id') &&
      body.includes('current_status: event.current_status') &&
      !body.includes('...event') &&
      !body.includes('patient_') &&
      !body.includes('bed_id');
  })(),
  'Exam room grid endpoint must return only active exam_room_id/current_status summaries without patient or bed data'
);
assert(
  api.includes('async getExamRoomGridStatus()') &&
    (() => {
      const idx = api.indexOf('async getExamRoomGridStatus()');
      const end = api.indexOf('},', idx);
      const body = api.slice(idx, end);
      return body.includes('tables/transfer_events/exam-room-grid-status') &&
        !body.includes('getAllActiveTransferEvents');
    })(),
  'js/api.js must use the minimal exam-room-grid-status endpoint for cross-ward aggregation'
);
assert(
  (() => {
    const idx = examroom.indexOf('async _renderRoomGrid()');
    if (idx < 0) return false;
    const end = examroom.indexOf('\n  },\n', idx);
    const body = examroom.slice(idx, end);
    return body.includes('API.getExamRoomGridStatus()') &&
      !body.includes('API.getAllActiveTransferEvents()') &&
      !body.includes('AppState.activeEvents.filter(');
  })(),
  'ExamRoom._renderRoomGrid must aggregate from the privacy-safe ward-agnostic status summary'
);

// ARRIVED / NEARLY_DONEを非表示にすると、患者総数は正でも内訳pillが0件に
// なりうる。その場合に「患者なし」と表示して総数と矛盾させてはならない。
assert(
  (() => {
    const idx = examroom.indexOf('const pillsHtml = pills.length');
    const end = examroom.indexOf('return `', idx);
    if (idx < 0 || end < 0) return false;
    const body = examroom.slice(idx, end);
    return body.includes('total > 0') &&
      body.includes('進行中 ${total}名') &&
      body.indexOf('total > 0') < body.indexOf('患者なし');
  })(),
  'Exam room cards must show 患者なし only when total is zero, even if hidden statuses leave no visible breakdown pills'
);

// ── スケジュールフィード個別のSMB認証情報 ─────────────────────────
// パスワードは system_settings の `smb_password__<feedId>` に置き、暗号化・子機マスク・
// 監査マスク・エクスポート除外の4機構(いずれもsystem_settings限定)にそのまま乗せる。
// どれか一つでも完全一致リストへ後退すると、平文のまま保存・配信されてしまう
assert(
  (() => {
    const idx = main.indexOf('function isSensitiveSettingId(');
    if (idx < 0) return false;
    return main.slice(idx, idx + 300).includes('isFeedSmbPasswordSettingId');
  })(),
  'isSensitiveSettingId must cover feed-scoped SMB password ids so they are encrypted at rest'
);
assert(
  (() => {
    const writeIdx = main.indexOf('const dbForDisk');
    const writeEnd = main.indexOf('safeWriteFile(DB_FILE', writeIdx);
    const readIdx = main.indexOf('// センシティブな設定情報の復号化');
    if (writeIdx < 0 || writeEnd < 0 || readIdx < 0) return false;
    return main.slice(writeIdx, writeEnd).includes('isSensitiveSettingId(s.id)')
      && main.slice(readIdx, readIdx + 400).includes('isSensitiveSettingId(s.id)');
  })(),
  'readDB/writeDB must go through isSensitiveSettingId, not the exact-match SENSITIVE_SETTING_IDS list'
);
assert(
  (() => {
    const idx = main.indexOf("if (isExternal && table === 'system_settings')");
    if (idx < 0) return false;
    const body = main.slice(idx, idx + 2000);
    return body.includes('isFeedSmbPasswordSettingId')
      && body.includes('isBlockedSecret')
      && body.includes('isWriteBlocked');
  })(),
  'Child terminals must have feed-scoped SMB passwords masked on read and blocked on write'
);
assert(
  (() => {
    const idx = main.indexOf('function maskAuditValue(');
    const end = main.indexOf('function summarizeAuditRecord', idx);
    return idx >= 0 && end > idx && main.slice(idx, end).includes('isAuditSecretSettingId');
  })(),
  'Audit masking must redact feed-scoped SMB passwords via isAuditSecretSettingId'
);
assert(
  (() => {
    const idx = main.indexOf('function redactCredentials(');
    return idx >= 0 && main.slice(idx, main.indexOf('\n}', idx)).includes('isExportRedactedSettingId');
  })(),
  'Redacted backups must strip feed-scoped SMB passwords via isExportRedactedSettingId'
);
// 子機は機密設定をマスク値で受け取るため、設定画面を開いて保存しただけで
// マスク文字列が実パスワードを上書きしてしまう(過去に実在した不具合)
assert(
  (() => {
    const idx = main.indexOf("case 'save-import-settings'");
    const end = main.indexOf("case 'manual-import'", idx);
    return idx >= 0 && end > idx && main.slice(idx, end).includes('MASKED_SECRET_VALUE');
  })(),
  'save-import-settings must ignore masked secret placeholders instead of storing them over the real password'
);
// UNC監視先のスケジュールフィードは認証しないと fs.existsSync で失敗し続ける
assert(
  (() => {
    const idx = main.indexOf('function setupScheduleFeedTriggers()');
    const end = main.indexOf('function scanAndImportScheduleFolder', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('authenticateSMBSync') && body.includes('readFeedSmbCredentials')
      && body.includes('pruneUnusedSmbSessions');
  })(),
  'setupScheduleFeedTriggers must authenticate UNC feed folders and release sessions that no feed uses any more'
);
// 稼働中のwatcherが掴んでいる共有を net use /delete すると、監視は生きたまま
// イベントが二度と来ない無言故障になる。同一資格情報での再接続は行わないこと
assert(
  (() => {
    const idx = main.indexOf('function authenticateSMBSync(');
    const end = main.indexOf('\n}', main.indexOf("'/persistent:no'", idx));
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('smbSessionRegistry.plan')
      && body.includes("planned.action === 'skip'")
      && body.includes("planned.action === 'conflict'")
      && body.includes('planned.deleteFirst');
  })(),
  'authenticateSMBSync must reuse an existing session and must not tear one down for conflicting credentials'
);
// ウィザードは 'credential' を書いていたが main.js は 'custom' しか解釈しない
assert(
  !wizard.includes("value=\"credential\"") && !wizard.includes("=== 'credential' ? 'grid'"),
  "The setup wizard must write the same 'custom' SMB auth mode value that main.js understands"
);
// フィードを削除したら資格情報も残さない
assert(
  (() => {
    const idx = main.indexOf("if (table === 'schedule_feeds')");
    if (idx < 0) return false;
    return main.slice(idx, idx + 400).includes('feedSmbPasswordSettingId');
  })(),
  'Deleting a schedule feed must also drop its stored SMB password setting'
);

// ── 親機/子機の関係 ─────────────────────────────────────────
// A-1: import_directory も schedule_feeds も共有DBにあるため、ガードが無いと
// 全子機が親機と同じフォルダを監視し、取り込み後のアーカイブ/削除でソースCSVを
// 先に消してしまう（親機が永久に取り込めなくなる無言のデータ損失）
assert(
  (() => {
    const idx = main.indexOf('function setupImportTrigger()');
    const end = main.indexOf('\nfunction ', idx + 10);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    // 停止処理より後、監視を張る前にガードがあること
    return body.includes('isClientTerminal(db)')
      && body.indexOf('isClientTerminal(db)') < body.indexOf('resolveWatchDir()');
  })(),
  'setupImportTrigger must not start a watcher on a child terminal (children would consume the CSVs the parent needs)'
);
assert(
  (() => {
    const idx = main.indexOf('function setupScheduleFeedTriggers()');
    const end = main.indexOf('function scanAndImportScheduleFolder', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('isClientTerminal(db)')
      && body.indexOf('isClientTerminal(db)') < body.indexOf('feeds.forEach');
  })(),
  'setupScheduleFeedTriggers must not start watchers on a child terminal'
);
// A-2: 親機でのみ実行できる操作を子機で押したとき、成功を騙らないこと
assert(
  (() => {
    const idx = app.indexOf('const EventRetentionManager');
    const end = app.indexOf('\n};', idx);
    return idx >= 0 && end > idx && app.slice(idx, end).includes('return result;');
  })(),
  'EventRetentionManager.run must return the IPC result so callers can detect a parent-only rejection'
);
assert(
  maintenance.includes("result?.success === false") && maintenance.includes('btn-run-event-cleanup'),
  'The manual retention cleanup button must surface a failed result instead of always reporting success'
);
// A-3: 401でも本文は正常なJSONなので、res.okを見ないと認証エラーが
// 「正常な空応答」と区別できず、ハートビートが切断バナーを打ち消す
assert(
  api.includes('async function assertParentResponseOk(')
  && (api.match(/assertParentResponseOk/g) || []).length >= 4,
  'deviceHeartbeat / getConnectedDevices / webrtcPoll must check res.ok instead of parsing a 401 body as success'
);
// A-4: 書き込み直後の refreshData が force 無しだと、書き込み前に発行された
// ポーリングのPromiseがそのまま返り、画面が変わらないまま成功トーストが出る
assert(
  !modal.includes('App.refreshData()')
  && !examroom.includes('App.refreshData()')
  && !timeline.includes('App.refreshData()')
  && !carryover.includes('App.refreshData()'),
  'refreshData() after a mutation must pass { force: true }, otherwise it can return an in-flight pre-write poll'
);
// B-1: localStorage欠落時に既定の'parent'で修復すると、子機が黙って
// 2台目の親機へ昇格する（APIトークンは全機共通なので誰にも検知されない）
assert(
  (() => {
    const idx = app.indexOf('async _repairLocalShareMode()');
    const end = app.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = app.slice(idx, end);
    return body.includes("const storedMode = localStorage.getItem('cfg_share_mode');")
      && body.includes('if (!storedMode)')
      && !body.includes("localStorage.getItem('cfg_share_mode') || 'parent'");
  })(),
  'A terminal with no stored cfg_share_mode must not promote itself to parent'
);
// B-3: 再起動を断られても3005が生き続けると、子機として振る舞いながら配信を続ける
assert(
  main.includes('function stopParentServer()') && main.includes("handleTrusted('stop-parent-server'"),
  'There must be a way to stop the parent HTTP server without a restart'
);
assert(
  networkSettings.includes('stopParentServer'),
  'Switching a terminal to child mode must stop the shared server immediately'
);
// B-4: メインプロセスはlocalStorageを触れないため、復元後の役割をrendererへ返す
assert(
  (() => {
    const idx = main.indexOf("handleTrusted('restore-db'");
    const end = main.indexOf("handleTrusted('get-local-ips'", idx);
    return idx >= 0 && end > idx
      && main.slice(idx, end).includes('return { success: true, shareMode: restoredShareMode, parentIp: restoredParentIp };');
  })(),
  'restore-db must report the restored role so the renderer can sync localStorage before relaunching'
);
assert(
  maintenance.includes("localStorage.setItem('cfg_share_mode', res.shareMode)"),
  'The restore handler must sync cfg_share_mode to the restored role'
);
// B-5: 別マシンが親機になっても子機は無警告で追従してしまう
assert(
  main.includes('function ensureParentInstanceId()') && app.includes('_checkParentIdentity('),
  'Children must be able to notice that the parent they talk to has been replaced'
);
// C-1: 子機の指定した任意のUNCパスへ親機が保存済み資格情報で net use しに行かないこと
assert(
  (() => {
    const idx = main.indexOf('function validateWatchDirectoryOnParent(');
    const end = main.indexOf('function updateWatchDirectoryOnParent(', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('isExternal')
      && body.includes('getConfiguredSmbServerKeys')
      && body.indexOf('getConfiguredSmbServerKeys') < body.indexOf('authenticateSMBSync(resolved)');
  })(),
  'External callers must not be able to point the parent at an unconfigured SMB server'
);
// C-2: 他のODBC操作と同じくDSN必須。無いと任意ホストへ接続させられる
assert(
  (() => {
    const idx = main.indexOf('async function getOdbcTablesOnParent(');
    const end = main.indexOf('execOdbcPowerShell', idx);
    return idx >= 0 && end > idx && main.slice(idx, end).includes("includes('DSN=')");
  })(),
  'getOdbcTablesOnParent must require a DSN like the other ODBC actions do'
);
// C-3: 共有トークンしかないため、HTTP経由では他端末になりすまして切断できてしまう
assert(
  (() => {
    const idx = main.indexOf("} else if (cleanUrl.startsWith('device/')) {");
    const end = main.indexOf('Unknown device action', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes("action === 'disconnect'") && !body.includes('delete connectedDevices[info.deviceId]');
  })(),
  'device/disconnect must not be reachable over HTTP (any child could evict any other terminal)'
);

// ── 通話機能: ICE候補の保留・呼び出し中の状態管理・シグナリングの送信元検証 ──
// 発信側のhost candidateはミリ秒単位で収集・送信されるのに対し、着信側は応答するまで
// peerConnection自体が存在しない。保留せずに捨てると発信側のICE候補がほぼ全て失われ、
// 「通話がつながらない」の主因になる
assert(
  (() => {
    const idx = call.indexOf("else if (msg.type === 'ice') {");
    const end = call.indexOf("else if (msg.type === 'hangup')", idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes('_pendingIceCandidates.push') && body.includes('remoteDescription');
  })(),
  'ICE candidates arriving before remoteDescription is set must be queued (_pendingIceCandidates), not dropped'
);
assert(
  call.includes('_flushPendingIceCandidates') &&
  (call.match(/await this\._flushPendingIceCandidates\(\)/g) || []).length >= 2,
  'Queued ICE candidates must be flushed after setRemoteDescription on both the caller (answer) and callee (accept) paths'
);
// cleanupCallはDB書き込み(API.patch、子機では最大8秒かかりうる)の完了を待たずに
// isCalling/isConnectedを倒す必要がある。そうしないと「通話を終了」を押してから
// 最大8秒間、新規の発信も着信もできなくなる
assert(
  (() => {
    const idx = call.indexOf('async cleanupCall(message');
    const flagIdx = call.indexOf('this.isCalling = false;', idx);
    const patchIdx = call.indexOf("await API.patch('calls'", idx);
    return idx >= 0 && flagIdx > idx && patchIdx > flagIdx;
  })(),
  'cleanupCall must clear isCalling/isConnected before awaiting the calls-table DB patch, not after'
);
// 着信呼び出し中(応答前)はpeerConnection/isCalling/isConnectedのいずれも真にならないため、
// 話し中判定にこれらしか使わないと2件目の着信で1件目のダイアログが上書きされ、
// 1件目の発信者にbusyも拒否も返らないまま無応答タイムアウトまで鳴り続けてしまう
assert(
  (() => {
    const idx = call.indexOf("if (msg.type === 'offer') {");
    const end = call.indexOf("else if (msg.type === 'answer')", idx);
    return idx >= 0 && end > idx && call.slice(idx, end).includes('this._isRinging');
  })(),
  'The busy-check on incoming offers must include _isRinging (peerConnection/isCalling/isConnected are all false while ringing)'
);
assert(
  (() => {
    const idx = call.indexOf("else if (msg.type === 'answered')");
    const end = call.indexOf("else if (msg.type === 'speech')", idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes('_incomingRingTimeoutId') && body.includes('_isRinging = false');
  })(),
  "Receiving 'answered' (another terminal with the same id picked up) must clear the no-answer timeout, or it later fires busy against an already-connected call"
);
// シグナリングメッセージはキューに最大30秒残るため、送信元を見ずにhangup/busyを
// 処理すると、通信が数秒詰まった後に再開した際、直前の通話のhangupが次の通話を切る。
// 呼び出し箇所の存在だけでなく、_isFromCurrentPeer自体が実際にtargetIdと比較して
// いること（常にtrueを返すよう空洞化されていないこと）も確認する
assert(
  (() => {
    const idx = call.indexOf('_isFromCurrentPeer(msg) {');
    const end = call.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    return call.slice(idx, end).includes('msg.from === this.targetId');
  })(),
  '_isFromCurrentPeer must actually compare msg.from against this.targetId, not be a stub'
);
assert(
  call.includes('_isFromCurrentPeer(msg)') &&
  (call.match(/if \(!this\._isFromCurrentPeer\(msg\)/g) || []).length >= 4,
  'answer/ice/hangup/busy handlers must verify the sender matches the current call partner (targetId)'
);

// #webrtc-video-container/#webrtc-remote-videoはjs/call.jsでインラインstyle
// (width:100%;height:260px;等)を持つため、:fullscreenのCSSルールに!important
// が無いとインラインstyleに常に負け、フルスクリーンにしても見た目が一切
// 変わらない(横だけ100vwになり縦は260pxのまま、という壊れた表示になる)
assert(
  (() => {
    const idx = styles.indexOf('#webrtc-video-container:fullscreen {');
    const end = styles.indexOf('}', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = styles.slice(idx, end);
    return body.includes('width: 100vw !important') && body.includes('height: 100vh !important');
  })(),
  '#webrtc-video-container:fullscreen must use !important on width/height to override the element\'s inline style from js/call.js'
);
assert(
  (() => {
    const idx = styles.indexOf('#webrtc-video-container:fullscreen #webrtc-remote-video {');
    const end = styles.indexOf('}', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = styles.slice(idx, end);
    return body.includes('width: 100% !important') && body.includes('height: 100% !important');
  })(),
  '#webrtc-video-container:fullscreen #webrtc-remote-video must use !important on width/height to override the video element\'s inline style'
);

// ExamRoom._handleScanは、病床詳細モーダルのbody.innerHTMLがclose()後も
// DOMに残り続けるため、#m-ic-tag-id/#f-ic-tag-idの「存在」だけで
// モーダルが開いているとみなすと、過去にモーダルを一度でも開いた端末では
// 検査室でのICスキャンが常にその残骸へ誤って流れ、ステータス更新が
// 一切実行されなくなる(検査室でカードを読ませても到着/検査開始にならない
// 不具合の原因)。オーバーレイの表示状態を必ず併せて確認すること。
assert(
  (() => {
    const idx = examroom.indexOf('async _handleScan(icValue) {');
    const editIdx = examroom.indexOf("getElementById('m-ic-tag-id')", idx);
    const overlayIdx = examroom.indexOf("getElementById('bed-modal-overlay')", idx);
    if (idx < 0 || editIdx < 0 || overlayIdx < 0) return false;
    return overlayIdx < editIdx;
  })(),
  'ExamRoom._handleScan must check #bed-modal-overlay visibility before routing to #m-ic-tag-id/#f-ic-tag-id (their DOM nodes persist after modal close)'
);

// ICスキャン/バーコード照合は数字のみのIDについて先頭0埋めの有無を無視して
// 一致判定しなければならない。「患者IDをセット」で使われるbeds.patient_idと
// 検査室で読み取るバーコードの桁数(0埋め)ルールが一致しない運用があり、
// 単純な文字列完全一致のままだと該当患者が見つからず自動更新できない。
assert(
  examroom.includes('_normalizeIdForMatch(value)') &&
  (() => {
    const idx = examroom.indexOf('async _handleScan(icValue) {');
    if (idx < 0) return false;
    const matchIdx = examroom.indexOf('relevant.find(', idx);
    if (matchIdx < 0) return false;
    const lineEnd = examroom.indexOf('\n', matchIdx);
    const line = examroom.slice(matchIdx, lineEnd);
    return line.includes('this._normalizeIdForMatch(');
  })(),
  'ExamRoom._handleScan must compare scanned IDs via _normalizeIdForMatch (strip leading zeros for numeric IDs) instead of raw string equality, or IC-tag matches fail when zero-padding differs'
);

// バーコードモード: NFCカードリーダーの常時監視プロセス(PowerShell)は
// patient_id_scan_modeが'barcode'のときは起動してはならない
// (バーコードスキャナーはキーボード入力型のためカード監視自体が不要)。
assert(
  main.includes("function isNfcWatcherEnabled(db)") &&
  (() => {
    const idx = main.indexOf('function isNfcWatcherEnabled(db) {');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes("'patient_id_scan_mode'") && body.includes("scanMode !== 'barcode'");
  })(),
  'isNfcWatcherEnabled must gate the NFC watcher on patient_id_scan_mode !== "barcode"'
);
assert(
  main.includes('isNfcWatcherEnabled(db)') &&
  (main.match(/isNfcWatcherEnabled\(/g) || []).length >= 3,
  'startup and restart-scheduling NFC watcher checks must both use isNfcWatcherEnabled (not a raw enable_patient_ic_association check)'
);

// バーコードモード・出棟登録時の患者ID自動セットは設定画面(共有・ネットワーク設定)で
// system_settingsとして保存されなければならない
assert(
  networkSettings.includes("API.patch('system_settings', 'patient_id_scan_mode'") &&
  networkSettings.includes("API.patch('system_settings', 'enable_auto_set_patient_id'"),
  'Network settings save handler must persist patient_id_scan_mode and enable_auto_set_patient_id to system_settings'
);

// 「患者IDをセット」は、この病床に既に設定されている患者IDをそのまま検査室照合用
// (patient_ic_tag_id)として使う機能であり、読み取り欄でbeds.patient_id自体を
// 上書きしてはならない(患者IDはCSV/ODBC同期や在室登録で既に正しい値のはず)
assert(
  (() => {
    const idx = modal.indexOf('async _startTransfer() {');
    const end = modal.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = modal.slice(idx, end);
    return !body.includes("API.patch('beds'");
  })(),
  '_startTransfer must not overwrite beds.patient_id; "患者IDをセット" must use the bed\'s existing patient_id as-is for exam-room matching, not a scanned value'
);
assert(
  (() => {
    const idx = modal.indexOf('async _startTransfer() {');
    const end = modal.indexOf('const btn = document.getElementById', idx);
    if (idx < 0 || end < idx) return false;
    const body = modal.slice(idx, end);
    return body.includes('autoSetPatientIdChecked') && body.includes('bed.patient_id || null');
  })(),
  '_startTransfer must derive the exam-room matching id (patientIcTagId) from bed.patient_id when auto-set is checked, not from the scan input value'
);
assert(
  modal.includes("icTagRow.style.display = autoSetCheckbox.checked ? 'none' : ''"),
  'The "患者IDをセット" checkbox must hide the #f-ic-tag-row scan field when checked, since no scanning is needed at departure registration in that mode'
);

// 「患者IDをセット」チェックボックスの既定チェック状態(auto_set_patient_id_default_checked)は
// 設定画面から保存され、出棟登録フォームの描画時にcheckedとして反映されなければならない
assert(
  networkSettings.includes("API.patch('system_settings', 'auto_set_patient_id_default_checked'"),
  'Network settings save handler must persist auto_set_patient_id_default_checked to system_settings'
);
assert(
  (() => {
    const idx = modal.indexOf("id=\"f-auto-set-patient-id\"");
    if (idx < 0) return false;
    const lineStart = modal.lastIndexOf('\n', idx);
    const lineEnd = modal.indexOf('\n', idx);
    return modal.slice(lineStart, lineEnd).includes('isAutoSetPatientIdDefaultChecked');
  })(),
  'The #f-auto-set-patient-id checkbox markup must reflect isAutoSetPatientIdDefaultChecked'
);

// 「患者IDをセット」がチェックされているのに、この病床に患者IDが設定されて
// いない場合に送信を許すと、patient_ic_tag_idがnullのまま移送が始まり、
// 検査室でバーコードを読ませても該当イベントが見つからない(誤って登録
// されていないように見える)事故になる。_startTransferはAPI呼び出しより
// 前にこれを検知して止めなければならない
assert(
  (() => {
    const idx = modal.indexOf('async _startTransfer() {');
    const guardIdx = modal.indexOf('autoSetPatientIdChecked && !icTagId', idx);
    const startIdx = modal.indexOf('API.startTransfer(', idx);
    if (idx < 0 || guardIdx < 0 || startIdx < 0) return false;
    return guardIdx < startIdx;
  })(),
  '_startTransfer must reject submission when autoSetPatientIdChecked is true but the bed has no patient_id, before calling API.startTransfer'
);

// 検査種別・検査室のカード選択でキーボードウェッジ型スキャナーのフォーカスが
// 外れると、その後の読み取りが#f-ic-tag-idへ入らないまま登録できてしまう。
// _bindOptionCardSelectorsはカード選択後、未読み取りならスキャン欄へ
// フォーカスを戻さなければならない
assert(
  (() => {
    const idx = modal.indexOf('_bindOptionCardSelectors() {');
    const end = modal.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = modal.slice(idx, end);
    return body.includes("getElementById('f-ic-tag-id')") && body.includes('.focus()');
  })(),
  '_bindOptionCardSelectors must refocus #f-ic-tag-id after card selection when it is still empty'
);

// 検査室の「全検査室の患者一覧」: exam-room-statusはexam_room_id未指定時、
// 検査室が割り当てられている全イベントを対象にしなければならない
// (この分岐が無いと空のexam_room_idが常に一致無しになり、全患者一覧が
// 常に空表示になる)
assert(
  (() => {
    const idx = main.indexOf("id === 'exam-room-status'");
    const end = main.indexOf('\n    }', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('examRoomId') && body.includes('!!event.exam_room_id');
  })(),
  'exam-room-status handler must fall back to all rooms with an assigned exam_room_id when examRoomId is empty'
);

// _renderQueueはshowingAllRoomsを算出し、検査室未選択かつ全患者一覧モードの
// ときはグリッドではなく患者一覧側の分岐へ進まなければならない
assert(
  (() => {
    const idx = examroom.indexOf('async _renderQueue() {');
    const end = examroom.indexOf('_renderQueueCard(event', idx);
    if (idx < 0 || end < idx) return false;
    const body = examroom.slice(idx, end);
    return body.includes('showingAllRooms') &&
      body.includes('!roomId && !showingAllRooms') &&
      body.includes('{ showRoom: showingAllRooms }');
  })(),
  '_renderQueue must branch on showingAllRooms and pass { showRoom: showingAllRooms } to the queue renderers'
);

// カード/一覧の描画は検査室バッジ表示のためshowRoomオプションを受け取らな
// ければならない
assert(
  examroom.includes('_renderQueueCard(event, { showRoom = false } = {})') &&
  examroom.includes('_renderQueueList(events, { showRoom = false } = {})'),
  '_renderQueueCard/_renderQueueList must accept a showRoom option to render exam-room badges in the all-rooms view'
);

// save-import-settingsは、書き込み成功後に無条件でsetupImportTrigger/
// setupScheduleFeedTriggersを呼ばなければならない。import_directoryの
// 有無で条件分岐させると、それ以外のキー(import_schedule等)だけを送る
// 将来の呼び出し元で監視が古いまま取り残される静かな不整合を生む
assert(
  (() => {
    const idx = main.indexOf("case 'save-import-settings': {");
    const end = main.indexOf("case 'manual-import':", idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    const writeIdx = body.indexOf('writeDB(db)');
    const setupIdx = body.indexOf('setupImportTrigger();', writeIdx);
    if (writeIdx < 0 || setupIdx < 0) return false;
    // setupImportTrigger呼び出し直前(数行以内)に条件分岐が復活していないことを確認
    const between = body.slice(writeIdx, setupIdx);
    return !between.includes('hasImportDirectory &&') && !between.includes('if (hasImportDirectory');
  })(),
  'save-import-settings must call setupImportTrigger/setupScheduleFeedTriggers unconditionally after a successful write, not only when import_directory was part of the payload'
);

console.log('Security regression checks passed.');

// 行先(検査室)×検査種別の紐付け: exam_rooms.exam_type_ids が未設定・空配列の場合は
// 「すべての検査種別に対応」でなければならない。ここを「対応なし」と解釈すると、
// このフィールドを持たない既存の全インストールで検査種別が1件も選べなくなり、
// 出棟登録そのものができなくなる。
assert(
  (() => {
    const idx = modal.indexOf('_allowedExamTypeIdsForRoom(roomId) {');
    const end = modal.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = modal.slice(idx, end);
    return body.includes('!Array.isArray(ids) || ids.length === 0') && body.includes('return null');
  })(),
  '_allowedExamTypeIdsForRoom must treat a missing/empty exam_type_ids as "no restriction" (null), or existing rooms without the field would offer no exam types at all'
);

// 絞り込みは「行き先検査室を選んでから検査種別」の順を前提にしているため、
// 出棟登録フォームでは行き先検査室が検査種別より先に描画されていなければならない。
assert(
  (() => {
    const idx = modal.indexOf('_renderDepartForm(bed) {');
    const roomIdx = modal.indexOf("<label>行き先検査室", idx);
    const typeIdx = modal.indexOf("<label>検査種別", idx);
    if (idx < 0 || roomIdx < 0 || typeIdx < 0) return false;
    return roomIdx < typeIdx;
  })(),
  '_renderDepartForm must render the 行き先検査室 row before 検査種別 (the exam-type filter depends on picking the destination first)'
);

// 検査種別の絞り込みで送信ボタンを無効化する際、空床でフォーム自体が無効な
// ケースの無効状態まで解除してしまってはならない（空床で移送を開始できてしまう）。
assert(
  (() => {
    const idx = modal.indexOf('_applyExamTypeFilterForRoom(roomId) {');
    const end = modal.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = modal.slice(idx, end);
    return body.includes('submitBtn.disabled = available.length === 0 || select.disabled');
  })(),
  '_applyExamTypeFilterForRoom must keep the submit button disabled when the form itself is disabled (empty bed), not just when no exam type is available'
);

// exam_type_ids列を持たない旧フォーマットのCSVを取り込んだとき、キーを落として
// おかないと bulkUpsert のマージ({ ...before, ...data })で空配列が書き込まれ、
// 設定済みの対応検査種別が消える。
assert(
  (() => {
    const idx = masters.indexOf("if (tableName === 'exam_rooms') {");
    if (idx < 0) return false;
    const body = masters.slice(idx, idx + 900);
    return body.includes("csvHeaders.includes('exam_type_ids')") &&
      body.includes('delete record.exam_type_ids');
  })(),
  'exam_rooms CSV import must delete record.exam_type_ids when the CSV has no such column, or importing a legacy CSV wipes the configured exam-type mapping'
);

// 検査終了の目安(estimated_pickup_at)は出棟時点では移動時間を見込めない仮値
// のため、検査開始(IN_EXAM)への遷移時に実際の開始時刻+標準所要時間へ
// 再計算しなければならない。これが無いと出棟時刻基準のまま値が固定され、
// 移動に時間がかかった移送ほど「検査終了の目安」が実際より早い側にずれ続ける。
assert(
  (() => {
    const idx = main.indexOf("if (newStatus === 'IN_EXAM') {");
    const nearlyIdx = main.indexOf("if (newStatus === 'NEARLY_DONE') {");
    if (idx < 0 || nearlyIdx < 0 || nearlyIdx <= idx) return false;
    const body = main.slice(idx, nearlyIdx);
    return body.includes('current.expected_duration_min') &&
      body.includes('patch.estimated_pickup_at = now +');
  })(),
  'processStatusUpdateRequest must recompute estimated_pickup_at from current.expected_duration_min when transitioning to IN_EXAM, or the "検査終了の目安" stays pinned to the pre-transit departure-time estimate'
);

// リアルタイム監視のchokidar'add'ハンドラは、CSV1件ごとに単独で取り込む
// (commitScheduleFeedImportを都度呼ぶ)のではなく、フィード単位でデバウンスして
// scanAndImportScheduleFolder()でフォルダ全体をまとめて取り込まなければならない。
// ファイル単位で個別に取り込むと、commitScheduleFeedImportが呼び出しごとに
// 「そのフィードの既存アイテムを全削除してから今回渡された分だけ追加」するため、
// 同じフォルダに複数のCSVが立て続けに現れた場合(起動時に既存の複数CSVを検出、
// 運用者が複数ファイルを同時投入等)、後から処理されたファイルが先に処理された
// ファイル分の予定を消してしまう
assert(
  !main.includes('importScheduleFeedCSV'),
  'the standalone importScheduleFeedCSV(filePath, feed) helper (single-file replace-then-insert) must not exist any more; the realtime add handler must route through scanAndImportScheduleFolder so multiple CSVs in one watch folder are committed together, not one file at a time'
);
assert(
  (() => {
    const idx = main.indexOf("watcher.on('add', filePath => {");
    const end = main.indexOf('\n      });', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('scheduleFeedRealtimeDebounceTimers') &&
      body.includes('setTimeout(') &&
      body.includes('scanAndImportScheduleFolder(watchDir, feed)');
  })(),
  "the realtime watcher's 'add' handler must debounce per feed (via scheduleFeedRealtimeDebounceTimers) and call scanAndImportScheduleFolder once quiet, or CSVs added close together (startup with multiple existing files, or two files dropped at once) overwrite each other's imported items"
);

// 手動でのスケジュール取り込み(schedule-feed-import)は、実際にCSVの取り込みが
// 完了するまで待ってから結果を返さなければならない。待たずに{success:true}を
// 返すと、子機（親機アクション経由でこの結果を受け取る）では「取り込みました」
// と表示された直後にまだ反映されていないことがある
assert(
  (() => {
    const idx = main.indexOf('async function triggerScheduleFeedImportOnParent(feedId) {');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('await scanAndImportScheduleFolder(') &&
      body.includes('result.success');
  })(),
  'triggerScheduleFeedImportOnParent must await scanAndImportScheduleFolder and report its real result, not return {success:true} before the import has actually run'
);

// scanAndImportScheduleFolderはtriggerScheduleFeedImportOnParentから
// awaitされる前提のため、コールバックベースのfs.readdirのままでは
// 呼び出し元が完了を待てない
assert(
  main.includes('async function scanAndImportScheduleFolder(watchDir, feed) {') &&
  (() => {
    const idx = main.indexOf('async function scanAndImportScheduleFolder(watchDir, feed) {');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('await fs.promises.readdir(watchDir)');
  })(),
  'scanAndImportScheduleFolder must be async and await fs.promises.readdir, or its caller cannot await actual completion'
);

// 検査種別マスタの一覧テーブルは、行側でアイコン列(<td>)を出しているのに
// ヘッダー側に対応する<th>が無く、以降の列(検査種別名・コード・標準所要時間等)が
// 1列ずつヘッダーとずれて表示される不具合があった(「検査マスターの列がずれている」)。
assert(
  masters.includes('<tr><th>アイコン</th><th>検査種別名</th><th>コード</th><th>標準所要時間(分)</th><th>有効</th><th>操作</th></tr>'),
  'Exam-type master table header must include an アイコン column matching the icon <td> each row renders, or every later column is misaligned by one'
);
assert(
  masters.includes('colspan="6" class="text-muted" style="text-align:center;">検査種別が登録されていません'),
  'Exam-type master empty-state row must use colspan=6 to match the 6-column header (including the icon column)'
);

// 端末役割(cfg_terminal_role)は表示設定3件(default_zoom/font_style/bed_card_size)の
// 親機DBへの書き込み結果とは無関係のため、その失敗フラグ(failed)の中で
// setTerminalRoleを呼んではならない。囲うと、表示設定の一時的な失敗だけで
// 役割の切り替えが黙って捨てられ、トーストは表示設定のことしか伝えないため
// 利用者が気付けない。
assert(
  (() => {
    const idx = terminalAccess.indexOf('#btn-save-terminal-behavior');
    if (idx < 0) return false;
    const body = terminalAccess.slice(idx);
    const failedBlockIdx = body.indexOf('if (!failed) {');
    const failedBlockEnd = body.indexOf('\n        }', failedBlockIdx);
    const roleIdx = body.indexOf('App.setTerminalRole(terminalRoleVal)');
    if (failedBlockIdx < 0 || failedBlockEnd < 0 || roleIdx < 0) return false;
    // setTerminalRole が if (!failed) ブロックより後（＝外）にあること
    return roleIdx > failedBlockEnd;
  })(),
  'setTerminalRole must be called outside the if (!failed) block, or a transient failure saving the shared display defaults silently discards the terminal role change'
);

// 保存系ハンドラはAPI.patchが成功してからAppStateへ反映しなければならない。
// 先にAppStateを書き換えると、保存に失敗したときに「保存に失敗しました」と
// 表示しながら画面上は新しい値のまま残り、次のマスタ同期まで実態とずれる。
assert(
  (() => {
    const idx = importNotify.indexOf("document.getElementById('btn-save-misc-notif').onclick");
    if (idx < 0) return false;
    const body = importNotify.slice(idx, idx + 1200);
    const childIdx = body.indexOf('if (isChildMode) {');
    const elseIdx = body.indexOf('} else {', childIdx);
    if (childIdx < 0 || elseIdx < 0) return false;
    const childBranch = body.slice(childIdx, elseIdx);
    const patchIdx = childBranch.indexOf('await API.patch(');
    const stateIdx = childBranch.indexOf('AppState.systemSettings?.find(');
    if (patchIdx < 0 || stateIdx < 0) return false;
    return patchIdx < stateIdx;
  })(),
  'btn-save-misc-notif child branch must await API.patch before mutating AppState, or a failed save leaves the UI showing an unsaved value'
);

// ステータスカスタマイズ画面のNEARLY_DONE既定表示は、しきい値設定
// (nearly_done_minutes)から組み立てなければならない。'あと10分'を固定で
// 使うと、実行時(App._applyThresholds/_applyActionButtonLabels)が
// 'あと15分'等に書き換えるのに対し、この設定画面だけが取り残されて食い違う。
assert(
  statusCustomize.includes('const nearlyDoneDefaultLabel = ndMin > 0') &&
  statusCustomize.includes('NEARLY_DONE: nearlyDoneDefaultLabel') &&
  !/label: 'あと10分'/.test(statusCustomize),
  'status-customize must derive the NEARLY_DONE default label from nearly_done_minutes instead of hardcoding あと10分, or the settings screen disagrees with the rest of the app'
);

// 検査室が1つも選択されていない間(「全検査室の患者一覧」表示中を含む)は
// getMyId()がnullを返し、ポーリング自体が止まって着信・自動アナウンスを
// 一切受信できなくなる不具合があった。特定の検査室に絞れない以上、
// 既知の全検査室を受信対象にしなければならない。
assert(
  (() => {
    const idx = call.indexOf('_getExamRoomListenIds() {');
    const end = call.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes('AppState.examRooms') && body.includes('.map(') && body.includes('.id');
  })(),
  '_getExamRoomListenIds must fall back to all known exam rooms when none is selected, or the terminal goes completely deaf while browsing the all-rooms view'
);

// 病棟ダッシュボードで別の病棟を一時的に閲覧しても、この端末が最初に
// 表示していた病棟(_homeWardId)宛の着信・自動アナウンスを取りこぼしては
// ならない。currentWardIdだけをポーリングすると、他病棟を見ている間
// 自分の病棟宛のメッセージを完全に受信できなくなる。
assert(
  (() => {
    const idx = call.indexOf('_getWardListenIds() {');
    const end = call.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes('_homeWardId') && body.includes('ids.push(this._homeWardId)');
  })(),
  '_getWardListenIds must include _homeWardId in addition to the currently viewed ward, or switching wards silently stops receiving the terminal\'s own ward messages'
);

// 発信中・通話中は、複数ID同時ポーリングに切り替わっても_callSourceIdの
// 単一IDのみを使い続けなければならない(既存の保護をこの変更で壊さないこと)。
assert(
  (() => {
    const idx = call.indexOf("const myIds = (this.isCalling || this.isConnected)");
    if (idx < 0) return false;
    const body = call.slice(idx, idx + 300);
    return body.includes('this._callSourceId || this.getMyId()') && body.includes('.filter(Boolean)');
  })(),
  'startListening must keep polling only _callSourceId while a call is active/in progress, even after switching to multi-id polling for the idle case'
);

// 終了登録(迎え要)時に選ばれた「お迎えに必要なもの」は、status/updateの
// extraFieldsを経由してtransfer_eventsに書き込まれる。唯一のゲートである
// sanitizeStatusExtraFieldsの許可リストに無いと、クライアントが送っても
// サーバー側で黙って落とされる
assert(
  (() => {
    const idx = main.indexOf('function sanitizeStatusExtraFields');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes("'pickup_assistance_type_id'") && body.includes("'pickup_assistance_note'");
  })(),
  'sanitizeStatusExtraFields must allow pickup_assistance_type_id and pickup_assistance_note, or the pickup-assistance selection made at the exam room is silently discarded on save'
);

// pickup_assistance_typesマスターは、既存のexam_typesと同じ汎用テーブル
// CRUD(ALLOWED_TABLES)と楽観的排他(MASTER_REVISION_TABLES)の両方に
// 登録されていないと、設定画面のマスター管理が保存できない/衝突検知が働かない
assert(
  (() => {
    const idx = main.indexOf('const ALLOWED_TABLES = new Set([');
    const end = main.indexOf(']);', idx);
    return idx >= 0 && end > idx && main.slice(idx, end).includes("'pickup_assistance_types'");
  })(),
  'ALLOWED_TABLES must include pickup_assistance_types, or the master management screen cannot save via the generic table CRUD'
);
assert(
  (() => {
    const idx = main.indexOf('const MASTER_REVISION_TABLES = new Set([');
    const end = main.indexOf(']);', idx);
    return idx >= 0 && end > idx && main.slice(idx, end).includes("'pickup_assistance_types'");
  })(),
  'MASTER_REVISION_TABLES must include pickup_assistance_types, or concurrent edits from multiple terminals silently overwrite each other'
);

// 検査室側の2つの遷移経路(手動ボタン・ICスキャン)は、どちらもPICKUP_REQUIRED
// への遷移時に選択モーダルを呼んでextraFieldsへ結果を渡さなければならない。
// {}固定のままだと選択内容が病棟側へ一切伝わらない
assert(
  (() => {
    const idx = examroom.indexOf('async _updateStatus(eventId, newStatus');
    const end = examroom.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = examroom.slice(idx, end);
    return body.includes("this._selectPickupAssistance(bedLabel)") &&
      body.includes('API.updateEventStatus(eventId, newStatus, extraFields');
  })(),
  '_updateStatus must call _selectPickupAssistance and forward its result as extraFields for PICKUP_REQUIRED, or the manual button never conveys pickup-assistance info to the ward'
);
assert(
  (() => {
    const idx = examroom.indexOf('async _handleScan(icValue)');
    const end = examroom.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = examroom.slice(idx, end);
    return body.includes("this._selectPickupAssistance(bedName)") &&
      body.includes('API.updateEventStatus(matchEvent.id, action.toStatus, extraFields');
  })(),
  '_handleScan must call _selectPickupAssistance and forward its result as extraFields for PICKUP_REQUIRED, or scanning to register pickup never conveys the choice to the ward'
);

// 病棟側3箇所(ベッドカード・詳細モーダル・トースト)は、同じUI.pickupAssistanceLabel
// ヘルパーでラベルを解決しなければならない。各所で個別に組み立てると、
// マスター名やotherの扱いが表示箇所ごとに食い違う恐れがある
assert(
  ui.includes('pickupAssistanceLabel(event)') &&
  ui.includes("if (event.pickup_assistance_type_id === 'other')"),
  'UI.pickupAssistanceLabel must exist and handle the other sentinel, or the shared display helper used by bedmap/modal/app is missing or incomplete'
);
assert(
  bedmap.includes('UI.pickupAssistanceLabel(event)') &&
  bedmap.includes('bed-pickup-assist-badge') &&
  bedmap.includes('pickupAssistHtml = `<div class="bed-pickup-assist-badge"') &&
  bedmap.includes('${pickupAssistHtml}'),
  'bedmap.js must compute a pickup-assistance badge via UI.pickupAssistanceLabel AND actually interpolate it into the rendered card, or the ward bed card never shows what is needed for pickup'
);
assert(
  modal.includes('const pickupAssistLabel = UI.pickupAssistanceLabel(event);') &&
  modal.includes('お迎えに必要なもの') &&
  modal.includes('${pickupAssistLabel ? `（${UI.escapeHTML(pickupAssistLabel)}）') &&
  modal.includes("${pickupAssistLabel && event.current_status === 'PICKUP_REQUIRED' ? `"),
  'modal.js must surface UI.pickupAssistanceLabel in both the urgent banner and the info grid (gated to PICKUP_REQUIRED) of the bed detail view, or the ward detail modal never shows or wrongly persists what is needed for pickup'
);
assert(
  (() => {
    const idx = app.indexOf('迎え要通知');
    const end = app.indexOf('\n      }', idx);
    if (idx < 0 || end < idx) return false;
    const body = app.slice(idx, end);
    return body.includes('UI.pickupAssistanceLabel(e)') && body.includes('${assistLabel');
  })(),
  'app.js PICKUP_REQUIRED toast block must call UI.pickupAssistanceLabel and interpolate it into the toast message, or the pop-up notification never conveys what is needed for pickup'
);

// ── 子機同士の通話競合: 同じID(病棟/検査室)を2台以上の端末が表示している場合の対策 ──

// webrtc-signalingのユニキャストは「to」で先着1クライアントに渡した時点で
// キューから消していたため、同じ論理IDを2台の端末が同時に見ている場合、
// 実際に通話中でない側がICE候補やhangupを横取りしてしまっていた。
// 全メッセージ種別をブロードキャストと同じクライアント単位ack管理に統一し、
// 「to」ごとの単一キューに一本化しなければならない
assert(
  !webrtcSignaling.includes('BROADCAST_TYPES') && !webrtcSignaling.includes("`bc:${"),
  'webrtc-signaling.js must not special-case a subset of message types as "broadcast" (bc: prefix) — every message must use the same per-client ack-tracked delivery, or messages addressed to a shared ward/room id are stolen by whichever sibling terminal polls first'
);
assert(
  (() => {
    const idx = webrtcSignaling.indexOf("if (action === 'poll')");
    const end = webrtcSignaling.indexOf("return { success: false, message: 'Not Found' };", idx);
    if (idx < 0 || end < idx) return false;
    const body = webrtcSignaling.slice(idx, end);
    return body.includes('item.ackedBy[client]') && !body.includes('delete queue[id];\n      const ucMessages');
  })(),
  'webrtc-signaling.js poll handler must deliver every message via per-client ack tracking, not a destructive queue[id] drain'
);

// busyハンドラは、既に別の兄弟端末が応答して通話が確立済みなら無視しなければ
// ならない。無いと「片方が応答した直後にもう片方が拒否/無応答タイムアウト」
// という良くあるタイミングで、確立済みの通話が強制切断される
assert(
  (() => {
    const idx = call.indexOf("else if (msg.type === 'busy')");
    const end = call.indexOf("else if (msg.type === 'answered')", idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes('if (this.isConnected) return;');
  })(),
  'the busy handler must ignore a stray busy once this terminal is already connected, or a sibling terminal declining/timing out after another sibling answered tears down the live call'
);

// answeredで待避する端末は、targetIdを残したままだと後続のice/hangupを
// この通話のものとして誤って処理し続けてしまう。_isRingingも見ることで、
// 着信中でない(=無関係な別のダイアログを表示中の)端末が誤ってそのダイアログを
// 閉じないようにする
assert(
  (() => {
    const idx = call.indexOf("else if (msg.type === 'answered')");
    const end = call.indexOf("else if (msg.type === 'speech')", idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes('!this.isConnected && !this.isCalling && this._isRinging') &&
      body.includes('this.targetId = null;') &&
      body.includes('this._pendingIceCandidates = [];');
  })(),
  'the answered handler must gate on _isRinging and clear targetId/_pendingIceCandidates, or a standing-down sibling keeps reacting to the call it did not answer'
);

// ── 子機同士の機能: 端末プレゼンス(在席表示) ──

// 親機自身のローカルUIから「接続機器を切断」した場合、以前はHTTP経由のURLしか
// 用意されておらず親機モードでは何もせずundefinedを返し、呼び出し元は
// success===falseでないことしか見ていないため誤って成功トーストを出していた
assert(
  api.includes("window.electronAPI.dbRequest({ url: 'device/disconnect'"),
  'API.disconnectDevice must fall back to the local electronAPI.dbRequest path in parent mode, or the parent-side disconnect button always no-ops while reporting fake success'
);

// ハートビートは、親機のローカルIPC経路でも送れなければならない(親機自身の
// 画面が実務端末として使われている場合に他の子機から見えるようにするため)
assert(
  api.includes("window.electronAPI.dbRequest({ url: 'device/heartbeat'") &&
  main.includes("if (url === 'device/heartbeat') {"),
  'both API.deviceHeartbeat (client) and the local db-request handler (main.js) must support a device/heartbeat path for the parent terminal itself, or the parent can never appear in another terminal\'s presence list'
);

// 不正なハートビート(deviceId欠落等)は常にsuccess:trueを返してはならない。
// 送信側は「接続中」と表示し続けるのに、実際はレジストリへ書き込まれておらず
// 他端末からは永久に見えなくなるという、気付けない障害だった
assert(
  main.includes('function applyHeartbeat(info, ip) {') &&
  main.includes("if (!sanitizedInfo) return { success: false, message: 'Invalid device heartbeat payload' };"),
  'applyHeartbeat must return success:false for an invalid payload instead of unconditionally acking, or a corrupted device id becomes a silent, undetectable presence outage'
);
assert(
  app.includes("res !== null && res?.unauthorized !== true && res?.success !== false"),
  'the heartbeat client must treat res.success === false as a failure, or it keeps showing "connected" even when the server rejected the payload'
);

// deviceIdの長さ上限はMAX_DEVICE_ID_LENGTH(64)文字ちょうどまで許可しなければ
// ならない(以前は>=で63文字が実質上限というオフバイワンだった)
assert(
  main.includes('if (!deviceId || deviceId.length > MAX_DEVICE_ID_LENGTH) return null;'),
  'sanitizeHeartbeatInfo must reject only ids longer than MAX_DEVICE_ID_LENGTH (using >), not >=, or the documented 64-char max is actually enforced as 63'
);

// 「他に誰がいるか」を見るための一覧に自分自身が含まれてはならない
assert(
  app.includes("const myDeviceId = localStorage.getItem('_device_id') || '';") &&
  app.includes('rawDevices.filter(d => d.deviceId !== myDeviceId)'),
  '_refreshDevicePresence must exclude this terminal\'s own deviceId from the list it renders, or every presence count/popover is inflated by exactly one self-entry'
);

// 親機も、単独運用モードでない限りハートビートを送らなければならない
// (以前は子機モードのみで、親機の画面が実務端末でも他端末から永久に見えなかった)
assert(
  (() => {
    const idx = app.indexOf('await this._repairLocalShareMode();');
    const end = app.indexOf('_applyStandaloneMode', idx);
    if (idx < 0 || end < idx) return false;
    const body = app.slice(idx, end);
    return body.includes('if (!this.isStandalone()) {') && body.includes('this._startHeartbeat();');
  })(),
  'initialize() must start the heartbeat for parent terminals too (gated only on isStandalone), not only for child mode'
);

// lastSeenの経過秒数はサーバー(親機)の時計で計算した値を優先しなければ
// ならない。各端末が自分の時計で計算し直すと、端末間の時計のずれがそのまま
// 誤った「応答なし」表示(またはその見逃し)につながる
assert(
  main.includes('.map(d => ({ ...d, secondsAgo: Math.max(0, Math.floor((now - d.lastSeen) / 1000)) }));'),
  'getActiveDevices must attach a server-computed secondsAgo to each device, or every viewer recomputes elapsed time from its own (possibly skewed) clock'
);
assert(
  devicePresence.includes('if (device && typeof device.secondsAgo === \'number\') return device.secondsAgo;'),
  'DevicePresence.secondsSince must prefer the server-provided secondsAgo over client-side math from a raw lastSeen timestamp'
);
assert(
  networkSettings.includes('DevicePresence.secondsSince(d, now)'),
  'the parent\'s own connected-devices table (network.js) must also use DevicePresence.secondsSince instead of duplicating its own clock-skew-prone calculation'
);

// pageラベルはdevice.mode(端末の役割)にフォールバックしてはならない。
// 空文字のときmodeが漏れて出ると、起動直後は「client」等の意味不明な
// 文字列がそのまま画面名として表示されてしまう
assert(
  !devicePresence.includes('device.page || device.mode') &&
  !app.includes('device.page || device.mode') &&
  !networkSettings.includes('d.page || d.mode'),
  'no device-presence display site may fall back from page to mode, or an empty page value renders the terminal\'s role string (e.g. "client") as if it were a screen name'
);

// ホーム病棟(_homeWardId)はメモリ上だけで確立してはならない。前回終了時に
// たまたま別病棟を一時閲覧していた場合、current_ward_idとして復元される
// その閲覧先が再起動直後の新しいホーム病棟として誤って確立されてしまい、
// 本来のホーム病棟宛の着信・自動アナウンスを再び取りこぼす
assert(
  (() => {
    const idx = call.indexOf('_getWardListenIds() {');
    const end = call.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes("localStorage.getItem('_home_ward_id')") &&
      body.includes("localStorage.setItem('_home_ward_id', wardId)");
  })(),
  '_getWardListenIds must persist _homeWardId to localStorage and read it back on next launch, or the home ward is re-guessed from whatever ward happens to be displayed at restart'
);

// ── スケジュール取り込み: 複数CSVの置換・集計不整合とファイルエラーの黙殺 ──

// フォルダ内に複数CSVがある場合、既存アイテムの置換は全ファイル分を
// まとめて1回だけ行わなければならない。ファイルごとに個別へ置換すると、
// 後続ファイルの書き込みで先行ファイル分が消えてしまい、取り込み件数の
// 集計(全ファイルの合計)とDBの実際の中身(最後のファイル分のみ)が食い違う
assert(
  (() => {
    const idx = main.indexOf('async function scanAndImportScheduleFolder(watchDir, feed) {');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('const parsedFiles = []') &&
      body.includes('commitScheduleFeedImport(feed, parsedFiles)');
  })(),
  'scanAndImportScheduleFolder must parse all CSV files first and commit them together in one call, not replace the feed\'s items once per file'
);
assert(
  (() => {
    const idx = main.indexOf('function commitScheduleFeedImport(feed, parsedFiles)');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('const allItems = succeeded.flatMap(p => p.items)') &&
      body.includes('db.schedule_items.push(...allItems)') &&
      body.indexOf("db.schedule_items = db.schedule_items.filter(x => x.feed_id !== feed.id)") ===
        body.lastIndexOf("db.schedule_items = db.schedule_items.filter(x => x.feed_id !== feed.id)");
  })(),
  'commitScheduleFeedImport must delete the feed\'s existing items exactly once and insert every parsed file\'s items together, or multi-file folder scans lose earlier files\' items'
);

// フォルダ走査中、個別ファイルのfs.statSync等の例外は以前完全に握りつぶされ、
// ログにも取り込み結果にも一切残らなかった(権限エラーやスキャン中の
// ファイル削除等が誰にも気づかれない)。記録した上で処理を継続しなければならない
assert(
  (() => {
    const idx = main.indexOf('async function scanAndImportScheduleFolder(watchDir, feed) {');
    const end = main.indexOf('const parsedFiles = []', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('fileErrors.push(') && body.includes('console.warn(') && !/catch \(e\) \{\}/.test(body);
  })(),
  'scanAndImportScheduleFolder must record per-file stat errors (fileErrors + console.warn) instead of silently swallowing them with an empty catch block'
);

// ── ビデオ通話の全画面表示: IPC経由のBrowserWindow.setFullScreen()に統一 ──

// トグルとは別に、期待状態を明示的に指定できるIPCブリッジが要る
// (ビデオ通話の全画面ボタンは「必ずこの状態にしたい」を指定する)
assert(
  main.includes("handleTrusted('set-fullscreen', (event, value) => {") &&
  main.includes('mainWindow.setFullScreen(Boolean(value));'),
  'main.js must expose a set-fullscreen IPC handler that calls BrowserWindow.setFullScreen() with an explicit desired state, separate from the existing toggle'
);
assert(
  main.includes("handleTrusted('is-fullscreen'"),
  'main.js must expose an is-fullscreen IPC handler so a dialog opened while already fullscreen can sync its initial button state'
);
assert(
  preload.includes("setFullscreen: (value) => ipcRenderer.invoke('set-fullscreen'"),
  'preload.js must bridge the set-fullscreen IPC channel as electronAPI.setFullscreen'
);

// onFullscreenChangedは全体のフルスクリーンボタン(js/app.js)とビデオ通話の
// 全画面ボタン(js/call.js)など、複数の独立した呼び出し元が同時に購読できな
// ければならない。removeAllListeners方式に戻すと、後から購読した側が
// 先に購読していた側のリスナーを消してしまう
assert(
  !preload.includes("ipcRenderer.removeAllListeners('fullscreen-changed')"),
  'preload.js onFullscreenChanged must not use removeAllListeners, or a second subscriber (e.g. the video call fullscreen button) silently unregisters the first (e.g. the app-wide fullscreen indicator)'
);
assert(
  (() => {
    const idx = preload.indexOf('onFullscreenChanged: (callback) => {');
    const end = preload.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = preload.slice(idx, end);
    return body.includes('ipcRenderer.on(') && /return \(\) => /.test(body);
  })(),
  'preload.js onFullscreenChanged must return an unsubscribe function, or per-dialog subscribers (video call) cannot clean up their own listener independently on call end'
);

// js/call.jsはビデオ通話の全画面表示にHTML要素のFullscreen APIを使っては
// ならない。IPC(electronAPI.setFullscreen/isFullscreen/onFullscreenChanged)
// に統一する
assert(
  !call.includes('requestFullscreen') &&
  !call.includes('document.fullscreenElement') &&
  !call.includes("addEventListener('fullscreenchange'"),
  'js/call.js must not use the HTML Fullscreen API for the video call, or the fullscreen state can no longer be driven by BrowserWindow.setFullScreen()'
);
assert(
  call.includes('window.electronAPI.setFullscreen(wantFullscreen)') &&
  call.includes('window.electronAPI.onFullscreenChanged(isFullscreen => {') &&
  call.includes("window.electronAPI.isFullscreen()"),
  'the video call fullscreen button must call the IPC bridge (setFullscreen/onFullscreenChanged/isFullscreen), or Electron never actually enters/exits fullscreen'
);

// Escapeキーでの解除と、通話終了時に「通話が原因で入った全画面表示」だけを
// 自動解除することの両方を維持する
assert(
  (() => {
    const idx = call.indexOf('this._fullscreenEscapeHandler = e => {');
    const end = call.indexOf('\n      };', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes("e.key === 'Escape'") && body.includes('this._isFullscreen');
  })(),
  'js/call.js must exit fullscreen on Escape while the video call is fullscreen'
);
assert(
  (() => {
    const idx = call.indexOf('async cleanupCall(message = \'\') {');
    const end = call.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes('this._unsubscribeFullscreenChanged()') &&
      body.includes('if (this._fullscreenEnteredForCall)') &&
      body.includes('window.electronAPI?.setFullscreen?.(false)');
  })(),
  'cleanupCall must unsubscribe the fullscreen-changed listener and exit fullscreen if this call is the reason it entered fullscreen'
);

// ── 通話ボタンの安全な無効化: mediaDevices API欠如・デバイス列挙結果 ──

// navigator.mediaDevices/getUserMedia/enumerateDevices自体が無い環境でも
// 同期的に例外を投げず判定できる、専用のチェックが要る
assert(
  call.includes('_isMediaDevicesApiAvailable() {') &&
  call.includes("typeof navigator.mediaDevices.getUserMedia === 'function'") &&
  call.includes("typeof navigator.mediaDevices.enumerateDevices === 'function'"),
  'js/call.js must have a synchronous, safe check for navigator.mediaDevices/getUserMedia/enumerateDevices availability before ever calling them'
);
assert(
  call.includes('if (this._isMediaDevicesApiAvailable()) {') &&
  call.includes('navigator.mediaDevices.enumerateDevices().then(devices => {'),
  'the device-select population in showCallSelectionDialog must guard navigator.mediaDevices.enumerateDevices() behind the availability check, or it throws synchronously in environments without the API'
);

// マイクが無ければ音声通話を、マイクまたはカメラが無ければビデオ通話を
// 無効化する。列挙自体の失敗(enumerationFailed)では一律禁止しない
assert(
  (() => {
    const idx = call.indexOf('async _detectMediaCapabilities() {');
    const end = call.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes('enumerationFailed: false') && body.includes('enumerationFailed: true') &&
      body.includes("hasMic: true, hasCam: true, enumerationFailed: true");
  })(),
  '_detectMediaCapabilities must distinguish "no device" from "enumeration failed" and must not report hasMic/hasCam as false merely because enumeration itself threw'
);
assert(
  (() => {
    const idx = call.indexOf('this._detectMediaCapabilities().then(');
    const end = call.indexOf('\n      }', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes('if (enumerationFailed) return;') &&
      body.includes('if (!hasMic) {') &&
      body.includes('if (!hasMic || !hasCam) {');
  })(),
  'showCallSelectionDialog must disable the voice button when no mic is found, the video button when no mic or no camera is found, and must not disable either button when enumeration merely failed'
);

// ── シグナリングのack識別子(client)は他端末から閲覧可能な値を流用してはならない ──

// _device_idはハートビートで送信され、GET /api/device/list を叩ける端末
// (共有APIトークンさえあれば全端末が叩ける)からは他端末の正確な値がそのまま
// 見える。これをclientとして流用すると、それを指定するだけで本来別端末に
// 届くはずのメッセージを先にack(受信済み扱いに)でき、以後その端末は同じ
// メッセージを二度と受け取れなくなる(着信・ICE候補・切断通知等の横取りに
// よる着信妨害)。ハートビート等どのAPIレスポンスにも含まれない、別の秘匿値を
// 使わなければならない
assert(
  (() => {
    const idx = call.indexOf('getClientId() {');
    const end = call.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes("localStorage.getItem('_signaling_client_id')") &&
      !body.includes("localStorage.getItem('_device_id')");
  })(),
  'CallPanel.getClientId must use a dedicated, non-public secret (not the heartbeat _device_id that GET /api/device/list exposes to every token-holding terminal), or any terminal can steal another terminal\'s incoming signaling messages by pre-acking them'
);
assert(
  call.includes("typeof crypto.randomUUID === 'function'"),
  'the signaling client secret generator must prefer crypto.randomUUID() for strong entropy, or the fallback id remains guessable enough to brute-force the ack-stealing attack'
);

// ── 画質変更(lowerVideoQuality)は失敗時に設定・UIを成功扱いにしてはならない ──

// 以前はメディア再取得/replaceTrack()より前にプリセットをlocalStorageへ
// 保存していたため、途中で失敗しても設定とUIだけが新しい画質を騙り、
// 実際の映像は変わっていなかった
assert(
  (() => {
    const idx = call.indexOf('async lowerVideoQuality() {');
    const end = call.indexOf('\n  _onVideoQualityChanged', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    // 元のバグの形そのもの: 「既に最低画質」ガードの直後、通話中かどうかの
    // 分岐にすら入る前に、newPresetKeyを無条件でthis._videoQualityPreset/
    // localStorageへ書き込んでいないこと
    const guardIdx = body.indexOf('if (idx >= order.length - 1)');
    const notInCallIdx = body.indexOf('if (!this.peerConnection || !this.localStream) {');
    if (guardIdx < 0 || notInCallIdx < 0) return false;
    const immediatelyAfterGuard = body.slice(guardIdx, notInCallIdx);
    if (immediatelyAfterGuard.includes("localStorage.setItem('tbs_video_quality'") ||
      immediatelyAfterGuard.includes('this._videoQualityPreset = newPresetKey;')) {
      return false;
    }
    // getUserMedia()での再取得からreplaceTrack()成功までの間にも
    // 現れてはならない(先に保存していたら未達成の画質を騙ることになる)
    const getUserMediaIdx = body.indexOf('await navigator.mediaDevices.getUserMedia(');
    const replaceTrackIdx = body.indexOf('await sender.replaceTrack(newTrack);');
    if (getUserMediaIdx < 0 || replaceTrackIdx < 0 || replaceTrackIdx < getUserMediaIdx) return false;
    const betweenAcquireAndReplace = body.slice(getUserMediaIdx, replaceTrackIdx);
    return !betweenAcquireAndReplace.includes("localStorage.setItem('tbs_video_quality'");
  })(),
  'lowerVideoQuality must persist the new quality preset only after getUserMedia()/replaceTrack() succeed, not before attempting them'
);
assert(
  (() => {
    const idx = call.indexOf('async lowerVideoQuality() {');
    const end = call.indexOf('\n  _onVideoQualityChanged', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    const catchIdx = body.indexOf('} catch (e) {');
    if (catchIdx < 0) return false;
    const catchBody = body.slice(catchIdx);
    return catchBody.includes('if (newStream) newStream.getTracks().forEach(t => t.stop());') &&
      catchBody.includes("UI.toast('画質の変更に失敗しました");
  })(),
  'lowerVideoQuality must stop any newly-acquired stream and warn the user on failure, or a failed switch silently keeps the camera open while claiming success'
);
assert(
  call.includes("throw new Error(sender ? '新しいビデオトラックを取得できませんでした' : '既存の映像senderが見つかりませんでした');"),
  'lowerVideoQuality must treat "got a new track but no matching sender" as a failure (so the new track gets stopped in the catch block), not silently drop the unused track and keep the camera open'
);
assert(
  call.includes('existingTrack.applyConstraints({'),
  'lowerVideoQuality must try applyConstraints() on the existing track before falling back to re-acquiring the camera via getUserMedia()'
);

// ── 検査室端末は親機との通信が全滅しても「接続中」に戻してはならない ──

// 検査室端末では_refreshDataOnce()のeventResultが実通信ではなく常に成功する
// Promise.resolve(...)のダミー値に置き換わっており、残り3件(system_settings/
// 予定フィード/予定項目)はPromise.allSettled()経由で失敗しても前回値へ
// フォールバックするだけで例外を投げない。3件の実通信が全て失敗していても
// ここで明示的に失敗扱いにしないと、_setConnectionStatus(true)が必ず呼ばれ、
// 親機停止・LAN断時にも5秒ごとの通常ポーリングがハートビートや
// ParentServerMonitorの切断検知を毎回上書きし、バックオフも作動しなくなる
assert(
  (() => {
    const idx = app.indexOf('async _refreshDataOnce(wardId, todayMs) {');
    const end = app.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = app.slice(idx, end);
    const eventCheckIdx = body.indexOf("if (eventResult.status === 'rejected') throw eventResult.reason;");
    const partialSyncIdx = body.indexOf('const partialSync');
    if (eventCheckIdx < 0 || partialSyncIdx < 0 || partialSyncIdx < eventCheckIdx) return false;
    const between = body.slice(eventCheckIdx, partialSyncIdx);
    return between.includes('isExamTerminal') && /throw\s/.test(between);
  })(),
  '_refreshDataOnce must treat all-3-auxiliary-requests-failed as an overall failure for exam terminals (whose eventResult is a dummy that never rejects), or the connection banner keeps flapping back to "connected" every 5s while the parent server is actually down'
);

// ── loadMasters()はsystem_settingsの一時的な取得失敗を「空設定」として確定してはならない ──

// staffsは取得失敗時にnullへフォールバックし、Array.isArray()で判定できた場合
// だけAppState.staffsを上書きする(失敗時は前回値を保持する)実装になっている
// 一方、system_settingsが取得失敗時に[]を返しそれをそのまま無条件で
// AppState.systemSettingsへ上書きしていると、子機で30秒ごとに実行される
// loadMasters()の一時的な応答失敗だけで、ステータス表示・通知・表示調整・
// 各種運用設定が既定値へ戻って見えてしまう
assert(
  (() => {
    const idx = app.indexOf('async loadMasters({ silent = false, loadHandover = true } = {}) {');
    const end = app.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = app.slice(idx, end);
    return body.includes("API.getAll('system_settings').then(res => Array.isArray(res?.data) ? res.data : null).catch(() => null)") &&
      body.includes('if (Array.isArray(systemSettings)) {');
  })(),
  "loadMasters must fall back to null (not []) when system_settings fails to fetch, and only overwrite AppState.systemSettings when Array.isArray(systemSettings) is true, or a single transient fetch failure during the 30s master sync wipes the terminal's current settings to defaults"
);

// ── スケジュール取り込み後のCSVアーカイブ/削除の失敗を成功として報告してはならない ──

// unlinkSync/mkdirSync/renameSyncの例外を無条件で握りつぶすと、共有フォルダが
// 読み取り専用等の理由で後処理に失敗しても、DB保存(予定の登録)自体は成功して
// いるためUIには「取り込み成功」としか表示されず、元CSVが監視フォルダに残り
// 続けてインターバル/時刻指定モードで同じCSVを繰り返し取り込んでしまう
assert(
  (() => {
    const idx = main.indexOf('function archiveScheduleFeedFile(filePath, feed, policy) {');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    const deleteCatchIdx = body.indexOf("if (policy.action === 'delete') {");
    if (deleteCatchIdx < 0) return false;
    const afterDelete = body.slice(deleteCatchIdx);
    return afterDelete.includes('success: false') &&
      body.includes('fs.mkdirSync(archiveDir') &&
      body.includes('fs.renameSync(filePath, destPath)') &&
      (body.match(/success: false/g) || []).length >= 3;
  })(),
  'archiveScheduleFeedFile must return {success:false, message} when unlinkSync/mkdirSync/renameSync throw, not silently swallow the exception in an empty catch block, or the UI reports a successful import while the source CSV is left in the watch folder and keeps getting re-imported'
);
assert(
  (() => {
    const idx = main.indexOf('function commitScheduleFeedImport(feed, parsedFiles)');
    const end = main.indexOf('\n}', idx);
    if (idx < 0 || end < idx) return false;
    const body = main.slice(idx, end);
    return body.includes('archiveResult.success === false') &&
      body.includes('archiveWarning') &&
      body.includes("return { success: true, importedCount: allItems.length, message: null, archiveWarning };");
  })(),
  'commitScheduleFeedImport must collect archiveScheduleFeedFile failures into an archiveWarning and return it (success stays true since the DB write itself succeeded), or a failed post-import archive/delete is silently dropped instead of being reported as a partial success'
);
assert(
  !main.includes("retention_policy || { action: 'archive', retentionDays: '30' }"),
  "commitScheduleFeedImport's retention policy default must not claim a retentionDays that archiveScheduleFeedFile never reads and the per-feed settings form never saves, or the unused default misleadingly implies archived CSVs are pruned when they in fact accumulate indefinitely"
);
assert(
  (() => {
    const idx = app.indexOf('window.electronAPI.onScheduleImported(async (');
    const end = app.indexOf('\n        });', idx);
    if (idx < 0 || end < idx) return false;
    const body = app.slice(idx, end);
    const countToastIdx = body.indexOf('count}件のスケジュールを取り込みました');
    if (countToastIdx < 0) return false;
    const afterSuccessToast = body.slice(countToastIdx);
    const ifMessageIdx = afterSuccessToast.indexOf('if (message) {');
    if (ifMessageIdx < 0) return false;
    return afterSuccessToast.indexOf('UI.toast(', ifMessageIdx) > ifMessageIdx;
  })(),
  'onScheduleImported must surface a non-empty message as a separate warning toast even when success !== false, or a partial-success case (schedule saved, but archiving/deleting the source CSV failed) reports as a plain, silent success with no way for the operator to notice'
);

// ── アナウンス定型文の数字入力欄({n})は未入力のまま送信できてはならない ──

// 数字入力欄を含む定型文の送信処理は、入力欄が1つでも空のままだと
// UI.fillAnnouncementTemplateへ渡す前にブロックしてsendAnnounceを呼ばない
// ようにしなければならない。ブロックせずに送信すると、{n}の位置が
// 空文字のままアナウンスとして読み上げ・送信されてしまう
assert(
  (() => {
    const idx = call.indexOf("overlay.querySelectorAll('.btn-send-blank-template').forEach(sendBtn => {");
    const end = call.indexOf('\n    });', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    const guardIdx = body.indexOf("inputs.some(inp => inp.value.trim() === '')");
    const fillIdx = body.indexOf('UI.fillAnnouncementTemplate(');
    return guardIdx >= 0 && fillIdx > guardIdx;
  })(),
  'the blank-template send handler must block (and warn) when any template-blank-input is empty before calling UI.fillAnnouncementTemplate/sendAnnounce, or an announcement with an unfilled {n} slot gets sent as-is'
);
assert(
  (() => {
    const idx = call.indexOf('const templateBtns = templates.map((t, idx) => {');
    const end = call.indexOf("}).join('');", idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    if (!body.includes('UI.splitAnnouncementTemplate(t)') || !body.includes('parsed.hasBlank')) return false;
    // !parsed.hasBlankの分岐は<button>を返さなければならない。<div>等の
    // 非対話要素になると、既存の全定型文がクリック一発で送信できなくなる
    const guardIdx = body.indexOf('if (!parsed.hasBlank) {');
    const blankDivIdx = body.indexOf('announcement-template-item has-blank');
    if (guardIdx < 0 || blankDivIdx < 0 || blankDivIdx < guardIdx) return false;
    const nonBlankBranch = body.slice(guardIdx, blankDivIdx);
    return nonBlankBranch.includes('<button') && nonBlankBranch.includes('btn-send-announcement"');
  })(),
  'templates without {n} must still render as a clickable <button> (btn-send-announcement), or every existing announcement template silently becomes a non-clickable multi-element row and loses one-click sending'
);

// ── 右下のFAB(#btn-call-toggle)は通話状態(発信中/着信中/通話中)をactiveクラスで反映しなければならない ──

// css/style.cssには.call-fab.active(赤くパルスするスタイル)が定義されて
// いるが、それに対応するclassList操作が無いと単なる死んだCSSになり、
// パネルを閉じている間、通話中/着信中であることが一目でわからなくなる
assert(
  (() => {
    const idx = call.indexOf('_updateCallFabState() {');
    const end = call.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes("document.getElementById('btn-call-toggle')") &&
      body.includes('this.isCalling') &&
      body.includes('this.isConnected') &&
      body.includes('this._isRinging') &&
      body.includes("classList.toggle('active'");
  })(),
  '_updateCallFabState must exist and toggle the active class on #btn-call-toggle based on isCalling/isConnected/_isRinging, or the FAB never shows a call-in-progress/incoming-call indicator'
);
assert(
  (call.match(/this\._updateCallFabState\(\);/g) || []).length >= 6,
  '_updateCallFabState must be called from every place isCalling/isConnected/_isRinging change (startCall, showIncomingCallDialog, acceptCall, setConnectedState, cleanupCall, and the answered-by-another-terminal branch of handleSignalingMessage), or some call state transitions leave the FAB showing stale active/inactive state'
);

// ── togglePanel()はshowPanel()/hidePanel()に委譲しなければならない(重複実装の分岐を避ける) ──

// classList.toggle('hidden')を直接呼ぶ独自実装だと、showPanel/hidePanelに
// 副作用(通話状態バッジの更新等)を足した際にtogglePanel側だけ古い挙動の
// ままになりうる
assert(
  (() => {
    const idx = call.indexOf('togglePanel() {');
    const end = call.indexOf('\n  },', idx);
    if (idx < 0 || end < idx) return false;
    const body = call.slice(idx, end);
    return body.includes('this.showPanel()') && body.includes('this.hidePanel()');
  })(),
  'togglePanel must delegate to showPanel()/hidePanel() instead of directly toggling the hidden class, or a future change to either method can silently diverge from the toggle behavior'
);

// ── RBAC(Auth.can/setRole/CONFIG.PERMISSIONS)は撤去済みで、部分的に復活していないこと ──

// ロール切り替えUIが存在しないままAuth.canの呼び出しだけが復活すると、
// cfg_user_roleが常にNURSE既定のままの状態で権限判定が「動いているように
// 見えて実は何も制限しない」死んだアクセス制御に逆戻りする
assert(!fs.existsSync(path.join(root, 'js/auth.js')), 'js/auth.js (RBACモジュール) が復活しています。ロール切り替えUIを伴わないAuth.can()呼び出しは実質何も制限しない飾りの権限チェックになるため、再導入する場合はロール変更手段とセットで設計すること');
assert(!/js\/auth\.js/.test(indexHtml), 'index.htmlがjs/auth.jsを読み込んでいます。RBACモジュールは撤去済みのはずです');
assert(!/\bROLES\s*:/.test(config) && !/\bPERMISSIONS\s*:/.test(config), 'js/config.jsにCONFIG.ROLES/CONFIG.PERMISSIONSが復活しています(RBACモジュールと一緒に撤去済みのはず)');
assert(!/\bAuth\.can\(/.test(history) && !/\bAuth\.requirePermission\(/.test(history), 'js/history.jsにAuth.can()/Auth.requirePermission()の呼び出しが復活しています。Authは撤去済みのはずです');

// ── 端末間チャット(chat_messages)は患者データ扱いを外してはならない ──

// チャット本文と、そこへ記録されるアナウンス文面には患者名が入りうる。
// PATIENT_DATA_TABLESから外れると、APIトークン無しの端末から会話が読めてしまう
assert(
  /const PATIENT_DATA_TABLES = new Set\(\[[^\]]*'chat_messages'[^\]]*\]\);/.test(main),
  'chat_messagesがPATIENT_DATA_TABLESから外れています。チャット本文・アナウンス履歴には患者名が入りうるため、APIトークン必須の患者データ扱いを維持すること'
);

// 上限管理が外れると、追記専用のchat_messagesがDBファイルを無制限に肥大化させる
assert(
  /table === 'chat_messages'\s*\)\s*\{\s*trimTable\(list, CHAT_MESSAGE_MAX_ENTRIES/.test(main),
  'chat_messagesの書き込み経路でtrimTable(CHAT_MESSAGE_MAX_ENTRIES)が呼ばれていません。追記専用テーブルのためDBが無制限に肥大化します'
);
