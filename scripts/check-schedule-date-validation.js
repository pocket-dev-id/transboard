// スケジュール取り込みCSVの日時解析(parseScheduleDatetimeMs)が、範囲外の値
// (2月31日、13月、25時等)をJavaScriptのDateコンストラクタの自動繰り上げに
// 任せて「別の日時」として黙って受理してしまわないことを確認する回帰テスト。
//
// 例えば new Date(2026, 1, 31) は例外を投げず2026年3月3日を返す。この繰り上げを
// 検出せず採用すると、CSVの入力ミスが取り込みエラーにならず、全く別の日付・
// 時刻の予定として表示されてしまう。
//
// main.jsからparseScheduleDatetimeMs/buildValidatedScheduleDateMsの実装コード
// そのものを取り出して直接実行し、出荷されるコードの挙動を検証する。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

const startIdx = source.indexOf('const SCHEDULE_TIME_RE_SRC');
assert(startIdx >= 0, 'SCHEDULE_TIME_RE_SRCが見つかりません');
const fnIdx = source.indexOf('function parseScheduleDatetimeMs');
assert(fnIdx > startIdx, 'function parseScheduleDatetimeMsが見つかりません');
const endIdx = source.indexOf('\n}', fnIdx);
assert(endIdx > fnIdx, 'parseScheduleDatetimeMsの終端(\\n})が見つかりません');
const snippet = source.slice(startIdx, endIdx + 2);

const mod = { exports: {} };
const loader = new Function('module', `${snippet}\nmodule.exports = { parseScheduleDatetimeMs, buildValidatedScheduleDateMs };`);
loader(mod);
const { parseScheduleDatetimeMs, buildValidatedScheduleDateMs } = mod.exports;
assert(typeof parseScheduleDatetimeMs === 'function', 'parseScheduleDatetimeMsを取り出せませんでした');
assert(typeof buildValidatedScheduleDateMs === 'function', 'buildValidatedScheduleDateMsを取り出せませんでした(range検証+構築後の突き合わせヘルパー)');

function isoOf(ms) {
  assert.notStrictEqual(ms, null, `parseScheduleDatetimeMsがnullを返しました(有効な日時のはずでした)`);
  return new Date(ms).toISOString();
}

// ── 正常系: 引き続き解釈できること(退行防止) ──
assert.strictEqual(isoOf(parseScheduleDatetimeMs('2026/08/26', '13:05:30')), '2026-08-26T13:05:30.000Z', 'YYYY/MM/DD + HH:mm:ss');
assert.strictEqual(isoOf(parseScheduleDatetimeMs('2026-08-26', '13:05:30')), '2026-08-26T13:05:30.000Z', 'YYYY-MM-DD(ISO区切り) + HH:mm:ss');
assert.strictEqual(isoOf(parseScheduleDatetimeMs('08/26/2026', '13:05')), '2026-08-26T13:05:00.000Z', 'MM/DD/YYYY + HH:mm');
assert.strictEqual(isoOf(parseScheduleDatetimeMs('2026/08/26', null)), '2026-08-26T00:00:00.000Z', '時刻省略時は00:00:00になること');
assert.strictEqual(isoOf(parseScheduleDatetimeMs('2026-08-26T13:05:00', null)), '2026-08-26T13:05:00.000Z', 'ISO 8601のT区切り(日付列に日時が両方入っている場合)');
// 全角コロン・ドット区切りの時刻(現場のCSV/機器出力で混在する)
assert.strictEqual(isoOf(parseScheduleDatetimeMs('2026/08/26', '13：05：30')), '2026-08-26T13:05:30.000Z', '全角コロン区切りの時刻');
assert.strictEqual(isoOf(parseScheduleDatetimeMs('2026/08/26', '13.05.30')), '2026-08-26T13:05:30.000Z', 'ドット区切りの時刻(hh.mm.ss)');
assert.strictEqual(isoOf(parseScheduleDatetimeMs('2026/08/26', '13.05')), '2026-08-26T13:05:00.000Z', 'ドット区切りの時刻(hh.mm、秒省略)');
// 閏年の2/29は有効
assert.strictEqual(isoOf(parseScheduleDatetimeMs('2024/02/29', null)), '2024-02-29T00:00:00.000Z', '閏年の2月29日は有効な日付であること');
// 月末日(31日を持つ月)は有効
assert.strictEqual(isoOf(parseScheduleDatetimeMs('2026/01/31', null)), '2026-01-31T00:00:00.000Z', '1月31日(月末)は有効な日付であること');
// 23:59:59は有効(時刻の上限)
assert.strictEqual(isoOf(parseScheduleDatetimeMs('2026/08/26', '23:59:59')), '2026-08-26T23:59:59.000Z', '23:59:59は有効な時刻であること');

// ── 異常系: BUG FIX、範囲外の値を別の日時へ繰り上げて受理してはならない ──
assert.strictEqual(parseScheduleDatetimeMs('2026/02/31', '13:05'), null, 'BUG FIX: 2月31日(存在しない日)は3月3日等へ繰り上げず、nullとして拒否すること');
assert.strictEqual(parseScheduleDatetimeMs('2026-02-31', null), null, 'BUG FIX: ISO区切りの2月31日も同様に拒否すること');
assert.strictEqual(parseScheduleDatetimeMs('02/31/2026', '13:05'), null, 'BUG FIX: MM/DD/YYYY形式の2月31日も拒否すること');
assert.strictEqual(parseScheduleDatetimeMs('2026/13/01', '10:00'), null, 'BUG FIX: 13月は翌年1月へ繰り上げず、nullとして拒否すること');
assert.strictEqual(parseScheduleDatetimeMs('13/01/2026', '10:00'), null, 'BUG FIX: MM/DD/YYYY形式で月13も拒否すること');
assert.strictEqual(parseScheduleDatetimeMs('2026/01/01', '25:00'), null, 'BUG FIX: 25時は翌日1時へ繰り上げず、nullとして拒否すること(24:00を含む24以上はすべて不正)');
assert.strictEqual(parseScheduleDatetimeMs('2026/01/01', '24:00'), null, 'BUG FIX: 24:00は不正な時刻表記として拒否すること');
assert.strictEqual(parseScheduleDatetimeMs('2026/01/01', '10:65'), null, 'BUG FIX: 65分は繰り上げず拒否すること');
assert.strictEqual(parseScheduleDatetimeMs('2026/01/01', '10:00:65'), null, 'BUG FIX: 65秒は繰り上げず拒否すること');
assert.strictEqual(parseScheduleDatetimeMs('2026/02/29', null), null, 'BUG FIX: 非閏年の2月29日(存在しない日)は3月1日等へ繰り上げず拒否すること');
assert.strictEqual(parseScheduleDatetimeMs('2026/00/01', '10:00'), null, '月0は拒否すること');
assert.strictEqual(parseScheduleDatetimeMs('2026/01/00', '10:00'), null, '日0は拒否すること');

// ── buildValidatedScheduleDateMs単体: range検証と構築後の突き合わせの両方が
//    効いていることを直接確認する ──
assert.strictEqual(buildValidatedScheduleDateMs(2026, 2, 31, 0, 0, 0), null, 'range検証だけでなく構築後の値の突き合わせでも繰り上げを検出できること');
assert.strictEqual(buildValidatedScheduleDateMs(2026, 8, 26, 13, 5, 30), new Date(2026, 7, 26, 13, 5, 30).getTime(), '正常な値はそのまま採用されること');

console.log('Schedule date validation checks passed.');
