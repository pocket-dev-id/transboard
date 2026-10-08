'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fileDigest(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

// Keep the original files. The mode is committed only after every copy verifies.
function migrateStorage({ sourceDir, targetDir, validateDb, commitMode }) {
  if (path.resolve(sourceDir) === path.resolve(targetDir)) return;
  const sourceDb = path.join(sourceDir, 'db.json');
  if (!fs.existsSync(sourceDb)) throw Error('移行元のDBがありません');
  fs.mkdirSync(targetDir, { recursive: true });
  const files = ['db.json', 'audit-log.jsonl', 'db.json.bak'].filter(name => fs.existsSync(path.join(sourceDir, name)));
  validateDb(fs.readFileSync(sourceDb, 'utf8'));
  const snapshots = files.map(name => ({ name, digest: fileDigest(path.join(sourceDir, name)) }));
  for (const { name, digest } of snapshots) {
    const dest = path.join(targetDir, name);
    if (fs.existsSync(dest) && fileDigest(dest) !== digest) {
      throw Error(`移行先に異なる既存データがあります (${name})。バックアップして移行先を空にしてください`);
    }
  }
  const created = [], temporary = [];
  try {
    for (const { name, digest } of snapshots) {
      const dest = path.join(targetDir, name);
      if (fs.existsSync(dest)) continue;
      const temp = dest + `.migration-${process.pid}.tmp`;
      temporary.push(temp);
      fs.copyFileSync(path.join(sourceDir, name), temp, fs.constants.COPYFILE_EXCL);
      if (fileDigest(temp) !== digest) throw Error(`コピーの検証に失敗しました (${name})`);
      // COPYFILE_EXCL avoids overwriting a file created by another process.
      fs.copyFileSync(temp, dest, fs.constants.COPYFILE_EXCL);
      created.push(dest);
      fs.unlinkSync(temp);
    }
    for (const { name, digest } of snapshots) {
      if (fileDigest(path.join(sourceDir, name)) !== digest ||
          fileDigest(path.join(targetDir, name)) !== digest) {
        throw Error('移行中にデータが更新されました。取込・更新を停止して再実行してください');
      }
    }
    commitMode();
  } catch (error) {
    for (const file of created) { try { fs.unlinkSync(file); } catch {} }
    throw error;
  } finally {
    for (const file of temporary) { try { fs.unlinkSync(file); } catch {} }
  }
}
module.exports = { migrateStorage };
