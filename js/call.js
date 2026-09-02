/**
 * TransBoard - 電話番号表示 & WebRTC音声通話 & 音声合成アナウンスパネル
 */

const CallPanel = {

  currentCallId: null,
  _callTimerInterval: null,
  _callStartTime: null,

  // WebRTC 関連メンバ
  peerConnection: null,
  localStream: null,
  remoteAudio: null,
  pollTimer: null,
  targetId: null,
  isCalling: false,
  isConnected: false,
  isVideoCall: false,
  callTimer: null,
  callDuration: 0,
  
  // アナウンス（音声通知）キュー
  announcementQueue: [],
  isSpeakingAnnouncement: false,

  // 端末間チャット。履歴は chat_messages テーブル(DB)が唯一の真実で、
  // ここはあくまで表示中の会話のキャッシュ。_chatPeerId が非nullの間は
  // 通話パネルが「会話状態」になる(nullなら発信先の一覧状態)
  _chatPeerId: null,
  _chatMessages: [],
  _chatPollTimer: null,
  _chatSending: false,
  CHAT_POLL_INTERVAL_MS: 5000,
  CHAT_MAX_LENGTH: 500,

  // 受信済みメッセージIDの管理（重複処理防止）
  _seenMsgIds: new Set(),
  _pollInFlight: false,
  _pollFailures: 0,
  _nextPollAt: 0,

  // 再接続タイマー
  reconnectTimeout: null,

  // 無応答タイムアウト（発信側・着信側）
  _ringTimeoutId: null,
  _incomingRingTimeoutId: null,
  CALL_RING_TIMEOUT_MS: 30000,

  // 着信呼び出し中フラグ。話し中判定(peerConnection/isCalling/isConnected)は
  // 着信呼び出し中(応答前でpeerConnection未作成)を捕捉できないため別途持つ
  _isRinging: false,

  // setRemoteDescription前に届いたICE候補の保留キュー。着信側は応答するまで
  // peerConnection自体が存在せず、発信側のhost候補はミリ秒単位で収集・送信
  // されるため、応答を待つ間に届いた候補を保持してsetRemoteDescription直後に
  // 適用する（保持しないとICE候補がほぼ全て失われ、接続できないことがある）
  _pendingIceCandidates: [],
  MAX_PENDING_ICE_CANDIDATES: 50,

  // ビデオ品質・統計・デバイス選択
  _videoQualityPreset: localStorage.getItem('tbs_video_quality') || 'medium',
  _statsInterval: null,
  _prevStats: null,
  _selectedAudioInput: null,
  _selectedVideoInput: null,
  _callSourceId: null,

  // ビデオ通話の全画面表示状態(Electronのウィンドウ全体のフルスクリーンを
  // IPC経由で管理する。HTML Fullscreen APIは使わない)
  _isFullscreen: false,
  // このビデオ通話の全画面ボタンでフルスクリーンに入ったかどうか。通話終了時、
  // 通話が原因で入ったフルスクリーンだけを自動解除する(通話開始前から
  // 既に全体をフルスクリーン表示していた場合まで解除してしまわないため)
  _fullscreenEnteredForCall: false,
  _unsubscribeFullscreenChanged: null,
  _fullscreenEscapeHandler: null,

  VIDEO_QUALITY_PRESETS: {
    low:    { width: 320,  height: 240, frameRate: 10,  maxBitrateBps: 200_000 },
    medium: { width: 640,  height: 480, frameRate: 15,  maxBitrateBps: 500_000 },
    high:   { width: 1280, height: 720, frameRate: 30,  maxBitrateBps: 1_500_000 },
  },

  _getMediaConstraints() {
    const preset = this.VIDEO_QUALITY_PRESETS[this._videoQualityPreset] || this.VIDEO_QUALITY_PRESETS.medium;
    const audioConstraints = this._selectedAudioInput
      ? { deviceId: { exact: this._selectedAudioInput } }
      : true;
    const videoConstraints = this.isVideoCall
      ? { width: { ideal: preset.width }, height: { ideal: preset.height },
          frameRate: { ideal: preset.frameRate },
          ...(this._selectedVideoInput ? { deviceId: { exact: this._selectedVideoInput } } : {}) }
      : false;
    return { audio: audioConstraints, video: videoConstraints };
  },

  _audioCtx: null,
  _ringTimer: null,

  init() {
    document.getElementById('btn-call-toggle').onclick = () => this.togglePanel();
    document.getElementById('call-panel-close').onclick  = () => this.hidePanel();
    // パネル内コンテンツはマスタ読み込み後に _renderCallPanel() で描画する

    // 着信ポーリング監視を開始
    this.startListening();
  },

  togglePanel() {
    const panel = document.getElementById('call-panel');
    if (panel.classList.contains('hidden')) this.showPanel();
    else this.hidePanel();
  },

  showPanel() {
    document.getElementById('call-panel').classList.remove('hidden');
    // 閉じている間に止めたポーリングを、会話を開いたまま閉じていた場合は再開する
    if (this._chatPeerId) {
      this._loadChatMessages();
      this._startChatPoll();
    }
    // 通話パネルを開いている間に病棟/検査室を切り替えると、発信元や会話相手の
    // 取り違えにつながるため(getMyId()が選択中の値をその場で読むため)、
    // パネルが閉じるまで一時的に操作を禁止する
    const wardSelect = document.getElementById('ward-select');
    if (wardSelect) wardSelect.disabled = true;
    const examRoomSelect = document.getElementById('exam-room-select');
    if (examRoomSelect) examRoomSelect.disabled = true;
    const allRoomsBtn = document.getElementById('btn-exam-all-rooms');
    if (allRoomsBtn) allRoomsBtn.disabled = true;
  },

  hidePanel() {
    document.getElementById('call-panel').classList.add('hidden');
    // 閉じている間まで会話をポーリングし続けない
    this._stopChatPoll();
    const examRoomSelect = document.getElementById('exam-room-select');
    if (examRoomSelect) examRoomSelect.disabled = false;
    const allRoomsBtn = document.getElementById('btn-exam-all-rooms');
    if (allRoomsBtn) allRoomsBtn.disabled = false;
    // 病棟セレクトは検査室端末モードでは常に無効化されているため、その状態を
    // 正しく復元できるApp側の関数へ委譲する(単純にfalseへ戻すと検査室端末
    // モードの端末で誤って有効化してしまう)
    if (typeof App !== 'undefined' && typeof App._applyTerminalRoleMode === 'function') {
      App._applyTerminalRoleMode({ navigate: false });
    } else {
      const wardSelect = document.getElementById('ward-select');
      if (wardSelect) wardSelect.disabled = false;
    }
  },

  // FAB(#btn-call-toggle)へ通話状態を反映する。発信中・着信中・通話中は
  // activeクラスで赤くパルスさせ、パネルを閉じていても一目でわかるように
  // する(css/style.cssの.call-fab.activeに対応)。状態が変わる全ての箇所
  // (startCall/showIncomingCallDialog/acceptCall/setConnectedState/
  // cleanupCall/answered受信時)から呼ぶ
  _updateCallFabState() {
    const btn = document.getElementById('btn-call-toggle');
    if (!btn) return;
    const active = this.isCalling || this.isConnected || this._isRinging;
    btn.classList.toggle('active', active);
  },

  // ── メインパネルHTML描画 ──
  // パネルは「発信先の一覧」と「1対1の会話」の2状態を持つ。_renderCallPanel()は
  // 子機の30秒ごとのマスタ再同期・病棟切り替え・マスタ保存後など、チャットの
  // 状態とは無関係な箇所からも繰り返し呼ばれる。会話画面を丸ごと再構築すると
  // 入力欄が新しいDOMノードに置き換わり、入力中のフォーカスが失われてしまうため、
  // 既に会話画面が表示されている間は再構築せず、相手の表示名(改名等)だけを
  // その場で更新する
  _renderCallPanel() {
    if (this._chatPeerId) {
      const peerNameEl = document.getElementById('chat-peer-name');
      if (peerNameEl) {
        peerNameEl.textContent = this.getNameById(this._chatPeerId);
        return;
      }
      this._renderChatView();
      return;
    }
    const body = document.getElementById('call-panel-body');
    if (!body) return;

    // 発信先1件分の行。行本体クリックは従来どおり「連絡方法の選択」を開き、
    // 右端のチャットボタンだけが会話を開く
    const targetRow = (record, kind) => `
      <div class="call-target-row">
        <button class="call-room-btn" data-${kind}-id="${UI.escapeHTML(record.id)}">
          <span class="call-room-name">${UI.escapeHTML(record.name)}</span>
          <span class="call-room-phone">${record.phone ? '内線 ' + UI.escapeHTML(record.phone) : '番号未設定'}</span>
        </button>
        <button class="call-chat-btn" data-chat-peer-id="${UI.escapeHTML(record.id)}"
          title="${UI.escapeHTML(record.name)}とチャット" aria-label="${UI.escapeHTML(record.name)}とチャット">
          <i class="fas fa-comment-alt" aria-hidden="true"></i>
        </button>
      </div>
    `;

    const roomBtns = AppState.examRooms.map(r => targetRow(r, 'room')).join('');

    // 病棟一覧は自分自身の病棟を除外する
    const wardBtns = AppState.wards
      .filter(w => w.id !== this.getMyId())
      .map(w => targetRow(w, 'ward'))
      .join('');

    body.innerHTML = `
      <div class="call-section-title"><i class="fas fa-hospital"></i> 病棟へ発信 (通話 / アナウンス / チャット)</div>
      <div class="call-room-list">${wardBtns || '<div class="text-muted text-sm">病棟データ読込中...</div>'}</div>
      <div class="divider"></div>
      <div class="call-section-title"><i class="fas fa-phone-alt"></i> 検査室へ発信 (通話 / アナウンス / チャット)</div>
      <div class="call-room-list">${roomBtns || '<div class="text-muted text-sm">検査室データ読込中...</div>'}</div>
    `;

    // 各ボタンにイベント設定
    body.querySelectorAll('.call-room-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const sourceId = this.getMyId();
        if (btn.dataset.wardId) {
          this.showCallSelectionDialog(btn.dataset.wardId, { fromId: sourceId });
          return;
        }
        const room = AppState.getExamRoomById(btn.dataset.roomId);
        if (room) {
          this.showCallSelectionDialog(room.id, { fromId: sourceId });
        }
      });
    });
    body.querySelectorAll('.call-chat-btn').forEach(btn => {
      btn.addEventListener('click', () => this.openChat(btn.dataset.chatPeerId));
    });
  },

  // ── 1対1チャット(アナウンス送信履歴を含む統合タイムライン) ──

  // 相手を指定して会話を開く。以後パネルは会話状態になる
  openChat(peerId) {
    if (!peerId) return;
    this._chatPeerId = peerId;
    this._chatMessages = [];
    this._renderChatView();
    this._loadChatMessages();
    this._startChatPoll();
  },

  // 会話を閉じて発信先の一覧へ戻る
  closeChat() {
    this._chatPeerId = null;
    this._chatMessages = [];
    this._stopChatPoll();
    this._renderCallPanel();
  },

  _startChatPoll() {
    this._stopChatPoll();
    this._chatPollTimer = setInterval(() => this._loadChatMessages(), this.CHAT_POLL_INTERVAL_MS);
  },

  _stopChatPoll() {
    if (this._chatPollTimer) {
      clearInterval(this._chatPollTimer);
      this._chatPollTimer = null;
    }
  },

  // 会話画面の外枠。_renderCallPanel()経由で何度も呼ばれうるので、
  // 入力途中のテキストは組み直しの前後で持ち越す
  _renderChatView() {
    const body = document.getElementById('call-panel-body');
    if (!body) return;
    const draft = document.getElementById('chat-input')?.value || '';
    const peerName = this.getNameById(this._chatPeerId);

    body.innerHTML = `
      <div class="chat-view-header">
        <button class="chat-back-btn" id="chat-back" aria-label="発信先の一覧へ戻る">
          <i class="fas fa-chevron-left" aria-hidden="true"></i>
        </button>
        <span class="chat-peer-name" id="chat-peer-name">${UI.escapeHTML(peerName)}</span>
        <button class="btn btn-sm btn-outline" id="btn-stop-speech"
          style="font-size:10px; padding:2px 6px; min-width:auto; height:auto; border-color:#ef4444; color:#ef4444; font-weight:normal; border-radius:3px;">音声停止</button>
      </div>
      <div id="chat-timeline" class="chat-timeline"></div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" maxlength="${this.CHAT_MAX_LENGTH}" placeholder="メッセージを入力..." autocomplete="off">
        <button class="btn btn-primary btn-sm" id="chat-send" aria-label="送信">
          <i class="fas fa-paper-plane" aria-hidden="true"></i>
        </button>
      </div>
    `;

    document.getElementById('chat-back').onclick = () => this.closeChat();

    const input = document.getElementById('chat-input');
    input.value = draft;
    // IME変換中のEnterで送信してしまわないよう isComposing を見る
    // (アナウンスの自由入力欄と同じ扱い)
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) this._sendChatMessage();
    });
    document.getElementById('chat-send').onclick = () => this._sendChatMessage();

    const stopBtn = document.getElementById('btn-stop-speech');
    if (stopBtn) {
      stopBtn.onclick = () => {
        this.announcementQueue = [];
        this.isSpeakingAnnouncement = false;
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        UI.toast('音声読み上げキューをクリアしました', 'warning');
      };
    }

    this._renderChatTimeline();
  },

  // メッセージ一覧だけを差し替える。5秒ポーリングからはこちらだけを呼び、
  // 入力欄やフォーカスを壊さないようにする
  _renderChatTimeline() {
    const el = document.getElementById('chat-timeline');
    if (!el) return;

    if (this._chatMessages.length === 0) {
      el.innerHTML = UI.emptyStateHtml('まだやりとりはありません', { icon: 'fas fa-comment-alt' });
      return;
    }

    const myId = this.getMyId();
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;

    el.innerHTML = this._chatMessages.map(m => {
      const time = UI.formatTimeSmart(m.created_at);
      const mine = String(m.from_id) === String(myId);
      return `
        <div class="chat-msg ${mine ? 'chat-msg--mine' : 'chat-msg--theirs'}">
          <div class="chat-bubble">${UI.escapeHTML(m.body)}</div>
          <div class="chat-msg-meta">${mine ? '自分' : UI.escapeHTML(m.from_name)} / ${time}</div>
        </div>
      `;
    }).join('');

    // 既に最下部を見ていたときだけ追従する(過去を読んでいる最中に
    // 新着で勝手にスクロールしてしまわないように)
    if (atBottom) el.scrollTop = el.scrollHeight;
  },

  async _loadChatMessages() {
    if (!this._chatPeerId) return;
    const key = UI.conversationKey(this.getMyId(), this._chatPeerId);
    if (!key) return;
    try {
      const list = await API.getChatMessages(key);
      // 取得中に会話を閉じた/切り替えた場合は古い応答を捨てる
      if (!this._chatPeerId || key !== UI.conversationKey(this.getMyId(), this._chatPeerId)) return;
      // アナウンス送信履歴(kind:'announce')は通知履歴パネル側に表示するため、
      // チャットのタイムラインには表示しない(記録自体はchat_messagesに残したままにする)
      this._chatMessages = list.filter(m => m.kind !== 'announce');
      this._renderChatTimeline();
    } catch (e) {
      console.warn('[Chat] 履歴の取得に失敗しました:', e);
    }
  },

  async _sendChatMessage() {
    if (this._chatSending) return;
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    const myId = this.getMyId();
    if (!myId || !this._chatPeerId) {
      UI.toast('送信元を特定できませんでした', 'warning');
      return;
    }

    this._chatSending = true;
    try {
      await this.recordChatMessage({
        fromId: myId,
        toId: this._chatPeerId,
        kind: 'chat',
        body: text.slice(0, this.CHAT_MAX_LENGTH),
      });
      input.value = '';
      await this._loadChatMessages();
    } catch (e) {
      console.error('[Chat] 送信に失敗しました:', e);
      UI.toast('メッセージの送信に失敗しました', 'danger');
    } finally {
      this._chatSending = false;
    }
  },

  // chat_messages への1件記録。チャット発言とアナウンス送信履歴の
  // 両方がこの1関数を通る(会話キーの組み立てを1箇所に閉じ込めるため)
  async recordChatMessage({ fromId, toId, kind, body }) {
    const conversationKey = UI.conversationKey(fromId, toId);
    if (!conversationKey) return null;
    return API.create('chat_messages', {
      id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      conversation_key: conversationKey,
      from_id: fromId,
      to_id: toId,
      from_name: this.getNameById(fromId),
      kind,
      body,
      created_at: Date.now(),
    });
  },

  // 受信したアナウンスの相手と会話を開いていれば、その場で履歴を取り直す
  // (5秒のポーリングを待たずに反映する)
  _refreshChatIfPeer(peerId) {
    if (this._chatPeerId && String(this._chatPeerId) === String(peerId)) {
      this._loadChatMessages();
    }
  },

  // ── 病棟側から呼び出す（検査室画面用）──
  callFromEvent(eventId) {
    const ev = AppState.activeEvents.find(e => e.id === eventId);
    if (!ev) return;
    const room = AppState.getExamRoomById(ev.exam_room_id);
    if (room) {
      this.showCallSelectionDialog(room.id, { fromId: ev.ward_id || AppState.currentWardId, eventId });
    }
  },

  // ── WebRTC 音声通話コア処理 ──

  getMyId() {
    // 自身のID判定: 検査室画面を開いていて検査室が選択されていればその部屋ID、さもなければ現在の病棟ID
    const tab = document.querySelector('.tab-btn.active')?.dataset.page;
    if (tab === 'exam-room') {
      return document.getElementById('exam-room-select')?.value || null;
    } else {
      return AppState.currentWardId || 'ward-1';
    }
  },

  // シグナリングpoll用のack識別子(client)には、他端末が閲覧できる_device_id
  // を流用してはならない。_device_idはハートビートで送信され、
  // GET /api/device/list を叩ける端末(共有APIトークンさえあれば全端末が叩ける)
  // からは他端末の正確な値がそのまま見える。流用すると、それを使って
  // clientに指定するだけで、本来別端末に届くはずのメッセージを自分が
  // 先にack(受信済み扱いに)でき、以後その端末は同じメッセージを二度と
  // 受け取れなくなる(着信・ICE候補・切断通知等の横取りによる着信妨害)。
  // 十分なエントロピーを持つ、ハートビート等どのAPIレスポンスにも
  // 含まれない秘匿値を別途生成して使う
  getClientId() {
    let id = localStorage.getItem('_signaling_client_id');
    if (!id) {
      id = `sig-${this._generateSignalingClientSecret()}`;
      localStorage.setItem('_signaling_client_id', id);
    }
    return id;
  },

  _generateSignalingClientSecret() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // crypto.randomUUID()が無い環境向けのフォールバック。単発のMath.random()
    // (base36で最大6桁≒31bit相当)では総当たりの余地が残るため複数回連結する
    return [Date.now().toString(36), Math.random().toString(36).slice(2),
      Math.random().toString(36).slice(2), Math.random().toString(36).slice(2)].join('-');
  },

  // 病棟IDは管理画面で任意の文字列を設定できる（'ward-'接頭辞は既定の例示に過ぎず必須ではない）
  // ため、IDの接頭辞では病棟/検査室を判別できない。実データを両方探して判定する
  resolveCallTarget(id) {
    if (!id) return null;
    const ward = AppState.wards.find(x => x.id === id);
    if (ward) return { type: 'ward', record: ward };
    const room = AppState.getExamRoomById(id);
    if (room) return { type: 'exam_room', record: room };
    return null;
  },

  getNameById(id) {
    const target = this.resolveCallTarget(id);
    return target ? target.record.name : '不明';
  },

  _getCallFromId() {
    return this._callSourceId || this.getMyId();
  },

  // この端末が最初に表示していた病棟。以後どの病棟のダッシュボードを
  // 閲覧していても、着信・自動アナウンスの受信対象に含め続けるための
  // 恒久的な受信先(getWardListenIds参照)
  _homeWardId: null,

  // ward-select変更のたびに変わる「今どの病棟を見ているか」と、この端末が
  // 実際に受信すべきIDを分離する。current_wardIdだけを使うと、他病棟の
  // ダッシュボードを一時的に見ている間、自分の病棟宛の着信・アナウンスを
  // 一切受信できなくなる
  _getWardListenIds() {
    const wardId = AppState.currentWardId || 'ward-1';
    if (!this._homeWardId) {
      // ホーム病棟はlocalStorageで再起動をまたいで保持する。メモリ上だけで
      // 確立していると、前回終了時にたまたま別病棟を一時閲覧していた場合、
      // その閲覧先(current_ward_idとして復元される)が再起動直後の新しい
      // ホーム病棟として誤って確立されてしまい、本来のホーム病棟宛の
      // 着信・自動アナウンスを再び取りこぼす
      const savedHomeWardId = localStorage.getItem('_home_ward_id');
      this._homeWardId = savedHomeWardId || wardId;
      if (!savedHomeWardId && wardId) localStorage.setItem('_home_ward_id', wardId);
    }
    const ids = [wardId];
    if (this._homeWardId && this._homeWardId !== wardId) ids.push(this._homeWardId);
    return ids;
  },

  // 検査室が1つも選択されていない間（未選択・「全検査室の患者一覧」表示中）は
  // getMyId()がnullを返し、以前はポーリング自体が止まっていた
  // （＝いずれの検査室宛の着信・自動アナウンスも一切受信できない不具合）。
  // 特定の検査室に絞れない以上、既知の全検査室を受信対象にする
  _getExamRoomListenIds() {
    const selected = document.getElementById('exam-room-select')?.value || '';
    if (selected) return [selected];
    return (AppState.examRooms || []).map(r => r.id).filter(Boolean);
  },

  // 通常時（発信中・通話中でない）にこの端末が受信すべきID一覧
  _getListenIds() {
    const tab = document.querySelector('.tab-btn.active')?.dataset.page;
    return tab === 'exam-room' ? this._getExamRoomListenIds() : this._getWardListenIds();
  },

  startListening() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      const now = Date.now();
      if (now < this._nextPollAt) return;
      let pollOk = true;
      // WebRTC設定の取得
      const webrtcSetting = AppState.systemSettings?.find(s => s.id === 'enable_webrtc_call');
      if (webrtcSetting && webrtcSetting.value === 'false') {
        this._nextPollAt = Date.now() + 5000;
        return; // WebRTC通話が無効の場合はポーリングを行わない
      }

      // 発信中・通話中は、そのやり取りを開始した時のID(_callSourceId)を使い続ける。
      // getMyId()はアクティブなタブ/選択中の検査室から都度その場で判定するため、
      // 呼び出し中に他のタブへ切り替えると相手からの応答・拒否シグナルの宛先(myId)が
      // ずれて届かなくなり、応答/拒否に気づけないままになってしまう
      const myIds = (this.isCalling || this.isConnected)
        ? [this._callSourceId || this.getMyId()].filter(Boolean)
        : this._getListenIds();
      if (myIds.length === 0) {
        this._nextPollAt = Date.now() + 1500;
        return;
      }

      if (this._pollInFlight) {
        this._nextPollAt = Date.now() + 500;
        return;
      }
      this._pollInFlight = true;
      try {
        const clientId = this.getClientId();
        const results = await Promise.allSettled(myIds.map(id => API.webrtcPoll(id, clientId)));
        for (const result of results) {
          if (result.status !== 'fulfilled') { pollOk = false; continue; }
          const res = result.value;
          if (res && res.success && res.messages) {
            for (const msg of res.messages) {
              if (msg.msgId) {
                if (this._seenMsgIds.has(msg.msgId)) continue;
                this._seenMsgIds.add(msg.msgId);
                // メモリ肥大防止：上限500件を超えたら古いものを削除
                if (this._seenMsgIds.size > 500) {
                  const first = this._seenMsgIds.values().next().value;
                  this._seenMsgIds.delete(first);
                }
              }
              await this.handleSignalingMessage(msg);
            }
          }
        }
      } catch (e) {
        pollOk = false;
        console.error('[WebRTC Poll Error]', e);
      } finally {
        this._pollInFlight = false;
        this._pollFailures = pollOk ? 0 : Math.min(this._pollFailures + 1, 5);
        const baseDelay = this._pollFailures ? Math.min(15000, 1500 * Math.pow(2, this._pollFailures - 1)) : 1500;
        this._nextPollAt = Date.now() + Math.round(baseDelay + (Math.random() * 500));
      }
    }, 500);
  },

  // 通話の文脈(targetId)が無い、または相手が現在の通話相手と異なるメッセージは無視する。
  // シグナリングメッセージはキューに最大30秒残るため、これが無いと通信が数秒詰まった
  // あとに再開した際、直前の通話のhangup/busyが次の通話を切ってしまうことがある
  _isFromCurrentPeer(msg) {
    return !!this.targetId && msg.from === this.targetId;
  },

  // setRemoteDescription前に保留していたICE候補をまとめて適用する
  async _flushPendingIceCandidates() {
    if (!this.peerConnection || this._pendingIceCandidates.length === 0) return;
    const queued = this._pendingIceCandidates;
    this._pendingIceCandidates = [];
    for (const candidate of queued) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('[WebRTC] addIceCandidate (queued) error:', e);
      }
    }
  },

  async handleSignalingMessage(msg) {
    console.log('[WebRTC Signaling] Received:', msg.type, 'from:', msg.from);

    if (msg.type === 'offer') {
      if (this.peerConnection || this.isCalling || this.isConnected || this._isRinging) {
        // 話し中の場合は拒否シグナル
        await API.webrtcSend({
          from: this._getCallFromId(),
          to: msg.from,
          type: 'busy'
        });
        return;
      }
      this.targetId = msg.from;
      this.isVideoCall = !!msg.video;
      this.showIncomingCallDialog(msg.from, msg.sdp);
    }
    else if (msg.type === 'answer') {
      if (!this._isFromCurrentPeer(msg)) return;
      if (this.peerConnection) {
        try {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          await this._flushPendingIceCandidates();
          this.setConnectedState();
        } catch (e) {
          console.error('[WebRTC] setRemoteDescription Answer error:', e);
        }
      }
    }
    else if (msg.type === 'ice') {
      if (!this._isFromCurrentPeer(msg) || !msg.candidate) return;
      if (this.peerConnection && this.peerConnection.remoteDescription) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (e) {
          console.error('[WebRTC] addIceCandidate error:', e);
        }
      } else {
        // remoteDescription未設定(着信呼び出し中はpeerConnection自体が未作成)。
        // 捨てずに溜め、setRemoteDescription直後にフラッシュする
        this._pendingIceCandidates.push(msg.candidate);
        if (this._pendingIceCandidates.length > this.MAX_PENDING_ICE_CANDIDATES) {
          this._pendingIceCandidates.shift();
        }
      }
    }
    else if (msg.type === 'hangup') {
      if (!this._isFromCurrentPeer(msg)) return;
      this.cleanupCall('相手が切断しました');
    }
    else if (msg.type === 'busy') {
      if (!this._isFromCurrentPeer(msg)) return;
      // 同じIDを2台以上の端末が表示している場合、片方が応答した直後にもう片方が
      // 拒否/無応答タイムアウトしてbusyを送ってくることがある。既に確立済み
      // (または相手からの応答待ち中に別の応答で確立済み)の通話をそれで切っては
      // ならない
      if (this.isConnected) return;
      this.cleanupCall('話し中、または応答がありません');
    }
    else if (msg.type === 'answered') {
      // 同じIDを持つ別端末が応答した → ダイアログを静かに閉じる。
      // 無応答タイムアウトを解除し忘れると、この端末で後からタイマーが発火して
      // busyを送り、既に確立済みの通話を切ってしまう。
      // _isRinging も見ることで、着信中でない(=無関係な別のダイアログを表示中の)
      // 端末が誤ってそのダイアログを閉じないようにする
      if (!this.isConnected && !this.isCalling && this._isRinging) {
        if (this._incomingRingTimeoutId) { clearTimeout(this._incomingRingTimeoutId); this._incomingRingTimeoutId = null; }
        this._isRinging = false;
        this._updateCallFabState();
        this.stopRingTone();
        // targetIdを残したままだと、この端末は「応答しなかった側」なのに
        // 後続のice/hangupをこの通話のものとして誤って処理し続けてしまう
        this.targetId = null;
        this._pendingIceCandidates = [];
        const overlay = document.getElementById('webrtc-call-overlay');
        if (overlay) overlay.remove();
      }
    }
    else if (msg.type === 'speech') {
      this.playAnnouncement(msg.text, msg.from, { automatic: msg.automatic === true });
    }
  },

  // navigator.mediaDevices / getUserMedia / enumerateDevices自体が存在しない
  // 環境(制限されたビルド・古いWebView等)でも安全に判定できるようにする
  _isMediaDevicesApiAvailable() {
    return !!(navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof navigator.mediaDevices.enumerateDevices === 'function');
  },

  // マイク・カメラの有無を判定する。enumerateDevices()自体が権限等の理由で
  // 失敗した場合は「実際に無い」と決めつけず、発信時のgetUserMedia()の成否に
  // 判断を委ねる(発信ボタンを一律に禁止しない)
  async _detectMediaCapabilities() {
    if (!this._isMediaDevicesApiAvailable()) {
      return { apiAvailable: false, hasMic: false, hasCam: false, enumerationFailed: false };
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        apiAvailable: true,
        hasMic: devices.some(d => d.kind === 'audioinput'),
        hasCam: devices.some(d => d.kind === 'videoinput'),
        enumerationFailed: false,
      };
    } catch (e) {
      console.warn('[CallPanel] デバイス列挙に失敗しました:', e);
      return { apiAvailable: true, hasMic: true, hasCam: true, enumerationFailed: true };
    }
  },

  _disableCallButton(btn) {
    if (!btn) return;
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'not-allowed';
    btn.style.pointerEvents = 'none';
    btn.onclick = null;
  },

  _showMediaWarning(el, text) {
    if (!el || !text) return;
    el.style.display = 'block';
    el.textContent = text;
  },

  // ── コール選択ダイアログ (音声通話 or 定型アナウンス) ──
  showCallSelectionDialog(targetId, { fromId = null, eventId = null } = {}) {
    if (this.isCalling || this.isConnected) {
      UI.toast('既に通話中です。先に現在の通話を終了してください。', 'warning');
      return;
    }
    const targetName = this.getNameById(targetId);
    const targetNameHtml = UI.escapeHTML(targetName);
    const sourceId = fromId || this.getMyId();
    const sourceName = this.getNameById(sourceId);
    
    const old = document.getElementById('webrtc-call-overlay');
    if (old) old.remove();

    const phoneNum = this.resolveCallTarget(targetId)?.record.phone || '';
    const phoneNumHtml = UI.escapeHTML(phoneNum || '');

    // 定型文リストの構築 (データベースから動的に取得)
    const myName = this.getNameById(sourceId);
    const event = eventId
      ? (AppState.activeEvents.find(e => e.id === eventId) || AppState.todayEvents.find(e => e.id === eventId))
      : null;
    const bed = event ? AppState.getBedById(event.bed_id) : null;
    const patientName = String(event?.patient_name || bed?.patient_name || '').trim();
    const prefixPatientName = patientName && AppState.getSettingBool('speech_include_patient_name', false);
    const templatesSetting = AppState.systemSettings?.find(s => s.id === 'speech_templates');
    let templates = [];
    if (templatesSetting && templatesSetting.value) {
      try {
        templates = JSON.parse(templatesSetting.value);
      } catch (e) {
        console.error('[CallPanel] speech_templates parse error:', e);
      }
    }
    
    // フォールバック
    if (!Array.isArray(templates) || templates.length === 0) {
      templates = [
        `${myName}から、連絡事項があります。`,
        `間もなく、患者が出発します。`,
        `患者が到着しました。`,
        `検査が終了しました。お迎えをお願いします。`,
        `移送をキャンセルします。`,
        `至急、ご連絡ください。`
      ];
    }

    // WebRTC音声通話の有効化設定を確認
    const webrtcSetting = AppState.systemSettings?.find(s => s.id === 'enable_webrtc_call');
    const isWebRtcEnabled = !webrtcSetting || webrtcSetting.value !== 'false';

    const voiceBtnHtml = isWebRtcEnabled ? `
          <!-- 音声通話・ビデオ通話を開始するボタン(横並びでコンパクトに) -->
          <div style="display:flex; gap:8px;">
            <button class="btn btn-success" id="webrtc-btn-start-voice" style="flex:1; padding: 10px 6px; font-size: 13px; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: var(--shadow-sm);">
              <i class="fas fa-phone-alt" style="font-size: 14px;"></i>
              <span>音声通話</span>
            </button>
            <button class="btn btn-primary" id="webrtc-btn-start-video" style="flex:1; padding: 10px 6px; font-size: 13px; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: var(--shadow-sm);">
              <i class="fas fa-video" style="font-size: 14px;"></i>
              <span>ビデオ通話</span>
            </button>
          </div>
          <!-- マイク/カメラが利用できない場合の警告(非同期のデバイス確認後に表示) -->
          <div id="webrtc-media-warning" style="display:none; font-size:11px; color:#b45309; background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:6px 9px; margin-top:6px;"></div>
    ` : `
          <!-- 無効化時の表示 -->
          <button class="btn btn-secondary" id="webrtc-btn-start-voice" disabled style="padding: 12px; font-size: 13px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; opacity: 0.6; cursor: not-allowed; pointer-events: none;">
            <i class="fas fa-phone-slash" style="font-size: 16px;"></i>
            <span>通話・ビデオ機能は無効化されています</span>
          </button>
    `;

    // 定型文中に{n}トークンがあれば、クリック即送信のボタンではなく、
    // 数字入力欄を常時表示した複合行として描画する(展開式にはしない)。
    // 1つの定型文に{n}を複数書いた場合は、その数だけ入力欄が並ぶ。
    // ワンクリック送信(button)と数字入力欄付き(div)の両方に
    // announcement-template-itemクラスを与え、枠線・角丸・paddingを揃える
    // ことで見た目の一貫性を持たせる(css/style.css参照)。数字入力欄付きの
    // 行はhas-blankクラスによる左端の色付きボーダーと「🔢 要入力」バッジで、
    // 文章を読まなくても一目で区別できるようにする
    const templateBtns = templates.map((t, idx) => {
      const parsed = UI.splitAnnouncementTemplate(t);
      if (!parsed.hasBlank) {
        return `
      <button class="announcement-template-item btn-send-announcement" data-text="${UI.escapeHTML(t)}">
        <span class="announcement-template-row">
          <i class="fas fa-bullhorn" style="color:#3b82f6;"></i>
          <span>${UI.escapeHTML(t)}</span>
        </span>
      </button>
    `;
      }
      const innerHtml = parsed.segments.map(seg => seg.type === 'text'
        ? `<span>${UI.escapeHTML(seg.value)}</span>`
        : `<input type="number" inputmode="numeric" class="template-blank-input" data-template-idx="${idx}">`
      ).join('');
      return `
      <div class="announcement-template-item has-blank btn-send-announcement-blank" data-template-idx="${idx}">
        <span class="announcement-template-row">
          <i class="fas fa-bullhorn" style="color:#3b82f6;"></i>
          <span class="announcement-template-blank-badge">🔢 要入力</span>
          ${innerHtml}
        </span>
        <button class="btn btn-primary btn-send-blank-template" data-template-idx="${idx}">
          <i class="fas fa-paper-plane"></i> 送信
        </button>
      </div>
    `;
    }).join('');

    const overlay = document.createElement('div');
    overlay.id = 'webrtc-call-overlay';
    overlay.className = 'phone-dialog-overlay';
    overlay.innerHTML = `
      <div class="phone-dialog" role="dialog" style="border-color: #3b82f6; width: 420px;">
        <div class="phone-dialog-header" style="background: #3b82f6; color: white;">
          <i class="fas fa-phone-alt"></i>
          <span>連絡方法の選択: ${targetNameHtml}</span>
          <button class="phone-dialog-close" id="webrtc-btn-close-selection"><i class="fas fa-times"></i></button>
        </div>
        <div class="phone-dialog-body" style="padding: 16px; display:flex; flex-direction:column; gap:16px; max-height: min(560px, 78vh); overflow-y: auto;">

          ${voiceBtnHtml}
          <div style="font-size:11px;color:#64748b;">
            <i class="fas fa-arrow-right"></i> 発信元: <strong>${UI.escapeHTML(sourceName)}</strong>
            ${patientName ? ` / 対象患者: <strong>${UI.escapeHTML(prefixPatientName ? patientName : '患者名は読み上げません')}</strong>` : ''}
          </div>

          <!-- 簡易定型アナウンスを送信するセクション -->
          <div style="border-top: 1px solid #e2e8f0; padding-top: 12px;">
            <div style="font-size: 11px; font-weight: bold; color: #475569; margin-bottom: 8px;">
              <i class="fas fa-comment-alt"></i> 呼び出さずにアナウンスを送信 (音声合成):
            </div>
            <!-- 手動入力エリア -->
            <div style="display:flex;gap:6px;margin-bottom:8px;">
              <input type="text" id="announce-custom-text" maxlength="200"
                placeholder="自由入力でアナウンスを送信..."
                style="flex:1;padding:7px 10px;border:1px solid #cbd5e0;border-radius:6px;font-size:12.5px;">
              <button class="btn btn-primary btn-sm" id="btn-send-announce-custom"
                style="white-space:nowrap;padding:6px 12px;">
                <i class="fas fa-paper-plane"></i> 送信
              </button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 6px;">
              ${templateBtns}
            </div>
          </div>
 
          <!-- デバイス設定 -->
          <details style="border:1px solid #e2e8f0;border-radius:6px;padding:6px 12px;">
            <summary style="font-size:12px;font-weight:600;color:#374151;cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;">
              <i class="fas fa-sliders-h" style="color:#64748b;"></i> カメラ / マイク設定
            </summary>
            <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
              <div>
                <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;"><i class="fas fa-microphone"></i> マイク</label>
                <select id="webrtc-mic-select" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px;">
                  <option value="">デフォルト</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;"><i class="fas fa-video"></i> カメラ（ビデオ通話時）</label>
                <select id="webrtc-cam-select" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px;">
                  <option value="">デフォルト</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;"><i class="fas fa-film"></i> ビデオ品質</label>
                <select id="webrtc-quality-select" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px;">
                  <option value="low">低画質 (320×240 / 10fps / 200kbps)</option>
                  <option value="medium">標準 (640×480 / 15fps / 500kbps)</option>
                  <option value="high">高画質 (1280×720 / 30fps / 1500kbps)</option>
                </select>
              </div>
            </div>
          </details>

          <!-- 内線番号表示（バックアップ用） -->
          ${phoneNum ? `
          <div style="border-top: 1px solid #e2e8f0; padding-top: 10px; text-align: center; font-size: 11px; color: #64748b;">
            内線電話からかける場合: <strong style="font-size:13px;color:#1e293b;">内線 ${phoneNumHtml}</strong>
          </div>
          ` : ''}

        </div>
        <div class="phone-dialog-footer" style="padding: 8px 16px; background: #f8fafc; border-top: 1px solid #e2e8f0;">
          <button class="btn btn-outline" id="webrtc-btn-cancel-selection" style="width: 100%;">閉じる</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
 
    // デバイスリストを非同期でポピュレート(navigator.mediaDevices自体が
    // 無い環境ではAPIに触れずスキップする)
    if (this._isMediaDevicesApiAvailable()) {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        const micSel = document.getElementById('webrtc-mic-select');
        const camSel = document.getElementById('webrtc-cam-select');
        devices.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `デバイス (${d.deviceId.slice(0, 8)})`;
          if (d.kind === 'audioinput' && micSel) micSel.appendChild(opt);
          if (d.kind === 'videoinput' && camSel) camSel.appendChild(opt);
        });
        if (micSel && this._selectedAudioInput) micSel.value = this._selectedAudioInput;
        if (camSel && this._selectedVideoInput) camSel.value = this._selectedVideoInput;
        if (micSel) micSel.onchange = () => { this._selectedAudioInput = micSel.value || null; };
        if (camSel) camSel.onchange = () => { this._selectedVideoInput = camSel.value || null; };
      }).catch(() => {});
    }

    // ビデオ品質セレクト
    const qSel = document.getElementById('webrtc-quality-select');
    if (qSel) {
      qSel.value = this._videoQualityPreset;
      qSel.onchange = () => {
        this._videoQualityPreset = qSel.value;
        localStorage.setItem('tbs_video_quality', qSel.value);
      };
    }

    // イベントバインド
    const closeBtn = () => { overlay.remove(); };
    document.getElementById('webrtc-btn-close-selection').onclick = closeBtn;
    document.getElementById('webrtc-btn-cancel-selection').onclick = closeBtn;
 
    // 音声通話を開始するボタン (有効な場合のみイベントを設定)
    if (isWebRtcEnabled) {
      const voiceBtn = document.getElementById('webrtc-btn-start-voice');
      const videoBtn = document.getElementById('webrtc-btn-start-video');
      const warningEl = document.getElementById('webrtc-media-warning');

      voiceBtn.onclick = () => {
        this.isVideoCall = false;
        overlay.remove(); // 選択画面を閉じて
        this.startCall(targetId, sourceId); // WebRTC通話を開始
      };
      if (videoBtn) {
        videoBtn.onclick = () => {
          this.isVideoCall = true;
          overlay.remove();
          this.startCall(targetId, sourceId);
        };
      }

      // デバイスの利用可否を確認し、無いものだけを個別に無効化する。
      // navigator.mediaDevices/getUserMedia/enumerateDevices自体が使えない
      // 環境では両方とも無効化して警告する。enumerateDevices()自体が権限等で
      // 失敗した場合は「実在するか判断できない」ため無効化せず、発信時の
      // getUserMedia()の成否に一律禁止せず委ねる
      if (!this._isMediaDevicesApiAvailable()) {
        this._disableCallButton(voiceBtn);
        this._disableCallButton(videoBtn);
        this._showMediaWarning(warningEl, 'この端末ではマイク・カメラを利用できないため、通話機能を無効化しました');
      } else {
        this._detectMediaCapabilities().then(({ hasMic, hasCam, enumerationFailed }) => {
          if (enumerationFailed) return;
          const reasons = [];
          if (!hasMic) {
            this._disableCallButton(voiceBtn);
            reasons.push('マイクが見つかりません');
          }
          if (!hasMic || !hasCam) {
            this._disableCallButton(videoBtn);
            if (hasMic && !hasCam) reasons.push('カメラが見つかりません');
          }
          if (reasons.length) this._showMediaWarning(warningEl, reasons.join(' / '));
        }).catch(() => {});
      }
    }
 
    // アナウンス送信共通関数
    const sendAnnounce = async (text) => {
      if (!text?.trim()) { UI.toast('テキストを入力してください', 'warning'); return; }
      if (!sourceId) { UI.toast('発信元を特定できませんでした。病棟または検査室を選択してください。', 'warning'); return; }
      const speechText = prefixPatientName ? `${patientName}さん、${text.trim()}` : text.trim();
      try {
        await API.webrtcSend({ from: sourceId, to: targetId, type: 'speech', text: speechText });
        // 読み上げ自体は上のシグナリング経路(即時)のまま。履歴として後から
        // 追えるよう、同じ内容をチャットのタイムラインにも1件残す。
        // ここが失敗しても読み上げは既に送信済みなので、送信自体は成功扱いにする
        this.recordChatMessage({
          fromId: sourceId,
          toId: targetId,
          kind: 'announce',
          body: speechText,
        }).catch(err => {
          console.warn('[Chat] アナウンス履歴の記録に失敗しました:', err);
          UI.toast('アナウンス履歴の記録に失敗しました', 'warning');
        });
        UI.toast('音声アナウンスを送信しました', 'success');
        overlay.remove();
      } catch (e) {
        console.error(e);
        UI.toast('送信に失敗しました', 'danger');
      }
    };

    // 手動入力送信
    document.getElementById('btn-send-announce-custom')?.addEventListener('click', () => {
      sendAnnounce(document.getElementById('announce-custom-text')?.value);
    });
    document.getElementById('announce-custom-text')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) sendAnnounce(e.target.value);
    });

    // 定型アナウンスボタンイベント({n}を含まない、クリック即送信のもの)
    overlay.querySelectorAll('.btn-send-announcement').forEach(btn => {
      btn.addEventListener('click', () => sendAnnounce(btn.dataset.text));
    });

    // 数字入力欄を含む定型文の送信処理。未入力の欄が1つでもあれば送信せず
    // 警告を出す(空欄のままアナウンスが流れてしまうことを防ぐ)。
    // 各行(div)配下だけを対象にせず、入力欄・送信ボタンいずれもdata-template-idx
    // で紐付けてoverlay全体からフラットに集める(要素は出現順=文中で左から右の
    // 順で並ぶため、そのままfillAnnouncementTemplateへ渡す順序として使える)
    const blankInputsByTemplate = new Map();
    overlay.querySelectorAll('.template-blank-input').forEach(inp => {
      const idx = parseInt(inp.dataset.templateIdx, 10);
      if (!blankInputsByTemplate.has(idx)) blankInputsByTemplate.set(idx, []);
      blankInputsByTemplate.get(idx).push(inp);
    });
    overlay.querySelectorAll('.btn-send-blank-template').forEach(sendBtn => {
      const idx = parseInt(sendBtn.dataset.templateIdx, 10);
      const template = templates[idx];
      const inputs = blankInputsByTemplate.get(idx) || [];
      const sendFromRow = () => {
        if (inputs.some(inp => inp.value.trim() === '')) {
          UI.toast('数字をすべて入力してください', 'warning');
          return;
        }
        const composed = UI.fillAnnouncementTemplate(template, inputs.map(inp => inp.value.trim()));
        if (composed !== null) sendAnnounce(composed);
      };
      sendBtn.addEventListener('click', sendFromRow);
      inputs.forEach(inp => {
        inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) sendFromRow(); });
      });
    });
  },

  async startCall(targetId, fromId = null) {
    if (this.isCalling || this.isConnected) {
      UI.toast('既に通話中です。先に現在の通話を終了してください。', 'warning');
      return;
    }
    const myId = fromId || this.getMyId();
    if (!myId) {
      UI.toast('自身のIDを特定できませんでした。検査室または病棟を選択してください。', 'danger');
      return;
    }
    if (myId === targetId) {
      UI.toast('自分自身には架電できません。', 'warning');
      return;
    }

    this.targetId = targetId;
    this._callSourceId = myId;
    this.isCalling = true;
    this._updateCallFabState();

    this.showCallingDialog(targetId);
    this.playRingBackTone();

    try {
      // 1. マイク・カメラ取得（品質プリセット適用）
      this.localStream = await navigator.mediaDevices.getUserMedia(this._getMediaConstraints());

      // 2. PeerConnection 作成
      this.createPeerConnection();

      // 3. トラック追加
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });

      // 4. Offer 作成
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      // 5. Offer 送信
      await API.webrtcSend({
        from: myId,
        to: targetId,
        type: 'offer',
        sdp: offer,
        video: this.isVideoCall
      });

      // コール記録を一時作成
      this.currentCallId = `call-${Date.now()}`;
      await API.create('calls', {
        id: this.currentCallId,
        from_id: myId,
        to_id: targetId,
        status: 'calling',
        started_at: Date.now()
      });

      // 無応答タイムアウト: 一定時間応答が無ければ自動的に発信を取りやめる
      this._ringTimeoutId = setTimeout(async () => {
        if (!this.isCalling) return;
        if (this.targetId) {
          await API.webrtcSend({ from: this._getCallFromId(), to: this.targetId, type: 'hangup' }).catch(() => {});
        }
        this.cleanupCall('応答がありませんでした');
      }, this.CALL_RING_TIMEOUT_MS);

    } catch (e) {
      console.error('[WebRTC] Start Call Error:', e);
      this.cleanupCall(this.isVideoCall
        ? 'マイクまたはカメラへのアクセスが拒否されたか、見つかりません'
        : 'マイクへのアクセスが拒否されたか、マイクが見つかりません');
    }
  },

  showIncomingCallDialog(callerId, offerSdp) {
    const callerName = this.getNameById(callerId);
    const callerNameHtml = UI.escapeHTML(callerName);

    const old = document.getElementById('webrtc-call-overlay');
    if (old) old.remove();

    this._isRinging = true;
    this._updateCallFabState();
    this.playIncomingRingTone();

    const isVideo = this.isVideoCall;

    const overlay = document.createElement('div');
    overlay.id = 'webrtc-call-overlay';
    overlay.className = 'phone-dialog-overlay';
    overlay.innerHTML = `
      <div class="phone-dialog" role="dialog" style="border-color: #3b82f6;">
        <div class="phone-dialog-header" style="background: #3b82f6; color: white;">
          <i class="fas ${isVideo ? 'fa-video' : 'fa-phone-volume'}"></i>
          <span>${isVideo ? 'ビデオ通話着信' : '通話着信'}</span>
        </div>
        <div class="phone-dialog-body" style="text-align: center; padding: 24px 16px;">
          <div style="font-size: 22px; font-weight: bold; margin-bottom: 8px; color: #1e293b;">${callerNameHtml}</div>
          <div style="color: #3b82f6; font-size: 13px; font-weight: bold; animation: pulse 1.5s infinite;">
            ${isVideo ? '内線ビデオ通話を着信中...' : '内線音声通話を着信中...'}
          </div>
        </div>
        <div class="phone-dialog-footer" style="display: flex; gap: 12px; justify-content: center; padding: 12px 16px;">
          <button class="btn btn-success" id="webrtc-btn-accept" style="flex: 1; padding: 10px; font-weight: bold;">
            <i class="fas fa-phone"></i> 応答
          </button>
          <button class="btn btn-secondary" id="webrtc-btn-reject" style="flex: 1; padding: 10px;">
            拒否
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // 無応答タイムアウト: 一定時間応答も拒否もされなければ自動的に拒否扱いにする
    if (this._incomingRingTimeoutId) clearTimeout(this._incomingRingTimeoutId);
    this._incomingRingTimeoutId = setTimeout(() => {
      this._declineIncomingCall(callerId, '応答がありませんでした（自動的に終了しました）');
    }, this.CALL_RING_TIMEOUT_MS);

    document.getElementById('webrtc-btn-accept').onclick = async () => {
      if (this._incomingRingTimeoutId) { clearTimeout(this._incomingRingTimeoutId); this._incomingRingTimeoutId = null; }
      this.stopRingTone();
      // 同じIDを開いている他端末に「応答済み」を通知
      await API.webrtcSend({ from: this.getMyId(), to: this.getMyId(), type: 'answered' }).catch(() => {});
      await this.acceptCall(callerId, offerSdp);
    };

    document.getElementById('webrtc-btn-reject').onclick = () => this._declineIncomingCall(callerId);
  },

  // 着信を拒否する（手動での「拒否」ボタン、および無応答タイムアウトの両方から呼ばれる）
  async _declineIncomingCall(callerId, message = '着信を拒否しました') {
    if (this._incomingRingTimeoutId) { clearTimeout(this._incomingRingTimeoutId); this._incomingRingTimeoutId = null; }
    this._isRinging = false;
    this.stopRingTone();
    await API.webrtcSend({
      from: this.getMyId(),
      to: callerId,
      type: 'busy'
    }).catch(() => {});
    // 不応答として記録
    await API.create('calls', {
      id: `call-missed-${Date.now()}`,
      from_id: callerId,
      to_id: this.getMyId(),
      status: 'missed',
      started_at: Date.now(),
      ended_at: Date.now()
    }).catch(() => {});
    this.cleanupCall(message);
  },

  async acceptCall(callerId, offerSdp) {
    this.isCalling = false;
    this.isConnected = true;
    this._isRinging = false;
    this._updateCallFabState();
    this._callSourceId = this.getMyId();

    this.showConnectedDialog(callerId);

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(this._getMediaConstraints());

      this.createPeerConnection();

      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });

      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offerSdp));
      await this._flushPendingIceCandidates();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      await API.webrtcSend({
        from: this._getCallFromId(),
        to: callerId,
        type: 'answer',
        sdp: answer
      });

      // 通話開始の記録（応答した時点なのでstarted_at/answered_atとも現在時刻）
      this.currentCallId = `call-${Date.now()}`;
      const acceptedAt = Date.now();
      await API.create('calls', {
        id: this.currentCallId,
        from_id: callerId,
        to_id: this.getMyId(),
        status: 'connected',
        started_at: acceptedAt,
        answered_at: acceptedAt
      });

      this.startCallTimer();

    } catch (e) {
      console.error('[WebRTC] Accept Call Error:', e);
      this.cleanupCall(this.isVideoCall
        ? 'マイクまたはカメラが見つからないか、応答処理中にエラーが発生しました'
        : 'マイクが見つからないか、応答処理中にエラーが発生しました');
    }
  },

  createPeerConnection() {
    // 院内LAN内の端末間通話ではhost candidateだけを使用する。公開STUNへ
    // 内部IP情報を送信せず、完全オフラインでも接続待ちが発生しないようにする。
    const config = { iceServers: [] };

    this.peerConnection = new RTCPeerConnection(config);

    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate && this.targetId) {
        await API.webrtcSend({
          from: this._getCallFromId(),
          to: this.targetId,
          type: 'ice',
          candidate: event.candidate
        });
      }
    };

    this.peerConnection.ontrack = (event) => {
      console.log('[WebRTC] Received remote track');
      if (this.isVideoCall) {
        setTimeout(() => {
          const remoteVideo = document.getElementById('webrtc-remote-video');
          if (remoteVideo) {
            remoteVideo.srcObject = event.streams[0];
          }
        }, 50);
      } else {
        if (!this.remoteAudio) {
          this.remoteAudio = document.createElement('audio');
          this.remoteAudio.autoplay = true;
          this.remoteAudio.style.display = 'none';
          document.body.appendChild(this.remoteAudio);
        }
        this.remoteAudio.srcObject = event.streams[0];
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection) {
        const state = this.peerConnection.connectionState;
        console.log('[WebRTC] Connection State Changed:', state);
        
        const statusLabel = document.getElementById('webrtc-call-status-label');
        const header = document.querySelector('#webrtc-call-overlay .phone-dialog-header');
        const dialog = document.querySelector('#webrtc-call-overlay .phone-dialog');
        
        if (state === 'disconnected') {
          // 再接続処理
          if (statusLabel) {
            statusLabel.innerHTML = `<i class="fas fa-exclamation-triangle"></i> 接続不安定: 再接続中...`;
            statusLabel.style.color = '#d97706';
          }
          if (header) {
            header.style.background = '#d97706';
          }
          if (dialog) {
            dialog.style.borderColor = '#d97706';
          }
          
          if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = setTimeout(() => {
            console.log('[WebRTC] Reconnection timeout exceeded. Cleaning up.');
            this.cleanupCall('再接続タイムアウト');
          }, 7000); // 7秒間待機
          
        } else if (state === 'failed') {
          this.cleanupCall('通話が切断されました');
        } else if (state === 'connected') {
          if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
            
            if (statusLabel) {
              statusLabel.textContent = '通話中';
              statusLabel.style.color = '#16a34a';
            }
            if (header) {
              header.style.background = '#16a34a';
            }
            if (dialog) {
              dialog.style.borderColor = '#16a34a';
            }
            
            UI.toast('通話が再接続されました', 'success');
          }
        }
      }
    };
  },

  setConnectedState() {
    if (this._ringTimeoutId) { clearTimeout(this._ringTimeoutId); this._ringTimeoutId = null; }
    this.stopRingTone();
    this.isCalling = false;
    this.isConnected = true;
    this._updateCallFabState();
    this.showConnectedDialog(this.targetId);
    this.startCallTimer();
    this._startStatsPolling();
    if (this.currentCallId) {
      API.patch('calls', this.currentCallId, { answered_at: Date.now() }).catch(() => {});
    }
    // ビットレート制限を接続後に適用
    if (this.isVideoCall) {
      setTimeout(() => this._applyBitrateToAll(), 1500);
    }
  },

  // ── 統計ポーリング ──
  _startStatsPolling() {
    this._stopStatsPolling();
    this._prevStats = null;
    this._statsInterval = setInterval(() => this._updateNetworkStats(), 2500);
  },

  _stopStatsPolling() {
    if (this._statsInterval) { clearInterval(this._statsInterval); this._statsInterval = null; }
  },

  async _updateNetworkStats() {
    if (!this.peerConnection) return;
    try {
      const stats = await this.peerConnection.getStats();
      let rtt = null, packetsLost = 0, bytesSent = 0;
      stats.forEach(r => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
          rtt = Math.round(r.currentRoundTripTime * 1000);
        }
        if (r.type === 'outbound-rtp') bytesSent += (r.bytesSent || 0);
        if (r.type === 'inbound-rtp') packetsLost += (r.packetsLost || 0);
      });

      const now = Date.now();
      let kbps = 0;
      if (this._prevStats) {
        const dt = (now - this._prevStats.time) / 1000;
        kbps = dt > 0 ? Math.round((bytesSent - this._prevStats.bytesSent) * 8 / dt / 1000) : 0;
      }
      this._prevStats = { time: now, bytesSent };

      // 品質判定
      let qualColor = '#16a34a', qualLabel = '良好';
      if (rtt && rtt > 200 || packetsLost > 10) { qualColor = '#dc2626'; qualLabel = '不良'; }
      else if (rtt && rtt > 100 || packetsLost > 2) { qualColor = '#d97706'; qualLabel = '不安定'; }

      const statsEl = document.getElementById('webrtc-net-stats');
      const indEl = document.getElementById('webrtc-quality-indicator');
      if (statsEl) {
        const parts = [];
        if (rtt != null) parts.push(`遅延 ${rtt}ms`);
        if (kbps > 0) parts.push(`${kbps}kbps`);
        if (packetsLost > 0) parts.push(`損失 ${packetsLost}pkt`);
        statsEl.textContent = parts.join(' | ') || '測定中...';
      }
      if (indEl) { indEl.textContent = '● ' + qualLabel; indEl.style.color = qualColor; }
    } catch(e) { /* stats取得失敗は無視 */ }
  },

  // ── ビットレート制限を全ビデオSenderに適用 ──
  async _applyBitrateToAll() {
    if (!this.peerConnection) return;
    const preset = this.VIDEO_QUALITY_PRESETS[this._videoQualityPreset];
    const sender = this.peerConnection.getSenders().find(s => s.track?.kind === 'video');
    if (sender) await this._applyBitrateConstraint(sender, preset.maxBitrateBps);
  },

  async _applyBitrateConstraint(sender, maxBitrateBps) {
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings.forEach(e => { e.maxBitrate = maxBitrateBps; });
      await sender.setParameters(params);
    } catch(e) { console.warn('[WebRTC] setParameters:', e); }
  },

  // ── 画質を1段階下げる ──
  // プリセットの保存(_videoQualityPreset/localStorage)は、実際にメディアの
  // 切り替えが成功した後にのみ行う。先に保存してしまうと、途中で失敗しても
  // 設定・UIだけ変更後の画質を騙り、実際の映像は変わっていない状態になる
  async lowerVideoQuality() {
    const order = ['high', 'medium', 'low'];
    const oldPreset = this._videoQualityPreset;
    const idx = order.indexOf(oldPreset);
    if (idx >= order.length - 1) { UI.toast('すでに最低画質です', 'info'); return; }
    const newPresetKey = order[idx + 1];
    const preset = this.VIDEO_QUALITY_PRESETS[newPresetKey];
    const names = { low: '低画質(320×240)', medium: '標準(640×480)', high: '高画質(1280×720)' };

    if (!this.peerConnection || !this.localStream) {
      // 通話中でなければ切り替える実体が無いため、設定値のみ更新して終える
      this._videoQualityPreset = newPresetKey;
      localStorage.setItem('tbs_video_quality', newPresetKey);
      this._onVideoQualityChanged(newPresetKey, names);
      return;
    }

    const sender = this.peerConnection.getSenders().find(s => s.track?.kind === 'video');
    const existingTrack = this.localStream.getVideoTracks()[0];
    let newStream = null;
    try {
      // まず既存トラックへのapplyConstraints()で済ませられないか試す。
      // カメラの再取得(getUserMedia)を避けられれば、機種によっては起きる
      // 映像の一瞬の途切れやカメラの再初期化を避けられる
      if (sender && existingTrack && typeof existingTrack.applyConstraints === 'function') {
        try {
          await existingTrack.applyConstraints({
            width: { ideal: preset.width },
            height: { ideal: preset.height },
            frameRate: { ideal: preset.frameRate },
          });
          await this._applyBitrateConstraint(sender, preset.maxBitrateBps);
          this._videoQualityPreset = newPresetKey;
          localStorage.setItem('tbs_video_quality', newPresetKey);
          this._onVideoQualityChanged(newPresetKey, names);
          return;
        } catch (constraintErr) {
          console.warn('[WebRTC] applyConstraints失敗、カメラを再取得します:', constraintErr);
          // ここでは中断せず、下のgetUserMedia再取得へフォールバックする
        }
      }

      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: preset.width }, height: { ideal: preset.height },
          frameRate: { ideal: preset.frameRate },
          ...(this._selectedVideoInput ? { deviceId: { exact: this._selectedVideoInput } } : {}) }
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!sender || !newTrack) {
        throw new Error(sender ? '新しいビデオトラックを取得できませんでした' : '既存の映像senderが見つかりませんでした');
      }
      await sender.replaceTrack(newTrack);
      await this._applyBitrateConstraint(sender, preset.maxBitrateBps);
      const oldVideoTracks = this.localStream.getVideoTracks();
      // localStreamを新トラックで更新し、通話終了時のcleanupCall()が新トラックも
      // 停止できるようにする(そのままだとカメラが解放されず動作し続ける)
      this.localStream = new MediaStream([newTrack, ...this.localStream.getAudioTracks()]);
      const localVideo = document.getElementById('webrtc-local-video');
      if (localVideo) localVideo.srcObject = this.localStream;
      oldVideoTracks.forEach(t => t.stop());

      this._videoQualityPreset = newPresetKey;
      localStorage.setItem('tbs_video_quality', newPresetKey);
      this._onVideoQualityChanged(newPresetKey, names);
    } catch (e) {
      console.error('[WebRTC] lowerQuality:', e);
      // 置き換えに使われなかった(または失敗した)新規取得トラックを停止しないと
      // 使われないままカメラを掴み続けてしまう
      if (newStream) newStream.getTracks().forEach(t => t.stop());
      // プリセット・localStorageはまだ変更していないため(成功時にのみ更新する
      // 方式にした)、_videoQualityPresetは元のままで一致している。設定と
      // 実際の映像が食い違ったまま「成功」を騙らないよう、失敗を明示する
      UI.toast('画質の変更に失敗しました。元の設定のままです', 'warning');
    }
  },

  _onVideoQualityChanged(newPresetKey, names) {
    UI.toast(`画質を「${names[newPresetKey]}」に変更しました`, 'info');
    const btn = document.getElementById('webrtc-btn-lower-quality');
    if (btn) {
      btn.innerHTML = `<i class="fas fa-compress-arrows-alt"></i> ${names[newPresetKey]}`;
      if (newPresetKey === 'low') btn.disabled = true;
    }
  },

  showCallingDialog(targetId) {
    const targetName = this.getNameById(targetId);
    const targetNameHtml = UI.escapeHTML(targetName);
    const old = document.getElementById('webrtc-call-overlay');
    if (old) old.remove();

    const phoneNum = this.resolveCallTarget(targetId)?.record.phone || '';
    const phoneNumHtml = UI.escapeHTML(phoneNum || '');

    const overlay = document.createElement('div');
    overlay.id = 'webrtc-call-overlay';
    overlay.className = 'phone-dialog-overlay';
    overlay.innerHTML = `
      <div class="phone-dialog" role="dialog" style="border-color: #3b82f6; width: 360px; max-width: 90%;">
        <div class="phone-dialog-header" style="background: #3b82f6; color: white;">
          <i class="fas fa-phone"></i>
          <span>通話発信中</span>
        </div>
        <div class="phone-dialog-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
          <!-- 相手情報・ステータス -->
          <div style="text-align: center;">
            <div style="font-size: 20px; font-weight: bold; color: #1e293b;" id="webrtc-call-target-name">${targetNameHtml}</div>
            ${phoneNum ? `<div style="font-size: 11px; color: #64748b; margin-top: 2px;">(内線番号: ${phoneNumHtml})</div>` : ''}
            <div id="webrtc-call-status-label" style="color: #3b82f6; font-size: 13px; font-weight: bold; margin-top: 6px; animation: pulse 1.5s infinite;">
              <i class="fas fa-phone-volume"></i> 呼び出し中...
            </div>
          </div>
          
        </div>
        <div class="phone-dialog-footer" style="display: flex; gap: 12px; justify-content: center; padding: 8px 16px; background: #f8fafc; border-top: 1px solid #e2e8f0;">
          <button class="btn btn-danger" id="webrtc-btn-hangup" style="flex: 1; padding: 8px; font-weight: bold;">
            <i class="fas fa-phone-slash"></i> キャンセル
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('webrtc-btn-hangup').onclick = () => this.hangupCall();

  },

  showConnectedDialog(targetId) {
    const targetName = this.getNameById(targetId);
    const targetNameHtml = UI.escapeHTML(targetName);
    const old = document.getElementById('webrtc-call-overlay');
    if (old) old.remove();

    const isVideo = this.isVideoCall;

    const overlay = document.createElement('div');
    overlay.id = 'webrtc-call-overlay';
    overlay.className = 'phone-dialog-overlay';
    
    let videoHtml = '';
    if (isVideo) {
      videoHtml = `
        <div id="webrtc-video-container" style="position: relative; width: 100%; height: 260px; background: #0f172a; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; border: 1px solid #334155;">
          <!-- リモート映像 -->
          <video id="webrtc-remote-video" autoplay playsinline style="width: 100%; height: 100%; object-fit: cover;"></video>
          <!-- ローカル映像 (右上重ね合わせ) -->
          <video id="webrtc-local-video" autoplay playsinline muted style="position: absolute; top: 10px; right: 10px; width: 110px; height: 82px; object-fit: cover; border: 2px solid white; border-radius: 6px; background: #1e293b; box-shadow: var(--shadow-md); z-index: 5;"></video>
          <!-- 全画面ボタン -->
          <button type="button" id="webrtc-btn-fullscreen" title="全画面表示" aria-label="全画面表示" style="position:absolute; bottom:8px; right:8px; background:rgba(0,0,0,0.5); border:none; color:white; width:32px; height:32px; border-radius:6px; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center; z-index:10;">
            <i class="fas fa-expand"></i>
          </button>
        </div>
      `;
    }

    overlay.innerHTML = `
      <div class="phone-dialog" role="dialog" style="border-color: #16a34a; width: ${isVideo ? '520px' : '360px'}; max-width: 95%;">
        <div class="phone-dialog-header" style="background: #16a34a; color: white;">
          <i class="fas ${isVideo ? 'fa-video' : 'fa-phone-alt'}"></i>
          <span>${isVideo ? 'ビデオ通話中' : '通話中'}</span>
        </div>
        <div class="phone-dialog-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
          <!-- ビデオフィード -->
          ${videoHtml}

          <!-- 相手情報・ステータス -->
          <div style="text-align: center;">
            <div style="font-size: 18px; font-weight: bold; color: #1e293b;" id="webrtc-call-target-name">${targetNameHtml}</div>
            <div id="webrtc-call-status-label" style="font-size: 11px; font-weight: bold; color: #16a34a; margin-top: 2px;">通話中</div>
            <div id="webrtc-call-duration" style="font-size: 20px; color: #16a34a; font-weight: 800; font-family: monospace; margin-top: 2px;">00:00</div>
          </div>

          <!-- 通話品質・統計バー -->
          <div id="webrtc-stats-bar" style="display:flex;align-items:center;gap:8px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:5px 10px;font-size:11px;">
            <span id="webrtc-quality-indicator" style="font-weight:700;color:#16a34a;">● 良好</span>
            <span id="webrtc-net-stats" style="color:#64748b;flex:1;">統計情報取得中...</span>
            ${isVideo ? `<button id="webrtc-btn-lower-quality" class="btn btn-outline btn-sm" style="padding:3px 8px;font-size:10px;white-space:nowrap;">
              <i class="fas fa-compress-arrows-alt"></i> 画質を下げる
            </button>` : ''}
          </div>
          
        </div>
        <div class="phone-dialog-footer" style="display: flex; gap: 12px; justify-content: center; padding: 8px 16px; background: #f8fafc; border-top: 1px solid #e2e8f0;">
          <button class="btn btn-outline" id="webrtc-btn-mute" style="flex: 1; padding: 8px; font-weight: bold;">
            <i class="fas fa-microphone"></i> ミュート
          </button>
          <button class="btn btn-danger" id="webrtc-btn-hangup" style="flex: 1; padding: 8px; font-weight: bold;">
            <i class="fas fa-phone-slash"></i> 通話を終了
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('webrtc-btn-hangup').onclick = () => this.hangupCall();

    // 自分のマイクを一時的にミュート/解除する（通話を切らずに音声だけ止める）
    const muteBtn = document.getElementById('webrtc-btn-mute');
    if (muteBtn) {
      muteBtn.onclick = () => {
        const audioTracks = this.localStream ? this.localStream.getAudioTracks() : [];
        if (!audioTracks.length) return;
        const shouldMute = audioTracks.some(t => t.enabled);
        audioTracks.forEach(t => { t.enabled = !shouldMute; });
        muteBtn.innerHTML = shouldMute
          ? '<i class="fas fa-microphone-slash"></i> ミュート解除'
          : '<i class="fas fa-microphone"></i> ミュート';
        muteBtn.classList.toggle('btn-danger', shouldMute);
        muteBtn.classList.toggle('btn-outline', !shouldMute);
      };
    }

    // 画質を下げるボタン
    const lqBtn = document.getElementById('webrtc-btn-lower-quality');
    if (lqBtn) {
      const names = { low: '低画質(320×240)', medium: '標準(640×480)', high: '高画質(1280×720)' };
      if (this._videoQualityPreset === 'low') lqBtn.disabled = true;
      lqBtn.onclick = () => this.lowerVideoQuality();
    }

    // ローカルストリームをローカルビデオ要素にアタッチする（ビデオ通話時）
    if (isVideo && this.localStream) {
      setTimeout(() => {
        const localVideo = document.getElementById('webrtc-local-video');
        if (localVideo) localVideo.srcObject = this.localStream;
      }, 50);
    }

    // 全画面ボタン。HTML要素のFullscreen APIではなく、IPC経由でElectronの
    // BrowserWindow.setFullScreen()を明示的に呼び出す(main.jsの'set-fullscreen')
    const fsBtn = document.getElementById('webrtc-btn-fullscreen');
    if (fsBtn) {
      const updateFullscreenButton = () => {
        const active = this._isFullscreen;
        fsBtn.innerHTML = `<i class="fas ${active ? 'fa-compress' : 'fa-expand'}"></i>`;
        fsBtn.title = active ? '全画面表示を終了' : '全画面表示';
        if (typeof fsBtn.setAttribute === 'function') fsBtn.setAttribute('aria-label', fsBtn.title);
      };

      const applyFullscreen = async wantFullscreen => {
        if (!window.electronAPI?.setFullscreen) {
          UI.toast('この環境では全画面表示に対応していません', 'warning');
          return;
        }
        try {
          const result = await window.electronAPI.setFullscreen(wantFullscreen);
          this._isFullscreen = !!result;
          this._fullscreenEnteredForCall = this._isFullscreen && wantFullscreen;
          updateFullscreenButton();
        } catch (error) {
          console.warn('[Fullscreen] ビデオ通話の全画面切替に失敗しました:', error);
          UI.toast('全画面表示に切り替えられませんでした', 'warning');
        }
      };

      fsBtn.onclick = event => {
        event.preventDefault();
        applyFullscreen(!this._isFullscreen);
      };

      // 通話ごとに古い購読・リスナーを外してから登録する(通話を重ねるたびに
      // 溜まり続けないよう、cleanupCall()でも明示的に解除する)
      if (this._unsubscribeFullscreenChanged) {
        this._unsubscribeFullscreenChanged();
        this._unsubscribeFullscreenChanged = null;
      }
      if (window.electronAPI?.onFullscreenChanged) {
        // F11キー・OS操作等、このボタン以外で状態が変わった場合もElectron側からの
        // 通知で追従する
        this._unsubscribeFullscreenChanged = window.electronAPI.onFullscreenChanged(isFullscreen => {
          this._isFullscreen = !!isFullscreen;
          if (!this._isFullscreen) this._fullscreenEnteredForCall = false;
          updateFullscreenButton();
        });
      }

      // Escapeキーで全画面表示を解除する(HTML Fullscreen APIが標準で持っていた
      // Escape解除の挙動を、ウィンドウ全体のフルスクリーンに対して明示的に再現する)
      if (this._fullscreenEscapeHandler) {
        document.removeEventListener('keydown', this._fullscreenEscapeHandler);
      }
      this._fullscreenEscapeHandler = e => {
        if (e.key === 'Escape' && this._isFullscreen) applyFullscreen(false);
      };
      document.addEventListener('keydown', this._fullscreenEscapeHandler);

      // ダイアログを開いた時点の実際のウィンドウ状態を取得する(通話開始前から
      // 既に全画面だった場合を含め、通知のpushだけに頼らず初期表示を正しく合わせる)
      if (window.electronAPI?.isFullscreen) {
        window.electronAPI.isFullscreen().then(isFS => {
          this._isFullscreen = !!isFS;
          updateFullscreenButton();
        }).catch(() => {});
      }
      updateFullscreenButton();
    }

  },

  async hangupCall() {
    if (this.targetId) {
      await API.webrtcSend({
        from: this._getCallFromId(),
        to: this.targetId,
        type: 'hangup'
      });
    }
    this.cleanupCall('通話を終了しました');
  },

  async cleanupCall(message = '') {
    this.stopRingTone();
    this.stopCallTimer();
    this._stopStatsPolling();

    // 無応答タイムアウト（発信側・着信側）: 通話が別の経路(hangup/busy/エラー等)で
    // 終了した後にタイマーが残っていると、後で別の通話を開始した際に誤って
    // その新しい通話を終了させてしまうため、終了経路によらずここで必ず解除する
    if (this._ringTimeoutId) { clearTimeout(this._ringTimeoutId); this._ringTimeoutId = null; }
    if (this._incomingRingTimeoutId) { clearTimeout(this._incomingRingTimeoutId); this._incomingRingTimeoutId = null; }

    if (this._fullscreenEscapeHandler) {
      document.removeEventListener('keydown', this._fullscreenEscapeHandler);
      this._fullscreenEscapeHandler = null;
    }
    if (this._unsubscribeFullscreenChanged) {
      this._unsubscribeFullscreenChanged();
      this._unsubscribeFullscreenChanged = null;
    }
    // 通話が原因で全画面表示に入っていた場合のみ、通話終了とあわせて解除する
    // (通話開始前から全体をフルスクリーン表示していた場合は解除しない)
    if (this._fullscreenEnteredForCall) {
      this._fullscreenEnteredForCall = false;
      window.electronAPI?.setFullscreen?.(false).then(result => {
        this._isFullscreen = !!result;
      }).catch(() => {});
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch (e){}
      this.peerConnection = null;
    }

    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }

    this._pendingIceCandidates = [];

    // 状態フラグはDB書き込み(await)より前に確実にクリアする。子機で親機が
    // 不達だと下のAPI.patchは最大8秒のタイムアウトまで待つため、awaitの後に
    // フラグを倒す実装だと「通話を終了」を押してから最大8秒間、新規の発信も
    // 着信もできなくなる（isConnected/isCallingが真のままのため）
    this.isCalling = false;
    this.isConnected = false;
    this._isRinging = false;
    this._updateCallFabState();
    this.targetId = null;
    this._callSourceId = null;

    // 通話終了をDBに反映（currentCallIdは退避してから即座にクリアし、
    // cleanupCallが二重に走ってもPATCHが二重発行されないようにする）
    const endedCallId = this.currentCallId;
    this.currentCallId = null;
    if (endedCallId) {
      try {
        await API.patch('calls', endedCallId, {
          status: 'ended',
          ended_at: Date.now()
        });
      } catch (e) {}
    }

    const overlay = document.getElementById('webrtc-call-overlay');
    if (overlay) {
      if (message) {
        const body = overlay.querySelector('.phone-dialog-body');
        if (body) {
          body.replaceChildren();
          const errorMessage = document.createElement('div');
          errorMessage.style.cssText = 'color:#dc2626;font-weight:bold;font-size:15px;padding:10px 0';
          errorMessage.textContent = String(message);
          body.appendChild(errorMessage);
        }
        const footer = overlay.querySelector('.phone-dialog-footer');
        if (footer) footer.style.display = 'none';
        setTimeout(() => overlay.remove(), 1500);
      } else {
        overlay.remove();
      }
    }

    // 通話履歴リロード
    if (typeof History !== 'undefined' && History._loadCalls) {
      History._loadCalls();
    }
  },

  // ── タイマー ──
  startCallTimer() {
    this.stopCallTimer();
    this.callDuration = 0;
    const update = () => {
      const el = document.getElementById('webrtc-call-duration');
      if (el) {
        const m = Math.floor(this.callDuration / 60).toString().padStart(2, '0');
        const s = (this.callDuration % 60).toString().padStart(2, '0');
        el.textContent = `${m}:${s}`;
      }
    };
    this.callTimer = setInterval(() => {
      this.callDuration++;
      update();
    }, 1000);
  },

  stopCallTimer() {
    if (this.callTimer) {
      clearInterval(this.callTimer);
      this.callTimer = null;
    }
  },

  // ── 音響効果 (Web Audio API) ──
  playRingBackTone() {
    this.stopRingTone();
    // 着信音(playIncomingRingTone)と同じく、通知ミュート時間帯・音量設定を尊重する。
    // 従来はここだけ設定を無視して常に固定音量で鳴っていたため、夜間ミュート中に
    // 発信すると着信側は無音なのに発信側だけ呼出音が鳴る非対称な挙動になっていた
    if (UI._isNotifMuted()) return;
    const volume = UI._getNotifVolume();
    if (volume <= 0) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new AudioCtx();

      let isPlaying = false;
      const play = () => {
        if (!this._audioCtx) return;
        isPlaying = true;

        const osc = this._audioCtx.createOscillator();
        const gain = this._audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(400, this._audioCtx.currentTime); // 400Hz 呼出音

        gain.gain.setValueAtTime(0, this._audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.1 * volume, this._audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.1 * volume, this._audioCtx.currentTime + 1.0);
        gain.gain.linearRampToValueAtTime(0, this._audioCtx.currentTime + 1.1);

        osc.connect(gain);
        gain.connect(this._audioCtx.destination);
        osc.start();
        osc.stop(this._audioCtx.currentTime + 1.2);

        setTimeout(() => { isPlaying = false; }, 3000);
      };

      play();
      this._ringTimer = setInterval(play, 3000);
    } catch(e) {
      console.warn('[Call] RingBack error:', e);
    }
  },

  playIncomingRingTone({ sound = null, ignoreMute = false } = {}) {
    this.stopRingTone();
    if (!ignoreMute && UI._isNotifMuted()) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new AudioCtx();
      const localRingSound = UI._localOverrideOrNull('tbs_incoming_ring_sound');
      const ringSetting = AppState.systemSettings?.find(s => s.id === 'incoming_ring_sound');
      const ringSound = sound || localRingSound || ringSetting?.value || 'ring';
      const volume = UI._getNotifVolume();
      if (volume <= 0) {
        this.stopRingTone();
        return;
      }
      
      let isPlaying = false;
      const play = () => {
        if (!this._audioCtx) return;
        isPlaying = true;
        
        const osc1 = this._audioCtx.createOscillator();
        const osc2 = this._audioCtx.createOscillator();
        const gain = this._audioCtx.createGain();
        
        const RING_FREQS = {
          ring:         [600, 750],
          alarm:        [880, 660, 'sawtooth', 'square'],
          urgent:       [1320, 1100, 'sawtooth', 'sawtooth'],
          chime:        [523.25, 783.99],
          'double-chime': [880, 1108.73],
          fanfare:      [523.25, 1046.50],
          ding:         [1046.50, 1318.51],
          beep:         [1200, 1400, 'square', 'square'],
          soft:         [349.23, 523.25],
        };
        const rf = RING_FREQS[ringSound] || RING_FREQS.ring;
        osc1.type = rf[2] || 'sine';
        osc1.frequency.setValueAtTime(rf[0], this._audioCtx.currentTime);
        osc2.type = rf[3] || 'sine';
        osc2.frequency.setValueAtTime(rf[1], this._audioCtx.currentTime);
        
        const master = this._audioCtx.createGain();
        master.gain.setValueAtTime(volume, this._audioCtx.currentTime);
        master.connect(this._audioCtx.destination);

        gain.gain.setValueAtTime(0, this._audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.15, this._audioCtx.currentTime + 0.05);
        gain.gain.setValueAtTime(0.15, this._audioCtx.currentTime + 0.7);
        gain.gain.linearRampToValueAtTime(0, this._audioCtx.currentTime + 0.8);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(master);
        
        osc1.start();
        osc2.start();
        osc1.stop(this._audioCtx.currentTime + 0.9);
        osc2.stop(this._audioCtx.currentTime + 0.9);
        
        setTimeout(() => { isPlaying = false; }, 2000);
      };
      
      play();
      this._ringTimer = setInterval(play, 2000);
    } catch(e) {
      console.warn('[Call] Ring error:', e);
    }
  },

  stopRingTone() {
    if (this._ringTimer) {
      clearInterval(this._ringTimer);
      this._ringTimer = null;
    }
    if (this._audioCtx) {
      try {
        this._audioCtx.close();
      } catch(e){}
      this._audioCtx = null;
    }
  },

  // ── 音声合成（TTS / SpeechSynthesis）再生機能 ──
  playAnnouncement(text, fromId, { automatic = false } = {}) {
    const fromName = this.getNameById(fromId);
    const annObj = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      text: text,
      fromId: fromId,
      fromName: fromName,
      timestamp: Date.now(),
      automatic,
    };

    // 履歴は送信側がchat_messagesへ記録済みなので、ここでは保持しない。
    // 送信元と会話を開いていれば、ポーリングを待たずに反映する
    this._refreshChatIfPeer(fromId);

    // 画面にトースト表示
    UI.toast(`【音声通知】${fromName}: "${text}"`, 'info');

    // 自動アナウンスは端末ごとに停止できる。履歴とトーストは残す。
    if ((automatic && !UI._isAutomaticSpeechEnabled()) || UI._isNotifMuted()) return;

    // キューに追加
    this.announcementQueue.push(annObj);

    // 再生プロセスが動いていなければ開始
    if (!this.isSpeakingAnnouncement) {
      this.processNextAnnouncement();
    }
  },

  processNextAnnouncement() {
    if (this.announcementQueue.length === 0) {
      this.isSpeakingAnnouncement = false;
      return;
    }

    this.isSpeakingAnnouncement = true;
    const item = this.announcementQueue.shift();
    const volume = UI._getNotifVolume();
    if (
      volume <= 0 ||
      UI._isNotifMuted() ||
      (item.automatic && !UI._isAutomaticSpeechEnabled())
    ) {
      this.isSpeakingAnnouncement = false;
      setTimeout(() => this.processNextAnnouncement(), 0);
      return;
    }

    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(item.text);
      utterance.lang = 'ja-JP';
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = volume;

      // 発話終了およびエラー時のイベントハンドラを設定してキューを回す
      utterance.onend = () => {
        setTimeout(() => {
          this.processNextAnnouncement();
        }, 600); // 発話間に0.6秒の間隔を空ける
      };
      utterance.onerror = (e) => {
        console.error('[SpeechSynthesis Error]', e);
        setTimeout(() => {
          this.processNextAnnouncement();
        }, 600);
      };

      // チャイム（ピンポンパンポーン）の後に喋る
      this.playChimeBeforeSpeech(() => {
        if (
          UI._getNotifVolume() <= 0 ||
          UI._isNotifMuted() ||
          (item.automatic && !UI._isAutomaticSpeechEnabled())
        ) {
          this.isSpeakingAnnouncement = false;
          setTimeout(() => this.processNextAnnouncement(), 0);
          return;
        }
        window.speechSynthesis.speak(utterance);
      });
    } else {
      console.warn('SpeechSynthesis is not supported in this browser.');
      // 音声合成が非対応の場合も、チャイム音だけ鳴らして次のキューへ進む
      this.playChimeBeforeSpeech(() => {
        setTimeout(() => {
          this.processNextAnnouncement();
        }, 1000);
      });
    }
  },

  // 簡易2和音チャイム（ピンポンパンポーン）
  playChimeBeforeSpeech(callback) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const volume = UI._getNotifVolume();
      const master = ctx.createGain();
      master.gain.setValueAtTime(volume, ctx.currentTime);
      master.connect(ctx.destination);
      
      const notes = [554.37, 440.00, 493.88, 329.63]; // C#5, A4, B4, E4
      let time = ctx.currentTime;
      
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, time);
        
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.12, time + 0.05);
        gain.gain.setValueAtTime(0.12, time + 0.25);
        gain.gain.linearRampToValueAtTime(0, time + 0.4);
        
        osc.connect(gain);
        gain.connect(master);
        osc.start(time);
        osc.stop(time + 0.45);
        
        time += 0.25;
      });
      
      setTimeout(() => {
        try { ctx.close(); } catch(e){}
        callback();
      }, 1200);
    } catch(e) {
      console.warn('Chime audio error:', e);
      callback();
    }
  },

};

// ── 病棟電話ダイアログの代替（WebRTC通話開始へバイパス）──
const PhoneDialog = {
  showWardPhone(ward) {
    if (ward) {
      CallPanel.showCallSelectionDialog(ward.id, { fromId: CallPanel.getMyId() });
    } else {
      UI.toast('病棟情報を取得できませんでした', 'warning');
    }
  }
};
