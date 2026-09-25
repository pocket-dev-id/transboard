// main-modules/*.js が「読み込めること」だけを確かめる最小のテスト。
//
// 【なぜ必要か】
// 他のcheckスクリプトは、対象ファイルをテキストとして読むか vm で評価する方式の
// ため、実際の require を一度も通さない。check-js-syntax.js も構文検査だけなので、
// 「構文は正しいが読み込むと落ちる」種類の不具合(未定義の識別子をトップレベルで
// 呼ぶ・module.exports に存在しない名前を並べる等)を素通りさせる。
// 実際、main.js から main-modules/ へ切り出した際に
//   - odbc.js が main.js 側に残るべき handleTrusted() をトップレベルで呼んでいる
//   - schedule-csv.js が定義の無い名前を module.exports に並べている
// という2件が同時に混入し、アプリが一切起動しない状態のまま check は全て通って
// いた。require を1回通すだけでこの種の事故は確実に検出できる。
//
// main-modules/* は electron に直接依存せず、依存は configure*() で注入される
// 設計のため、electron を起動せずに require できる(このテストが成立する前提)。
//
// 【このテストで捕まえられないもの】
// 「関数の中で、宣言も注入もされていない裸の識別子を使っている」型の不具合
// (今回の ensureApiToken / processWebrtcRequest / mainWindow がこれに当たる)は、
// その経路を実行するまで表面化しないため、ここでは検出できない。
// 本来は eslint の no-undef のような静的解析で塞ぐべき範囲。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MODULES_DIR = path.join(__dirname, '..', 'main-modules');

const files = fs.readdirSync(MODULES_DIR)
  .filter((name) => name.endsWith('.js'))
  .sort();

assert.ok(files.length > 0, 'main-modules/ に .js が1つも見つかりません(パスの想定が変わった可能性があります)');

const failures = [];
for (const name of files) {
  const modulePath = path.join(MODULES_DIR, name);
  try {
    const loaded = require(modulePath);
    assert.ok(
      loaded && typeof loaded === 'object',
      `${name}: module.exports がオブジェクトではありません`
    );
  } catch (err) {
    failures.push(`  ${name}: ${err.message}`);
  }
}

assert.strictEqual(
  failures.length, 0,
  `main-modules/ の読み込みに失敗しました(この状態ではアプリが起動しません):\n${failures.join('\n')}`
);

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// 切り出したモジュールが export している名前を main.js 側が取り込み忘れると、
// 「その機能を使った瞬間に ReferenceError」になる。main.js が参照しているのに
// どこからも供給されていない名前が無いことを確認する
// (実際に MAX_CSV_ROWS・assertCsvFileSize 等6件の取り込み漏れが発生したため)
for (const name of files) {
  const moduleName = name.replace(/\.js$/, '');
  const requireMarker = `= require('./main-modules/${moduleName}')`;
  const requireIdx = mainSource.indexOf(requireMarker);
  if (requireIdx < 0) continue; // main.js から直接読んでいないモジュール
  const destructured = sliceEnclosingBraces(mainSource, requireIdx);

  for (const exported of Object.keys(require(path.join(MODULES_DIR, name)))) {
    // main.js が使っていない export は取り込まれていなくて当然なので、
    // 「main.js が参照しているのに取り込んでいない」ものだけを咎める
    const used = new RegExp(`\\b${exported}\\b`);
    if (!used.test(mainSource)) continue;
    assert.ok(
      used.test(destructured),
      `main.js が ${exported} を使っていますが、${name} から取り込んでいません`
    );
  }
}

// 依存注入(configureXxx)の取りこぼしも同じ種類の事故になる。モジュール側が
// deps.foo を読んでいるのに main.js の configureXxx({...}) が渡していないと、
// その依存を使う経路に入った瞬間に落ちる(processWebrtcRequest・ensureApiToken
// の2件が実際に漏れていた)
for (const name of files) {
  const source = fs.readFileSync(path.join(MODULES_DIR, name), 'utf8');
  const configureName = (source.match(/function (configure[A-Za-z]*)\s*\(/) || [])[1];
  if (!configureName) continue;

  const bodyStart = source.indexOf(`function ${configureName}`);
  const body = source.slice(bodyStart, source.indexOf('\n}', bodyStart));
  const required = [...new Set([...body.matchAll(/deps\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];

  const callIdx = mainSource.indexOf(`${configureName}({`);
  assert.ok(callIdx >= 0, `main.js が ${configureName}() を呼んでいません(${name} の依存が未注入になります)`);
  const passed = sliceEnclosingBraces(mainSource, callIdx);

  for (const dep of required) {
    assert.ok(
      new RegExp(`\\b${dep}\\b`).test(passed),
      `${name} が deps.${dep} を使っていますが、main.js の ${configureName}() が渡していません`
    );
  }
}

// idx 付近を含む {...} を、波括弧の対応を数えて切り出す
function sliceEnclosingBraces(source, idx) {
  const open = source.lastIndexOf('{', idx) >= 0 && source.lastIndexOf('{', idx) > source.lastIndexOf(';', idx)
    ? source.lastIndexOf('{', idx)
    : source.indexOf('{', idx);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

console.log(`Main modules load checks passed. (${files.length} modules)`);
process.exit(0);
