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
  completeDataImport: (payload) => ipcRenderer.invoke('complete-data-import', payload),
  onArchiveError: (callback) => {
    ipcRenderer.removeAllListeners('archive-error');
    ipcRenderer.on('archive-error', (event, value) => callback(value));
  },
  
  // 監視フォルダパスの取得
  getWatchDirectory: () => ipcRenderer.invoke('get-watch-directory'),
  
  // 監視フォルダパスの更新
  updateWatchDirectory: (newPath) => ipcRenderer.invoke('update-watch-directory', newPath),
  stopParentServer: () => ipcRenderer.invoke('stop-parent-server'),
  
  // システム全体の初期化リセット
  resetDatabase: () => ipcRenderer.invoke('reset-database'),
  
  // ローカルJSONデータベースへのリクエスト
  dbRequest: (req) => ipcRenderer.invoke('db-request', req),

  // WebRTCシグナリングリクエスト
  webrtcRequest: (req) => ipcRenderer.invoke('webrtc-request', req),

  // 子機→親機HTTPリクエストをメインプロセス経由で中継する（レンダラーfetch()のLocal Network Access制限を回避）
  parentHttpRequest: (req) => ipcRenderer.invoke('parent-http-request', req),

  // 手動取り込み実行のトリガー
  triggerManualImport: () => ipcRenderer.invoke('trigger-manual-import'),
  
  // ODBC接続テストの実行
  testOdbcConnection: (config) => ipcRenderer.invoke('test-odbc-connection', config),
  
   // ODBC同期の実行
  runOdbcSync: (config) => ipcRenderer.invoke('run-odbc-sync', config),
  previewOdbcQuery: (config) => ipcRenderer.invoke('preview-odbc-query', config),
  
  // 親機PC自身のローカルIPアドレス一覧を取得する
  getLocalIPs: () => ipcRenderer.invoke('get-local-ips'),

  // アプリケーションを再起動する
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),

  // フルスクリーン切り替え(現在の状態をトグル)
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  // フルスクリーンの期待状態を明示的に指定するブリッジ(トグルとは別)。
  // ビデオ通話の全画面表示のように「必ずONにする/必ずOFFにする」呼び出し元向け
  setFullscreen: (value) => ipcRenderer.invoke('set-fullscreen', Boolean(value)),
  // 現在のフルスクリーン状態を取得する(状態変更のpush通知だけに頼らず、
  // ダイアログを開いた時点の実際の状態と初期表示を合わせるため)
  isFullscreen: () => ipcRenderer.invoke('is-fullscreen'),
  // フルスクリーン状態変更の通知。全体のフルスクリーンボタン(js/app.js)と
  // ビデオ通話の全画面ボタン(js/call.js)など、複数の呼び出し元が独立に
  // 購読できるよう、removeAllListenersでは無くlistenerを都度追加し、
  // 購読解除用の関数を返す(呼び出し元は不要になったら呼ぶ)
  onFullscreenChanged: (callback) => {
    const listener = (event, value) => callback(value);
    ipcRenderer.on('fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('fullscreen-changed', listener);
  },

  // データベースバックアップ & リストア
  backupDatabase: (opts) => ipcRenderer.invoke('backup-db', opts),
  restoreDatabase: (opts) => ipcRenderer.invoke('restore-db', opts),

  // データベース保存先管理
  getDatabaseStorageInfo: () => ipcRenderer.invoke('get-database-storage-info'),
  changeDatabaseStorageMode: (mode) => ipcRenderer.invoke('change-database-storage-mode', mode),
  getEncryptionStatus: () => ipcRenderer.invoke('get-encryption-status'),
  getArchiveInfo: () => ipcRenderer.invoke('get-archive-info'),
  getDbInfo: () => ipcRenderer.invoke('get-db-info'),
  exportDiagnosticsBundle: () => ipcRenderer.invoke('export-diagnostics-bundle'),

  // NFC カードスキャン
  onCardScanned: (callback) => {
    ipcRenderer.removeAllListeners('card-scanned');
    ipcRenderer.on('card-scanned', (event, uid) => callback(uid));
  },

  // アプリバージョン取得
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPasscodeStatus: () => ipcRenderer.invoke('get-passcode-status'),
  verifyAdminPasscode: (passcode) => ipcRenderer.invoke('verify-admin-passcode', passcode),
  setAdminPasscode: (passcode) => ipcRenderer.invoke('set-admin-passcode', passcode),
  getTerminalApiToken: () => ipcRenderer.invoke('get-terminal-api-token'),
  setTerminalApiToken: (token) => ipcRenderer.invoke('set-terminal-api-token', token),
  getTerminalRole: () => ipcRenderer.invoke('get-terminal-role'),
  setTerminalRole: (role) => ipcRenderer.invoke('set-terminal-role', role),
  cleanupEventRetention: () => ipcRenderer.invoke('cleanup-event-retention'),

  // アプリ更新（自前アップデータ）
  checkForUpdate: (opts) => ipcRenderer.invoke('check-for-update', opts),
  downloadAndInstallUpdate: (opts) => ipcRenderer.invoke('download-and-install-update', opts),

  // 親機の更新配信管理
  getUpdateDistInfo: () => ipcRenderer.invoke('get-update-dist-info'),
  importUpdateFiles: () => ipcRenderer.invoke('import-update-files'),
  rollbackUpdateDist: () => ipcRenderer.invoke('rollback-update-dist'),

  // 開発/本番モード判定 (インフラ #4)
  isDevMode: () => ipcRenderer.invoke('is-dev-mode'),


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

  // PCのホスト名を取得する
  getHostname: () => ipcRenderer.invoke('get-hostname'),

  // このプロセスがWindows管理者権限(昇格)で起動されているか(true/false)。
  // Windows以外ではnull(判定不能)
  isElevated: () => ipcRenderer.invoke('is-elevated'),

  // 診断用デバッグログ（接続テスト失敗時などの詳細をファイルへ記録・メモ帳等で開く）
  appendDebugLog: (line) => ipcRenderer.invoke('append-debug-log', line),
  openDebugLog: () => ipcRenderer.invoke('open-debug-log'),

  // フォルダ選択ダイアログを開く
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // 指定フォルダ内の最初のCSVのヘッダ行を読み取る
  readCsvHeaders: (folderPath, encoding = 'auto') => ipcRenderer.invoke('read-csv-headers', { folderPath, encoding }),

  // 列マッピング設定が実データの1行をどう解釈するかをプレビューする
  previewScheduleDatetime: (args) => ipcRenderer.invoke('preview-schedule-datetime', args),

  // スクリーンセイバー・ディスプレイスリープの抑制
  setPowerSave: (prevent) => ipcRenderer.invoke('set-power-save', prevent),

  // ウィンドウを常に最前面に表示する
  setAlwaysOnTop: (value) => ipcRenderer.invoke('set-always-on-top', value),
});
