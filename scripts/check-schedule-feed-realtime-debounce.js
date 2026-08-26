// リアルタイム監視(chokidarの'add'イベント)のデバウンス処理が、同じ監視
// フォルダに複数のCSVが立て続けに現れた場合(アプリ起動時に既存の複数CSVを
// まとめて検出、運用者が複数ファイルを同時投入等)でも、フォルダ全体を
// scanAndImportScheduleFolder()で1回だけまとめて取り込むことを確認する
// 回帰テスト。
//
// 以前はaddイベントごとにimportScheduleFeedCSV()を単独で呼んでおり、
// commitScheduleFeedImport()は呼び出しごとに「そのフィードの既存アイテムを
// 全削除してから今回渡された分だけ追加」するため、後から処理されたファイルが
// 先に処理されたファイル分の予定を消してしまっていた。
//
// この環境にはchokidar(node_modules)がインストールされていないため、実際の
// ファイルシステム監視は使わず、main.jsから実装コードそのもの(watcher.on('add', ...)
// のハンドラ本体)を文字列として取り出し、Function化して直接実行することで、
// 出荷されるコードそのものの挙動を検証する(再実装のロジックを検証するのではない)。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

const startMarker = "watcher.on('add', filePath => {";
const startIdx = source.indexOf(startMarker);
assert(startIdx >= 0, "watcher.on('add', filePath => { が見つかりません(main.jsの構造が変わった可能性があります)");
const bodyStart = startIdx + startMarker.length;
const endIdx = source.indexOf('\n      });', bodyStart);
assert(endIdx > bodyStart, "'add'ハンドラの終端(\\n      }); )が見つかりません");
const handlerBody = source.slice(bodyStart, endIdx);

// テストでは実装の定数(SCHEDULE_FEED_REALTIME_DEBOUNCE_MS)そのものではなく、
// 短縮した待機時間を注入する。検証したいのは「収束後に1回だけ呼ぶ」という
// デバウンスの性質であり、実際の待機時間の値自体はscripts/check-security-
// regressions.jsの構造チェックで別途担保している
const DEBOUNCE_MS = 80;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeAddHandler(watchDir, feed, debounceTimers, scanStub) {
  const factory = new Function(
    'path', 'scheduleFeedRealtimeDebounceTimers', 'feed', 'scanAndImportScheduleFolder',
    'watchDir', 'console', 'SCHEDULE_FEED_REALTIME_DEBOUNCE_MS', 'setTimeout', 'clearTimeout',
    `return function(filePath) {\n${handlerBody}\n};`
  );
  return factory(path, debounceTimers, feed, scanStub, watchDir, console, DEBOUNCE_MS, setTimeout, clearTimeout);
}

