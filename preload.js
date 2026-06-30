const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // メインプロセスからのデータ受信イベントハンドラを登録
  onDataImported: (callback) => {
    ipcRenderer.removeAllListeners('data-imported');
    ipcRenderer.on('data-imported', (event, value) => callback(value));
  },
  onDataImportFailed: (callback) => {
    ipcRenderer.removeAllListeners('data-import-failed');
    ipcRenderer.on('data-import-failed', (event, value) => callback(value));
  },
  onArchiveError: (callback) => {
    ipcRenderer.removeAllListeners('archive-error');
    ipcRenderer.on('archive-error', (event, value) => callback(value));
  },
  
  // 監視フォルダパスの取得
  getWatchDirectory: () => ipcRenderer.invoke('get-watch-directory'),
  
  // 監視フォルダパスの更新
  updateWatchDirectory: (newPath) => ipcRenderer.invoke('update-watch-directory', newPath),
  
  // システム全体の初期化リセット
  resetDatabase: () => ipcRenderer.invoke('reset-database'),
  
  // ローカルJSONデータベースへのリクエスト
  dbRequest: (req) => ipcRenderer.invoke('db-request', req),

  // WebRTCシグナリングリクエスト
  webrtcRequest: (req) => ipcRenderer.invoke('webrtc-request', req),

  // 手動取り込み実行のトリガー
  triggerManualImport: () => ipcRenderer.invoke('trigger-manual-import'),
  
  // ODBC接続テストの実行
  testOdbcConnection: (config) => ipcRenderer.invoke('test-odbc-connection', config),
  
   // ODBC同期の実行
  runOdbcSync: (config) => ipcRenderer.invoke('run-odbc-sync', config),
  
  // 親機PC自身のローカルIPアドレス一覧を取得する
  getLocalIPs: () => ipcRenderer.invoke('get-local-ips'),

  // アプリケーションを再起動する
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),

  // フルスクリーン切り替え
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  onFullscreenChanged: (callback) => ipcRenderer.on('fullscreen-changed', (event, value) => callback(value)),

  // データベースバックアップ & リストア
  backupDatabase: () => ipcRenderer.invoke('backup-db'),
  restoreDatabase: () => ipcRenderer.invoke('restore-db'),

  // データベース保存先管理
  getDatabaseStorageInfo: () => ipcRenderer.invoke('get-database-storage-info'),
  changeDatabaseStorageMode: (mode) => ipcRenderer.invoke('change-database-storage-mode', mode),

  // NFC カードスキャン
  onCardScanned: (callback) => ipcRenderer.on('card-scanned', (event, uid) => callback(uid)),
  setNfcWatcher: (enabled) => ipcRenderer.invoke('set-nfc-watcher', enabled),

  // アプリバージョン取得
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // OSデスクトップ通知（メインプロセス経由）
  showOsNotification: (title, body) => ipcRenderer.invoke('show-os-notification', { title, body }),

  // スタートアップ（Windows ログイン時自動起動）設定
  getStartupSetting: () => ipcRenderer.invoke('get-startup-setting'),
  setStartupSetting: (settings) => ipcRenderer.invoke('set-startup-setting', settings),

  // 汎用スケジュール取り込み
  onScheduleImported: (callback) => {
    ipcRenderer.removeAllListeners('schedule-imported');
    ipcRenderer.on('schedule-imported', (event, value) => callback(value));
  },
  triggerScheduleFeedImport: (feedId) => ipcRenderer.invoke('trigger-schedule-feed-import', feedId),
  reloadScheduleFeedTriggers: () => ipcRenderer.invoke('reload-schedule-feed-triggers'),

  // WindowsレジストリからODBC DSN / ドライバ一覧を取得する
  getOdbcDsns: () => ipcRenderer.invoke('get-odbc-dsns'),

  // ODBC接続先のテーブル/ビュー一覧を取得する
  getOdbcTables: (config) => ipcRenderer.invoke('get-odbc-tables', config),
});
