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

console.log('Security regression checks passed.');
