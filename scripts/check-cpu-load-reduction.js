// CPU負荷レビューで見つかった2件の修正を検証する回帰テスト。
//
// 1) js/app.js: _refreshDataOnce()(5秒ごとのポーリングから呼ばれる)が、
//    取得したsystemSettingsが前回適用時から変化していない場合、
//    applySystemVisualSettings()(zoom書き換え・classList操作・CSS変数書き換え等)
//    の呼び出しを省略すること。変化があれば必ず呼ぶこと。
// 2) js/examroom.js: _renderQueue()(検査室端末で同じく5秒ごとに呼ばれ続ける)が、
//    対象・患者一覧が前回描画時から変化していなければ、ローディング表示の点滅と
//    キュー本体のDOM再構築を省略すること。ただし病棟確認通知の判定
//    (_notifyWardAcknowledgementChanges)は省略時も必ず実行されること、
//    対象(検査室)が変わった場合・一定時間経過後は必ず再構築されること。
//
// js/app.js・js/examroom.jsはDOM前提のグローバルへ多数依存しておりファイル全体を
// vmへ読み込むのは現実的でないため、対象コードそのものを文字列として取り出し、
// 最小限のモックにバインドして直接実行する。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const examroomSource = fs.readFileSync(path.join(ROOT, 'js/examroom.js'), 'utf8');

function extract(source, startMarker, endMarker) {
  const idx = source.indexOf(startMarker);
  assert(idx >= 0, `"${startMarker}" が見つかりません(ソースの構造が変わった可能性があります)`);
  const end = source.indexOf(endMarker, idx);
  assert(end > idx, `"${startMarker}" の終端(${JSON.stringify(endMarker)})が見つかりません`);
  return source.slice(idx, end + endMarker.length);
}

