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
    const context = { fs,path,crypto,Readable,TextDecoder,structuredClone,console,
      csv: require('csv-parser'), MAX_CSV_ROWS:100000, assertCsvFileSize:()=>{},
      readDB:()=>JSON.parse(JSON.stringify(db)), writeDB:value=>{Object.assign(db,value);return true;}, isClientTerminal:()=>false,
      getJsonSetting:(value,id,fallback)=>id === 'import_retention_policy' ? (value.policy || fallback) : fallback,
      getPatientImportSignature:value=> value.signature || 'config', patientImportGeneration:0,
      registerImportJob:()=> 'job', pendingImportJobs:new Map(), isUtf8:()=>true,
      commitPatientRows:async(_rows,_fileName,options={})=> {
        const receipt = options.patientImportReceipt;
        if (receipt?.skip) {
          const probe = structuredClone(db);
          if (!receipts.recordPatientManifest(probe, receipt.folderKey, receipt.signature, receipt.key, receipt.digest)) {
            return {success:false,message:'manifest full'};
          }
        }
        writes++;
        if (receipt) {
          receipts.recordReceipt(db, receipt.key, receipt.digest);
          if (receipt.skip) receipts.recordPatientManifest(db, receipt.folderKey, receipt.signature, receipt.key, receipt.digest);
        }
        return {success:true,count:1};
      },
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
    context.fs = fs;
    db.signature = undefined;
    db.import_receipts = [];
    db.patient_import_manifests = [];
    db.policy = { action: 'skip' };
    for (let i=0;i<513;i++) fs.writeFileSync(path.join(dir,`skip-${i}.csv`),`bed_number,patient_id\n1,${i}\n`);
    for (let i=0;i<513;i++) { const result = await run()(path.join(dir,`skip-${i}.csv`)); assert(result.success, result.message || result.warning || `failed at ${i}`); }
    assert.strictEqual(db.patient_import_manifests[0].files.length,513,'Skip-mode receipts must retain more than 512 files per source snapshot');
    db.import_receipts = [];
    for (let i=0;i<513;i++) assert((await run()(path.join(dir,`skip-${i}.csv`))).skipped,'Durable skip manifest must suppress unchanged files after receipt-cache eviction');
    assert.strictEqual(writes,516,'Unchanged skip-mode files must not be committed after the 512-entry cache is cleared');
    db.patient_import_manifests = [{ folderKey: 'full-folder', signature: 'config', files: Array.from({length:5000},(_,i)=>({key:`f${i}`,digest:'d'})) }];
    fs.writeFileSync(path.join(dir,'skip-514.csv'),'bed_number,patient_id\n1,514\n');
    const fullResult = await run()(path.join(dir,'skip-514.csv'));
    assert.strictEqual(fullResult.success, false, 'A full durable manifest must refuse a CSV before committing patient data');
    assert.strictEqual(writes,516);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  console.log('CSV repeat checks passed.');
})().catch(error=> {console.error(error);process.exitCode=1;});
