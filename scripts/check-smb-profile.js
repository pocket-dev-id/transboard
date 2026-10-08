'use strict';
const assert = require('assert');
const vm = require('vm');
const { readRoot, extractByBraceEnd } = require('./lib/extract-source');
const smb = require('../main-modules/smb-credentials');
const source = readRoot('main.js');
const definitions = ['readSmbServerProfiles', 'resolveSmbServerProfile', 'saveSmbServerProfile']
  .map(name => extractByBraceEnd(source, `function ${name}(`)).join('\n');
let db = { system_settings: [] };
let writes = 0;
const context = {
  JSON, Object, String,
  readDB: () => structuredClone(db),
  writeDB: value => { writes++; db = value; return true; },
  getSettingRecord: (value, id) => value.system_settings.find(s => s.id === id),
  parseUncTarget: smb.parseUncTarget,
  serverSmbPasswordSettingId: smb.serverSmbPasswordSettingId,
  MASKED_SECRET_VALUE: smb.MASKED_SECRET_VALUE,
  appendAuditLog: () => {},
  smbSessionRegistry: { servers: () => [] },
  setupImportTrigger: () => {},
  setupScheduleFeedTriggers: () => {},
};
const methods = vm.runInNewContext(definitions + '\n({saveSmbServerProfile,resolveSmbServerProfile})', context);
const fallback = { mode: 'custom', username: 'old', password: 'old-secret' };
assert.strictEqual(methods.resolveSmbServerProfile(db, '\\\\SRV01\\a', fallback), fallback);
assert.strictEqual(smb.serverSmbPasswordSettingId('WARD_FILE'), smb.serverSmbPasswordSettingId('ward_file'));
assert.strictEqual(methods.saveSmbServerProfile({
  server: 'SRV01', mode: 'custom', username: 'domain\\reader', password: 'secret',
}).success, true);
assert.strictEqual(methods.resolveSmbServerProfile(db, '\\\\srv01\\other', fallback).username, 'domain\\reader');
assert.strictEqual(methods.resolveSmbServerProfile(db, '\\\\srv01\\other', fallback).password, 'secret');
assert.strictEqual(methods.saveSmbServerProfile({ server: 'WARD_FILE', mode: 'current' }).success, true);
assert.strictEqual(methods.resolveSmbServerProfile(db, '\\\\WARD_FILE\\share', fallback).mode, 'current');
const before = writes;
assert.strictEqual(methods.saveSmbServerProfile({ server: 'srv01', mode: 'custom', username: 'changed' }).success, true);
assert.strictEqual(methods.resolveSmbServerProfile(db, '\\\\srv01\\other', fallback).password, 'secret', 'Blank password must preserve existing secret');
assert.strictEqual(methods.saveSmbServerProfile({ server: '../bad', mode: 'custom', username: 'changed', password: 'new' }).success, false);
assert.strictEqual(writes, before + 1, 'Invalid profile must not write DB');
assert.strictEqual(methods.saveSmbServerProfile({ server: 'srv01', remove: true }).success, true);
assert.strictEqual(methods.resolveSmbServerProfile(db, '\\\\srv01\\a', fallback), fallback, 'Removing profile restores legacy configuration');
console.log('SMB profile checks passed.');
