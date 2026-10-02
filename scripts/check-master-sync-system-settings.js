// App.loadMasters()が、system_settingsの一時的な取得失敗を「空設定」として
// 確定してしまわないことを確認する回帰テスト。
//
// staffsは取得失敗時にnullへフォールバックし、Array.isArray()で判定できた
// 場合だけAppState.staffsを上書きする(失敗時は前回値を保持する)実装に
// なっている一方、system_settingsは取得失敗時に[]を返し、それがそのまま
// 無条件でAppState.systemSettingsへ上書きされていた。子機では30秒ごとに
// loadMasters()が呼ばれるため、一時的な応答失敗だけでステータス表示・通知・
// 表示調整・各種運用設定が既定値へ戻って見えてしまっていた。
//
// js/app.jsはDOM前提のグローバルへ多数依存しておりファイル全体をvmへ読み込むのは
// 現実的でないため、loadMasters()メソッド本体だけを文字列として取り出し、
// 最小限のthis/API/AppStateモックにバインドして直接実行する。
const assert = require('assert');
const vm = require('vm');
const { readRoot, extractMethodBody } = require('./lib/extract-source');

const source = readRoot('js/app.js');

const methodBody = extractMethodBody(source, 'async loadMasters({ silent = false, requireComplete = false } = {}) {');
assert(methodBody, 'loadMasters({ silent })の抽出に失敗しました(js/app.jsの構造が変わった可能性があります)');

function buildHarness(state) {
  const sandbox = {
    console,
    Promise, Date, JSON, Math, Array,
    API: state.API,
    AppState: state.AppState,
    localStorage: { getItem: () => null, setItem: () => {} },
    UI: { toast: () => {} },
  };
  const obj = vm.runInNewContext(`({
    isExamTerminal() { return false; },
    _checkParentIdentity(settings) { __state.checkParentIdentityCalls.push(settings); },
    async loadMasters({ silent = false, requireComplete = false } = {}) {${methodBody}
    },
  })`, Object.assign(sandbox, { __state: state }));
  return obj;
}

function makeAppState() {
  return {
    wards: ['stale-ward'],
    beds: ['stale-bed'],
    allExamRooms: ['stale-room'],
    examRooms: ['stale-room'],
    allExamTypes: ['stale-type'],
    examTypes: ['stale-type'],
    allPickupAssistanceTypes: ['stale-pat'],
    pickupAssistanceTypes: ['stale-pat'],
    allStaffs: ['stale-staff'],
    staffs: ['stale-staff'],
    systemSettings: [{ id: 'notify_volume', value: '80' }],
  };
}

function makeApi(overrides) {
  return Object.assign({
    getWards: async () => [{ id: 'ward-1', name: 'A病棟' }],
    getAllBeds: async () => [{ id: 'bed-1' }],
    getExamRooms: async () => [{ id: 'room-1', is_active: true }],
    getExamTypes: async () => [{ id: 'type-1', is_active: true }],
    getPickupAssistanceTypes: async () => [{ id: 'pat-1', is_active: true }],
    getAllStaffs: async () => [{ id: 'staff-1', is_active: true }],
    getAll: async () => ({ data: [{ id: 'notify_volume', value: '80' }] }),
  }, overrides);
}