async function main() {
  // 1) 同じフィードへ2件のCSVが立て続けに追加された場合(起動時の既存2ファイル
  //    検出、運用者による同時投入いずれも同じ形)、scanAndImportScheduleFolder()
  //    はデバウンス収束後に1回だけ呼ばれ、両ファイルとも1回のフォルダ走査で
  //    まとめて取り込まれること
  {
    const watchDir = '/fake/watch/dir';
    const feed = { id: 'feed-1', name: 'テストフィード' };
    const debounceTimers = new Map();
    const scanCalls = [];
    const scanStub = (dir, f) => { scanCalls.push({ dir, f }); return Promise.resolve({ success: true }); };
    const addHandler = makeAddHandler(watchDir, feed, debounceTimers, scanStub);

    addHandler(path.join(watchDir, 'ward-a.csv'));
    await sleep(DEBOUNCE_MS / 2);
    assert.strictEqual(scanCalls.length, 0, 'デバウンス待機中はまだscanAndImportScheduleFolderが呼ばれていないこと');
    addHandler(path.join(watchDir, 'ward-b.csv'));
    await sleep(DEBOUNCE_MS / 2);
    assert.strictEqual(scanCalls.length, 0, '2件目のaddでタイマーが延長され、まだ呼ばれていないこと(前提の確認)');
    await sleep(DEBOUNCE_MS);
    assert.strictEqual(scanCalls.length, 1, 'BUG FIX: 2件のCSVが立て続けに追加されても、scanAndImportScheduleFolderは1回だけ呼ばれること(ファイルごとの個別取り込みで互いを上書きしないこと)');
    assert.strictEqual(scanCalls[0].dir, watchDir, 'フォルダ全体を対象に走査すること(単一ファイルだけを渡さないこと)');
    assert.strictEqual(scanCalls[0].f, feed, '対象フィードが正しく渡されること');
  }

  // 2) 拡張子がCSVでないファイルは無視され、タイマーも作られないこと
  {
    const watchDir = '/fake/watch/dir';
    const feed = { id: 'feed-1', name: 'テストフィード' };
    const debounceTimers = new Map();
    const scanCalls = [];
    const scanStub = (dir, f) => { scanCalls.push({ dir, f }); return Promise.resolve({ success: true }); };
    const addHandler = makeAddHandler(watchDir, feed, debounceTimers, scanStub);

    addHandler(path.join(watchDir, 'readme.txt'));
    assert.strictEqual(debounceTimers.size, 0, 'CSV以外のファイルではデバウンスタイマーを作らないこと');
    await sleep(DEBOUNCE_MS * 2);
    assert.strictEqual(scanCalls.length, 0, 'CSV以外のファイルではscanAndImportScheduleFolderを呼ばないこと');
  }

  // 3) デバウンス発火後に新たなCSVが追加された場合は、独立した2回目の走査として
  //    別途スキャンされること(1回発火したら以後ずっと止まったままにならないこと)
  {
    const watchDir = '/fake/watch/dir';
    const feed = { id: 'feed-1', name: 'テストフィード' };
    const debounceTimers = new Map();
    const scanCalls = [];
    const scanStub = (dir, f) => { scanCalls.push({ dir, f }); return Promise.resolve({ success: true }); };
    const addHandler = makeAddHandler(watchDir, feed, debounceTimers, scanStub);

    addHandler(path.join(watchDir, 'ward-a.csv'));
    await sleep(DEBOUNCE_MS * 2);
    assert.strictEqual(scanCalls.length, 1, '1回目のデバウンスが発火すること(前提の確認)');
    assert.strictEqual(debounceTimers.size, 0, '発火後はタイマーが片付けられ、次のaddイベントを受け付けられる状態に戻ること');

    addHandler(path.join(watchDir, 'ward-b.csv'));
    await sleep(DEBOUNCE_MS * 2);
    assert.strictEqual(scanCalls.length, 2, '発火後に新たに追加されたCSVは、独立した2回目の走査としてscanされること');
  }

  // 4) 複数フィードを同時に監視している場合、フィードごとに独立してデバウンス
  //    されること(片方のフィードへのCSV追加が、別フィードの保留中デバウンスへ
  //    影響しないこと)
  {
    const watchDirA = '/fake/watch/dir-a';
    const watchDirB = '/fake/watch/dir-b';
    const feedA = { id: 'feed-a', name: 'フィードA' };
    const feedB = { id: 'feed-b', name: 'フィードB' };
    const debounceTimers = new Map(); // 実装同様、両フィードで1つのMapを共有する
    const scanCalls = [];
    const scanStub = (dir, f) => { scanCalls.push({ dir, f }); return Promise.resolve({ success: true }); };
    const addHandlerA = makeAddHandler(watchDirA, feedA, debounceTimers, scanStub);
    const addHandlerB = makeAddHandler(watchDirB, feedB, debounceTimers, scanStub);

    addHandlerA(path.join(watchDirA, 'a1.csv'));
    await sleep(DEBOUNCE_MS / 2);
    addHandlerB(path.join(watchDirB, 'b1.csv'));
    await sleep(DEBOUNCE_MS * 2);

    assert.strictEqual(scanCalls.length, 2, 'フィードごとに独立して1回ずつ走査されること(合計2回)');
    assert.ok(scanCalls.some((c) => c.dir === watchDirA && c.f === feedA), 'フィードAが自分のフォルダで走査されること');
    assert.ok(scanCalls.some((c) => c.dir === watchDirB && c.f === feedB), 'フィードBが自分のフォルダで走査されること');
  }

  console.log('Schedule feed realtime debounce checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
