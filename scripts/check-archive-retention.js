'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const modulePath = path.join(__dirname, '../main-modules/archive-retention.js');
assert(fs.existsSync(modulePath), 'Shared archive retention must be implemented');
const { cleanArchive } = require(modulePath);
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-retention-'));
  try {
    const old = path.join(dir, 'old.csv'), recent = path.join(dir, 'recent.csv'), other = path.join(dir, 'keep.json');
    for (const file of [old, recent, other]) fs.writeFileSync(file, 'original');
    const stale = new Date(Date.now() - 40 * 86400000);
    fs.utimesSync(old, stale, stale); fs.utimesSync(other, stale, stale);
    await cleanArchive(dir, 0);
    assert(fs.existsSync(old), 'Zero means unlimited');
    await cleanArchive(dir, -1);
    assert(fs.existsSync(old), 'Invalid retention must preserve files');
    await cleanArchive(dir, 30, () => false);
    assert(fs.existsSync(old), 'Configuration change must prevent deletion');
    await cleanArchive(dir, 30);
    assert(!fs.existsSync(old)); assert(fs.existsSync(recent)); assert(fs.existsSync(other));
    const missing = await cleanArchive(path.join(dir, 'missing'), 30);
    assert.strictEqual(missing.deleted, 0);
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
  console.log('Archive retention checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
