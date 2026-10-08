'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { extractByBraceEnd } = require('./lib/extract-source');
const { prepareImportSettings, applyImportSettings } = require('../main-modules/import-settings');
const oldDb = { system_settings: [{ id: 'smb_password', value: 'secret' }, { id: 'show_sync_time', value: 'false' }] };
const input = {
  import_directory: 'C:\\imports',
  import_mapping: JSON.stringify({ bed_number: 'bed' }),
  import_schedule: JSON.stringify({ mode: 'interval' }),
  import_retention_policy: JSON.stringify({ action: 'skip', retentionDays: '30' }),
  show_sync_time: 'true', smb_password: '********',
};
const prepared = prepareImportSettings(input);
const updated = applyImportSettings(oldDb, prepared);
assert.strictEqual(updated.system_settings.find(item => item.id === 'show_sync_time').value, 'true');
assert.strictEqual(updated.system_settings.find(item => item.id === 'smb_password').value, 'secret', 'Masked credentials must remain unchanged');
assert.strictEqual(oldDb.system_settings.find(item => item.id === 'show_sync_time').value, 'false', 'Preparing settings must not partially mutate persisted state');
assert.throws(() => prepareImportSettings({ ...input, import_schedule: '{broken' }), /JSON/);
assert.throws(() => prepareImportSettings({ ...input, unknown_setting: 'x' }), /未対応/);
assert.throws(() => prepareImportSettings({ ...input, import_retention_policy: JSON.stringify({ action: 'purge' }) }), /動作/);
assert.throws(() => prepareImportSettings({ ...input, show_sync_time: true }), /形式またはサイズ/);
const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(root, 'js/api.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'js/settings/import-notify.js'), 'utf8');
const saveBody = extractByBraceEnd(mainSource, 'function saveImportSettingsOnParent(');
assert(saveBody, 'The atomic settings save function must be found');
assert.strictEqual((saveBody.match(/writeDB\(/g) || []).length, 1, 'Validated import settings must persist through one DB write');
assert(saveBody.includes('prepareImportSettings') && saveBody.includes('applyImportSettings'), 'All values must be validated and prepared before persistence');
assert(apiSource.includes("this._fetch('actions/save-import-settings'"), 'The local API must use the atomic main-process action');
assert(uiSource.includes('await API.saveImportSettings(settingsPayload)'), 'The settings UI must save the local payload as one request');
console.log('Import settings checks passed.');
