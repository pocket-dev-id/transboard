'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateStorage } = require('../main-modules/storage-migration');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-storage-'));
try {
  const source = path.join(root, 'user'), target = path.join(root, 'common');
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'db.json'), '{"beds":[]}');
  fs.writeFileSync(path.join(source, 'audit-log.jsonl'), 'history\n');
  let mode = 'user';
  const args = { sourceDir: source, targetDir: target, validateDb: text => JSON.parse(text), commitMode: () => { mode = 'common'; } };
  fs.writeFileSync(path.join(target, 'db.json'), '{"beds":[1]}');
  assert.throws(() => migrateStorage(args), /既存/);
  assert.strictEqual(mode, 'user');
  fs.unlinkSync(path.join(target, 'db.json'));
  assert.throws(() => migrateStorage({ ...args, commitMode: () => { throw Error('disk full'); } }), /disk full/);
  assert.strictEqual(mode, 'user');
  assert(!fs.existsSync(path.join(target, 'db.json')), 'Failed switch must remove newly copied files');
  migrateStorage(args);
  assert.strictEqual(mode, 'common');
  assert.strictEqual(fs.readFileSync(path.join(target, 'audit-log.jsonl'), 'utf8'), 'history\n');
  assert.strictEqual(fs.readFileSync(path.join(source, 'db.json'), 'utf8'), '{"beds":[]}');
  const largeAudit = path.join(source, 'audit-log.jsonl');
  fs.writeFileSync(largeAudit, Buffer.alloc(8 * 1024 * 1024, 65));
  fs.unlinkSync(path.join(target, 'audit-log.jsonl'));
  fs.unlinkSync(path.join(target, 'db.json'));
  const originalRead = fs.readFileSync;
  fs.readFileSync = function(file, ...options) {
    if (String(file) === largeAudit) throw Error('Audit log must be copied without loading it into memory');
    return originalRead.call(this, file, ...options);
  };
  try { migrateStorage(args); } finally { fs.readFileSync = originalRead; }
  assert.strictEqual(fs.statSync(path.join(target, 'audit-log.jsonl')).size, 8 * 1024 * 1024);
  mode = 'user';
  assert.throws(() => migrateStorage({ ...args, validateDb: () => { throw Error('corrupt'); } }), /corrupt/);
  assert.strictEqual(mode, 'user');
  console.log('Storage migration checks passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
