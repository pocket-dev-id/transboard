const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nfcSelfService', {
  startReader: () => ipcRenderer.invoke('nfc:start'),
  stopReader: () => ipcRenderer.invoke('nfc:stop'),
  buildCardPayload: (uid) => ipcRenderer.invoke('card:build-payload', uid),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  copySubmission: (form) => ipcRenderer.invoke('submission:copy', form),
  saveSubmission: (form, format) => ipcRenderer.invoke('submission:save', { form, format }),
  onCardScanned: (callback) => {
    ipcRenderer.removeAllListeners('card-scanned');
    ipcRenderer.on('card-scanned', (event, payload) => callback(payload));
  },
  onReaderStatus: (callback) => {
    ipcRenderer.removeAllListeners('reader-status');
    ipcRenderer.on('reader-status', (event, status) => callback(status));
  },
});
