(function installWailsElectronCompat(global) {
  'use strict';

  if (global.electronAPI && global.electronAPI.__transboardWailsCompat !== true) return;

  const app = () => global.go?.main?.App || null;
  const invoke = (method, ...args) => {
    const target = app();
    if (!target || typeof target[method] !== 'function') {
      return Promise.reject(new Error(`Wails binding is unavailable: ${method}`));
    }
    try {
      return Promise.resolve(target[method](...args));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const on = (eventName, callback) => {
    if (typeof global.runtime?.EventsOn !== 'function') return () => {};
    return global.runtime.EventsOn(eventName, callback);
  };

  global.electronAPI = {
    __transboardWailsCompat: true,
    onDataImported: callback => on('data-imported', callback),
    onDataImportFailed: callback => on('data-import-failed', callback),
    completeDataImport: payload => invoke('CompleteDataImport', payload),
    onArchiveError: callback => on('archive-error', callback),
    getWatchDirectory: () => invoke('GetWatchDirectory').then(result => result?.path || ''),
    updateWatchDirectory: path => invoke('UpdateWatchDirectory', path),
    resetDatabase: token => invoke('ResetDatabase', token || ''),
    dbRequest: request => invoke('DBRequest', request),
    webrtcRequest: request => invoke('WebrtcRequest', request),
    parentHttpRequest: request => invoke('ParentHttpRequest', request),
    triggerManualImport: () => invoke('TriggerManualImport'),
    testOdbcConnection: config => invoke('TestOdbcConnection', config),
    runOdbcSync: config => invoke('RunOdbcSync', config),
    previewOdbcQuery: config => invoke('PreviewOdbcQuery', config),
    getLocalIPs: () => invoke('GetLocalIPs'),
    getHostname: () => invoke('GetHostname'),
    relaunchApp: () => invoke('RelaunchApp'),
    toggleFullscreen: () => invoke('ToggleFullscreen'),
    onFullscreenChanged: callback => on('fullscreen-changed', callback),
    backupDatabase: options => invoke('BackupDatabase', options || {}),
    restoreDatabase: options => invoke('RestoreDatabase', options || {}),
    getDatabaseStorageInfo: () => invoke('GetDatabaseStorageInfo'),
    changeDatabaseStorageMode: mode => invoke('ChangeDatabaseStorageMode', mode),
    getEncryptionStatus: () => invoke('GetEncryptionStatus'),
    getArchiveInfo: () => invoke('GetArchiveInfo'),
    getDbInfo: () => invoke('GetDbInfo'),
    exportDiagnosticsBundle: () => invoke('ExportDiagnosticsBundle'),
    onCardScanned: callback => on('card-scanned', callback),
    getAppVersion: () => invoke('GetAppVersion'),
    getPasscodeStatus: () => invoke('GetPasscodeStatus'),
    verifyAdminPasscode: passcode => invoke('VerifyAdminPasscode', passcode),
    setAdminPasscode: passcode => invoke('SetAdminPasscode', passcode),
    getTerminalApiToken: () => invoke('GetTerminalApiToken'),
    setTerminalApiToken: token => invoke('SetTerminalApiToken', token),
    getTerminalRole: () => invoke('GetTerminalRole'),
    setTerminalRole: role => invoke('SetTerminalRole', role),
    cleanupEventRetention: () => invoke('CleanupEventRetention'),
    checkForUpdate: options => invoke('CheckForUpdate', options || {}),
    downloadAndInstallUpdate: options => invoke('DownloadAndInstallUpdate', options || {}),
    getUpdateDistInfo: () => invoke('GetUpdateDistInfo'),
    importUpdateFiles: () => invoke('ImportUpdateFiles'),
    rollbackUpdateDist: () => invoke('RollbackUpdateDist'),
    isDevMode: () => invoke('IsDevMode'),
    getStartupSetting: () => invoke('GetStartupSetting'),
    setStartupSetting: settings => invoke('SetStartupSetting', settings || {}),
    onScheduleImported: callback => on('schedule-imported', callback),
    triggerScheduleFeedImport: feedId => invoke('TriggerScheduleFeedImport', feedId),
    reloadScheduleFeedTriggers: () => invoke('ReloadScheduleFeedTriggers'),
    getOdbcDsns: () => invoke('GetOdbcDsns'),
    getOdbcTables: config => invoke('GetOdbcTables', config),
    appendDebugLog: line => invoke('AppendDebugLog', line),
    openDebugLog: () => invoke('OpenDebugLog'),
    selectFolder: () => invoke('SelectFolder').then(result => result?.path || ''),
    readCsvHeaders: (path, encoding = 'auto') => invoke('ReadCsvHeaders', path, encoding),
    setPowerSave: prevent => invoke('SetPowerSave', prevent),
    setAlwaysOnTop: value => invoke('SetAlwaysOnTop', value),
  };
})(window);
