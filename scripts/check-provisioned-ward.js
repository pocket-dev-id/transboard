// 配布管理ツールが投入した既定の病棟(terminal_role.jsonのwardId)を、
// 画面側が「まだ一度も病棟を選んでいない端末」でだけ採用することを固定する
// 回帰テスト(App._loadTerminalRole、js/app.js)。
//
// 利用者がその後に選び直した病棟を毎起動で配布時の値へ戻してしまうと、
// 病棟をまたいで運用している端末で誤った病棟の患者一覧を表示し続けることに
// なるため、「初回のみ」の条件は明確に固定しておく必要がある。
const assert = require('assert');
const vm = require('vm');
const { readRoot, extractMethodBody } = require('./lib/extract-source');

const source = readRoot('js/app.js');
const methodBody = extractMethodBody(source, 'async _loadTerminalRole() {');
assert(methodBody, '_loadTerminalRole()の抽出に失敗しました(js/app.jsの構造が変わった可能性があります)');

function buildHarness({ stored = {}, roleResult, roleThrows = false } = {}) {
  const state = { store: { ...stored }, getTerminalRoleCalls: 0 };
  const sandbox = {
    console: { warn() {}, log() {} },
    Promise, String,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(state.store, k) ? state.store[k] : null),
      setItem: (k, v) => { state.store[k] = String(v); },
    },
    window: {
      electronAPI: {
        getTerminalRole: async () => {
          state.getTerminalRoleCalls++;
          if (roleThrows) throw new Error('IPC失敗');
          return roleResult;
        },
      },
    },
  };
  const obj = vm.runInNewContext(`({
    async _loadTerminalRole() {${methodBody}
    },
  })`, sandbox);
  return { obj, state };
}

async function main() {
  // 1) 初回起動(役割も病棟も未設定): 配布された役割と病棟の両方が採用されること
  {
    const { obj, state } = buildHarness({ roleResult: { terminalRole: 'ward', wardId: 'ward-3' } });
    await obj._loadTerminalRole();
    assert.strictEqual(state.store.cfg_terminal_role, 'ward', '配布された端末役割が採用されること');
    assert.strictEqual(
      state.store.current_ward_id, 'ward-3',
      'BUG FIX: 配布された既定の病棟が初回起動で採用されること'
    );
  }

  // 2) 利用者が既に病棟を選び直している場合、配布時の値で上書きしないこと
  {
    const { obj, state } = buildHarness({
      stored: { cfg_terminal_role: 'ward', current_ward_id: 'ward-9' },
      roleResult: { terminalRole: 'ward', wardId: 'ward-3' },
    });
    await obj._loadTerminalRole();
    assert.strictEqual(
      state.store.current_ward_id, 'ward-9',
      'BUG FIX: 利用者が選んだ病棟を配布時の既定値で上書きしないこと'
    );
    assert.strictEqual(
      state.getTerminalRoleCalls, 0,
      '役割・病棟とも確定済みなら、毎起動でIPCを呼ばないこと'
    );
  }

  // 2b) 役割が未確定でIPCまで進む場合でも、選択済みの病棟は上書きしないこと。
  //     (2)は早期returnで到達しないため、wardId代入側のガード自体はここで固定する
  {
    const { obj, state } = buildHarness({
      stored: { current_ward_id: 'ward-9' },
      roleResult: { terminalRole: 'ward', wardId: 'ward-3' },
    });
    await obj._loadTerminalRole();
    assert.strictEqual(
      state.store.current_ward_id, 'ward-9',
      'BUG FIX: 役割の取得でIPCを呼ぶ場合でも、選択済みの病棟は配布時の既定値で上書きしないこと'
    );
    assert.strictEqual(state.store.cfg_terminal_role, 'ward', '未確定だった役割は設定されること');
  }

  // 3) 役割は確定済みだが病棟が未選択なら、病棟だけを補完すること
  {
    const { obj, state } = buildHarness({
      stored: { cfg_terminal_role: 'exam' },
      roleResult: { terminalRole: 'exam', wardId: 'ward-5' },
    });
    await obj._loadTerminalRole();
    assert.strictEqual(state.store.current_ward_id, 'ward-5', '病棟だけが未設定なら補完されること');
    assert.strictEqual(state.store.cfg_terminal_role, 'exam', '確定済みの役割は変更しないこと');
  }

  // 4) 配布時に病棟が指定されていなければ、何も書き込まないこと
  {
    const { obj, state } = buildHarness({ roleResult: { terminalRole: 'ward' } });
    await obj._loadTerminalRole();
    assert.strictEqual(
      state.store.current_ward_id, undefined,
      'wardId未指定なら病棟を勝手に確定させないこと(利用者に選ばせる)'
    );
  }

  // 5) IPCが失敗しても例外を投げず、役割は既定値へフォールバックすること
  {
    const { obj, state } = buildHarness({ roleThrows: true });
    await assert.doesNotReject(() => obj._loadTerminalRole(), 'IPC失敗時に例外を投げないこと');
    assert.strictEqual(state.store.cfg_terminal_role, 'ward', 'IPC失敗時は端末役割を既定(ward)にすること');
  }

  console.log('Provisioned ward checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
