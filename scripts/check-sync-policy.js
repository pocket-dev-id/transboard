'use strict';
const assert = require('assert');
const vm = require('vm');
const { readRoot, extractMethodBody } = require('./lib/extract-source');
const policy = require('../js/sync-policy');
assert.strictEqual(policy.jitter(1000, 0.2, 250, () => 0), 800);
assert.strictEqual(policy.retry(1000, 3, 5000, () => 0.5), 4000);
assert.strictEqual(policy.retry(1000, 6, 5000, () => 0.5), 5000);
const app = readRoot('js/app.js');
const timers = new Map();
let next = 0;
const timer = cb => { const id = ++next; timers.set(id, cb); return id; };
const clear = id => timers.delete(id);
const state = { pollTimer: null };
const monitor = { destroyCalls: 0, destroy() { this.destroyCalls++; } };
const context = {
  AppState: state, ParentServerMonitor: monitor,
  clearTimeout: clear, clearInterval: clear,
  setTimeout: timer, setInterval: timer,
  SyncPolicy: policy, CONFIG: { POLL_INTERVAL: 5000 },
  document: { querySelector: () => null },
  console,
};
const subject = vm.runInNewContext(`({
  _connectionGeneration: 0, _refreshPromise: null, _pollFailures: 0,
  _jitterDelay(base, ratio) { return SyncPolicy.jitter(base, ratio); },
  _backoffDelay(base, failures, max) { return SyncPolicy.retry(base, failures, max); },
  stopDataMonitors() {${extractMethodBody(app, 'stopDataMonitors() {')}},
  startPolling() {${extractMethodBody(app, 'startPolling() {')}},
  refreshData() { return new Promise(resolve => { this.finishRefresh = resolve; }); },
})`, context);
(async () => {
  subject.startPolling();
  const first = state.pollTimer;
  assert(timers.has(first));
  const running = timers.get(first)();
  subject.stopDataMonitors();
  subject.finishRefresh(true);
  await running;
  assert.strictEqual(timers.size, 0, 'Stopping must prevent an in-flight poll from scheduling another tick');
  assert.strictEqual(monitor.destroyCalls, 1);
  console.log('Sync policy checks passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
