const assert = require('assert');
const vm = require('vm');
const { readRoot, extractByBraceEnd } = require('./lib/extract-source');
const text = readRoot('js/settings/network.js').replace(/\r\n/g, '\n');
const marker = 'saveNetworkBtn.onclick = async () => {';
const start = text.indexOf(marker) + marker.length;
const source = text.slice(start, text.indexOf('    }; // if (saveNetworkBtn)', start));
async function save({ outcome = 'ok', failure = false, token = 'new-token' } = {}) {
  const stored = new Map([['cfg_share_mode', 'parent'], ['cfg_parent_ip', '']]);
  const calls = [];
  const sandbox = {
    console: { error() {}, warn() {} }, saveNetworkBtn: {},
    body: { querySelector: key => key.includes('network-mode') ? { value: 'client' } : key === '#cfg-parent-ip' ? { value: '10.0.0.2' } : key === '#cfg-api-token' ? { value: token } : { checked: false } },
    localStorage: { setItem: (k,v) => stored.set(k,v) },
    API: { setTerminalApiToken: async () => { calls.push('token'); return { success: true }; }, patch: async () => { calls.push('shared'); } },
    testParentConnection: async () => ({ outcome }),
    saveLocalShareModeSettings: async () => { if (failure) throw Error('disk'); },
    saveTerminalConnectionSettings: async () => { if (failure) throw Error('disk'); calls.push('saved'); },
    UI: { toast() {}, confirmModal: async () => false },
    window: { electronAPI: { stopParentServer: async () => calls.push('stop') } },
  };
  await vm.runInNewContext(`(async function(){${source}})`, sandbox).call({ _writeLocalSetting() {} });
  return { stored, calls };
}
(async () => {
  for (const opts of [{ outcome: 'token-mismatch' }, { token: '' }, { failure: true }]) {
    const r = await save(opts);
    assert.strictEqual(r.stored.get('cfg_share_mode'), 'parent', 'Rejected or failed save must preserve active mode');
    assert.deepStrictEqual(r.calls, [], 'Rejected save must not modify credentials, shared settings or stop the server');
  }
  const r = await save();
  assert.strictEqual(r.stored.get('cfg_parent_ip'), '10.0.0.2');
  assert.deepStrictEqual(r.calls, ['saved', 'stop'], 'Connection save must not write shared settings');

  const sharedMarker = 'sharedSaveBtn.onclick = async () => {';
  const sharedStart = text.indexOf(sharedMarker) + sharedMarker.length;
  const sharedBody = text.slice(sharedStart, text.indexOf('\n    };\n\n    // 役割ラジオ', sharedStart));
  for (const mode of ['parent', 'client']) {
    const patches = [];
    const shared = vm.runInNewContext(`(async function(){${sharedBody}})`, {
      readLocalShareMode: () => mode, sharedSaveBtn: {},
      body: { querySelector: () => ({ checked: true, value: 'barcode' }) },
      API: { patch: async (table,id,data) => patches.push({table,id,value:data.value}) }, UI: { toast() {} }
    });
    await shared.call({ _writeLocalSetting() {} });
    assert.strictEqual(patches.length, mode === 'parent' ? 5 : 0, 'Only the separate parent save may write shared settings');
    if (mode === 'parent') assert(patches.some(p => p.id === 'patient_id_scan_mode' && p.value === 'barcode'));
  }
  const functionSource = extractByBraceEnd(readRoot('js/api.js'), 'async function saveTerminalConnectionSettings(');
  assert(functionSource, 'Connection persistence helper must exist');
  let db = { share_mode: 'parent', parent_ip: '' };
  let storedToken = 'old-token';
  let writes = 0;
  const helper = vm.runInNewContext(functionSource + '\nsaveTerminalConnectionSettings', {
    window: { electronAPI: { dbRequest: async ({ url }) => ({ value: db[url.split('/').pop()] }) } },
    getTerminalApiToken: async () => storedToken,
    setTerminalApiToken: async token => { storedToken = token; return { success: true }; },
    saveLocalShareModeSettings: async (mode, ip) => {
      db.share_mode = mode;
      if (++writes === 1) throw Error('parent_ip write failed');
      db.parent_ip = ip;
    },
  });
  await assert.rejects(helper('client', '10.0.0.2', 'new-token'), /parent_ip write failed/);
  assert.deepStrictEqual(db, { share_mode: 'parent', parent_ip: '' }, 'Partial DB save must be rolled back');
  assert.strictEqual(storedToken, 'old-token');
  const tokenFailure = vm.runInNewContext(functionSource + '\nsaveTerminalConnectionSettings', {
    window: { electronAPI: { dbRequest: async ({ url }) => ({ value: db[url.split('/').pop()] }) } },
    getTerminalApiToken: async () => storedToken,
    setTerminalApiToken: async token => { storedToken = token; return { success: token === 'old-token', message: 'token write failed' }; },
    saveLocalShareModeSettings: async (mode, ip) => { db = { share_mode: mode, parent_ip: ip }; },
  });
  await assert.rejects(tokenFailure('client', '10.0.0.2', 'new-token'), /token write failed/);
  assert.deepStrictEqual(db, { share_mode: 'parent', parent_ip: '' });
  assert.strictEqual(storedToken, 'old-token', 'Failed credential save must restore the previous token');
  console.log('Network settings save checks passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
