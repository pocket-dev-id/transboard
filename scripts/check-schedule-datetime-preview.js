// スケジュール取り込み設定画面の日時プレビュー機能(previewScheduleDatetime)の
// 回帰テスト。main.jsから実装コードそのものを取り出して直接実行し、
// combined/separateの両モード、列未指定、sampleRowに列が無い、値が不正な形式、
// といったケースで意図通りの結果(ms または null)を返すことを確認する。
const assert = require('assert');
const { readRoot, extractThroughFunctionEnd } = require('./lib/extract-source');

const source = readRoot('main.js');

const snippet = extractThroughFunctionEnd(source, 'const SCHEDULE_TIME_RE_SRC', 'function previewScheduleDatetime');
assert(snippet, 'SCHEDULE_TIME_RE_SRC〜previewScheduleDatetimeの抽出に失敗しました(main.jsの構造が変わった可能性があります)');

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

// ── dateFormat明示指定: 曖昧な値(01/02)がdateFormatによって異なる日付に
//    解釈されること。previewScheduleDatetimeがdateFormatを実際に
//    parseScheduleDatetimeMsへ伝播していることの確認 ──
{
  const sampleRow = { '日付': '01/02/2026' };
  const mdyResult = previewScheduleDatetime(sampleRow, 'combined', '日付', null, 'mdy');
  const dmyResult = previewScheduleDatetime(sampleRow, 'combined', '日付', null, 'dmy');
  assert.strictEqual(mdyResult.ms, new Date(2026, 0, 2).getTime(), 'dateFormat:mdyでは01/02/2026が1月2日と解釈されること');
  assert.strictEqual(dmyResult.ms, new Date(2026, 1, 1).getTime(), 'dateFormat:dmyでは01/02/2026が2月1日と解釈されること(mdyと異なる結果)');
}

// ── dateFormat:dmyを指定したが値が明らかにYMD形式の場合、自動判定へ
//    フォールバックして正しく解釈されること ──
{
  const sampleRow = { '日付': '2026-08-26', '時刻': '13:05' };
  const result = previewScheduleDatetime(sampleRow, 'separate', '日付', '時刻', 'dmy');
  assert.strictEqual(result.ms, new Date(2026, 7, 26, 13, 5, 0).getTime(), 'dateFormat:dmy指定でもYMD形式の値は自動判定にフォールバックして解釈されること');
}

// ── dateFormat未指定時の挙動が変化していないこと(後方互換) ──
{
  const sampleRow = { '検査日': '2026/08/26', '検査時刻': '13:05' };
  const withoutFormat = previewScheduleDatetime(sampleRow, 'separate', '検査日', '検査時刻');
  const withAutoFormat = previewScheduleDatetime(sampleRow, 'separate', '検査日', '検査時刻', 'auto');
  assert.strictEqual(withoutFormat.ms, withAutoFormat.ms, 'dateFormat未指定と\'auto\'指定は同じ結果を返すこと(後方互換)');
  assert.notStrictEqual(withoutFormat.ms, null);
}

console.log('Schedule datetime preview checks passed.');
