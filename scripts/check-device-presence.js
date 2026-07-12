const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'js/device-presence.js'), 'utf8');
const DevicePresence = vm.runInNewContext(`${source}\nDevicePresence;`, {
  Date,
  Math,
  String,
  Array,
  Boolean,
});

const now = new Date('2026-07-13T00:00:30Z').getTime();
const summary = DevicePresence.summarize([
  {
    name: 'Ward A',
    page: 'ward-dashboard',
    wardId: 'ward-1',
    lastSeen: '2026-07-13T00:00:20Z',
    appVersion: '1.1.3',
  },
  {
    name: 'Exam A',
    page: 'exam-room',
    wardId: '',
    lastSeen: '2026-07-13T00:00:00Z',
    appVersion: '1.1.2',
  },
], {
  now,
  currentWardId: 'ward-1',
  parentVersion: '1.1.3',
});

assert.strictEqual(summary.total, 2);
assert.strictEqual(summary.currentWardCount, 1);
assert.strictEqual(summary.examCount, 1);
assert.strictEqual(summary.wardPageCount, 1);
assert.strictEqual(summary.delayedCount, 1);
assert.strictEqual(summary.mismatchCount, 1);
assert.strictEqual(summary.stateClass, 'warn');
assert.match(summary.warningNote, /版違い1/);
assert.match(summary.title, /Ward A/);
assert.match(summary.title, /Exam A/);

const disconnected = DevicePresence.summarize([], {
  hasConnectionProblem: true,
  connectionReason: 'unauthorized',
});

assert.strictEqual(disconnected.stateClass, 'danger');
assert.match(disconnected.childNote, /トークン不一致/);

console.log('Device presence checks passed.');
