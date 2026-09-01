// UI.switchPage(pageId)(js/ui.js)が、電話番号パネル(CallPanel)を開いたまま
// 画面遷移した場合に自動的に閉じることを固定する回帰テスト。
//
// 修正前は、設定タブ離脱時の端末一覧ポーリング停止と同じ場所に電話パネルの
// クリーンアップが無かったため、右下の電話FABから開いたポップアップが
// タブ切り替え後も表示されたままになっていた。
//
// switchPage()はWardDashboard/ExamRoom/Timeline/HistoryView/Settings.render()
// 等の多数のグローバルに依存しているため、それらは呼び出し記録だけ行う
// 最小限のスタブとして与え、メソッド本体そのものを直接実行する。
const assert = require('assert');
const vm = require('vm');
const { readRoot, extractMethodBody } = require('./lib/extract-source');

const source = readRoot('js/ui.js');
const methodBody = extractMethodBody(source, 'switchPage(pageId) {');
assert(methodBody, 'switchPage(pageId)の抽出に失敗しました(js/ui.jsの構造が変わった可能性があります)');
assert(
  methodBody.includes('CallPanel.hidePanel()'),
  'BUG FIX: switchPage()が電話番号パネルを閉じる処理(CallPanel.hidePanel())を呼んでいません'
);

function buildHarness(state) {
  const pages = [{ classList: { remove() {} } }];
  const tabBtns = [{ classList: { remove() {} } }];
  const sandbox = {
    console,
    document: {
      querySelectorAll(sel) {
        if (sel === '.page') return pages;
        if (sel === '.tab-btn') return tabBtns;
        return [];
      },
      getElementById(id) {
        if (id === 'call-panel') return state.callPanelEl;
        if (id.startsWith('page-')) return { classList: { add() {} } };
        return null;
      },
      querySelector(sel) {
        if (sel.startsWith('.tab-btn[data-page=')) return { classList: { add() {} } };
        return null;
      },
    },
    App: { isExamTerminal: () => false },
    WardDashboard: { render: () => state.calls.push('WardDashboard.render') },
    ExamRoom: { render: () => state.calls.push('ExamRoom.render') },
    Timeline: { render: () => state.calls.push('Timeline.render') },
    HistoryView: { render: () => state.calls.push('HistoryView.render') },
    Settings: { render: () => state.calls.push('Settings.render'), _deviceListTimer: null },
    CallPanel: state.CallPanel,
  };
  const obj = vm.runInNewContext(`({
    switchPage(pageId) {${methodBody}
    },
  })`, sandbox);
  return obj;
}

function main() {
  // 1) 電話パネルが開いている状態でタブ切り替えすると、閉じる処理が呼ばれること
  {
    const state = {
      calls: [],
      callPanelEl: { classList: { contains: (c) => c !== 'hidden' /* 開いている(hiddenクラス無し)*/ } },
      CallPanel: { hidePanel: () => state.calls.push('CallPanel.hidePanel') },
    };
    const harness = buildHarness(state);
    harness.switchPage('exam-room');
    assert.ok(
      state.calls.includes('CallPanel.hidePanel'),
      'BUG FIX: 電話パネルが開いている状態でswitchPage()を呼ぶと、CallPanel.hidePanel()が呼ばれること'
    );
  }

  // 2) 電話パネルが既に閉じている場合は、無駄にhidePanel()を呼ばないこと
  {
    const state = {
      calls: [],
      callPanelEl: { classList: { contains: (c) => c === 'hidden' /* 既に閉じている */ } },
      CallPanel: { hidePanel: () => state.calls.push('CallPanel.hidePanel') },
    };
    const harness = buildHarness(state);
    harness.switchPage('timeline');
    assert.ok(
      !state.calls.includes('CallPanel.hidePanel'),
      '電話パネルが既に閉じている場合は、hidePanel()を余計に呼ばないこと'
    );
  }

  // 3) #call-panel要素が見つからない場合(将来のマークアップ変更等)でも例外を投げないこと
  {
    const state = {
      calls: [],
      callPanelEl: null,
      CallPanel: { hidePanel: () => state.calls.push('CallPanel.hidePanel') },
    };
    const harness = buildHarness(state);
    assert.doesNotThrow(() => harness.switchPage('history'), '#call-panel要素が無くても例外を投げないこと');
  }

  console.log('Call panel close-on-navigate checks passed.');
  process.exit(0);
}

main();
