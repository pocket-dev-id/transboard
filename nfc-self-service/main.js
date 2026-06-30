const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

let mainWindow;
let nfcProcess = null;
let lastUid = '';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#f4f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

function getReaderScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'nfc-reader.ps1')
    : path.join(__dirname, 'nfc-reader.ps1');
}

function sendReaderStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('reader-status', status);
  }
}

function startNfcWatcher() {
  if (nfcProcess) {
    sendReaderStatus({ running: true, message: 'NFCリーダー監視中です。カードをかざしてください。' });
    return { success: true, message: 'NFCリーダー監視中です。' };
  }

  const scriptPath = getReaderScriptPath();
  if (!fs.existsSync(scriptPath)) {
    return { success: false, message: `NFC読み取りスクリプトが見つかりません: ${scriptPath}` };
  }

  nfcProcess = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  sendReaderStatus({ running: true, message: 'NFCリーダーを監視しています。カードをかざしてください。' });

  nfcProcess.stdout.on('data', (data) => {
    const lines = data.toString().split(/\r?\n/);
    for (const line of lines) {
      const match = line.trim().match(/^UID:([0-9A-Fa-f]+)$/);
      if (!match) continue;
      lastUid = match[1].toUpperCase();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('card-scanned', buildCardPayload(lastUid));
      }
    }
  });

  nfcProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) sendReaderStatus({ running: true, warning: text });
  });

  nfcProcess.on('exit', () => {
    nfcProcess = null;
    sendReaderStatus({ running: false, message: 'NFCリーダー監視を停止しました。' });
  });

  nfcProcess.on('error', (err) => {
    nfcProcess = null;
    sendReaderStatus({ running: false, error: err.message });
  });

  return { success: true, message: 'NFCリーダー監視を開始しました。' };
}

function stopNfcWatcher() {
  if (nfcProcess) {
    nfcProcess.kill();
    nfcProcess = null;
  }
  sendReaderStatus({ running: false, message: 'NFCリーダー監視を停止しました。' });
  return { success: true };
}

function buildCardPayload(uid) {
  const normalizedUid = String(uid || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const hash = crypto.createHash('sha256').update(normalizedUid, 'utf8').digest('hex').toUpperCase();
  return {
    uid: normalizedUid,
    uidHashSha256: hash,
    readAt: new Date().toISOString(),
    source: 'pcsc-apdu-ffca',
  };
}

function buildSubmissionRecord(form) {
  const card = buildCardPayload(form.cardUid || lastUid);
  return {
    submittedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    user: {
      employeeId: String(form.employeeId || '').trim(),
      name: String(form.name || '').trim(),
      department: String(form.department || '').trim(),
      email: String(form.email || '').trim(),
    },
    card,
    note: String(form.note || '').trim(),
  };
}

function toCsv(record) {
  const headers = [
    'submittedAt',
    'employeeId',
    'name',
    'department',
    'email',
    'cardUid',
    'cardUidHashSha256',
    'readAt',
    'note',
  ];
  const row = [
    record.submittedAt,
    record.user.employeeId,
    record.user.name,
    record.user.department,
    record.user.email,
    record.card.uid,
    record.card.uidHashSha256,
    record.card.readAt,
    record.note,
  ];
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return `${headers.join(',')}\r\n${row.map(escape).join(',')}\r\n`;
}

ipcMain.handle('nfc:start', () => startNfcWatcher());
ipcMain.handle('nfc:stop', () => stopNfcWatcher());
ipcMain.handle('card:build-payload', (event, uid) => buildCardPayload(uid));
ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('submission:copy', (event, form) => {
  const record = buildSubmissionRecord(form);
  clipboard.writeText(JSON.stringify(record, null, 2));
  return { success: true, record };
});

ipcMain.handle('submission:save', async (event, { form, format }) => {
  const record = buildSubmissionRecord(form);
  const safeId = (record.user.employeeId || record.user.email || record.user.name || 'nfc-card')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .slice(0, 48);
  const defaultPath = `nfc_enrollment_${safeId}_${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : 'json'}`;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '提出用ファイルを保存',
    defaultPath,
    filters: format === 'csv'
      ? [{ name: 'CSV Files', extensions: ['csv'] }]
      : [{ name: 'JSON Files', extensions: ['json'] }],
  });

  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }

  const content = format === 'csv' ? toCsv(record) : JSON.stringify(record, null, 2);
  fs.writeFileSync(result.filePath, content, 'utf8');
  return { success: true, filePath: result.filePath, record };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopNfcWatcher();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
