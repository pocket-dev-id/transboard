// アナウンス定型文に埋め込む数字入力欄({n}トークン)のパース・合成ロジック
// (UI.splitAnnouncementTemplate / UI.fillAnnouncementTemplate、js/ui.js)が
// 正しく動作することを確認する回帰テスト。
//
// この2関数はDOMに依存しない純粋関数として実装されており、js/call.js(通話
// 画面の描画)とjs/settings/import-notify.js(定型文編集画面のプレビュー)の
// 両方から共有される。js/ui.js全体を実際にロードして直接実行することで、
// 出荷されるコードそのものの挙動を検証する。
const assert = require('assert');
const vm = require('vm');
const { readRoot } = require('./lib/extract-source');

const source = readRoot('js/ui.js');

const sandbox = { console };
vm.runInNewContext(`${source}\nthis.UI = UI;`, sandbox);
const { UI } = sandbox;
assert(typeof UI.splitAnnouncementTemplate === 'function', 'UI.splitAnnouncementTemplateを取り出せませんでした');
assert(typeof UI.fillAnnouncementTemplate === 'function', 'UI.fillAnnouncementTemplateを取り出せませんでした');

// ── splitAnnouncementTemplate ──

// {n}を含まない場合
{
  const result = UI.splitAnnouncementTemplate('患者が到着しました。');
  assert.strictEqual(result.hasBlank, false, '{n}を含まない定型文はhasBlank:falseであること');
  assert.strictEqual(JSON.stringify(result.segments), JSON.stringify([{ type: 'text', value: '患者が到着しました。' }]), '{n}を含まない場合は元の文字列全体が1つのtextセグメントであること');
}

// 中間に1つ
{
  const result = UI.splitAnnouncementTemplate('検査室{n}番からお迎えください。');
  assert.strictEqual(result.hasBlank, true);
  assert.strictEqual(JSON.stringify(result.segments), JSON.stringify([
    { type: 'text', value: '検査室' },
    { type: 'blank' },
    { type: 'text', value: '番からお迎えください。' },
  ]), '中間の{n}が正しく分割されること');
}

// 先頭に1つ(先頭が空文字になるケース、textセグメントを作らないこと)
{
  const result = UI.splitAnnouncementTemplate('{n}番の患者様。');
  assert.strictEqual(JSON.stringify(result.segments), JSON.stringify([
    { type: 'blank' },
    { type: 'text', value: '番の患者様。' },
  ]), '先頭の{n}では空のtextセグメントを作らないこと');
}

// 末尾に1つ(末尾が空文字になるケース)
{
  const result = UI.splitAnnouncementTemplate('検査室{n}');
  assert.strictEqual(JSON.stringify(result.segments), JSON.stringify([
    { type: 'text', value: '検査室' },
    { type: 'blank' },
  ]), '末尾の{n}では空のtextセグメントを作らないこと');
}

// 複数(隣接含む)
{
  const result = UI.splitAnnouncementTemplate('{n}階{n}号室の患者様、{n}時にお越しください。');
  assert.strictEqual(JSON.stringify(result.segments), JSON.stringify([
    { type: 'blank' },
    { type: 'text', value: '階' },
    { type: 'blank' },
    { type: 'text', value: '号室の患者様、' },
    { type: 'blank' },
    { type: 'text', value: '時にお越しください。' },
  ]), '複数の{n}が出現順通りに分割されること');
}

// 隣接する{n}{n}(間にtextが無いケース)
{
  const result = UI.splitAnnouncementTemplate('{n}{n}番');
  assert.strictEqual(JSON.stringify(result.segments), JSON.stringify([
    { type: 'blank' },
    { type: 'blank' },
    { type: 'text', value: '番' },
  ]), '隣接する{n}{n}の間に空のtextセグメントを挟まないこと');
}

// 空文字列・null・undefined
assert.strictEqual(UI.splitAnnouncementTemplate('').hasBlank, false);
assert.strictEqual(UI.splitAnnouncementTemplate(null).hasBlank, false);
assert.strictEqual(UI.splitAnnouncementTemplate(undefined).hasBlank, false);

// ── fillAnnouncementTemplate ──

// 1箇所
assert.strictEqual(
  UI.fillAnnouncementTemplate('検査室{n}番からお迎えください。', ['3']),
  '検査室3番からお迎えください。',
  '1箇所の{n}が正しく埋め込まれること'
);

// 複数箇所、出現順に埋め込まれること
assert.strictEqual(
  UI.fillAnnouncementTemplate('{n}階{n}号室の患者様、{n}時にお越しください。', ['5', '12', '14']),
  '5階12号室の患者様、14時にお越しください。',
  '複数の{n}が出現順にvalues配列の値で埋め込まれること'
);

// {n}を含まない定型文はそのまま返る(values空配列)
assert.strictEqual(
  UI.fillAnnouncementTemplate('患者が到着しました。', []),
  '患者が到着しました。',
  '{n}を含まない定型文はvaluesが空でもそのまま返ること'
);

// BUG防止: {n}の個数とvaluesの個数が一致しない場合はnullを返すこと
assert.strictEqual(
  UI.fillAnnouncementTemplate('検査室{n}番、{n}時から', ['3']),
  null,
  '{n}の個数(2)よりvaluesが少ない(1)場合はnullを返すこと'
);
assert.strictEqual(
  UI.fillAnnouncementTemplate('検査室{n}番からお迎えください。', ['3', '4']),
  null,
  '{n}の個数(1)よりvaluesが多い(2)場合はnullを返すこと'
);
assert.strictEqual(
  UI.fillAnnouncementTemplate('患者が到着しました。', ['3']),
  null,
  '{n}が無いのにvaluesが渡された場合はnullを返すこと'
);

// セキュリティ: replaceにコールバック関数を渡しているため、値に$&等の
// 特殊パターン文字が含まれていても置換パターンとして解釈されず、
// そのまま文字列として挿入されること(String.replaceの罠を踏んでいないこと)
assert.strictEqual(
  UI.fillAnnouncementTemplate('検査室{n}番', ['$&']),
  '検査室$&番',
  '値に$&が含まれていてもマッチした部分文字列に置き換わらず、そのまま挿入されること'
);
assert.strictEqual(
  UI.fillAnnouncementTemplate('検査室{n}番、{n}時', ['$1', '$`']),
  '検査室$1番、$`時',
  '値に$1・$`が含まれていても特殊パターンとして解釈されず、そのまま挿入されること'
);

console.log('Announcement template blank checks passed.');
