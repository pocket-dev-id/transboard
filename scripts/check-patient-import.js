'use strict';
const assert = require('assert');
const { planPatientImport } = require('../main-modules/patient-import');
const settings = policy => [
  { id: 'import_mapping', value: JSON.stringify({ bed_number: 'bed', patient_id: 'id', patient_name: 'name' }) },
  { id: 'import_retention_policy', value: JSON.stringify(policy) },
];
const beds = [
  { id: 'a', ward_id: 'w1', bed_number: '101', patient_id: 'old' },
  { id: 'b', ward_id: 'w1', bed_number: '102', patient_id: 'keep' },
  { id: 'c', ward_id: 'w2', bed_number: '201', patient_id: 'other-ward' },
];
const db = policy => ({ beds, wards: [{id:'w1'}, {id:'w2'}], system_settings: settings(policy), transfer_events: [] });
const rows = [{ bed:'101', id:'new', name:'患者A' }];
assert.strictEqual(planPatientImport(rows, db({mode:'delta'})).updates.length, 1);
assert.throws(() => planPatientImport(rows, db({mode:'snapshot', clearUnlisted:true})), /対象病棟/);
const legacy = planPatientImport(rows, db({clearUnlisted:true}));
assert.strictEqual(legacy.updates.length, 1, 'Old snapshot settings must continue patient updates');
assert.strictEqual(legacy.clearCount, 0, 'Old snapshot settings must not clear beds without a ward scope');
assert.match(legacy.warning, /対象病棟/);
assert.throws(() => planPatientImport(rows, db({mode:'snapshot',scopeWardIds:['w1'],clearUnlisted:true})), /減少/);
const snapshot = planPatientImport(rows, db({mode:'snapshot',scopeWardIds:['w1'],clearUnlisted:true,maxClearPercent:100}));
assert(snapshot.updates.some(p=>p.id==='b' && p.patient_id===null));
assert(!snapshot.updates.some(p=>p.id==='c'));
assert.throws(() => planPatientImport([...rows, {bed:'unknown'}], db({mode:'snapshot',scopeWardIds:['w1'],clearUnlisted:true,maxClearPercent:100})), /一致率/);
assert.throws(() => planPatientImport(rows, {...db({mode:'delta'}),beds:[...beds,{id:'d',ward_id:'w2',bed_number:'101'}]}), /有効/);
assert.throws(() => planPatientImport([], db({mode:'snapshot',scopeWardIds:['w1']})), /有効/);
const protectedDb = db({mode:'snapshot',scopeWardIds:['w1'],clearUnlisted:true,maxClearPercent:100});
protectedDb.transfer_events=[{bed_id:'b',current_status:'MOVING'}];
assert(!planPatientImport(rows, protectedDb).updates.some(p=>p.id==='b'));
console.log('Patient import checks passed.');
