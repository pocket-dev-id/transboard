// js/call.js (WebRTC音声・ビデオ通話) の主要な不具合修正を固定するための回帰テスト。
// device-presence.js と異なりブラウザAPI(DOM/WebRTC/AudioContext等)に依存するため、
// この1ファイル専用の軽量モックをsandboxとして与え、vmコンテキスト上でCallPanelを
// 読み込んで直接メソッドを呼び出す。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'frontend/js/call.js'), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── DOM モック ──
// getElementById はIDベースの単純なレジストリ参照。実DOMと同様、要素がどのツリー配下に
// 実際に追加されたかは無関係にID一致だけで解決されるため、これで call.js の用法には十分。
function createElementStub(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    dataset: {},
    onclick: null,
    srcObject: null,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : force;
        if (on) this._set.add(c); else this._set.delete(c);
        return on;
      },
      contains(c) { return this._set.has(c); },
    },
    appendChild(child) { return child; },
    remove() { this._removed = true; },
    requestFullscreen() { return Promise.resolve(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

const KNOWN_IDS = [
  'announce-custom-text', 'announcement-history-list', 'btn-call-toggle',
  'btn-clear-ann-history', 'btn-send-announce-custom', 'btn-stop-speech',
  'call-panel', 'call-panel-body', 'call-panel-close', 'exam-room-select',
  'webrtc-btn-accept', 'webrtc-btn-cancel-selection', 'webrtc-btn-close-selection',
  'webrtc-btn-fullscreen', 'webrtc-btn-hangup', 'webrtc-btn-lower-quality',
  'webrtc-btn-mute', 'webrtc-btn-reject', 'webrtc-btn-start-video',
  'webrtc-btn-start-voice', 'webrtc-call-duration', 'webrtc-call-overlay',
  'webrtc-call-status-label', 'webrtc-cam-select', 'webrtc-local-video',
  'webrtc-mic-select', 'webrtc-net-stats', 'webrtc-quality-indicator',
  'webrtc-quality-select', 'webrtc-remote-video', 'webrtc-video-container',
];

const elementRegistry = new Map();
function resetElementRegistry() {
  elementRegistry.clear();
  for (const id of KNOWN_IDS) {
    const el = createElementStub('div');
    el.id = id;
    elementRegistry.set(id, el);
  }
}

const fullscreenListeners = [];

const documentMock = {
  fullscreenElement: null,
  getElementById(id) { return elementRegistry.get(id) || null; },
  createElement(tag) { return createElementStub(tag); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { appendChild(el) { return el; } },
  addEventListener(type, handler) {
    if (type === 'fullscreenchange') fullscreenListeners.push(handler);
  },
  removeEventListener(type, handler) {
    if (type === 'fullscreenchange') {
      const idx = fullscreenListeners.indexOf(handler);
      if (idx !== -1) fullscreenListeners.splice(idx, 1);
    }
  },
  exitFullscreen() { documentMock.fullscreenElement = null; return Promise.resolve(); },
};

// ── localStorage モック（_videoQualityPresetの初期化がロード時に参照する）──
const localStorageStore = new Map();
const localStorageMock = {
  getItem(key) { return localStorageStore.has(key) ? localStorageStore.get(key) : null; },
  setItem(key, val) { localStorageStore.set(key, String(val)); },
};

// ── WebRTC / メディア モック（実際のネゴシエーションは行わない）──
function makeFakeTrack(kind) {
  return { kind, enabled: true, stop() { this._stopped = true; } };
}
class FakeMediaStream {
  constructor(tracks = []) { this._tracks = tracks.slice(); }
  getTracks() { return this._tracks.slice(); }
  getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
}
class FakeSender {
  constructor(track) { this.track = track; }
  getParameters() { return { encodings: [{}] }; }
  setParameters() { return Promise.resolve(); }
  replaceTrack(track) { this.track = track; return Promise.resolve(); }
}
class FakeRTCPeerConnection {
  constructor() {
    this._senders = [];
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
  }
  addTrack(track) {
    const sender = new FakeSender(track);
    this._senders.push(sender);
    return sender;
  }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'fake-offer-sdp' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'fake-answer-sdp' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  addIceCandidate() { return Promise.resolve(); }
  getSenders() { return this._senders; }
  getStats() { return Promise.resolve(new Map()); }
  close() { this._closed = true; }
}
class FakeRTCSessionDescription { constructor(init) { Object.assign(this, init || {}); } }
class FakeRTCIceCandidate { constructor(init) { Object.assign(this, init || {}); } }

const navigatorMock = {
  mediaDevices: {
    getUserMedia(constraints) {
      const tracks = [makeFakeTrack('audio')];
      if (constraints && constraints.video) tracks.push(makeFakeTrack('video'));
      return Promise.resolve(new FakeMediaStream(tracks));
    },
    enumerateDevices() { return Promise.resolve([]); },
  },
};

// ── AudioContext モック（発信音・着信音が実際に「鳴らされたか」を生成数で観測する）──
let audioContextCreateCount = 0;
class FakeAudioContext {
  constructor() {
    audioContextCreateCount++;
    this.currentTime = 0;
    this.destination = {};
  }
  createOscillator() {
    return { type: 'sine', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} };
  }
  createGain() {
    return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} };
  }
  close() { return Promise.resolve(); }
}
const windowMock = {
  AudioContext: FakeAudioContext,
  webkitAudioContext: FakeAudioContext,
  speechSynthesis: { cancel() {}, speak() {} },
};

