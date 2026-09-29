const assert = require('assert');
const { readRoot } = require('./lib/extract-source');

const source = readRoot('main.js');
const loadCode = source.slice(source.indexOf('function loadAuditLogFile()'), source.indexOf('// 監査ログ1件をO(1)'));
const rewriteCode = source.slice(source.indexOf('function getAuditLogFileSize()'), source.indexOf('// 2つの監査ログ列をid基準'));
assert(loadCode.startsWith('function loadAuditLogFile()') && rewriteCode.startsWith('function getAuditLogFileSize()'));

let fullRead = false;
const payload = 'partial\n{"id":"latest"}\n';
const reader = {
  existsSync: () => true,
  openSync: () => 1,
  fstatSync: () => ({ size: 1024 * 1024 * 1024 }),
  readSync: (_fd, buffer, _offset, length) => {
    assert.strictEqual(length, 64 * 1024 * 1024);
    return buffer.write(payload);
  },
  closeSync: () => {},
  readFileSync: () => { fullRead = true; throw new Error('full read'); },
};
const load = new Function('fs', 'Buffer', 'console', 'decryptDbFileContent', 'AUDIT_LOG_FILE', 'AUDIT_LOG_MAX_ENTRIES', 'AUDIT_LOG_MAX_FILE_BYTES',
  `${loadCode}\nreturn loadAuditLogFile();`);
const entries = load(reader, Buffer, console, line => line, 'audit.jsonl', 20000, 64 * 1024 * 1024);
assert.deepStrictEqual(entries.map(e => e.id), ['latest']);
assert.strictEqual(fullRead, false);

let archived = 0;
let written = '';
const writer = {
  statSync: () => ({ size: 201 }),
  copyFileSync: () => { archived++; },
  constants: { COPYFILE_EXCL: 1 },
};
const rewrite = new Function('fs', 'Buffer', 'Date', 'console', 'encryptDbFileContent', 'safeWriteFile', 'AUDIT_LOG_FILE', 'AUDIT_LOG_MAX_FILE_BYTES', 'AUDIT_LOG_TARGET_FILE_BYTES', 'AUDIT_LOG_MAX_ENTRIES',
  `${rewriteCode}\nreturn rewriteAuditLogFile([{id:1},{id:2},{id:3},{id:4},{id:5},{id:6}]);`);
const retained = rewrite(writer, Buffer, Date, console, JSON.stringify, (_path, content) => { written = content; }, 'audit.jsonl', 100, 50, 20);
assert.strictEqual(archived, 1);
assert(Buffer.byteLength(written) <= 50);
assert.deepStrictEqual(retained.map(e => e.id), [4, 5, 6]);
writer.statSync = () => ({ size: 101 });
rewrite(writer, Buffer, Date, console, JSON.stringify, (_path, content) => { written = content; }, 'audit.jsonl', 100, 50, 20);
assert.strictEqual(archived, 1, 'normal size compaction must not accumulate archives');
console.log('Audit log size checks passed.');
