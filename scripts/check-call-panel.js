// js/call.js (WebRTC音声・ビデオ通話) の主要な不具合修正を固定するための回帰テスト。
// device-presence.js と異なりブラウザAPI(DOM/WebRTC/AudioContext等)に依存するため、
// この1ファイル専用の軽量モックをsandboxとして与え、vmコンテキスト上でCallPanelを
// 読み込んで直接メソッドを呼び出す。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'js/call.js'), 'utf8');

// js/ui.js本体をロードし、アナウンス定型文の{n}パース/合成の実装だけを
// 下のUIモックへ拝借する(DOM非依存の純粋関数のため、モックで再実装せず
// 実装コードそのものを使うことで、call.js側の描画テストがロジックの
// ドリフトを検知できるようにする)
const realUiSource = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');
const realUiSandbox = { console };
vm.runInNewContext(`${realUiSource}\nthis.UI = UI;`, realUiSandbox);
const { splitAnnouncementTemplate, fillAnnouncementTemplate } = realUiSandbox.UI;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── DOM モック ──
// getElementById はIDベースの単純なレジストリ参照。実DOMと同様、要素がどのツリー配下に
// 実際に追加されたかは無関係にID一致だけで解決されるため、これで call.js の用法には十分。
//
// querySelector/querySelectorAllは、innerHTMLへ文字列として代入されたHTMLを
// 単純な正規表現で開始タグだけ走査し、単一のクラスセレクタ(".foo")に一致する
// 要素を都度パースして返す(入れ子構造の解決やタグ内容の抽出は行わない、この
// モックの用途に必要な範囲のみの簡易実装)。同一innerHTML文字列に対しては
// パース結果をキャッシュして同一オブジェクト参照を返すため、call.js内部の
// クロージャとテストコードの両方から同じ要素インスタンスを操作できる
// (実DOMのquerySelectorAllが毎回同じノードを返すのと同じ振る舞い)
function parseAttrs(attrStr) {
  const attrs = {};
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(attrStr))) attrs[m[1]] = m[2];
  return attrs;
}

function parseHtmlToStubs(html) {
  const results = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1];
    const attrs = parseAttrs(m[2]);
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    const dataset = {};
    Object.keys(attrs).forEach(k => {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        dataset[camel] = attrs[k];
      }
    });
    results.push({
      tagName: tag.toUpperCase(),
      _classes: classes,
      dataset,
      value: attrs.value || '',
      disabled: attrs.disabled !== undefined,
      _listeners: {},
      addEventListener(type, handler) { (this._listeners[type] = this._listeners[type] || []).push(handler); },
      removeEventListener() {},
    });
  }
  return results;
}

function matchesClassSelector(elStub, selector) {
  if (!selector.startsWith('.')) return false;
  return elStub._classes.has(selector.slice(1));
}

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
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    _parsedCacheHtml: undefined,
    _parsedCache: null,
    _getParsedChildren() {
      if (this._parsedCacheHtml !== this.innerHTML) {
        this._parsedCache = parseHtmlToStubs(this.innerHTML);
        this._parsedCacheHtml = this.innerHTML;
      }
      return this._parsedCache;
    },
    querySelector(selector) {
      return this._getParsedChildren().find(el => matchesClassSelector(el, selector)) || null;
    },
    querySelectorAll(selector) {
      return this._getParsedChildren().filter(el => matchesClassSelector(el, selector));
    },
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
  'webrtc-media-warning', 'webrtc-mic-select', 'webrtc-net-stats', 'webrtc-quality-indicator',
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

// call.jsはHTML Fullscreen APIを使わず、Electronの'set-fullscreen' IPC経由で
// ウィンドウ全体のフルスクリーンを管理する。documentへ登録するのは
// Escapeキー解除用のkeydownリスナーのみ
const keydownListeners = [];

// document.createElement()で作られた要素は、call.js内部のローカル変数
// (例: showCallSelectionDialogのoverlay)としてのみ保持され、elementRegistry
// には登録されない。テスト側からその実体(と実際にセットされたinnerHTML)へ
// アクセスできるよう、生成された要素をすべて記録しておく
const createdElements = [];

