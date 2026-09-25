// サイレントインストーラの引数投入機能(build/silent-provisioning.nsh)の回帰テスト。
//
// NSISスクリプト自体はこの環境(Linux)ではコンパイル・実行できないため、
// 代わりに以下を固定する:
//   1) 両方のビルド設定(package.json / per-machine)が同じ.nshを
//      nsis.includeとして参照していること
//   2) .nshの構造上の対称性(!macro/!macroend、${If}/${EndIf}の対応)が
//      崩れていないこと
//   3) .nshが「個別引数」モードで組み立てるJSONの内容を、このスクリプト内で
//      同じロジックで再現し、main.jsのapplyProvisioningFile()に本物の
//      検証ロジックを通して受理されることを確認する
//      (main.jsが受け付ける書式と、インストーラが生成する書式が
//      食い違っていないかを固定する)
//   4) ward/roleの値に二重引用符を含めるとJSONが壊れるという、
//      個別引数モードの既知の制約(README/manual.mdに明記)が
//      実際にその通りであることを固定する
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readRoot, extractByBraceEnd } = require('./lib/extract-source');

const ROOT = path.join(__dirname, '..');
const NSH_RELATIVE_PATH = 'build/silent-provisioning.nsh';
const nshSource = fs.readFileSync(path.join(ROOT, NSH_RELATIVE_PATH), 'utf8');

// 1) 両方のビルド設定が同じ.nshを参照していること
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(
    pkg.build?.nsis?.include, NSH_RELATIVE_PATH,
    'package.jsonのbuild.nsis.includeが silent-provisioning.nsh を指していること(per-userビルド)'
  );

  const perMachineYml = fs.readFileSync(path.join(ROOT, 'build/electron-builder.per-machine.yml'), 'utf8');
  assert.match(
    perMachineYml, /^\s*include:\s*build\/silent-provisioning\.nsh\s*$/m,
    'per-machineビルド設定も同じ silent-provisioning.nsh を参照していること'
  );
}

// 2) 構造上の対応が崩れていないこと(単純なカウントによる健全性チェック)
{
  const countOccurrences = (re) => (nshSource.match(re) || []).length;
  assert.strictEqual(countOccurrences(/!macro\s+\w/g), countOccurrences(/!macroend/g), '!macroと!macroendの数が一致すること');
  assert.strictEqual(countOccurrences(/\$\{If(Not)?\}/g), countOccurrences(/\$\{EndIf\}/g), '${If}/${IfNot}と${EndIf}の数が一致すること');
  assert.ok(countOccurrences(/\$\{Else\}/g) >= 1, '${Else}分岐(モード判定)が存在すること');
  for (const inc of ['FileFunc.nsh', 'LogicLib.nsh']) {
    assert.ok(nshSource.includes(`!include "${inc}"`), `${inc}をincludeしていること`);
  }
  // BUG FIX: 独立した"GetOptions.nsh"というヘッダはNSIS 3.xに存在しない
  // (GetParameters/GetOptionsマクロは共にFileFunc.nsh内で定義されている)。
  // !include "GetOptions.nsh" とすると実機ビルドで
  // "!include: could not find: GetOptions.nsh" として失敗することを
  // 実際のWindowsビルドで確認済み。再発を防ぐため存在しないことを固定する
  assert.ok(
    !nshSource.includes('!include "GetOptions.nsh"'),
    'BUG FIX: 存在しない"GetOptions.nsh"をincludeしていないこと(実機ビルド失敗の原因だった)'
  );
}

// 3) 個別引数モードのJSON組み立てを、.nshと同じロジックでJS側に再現し、
//    main.js側の本物の検証ロジック(applyProvisioningFile)を通す。
//    .nshのFileWrite列と1対1で対応させているため、片方だけを変更すると
//    このテストが構造的に古くなる(意図的な密結合)。
function buildIndividualArgsJson({
  parentIp = '', role = '', wardId = '', deviceName = '', apiToken = '',
  preventSleep = '', alwaysOnTop = '', managed = '',
} = {}) {
  let out = '{\n';
  out += '  "version": 1,\n';
  if (parentIp !== '') {
    out += '  "shareMode": "client",\n';
    out += `  "parentIp": "${parentIp}",\n`;
  } else {
    out += '  "shareMode": "parent",\n';
  }
  if (role !== '') out += `  "terminalRole": "${role}",\n`;
  if (wardId !== '') out += `  "wardId": "${wardId}",\n`;
  if (deviceName !== '') out += `  "deviceName": "${deviceName}",\n`;
  if (apiToken !== '') out += `  "apiToken": "${apiToken}",\n`;
  if (preventSleep === '1') out += '  "preventSleep": true,\n';
  else if (preventSleep === '0') out += '  "preventSleep": false,\n';
  if (alwaysOnTop === '1') out += '  "alwaysOnTop": true,\n';
  else if (alwaysOnTop === '0') out += '  "alwaysOnTop": false,\n';
  out += managed === '1' ? '  "managed": true\n' : '  "managed": false\n';
  out += '}\n';
  return out;
}

const mainSource = readRoot('main.js');
const applyFnSource = extractByBraceEnd(mainSource, 'function applyProvisioningFile() {');
assert(applyFnSource, 'applyProvisioningFile()の抽出に失敗しました(main.jsの構造が変わった可能性があります)');

