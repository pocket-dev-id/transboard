'use strict';

const ALLOWED_IMPORT_SETTINGS = new Set([
  'import_directory', 'import_mapping', 'import_schedule', 'import_retention_policy',
  'import_connection_type', 'odbc_connection_string', 'odbc_sql_query',
  'smb_auth_mode', 'smb_username', 'smb_password', 'show_sync_time', 'show_import_time',
]);
const JSON_IMPORT_SETTINGS = new Set(['import_mapping', 'import_schedule', 'import_retention_policy']);

function prepareImportSettings(settings, maskedSecretValue = '********') {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('連携設定の形式が不正です');
  }
  const entries = Object.entries(settings);
  if (!entries.length || entries.some(([id]) => !ALLOWED_IMPORT_SETTINGS.has(id))) {
    throw new Error('連携設定に未対応の項目が含まれています');
  }
  for (const [id, value] of entries) {
    if (typeof value !== 'string' || value.length > 200000) {
      throw new Error(`連携設定「${id}」の形式またはサイズが不正です`);
    }
    if (JSON_IMPORT_SETTINGS.has(id)) {
      let parsed;
      try { parsed = JSON.parse(value); } catch { throw new Error(`連携設定「${id}」のJSONが不正です`); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`連携設定「${id}」はオブジェクトで指定してください`);
      }
      if (id === 'import_retention_policy' && !['archive', 'delete', 'skip'].includes(parsed.action)) {
        throw new Error('CSV処理後の動作が不正です');
      }
    }
  }
  return entries.filter(([, value]) => value !== maskedSecretValue);
}

function applyImportSettings(db, entries) {
  const next = { ...db, system_settings: (db.system_settings || []).map(record => ({ ...record })) };
  for (const [id, value] of entries) {
    const record = next.system_settings.find(item => item.id === id);
    if (record) record.value = value;
    else next.system_settings.push({ id, value });
  }
  return next;
}

module.exports = { ALLOWED_IMPORT_SETTINGS, prepareImportSettings, applyImportSettings };
