'use strict';
const crypto = require('crypto');
const MAX_PATIENT_MANIFEST_FILES = 5000;
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
function readPatientManifest(db, folderKey, signature) {
  return (db.patient_import_manifests || []).find(m => m.folderKey === folderKey && m.signature === signature)?.files || [];
}
function recordPatientManifest(db, folderKey, signature, key, digest) {
  const manifests = (db.patient_import_manifests || []).filter(m => m.folderKey !== folderKey);
  const previous = (db.patient_import_manifests || []).find(m => m.folderKey === folderKey && m.signature === signature);
  const files = [...(previous?.files || []).filter(file => file.key !== key), { key, digest }];
  const otherCount = manifests.reduce((count, manifest) => count + manifest.files.length, 0);
  if (otherCount + files.length > MAX_PATIENT_MANIFEST_FILES) return false;
  db.patient_import_manifests = [...manifests, { folderKey, signature, files }];
  return true;
}
function applyPatientImportReceipt(db, receipt) {
  if (!receipt || !receipt.key || !receipt.digest || !receipt.folderKey || !receipt.signature) {
    return { success: false, message: '患者CSVの再処理防止記録を検証できませんでした。原本を保持します' };
  }
  let nextManifest = null;
  if (receipt.skip) {
    nextManifest = {
      patient_import_manifests: (db.patient_import_manifests || []).map(manifest => ({
        ...manifest, files: Array.isArray(manifest.files) ? [...manifest.files] : [],
      })),
    };
    if (!recordPatientManifest(nextManifest, receipt.folderKey, receipt.signature, receipt.key, receipt.digest)) {
      return { success: false, message: 'スキップ運用の再処理防止記録が上限に達したため、患者情報は更新しませんでした。処理済みCSVを整理してください' };
    }
  }
  recordReceipt(db, receipt.key, receipt.digest);
  if (nextManifest) db.patient_import_manifests = nextManifest.patient_import_manifests;
  return { success: true };
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
module.exports = { fingerprint, hasReceipt, recordReceipt, readPatientManifest, recordPatientManifest, applyPatientImportReceipt, readScheduleManifest, recordScheduleManifest };