function runApply(jsonText) {
  const state = { roleWrites: [], tokenWrites: [], deleted: false };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    fs: {
      existsSync: () => true,
      readFileSync: () => jsonText,
      unlinkSync: () => { state.deleted = true; },
    },
    Date, JSON, Number, String,
    PROVISIONING_FILE: 'dummy-path',
    MANAGED_DEPLOYMENT_FILE: 'dummy-managed-path',
    normalizeShareMode: (v) => (v === 'client' || v === 'child' ? 'client' : 'parent'),
    normalizeTerminalRole: (v) => (v === 'exam' ? 'exam' : 'ward'),
    writeTerminalRole(role) { state.roleWrites.push(role); return { ...role, updatedAt: Date.now() }; },
    setTerminalApiToken(token) { state.tokenWrites.push(token); return { success: true }; },
    safeWriteFile() {},
    readDB: () => ({ system_settings: [] }),
    writeDB: () => true,
    getSettingRecord: () => undefined,
    appendAuditLog() {},
  };
  const result = vm.runInNewContext(`${applyFnSource}\napplyProvisioningFile()`, sandbox);
  return { result, state };
}

// 3a) 子機・役割・病棟・端末名・トークン・スリープ抑止・最前面・管理配布フラグを
//     すべて指定 → 受理され、それぞれの値が正しくwriteTerminalRoleへ渡ること
{
  const json = buildIndividualArgsJson({
    parentIp: '192.168.1.10', role: 'ward', wardId: '3F', deviceName: '3F-PC1',
    apiToken: 'a'.repeat(32), preventSleep: '1', alwaysOnTop: '0', managed: '1',
  });
  JSON.parse(json); // 構文として妥当なことを先に確認
  const { result, state } = runApply(json);
  assert.strictEqual(result.success, true, '個別引数モードで組み立てたJSONがapplyProvisioningFile()に受理されること');
  assert.strictEqual(state.roleWrites[0].shareMode, 'client');
  assert.strictEqual(state.roleWrites[0].parentIp, '192.168.1.10');
  assert.strictEqual(state.roleWrites[0].terminalRole, 'ward');
  assert.strictEqual(state.roleWrites[0].wardId, '3F');
  assert.strictEqual(state.roleWrites[0].deviceName, '3F-PC1');
  assert.strictEqual(state.roleWrites[0].preventSleep, true);
  assert.strictEqual(state.roleWrites[0].alwaysOnTop, false, '/ALWAYSONTOP=0(明示的な無効化)が反映されること');
  assert.deepStrictEqual(state.tokenWrites, ['a'.repeat(32)]);
  assert.strictEqual(result.managed, true);
}

// 3a-2) /PREVENTSLEEP=, /ALWAYSONTOP=を指定しない場合、undefinedのまま
//       writeTerminalRoleへ渡ること(main.js側はundefinedを「利用者の選択を
//       尊重し、既存値を引き継ぐ」の意味で扱うため、falseと混同してはいけない)
{
  const json = buildIndividualArgsJson({ parentIp: '192.168.1.10' });
  const { state } = runApply(json);
  assert.strictEqual(state.roleWrites[0].preventSleep, undefined, '未指定のpreventSleepはundefinedのまま渡ること(falseにしないこと)');
  assert.strictEqual(state.roleWrites[0].alwaysOnTop, undefined, '未指定のalwaysOnTopはundefinedのまま渡ること(falseにしないこと)');
  assert.strictEqual(state.roleWrites[0].deviceName, undefined, '未指定のdeviceNameはundefinedのまま渡ること(空文字で既存値を消さないこと)');
  assert.strictEqual(state.roleWrites[0].wardId, undefined, '未指定のwardIdはundefinedのまま渡ること(空文字で既存値を消さないこと)');
}

// 3b) /PARENTIP=未指定(親機側の一括インストール) → shareMode:parentで受理されること
{
  const json = buildIndividualArgsJson({ role: 'ward' });
  JSON.parse(json);
  const { result, state } = runApply(json);
  assert.strictEqual(result.success, true, '親機向け(/PARENTIP未指定)も受理されること');
  assert.strictEqual(state.roleWrites[0].shareMode, 'parent');
}

// 3c) 何も引数を指定しない場合、.nsh側はファイル自体を作らない(マクロのガード条件)。
//     ここではガード条件そのもの("$R3$R4$R5$R6$R7" != "")が.nsh内に存在することを確認する
{
  assert.ok(
    nshSource.includes('${If} "$R3$R4$R5$R6$R7$0$1$2" != ""'),
    '引数が1つも無い場合はprovisioning.jsonを作らないガードが.nsh内に存在すること(通常インストールへの影響ゼロを保証)'
  );
}

// 4) 既知の制約: wardId/role/parentIp/apiTokenに二重引用符が含まれるとJSONが壊れる
//    (個別引数モードはエスケープ処理をしていないため)。ドキュメントの注意書きが
//    実態と一致していることを固定する
{
  const json = buildIndividualArgsJson({ wardId: '3F"' });
  assert.throws(() => JSON.parse(json), 'KNOWN LIMITATION: 引用符を含む値はJSONを破壊すること(ドキュメント記載の制約と一致させる)');
}

console.log('Silent installer provisioning checks passed.');
process.exit(0);