async function main() {
  // ══════════════════════════════════════════════════
  // 1) js/app.js: applySystemVisualSettings()の呼び出し省略
  // ══════════════════════════════════════════════════
  {
    const startMarker = 'async _refreshDataOnce(wardId, todayMs) {';
    const startIdx = appSource.indexOf(startMarker);
    assert(startIdx >= 0, '_refreshDataOnce(wardId, todayMs)が見つかりません(js/app.jsの構造が変わった可能性があります)');
    const bodyStart = startIdx + startMarker.length;
    const endIdx = appSource.indexOf('\n  },', bodyStart);
    assert(endIdx > bodyStart, '_refreshDataOnceの終端(\\n  },)が見つかりません');
    const methodBody = appSource.slice(bodyStart, endIdx);

    // BUG FIX対象のコードが実際にこのメソッド内にあることを先に確認する
    // (無い場合、以下のシナリオは何もテストせず素通りしてしまうため)
    assert(
      methodBody.includes('_lastAppliedSystemSettingsSignature'),
      '_refreshDataOnce内にsystemSettingsのsignature比較によるapplySystemVisualSettings省略ロジックが見当たりません'
    );

    function buildHarness(state) {
      const sandbox = {
        console,
        Promise, Date, JSON, Math,
        API: state.API,
        AppState: state.AppState,
        localStorage: { getItem: (key) => (key === 'cfg_share_mode' ? 'client' : null) },
        UI: { toast: () => {} },
      };
      const obj = vm.runInNewContext(`({
        _lastAppliedSystemSettingsSignature: __state.initialSignature,
        isExamTerminal() { return __state.isExamTerminal; },
        _setConnectionStatus() {},
        async applySystemVisualSettings() { __state.applyCalls++; },
        async _refreshDataOnce(wardId, todayMs) {${methodBody}
        },
      })`, Object.assign(sandbox, { __state: state }));
      return obj;
    }

    function makeAppState() {
      return {
        currentWardId: 'ward-1',
        activeEvents: [],
        todayEvents: [],
        recentStatusLogs: [],
        systemSettings: [],
        scheduleFeeds: [],
        scheduleItems: [],
      };
    }

    const settingsV1 = [{ id: 'default_zoom', value: '1.0' }];
    const settingsV1Copy = [{ id: 'default_zoom', value: '1.0' }]; // 内容は同じ、参照は別
    const settingsV2 = [{ id: 'default_zoom', value: '1.2' }];

    const state = {
      isExamTerminal: true,
      applyCalls: 0,
      initialSignature: undefined,
      AppState: makeAppState(),
      API: {
        getWardStatusEvents: async () => { throw new Error('should not be called for exam terminal'); },
        getAll: async () => ({ data: state._nextSettings }),
        getScheduleFeeds: async () => [],
        getScheduleItemsForRange: async () => [],
      },
    };
    const harness = buildHarness(state);

    // 1回目: 初回は前回適用値が無いため、必ず適用されること
    state._nextSettings = settingsV1;
    let ok = await harness._refreshDataOnce('ward-1', 0);
    assert.strictEqual(ok, true);
    assert.strictEqual(state.applyCalls, 1, '初回は適用されること');

    // 2回目: 内容が同一(参照は別オブジェクト)なら、BUG FIX: 適用が省略されること
    state._nextSettings = settingsV1Copy;
    ok = await harness._refreshDataOnce('ward-1', 0);
    assert.strictEqual(ok, true);
    assert.strictEqual(
      state.applyCalls, 1,
      'BUG FIX: systemSettingsの内容が変化していなければapplySystemVisualSettings()を再度呼ばないこと(5秒ごとのポーリングでzoom書き換え等が無駄に走り続けるのを防ぐ)'
    );
    // データ自体は省略時も更新されること(表示設定の適用だけを省略し、値の反映は妨げない)
    assert.strictEqual(state.AppState.systemSettings.length, 1);
    assert.strictEqual(state.AppState.systemSettings[0].value, '1.0');

    // 3回目: 内容が変化していれば、必ず再適用されること
    state._nextSettings = settingsV2;
    ok = await harness._refreshDataOnce('ward-1', 0);
    assert.strictEqual(ok, true);
    assert.strictEqual(
      state.applyCalls, 2,
      'systemSettingsの内容が変化していれば必ずapplySystemVisualSettings()を呼ぶこと'
    );
    assert.strictEqual(state.AppState.systemSettings[0].value, '1.2', '変化したsystemSettingsは反映されること');
  }

  // ══════════════════════════════════════════════════
  // 2) js/examroom.js: _renderQueue()のDOM再構築省略
  // ══════════════════════════════════════════════════
  {
    // 対象コードが実際に存在することを先に確認する
    assert(
      examroomSource.includes('_lastQueueSignature') && examroomSource.includes('isFreshSelection'),
      '_renderQueue内にsignature比較によるDOM再構築省略ロジックが見当たりません'
    );
    // 病棟確認通知の判定が、DOM再構築の省略チェックより前(必ず実行される位置)に
    // あることをソース上の位置関係で確認する。ここが逆転すると、省略時に
    // 確認通知(トースト)が届かなくなる
    const notifyIdx = examroomSource.indexOf('this._notifyWardAcknowledgementChanges(relevant);');
    const skipCheckIdx = examroomSource.indexOf('const queueSignature = JSON.stringify([queueKey, relevant]);');
    assert(notifyIdx >= 0 && skipCheckIdx >= 0, '_notifyWardAcknowledgementChangesまたはqueueSignatureの計算が見つかりません');
    assert(
      notifyIdx < skipCheckIdx,
      'BUG: _notifyWardAcknowledgementChanges(病棟確認通知)がDOM再構築の省略チェックより後にあります。省略時に確認通知が届かなくなります'
    );

    // _renderQueue内の「新規選択かどうか」判定と「DOM再構築を省略するかどうか」
    // 判定の2箇所を、実装コードそのものから取り出して直接実行する
    const preFetchStartMarker = "const queueKey = showingAllRooms ? '__all__' : roomId;";
    const preFetchStartIdx = examroomSource.indexOf(preFetchStartMarker);
    assert(preFetchStartIdx >= 0, `"${preFetchStartMarker}" が見つかりません`);
    const preFetchEndIdx = examroomSource.indexOf('\n\n    try {', preFetchStartIdx);
    assert(preFetchEndIdx > preFetchStartIdx, '新規選択判定ブロックの終端が見つかりません');
    const preFetchSrc = examroomSource.slice(preFetchStartIdx, preFetchEndIdx);
    const skipDecisionSrc = extract(
      examroomSource,
      'const queueSignature = JSON.stringify([queueKey, relevant]);',
      'this._lastQueueRenderAt = now;'
    );

    function evalPreFetch({ showingAllRooms, roomId, lastQueueRoomKey }) {
      const container = { innerHTML: '' };
      const historyArea = { hidden: false };
      const historyList = { innerHTML: '' };
      const thisObj = { _lastQueueRoomKey: lastQueueRoomKey };
      const UI = { loadingSpinnerHtml: () => 'SPINNER' };
      const fn = new Function(
        'showingAllRooms', 'roomId', 'container', 'historyArea', 'historyList', 'UI',
        `${preFetchSrc}\nreturn { queueKey, isFreshSelection };`
      );
      const result = fn.call(thisObj, showingAllRooms, roomId, container, historyArea, historyList, UI);
      return { ...result, spinnerShown: container.innerHTML === 'SPINNER' };
    }

    // skipDecisionSrc内の`return;`(省略時の早期return)はnew Functionで作った
    // 関数自体からの通常のreturnとして働く。省略されなかった場合だけ、
    // 抽出したコードの末尾に追加した番兵文字列に到達する。この違いで
    // 「省略されたかどうか」を判定する
    function evalSkipDecision(args) {
      const thisObj = {
        _lastQueueRoomKey: null,
        _lastQueueSignature: args.lastQueueSignature,
        _lastQueueRenderAt: args.lastQueueRenderAt,
        FULL_RENDER_FALLBACK_MS: args.fallbackMs,
      };
      const fn = new Function(
        'queueKey', 'relevant', 'isFreshSelection', 'JSON', 'Date',
        `${skipDecisionSrc}\nreturn 'RENDERED';`
      );
      const result = fn.call(
        thisObj, args.queueKey, args.relevant, args.isFreshSelection,
        JSON, { now: () => args.now }
      );
      return {
        skipped: result !== 'RENDERED',
        storedSignature: thisObj._lastQueueSignature,
        storedRenderAt: thisObj._lastQueueRenderAt,
        storedRoomKey: thisObj._lastQueueRoomKey,
      };
    }

    // ── 新規選択判定(スピナー表示の有無) ──
    {
      const fresh = evalPreFetch({ showingAllRooms: false, roomId: 'room-1', lastQueueRoomKey: null });
      assert.strictEqual(fresh.isFreshSelection, true, '初回(前回描画が無い)は新規選択扱いであること');
      assert.strictEqual(fresh.spinnerShown, true, '新規選択時はローディング表示を出すこと');

      const same = evalPreFetch({ showingAllRooms: false, roomId: 'room-1', lastQueueRoomKey: 'room-1' });
      assert.strictEqual(same.isFreshSelection, false, '同じ検査室への再描画は新規選択扱いにしないこと');
      assert.strictEqual(
        same.spinnerShown, false,
        'BUG FIX: 同じ検査室への再描画(ポーリング)ではローディング表示を出さないこと(点滅を防ぐ)'
      );

      const switched = evalPreFetch({ showingAllRooms: false, roomId: 'room-2', lastQueueRoomKey: 'room-1' });
      assert.strictEqual(switched.isFreshSelection, true, '別の検査室へ切り替えたら新規選択扱いにすること');
      assert.strictEqual(switched.spinnerShown, true, '検査室切替時はローディング表示を出すこと');
    }

    // ── DOM再構築の省略判定 ──
    {
      const relevantA = [{ id: 'evt-1', current_status: 'IN_EXAM' }];
      const relevantB = [{ id: 'evt-1', current_status: 'NEARLY_DONE' }]; // 状態が変化

      // 同一データ・新規選択でない・25秒未満 → 省略されること
      const sig = JSON.stringify(['room-1', relevantA]);
      const skip = evalSkipDecision({
        queueKey: 'room-1', relevant: relevantA, isFreshSelection: false,
        lastQueueSignature: sig, lastQueueRenderAt: 1000, now: 1000 + 10000, fallbackMs: 25000,
      });
      assert.strictEqual(
        skip.skipped, true,
        'BUG FIX: 対象・患者一覧が前回描画時から変化していなければDOM再構築を省略すること'
      );

      // 新規選択の場合は、データが同一でも省略しないこと(切替直後は必ず描画する)
      const freshRender = evalSkipDecision({
        queueKey: 'room-1', relevant: relevantA, isFreshSelection: true,
        lastQueueSignature: sig, lastQueueRenderAt: 1000, now: 1000 + 10000, fallbackMs: 25000,
      });
      assert.strictEqual(freshRender.skipped, false, '新規選択時はsignatureが同じでも省略しないこと');

      // データが変化していれば省略しないこと
      const changedRender = evalSkipDecision({
        queueKey: 'room-1', relevant: relevantB, isFreshSelection: false,
        lastQueueSignature: sig, lastQueueRenderAt: 1000, now: 1000 + 10000, fallbackMs: 25000,
      });
      assert.strictEqual(
        changedRender.skipped, false,
        'BUG: 患者の状態(current_status)が変化しているのに再構築が省略されています'
      );

      // FULL_RENDER_FALLBACK_MSを超えて経過していれば、データ同一でも
      // 強制的に再構築すること(経過時間表示が古いまま固まらないように)
      const staleRender = evalSkipDecision({
        queueKey: 'room-1', relevant: relevantA, isFreshSelection: false,
        lastQueueSignature: sig, lastQueueRenderAt: 1000, now: 1000 + 30000, fallbackMs: 25000,
      });
      assert.strictEqual(
        staleRender.skipped, false,
        'BUG: FULL_RENDER_FALLBACK_MSを超えて経過してもDOM再構築が省略されています。経過時間表示等が固まったままになります'
      );
    }
  }

  console.log('CPU load reduction checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
