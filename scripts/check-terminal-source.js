'use strict';
const assert = require('assert');
const vm = require('vm');
const { readRoot, extractMethodBody, extractByBraceEnd } = require('./lib/extract-source');
(async () => {
  const stored = new Map([['cfg_share_mode', 'parent'], ['cfg_parent_ip', 'old']]);
  let dbWrites = 0;
  const repair = vm.runInNewContext(`(async function(){${extractMethodBody(readRoot('js/app.js'), 'async _repairLocalShareMode() {')}})`, {
    localStorage: { getItem: k => stored.get(k), setItem: (k,v) => stored.set(k,v) },
    window: { electronAPI: { getTerminalRole: async () => ({ authoritative: true, shareMode: 'client', parentIp: 'TB-MASTER' }), dbRequest: async () => { dbWrites++; return { value: 'parent' }; } } },
    console: { warn() {} },
  });
  await repair.call({ _repairLocalParentIp: async () => {} });
  assert.strictEqual(stored.get('cfg_share_mode'), 'client', 'Persisted role must override stale browser cache');
  assert.strictEqual(stored.get('cfg_parent_ip'), 'TB-MASTER');
  assert.strictEqual(dbWrites, 0, 'Browser must not repair the canonical role from its cache');
  const source = extractByBraceEnd(readRoot('main.js'), 'function saveTerminalConnection(');
  assert(source, 'Atomic connection save must exist');
  let role = { shareMode: 'parent', parentIp: '', terminalRole: 'ward', setupCompleted: true }, token = 'old-token';
  const save = vm.runInNewContext(source + '\nsaveTerminalConnection', {
    readTerminalRole: () => role,
    getTerminalApiToken: () => ({ success: true, token }),
    setTerminalApiToken: t => { token = t; return { success: true }; },
    writeTerminalRole: r => { if (r.parentIp === 'fail') return null; role = r; return r; },
    normalizeShareMode: m => m === 'child' ? 'client' : m,
  });
  assert.strictEqual(save({ mode: 'client', parentIp: 'fail', token: 'new-token' }).success, false);
  assert.strictEqual(token, 'old-token');
  assert.strictEqual(role.shareMode, 'parent');
  assert.strictEqual(save({ mode: 'client', parentIp: 'TB-MASTER', token: 'new-token' }).success, true);
  assert.strictEqual(role.parentIp, 'TB-MASTER');
  assert.strictEqual(role.setupCompleted, false, 'Changed endpoint requires setup validation again');
  console.log('Terminal source checks passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
