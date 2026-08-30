// 検査室端末の定期更新(App._refreshDataOnce)が、親機との通信が全滅していても
// 接続中として扱ってしまわないことを確認する回帰テスト。
//
// 検査室端末ではeventResultが実通信ではなく常に成功するPromise.resolve(...)の
// ダミー値に置き換えられており、残り3件(system_settings/予定フィード/予定項目)は
// Promise.allSettled()経由で失敗しても前回値へフォールバックするだけで例外を
// 投げない。そのため元の実装では、3件の実通信が全て失敗していても
// _setConnectionStatus(true)が必ず呼ばれ、5秒ごとの通常ポーリングが
// ハートビートやParentServerMonitorの切断検知を毎回上書きしてしまっていた。
//
// js/app.jsはDOM前提のグローバルへ多数依存しておりファイル全体をvmへ読み込むのは
// 現実的でないため、_refreshDataOnce()メソッド本体だけを文字列として取り出し、
// 最小限のthis/API/AppStateモックにバインドして直接実行する。
const assert = require('assert');
const vm = require('vm');
const { readRoot, extractMethodBody } = require('./lib/extract-source');

const source = readRoot('js/app.js');

const methodBody = extractMethodBody(source, 'async _refreshDataOnce(wardId, todayMs) {');
assert(methodBody, '_refreshDataOnce(wardId, todayMs)の抽出に失敗しました(js/app.jsの構造が変わった可能性があります)');

function buildHarness(state) {
  const sandbox = {
    console,
    Promise, Date, JSON, Math,
    API: state.API,
    AppState: state.AppState,
    // catch節がisClientMode()(js/api.js定義、localStorage.getItem('cfg_share_mode')を
    // 見るグローバル関数)を参照するため必要
    localStorage: { getItem: (key) => (key === 'cfg_share_mode' ? 'client' : null) },
    isClientMode: () => true,
    // 部分同期(partialSync)のトースト通知のため必要
    UI: { toast: () => {} },
  };
  const obj = vm.runInNewContext(`({
    isExamTerminal() { return __state.isExamTerminal; },
    _setConnectionStatus(ok, reason = 'network') { __state.statusCalls.push({ ok, reason }); },
    async applySystemVisualSettings() {},
    async _refreshDataOnce(wardId, todayMs) {${methodBody}
    },
  })`, Object.assign(sandbox, { __state: state }));
  return obj;
}

function makeAppState() {
  return {
    currentWardId: 'ward-1',
    activeEvents: ['stale-active'],
    todayEvents: ['stale-today'],
    recentStatusLogs: ['stale-log'],
    systemSettings: ['stale-settings'],
    scheduleFeeds: ['stale-feeds'],
    scheduleItems: ['stale-items'],
  };
}

async function main() {
  // 1) 検査室端末: system_settings/予定フィード/予定項目の3件すべてが失敗した場合、
  //    BUG FIX: _setConnectionStatus(false)が呼ばれ、falseが返ること
  {
    const state = {
      isExamTerminal: true,
      statusCalls: [],
      AppState: makeAppState(),
      API: {
        getWardStatusEvents: async () => { throw new Error('should not be called for exam terminal'); },
        getAll: async () => { throw new Error('system_settings down'); },
        getScheduleFeeds: async () => { throw new Error('feeds down'); },
        getScheduleItemsForRange: async () => { throw new Error('items down'); },
      },
    };
    const harness = buildHarness(state);
    const ok = await harness._refreshDataOnce('ward-1', 0);
    assert.strictEqual(ok, false, 'BUG FIX: 検査室端末で実通信3件が全滅した場合、更新処理はfalseを返すこと');
    assert.ok(
      state.statusCalls.some((c) => c.ok === false),
      'BUG FIX: 検査室端末で実通信3件が全滅した場合、_setConnectionStatus(false)が呼ばれること(通常ポーリングが接続中に戻さないこと)'
    );
    assert.ok(
      !state.statusCalls.some((c) => c.ok === true),
      'BUG FIX: 実通信3件が全滅した場合、_setConnectionStatus(true)は呼ばれないこと'
    );
  }

  // 2) 検査室端末: 3件のうち1件でも成功していれば、従来通り部分同期として
  //    接続中(_setConnectionStatus(true))扱いを維持すること(過検知しないこと)
  {
    const state = {
      isExamTerminal: true,
      statusCalls: [],
      AppState: makeAppState(),
      API: {
        getWardStatusEvents: async () => { throw new Error('should not be called for exam terminal'); },
        getAll: async () => ({ data: ['fresh-settings'] }),
        getScheduleFeeds: async () => { throw new Error('feeds down'); },
        getScheduleItemsForRange: async () => { throw new Error('items down'); },
      },
    };
    const harness = buildHarness(state);
    const ok = await harness._refreshDataOnce('ward-1', 0);
    assert.strictEqual(ok, true, '実通信のうち1件でも成功していれば更新処理はtrueを返すこと(過剰な切断誤検知をしないこと)');
    // vmサンドボックス内で生成されたオブジェクトは別レルムのプロトタイプを持つため
    // deepStrictEqualではなく個々のフィールドを比較する
    assert.strictEqual(state.statusCalls.length, 1, '1件でも成功していれば_setConnectionStatusが1回だけ呼ばれること');
    assert.strictEqual(state.statusCalls[0].ok, true, '1件でも成功していれば接続中(ok=true)として扱われること');
    assert.strictEqual(state.statusCalls[0].reason, 'network', 'reasonは既定値のnetworkであること');
  }

  // 3) 検査室端末: 3件すべて成功していれば従来通り接続中扱いであること
  {
    const state = {
      isExamTerminal: true,
      statusCalls: [],
      AppState: makeAppState(),
      API: {
        getWardStatusEvents: async () => { throw new Error('should not be called for exam terminal'); },
        getAll: async () => ({ data: ['fresh-settings'] }),
        getScheduleFeeds: async () => ['fresh-feed'],
        getScheduleItemsForRange: async () => ['fresh-item'],
      },
    };
    const harness = buildHarness(state);
    const ok = await harness._refreshDataOnce('ward-1', 0);
    assert.strictEqual(ok, true, '実通信3件すべて成功していれば更新処理はtrueを返すこと');
    assert.strictEqual(state.AppState.systemSettings[0], 'fresh-settings', '成功した実データが反映されること');
  }

  // 4) 病棟端末(検査室端末でない)側の挙動は変えないこと: eventResult自体が
  //    実通信で失敗すればこれまで通りfalse/_setConnectionStatus(false)であること
  {
    const state = {
      isExamTerminal: false,
      statusCalls: [],
      AppState: makeAppState(),
      API: {
        getWardStatusEvents: async () => { throw new Error('ward status down'); },
        getAll: async () => ({ data: ['fresh-settings'] }),
        getScheduleFeeds: async () => ['fresh-feed'],
        getScheduleItemsForRange: async () => ['fresh-item'],
      },
    };
    const harness = buildHarness(state);
    const ok = await harness._refreshDataOnce('ward-1', 0);
    assert.strictEqual(ok, false, '病棟端末は従来通りeventResultの失敗だけでfalseを返すこと');
    assert.ok(state.statusCalls.some((c) => c.ok === false), '病棟端末は従来通りeventResultの失敗だけで_setConnectionStatus(false)を呼ぶこと');
  }

  console.log('Exam terminal connection status checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
