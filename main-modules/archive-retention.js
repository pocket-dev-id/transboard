'use strict';
const fs = require('fs');
const path = require('path');

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
module.exports = { cleanArchive };
