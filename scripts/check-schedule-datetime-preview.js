// スケジュール取り込み設定画面の日時プレビュー機能(previewScheduleDatetime)の
// 回帰テスト。main.jsから実装コードそのものを取り出して直接実行し、
// combined/separateの両モード、列未指定、sampleRowに列が無い、値が不正な形式、
// といったケースで意図通りの結果(ms または null)を返すことを確認する。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

const startIdx = source.indexOf('const SCHEDULE_TIME_RE_SRC');
assert(startIdx >= 0, 'SCHEDULE_TIME_RE_SRCが見つかりません');
const fnIdx = source.indexOf('function previewScheduleDatetime');
assert(fnIdx > startIdx, 'function previewScheduleDatetimeが見つかりません');
const endIdx = source.indexOf('\n}', fnIdx);
assert(endIdx > fnIdx, 'previewScheduleDatetimeの終端(\\n})が見つかりません');
const snippet = source.slice(startIdx, endIdx + 2);

const mod = { exports: {} };
const loader = new Function('module', `${snippet}\nmodule.exports = { previewScheduleDatetime };`);
loader(mod);
const { previewScheduleDatetime } = mod.exports;
assert(typeof previewScheduleDatetime === 'function', 'previewScheduleDatetimeを取り出せませんでした');

// ── separateモード: 日付列+時刻列がそれぞれ別のCSV列にある場合 ──
{
  const sampleRow = { '検査日': '2026/08/26', '検査時刻': '13:05', '患者名': '山田太郎' };
  const result = previewScheduleDatetime(sampleRow, 'separate', '検査日', '検査時刻');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.ms, new Date(2026, 7, 26, 13, 5, 0).getTime(), 'separateモードで日付列+時刻列を正しく解釈できること');
}

// ── combinedモード: 1つの列に日付と時刻がまとまっている場合(timeColは無視される) ──
{
  const sampleRow = { '検査日時': '2026-08-26 13:05:30', '時刻っぽい別列': '99:99' };
  const result = previewScheduleDatetime(sampleRow, 'combined', '検査日時', '時刻っぽい別列');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.ms, new Date(2026, 7, 26, 13, 5, 30).getTime(), 'combinedモードでは日付+時刻列のみを見てtimeColは無視すること');
}

// ── dateColが未指定(空文字)の場合: 「まだ判定できない」でms:null、エラー扱いにしない ──
{
  const sampleRow = { '検査日': '2026/08/26' };
  const result = previewScheduleDatetime(sampleRow, 'separate', '', '検査時刻');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.ms, null, 'dateColが空のときはms:nullを返すこと(エラーではない)');
}

// ── dateColがsampleRowに存在しない列名の場合 ──
{
  const sampleRow = { '検査日': '2026/08/26' };
  const result = previewScheduleDatetime(sampleRow, 'separate', '存在しない列', '検査時刻');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.ms, null, 'dateColがsampleRowに存在しない場合はms:nullを返すこと');
}

// ── sampleRow自体がnull(まだヘッダ読み込み前)の場合 ──
{
  const result = previewScheduleDatetime(null, 'separate', '検査日', '検査時刻');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.ms, null, 'sampleRowが無い場合はms:nullを返すこと');
}

// ── 値が不正な形式(解析不能)の場合: parseScheduleDatetimeMsの拒否がそのまま伝播すること ──
{
  const sampleRow = { '検査日': '2026/02/31', '検査時刻': '13:05' };
  const result = previewScheduleDatetime(sampleRow, 'separate', '検査日', '検査時刻');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.ms, null, '存在しない日付(2月31日)はms:nullとして拒否されること');
}

// ── 値が空文字の場合 ──
{
  const sampleRow = { '検査日': '', '検査時刻': '13:05' };
  const result = previewScheduleDatetime(sampleRow, 'separate', '検査日', '検査時刻');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.ms, null, '日付列の値が空文字の場合はms:nullを返すこと');
}

console.log('Schedule datetime preview checks passed.');
