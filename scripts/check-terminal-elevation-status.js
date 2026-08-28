// 接続機器一覧(js/settings/network.js)の「起動権限」列(Windows管理者権限で
// 起動されているかどうか)が正しく動作することを検証する回帰テスト。
//
// main.jsのcheckIsElevated()(実装コードそのものを取り出して直接実行)が
// (a) Windows以外ではnull(判定不能)を返すこと、(b) `net session`が成功
// すれば管理者権限ありと判定すること、(c) 失敗すれば管理者権限なしと
// 判定すること、(d) 結果をキャッシュしプロセス中に一度しかnet.exeを
// 呼ばないことを検証する。
// また、js/settings/network.jsの接続機器一覧テーブルが、isElevatedの
// 3状態(管理者/通常/不明)を正しく表示することを検証する。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

function extract(source, startMarker, endMarker) {
  const idx = source.indexOf(startMarker);
  assert(idx >= 0, `"${startMarker}" が見つかりません`);
  const end = source.indexOf(endMarker, idx);
  assert(end > idx, `"${startMarker}" の終端が見つかりません`);
  return source.slice(idx, end + endMarker.length);
}

// ── checkIsElevated()の実装コードそのものを取り出して直接実行 ──
const cacheDeclSrc = extract(mainSource, 'let _cachedIsElevated = null;', ';');
const checkFnSrc = extract(mainSource, 'function checkIsElevated() {', '\n}');

function makeCheckIsElevated({ platform, execFileImpl }) {
  const factory = new Function(
    'process', 'execFile', 'NET_EXE',
    `${cacheDeclSrc}\n${checkFnSrc}\nreturn checkIsElevated;`
  );
  return factory({ platform }, execFileImpl, '/fake/System32/net.exe');
}

async function main() {
  // (a) Windows以外は判定不能(null)を返し、execFileは呼ばれないこと
  {
    let called = false;
    const checkIsElevated = makeCheckIsElevated({
      platform: 'linux',
      execFileImpl: () => { called = true; },
    });
    const result = await checkIsElevated();
    assert.strictEqual(result, null, 'Windows以外ではnull(判定不能)を返すべき');
    assert.strictEqual(called, false, 'Windows以外ではnet.exeを呼び出すべきではない');
  }

  // (b) Windowsで`net session`が成功(エラー無し)すれば管理者権限ありと判定すること
  {
    let capturedArgs = null;
    const checkIsElevated = makeCheckIsElevated({
      platform: 'win32',
      execFileImpl: (exe, args, opts, cb) => { capturedArgs = { exe, args, opts }; cb(null); },
    });
    const result = await checkIsElevated();
    assert.strictEqual(result, true, 'BUG: net sessionが成功すれば管理者権限ありと判定するべき');
    assert.strictEqual(capturedArgs.exe, '/fake/System32/net.exe', 'net.exeの固定パスで実行するべき(PATH経由のnetコマンドに依存しない)');
    assert.deepStrictEqual(capturedArgs.args, ['session'], "'net session'で判定するべき");
    assert.strictEqual(capturedArgs.opts.windowsHide, true, 'コンソールウィンドウを表示しないべき');
  }

  // (c) Windowsで`net session`が失敗(アクセス拒否等)すれば管理者権限なしと判定すること
  {
    const checkIsElevated = makeCheckIsElevated({
      platform: 'win32',
      execFileImpl: (exe, args, opts, cb) => { cb(new Error('Access is denied.')); },
    });
    const result = await checkIsElevated();
    assert.strictEqual(result, false, 'BUG: net sessionが失敗(管理者権限なし)すればfalseと判定するべき');
  }

  // (d) 結果をキャッシュし、2回目以降はnet.exeを再実行しないこと
  {
    let callCount = 0;
    const checkIsElevated = makeCheckIsElevated({
      platform: 'win32',
      execFileImpl: (exe, args, opts, cb) => { callCount++; cb(null); },
    });
    const first = await checkIsElevated();
    const second = await checkIsElevated();
    assert.strictEqual(first, true);
    assert.strictEqual(second, true);
    assert.strictEqual(callCount, 1, 'BUG: 2回目の呼び出しはキャッシュを使い、net.exeを再実行しないべき(起動中に権限は変化しないため)');
  }

  // ── 関連ファイルの結線を source-text で確認 ──
  const preloadSource = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const networkSource = fs.readFileSync(path.join(ROOT, 'js/settings/network.js'), 'utf8');

  assert(
    mainSource.includes("HEARTBEAT_TEXT_FIELDS = ['name', 'hostname', 'wardId', 'mode', 'page', 'appVersion', 'isElevated']") ||
    /HEARTBEAT_TEXT_FIELDS\s*=\s*\[[^\]]*'isElevated'[^\]]*\]/.test(mainSource),
    'main.jsのHEARTBEAT_TEXT_FIELDSにisElevatedが含まれている必要があります(無いとハートビートで送っても握りつぶされます)'
  );
  assert(
    /handleTrusted\('is-elevated',\s*\(\)\s*=>\s*checkIsElevated\(\)\)/.test(mainSource),
    "main.jsに handleTrusted('is-elevated', ...) が登録されている必要があります"
  );
  assert(
    preloadSource.includes("isElevated: () => ipcRenderer.invoke('is-elevated')"),
    "preload.jsにwindow.electronAPI.isElevated()が公開されている必要があります"
  );
  assert(
    /window\.electronAPI\.isElevated\(\)/.test(appSource) && /isElevated:\s*_cachedIsElevated/.test(appSource),
    'js/app.jsのハートビート送信でisElevatedを取得・送信していません'
  );
  assert(
    networkSource.includes('起動権限'),
    'js/settings/network.jsの接続機器一覧テーブルに「起動権限」列がありません'
  );

  // ── 接続機器一覧テーブルのelevatedHtml算出ロジックを実際に評価して3状態を確認 ──
  const elevatedExprSrc = extract(networkSource, 'const elevatedHtml =', ";\n");
  const buildElevatedHtml = (isElevatedValue) => {
    const factory = new Function('d', `${elevatedExprSrc}\nreturn elevatedHtml;`);
    return factory({ isElevated: isElevatedValue });
  };

  assert(buildElevatedHtml('true').includes('管理者'), 'isElevated:"true"のときは「管理者」と表示するべき');
  assert(buildElevatedHtml('false').includes('通常'), 'isElevated:"false"のときは「通常」と表示するべき');
  assert(buildElevatedHtml(undefined).includes('不明'), 'isElevatedが無い(旧バージョン端末等、判定不能)ときは「不明」と表示するべき');

  console.log('Terminal elevation status checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
