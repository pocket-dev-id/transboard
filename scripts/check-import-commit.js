'use strict';
const assert = require('assert');
const vm = require('vm');
const { readRoot, extractByBraceEnd } = require('./lib/extract-source');
(async () => {
  let complete, sent = 0, settled = false;
  const savePromise = new Promise(resolve => { complete = resolve; });
  const odbc = vm.runInNewContext(extractByBraceEnd(readRoot('main-modules/odbc.js'), 'async function runOdbcSyncOnParent(') + '\nrunOdbcSyncOnParent', {
    enforceReadOnlyConnectionString: () => ({ valid: true, connectionString: 'DSN=test' }),
    validateReadOnlyQuery: () => ({ valid: true }),
    execOdbcPowerShell: async () => ({ success: true, output: 'rows' }),
    buildOdbcRowFetchScript: () => '', parseOdbcRows: () => ({ rows: [{}] }),
    commitPatientRows: () => savePromise,
    getMainWindow: () => ({ webContents: { send: () => { sent++; } } }),
  });
  const resultPromise = odbc({ connectionString: 'DSN=test', sqlQuery: 'SELECT * FROM v' }).then(r => { settled = true; return r; });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(settled, false, 'ODBC must wait for DB persistence');
  assert.strictEqual(sent, 0);
  complete({ success: false, message: 'disk full' });
  assert.strictEqual((await resultPromise).success, false);
  assert.strictEqual(sent, 0, 'Failed commit must not publish success');

  let active = 0, maxActive = 0, writes = 0;
  const src = readRoot('main.js');
  const commit = vm.runInNewContext('let patientImportQueue = Promise.resolve();\n' + extractByBraceEnd(src, 'function commitPatientRows(') + '\ncommitPatientRows', {
    readDB: () => ({}), isClientTerminal: () => false,
    planPatientImport: () => ({ updates: [{id:'bed'}], importedCount: 1, clearCount: 0, skipCount: 0, overwrittenActiveBeds: [] }),
    crypto: { randomBytes: () => ({ toString: () => 'test' }) },
    processDbRequest: async (method, url) => {
      if (url.includes('/beds/')) {
        active++; maxActive = Math.max(active, maxActive);
        await new Promise(resolve => setImmediate(resolve));
        active--; writes++; return { success: true };
      }
      return { success: true };
    },
  });
  const results = await Promise.all([commit([{}]), commit([{}]), commit([{}])]);
  assert(results.every(r => r.success));
  assert.strictEqual(writes, 3); assert.strictEqual(maxActive, 1, 'Patient commits must serialize');
  console.log('Import commit checks passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
