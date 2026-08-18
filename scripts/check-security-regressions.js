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
const styles = read('css/style.css');
const modal = read('js/modal.js');
const carryover = read('js/carryover.js');
const examroom = read('js/examroom.js');

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
  config.includes("if (!this.isStatusHidden('ARRIVED')) return actions;") &&
  config.includes('source.ARRIVED || []'),
  'Renderer action availability must expose the combined arrival/exam-start action when ARRIVED is hidden'
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

console.log('Security regression checks passed.');
