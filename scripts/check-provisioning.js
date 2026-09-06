// 配布管理ツールが端末へ事前配置する provisioning.json の取り込み
// (main.js の applyProvisioningFile)を固定する回帰テスト。
//
// この機能は「平文のAPIトークンを一時的にディスクへ置く」という、性質上
// 慎重さが要る受け渡しを行う。そのため下記を重点的に検証する:
//   - 取り込みの成否に関わらず、平文ファイルが**必ず削除される**こと
//   - 有効期限切れ・形式不正のファイルを取り込まないこと
//   - 監査ログにトークンの値そのものを残さないこと
//
// ファイル削除まで含めて本物の挙動を確認したいため、fsはモックせず実物を使い、
// PROVISIONING_FILE だけをテンポラリディレクトリへ差し替えて実行する。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { readRoot, extractByBraceEnd } = require('./lib/extract-source');

const source = readRoot('main.js');

const fnSource = extractByBraceEnd(source, 'function applyProvisioningFile() {');
assert(fnSource, 'applyProvisioningFile()の抽出に失敗しました(main.jsの構造が変わった可能性があります)');

const managedFnSource = extractByBraceEnd(source, 'function isManagedDeployment() {');
assert(managedFnSource, 'isManagedDeployment()の抽出に失敗しました');

