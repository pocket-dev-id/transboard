'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else if (entry.isFile() && entry.name.endsWith('.go')) files.push(fullPath);
  }
  return files;
}

function assertCheck(condition, message) {
  assert(condition, message);
}

const packageJSON = JSON.parse(read('package.json'));
const frontendIndex = read('frontend/index.html');
const bridge = read('frontend/bridge/electron-api-compat.js');
const call = read('frontend/js/call.js');
const goSource = walk(path.join(root, 'internal')).concat([
  path.join(root, 'app.go'),
  path.join(root, 'main.go'),
]).map(file => fs.readFileSync(file, 'utf8')).join('\n');

assertCheck(!packageJSON.main, 'package.json must not declare an Electron entry point');
assertCheck(!packageJSON.scripts.start && !packageJSON.scripts.dist && !packageJSON.scripts.pack, 'Electron packaging scripts must be removed');
assertCheck(!JSON.stringify(packageJSON).includes('electron'), 'package.json must not depend on Electron');
for (const legacyPath of ['main.js', 'preload.js', 'nfc-reader.ps1']) {
  assertCheck(!exists(legacyPath), `${legacyPath} must be removed after the Go cutover`);
}

assertCheck(frontendIndex.includes('wails-options') && frontendIndex.includes('/wails/runtime.js'), 'Wails runtime must be loaded by the frontend');
assertCheck(
  frontendIndex.includes("connect-src 'self'") && !/connect-src[^;]*https?:\/\/\*/.test(frontendIndex),
  'WebView CSP must not allow arbitrary network origins'
);
assertCheck(!/<script[^>]+src=["']https?:\/\//i.test(frontendIndex), 'Frontend must not load remote scripts');

const bridgeMethods = [
  'CompleteDataImport', 'GetWatchDirectory', 'UpdateWatchDirectory', 'ResetDatabase',
  'DBRequest', 'WebrtcRequest', 'ParentHttpRequest', 'TriggerManualImport',
  'TestOdbcConnection', 'RunOdbcSync', 'PreviewOdbcQuery', 'GetLocalIPs', 'GetHostname',
  'RelaunchApp', 'ToggleFullscreen', 'BackupDatabase', 'RestoreDatabase',
  'GetDatabaseStorageInfo', 'ChangeDatabaseStorageMode', 'GetEncryptionStatus',
  'GetArchiveInfo', 'GetDbInfo', 'ExportDiagnosticsBundle', 'GetAppVersion',
  'GetPasscodeStatus', 'VerifyAdminPasscode', 'SetAdminPasscode', 'GetTerminalApiToken',
  'SetTerminalApiToken', 'GetTerminalRole', 'SetTerminalRole', 'CleanupEventRetention',
  'CheckForUpdate', 'DownloadAndInstallUpdate', 'GetUpdateDistInfo', 'ImportUpdateFiles',
  'RollbackUpdateDist', 'GetStartupSetting', 'SetStartupSetting', 'TriggerScheduleFeedImport',
  'ReloadScheduleFeedTriggers', 'GetOdbcDsns', 'GetOdbcTables', 'AppendDebugLog',
  'OpenDebugLog', 'SelectFolder', 'ReadCsvHeaders', 'SetPowerSave', 'SetAlwaysOnTop',
];
for (const method of bridgeMethods) {
  assertCheck(bridge.includes(`invoke('${method}'`) || bridge.includes(`invoke(\"${method}\"`), `Wails bridge is missing ${method}`);
}
assertCheck(bridge.includes("EventsOn('data-imported'") || bridge.includes("on('data-imported'"), 'Wails import event bridge is missing');
assertCheck(bridge.includes("on('card-scanned'") && bridge.includes("on('fullscreen-changed'"), 'Wails native event bridge is incomplete');

assertCheck(goSource.includes('X-API-Token'), 'Go network layer must enforce X-API-Token');
assertCheck(goSource.includes('ConstantTimeCompare'), 'API token comparison must be constant-time');
assertCheck(goSource.includes('WriteBytesAtomic') && goSource.includes('os.Rename'), 'Database writes must remain atomic');
assertCheck(goSource.includes('fsnotify'), 'CSV watching must use fsnotify');
assertCheck(goSource.includes('CryptProtectData') && goSource.includes('CryptUnprotectData'), 'Windows secrets must use DPAPI');
assertCheck(goSource.includes('EncryptBackup') && goSource.includes('DecryptBackup'), 'Backup encryption must remain available');
assertCheck(goSource.includes('PCSC') || goSource.includes('SCARD_'), 'NFC implementation must use the Windows smart-card API');
assertCheck(!call.includes('stun.l.google.com'), 'WebRTC must not depend on a public STUN server');
assertCheck(!goSource.includes('panic('), 'Go production code must not use panic for ordinary error handling');

console.log('Go/Wails security regression checks passed.');
