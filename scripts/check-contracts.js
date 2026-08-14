'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const contracts = require(path.join(root, 'frontend', 'shared', 'contracts.js'));

function loadBrowserObject(relativePath, expression, globals = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const context = { console, ...globals };
  vm.createContext(context);
  return vm.runInContext(`${source}\n${expression}`, context, { filename: relativePath });
}

const browserContracts = loadBrowserObject('frontend/shared/contracts.js', 'TransboardContracts');
const csv = loadBrowserObject('frontend/js/csv-service.js', 'CSVService');
const config = loadBrowserObject('frontend/js/config.js', 'CONFIG', {
  AppState: {
    getSettingInt(id, fallback) {
      return id === 'nearly_done_minutes' ? 20 : (id === 'soon_threshold_min' ? 7 : fallback);
    },
    getSettingJSON() { return {}; },
  },
});

assert.deepStrictEqual([...contracts.TRANSFER_STATUSES], [...browserContracts.TRANSFER_STATUSES]);
assert.strictEqual(JSON.stringify(contracts.WARD_STATUS_ACTIONS), JSON.stringify(browserContracts.WARD_STATUS_ACTIONS));
assert.strictEqual(JSON.stringify(contracts.EXAM_STATUS_ACTIONS), JSON.stringify(browserContracts.EXAM_STATUS_ACTIONS));
assert.strictEqual(JSON.stringify(contracts.SETTING_CONTRACTS), JSON.stringify(browserContracts.SETTING_CONTRACTS));

assert.strictEqual(contracts.isTransitionAllowed('IN_EXAM', 'RETURNED', [], 'ward'), true);
assert.strictEqual(contracts.isTransitionAllowed('MOVING', 'RETURNED', [], 'ward'), false);
assert.strictEqual(contracts.isTransitionAllowed('MOVING', 'IN_EXAM', ['ARRIVED'], 'exam'), true);
assert.strictEqual(contracts.isTransitionAllowed('MOVING', 'IN_EXAM', [], 'exam'), false);

assert.strictEqual(contracts.normalizeSettingValue('nearly_done_minutes', '30'), 30);
assert.strictEqual(contracts.normalizeSettingValue('nearly_done_minutes', '0'), 10);
assert.strictEqual(contracts.normalizeSettingValue('notification_volume', '0'), 0);
assert.deepStrictEqual(
  contracts.normalizeSettingValue('future_json_setting', '{"enabled":true}', { enabled: false }),
  { enabled: true }
);
assert.deepStrictEqual(
  contracts.normalizeSettingValue('future_json_setting', null, { enabled: false }),
  { enabled: false }
);
assert.deepStrictEqual(
  contracts.normalizeSettingValue('hidden_statuses', '["ARRIVED","IN_EXAM","ARRIVED"]'),
  ['ARRIVED']
);
assert.strictEqual(JSON.stringify(
  browserContracts.normalizeSettingValue('status_colors', '{"MOVING":{"card_bg":"#123456","bad":"red"},"INVALID":"red"}'),
), JSON.stringify({ MOVING: { card_bg: '#123456' } }));
assert.strictEqual(config.getTimingLabel('NEARLY_DONE'), 'あと20分');
assert.strictEqual(config.getTimingLabel('SOON'), 'お迎え目安まであと7分');

const csvText = csv.generate(
  ['bed_number', 'note'],
  [{ bed_number: '701', note: '=1+1' }, { bed_number: '702', note: '患者情報\n引継ぎ' }]
);
assert(csvText.includes("'=1+1"));
assert.strictEqual(JSON.stringify(csv.parse(csvText)), JSON.stringify([
  ['bed_number', 'note'],
  ['701', "'=1+1"],
  ['702', '患者情報\n引継ぎ'],
]));
assert.strictEqual(csv.coerce('12', 'integer'), 12);
assert.strictEqual(csv.coerce('true', 'boolean'), true);
assert.strictEqual(csv.coerce('', 'nullable'), null);
assert.throws(() => csv.coerce('1e3', 'integer'));

console.log('Frontend contract tests passed.');
