'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let output, script, writes = 0, notifications = 0;
const source = fs.readFileSync(path.join(__dirname, '../main-modules/odbc.js'), 'utf8');
const context = { module: { exports: {} }, Buffer, process,
  require(name) {
    if (name === 'child_process') return { execFile(exe, args, options, callback) {
      script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      callback(null, output);
    } };
    return require(name);
  },
};
vm.runInNewContext(source, context);
const odbc = context.module.exports;
odbc.configureOdbc({ getImportSignature: () => 'test',
  commitPatientRows: async rows => { writes++; return {success: true, importedCount: rows.length}; },
  getMainWindow: () => ({ webContents: {send() { notifications++; }} }),
});
const config = {connectionString: 'DSN=test', sqlQuery: 'SELECT * FROM V_BED_STATUS'};
(async () => {
  output = JSON.stringify({rows: [{PATIENT_ID: 'partial'}], columns: ['PATIENT_ID'], truncated: true});
  const rejected = await odbc.runOdbcSyncOnParent(config);
  assert.strictEqual(rejected.success, false, 'Truncated sync must reject the entire result');
  assert.strictEqual(writes, 0); assert.strictEqual(notifications, 0);
  assert.match(rejected.message, /5,000|5000/);
  assert.match(script, /\$rows.Count -ge 5000/, 'Sync must cap reading before collecting an extra row');
  assert.match(script, /FieldCount -gt 128/);
  assert.match(script, /Length -gt 4096/);
  assert.match(script, /totalChars -gt 1000000/);
  output = JSON.stringify({rows: Array.from({length: 5000}, () => ({PATIENT_ID:'a'})), truncated: false});
  assert.strictEqual((await odbc.runOdbcSyncOnParent(config)).success, true);
  assert.strictEqual(writes, 1);
  output = JSON.stringify({rows: Array.from({length: 5001}, () => ({})), truncated: false});
  assert.strictEqual((await odbc.runOdbcSyncOnParent(config)).success, false);
  assert.strictEqual(writes, 1, 'Oversized output must not commit even without truncated flag');
  output = 'ERROR:取得データの文字数が上限を超えました';
  assert.strictEqual((await odbc.runOdbcSyncOnParent(config)).success, false);
  assert.strictEqual(writes, 1);
  output = JSON.stringify({rows: [{}], columns: ['PATIENT_ID'], truncated: true});
  assert.strictEqual((await odbc.previewOdbcQueryOnParent(config)).truncated, true);
  assert.match(script, /\$rows.Count -ge 15/);
  assert.strictEqual(writes, 1, 'Preview must never commit');
  console.log('ODBC result limit checks passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
