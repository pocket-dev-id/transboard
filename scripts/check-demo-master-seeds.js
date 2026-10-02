// Fresh databases must not contain fictional hospital master records, and startup
// must not fill real records with demo phone numbers or bed positions.
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { readRoot, extractBetweenMarkers, extractMethodBody } = require('./lib/extract-source');

const main = readRoot('main.js');
const seedSource = extractBetweenMarkers(main, 'const SEEDS = {', '\n};');
assert(seedSource, 'SEEDS definition must be present');
const seeds = vm.runInNewContext(`({${seedSource.slice('const SEEDS = {'.length).replace(/;$/, '')})`);
for (const table of ['wards', 'beds', 'exam_rooms', 'exam_types', 'pickup_assistance_types', 'staffs']) {
  assert.deepStrictEqual(Array.from(seeds[table]), [], `new DB ${table} must start empty`);
}
assert(!seeds.system_settings.some(setting => setting.id === 'demo_inserted'), 'unused demo_inserted setting must not be seeded');

const app = readRoot('js/app.js');
assert(!app.includes('DemoData.setup()'), 'startup must not mutate master data using demo defaults');
assert(!main.includes("name: \"7階東病棟\""), 'fictional wards must not be seeded');
assert(!main.includes("name: \"看護師A\""), 'fictional staff must not be seeded');
const html = readRoot('index.html');
assert(!html.includes('value="ward-1">7階東病棟'), 'ward picker must not hardcode a demo ward');
async function checkNoWardQueries() {
const api = readRoot('js/api.js');
for (const [name, marker, expected] of [
  ['getActiveEvents', 'async getActiveEvents(wardId) {', []],
  ['getAllEventsForWard', 'async getAllEventsForWard(wardId) {', []],
  ['getWardStatusEvents', 'async getWardStatusEvents(wardId, todayMs) {', { activeEvents: [], todayEvents: [], recentStatusLogs: [], recentAnnouncements: [] }],
]) {
  const body = extractMethodBody(api, marker);
  assert(body, `${name} implementation must exist`);
  let requests = 0;
  const method = vm.runInNewContext(`({ async run(wardId) {${body}
} }).run`, {});
  const actual = await method.call({ getAll: async () => { requests++; return { data: [] }; }, _fetch: async () => { requests++; return { data: [] }; } }, null);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, `${name} without a selected ward returns an empty result`);
  assert.strictEqual(requests, 0, `${name} without a ward must not send an unscoped request`);
}
}
const state = readRoot('js/state.js');
assert(!state.includes("currentWardId: 'ward-1'"), 'initial selected ward must not be a demo id');
assert(!fs.existsSync(path.resolve(__dirname, '..', 'js/demo.js')), 'legacy demo autofill file must be removed');

checkNoWardQueries().then(() => console.log('Demo master seed checks passed.')).catch(error => { console.error(error); process.exitCode = 1; });
