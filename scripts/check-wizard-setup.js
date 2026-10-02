const assert = require('assert');
const vm = require('vm');
const { readRoot, extractByBraceEnd, extractMethodBody } = require('./lib/extract-source');
function context({ token = 'abcdefgh', outcome = 'ok', localFailure = false, sharedFailure = false, wards = [{ id: 'w1', name: '病棟1' }] } = {}) {
  const values = new Map();
  const state = { completed: false, patches: [], toasts: [], role: null, creates: [] };
  const elements = { 'wizard-parent-ip': { value: '10.0.0.1' }, 'wizard-api-token': { value: token } };
  const sandbox = {
    console: { error() {}, warn() {} },
    localStorage: { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) },
    document: { getElementById: k => elements[k], querySelector: () => null },
    window: { electronAPI: { setTerminalRole: async role => { state.role = role; return { success: true }; } } },
    UI: { toast: (...args) => state.toasts.push(args), escapeHTML: String },
    AppState: { wards },
    App: { syncWardSelect() {}, loadMasters: async () => true, refreshData: async () => true, applySystemVisualSettings: async () => {}, _applyStandaloneMode() {}, _applyTerminalRoleMode() {}, _startDevicePresenceMonitor() {}, isExamTerminal: () => false },
    WardDashboard: { render() {} },
    API: { create: async (table, record) => { state.creates.push({ table, record }); return { id: 'ward-new', ...record }; }, setTerminalApiToken: async () => ({ success: true }), patch: async (...args) => { state.patches.push(args); if(sharedFailure) throw Error('disk'); return {success:true}; } },
    testParentConnection: async () => ({ outcome }),
    parentFetch: async () => ({ ok: true, json: async () => ({ data: [{id:'w1',name:'病棟1'}] }) }),
    saveLocalShareModeSettings: async () => { if(localFailure) throw Error('disk'); },
  };
  const wizard = vm.runInNewContext(readRoot('js/wizard.js') + '\nWizard', sandbox);
  wizard.config = { share_mode: 'client', ward_name: '', parent_ip:'10.0.0.1', api_token:token, terminal_role:'ward', ward_id:'w1', device_name:'PC1', default_zoom:'1.0', font_style:'ud' };
  wizard._saveCurrentStepState = () => {};
  wizard._showClientRestartScreen = () => { state.completed = true; };
  wizard.close = () => { state.completed = true; };
  return { wizard, state, values };
}
(async () => {
  const firstWard = context({ wards: [] });
  firstWard.wizard.config.share_mode = 'parent';
  firstWard.wizard.config.terminal_role = 'ward';
  firstWard.wizard.config.ward_name = '内科病棟';
  assert.strictEqual(await firstWard.wizard._ensureInitialWard(), true);
  assert.strictEqual(firstWard.state.creates[0].table, 'wards');
  assert.strictEqual(firstWard.state.creates[0].record.name, '内科病棟');
  assert.strictEqual(firstWard.wizard.config.ward_id, 'ward-new');
  const unnamedWard = context({ wards: [] });
  unnamedWard.wizard.config.share_mode = 'parent';
  assert.strictEqual(await unnamedWard.wizard._ensureInitialWard(), false, 'Blank first ward name must not create a record');
  assert.strictEqual(unnamedWard.state.creates.length, 0);
  const childWard = context({ wards: [] });
  assert.strictEqual(await childWard.wizard._ensureInitialWard(), true, 'Client must not create a parent ward');
  assert.strictEqual(childWard.state.creates.length, 0);

  const empty = context({token:''});
  assert.strictEqual(empty.wizard._validateStep(), false, 'Empty client token must be rejected');
  for (const opts of [{outcome:'token-mismatch'}, {localFailure:true}]) {
    const c = context(opts); await c.wizard.finish();
    assert.strictEqual(c.state.completed,false,'Failed authentication/save must leave setup open');
    assert.notStrictEqual(c.values.get('cfg_wizard_completed'),'true');
  }
  const child = context(); await child.wizard.finish();
  assert.strictEqual(child.state.completed,true);
  assert.strictEqual(child.state.patches.length,0,'Client setup must never patch parent settings');
  assert.strictEqual(child.values.get('cfg_app_zoom'),'1.0');
  assert.strictEqual(child.values.get('cfg_wizard_completed'),'true');
  const parent = context({sharedFailure:true}); parent.wizard.config.share_mode='parent';
  await parent.wizard.finish();
  assert.strictEqual(parent.state.completed,false,'Failed shared settings must not complete setup');
  const apiSandbox = { window:{electronAPI:{dbRequest:async()=>({success:false,message:'disk'})}} };
  const save = vm.runInNewContext(extractByBraceEnd(readRoot('js/api.js'),'async function saveLocalShareModeSettings(') + '\nsaveLocalShareModeSettings',apiSandbox);
  await assert.rejects(save('client','10.0.0.1'),/disk/);
  const storage = new Map([['cfg_share_mode','client'], ['cfg_parent_ip','10.0.0.1'], ['cfg_terminal_role','ward']]);
  let readyToken = 'abcdefgh';
  const ready = vm.runInNewContext(`({ async _isInitialSetupReady() {${extractMethodBody(readRoot('js/app.js'),'async _isInitialSetupReady() {')} } })`, {
    readLocalShareMode: () => storage.get('cfg_share_mode'),
    localStorage: { getItem: k => storage.get(k) || null },
    AppState: { systemSettings: [{ id:'wizard_completed', value:'true' }] },
    API: { getTerminalApiToken: async () => readyToken },
  });
  assert.strictEqual(await ready._isInitialSetupReady(),false,'Parent completion must not complete new client');
  storage.set('cfg_wizard_completed','true');
  assert.strictEqual(await ready._isInitialSetupReady(),true);
  readyToken = '';
  assert.strictEqual(await ready._isInitialSetupReady(),false,'Missing token must reopen setup');
  storage.set('cfg_share_mode','parent');
  ready._terminalSetupPending = true;
  assert.strictEqual(await ready._isInitialSetupReady(),false,'Pending provisioning overrides legacy completion');
  console.log('Wizard setup checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
