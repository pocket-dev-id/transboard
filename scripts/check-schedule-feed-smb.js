const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
  MASKED_SECRET_VALUE,
  SMB_FEED_PASSWORD_PREFIX,
  isFeedSmbPasswordSettingId,
  feedSmbPasswordSettingId,
  normalizeGlobalSmbMode,
  normalizeFeedSmbMode,
  parseUncTarget,
  credentialFingerprint,
  resolveFeedSmbCredentials,
  createSmbSessionRegistry,
} = require(path.join(ROOT, 'main-modules/smb-credentials.js'));

// ── 設定IDの規約 ───────────────────────────────────────────
assert.strictEqual(feedSmbPasswordSettingId('feed-1'), 'smb_password__feed-1');
assert.ok(isFeedSmbPasswordSettingId('smb_password__feed-1'));
assert.ok(!isFeedSmbPasswordSettingId('smb_password'), 'global smb_password must not be treated as a feed-scoped id');
assert.ok(!isFeedSmbPasswordSettingId('import_directory'));
assert.ok(!isFeedSmbPasswordSettingId(''));
assert.ok(SMB_FEED_PASSWORD_PREFIX.length > 0);

// ── モード正規化（ウィザードの'credential'互換を含む） ──────────
assert.strictEqual(normalizeGlobalSmbMode('custom'), 'custom');
assert.strictEqual(normalizeGlobalSmbMode('credential'), 'custom', "legacy wizard value 'credential' must repair itself to 'custom'");
assert.strictEqual(normalizeGlobalSmbMode('current'), 'current');
assert.strictEqual(normalizeGlobalSmbMode(''), 'current');
assert.strictEqual(normalizeGlobalSmbMode(undefined), 'current');

assert.strictEqual(normalizeFeedSmbMode(undefined), 'inherit', 'feeds without the field must inherit the global setting');
assert.strictEqual(normalizeFeedSmbMode(''), 'inherit');
assert.strictEqual(normalizeFeedSmbMode('nonsense'), 'inherit');
assert.strictEqual(normalizeFeedSmbMode('current'), 'current');
assert.strictEqual(normalizeFeedSmbMode('custom'), 'custom');
assert.strictEqual(normalizeFeedSmbMode('credential'), 'custom');

// ── UNCパス解析 ────────────────────────────────────────────
const unc = parseUncTarget('\\\\srv01\\share\\sub\\dir');
assert.deepStrictEqual(
  { server: unc.server, share: unc.share, target: unc.target },
  { server: 'srv01', share: 'share', target: '\\\\srv01\\share' }
);
assert.strictEqual(unc.serverKey, 'srv01');
assert.strictEqual(parseUncTarget('C:\\HospitalData\\Import'), null, 'local paths must not be treated as UNC');
assert.strictEqual(parseUncTarget('\\\\srv01'), null, 'a server without a share is not a connectable target');
assert.strictEqual(parseUncTarget(''), null);
assert.strictEqual(parseUncTarget(null), null);
// 大文字小文字が違っても同一サーバー・同一共有として扱う
assert.strictEqual(parseUncTarget('\\\\SRV01\\Share').serverKey, parseUncTarget('\\\\srv01\\share').serverKey);
assert.strictEqual(parseUncTarget('\\\\SRV01\\Share').shareKey, parseUncTarget('\\\\srv01\\share').shareKey);

// ── 資格情報の解決 ─────────────────────────────────────────
const globalCustom = { mode: 'custom', username: 'domain\\svc', password: 'globalpw' };
const globalCurrent = { mode: 'current', username: '', password: '' };

const inherited = resolveFeedSmbCredentials({}, globalCustom);
assert.strictEqual(inherited.mode, 'custom');
assert.strictEqual(inherited.username, 'domain\\svc');
assert.strictEqual(inherited.password, 'globalpw');
assert.strictEqual(inherited.source, 'global');

assert.strictEqual(resolveFeedSmbCredentials({ smb_auth_mode: 'unknown' }, globalCustom).source, 'global');

const explicitCurrent = resolveFeedSmbCredentials({ smb_auth_mode: 'current' }, globalCustom);
assert.strictEqual(explicitCurrent.mode, 'current', "'current' must suppress authentication even when the global setting is custom");
assert.strictEqual(explicitCurrent.password, '');

