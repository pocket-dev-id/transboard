'use strict';
const assert = require('assert');
const vm = require('vm');
const { readRoot, extractByBraceEnd } = require('./lib/extract-source');
let writes = 0;
const run = vm.runInNewContext(extractByBraceEnd(readRoot('main.js'), 'function processMasterBulkUpsert(') + '\nprocessMasterBulkUpsert', {
  Set, Map, String, Date, JSON, Math,
  applyMasterRevision: () => null,
  validateMasterReferences: () => null,
  WRITE_HOOKS: { beds: { onUpsert() {}, finalize() {} } },
  appendAuditLog() {},
  summarizeAuditRecord: () => ({}),
  writeDbOrThrow: () => { writes++; },
});
const records = Array.from({ length: 1001 }, (_, i) => ({ id: String(i) }));
const db = { beds: [], bed_occupancy_log: [] };
assert.strictEqual(run('beds', records, db, true).success, false, 'External bulk cap stays in force');
assert.strictEqual(writes, 0);
const result = run('beds', records, db, false);
assert.strictEqual(result.success, true, 'Local import can commit more than 1000 beds atomically');
assert.strictEqual(db.beds.length, 1001);
assert.strictEqual(writes, 1);
console.log('Patient bulk size checks passed.');