async function main() {
  // 1) BUG FIX: system_settingsの取得だけが失敗しても、既に読み込まれている
  //    設定を空配列で上書きしないこと(前回値を保持すること)
  {
    const state = {
      AppState: makeAppState(),
      checkParentIdentityCalls: [],
      API: makeApi({
        getAll: async () => { throw new Error('system_settings unavailable'); },
      }),
    };
    const harness = buildHarness(state);
    const ok = await harness.loadMasters({ silent: true });
    assert.strictEqual(ok, true, 'system_settings以外が成功していれば、loadMasters全体は成功として続行すること');
    assert.strictEqual(state.AppState.systemSettings.length, 1, 'BUG FIX: system_settingsの取得失敗時、既存の設定が空配列で上書きされないこと');
    assert.strictEqual(state.AppState.systemSettings[0].id, 'notify_volume', 'BUG FIX: 取得失敗時は前回値がそのまま保持されること');
    assert.strictEqual(state.checkParentIdentityCalls.length, 0, '取得に失敗した場合、その回はparent identityチェックを行わないこと(新しいデータが無いため)');
    // wards/beds等、他の取得できたマスタは通常通り更新されること
    assert.strictEqual(state.AppState.wards[0].id, 'ward-1', 'system_settings以外のマスタは通常通り更新されること');
  }

  // 2) system_settingsの取得に成功していれば、通常通り最新値へ更新されること
  {
    const state = {
      AppState: makeAppState(),
      checkParentIdentityCalls: [],
      API: makeApi({
        getAll: async () => ({ data: [{ id: 'notify_volume', value: '30' }, { id: 'display_font_scale', value: '1.2' }] }),
      }),
    };
    const harness = buildHarness(state);
    const ok = await harness.loadMasters({ silent: true });
    assert.strictEqual(ok, true, '成功時はtrueを返すこと');
    assert.strictEqual(state.AppState.systemSettings.length, 2, '取得に成功していれば最新のsystem_settingsへ更新されること');
    assert.strictEqual(state.checkParentIdentityCalls.length, 1, '取得に成功していればparent identityチェックが行われること');
  }

  // 3) 初回ロード(前回値が空)でsystem_settingsの取得に失敗した場合、
  //    未定義エラーにならず空配列のままであること
  {
    const state = {
      AppState: { wards: [], beds: [], allExamRooms: [], examRooms: [], allExamTypes: [], examTypes: [],
        allPickupAssistanceTypes: [], pickupAssistanceTypes: [], allStaffs: [], staffs: [], systemSettings: undefined },
      checkParentIdentityCalls: [],
      API: makeApi({
        getAll: async () => { throw new Error('system_settings unavailable'); },
      }),
    };
    const harness = buildHarness(state);
    const ok = await harness.loadMasters({ silent: true });
    assert.strictEqual(ok, true, '初回ロードで前回値が無くてもloadMasters全体は成功として続行すること');
    assert.deepStrictEqual(Array.from(state.AppState.systemSettings), [], '前回値が無い場合は空配列にフォールバックすること(undefinedのままにならないこと)');
  }

  for (const failed of ['staffs', 'settings']) {
    const state = { AppState: makeAppState(), checkParentIdentityCalls: [], API: makeApi(failed === 'staffs'
      ? { getAllStaffs: async () => { throw Error('staffs unavailable'); } }
      : { getAll: async () => { throw Error('settings unavailable'); } }) };
    const harness = buildHarness(state);
    assert.strictEqual(await harness.loadMasters({ silent: true, requireComplete: true }), false, 'Initial sync must require every master table');
    assert.strictEqual(state.AppState.wards[0], 'stale-ward', 'Incomplete initial sync must not publish a mixed snapshot');
  }
  const saved = new Map([['current_ward_id', 'w2']]);
  const appState = { wards: [], currentWardId: null };
  const select = { value: '', closest() { return null; }, replaceChildren() {} };
  const picker = vm.runInNewContext(`({ syncWardSelect() {${extractMethodBody(source, 'syncWardSelect() {')} } })`, {
    AppState: appState, localStorage: { getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v), removeItem: k => saved.delete(k) },
    document: { getElementById: () => select, createElement: () => ({}) }
  });
  picker.isExamTerminal = () => false;
  picker._masterLoadFailed = true;
  picker.syncWardSelect();
  assert.strictEqual(saved.get('current_ward_id'), 'w2', 'Failed fetch must preserve the assigned ward');
  appState.wards = [{ id: 'w1' }, { id: 'w2' }];
  picker._masterLoadFailed = false;
  picker.syncWardSelect();
  assert.strictEqual(appState.currentWardId, 'w2', 'Recovery must restore the assigned ward, not the first ward');
  console.log('Master sync system_settings checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
