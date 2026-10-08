'use strict';
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { readRoot, extractByBraceEnd } = require('./lib/extract-source');
const receipts = require('../main-modules/import-receipts');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-csv-repeat-'));
  try {
    const file = path.join(dir, 'a.csv');
    fs.writeFileSync(file, 'bed_number,patient_id\n1,123\n');
    let writes = 0;
    const db = {};
    const context = { fs,path,crypto,Readable,TextDecoder,console,
      csv: require('csv-parser'), MAX_CSV_ROWS:100000, assertCsvFileSize:()=>{},
      readDB:()=>JSON.parse(JSON.stringify(db)), writeDB:value=>{Object.assign(db,value);return true;}, isClientTerminal:()=>false,
      getJsonSetting:(_db,id,fallback)=>fallback,
      getPatientImportSignature:value=> value.signature || 'config', patientImportGeneration:0,
      registerImportJob:()=> 'job', pendingImportJobs:new Map(), isUtf8:()=>true,
      commitPatientRows:async()=> { writes++; return {success:true,count:1}; },
      archiveScheduleFeedFile:()=> ({success:true}), mainWindow:null,
      ...receipts,
    };
    const source = extractByBraceEnd(readRoot('main.js'), 'async function importCSV(');
    const run = () => vm.runInNewContext(source+'\nimportCSV', context);
    assert((await run()(file)).success);
    assert((await run()(file)).success);
    assert.strictEqual(writes,1,'Unchanged files must not commit again, including after a restart');
    await run()(file,{force:true}); assert.strictEqual(writes,2);
    fs.writeFileSync(file,'bed_number,patient_id\n1,456\n');
    await run()(file); assert.strictEqual(writes,3);
    context.fs = {...fs,promises:{...fs.promises,readFile:async target=> {
      db.signature='changed-during-read';
      await new Promise(resolve=>setImmediate(resolve));
      return fs.promises.readFile(target);
    }}};
    const stale = await run()(file,{force:true});
    assert.strictEqual(stale.success,false,'Settings changed during source reading must abort');
    assert.strictEqual(writes,3);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  console.log('CSV repeat checks passed.');
})().catch(error=> {console.error(error);process.exitCode=1;});
