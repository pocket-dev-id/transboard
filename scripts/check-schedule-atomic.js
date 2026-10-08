'use strict';
const assert = require('assert');
const vm = require('vm');
const { readRoot, extractByBraceEnd } = require('./lib/extract-source');
const source = readRoot('main.js');
let writes = 0, archives = 0;
const db = { schedule_items: [{ id: 'existing', feed_id: 'feed' }] };
const commit = vm.runInNewContext(extractByBraceEnd(source, 'function commitScheduleFeedImport(') + '\ncommitScheduleFeedImport', {
  readDB: () => db, writeDB: () => { writes++; return true; }, console,
  archiveScheduleFeedFile: () => { archives++; return {success:true}; },
});
const result = commit({id:'feed',name:'test'}, [
  {success:true, filePath:'a.csv',rowCount:1,items:[{id:'new',feed_id:'feed'}]},
  {success:false,filePath:'b.csv',message:'unreadable'},
]);
assert.strictEqual(result.success, false, 'A partial snapshot must fail without replacing existing schedules');
assert.strictEqual(writes, 0);
assert.strictEqual(archives, 0, 'All originals must remain after validation failure');
assert.strictEqual(db.schedule_items[0].id, 'existing');
const emptyInvalid = commit({id:'feed'}, [{success:true,rowCount:2,items:[{id:'one'}],invalidRowCount:1}]);
assert.strictEqual(emptyInvalid.success, false, 'Partially invalid rows must not replace a snapshot');
assert.strictEqual(commit({id:'feed'}, [{success:true,rowCount:0,items:[]}]).success, false,
  'An empty CSV must not erase existing schedules');
console.log('Schedule atomic checks passed.');