// ── UI モック ──
const toasts = [];
const UI = {
  escapeHTML(s) { return String(s == null ? '' : s); },
  toast(msg, type) { toasts.push({ msg, type }); },
  confirmModal() { return Promise.resolve(true); },
  formatTimeSmart() { return ''; },
  formatDuration() { return ''; },
  _isNotifMuted: () => false,
  _getNotifVolume: () => 0.8,
  _isAutomaticSpeechEnabled: () => true,
};

// ── API モック（呼び出し履歴を配列に記録し、断言に使う）──
const apiCalls = { create: [], patch: [], webrtcSend: [] };
const API = {
  create(table, data) { apiCalls.create.push({ table, data }); return Promise.resolve({ success: true, ...data }); },
  patch(table, id, data) { apiCalls.patch.push({ table, id, data }); return Promise.resolve({ success: true }); },
  webrtcSend(msg) { apiCalls.webrtcSend.push(msg); return Promise.resolve({ success: true }); },
};

// ── AppState モック（ward-接頭辞を持たない病棟IDを1件含める）──
const AppState = {
  wards: [
    { id: 'ward-1', name: '3階病棟', phone: '101' },
    { id: 'east-7f', name: '東7階病棟', phone: '102' },
  ],
  examRooms: [
    { id: 'room-1', name: 'CT検査室', phone: '201' },
  ],
  currentWardId: 'ward-1',
  systemSettings: [],
  activeEvents: [],
  todayEvents: [],
  getExamRoomById(id) { return this.examRooms.find((r) => r.id === id) || null; },
  getBedById() { return null; },
};

const History = { _loadCalls() {} };

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, String, Array, Boolean, Promise, Set, Map, JSON, Object,
  document: documentMock,
  window: windowMock,
  navigator: navigatorMock,
  localStorage: localStorageMock,
  RTCPeerConnection: FakeRTCPeerConnection,
  RTCSessionDescription: FakeRTCSessionDescription,
  RTCIceCandidate: FakeRTCIceCandidate,
  MediaStream: FakeMediaStream,
  UI,
  API,
  AppState,
  History,
};

const CallPanel = vm.runInNewContext(`${source}\nCallPanel;`, sandbox);

// 各シナリオの前後で呼ぶ: 実タイマーIDを使った本物のcleanupCall()で確実に解除しつつ、
// モック側の記録・レジストリも初期化する
async function resetAll() {
  await CallPanel.cleanupCall();
  apiCalls.create.length = 0;
  apiCalls.patch.length = 0;
  apiCalls.webrtcSend.length = 0;
  toasts.length = 0;
  fullscreenListeners.length = 0;
  audioContextCreateCount = 0;
  resetElementRegistry();
}