const perFeed = resolveFeedSmbCredentials(
  { smb_auth_mode: 'custom', smb_username: '  ward\\reader  ', smb_password: 'feedpw' },
  globalCustom
);
assert.strictEqual(perFeed.mode, 'custom');
assert.strictEqual(perFeed.username, 'ward\\reader', 'username must be trimmed like the global path does');
assert.strictEqual(perFeed.password, 'feedpw');
assert.strictEqual(perFeed.source, 'feed');

// 共通設定が'current'なら継承したフィードも認証しない
assert.strictEqual(resolveFeedSmbCredentials({}, globalCurrent).mode, 'current');

// ── フィンガープリント ─────────────────────────────────────
assert.strictEqual(credentialFingerprint('User', 'pw'), credentialFingerprint('user', 'pw'), 'usernames are case-insensitive');
assert.notStrictEqual(credentialFingerprint('user', 'pw'), credentialFingerprint('user', 'PW'), 'passwords are case-sensitive');
assert.notStrictEqual(credentialFingerprint('a', 'b c'), credentialFingerprint('a b', 'c'), 'the separator must not be ambiguous');

// ── セッションレジストリ ───────────────────────────────────
const shareA = parseUncTarget('\\\\srv01\\a');
const shareB = parseUncTarget('\\\\srv01\\b');
const otherServer = parseUncTarget('\\\\srv02\\a');
const fpA = credentialFingerprint('user1', 'pw1');
const fpB = credentialFingerprint('user2', 'pw2');

const reg = createSmbSessionRegistry();

// 初回は前回起動の残骸を掃除してから接続する
let planned = reg.plan(shareA, fpA);
assert.strictEqual(planned.action, 'connect');
assert.strictEqual(planned.deleteFirst, true, 'the first connection per server should clear a stale session');
reg.commit(shareA, fpA);

// 同一サーバー・同一資格情報・同一共有 → net use を一切実行しない
planned = reg.plan(shareA, fpA);
assert.strictEqual(planned.action, 'skip', 'repeat calls must not re-run net use (that is what tears down live watchers)');

// 同一サーバー・同一資格情報・別共有 → 切断せずに接続
planned = reg.plan(shareB, fpA);
assert.strictEqual(planned.action, 'connect');
assert.strictEqual(planned.deleteFirst, false, 'SMB multiplexes shares on one session; deleting would drop the live one');
reg.commit(shareB, fpA);

// 同一サーバー・異なる資格情報 → 生きたセッションに触らず競合として返す
planned = reg.plan(shareA, fpB);
assert.strictEqual(planned.action, 'conflict');
assert.strictEqual(planned.deleteFirst, false);
assert.deepStrictEqual(planned.sharesToDelete, [], 'a conflict must never tear down the session that is already working');
assert.ok(planned.message.includes('srv01'), 'the conflict message must name the server so the ward can act on it');
assert.ok(!planned.message.includes('pw1') && !planned.message.includes('pw2'), 'credentials must never appear in a user-facing message');
// 競合を報告しても記録は書き換わっていない
assert.strictEqual(reg.plan(shareA, fpA).action, 'skip');

// 別サーバーは独立
planned = reg.plan(otherServer, fpB);
assert.strictEqual(planned.action, 'connect');
reg.commit(otherServer, fpB);
assert.deepStrictEqual(reg.servers().sort(), ['srv01', 'srv02']);

// 利用者がいなくなったサーバーだけ切断対象になる
const pruned = reg.prune(['srv02']);
assert.deepStrictEqual(pruned.sort(), ['\\\\srv01\\a', '\\\\srv01\\b'], 'prune must return every share this process mounted for the dropped server');
assert.deepStrictEqual(reg.servers(), ['srv02']);
// 落とした後は同じサーバーを別資格情報で張り直せる
assert.strictEqual(reg.plan(shareA, fpB).action, 'connect');

// 利用者が残っていれば何も切らない
assert.deepStrictEqual(createSmbSessionRegistry().prune([]), []);

// ── マスク値 ───────────────────────────────────────────────
assert.strictEqual(MASKED_SECRET_VALUE, '********');
assert.notStrictEqual(MASKED_SECRET_VALUE, '', 'an empty password must stay distinguishable from "unchanged"');

console.log('Schedule feed SMB credential checks passed.');
