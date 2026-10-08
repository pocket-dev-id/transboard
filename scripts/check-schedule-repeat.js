'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const {readRoot,extractByBraceEnd} = require('./lib/extract-source');
const receipts = require('../main-modules/import-receipts');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'tb-schedule-repeat-'));
  try {
    fs.writeFileSync(path.join(dir,'a.csv'),'first');
    const feed = {id:'feed',name:'test',watch_dir:dir,retention_policy:{action:'skip'}};
    let db = {schedule_feeds:[feed],schedule_items:[]}, writes=0, client=false, fail=false, changeRole=false, partialArchive=false;
    const source = readRoot('main.js');
    const scan = vm.runInNewContext([
      extractByBraceEnd(source,'function commitScheduleFeedImport('),
      extractByBraceEnd(source,'async function scanAndImportScheduleFolder('),
      'scanAndImportScheduleFolder',
    ].join('\n'), {fs,path,console:{...console,warn:()=>{}},...receipts,
      readDB:()=> JSON.parse(JSON.stringify(db)),writeDB:value=> {db=value;writes++;return true;},
      isClientTerminal:()=>client,notifyScheduleImported:()=>{},
      archiveScheduleFeedFile:file=>{
        if(partialArchive && path.basename(file)==='512.csv') {if(fs.existsSync(file))fs.unlinkSync(file);return {success:true};}
        return {success:!partialArchive,message:'archive unavailable'};
      },
      parseScheduleFeedCsvFile:async (file,currentFeed)=> {
        if(changeRole)client=true;
        if(fail && path.basename(file)==='b.csv') return {success:false,message:'unreadable'};
        return {success:true,rowCount:1,items:[{id:path.basename(file),feed_id:currentFeed.id}],
          contentHash:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
      },
    });
    assert((await scan(dir,feed)).success); assert.strictEqual(writes,1);
    assert((await scan(dir,feed)).skipped); assert.strictEqual(writes,1);
    await scan(dir,feed,{force:true});assert.strictEqual(writes,2);
    fs.writeFileSync(path.join(dir,'b.csv'),'second');fail=true;
    assert(!(await scan(dir,feed)).success);assert.strictEqual(writes,2);
    assert.strictEqual(db.schedule_items[0].id,'a.csv');
    fail=false;
    const batchFeed = {...feed,id:'large'};
    db.schedule_feeds=[batchFeed];
    for(let i=0;i<513;i++) fs.writeFileSync(path.join(dir,`${i}.csv`),'unchanged');
    await scan(dir,batchFeed); const afterLargeBatch=writes;
    await scan(dir,batchFeed);
    assert.strictEqual(writes,afterLargeBatch,'An unchanged 513-file batch must remain deduplicated');
    const archiveFeed = {...batchFeed,id:'archive',retention_policy:{action:'archive'}};
    db.schedule_feeds=[archiveFeed];partialArchive=true;
    await scan(dir,archiveFeed);
    const beforeRetry = writes, itemCount = db.schedule_items.length;
    await scan(dir,archiveFeed);
    assert.strictEqual(writes,beforeRetry,'Partial archive cleanup must not recommit an evicted subset');
    assert.strictEqual(db.schedule_items.length,itemCount,'Pending cleanup must preserve all saved schedules');
    fs.writeFileSync(path.join(dir,'fresh.csv'),'fresh snapshot');
    await scan(dir,archiveFeed);
    const latest = db.schedule_items.filter(item=>item.feed_id===archiveFeed.id);
    assert.strictEqual(latest.length,1,'Old cleanup originals must not enter a fresh full snapshot');
    assert.strictEqual(latest[0].id,'fresh.csv');
    partialArchive=false;
    db.schedule_feeds=[feed];
    fail=false;changeRole=true;
    const beforeRoleChange=writes;
    assert(!(await scan(dir,feed)).success);assert.strictEqual(writes,beforeRoleChange,'A role change during parsing must keep schedules');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
  console.log('Schedule repeat checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