async function main() {
  // 1) 通話中に別の相手へ発信すると、既存の通話を切断せずUIから見えなくなる不具合の修正確認
  await resetAll();
  CallPanel.isConnected = true;
  await CallPanel.startCall('east-7f', 'ward-1');
  assert.strictEqual(apiCalls.create.length, 0, '通話中に発信しても新規callsレコードが作られないこと');
  assert.ok(toasts.some((t) => t.type === 'warning'), '通話中の発信は警告トーストで止まること(startCall)');

  await resetAll();
  CallPanel.isConnected = true;
  const overlayBeforeOpen = documentMock.getElementById('webrtc-call-overlay');
  overlayBeforeOpen._removed = false;
  CallPanel.showCallSelectionDialog('east-7f', { fromId: 'ward-1' });
  assert.strictEqual(overlayBeforeOpen._removed, false, '通話中は選択ダイアログが構築されず、既存の通話中オーバーレイが消されないこと');
  assert.ok(toasts.some((t) => t.type === 'warning'), '通話中の発信は警告トーストで止まること(showCallSelectionDialog)');

  // 2) 発信側の無応答タイムアウト: 一定時間で自動的に発信を取りやめ、相手にhangupを送る
  await resetAll();
  CallPanel.CALL_RING_TIMEOUT_MS = 40;
  await CallPanel.startCall('east-7f', 'ward-1');
  assert.strictEqual(CallPanel.isCalling, true, '発信直後はisCalling=trueであること');
  await sleep(200);
  assert.strictEqual(CallPanel.isCalling, false, '無応答タイムアウト後はisCallingがfalseに戻ること');
  assert.ok(
    apiCalls.webrtcSend.some((m) => m.type === 'hangup' && m.to === 'east-7f'),
    '無応答タイムアウトで相手にhangupシグナルが送られること'
  );
  CallPanel.CALL_RING_TIMEOUT_MS = 30000;

  // 3) 着信側の無応答タイムアウト: 拒否ボタンを押した場合と同じ扱いになる
  await resetAll();
  CallPanel.CALL_RING_TIMEOUT_MS = 40;
  CallPanel.showIncomingCallDialog('room-1', { type: 'offer', sdp: 'fake' });
  await sleep(200);
  assert.ok(
    apiCalls.webrtcSend.some((m) => m.type === 'busy' && m.to === 'room-1'),
    '着信の無応答タイムアウトでbusyシグナルが送られること'
  );
  assert.ok(
    apiCalls.create.some((c) => c.table === 'calls' && c.data.status === 'missed'),
    '着信の無応答タイムアウトが不応答(missed)としてcallsに記録されること'
  );
  CallPanel.CALL_RING_TIMEOUT_MS = 30000;

  // 4) calls.answered_at の記録（従来は一度も書き込まれず通話時間が常に「--」になっていた）
  await resetAll();
  await CallPanel.acceptCall('room-1', { type: 'offer', sdp: 'fake' });
  const connectedRecord = apiCalls.create.find((c) => c.table === 'calls' && c.data.status === 'connected');
  assert.ok(connectedRecord, '応答時にstatus=connectedのcallsレコードが作られること');
  assert.strictEqual(
    connectedRecord.data.answered_at,
    connectedRecord.data.started_at,
    '着信側は応答した時点がstarted_at/answered_atとも同じ値で記録されること'
  );

  await resetAll();
  CallPanel.currentCallId = 'call-test-1';
  CallPanel.targetId = 'east-7f';
  CallPanel.isCalling = true;
  CallPanel.peerConnection = new FakeRTCPeerConnection();
  CallPanel.setConnectedState();
  await sleep(20);
  const patchedRecord = apiCalls.patch.find((c) => c.table === 'calls' && c.id === 'call-test-1');
  assert.ok(patchedRecord, '発信側は応答受信時(setConnectedState)にanswered_atがpatchされること');
  assert.ok(Number.isFinite(patchedRecord.data.answered_at), 'answered_atが数値であること');

  // 5) ミュートボタン: 通話を切らずに自分のマイクだけを止める/再開できる
  await resetAll();
  CallPanel.isVideoCall = false;
  CallPanel.localStream = new FakeMediaStream([makeFakeTrack('audio')]);
  CallPanel.showConnectedDialog('east-7f');
  const muteBtn = documentMock.getElementById('webrtc-btn-mute');
  assert.strictEqual(typeof muteBtn.onclick, 'function', 'ミュートボタンにクリックハンドラが設定されること');
  const audioTrack = CallPanel.localStream.getAudioTracks()[0];
  assert.strictEqual(audioTrack.enabled, true, '初期状態ではミュートされていないこと');
  muteBtn.onclick();
  assert.strictEqual(audioTrack.enabled, false, 'クリックでミュート(enabled=false)されること');
  assert.ok(muteBtn.classList.contains('btn-danger'), 'ミュート中はbtn-dangerクラスが付くこと');
  muteBtn.onclick();
  assert.strictEqual(audioTrack.enabled, true, '再クリックでミュートが解除されること');

  // 6) fullscreenchangeリスナーが通話ごとに重複登録されず、通話終了時に解除される
  await resetAll();
  CallPanel.isVideoCall = true;
  CallPanel.localStream = new FakeMediaStream([makeFakeTrack('audio'), makeFakeTrack('video')]);
  CallPanel.showConnectedDialog('east-7f');
  assert.strictEqual(fullscreenListeners.length, 1, '1回目の描画でfullscreenchangeリスナーが1つ登録されること');
  CallPanel.showConnectedDialog('east-7f');
  assert.strictEqual(fullscreenListeners.length, 1, '再描画しても重複登録されず1つのままであること');
  await CallPanel.cleanupCall();
  assert.strictEqual(fullscreenListeners.length, 0, '通話終了(cleanupCall)でリスナーが解除されること');

  // 7) 発信音(playRingBackTone)が着信音と同じくミュート・音量設定に従うこと
  await resetAll();
  const originalIsMuted = UI._isNotifMuted;
  UI._isNotifMuted = () => true;
  CallPanel.playRingBackTone();
  assert.strictEqual(audioContextCreateCount, 0, '通知ミュート中は発信音(AudioContext)を生成しないこと');
  UI._isNotifMuted = originalIsMuted;
  CallPanel.stopRingTone();

  await resetAll();
  UI._isNotifMuted = () => false;
  CallPanel.playRingBackTone();
  assert.ok(audioContextCreateCount > 0, 'ミュートされていなければ発信音が鳴ること(AudioContextが生成される)');
  CallPanel.stopRingTone();

  // 8) 病棟IDが'ward-'接頭辞を持たなくても名前解決できること(検査室と誤認しない)
  await resetAll();
  assert.strictEqual(CallPanel.getNameById('east-7f'), '東7階病棟', "'ward-'接頭辞を持たない病棟IDでも病棟名を解決できること");
  assert.strictEqual(CallPanel.getNameById('room-1'), 'CT検査室', '検査室IDの解決は従来通り機能すること');
  assert.strictEqual(CallPanel.getNameById('nonexistent-id'), '不明', '存在しないIDは「不明」を返すこと');

  await resetAll();
  console.log('Call panel checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