const documentMock = {
  getElementById(id) { return elementRegistry.get(id) || null; },
  createElement(tag) { const el = createElementStub(tag); createdElements.push(el); return el; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { appendChild(el) { return el; } },
  addEventListener(type, handler) {
    if (type === 'keydown') keydownListeners.push(handler);
  },
  removeEventListener(type, handler) {
    if (type === 'keydown') {
      const idx = keydownListeners.indexOf(handler);
      if (idx !== -1) keydownListeners.splice(idx, 1);
    }
  },
};

// ── localStorage モック（_videoQualityPresetの初期化がロード時に参照する）──
const localStorageStore = new Map();
const localStorageMock = {
  getItem(key) { return localStorageStore.has(key) ? localStorageStore.get(key) : null; },
  setItem(key, val) { localStorageStore.set(key, String(val)); },
};

// ── WebRTC / メディア モック（実際のネゴシエーションは行わない）──
function makeFakeTrack(kind, opts) {
  const track = { kind, enabled: true, stop() { this._stopped = true; } };
  if (opts && opts.applyConstraints) {
    track.applyConstraints = opts.applyConstraints;
  }
  return track;
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
    this.remoteDescription = null;
    this.addedCandidates = [];
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
  setRemoteDescription(desc) { this.remoteDescription = desc; return Promise.resolve(); }
  addIceCandidate(candidate) { this.addedCandidates.push(candidate); return Promise.resolve(); }
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
// ── electronAPI モック（IPC経由のフルスクリーン管理: set-fullscreen/is-fullscreen/fullscreen-changed）──
let fullscreenState = false;
const fullscreenChangedListeners = [];
function emitFullscreenChanged(value) {
  fullscreenState = !!value;
  fullscreenChangedListeners.slice().forEach((cb) => cb(fullscreenState));
}
const electronAPIMock = {
  setFullscreen(value) {
    fullscreenState = !!value;
    return Promise.resolve(fullscreenState);
  },
  isFullscreen() { return Promise.resolve(fullscreenState); },
  onFullscreenChanged(callback) {
    fullscreenChangedListeners.push(callback);
    return () => {
      const idx = fullscreenChangedListeners.indexOf(callback);
      if (idx !== -1) fullscreenChangedListeners.splice(idx, 1);
    };
  },
};

const windowMock = {
  AudioContext: FakeAudioContext,
  webkitAudioContext: FakeAudioContext,
  speechSynthesis: { cancel() {}, speak() {} },
  electronAPI: electronAPIMock,
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
  splitAnnouncementTemplate,
  fillAnnouncementTemplate,
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
  keydownListeners.length = 0;
  fullscreenChangedListeners.length = 0;
  fullscreenState = false;
  audioContextCreateCount = 0;
  resetElementRegistry();
  createdElements.length = 0;
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

  // 6) 全画面表示: HTML Fullscreen APIではなくIPC(electronAPI.setFullscreen)を
  // 使うこと。購読・リスナーは通話ごとに重複登録されず、Escapeキー・通話終了で
  // 同期して解除されること
  await resetAll();
  CallPanel.isVideoCall = true;
  CallPanel.localStream = new FakeMediaStream([makeFakeTrack('audio'), makeFakeTrack('video')]);
  CallPanel.showConnectedDialog('east-7f');
  assert.strictEqual(fullscreenChangedListeners.length, 1, '1回目の描画でonFullscreenChangedの購読が1つ登録されること');
  assert.strictEqual(keydownListeners.length, 1, '1回目の描画でEscapeキー用のkeydownリスナーが1つ登録されること');
  CallPanel.showConnectedDialog('east-7f');
  assert.strictEqual(fullscreenChangedListeners.length, 1, '再描画しても購読が重複登録されず1つのままであること');
  assert.strictEqual(keydownListeners.length, 1, '再描画してもkeydownリスナーが重複登録されず1つのままであること');

  const fsBtn = documentMock.getElementById('webrtc-btn-fullscreen');
  assert.strictEqual(typeof fsBtn.onclick, 'function', '全画面ボタンにクリックハンドラが設定されること');
  fsBtn.onclick({ preventDefault() {} });
  await sleep(10);
  assert.strictEqual(fullscreenState, true, '全画面ボタンのクリックでIPC(setFullscreen)経由で全画面になること');
  assert.ok(fsBtn.innerHTML.includes('fa-compress'), '全画面中はボタンアイコンがfa-compressになること');

  // Escapeキーで全画面表示を解除する
  keydownListeners[0]({ key: 'Escape' });
  await sleep(10);
  assert.strictEqual(fullscreenState, false, 'Escapeキーで全画面がIPC経由で解除されること');
  assert.ok(fsBtn.innerHTML.includes('fa-expand'), '解除後はボタンアイコンがfa-expandに戻ること');

  // 通話中に再度全画面へ → 通話終了時、通話が原因の全画面表示は自動解除される
  fsBtn.onclick({ preventDefault() {} });
  await sleep(10);
  assert.strictEqual(fullscreenState, true, '全画面に戻せること');
  await CallPanel.cleanupCall();
  await sleep(10);
  assert.strictEqual(fullscreenState, false, '通話終了(cleanupCall)時、通話が原因の全画面表示は自動解除されること');
  assert.strictEqual(fullscreenChangedListeners.length, 0, '通話終了で購読が解除されること');
  assert.strictEqual(keydownListeners.length, 0, '通話終了でEscapeキーのリスナーが解除されること');

  // Electron側からの状態通知(F11キー等、全画面ボタン以外での変化)にもボタン表示を同期する
  await resetAll();
  CallPanel.isVideoCall = true;
  CallPanel.localStream = new FakeMediaStream([makeFakeTrack('audio'), makeFakeTrack('video')]);
  CallPanel.showConnectedDialog('east-7f');
  const fsBtn2 = documentMock.getElementById('webrtc-btn-fullscreen');
  emitFullscreenChanged(true);
  assert.ok(fsBtn2.innerHTML.includes('fa-compress'), 'Electron側からの通知でボタン表示が全画面中に更新されること');
  emitFullscreenChanged(false);
  assert.ok(fsBtn2.innerHTML.includes('fa-expand'), 'Electron側からの通知でボタン表示が解除後に更新されること');

  // 6b) デバイス列挙結果に応じて音声・ビデオ通話ボタンを個別に無効化すること。
  // 列挙自体の失敗では一律禁止しない、API自体が無い環境でも例外を投げない、
  // ことも合わせて確認する
  const realEnumerateDevices = navigatorMock.mediaDevices.enumerateDevices;
  const realMediaDevices = navigatorMock.mediaDevices;

  // マイク・カメラともに有る → どちらも有効なまま
  await resetAll();
  navigatorMock.mediaDevices.enumerateDevices = () =>
    Promise.resolve([{ kind: 'audioinput' }, { kind: 'videoinput' }]);
  CallPanel.showCallSelectionDialog('east-7f', { fromId: 'ward-1' });
  await sleep(10);
  assert.strictEqual(documentMock.getElementById('webrtc-btn-start-voice').disabled, false, 'マイク・カメラ両方あれば音声通話ボタンは有効なままであること');
  assert.strictEqual(documentMock.getElementById('webrtc-btn-start-video').disabled, false, 'マイク・カメラ両方あればビデオ通話ボタンは有効なままであること');
  assert.strictEqual(documentMock.getElementById('webrtc-media-warning').style.display, undefined, '問題が無ければ警告は表示されないこと');

  // マイクが無い → 音声・ビデオ両方を無効化
  await resetAll();
  navigatorMock.mediaDevices.enumerateDevices = () =>
    Promise.resolve([{ kind: 'videoinput' }]);
  CallPanel.showCallSelectionDialog('east-7f', { fromId: 'ward-1' });
  await sleep(10);
  assert.strictEqual(documentMock.getElementById('webrtc-btn-start-voice').disabled, true, 'BUG FIX: マイクが無ければ音声通話ボタンを無効化すること');
  assert.strictEqual(documentMock.getElementById('webrtc-btn-start-video').disabled, true, 'BUG FIX: マイクが無ければビデオ通話ボタンも無効化すること');
  assert.ok(documentMock.getElementById('webrtc-media-warning').textContent.includes('マイク'), '警告文にマイクが無い旨が含まれること');

  // マイクは有るがカメラが無い → ビデオ通話だけを無効化
  await resetAll();
  navigatorMock.mediaDevices.enumerateDevices = () =>
    Promise.resolve([{ kind: 'audioinput' }]);
  CallPanel.showCallSelectionDialog('east-7f', { fromId: 'ward-1' });
  await sleep(10);
  assert.strictEqual(documentMock.getElementById('webrtc-btn-start-voice').disabled, false, 'BUG FIX: マイクがあれば音声通話ボタンは有効のままであること');
  assert.strictEqual(documentMock.getElementById('webrtc-btn-start-video').disabled, true, 'BUG FIX: カメラが無ければビデオ通話ボタンを無効化すること');
  assert.ok(documentMock.getElementById('webrtc-media-warning').textContent.includes('カメラ'), '警告文にカメラが無い旨が含まれること');

  // enumerateDevices()自体が失敗(権限プロンプト未許可等) → 一律禁止せず両方とも有効のまま
  await resetAll();
  navigatorMock.mediaDevices.enumerateDevices = () => Promise.reject(new Error('Permission denied'));
  CallPanel.showCallSelectionDialog('east-7f', { fromId: 'ward-1' });
  await sleep(10);
  assert.strictEqual(documentMock.getElementById('webrtc-btn-start-voice').disabled, false, 'BUG FIX: デバイス列挙の失敗だけでは音声通話ボタンを無効化しないこと(発信時のgetUserMedia()に委ねる)');
  assert.strictEqual(documentMock.getElementById('webrtc-btn-start-video').disabled, false, 'BUG FIX: デバイス列挙の失敗だけではビデオ通話ボタンも無効化しないこと');

  // navigator.mediaDevices自体が存在しない環境 → 例外を投げず両方とも無効化して警告
  await resetAll();
  navigatorMock.mediaDevices = undefined;
  assert.doesNotThrow(() => {
    CallPanel.showCallSelectionDialog('east-7f', { fromId: 'ward-1' });
  }, 'BUG FIX: navigator.mediaDevices自体が無い環境でも例外を投げず安全に描画できること');
  await sleep(10);
  assert.strictEqual(documentMock.getElementById('webrtc-btn-start-voice').disabled, true, 'BUG FIX: mediaDevices API自体が無ければ音声通話ボタンを無効化すること');
  assert.strictEqual(documentMock.getElementById('webrtc-btn-start-video').disabled, true, 'BUG FIX: mediaDevices API自体が無ければビデオ通話ボタンも無効化すること');
  navigatorMock.mediaDevices = realMediaDevices;
  navigatorMock.mediaDevices.enumerateDevices = realEnumerateDevices;

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

  // 9) 着信呼び出し中(応答前でpeerConnection未作成)に届いたICE候補が保留され、
  //    応答後のsetRemoteDescription直後にまとめて適用されること
  await resetAll();
  await CallPanel.handleSignalingMessage({ type: 'offer', from: 'room-1', sdp: { type: 'offer', sdp: 'fake-offer' } });
  assert.strictEqual(CallPanel.targetId, 'room-1', 'offer受信でtargetIdが発信元に設定されること');
  assert.strictEqual(CallPanel._isRinging, true, 'offer受信で呼び出し中フラグが立つこと');
  assert.strictEqual(CallPanel.peerConnection, null, '応答前はpeerConnectionが未作成であること');

  await CallPanel.handleSignalingMessage({ type: 'ice', from: 'room-1', candidate: { candidate: 'cand-1' } });
  await CallPanel.handleSignalingMessage({ type: 'ice', from: 'room-1', candidate: { candidate: 'cand-2' } });
  assert.strictEqual(CallPanel._pendingIceCandidates.length, 2, '呼び出し中に届いたICE候補が捨てられず保留キューに積まれること');

  await CallPanel.acceptCall('room-1', { type: 'offer', sdp: 'fake-offer' });
  assert.strictEqual(CallPanel._pendingIceCandidates.length, 0, '応答後は保留キューが空になること');
  assert.strictEqual(CallPanel.peerConnection.addedCandidates.length, 2, '保留していたICE候補が応答直後にすべて適用されること');

  // 10) 発信側でも、answer受信(setRemoteDescription)より前に届いたICE候補が保留され、
  //     answer受信直後にフラッシュされること
  await resetAll();
  await CallPanel.startCall('east-7f', 'ward-1');
  assert.strictEqual(CallPanel.peerConnection.remoteDescription, null, 'answer受信前はremoteDescriptionが未設定であること');

  await CallPanel.handleSignalingMessage({ type: 'ice', from: 'east-7f', candidate: { candidate: 'cand-a' } });
  assert.strictEqual(CallPanel._pendingIceCandidates.length, 1, 'remoteDescription未設定の間に届いたICE候補は保留されること');
  assert.strictEqual(CallPanel.peerConnection.addedCandidates.length, 0, 'remoteDescription未設定の間はaddIceCandidateが呼ばれないこと');

  await CallPanel.handleSignalingMessage({ type: 'answer', from: 'east-7f', sdp: { type: 'answer', sdp: 'fake-answer' } });
  assert.strictEqual(CallPanel.isConnected, true, 'answer受信で接続状態になること');
  assert.strictEqual(CallPanel._pendingIceCandidates.length, 0, 'answer受信後は保留キューが空になること');
  assert.strictEqual(CallPanel.peerConnection.addedCandidates.length, 1, '保留していたICE候補がanswer受信直後に適用されること');

  // 11) 現在の通話相手以外から届いたICE候補は保留キューに積まれないこと
  await resetAll();
  await CallPanel.startCall('east-7f', 'ward-1');
  await CallPanel.handleSignalingMessage({ type: 'ice', from: 'someone-else', candidate: { candidate: 'cand-x' } });
  assert.strictEqual(CallPanel._pendingIceCandidates.length, 0, '現在の通話相手以外からのICE候補は保留されないこと');

  // 12) 保留キューが上限を超えたら古いものから捨てられること
  await resetAll();
  await CallPanel.handleSignalingMessage({ type: 'offer', from: 'room-1', sdp: { type: 'offer', sdp: 'fake' } });
  CallPanel.MAX_PENDING_ICE_CANDIDATES = 3;
  for (let i = 0; i < 5; i++) {
    await CallPanel.handleSignalingMessage({ type: 'ice', from: 'room-1', candidate: { candidate: `cand-${i}` } });
  }
  assert.strictEqual(CallPanel._pendingIceCandidates.length, 3, '保留キューは上限を超えないこと');
  assert.strictEqual(CallPanel._pendingIceCandidates[0].candidate, 'cand-2', '上限超過時は古いものから捨てられること');
  CallPanel.MAX_PENDING_ICE_CANDIDATES = 50;

  // 13) cleanupCall後は保留キューが空になること(通話をまたいで残さない)
  await resetAll();
  await CallPanel.handleSignalingMessage({ type: 'offer', from: 'room-1', sdp: { type: 'offer', sdp: 'fake' } });
  await CallPanel.handleSignalingMessage({ type: 'ice', from: 'room-1', candidate: { candidate: 'cand-1' } });
  assert.strictEqual(CallPanel._pendingIceCandidates.length, 1);
  await CallPanel.cleanupCall();
  assert.strictEqual(CallPanel._pendingIceCandidates.length, 0, 'cleanupCall後は保留キューが空であること');

  // 14) cleanupCallは状態フラグをDB書き込み(API.patch)の完了を待たずにクリアすること。
  //     従来はawaitの後でフラグを倒していたため、子機で親機が不達だと最大8秒間
  //     isCalling/isConnectedが真のままになり、新規の発信も着信もできなくなっていた
  await resetAll();
  CallPanel.currentCallId = 'call-flag-order-test';
  CallPanel.isCalling = true;
  CallPanel.isConnected = true;
  CallPanel.targetId = 'east-7f';
  let patchResolved = false;
  const originalPatch = API.patch;
  API.patch = (table, id, data) => {
    apiCalls.patch.push({ table, id, data });
    return new Promise((resolve) => {
      setTimeout(() => { patchResolved = true; resolve({ success: true }); }, 30);
    });
  };
  const cleanupPromise = CallPanel.cleanupCall('test');
  assert.strictEqual(CallPanel.isCalling, false, 'DB書き込みの完了を待たずisCallingがfalseになること');
  assert.strictEqual(CallPanel.isConnected, false, 'DB書き込みの完了を待たずisConnectedがfalseになること');
  assert.strictEqual(patchResolved, false, '検証時点ではまだAPI.patchが未解決であること(この前提が崩れるとテストの意味がない)');
  await cleanupPromise;
  API.patch = originalPatch;

  // 15) 呼び出し中(応答前)に2件目のofferが来たらbusyを返し、1件目の着信状態が維持されること
  await resetAll();
  await CallPanel.handleSignalingMessage({ type: 'offer', from: 'room-1', sdp: { type: 'offer', sdp: 'fake-1' } });
  const firstRingTimeoutId = CallPanel._incomingRingTimeoutId;
  assert.ok(firstRingTimeoutId, '1件目の着信で無応答タイマーが設定されること');

  await CallPanel.handleSignalingMessage({ type: 'offer', from: 'other-room', sdp: { type: 'offer', sdp: 'fake-2' } });
  assert.ok(
    apiCalls.webrtcSend.some((m) => m.type === 'busy' && m.to === 'other-room'),
    '呼び出し中(応答前)に届いた2件目のofferにはbusyを返すこと'
  );
  assert.strictEqual(CallPanel.targetId, 'room-1', '1件目の発信者情報が2件目のofferで上書きされないこと');
  assert.strictEqual(CallPanel._incomingRingTimeoutId, firstRingTimeoutId, '1件目の無応答タイマーが2件目のofferで差し替えられないこと');

  // 16) answered受信で無応答タイマーと呼び出し中フラグが解除され、後からタイマーが
  //     発火してもbusyを送らないこと(同一IDの別端末が応答した後、確立済みの通話を
  //     誤って切ってしまうバグの受け入れテスト)
  await resetAll();
  CallPanel.CALL_RING_TIMEOUT_MS = 40;
  await CallPanel.handleSignalingMessage({ type: 'offer', from: 'room-1', sdp: { type: 'offer', sdp: 'fake' } });
  await CallPanel.handleSignalingMessage({ type: 'answered', from: CallPanel.getMyId() });
  assert.strictEqual(CallPanel._incomingRingTimeoutId, null, 'answered受信で無応答タイマーが解除されること');
  assert.strictEqual(CallPanel._isRinging, false, 'answered受信で呼び出し中フラグが解除されること');
  apiCalls.webrtcSend.length = 0;
  await sleep(200);
  assert.ok(
    !apiCalls.webrtcSend.some((m) => m.type === 'busy'),
    '解除済みの無応答タイマーは発火せず、他端末が応答した通話にbusyを送らないこと'
  );
  CallPanel.CALL_RING_TIMEOUT_MS = 30000;

  // 17) 現在の通話相手以外からのhangup/busyは無視され、正しい相手からのものは従来通り切れること
  await resetAll();
  await CallPanel.startCall('east-7f', 'ward-1');
  await CallPanel.handleSignalingMessage({ type: 'hangup', from: 'someone-else' });
  assert.strictEqual(CallPanel.isCalling, true, '無関係な相手からのhangupでは通話状態が変わらないこと');
  await CallPanel.handleSignalingMessage({ type: 'busy', from: 'someone-else' });
  assert.strictEqual(CallPanel.isCalling, true, '無関係な相手からのbusyでも通話状態が変わらないこと');
  await CallPanel.handleSignalingMessage({ type: 'hangup', from: 'east-7f' });
  assert.strictEqual(CallPanel.isCalling, false, '正しい相手からのhangupでは従来通り通話が終了すること');

  // 18) 通話の文脈(targetId)が全く無いときのhangup/busyはcleanupCallすら呼ばないこと
  await resetAll();
  let cleanupCallCount = 0;
  const originalCleanup = CallPanel.cleanupCall;
  CallPanel.cleanupCall = async (...args) => { cleanupCallCount++; return originalCleanup.apply(CallPanel, args); };
  await CallPanel.handleSignalingMessage({ type: 'hangup', from: 'east-7f' });
  await CallPanel.handleSignalingMessage({ type: 'busy', from: 'east-7f' });
  assert.strictEqual(cleanupCallCount, 0, '通話の文脈が無いときのhangup/busyはcleanupCallを呼ばないこと');
  CallPanel.cleanupCall = originalCleanup;

  // 19) シグナリングpoll用のclient識別子(getClientId)は、他端末が
  //     GET /api/device/list 経由で閲覧できる_device_idを流用しないこと。
  //     同一値を再利用してackを横取りされる攻撃を防ぐための識別子なので、
  //     _device_idとは別の秘匿値として生成され、以後は安定して返ること
  await resetAll();
  localStorageStore.delete('_device_id');
  localStorageStore.delete('_signaling_client_id');
  localStorageStore.set('_device_id', 'device-abc-123');
  const clientId = CallPanel.getClientId();
  assert.ok(clientId, 'getClientId()は値を返すこと');
  assert.notStrictEqual(clientId, 'device-abc-123', 'BUG FIX: getClientId()は他端末から閲覧可能な_device_idをそのまま流用しないこと');
  assert.strictEqual(localStorageStore.get('_signaling_client_id'), clientId, '生成したclient idは_device_idとは別のキー(_signaling_client_id)で永続化されること');
  const clientId2 = CallPanel.getClientId();
  assert.strictEqual(clientId2, clientId, '2回目以降の呼び出しでも同じclient idが安定して返ること');

  // 20) 画質変更(lowerVideoQuality): 実際の切り替えが成功した場合のみプリセットを
  //     確定し、失敗時は元の設定のまま・カメラを保持し続けないこと
  function setupVideoCall(videoTrackOpts) {
    const audioTrack = makeFakeTrack('audio');
    const videoTrack = makeFakeTrack('video', videoTrackOpts);
    CallPanel.localStream = new FakeMediaStream([audioTrack, videoTrack]);
    CallPanel.peerConnection = new FakeRTCPeerConnection();
    const sender = CallPanel.peerConnection.addTrack(videoTrack);
    return { audioTrack, videoTrack, sender };
  }
  const originalGetUserMedia = navigatorMock.mediaDevices.getUserMedia;

  // 20a) 既存トラックのapplyConstraints()が成功すれば、getUserMedia()での
  //      カメラ再取得は行わずプリセットを更新すること
  await resetAll();
  CallPanel._videoQualityPreset = 'high';
  let applyConstraintsCalls = 0;
  setupVideoCall({ applyConstraints: () => { applyConstraintsCalls++; return Promise.resolve(); } });
  let getUserMediaCalled = false;
  navigatorMock.mediaDevices.getUserMedia = (c) => { getUserMediaCalled = true; return originalGetUserMedia(c); };
  await CallPanel.lowerVideoQuality();
  assert.strictEqual(applyConstraintsCalls, 1, 'BUG FIX: まず既存トラックのapplyConstraints()が試みられること');
  assert.strictEqual(getUserMediaCalled, false, 'applyConstraints()が成功すればgetUserMedia()での再取得は行われないこと');
  assert.strictEqual(CallPanel._videoQualityPreset, 'medium', 'applyConstraints成功でプリセットが更新されること');
  assert.ok(toasts.some((t) => t.type === 'info' && t.msg.includes('標準')), '成功時は成功トーストが表示されること');
  navigatorMock.mediaDevices.getUserMedia = originalGetUserMedia;

  // 20b) applyConstraints()が失敗した場合はgetUserMedia()再取得にフォールバックし、
  //      replaceTrack()成功後にのみプリセットが更新され、古いトラックは停止されること
  await resetAll();
  CallPanel._videoQualityPreset = 'high';
  const { videoTrack: oldTrackB, sender: senderB } = setupVideoCall({
    applyConstraints: () => Promise.reject(new Error('not supported')),
  });
  await CallPanel.lowerVideoQuality();
  assert.strictEqual(CallPanel._videoQualityPreset, 'medium', 'applyConstraints失敗時はgetUserMedia再取得にフォールバックしプリセットが更新されること');
  assert.strictEqual(senderB.track.kind, 'video', 'replaceTrack()で新トラックに置き換わること');
  assert.notStrictEqual(senderB.track, oldTrackB, '差し替え後のsender.trackは新しく取得したトラックであること');
  assert.strictEqual(oldTrackB._stopped, true, '古い映像トラックが停止されること');
  assert.notStrictEqual(CallPanel.localStream.getVideoTracks()[0], oldTrackB, 'localStreamが新しいトラックに差し替わること');
  assert.ok(toasts.some((t) => t.type === 'info'), '成功トーストが表示されること');

  // 20c) BUG FIX: getUserMedia()自体が失敗した場合、プリセット・localStorageは
  //      元のまま(成功を騙らない)で、警告トーストのみ表示されること
  await resetAll();
  CallPanel._videoQualityPreset = 'high';
  setupVideoCall({ applyConstraints: () => Promise.reject(new Error('not supported')) });
  const storedQualityBefore = localStorageStore.get('tbs_video_quality');
  navigatorMock.mediaDevices.getUserMedia = () => Promise.reject(new Error('camera busy'));
  await CallPanel.lowerVideoQuality();
  assert.strictEqual(CallPanel._videoQualityPreset, 'high', 'BUG FIX: 再取得に失敗した場合プリセットは元のままであること');
  assert.strictEqual(localStorageStore.get('tbs_video_quality'), storedQualityBefore, 'BUG FIX: 再取得に失敗した場合localStorageも書き換えられないこと');
  assert.ok(toasts.some((t) => t.type === 'warning' && t.msg.includes('失敗')), 'BUG FIX: 失敗時は警告トーストが表示されること');
  assert.ok(!toasts.some((t) => t.type === 'info'), 'BUG FIX: 失敗時に成功を騙るトーストが出ないこと');
  navigatorMock.mediaDevices.getUserMedia = originalGetUserMedia;

  // 20d) BUG FIX: 新しい映像トラックを取得できても対応するsenderが見つからない
  //      場合は失敗として扱い、新規取得トラックを停止する(カメラを保持し続けない)こと
  await resetAll();
  CallPanel._videoQualityPreset = 'high';
  CallPanel.localStream = new FakeMediaStream([makeFakeTrack('audio'), makeFakeTrack('video')]);
  CallPanel.peerConnection = new FakeRTCPeerConnection(); // 映像senderを追加しない
  let capturedNewTrack = null;
  navigatorMock.mediaDevices.getUserMedia = (c) => originalGetUserMedia(c).then((stream) => {
    capturedNewTrack = stream.getVideoTracks()[0];
    return stream;
  });
  await CallPanel.lowerVideoQuality();
  assert.ok(capturedNewTrack, 'このシナリオではgetUserMediaで新トラックが取得されること(前提の確認)');
  assert.strictEqual(capturedNewTrack._stopped, true, 'BUG FIX: senderが見つからない場合、新規取得トラックが停止されカメラを保持し続けないこと');
  assert.strictEqual(CallPanel._videoQualityPreset, 'high', 'senderが見つからない場合プリセットは変更されないこと');
  assert.ok(toasts.some((t) => t.type === 'warning'), 'senderが見つからない場合も警告トーストが表示されること');
  navigatorMock.mediaDevices.getUserMedia = originalGetUserMedia;

  // 20e) 既に最低画質の場合は何もせず案内するだけであること
  await resetAll();
  CallPanel._videoQualityPreset = 'low';
  await CallPanel.lowerVideoQuality();
  assert.ok(toasts.some((t) => t.type === 'info' && t.msg.includes('すでに最低画質')), '既に最低画質のときはその旨を通知して終了すること');
  assert.strictEqual(CallPanel._videoQualityPreset, 'low', '既に最低画質のときプリセットは変わらないこと');

  // 20f) 通話中でない(peerConnection/localStreamが無い)場合は設定のみ更新すること
  await resetAll();
  CallPanel._videoQualityPreset = 'high';
  CallPanel.peerConnection = null;
  CallPanel.localStream = null;
  await CallPanel.lowerVideoQuality();
  assert.strictEqual(CallPanel._videoQualityPreset, 'medium', '通話中でなくても設定のみ更新されること');
  assert.strictEqual(localStorageStore.get('tbs_video_quality'), 'medium', 'localStorageにも保存されること');

  // 21) アナウンス定型文中の{n}トークンは、常時表示の数字入力欄として描画され、
  //     未入力のまま送信できないこと。{n}を含まない定型文は従来通りクリック
  //     即送信のボタンのままであること
  await resetAll();
  AppState.systemSettings = [
    { id: 'speech_templates', value: JSON.stringify(['患者が到着しました。', '検査室{n}番からお迎えください。']) },
  ];
  CallPanel.showCallSelectionDialog('east-7f', { fromId: 'ward-1' });
  let overlay = createdElements.find((el) => el.id === 'webrtc-call-overlay');
  assert.ok(overlay, 'showCallSelectionDialogがwebrtc-call-overlayというidの要素を作成すること(前提の確認)');
  assert.strictEqual(overlay.querySelectorAll('.btn-send-announcement').length, 1, '{n}を含まない定型文は引き続きクリック即送信のボタンとして1つ描画されること');
  assert.strictEqual(overlay.querySelectorAll('.btn-send-blank-template').length, 1, '{n}を含む定型文は送信ボタン付きの複合行として1つ描画されること');
  const blankInputs1 = overlay.querySelectorAll('.template-blank-input');
  assert.strictEqual(blankInputs1.length, 1, '{n}が1箇所の定型文には数字入力欄が1つ描画されること(常時表示、クリックで展開する方式ではないこと)');
  assert.strictEqual(blankInputs1[0].dataset.templateIdx, '1', '数字入力欄には対応する定型文のインデックスがdata属性で付与されること');
  assert.ok(overlay.innerHTML.includes('検査室') && overlay.innerHTML.includes('番からお迎えください。'), '{n}の前後のテキストがそのまま描画されること');

  // 未入力のまま送信ボタンを押しても送信されず、警告が出ること
  const sendBtn1 = overlay.querySelectorAll('.btn-send-blank-template')[0];
  sendBtn1._listeners.click[0]();
  assert.strictEqual(apiCalls.webrtcSend.length, 0, 'BUG FIX: 数字が未入力のまま送信ボタンを押してもAPI.webrtcSendが呼ばれないこと(空欄のままアナウンスが流れないこと)');
  assert.ok(toasts.some((t) => t.type === 'warning' && t.msg.includes('数字をすべて入力')), 'BUG FIX: 未入力のまま送信しようとすると警告トーストが表示されること');

  // 数字を入力してから送信すると、{n}が入力値に置き換わった文字列で送信されること
  blankInputs1[0].value = '7';
  sendBtn1._listeners.click[0]();
  assert.strictEqual(apiCalls.webrtcSend.length, 1, '数字を入力していれば送信できること');
  assert.strictEqual(apiCalls.webrtcSend[0].text, '検査室7番からお迎えください。', '{n}が入力した数字に置き換わった状態で送信されること');
  assert.strictEqual(apiCalls.webrtcSend[0].type, 'speech', '通常のアナウンスと同じtype:speechで送信されること');

  // 22) 1つの定型文に{n}が複数ある場合、その数だけ入力欄が並び、出現順に
  //     埋め込まれること。Enterキーでも送信できること(自由入力欄と同じ操作性)
  await resetAll();
  AppState.systemSettings = [
    { id: 'speech_templates', value: JSON.stringify(['{n}階{n}号室の患者様、お待ちしております。']) },
  ];
  CallPanel.showCallSelectionDialog('east-7f', { fromId: 'ward-1' });
  overlay = createdElements.find((el) => el.id === 'webrtc-call-overlay');
  const blankInputs2 = overlay.querySelectorAll('.template-blank-input');
  assert.strictEqual(blankInputs2.length, 2, '1つの定型文に{n}が2つあれば、数字入力欄も2つ描画されること(複数箇所を許容)');
  blankInputs2[0].value = '3';
  blankInputs2[1].value = '12';
  // Enterキーはどちらの入力欄からでも同じ送信処理を起動できること
  blankInputs2[1]._listeners.keydown[0]({ key: 'Enter', isComposing: false });
  assert.strictEqual(apiCalls.webrtcSend.length, 1, 'Enterキーでも送信できること');
  assert.strictEqual(apiCalls.webrtcSend[0].text, '3階12号室の患者様、お待ちしております。', '複数の{n}が出現順(左から右)に、それぞれの入力欄の値で埋め込まれること');

  // IME変換確定のEnter(isComposing:true)では誤送信しないこと(自由入力欄の
  // 既存の挙動と同じガード)
  await resetAll();
  AppState.systemSettings = [
    { id: 'speech_templates', value: JSON.stringify(['検査室{n}番からお迎えください。']) },
  ];
  CallPanel.showCallSelectionDialog('east-7f', { fromId: 'ward-1' });
  overlay = createdElements.find((el) => el.id === 'webrtc-call-overlay');
  const blankInputs3 = overlay.querySelectorAll('.template-blank-input');
  blankInputs3[0].value = '5';
  blankInputs3[0]._listeners.keydown[0]({ key: 'Enter', isComposing: true });
  assert.strictEqual(apiCalls.webrtcSend.length, 0, 'IME変換確定のEnter(isComposing:true)では送信されないこと');

  await resetAll();
  console.log('Call panel checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
