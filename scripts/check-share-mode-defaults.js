// 未設定の cfg_share_mode を親機や子機に読み替えないこと、
// 修復がマスタ読み込みより前であること、デモ移送の自動投入が無いことを検証する。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

const api = read('js/api.js');
const app = read('js/app.js');
const wizard = read('js/wizard.js');
const demo = read('js/demo.js');
const state = read('js/state.js');
const network = read('js/settings/network.js');
const terminalAccess = read('js/settings/terminal-access.js');
const maintenance = read('js/settings/maintenance.js');

assert(api.includes('function readLocalShareMode()'), 'readLocalShareMode() がありません');
assert(
  api.includes("shareMode === 'client' || shareMode === 'child'"),
  'child は client として扱うこと'
);
assert(!api.includes("getItem('cfg_share_mode') || 'parent'"), 'isClientMode が空設定を親機にしてはいけません');
assert(!app.includes("getItem('cfg_share_mode') || 'parent'"), 'app.js が空設定を親機にしてはいけません');
assert(!app.includes("getItem('cfg_share_mode') || 'client'"), 'ハートビートが空設定を子機にしてはいけません');
assert(!network.includes("getItem('cfg_share_mode') || 'parent'"));
assert(!terminalAccess.includes("getItem('cfg_share_mode') || 'parent'"));
assert(!maintenance.includes("getItem('cfg_share_mode') || 'parent'"));
assert(!wizard.includes("gs('share_mode')"), 'ウィザードは親機から来た share_mode でこの端末の役割を決めてはいけません');

const initIdx = app.indexOf('async init()');
const repairIdx = app.indexOf('await this._repairLocalShareMode()', initIdx);
const loadIdx = app.indexOf('await this.loadMasters()', initIdx);
assert(initIdx >= 0 && repairIdx > initIdx && loadIdx > repairIdx, '修復は loadMasters より前に呼ぶこと');
assert(
  app.includes("if (readLocalShareMode()) {\n      this.startPolling();"),
  '稼働モード未設定のときはポーリングを始めないこと'
);
assert(
  app.includes('稼働モードが未設定です。設定から親機か子機を選んでください'),
  '未設定のときは設定を促すこと'
);

assert(!state.includes('stickyNotes') && !app.includes('stickyNotes'), '未使用の stickyNotes が残っています');
assert(!demo.includes('_insertDemoEvents') && !wizard.includes('wizard-insert-demo'), 'デモ移送の自動投入が残っています');
assert(demo.includes('_ensureExamRoomPhones') && demo.includes('_ensureBedMapPositions'), '検査室電話番号と病床位置の補完は残すこと');

console.log('Share mode default checks passed.');
