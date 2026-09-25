// ローカルIPCの db-request / webrtc-request が、通してよいURLだけを
// ハンドラの入口で許可していることを検証する。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  isAllowedLocalDbRequestUrl,
  isAllowedWebrtcRequestUrl,
} = require('../main-modules/ipc-routes');

const ROOT = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n');

const tablesMatch = mainSource.match(/const ALLOWED_TABLES = new Set\(\[([\s\S]*?)\]\);/);
assert(tablesMatch, 'main.js の ALLOWED_TABLES が見つかりません');
const allowedTables = new Set([...tablesMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
assert(allowedTables.has('wards'), 'ALLOWED_TABLES に wards がありません');

const allowedUrls = [
  'tables/wards',
  'tables/wards?limit=200',
  '/tables/system_settings/share_mode',
  'tables/transfer_events/ward-status?wardId=1',
  'tables/transfer_events/exam-room-status?roomId=room-1',
  'tables/beds/bulk',
  'device/heartbeat',
  'device/list',
  'device/disconnect',
  'audit/write',
  'status/update',
  'status/note',
  'status/ack',
  'transfer/start',
];
for (const url of allowedUrls) {
  assert.strictEqual(
    isAllowedLocalDbRequestUrl(url, allowedTables),
    true,
    `db-request で許可されるべきURLです: ${url}`
  );
}

const rejectedUrls = [
  'parent-actions/reset',
  'webrtc/send',
  'webrtc/poll',
  'tables/not_a_table',
  'tables/wards/../system_settings',
  'device/heartbeat/extra',
  '',
];
for (const url of rejectedUrls) {
  assert.strictEqual(
    isAllowedLocalDbRequestUrl(url, allowedTables),
    false,
    `db-request では拒否されるべきURLです: ${url}`
  );
}
assert.strictEqual(isAllowedLocalDbRequestUrl(null, allowedTables), false);
assert.strictEqual(isAllowedWebrtcRequestUrl('/webrtc/send'), true);
assert.strictEqual(isAllowedWebrtcRequestUrl('webrtc/poll?id=room-1&client=room-1'), true);
assert.strictEqual(isAllowedWebrtcRequestUrl('webrtc/drop'), false);
assert.strictEqual(isAllowedWebrtcRequestUrl('tables/wards'), false);

const dbHandlerIdx = mainSource.indexOf("handleTrusted('db-request'");
const webrtcHandlerIdx = mainSource.indexOf("handleTrusted('webrtc-request'");
assert(dbHandlerIdx >= 0 && webrtcHandlerIdx > dbHandlerIdx, 'db-request / webrtc-request ハンドラが見つかりません');
const dbHandler = mainSource.slice(dbHandlerIdx, webrtcHandlerIdx);
assert(
  dbHandler.includes('isAllowedLocalDbRequestUrl(url, ALLOWED_TABLES)'),
  'db-request は processDbRequest に入る前に isAllowedLocalDbRequestUrl でURLを拒否すること'
);
const allowIdx = dbHandler.indexOf('isAllowedLocalDbRequestUrl(url, ALLOWED_TABLES)');
const processIdx = dbHandler.indexOf('processDbRequest(');
assert(allowIdx >= 0 && processIdx > allowIdx, 'URL許可チェックは processDbRequest より前にあること');
assert(
  mainSource.includes('isAllowedWebrtcRequestUrl(url)'),
  'webrtc-request は isAllowedWebrtcRequestUrl で send と poll 以外を拒否すること'
);

console.log('IPC route checks passed.');
