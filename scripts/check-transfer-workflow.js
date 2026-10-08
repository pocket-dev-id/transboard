'use strict';
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const workflow = require('../js/transfer-workflow');
const source = fs.readFileSync(path.join(__dirname, '../js/config.js'), 'utf8');
const sandbox = { TransferWorkflow: workflow, AppState: { getSettingJSON: () => ['ARRIVED', 'NEARLY_DONE'] } };
vm.runInNewContext(source + '\nthis.config = CONFIG;', sandbox);
for (const scope of ['ward', 'exam']) {
  const actionMap = scope === 'ward' ? sandbox.config.ACTION_BUTTONS : sandbox.config.EXAM_ROOM_ACTIONS;
  for (const status of Object.keys(actionMap)) {
    assert.deepStrictEqual(
      Array.from(sandbox.config.getAllowedActions(status, scope), action => action.toStatus),
      workflow.allowedActions(status, scope, ['ARRIVED', 'NEARLY_DONE']).map(action => action.toStatus));
  }
}
assert.deepStrictEqual(workflow.allowedActions('MOVING', 'exam', ['ARRIVED']).map(a => a.toStatus), ['IN_EXAM']);
assert.deepStrictEqual(workflow.allowedActions('IN_EXAM', 'exam', ['NEARLY_DONE']).map(a => a.toStatus), ['PICKUP_REQUIRED']);
assert.strictEqual(new Set(workflow.activeStatuses).size, workflow.activeStatuses.length);
console.log('Transfer workflow checks passed.');
