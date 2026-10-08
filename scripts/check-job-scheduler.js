'use strict';
const assert = require('assert');
const { createJobScheduler } = require('../main-modules/job-scheduler');
(async () => {
  let tick, count = 0, complete;
  const timers = { setInterval: fn => { tick = fn; return 1; }, clearInterval() {} };
  const job = createJobScheduler({ mode:'time',times:['08:30'] }, async () => { count++; }, { timers });
  await job.tick(new Date(2026,9,8,8,30)); await job.tick(new Date(2026,9,8,8,30));
  assert.strictEqual(count,1);
  await job.tick(new Date(2026,9,9,8,30)); assert.strictEqual(count,2,'Same scheduled time must run on the next day');
  assert.throws(() => createJobScheduler({mode:'time',times:['25:90']}, ()=>{}, {timers}), /時刻/);
  assert.throws(() => createJobScheduler({mode:'interval',intervalMin:-2}, ()=>{}, {timers}), /間隔/);
  const slow = createJobScheduler({mode:'interval',intervalMin:1}, async () => {
    count++; await new Promise(resolve => { complete=resolve; });
  }, {timers});
  const first=slow.trigger(); await new Promise(r=>setImmediate(r));
  const second=slow.trigger(); assert.strictEqual(first,second,'Concurrent triggers share the same run');
  complete(); await first;
  slow.stop(); await slow.trigger(); assert.strictEqual(count,3,'Stopped jobs cannot restart');
  const errors = [];
  const failed = createJobScheduler({ mode:'interval',intervalMin:1 },
    async () => ({ success: false, message: 'disk full' }), { timers, onError: e => errors.push(e.message) });
  assert.strictEqual((await failed.trigger()).success, false);
  assert.deepStrictEqual(errors, ['disk full'], 'Scheduled failures must reach the error reporter');
  failed.stop();
  console.log('Job scheduler checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
