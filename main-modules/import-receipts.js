'use strict';
const crypto = require('crypto');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function fingerprint(content, settings) {
  return crypto.createHash('sha256').update(content).update('\0').update(JSON.stringify(canonical(settings))).digest('hex');
}
function hasReceipt(db, key, digest) {
  return (db.import_receipts || []).some(r => r.key === key && r.digest === digest);
}
function recordReceipt(db, key, digest) {
  db.import_receipts = [...(db.import_receipts || []).filter(r => r.key !== key), {key,digest,processedAt:Date.now()}].slice(-512);
}
// Cleanup provenance must never depend on the evictable receipt cache. Keep
// one durable manifest per active feed; reject oversized state before saving.
function readScheduleManifest(db, feedId, signature) {
  return (db.schedule_import_manifests || []).find(m => m.feedId === feedId && m.signature === signature)?.files || [];
}
function recordScheduleManifest(db, feedId, signature, files) {
  const activeIds = new Set((db.schedule_feeds || []).map(f => f.id));
  const others = (db.schedule_import_manifests || []).filter(m => m.feedId !== feedId && activeIds.has(m.feedId));
  if (others.reduce((n,m) => n + m.files.length, files.length) > 5000) return false;
  db.schedule_import_manifests = files.length
    ? [...others, {feedId,signature,files:files.map(p => ({key:p.receiptKey,digest:p.digest}))}]
    : others;
  return true;
}
module.exports = { fingerprint, hasReceipt, recordReceipt, readScheduleManifest, recordScheduleManifest };