function makeContext({ tokenResult = { success: true }, writeDbOk = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-provisioning-'));
  const state = {
    dir,
    provisioningFile: path.join(dir, 'provisioning.json'),
    managedFile: path.join(dir, 'managed_deployment.json'),
    roleWrites: [],
    tokenWrites: [],
    auditLogs: [],
    db: { system_settings: [{ id: 'wizard_completed', value: 'false' }] },
    dbWrites: 0,
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    fs,
    Date,
    JSON,
    Number,
    String,
    PROVISIONING_FILE: state.provisioningFile,
    MANAGED_DEPLOYMENT_FILE: state.managedFile,
    normalizeShareMode: (v) => (v === 'client' || v === 'child' ? 'client' : 'parent'),
    normalizeTerminalRole: (v) => (v === 'exam' ? 'exam' : 'ward'),
    writeTerminalRole(role) {
      state.roleWrites.push(role);
      return { ...role, updatedAt: Date.now() };
    },
    setTerminalApiToken(token) {
      state.tokenWrites.push(token);
      return tokenResult;
    },
    safeWriteFile(target, content) {
      fs.writeFileSync(target, content, 'utf8');
    },
    readDB: () => state.db,
    writeDB: () => {
      state.dbWrites++;
      return writeDbOk;
    },
    getSettingRecord: (db, id) => (db.system_settings || []).find((s) => s.id === id),
    appendAuditLog(db, action, opts) {
      state.auditLogs.push({ action, ...opts });
    },
  };

  const ctx = vm.runInNewContext(
    `${fnSource}\n${managedFnSource}\n({ applyProvisioningFile, isManagedDeployment })`,
    sandbox
  );
  return { state, ...ctx };
}

function writeProvisioning(state, payload) {
  fs.writeFileSync(state.provisioningFile, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
}

function main() {
  // 1) 正常系(子機): 役割・トークンが保存され、平文ファイルが削除されること
  {
    const { state, applyProvisioningFile } = makeContext();
    writeProvisioning(state, {
      version: 1,
      shareMode: 'client',
      parentIp: '192.168.1.10',
      terminalRole: 'ward',
      wardId: 'ward-3',
      apiToken: 'a'.repeat(64),
    });
    const result = applyProvisioningFile();

    assert.strictEqual(result.success, true, '正常な初期設定ファイルは取り込まれること');
    assert.strictEqual(state.roleWrites.length, 1, '端末役割が1回保存されること');
    assert.strictEqual(state.roleWrites[0].shareMode, 'client', 'shareModeが反映されること');
    assert.strictEqual(state.roleWrites[0].parentIp, '192.168.1.10', 'parentIpが反映されること');
    assert.strictEqual(state.roleWrites[0].terminalRole, 'ward', 'terminalRoleが反映されること');
    assert.strictEqual(state.roleWrites[0].wardId, 'ward-3', 'wardIdが反映されること');
    assert.deepStrictEqual(state.tokenWrites, ['a'.repeat(64)], 'APIトークンが安全な保存処理へ渡されること');
    assert.strictEqual(
      fs.existsSync(state.provisioningFile), false,
      'SECURITY: 取り込み後に平文の初期設定ファイルが削除されること'
    );
    assert.strictEqual(
      state.db.system_settings.find((s) => s.id === 'wizard_completed').value, 'true',
      '初期設定ウィザードが完了済みになること'
    );
  }

  // 2) SECURITY: 監査ログにトークンの値そのものを残さないこと
  {
    const { state, applyProvisioningFile } = makeContext();
    const token = 'b'.repeat(64);
    writeProvisioning(state, {
      version: 1, shareMode: 'client', parentIp: '10.0.0.2', terminalRole: 'exam', apiToken: token,
    });
    applyProvisioningFile();

    assert.strictEqual(state.auditLogs.length, 1, '取り込みが監査ログに記録されること');
    const serialized = JSON.stringify(state.auditLogs[0]);
    assert.ok(
      !serialized.includes(token),
      'SECURITY: 監査ログにAPIトークンの値そのものを残さないこと'
    );
    assert.strictEqual(
      state.auditLogs[0].details.apiTokenProvisioned, true,
      'トークンを投入したという事実(値ではなく真偽)は記録されること'
    );
  }

  // 3) ファイルが無ければ何もしない(冪等性: 2回目以降の起動)
  {
    const { state, applyProvisioningFile } = makeContext();
    const result = applyProvisioningFile();
    assert.strictEqual(result, null, '初期設定ファイルが無ければ何もしないこと');
    assert.strictEqual(state.roleWrites.length, 0, 'ファイルが無ければ端末役割を書き換えないこと');
    assert.strictEqual(state.tokenWrites.length, 0, 'ファイルが無ければトークンを書き換えないこと');
  }

  // 4) 有効期限切れは取り込まず、かつ平文ファイルを残さないこと
  {
    const { state, applyProvisioningFile } = makeContext();
    writeProvisioning(state, {
      version: 1, shareMode: 'client', parentIp: '10.0.0.3', terminalRole: 'ward',
      apiToken: 'c'.repeat(64),
      expiresAt: Date.now() - 1000,
    });
    const result = applyProvisioningFile();

    assert.strictEqual(result.success, false, 'SECURITY: 有効期限切れの初期設定ファイルは取り込まないこと');
    assert.strictEqual(state.tokenWrites.length, 0, 'SECURITY: 有効期限切れならトークンを保存しないこと');
    assert.strictEqual(state.roleWrites.length, 0, '有効期限切れなら役割も変更しないこと');
    assert.strictEqual(
      fs.existsSync(state.provisioningFile), false,
      'SECURITY: 有効期限切れでも平文ファイルは削除されること(古いトークンを晒したままにしない)'
    );
  }

  // 5) 壊れたJSON・未対応versionを安全に拒否し、ファイルを残さないこと
  for (const [label, payload] of [
    ['壊れたJSON', '{ this is not json'],
    ['未対応version', { version: 99, shareMode: 'parent' }],
    ['オブジェクトでない', '"just a string"'],
  ]) {
    const { state, applyProvisioningFile } = makeContext();
    writeProvisioning(state, payload);
    const result = applyProvisioningFile();
    assert.strictEqual(result.success, false, `${label}は取り込まないこと`);
    assert.strictEqual(state.roleWrites.length, 0, `${label}では役割を変更しないこと`);
    assert.strictEqual(fs.existsSync(state.provisioningFile), false, `${label}でもファイルは削除されること`);
  }

  // 6) 子機なのにparentIpが無い場合は拒否すること(接続不能な状態で確定させない)
  {
    const { state, applyProvisioningFile } = makeContext();
    writeProvisioning(state, { version: 1, shareMode: 'client', parentIp: '', terminalRole: 'ward' });
    const result = applyProvisioningFile();
    assert.strictEqual(result.success, false, '子機設定でparentIpが空なら取り込まないこと');
    assert.strictEqual(state.roleWrites.length, 0, 'parentIpが空なら役割を書き換えないこと');
  }

  // 7) 形式が不正なAPIトークンを拒否すること
  {
    const { state, applyProvisioningFile } = makeContext();
    writeProvisioning(state, {
      version: 1, shareMode: 'client', parentIp: '10.0.0.4', terminalRole: 'ward',
      apiToken: 'short',
    });
    const result = applyProvisioningFile();
    assert.strictEqual(result.success, false, '短すぎるAPIトークンは拒否すること');
    assert.strictEqual(state.tokenWrites.length, 0, '不正なトークンは保存処理へ渡さないこと');
  }

  // 8) トークンの安全な保存に失敗した場合でも、平文ファイルを残さないこと
  {
    const { state, applyProvisioningFile } = makeContext({
      tokenResult: { success: false, message: 'OSの資格情報保護機能を利用できません' },
    });
    writeProvisioning(state, {
      version: 1, shareMode: 'client', parentIp: '10.0.0.5', terminalRole: 'ward',
      apiToken: 'd'.repeat(64),
    });
    const result = applyProvisioningFile();
    assert.strictEqual(result.success, false, 'トークン保存に失敗したら成功扱いにしないこと');
    assert.strictEqual(
      fs.existsSync(state.provisioningFile), false,
      'SECURITY: トークン保存に失敗した場合でも平文ファイルは削除されること'
    );
  }

  // 9) managed:true のとき管理配布マーカーが作られ、isManagedDeployment()が真になること
  {
    const { state, applyProvisioningFile, isManagedDeployment } = makeContext();
    assert.strictEqual(isManagedDeployment(), false, '前提: 取り込み前は管理配布ではないこと');
    writeProvisioning(state, {
      version: 1, shareMode: 'client', parentIp: '10.0.0.6', terminalRole: 'ward', managed: true,
    });
    applyProvisioningFile();
    assert.strictEqual(
      fs.existsSync(state.managedFile), true,
      'managed:trueなら管理配布マーカーが作られること'
    );
    assert.strictEqual(isManagedDeployment(), true, '管理配布として判定されること');
  }

  // 10) managed指定が無ければマーカーを作らないこと(手動インストールの端末を巻き込まない)
  {
    const { state, applyProvisioningFile, isManagedDeployment } = makeContext();
    writeProvisioning(state, {
      version: 1, shareMode: 'parent', parentIp: '', terminalRole: 'ward',
    });
    applyProvisioningFile();
    assert.strictEqual(fs.existsSync(state.managedFile), false, 'managed未指定ならマーカーを作らないこと');
    assert.strictEqual(isManagedDeployment(), false, '管理配布とは判定されないこと');
  }

  console.log('Provisioning checks passed.');
  process.exit(0);
}

main();
