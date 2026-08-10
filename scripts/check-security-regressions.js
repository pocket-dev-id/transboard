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
// 現行ビルドは未署名のため、更新は毎回confirmUnsignedUpdateのネイティブ
// ダイアログを経由する(main.js側)。事前確認モーダルの説明文がこれに一切
// 触れないと、予告なく現れたダイアログをユーザーが反射的に「中止」してしまい
// 「ダウンロードしたのに更新が失敗する」体感を生む。事前に案内する文言が
// 後退していないことを保証する。
assert(
  (() => {
    const idx = app.indexOf('_promptInstallUpdate(info)');
    const end = app.indexOf('UI.toast(\'更新をダウンロードしています', idx);
    if (idx < 0 || end < 0 || end <= idx) return false;
    const body = app.slice(idx, end);
    return body.includes('署名なし') && body.includes('続行');
  })(),
  'The pre-download update confirmation must warn that a second native Windows dialog (unsigned-update confirmation) will follow'
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
      writeBody.includes('structuredClone(data)');
  })(),
  'readDB/writeDB must deep-clone the whole DB with structuredClone, not a JSON.stringify/parse round trip (this cost scales with DB size and is paid on every poll from every terminal)'
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
      writeBody.includes('structuredClone(data)') &&
      writeBody.includes('system_settings: data.system_settings.map(');
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

console.log('Security regression checks passed.');
