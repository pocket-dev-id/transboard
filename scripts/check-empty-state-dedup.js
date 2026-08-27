// 空状態/ローディング表示の共通ヘルパー(UI.emptyStateHtml / UI.showEmpty /
// UI.loadingSpinnerHtml / UI.showLoading、js/ui.js)が正しく動作すること、
// および各画面(priority/examroom/timeline/bedmap/history)がこれらの共通
// ヘルパーを使わず生のHTML文字列を直書きする形に後退していないことを検証
// する回帰テスト。
//
// 以前はこれらの画面がそれぞれ独自に同じ構造のHTML文字列
// ('<div class="empty-state">...'/'<div class="loading-spinner">...')を
// 直書きしており、UI.showEmpty/showLoadingは定義されているのにどこからも
// 呼ばれない死んだコードになっていた。js/ui.js全体を実際にロードして直接
// 実行することで、出荷されるコードそのものの挙動を検証する。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const uiSource = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');

const sandbox = { console, document: { getElementById: () => null } };
vm.runInNewContext(`${uiSource}\nthis.UI = UI;`, sandbox);
const { UI } = sandbox;
assert(typeof UI.emptyStateHtml === 'function', 'UI.emptyStateHtmlを取り出せませんでした');
assert(typeof UI.showEmpty === 'function', 'UI.showEmptyを取り出せませんでした');
assert(typeof UI.loadingSpinnerHtml === 'function', 'UI.loadingSpinnerHtmlを取り出せませんでした');
assert(typeof UI.showLoading === 'function', 'UI.showLoadingを取り出せませんでした');

// ── emptyStateHtml: デフォルト(アイコン無指定はfa-inbox) ──
{
  const html = UI.emptyStateHtml('該当するイベントがありません');
  assert.strictEqual(html, '<div class="empty-state"><i class="fas fa-inbox" aria-hidden="true"></i><p>該当するイベントがありません</p></div>');
}

// ── emptyStateHtml: アイコン指定 ──
{
  const html = UI.emptyStateHtml('スタッフが登録されていません', { icon: 'fas fa-user-nurse' });
  assert.strictEqual(html, '<div class="empty-state"><i class="fas fa-user-nurse" aria-hidden="true"></i><p>スタッフが登録されていません</p></div>');
}

// ── emptyStateHtml: iconStyle(アイコン単体へのstyle) ──
{
  const html = UI.emptyStateHtml('現在、出棟中の患者はいません', { icon: 'fas fa-check-circle', iconStyle: 'color:#16a34a' });
  assert.strictEqual(html, '<div class="empty-state"><i class="fas fa-check-circle" aria-hidden="true" style="color:#16a34a"></i><p>現在、出棟中の患者はいません</p></div>');
}

// ── emptyStateHtml: icon:null でアイコン無し ──
{
  const html = UI.emptyStateHtml('読み込みに失敗しました', { icon: null });
  assert.strictEqual(html, '<div class="empty-state"><p>読み込みに失敗しました</p></div>');
}

// ── emptyStateHtml: style(ラッパーdivへのstyle) ──
{
  const html = UI.emptyStateHtml('対象期間に帰棟済みの移送がありません', { icon: 'fas fa-stopwatch', style: 'padding:16px;' });
  assert.strictEqual(html, '<div class="empty-state" style="padding:16px;"><i class="fas fa-stopwatch" aria-hidden="true"></i><p>対象期間に帰棟済みの移送がありません</p></div>');
}

// ── emptyStateHtml: hint(補足の2行目) ──
{
  const html = UI.emptyStateHtml('検査室が登録されていません', {
    icon: 'fas fa-hospital-symbol',
    hint: '設定 → 検査室マスタ から登録してください。',
  });
  assert.strictEqual(html, '<div class="empty-state"><i class="fas fa-hospital-symbol" aria-hidden="true"></i><p>検査室が登録されていません</p><p style="font-size:11px;margin-top:4px;">設定 → 検査室マスタ から登録してください。</p></div>');
}

// ── emptyStateHtml: メッセージがエスケープされること(escapeHTML経由) ──
{
  const html = UI.emptyStateHtml('<script>alert(1)</script>');
  assert(!html.includes('<script>alert(1)</script>'), 'メッセージはHTMLエスケープされなければならない');
  assert(html.includes('&lt;script&gt;'), 'エスケープ後の文字列が含まれること');
}

// ── loadingSpinnerHtml ──
{
  const html = UI.loadingSpinnerHtml();
  assert.strictEqual(html, '<div class="loading-spinner"><div class="spinner"></div></div>');
}

// ── showEmpty: 存在しないコンテナIDでは何もしない(例外を投げない) ──
{
  UI.showEmpty('does-not-exist', 'test');
}

// ── showLoading: 存在しないコンテナIDでは何もしない(例外を投げない) ──
{
  UI.showLoading('does-not-exist');
}

// ── 各画面が生のempty-state/loading-spinner HTML文字列を直書きせず、
//    共通ヘルパー経由に統一されていること ──
const screensToCheck = [
  'js/priority.js',
  'js/examroom.js',
  'js/timeline.js',
  'js/bedmap.js',
  'js/history.js',
];
for (const rel of screensToCheck) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert(
    !/class="empty-state"/.test(src),
    `${rel}: 生の class="empty-state" HTML文字列が直書きされています。UI.emptyStateHtml()/UI.showEmpty()を使ってください`
  );
  assert(
    !/class="loading-spinner"/.test(src),
    `${rel}: 生の class="loading-spinner" HTML文字列が直書きされています。UI.loadingSpinnerHtml()/UI.showLoading()を使ってください`
  );
}
// examroom.jsとhistory.jsは複数箇所で使うため、実際に呼び出し箇所が
// 十分な数あることも確認する(単なるコメント上の言及ではないこと)
{
  const examroomSrc = fs.readFileSync(path.join(ROOT, 'js/examroom.js'), 'utf8');
  assert((examroomSrc.match(/UI\.emptyStateHtml\(/g) || []).length >= 4, 'js/examroom.jsのUI.emptyStateHtml呼び出し数が想定より少ない');
  assert((examroomSrc.match(/UI\.loadingSpinnerHtml\(/g) || []).length >= 2, 'js/examroom.jsのUI.loadingSpinnerHtml呼び出し数が想定より少ない');

  const historySrc = fs.readFileSync(path.join(ROOT, 'js/history.js'), 'utf8');
  assert((historySrc.match(/UI\.emptyStateHtml\(/g) || []).length >= 5, 'js/history.jsのUI.emptyStateHtml呼び出し数が想定より少ない');
}

console.log('Empty state / loading dedup checks passed.');
