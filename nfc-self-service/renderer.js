const fields = {
  employeeId: document.getElementById('employee-id'),
  name: document.getElementById('name'),
  department: document.getElementById('department'),
  email: document.getElementById('email'),
  note: document.getElementById('note'),
  cardUid: document.getElementById('card-uid'),
  cardHash: document.getElementById('card-hash'),
};

const statusText = document.getElementById('reader-status-text');
const scanBox = document.getElementById('scan-box');
const scanTitle = document.getElementById('scan-title');
const scanSubtitle = document.getElementById('scan-subtitle');
const preview = document.getElementById('preview');
const toast = document.getElementById('toast');

let lastReadAt = '';

function getForm() {
  return {
    employeeId: fields.employeeId.value,
    name: fields.name.value,
    department: fields.department.value,
    email: fields.email.value,
    note: fields.note.value,
    cardUid: fields.cardUid.value,
  };
}

function showToast(message, type = 'info') {
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.className = 'toast';
  }, 4200);
}

function validateForm() {
  if (!fields.employeeId.value.trim() && !fields.email.value.trim()) {
    showToast('職員番号またはメールアドレスを入力してください。', 'warning');
    return false;
  }
  if (!fields.name.value.trim()) {
    showToast('氏名を入力してください。', 'warning');
    return false;
  }
  if (!fields.cardUid.value.trim()) {
    showToast('NFCカードを読み取ってください。', 'warning');
    return false;
  }
  return true;
}

function buildPreview() {
  const form = getForm();
  if (!form.cardUid) {
    preview.textContent = 'カードを読み取ると提出データのプレビューが表示されます。';
    return;
  }

  const record = {
    submittedAt: new Date().toISOString(),
    user: {
      employeeId: form.employeeId.trim(),
      name: form.name.trim(),
      department: form.department.trim(),
      email: form.email.trim(),
    },
    card: {
      uid: form.cardUid.trim(),
      uidHashSha256: fields.cardHash.value.trim(),
      readAt: lastReadAt,
      source: 'pcsc-apdu-ffca',
    },
    note: form.note.trim(),
  };
  preview.textContent = JSON.stringify(record, null, 2);
}

async function setCard(payload) {
  fields.cardUid.value = payload.uid || '';
  fields.cardHash.value = payload.uidHashSha256 || '';
  lastReadAt = payload.readAt || new Date().toISOString();
  scanBox.classList.add('scanned');
  scanTitle.textContent = 'カードを読み取りました';
  scanSubtitle.textContent = `UID: ${payload.uid}`;
  buildPreview();
  showToast('NFCカードを読み取りました。提出内容を確認してください。', 'success');
}

document.getElementById('start-reader').addEventListener('click', async () => {
  const result = await window.nfcSelfService.startReader();
  showToast(result.message || (result.success ? '読み取りを開始しました。' : '読み取りを開始できませんでした。'), result.success ? 'success' : 'danger');
});

document.getElementById('stop-reader').addEventListener('click', async () => {
  await window.nfcSelfService.stopReader();
  showToast('読み取りを停止しました。', 'info');
});

document.getElementById('clear-card').addEventListener('click', () => {
  fields.cardUid.value = '';
  fields.cardHash.value = '';
  lastReadAt = '';
  scanBox.classList.remove('scanned');
  scanTitle.textContent = 'カード未読み取り';
  scanSubtitle.textContent = '「読み取り開始」を押してカードをかざしてください。';
  buildPreview();
});

document.getElementById('copy-json').addEventListener('click', async () => {
  if (!validateForm()) return;
  await window.nfcSelfService.copySubmission(getForm());
  showToast('提出用JSONをクリップボードへコピーしました。', 'success');
});

document.getElementById('save-json').addEventListener('click', async () => {
  if (!validateForm()) return;
  const result = await window.nfcSelfService.saveSubmission(getForm(), 'json');
  if (result.success) showToast('JSONファイルを保存しました。', 'success');
});

document.getElementById('save-csv').addEventListener('click', async () => {
  if (!validateForm()) return;
  const result = await window.nfcSelfService.saveSubmission(getForm(), 'csv');
  if (result.success) showToast('CSVファイルを保存しました。', 'success');
});

Object.values(fields).forEach((field) => {
  field.addEventListener('input', buildPreview);
});

window.nfcSelfService.onCardScanned(setCard);
window.nfcSelfService.onReaderStatus((status) => {
  if (status.error) {
    statusText.textContent = `エラー: ${status.error}`;
    showToast(status.error, 'danger');
    return;
  }
  if (status.warning) {
    statusText.textContent = status.warning;
    return;
  }
  statusText.textContent = status.message || (status.running ? 'NFCリーダー監視中です。' : 'リーダー監視は停止中です。');
});

window.nfcSelfService.getVersion().then((version) => {
  document.getElementById('app-version').textContent = version;
});
