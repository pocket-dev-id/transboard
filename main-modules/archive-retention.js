'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getArchiveDirectory(sourceDirectory, source = {}) {
  const isScheduleFeed = Boolean(source.id);
  const kind = isScheduleFeed ? 'schedule-feed' : 'patient-import';
  const sourceId = isScheduleFeed ? String(source.id) : 'patient';
  const key = crypto.createHash('sha256').update(sourceId).digest('hex').slice(0, 24);
  return path.join(path.resolve(sourceDirectory), 'archive', kind, key);
}

function countArchiveFiles(directory, depth = 0) {
  if (depth > 3) return 0;
  let count = 0;
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.csv') count++;
    else if (entry.isDirectory()) count += countArchiveFiles(file, depth + 1);
  }
  return count;
}

// Only ordinary CSV files in the archive directory are eligible. Invalid or
// unlimited policies preserve everything. Do not follow archive/file symlinks.
async function cleanArchive(directory, retentionDays, shouldDelete = () => true) {
  const days = Number(retentionDays);
  const result = { deleted: 0, errors: [] };
  if (!Number.isInteger(days) || days <= 0) return result;
  try {
    if (!(await fs.promises.lstat(directory)).isDirectory()) return result;
    const cutoff = Date.now() - days * 86400000;
    const names = await fs.promises.readdir(directory);
    for (const name of names) {
      if (path.extname(name).toLowerCase() !== '.csv') continue;
      const file = path.join(directory, name);
      try {
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile() || stat.mtimeMs >= cutoff || !shouldDelete()) continue;
        await fs.promises.unlink(file);
        result.deleted++;
      } catch (error) {
        if (error.code !== 'ENOENT') result.errors.push(`${name}: ${error.message}`);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') result.errors.push(error.message);
  }
  return result;
}
module.exports = { cleanArchive, getArchiveDirectory, countArchiveFiles };
