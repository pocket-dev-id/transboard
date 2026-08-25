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
  
  // アナウンス（音声通知）キュー＆履歴用メンバ
  announcementQueue: [],
  isSpeakingAnnouncement: false,
  announcementHistory: [],

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
  _fullscreenChangeHandler: null,

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
    panel.classList.toggle('hidden');
  },

  showPanel() {
    document.getElementById('call-panel').classList.remove('hidden');
  },

  hidePanel() {
    document.getElementById('call-panel').classList.add('hidden');
  },

  // ── メインパネルHTML描画 ──
  _renderCallPanel() {
    const body = document.getElementById('call-panel-body');
    if (!body) return;

    // 検査室ボタン一覧を構築
    const roomBtns = AppState.examRooms.map(r => `
      <button class="call-room-btn" data-room-id="${UI.escapeHTML(r.id)}">
        <span class="call-room-name">${UI.escapeHTML(r.name)}</span>
        <span class="call-room-phone">${r.phone ? '内線 ' + UI.escapeHTML(r.phone) : '番号未設定'}</span>
      </button>
    `).join('');

    // 病棟ボタン一覧を構築（自分自身の病棟は除外）
    const wardBtns = AppState.wards
      .filter(w => w.id !== this.getMyId())
      .map(w => `
        <button class="call-room-btn" data-ward-id="${UI.escapeHTML(w.id)}">
          <span class="call-room-name">${UI.escapeHTML(w.name)}</span>
          <span class="call-room-phone">${w.phone ? '内線 ' + UI.escapeHTML(w.phone) : '番号未設定'}</span>
        </button>
      `).join('');

    body.innerHTML = `
      <div class="call-section-title"><i class="fas fa-hospital"></i> 病棟へ発信 (通話 / アナウンス)</div>
      <div class="call-room-list">${wardBtns || '<div class="text-muted text-sm">病棟データ読込中...</div>'}</div>
      <div class="divider"></div>
      <div class="call-section-title"><i class="fas fa-phone-alt"></i> 検査室へ発信 (通話 / アナウンス)</div>
      <div class="call-room-list">${roomBtns || '<div class="text-muted text-sm">検査室データ読込中...</div>'}</div>
      <div class="divider"></div>
      <div class="call-history-title" style="display:flex; justify-content:space-between; align-items:center;">
        <span><i class="fas fa-bullhorn"></i> アナウンス受信履歴</span>
        <div style="display:flex; gap:4px;">
          <button class="btn btn-sm btn-outline" id="btn-stop-speech" style="font-size:10px; padding:2px 6px; min-width:auto; height:auto; border-color:#ef4444; color:#ef4444; font-weight:normal; border-radius:3px;">音声停止</button>
          <button class="btn btn-sm btn-outline" id="btn-clear-ann-history" style="font-size:10px; padding:2px 6px; min-width:auto; height:auto; border-color:#cbd5e0; color:#64748b; font-weight:normal; border-radius:3px;">消去</button>
        </div>
      </div>
      <div id="announcement-history-list" style="max-height:160px; overflow-y:auto; display:flex; flex-direction:column; gap:6px; margin-top:4px; padding-right:2px;">
      </div>
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

    this._renderAnnouncementHistory();
  },

  // ── アナウンス受信履歴の描画 ──
  _renderAnnouncementHistory() {
    const el = document.getElementById('announcement-history-list');
    if (!el) return;
    
    if (this.announcementHistory.length === 0) {
      el.innerHTML = '<div style="font-size:11px;color:#94a3b8;padding:4px 0;text-align:center;">アナウンス受信履歴はありません</div>';
      const clearBtn = document.getElementById('btn-clear-ann-history');
      if (clearBtn) clearBtn.style.display = 'none';
      const stopBtn = document.getElementById('btn-stop-speech');
      if (stopBtn) stopBtn.style.display = 'none';
      return;
    }

    const clearBtn = document.getElementById('btn-clear-ann-history');
    if (clearBtn) {
      clearBtn.style.display = 'inline-block';
      clearBtn.onclick = () => {
        this.announcementHistory = [];
        this._renderAnnouncementHistory();
      };
    }

    const stopBtn = document.getElementById('btn-stop-speech');
    if (stopBtn) {
      stopBtn.style.display = 'inline-block';
      stopBtn.onclick = () => {
        this.announcementQueue = [];
        this.isSpeakingAnnouncement = false;
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
        UI.toast('音声読み上げキューをクリアしました', 'warning');
      };
    }
    
    el.innerHTML = this.announcementHistory.map(a => `
      <div class="call-entry" style="font-size:11.5px; border-bottom:1px dashed #f1f5f9; padding:6px 0; display:flex; flex-direction:column; gap:2px; align-items:stretch; background:transparent;">
        <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
          <span style="font-weight:700; color:#1e293b;"><i class="fas fa-bullhorn" style="font-size:10px; color:#3b82f6; margin-right:4px;"></i>${UI.escapeHTML(a.fromName)}</span>
          <span class="text-muted" style="font-size:9.5px;">${UI.formatTimeSmart(a.timestamp)}</span>
        </div>
        <div style="color:#475569; padding-left:14px; word-break:break-all; line-height:1.2; font-style:italic;">"${UI.escapeHTML(a.text)}"</div>
      </div>
    `).join('');
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

  getClientId() {
    let id = localStorage.getItem('_device_id');
    if (!id) {
      id = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem('_device_id', id);
    }
    return id;
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
    if (!this._homeWardId && wardId) this._homeWardId = wardId;
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
      this.cleanupCall('話し中、または応答がありません');
    }
    else if (msg.type === 'answered') {
      // 同じIDを持つ別端末が応答した → ダイアログを静かに閉じる。
      // 無応答タイムアウトを解除し忘れると、この端末で後からタイマーが発火して
      // busyを送り、既に確立済みの通話を切ってしまう
      if (!this.isConnected && !this.isCalling) {
        if (this._incomingRingTimeoutId) { clearTimeout(this._incomingRingTimeoutId); this._incomingRingTimeoutId = null; }
        this._isRinging = false;
        this.stopRingTone();
        const overlay = document.getElementById('webrtc-call-overlay');
        if (overlay) overlay.remove();
      }
    }
    else if (msg.type === 'speech') {
      this.playAnnouncement(msg.text, msg.from, { automatic: msg.automatic === true });
    }
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
          <!-- 音声通話を開始するボタン -->
          <button class="btn btn-success" id="webrtc-btn-start-voice" style="padding: 12px; font-size: 14px; font-weight: bold; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: var(--shadow-sm); margin-bottom: 8px;">
            <i class="fas fa-phone-alt" style="font-size: 15px;"></i>
            <span>音声通話を開始</span>
          </button>
          <!-- ビデオ通話を開始するボタン -->
          <button class="btn btn-primary" id="webrtc-btn-start-video" style="padding: 12px; font-size: 14px; font-weight: bold; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: var(--shadow-sm);">
            <i class="fas fa-video" style="font-size: 15px;"></i>
            <span>ビデオ通話を開始</span>
          </button>
    ` : `
          <!-- 無効化時の表示 -->
          <button class="btn btn-secondary" id="webrtc-btn-start-voice" disabled style="padding: 12px; font-size: 13px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; opacity: 0.6; cursor: not-allowed; pointer-events: none;">
            <i class="fas fa-phone-slash" style="font-size: 16px;"></i>
            <span>通話・ビデオ機能は無効化されています</span>
          </button>
    `;

    const templateBtns = templates.map((t, idx) => `
      <button class="btn btn-sm btn-outline btn-send-announcement" data-text="${UI.escapeHTML(t)}" style="font-size:11.5px; padding:8px 10px; text-align:left; white-space:normal; line-height:1.2; width:100%; display:flex; align-items:center; gap:6px;">
        <i class="fas fa-bullhorn" style="color:#3b82f6;"></i>
        <span>${UI.escapeHTML(t)}</span>
      </button>
    `).join('');

    const overlay = document.createElement('div');
    overlay.id = 'webrtc-call-overlay';
    overlay.className = 'phone-dialog-overlay';
    overlay.innerHTML = `
      <div class="phone-dialog" role="dialog" style="border-color: #3b82f6; max-width: 360px;">
        <div class="phone-dialog-header" style="background: #3b82f6; color: white;">
          <i class="fas fa-phone-alt"></i>
          <span>連絡方法の選択: ${targetNameHtml}</span>
          <button class="phone-dialog-close" id="webrtc-btn-close-selection"><i class="fas fa-times"></i></button>
        </div>
        <div class="phone-dialog-body" style="padding: 16px; display:flex; flex-direction:column; gap:16px;">
          
          ${voiceBtnHtml}
          <div style="font-size:11px;color:#64748b;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:7px 9px;">
            <i class="fas fa-arrow-right"></i> 発信元: <strong>${UI.escapeHTML(sourceName)}</strong>
            ${patientName ? ` / 対象患者: <strong>${UI.escapeHTML(prefixPatientName ? patientName : '患者名は読み上げません')}</strong>` : ''}
          </div>
 
          <!-- 簡易定型アナウンスを送信するセクション -->
          <div style="border-top: 1px solid #e2e8f0; padding-top: 12px;">
            <div style="font-size: 11px; font-weight: bold; color: #475569; margin-bottom: 8px;">
              <i class="fas fa-comment-alt"></i> 呼び出さずにアナウンスを送信 (音声合成):
            </div>
            <!-- 手動入力エリア -->
            <div style="display:flex;gap:6px;margin-bottom:4px;">
              <input type="text" id="announce-custom-text" maxlength="200"
                placeholder="自由入力でアナウンスを送信..."
                style="flex:1;padding:7px 10px;border:1px solid #cbd5e0;border-radius:6px;font-size:12.5px;">
              <button class="btn btn-primary btn-sm" id="btn-send-announce-custom"
                style="white-space:nowrap;padding:6px 12px;">
                <i class="fas fa-paper-plane"></i> 送信
              </button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 6px; max-height: 160px; overflow-y: auto; padding-right: 4px;">
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
          <div style="border-top: 1px solid #e2e8f0; padding-top: 12px; text-align: center;">
            <div style="font-size: 10px; color: #64748b;">(内線電話からかける場合の内線番号)</div>
            <div style="font-size: 18px; font-weight: 800; color: #1e293b; margin-top: 2px;">内線 ${phoneNumHtml}</div>
          </div>
          ` : ''}

        </div>
        <div class="phone-dialog-footer" style="padding: 8px 16px; background: #f8fafc; border-top: 1px solid #e2e8f0;">
          <button class="btn btn-outline" id="webrtc-btn-cancel-selection" style="width: 100%;">閉じる</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
 
    // デバイスリストを非同期でポピュレート
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
      document.getElementById('webrtc-btn-start-voice').onclick = () => {
        this.isVideoCall = false;
        overlay.remove(); // 選択画面を閉じて
        this.startCall(targetId, sourceId); // WebRTC通話を開始
      };
      const vBtn = document.getElementById('webrtc-btn-start-video');
      if (vBtn) {
        vBtn.onclick = () => {
          this.isVideoCall = true;
          overlay.remove();
          this.startCall(targetId, sourceId);
        };
      }
    }
 
    // アナウンス送信共通関数
    const sendAnnounce = async (text) => {
      if (!text?.trim()) { UI.toast('テキストを入力してください', 'warning'); return; }
      if (!sourceId) { UI.toast('発信元を特定できませんでした。病棟または検査室を選択してください。', 'warning'); return; }
      const speechText = prefixPatientName ? `${patientName}さん、${text.trim()}` : text.trim();
      try {
        await API.webrtcSend({ from: sourceId, to: targetId, type: 'speech', text: speechText });
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

    // 定型アナウンスボタンイベント
    overlay.querySelectorAll('.btn-send-announcement').forEach(btn => {
      btn.addEventListener('click', () => sendAnnounce(btn.dataset.text));
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
  async lowerVideoQuality() {
    const order = ['high', 'medium', 'low'];
    const idx = order.indexOf(this._videoQualityPreset);
    if (idx >= order.length - 1) { UI.toast('すでに最低画質です', 'info'); return; }
    this._videoQualityPreset = order[idx + 1];
    localStorage.setItem('tbs_video_quality', this._videoQualityPreset);

    if (this.peerConnection && this.localStream) {
      const preset = this.VIDEO_QUALITY_PRESETS[this._videoQualityPreset];
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: { ideal: preset.width }, height: { ideal: preset.height },
            frameRate: { ideal: preset.frameRate },
            ...(this._selectedVideoInput ? { deviceId: { exact: this._selectedVideoInput } } : {}) }
        });
        const newTrack = newStream.getVideoTracks()[0];
        const sender = this.peerConnection.getSenders().find(s => s.track?.kind === 'video');
        if (sender && newTrack) {
          await sender.replaceTrack(newTrack);
          await this._applyBitrateConstraint(sender, preset.maxBitrateBps);
          const oldVideoTracks = this.localStream.getVideoTracks();
          // localStreamを新トラックで更新し、通話終了時のcleanupCall()が新トラックも
          // 停止できるようにする(そのままだとカメラが解放されず動作し続ける)
          this.localStream = new MediaStream([newTrack, ...this.localStream.getAudioTracks()]);
          const localVideo = document.getElementById('webrtc-local-video');
          if (localVideo) localVideo.srcObject = this.localStream;
          oldVideoTracks.forEach(t => t.stop());
        }
      } catch(e) { console.error('[WebRTC] lowerQuality:', e); }
    }

    const names = { low: '低画質(320×240)', medium: '標準(640×480)', high: '高画質(1280×720)' };
    UI.toast(`画質を「${names[this._videoQualityPreset]}」に変更しました`, 'info');
    const btn = document.getElementById('webrtc-btn-lower-quality');
    if (btn) {
      btn.innerHTML = `<i class="fas fa-compress-arrows-alt"></i> ${names[this._videoQualityPreset]}`;
      if (this._videoQualityPreset === 'low') btn.disabled = true;
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

    // 全画面ボタン
    const fsBtn = document.getElementById('webrtc-btn-fullscreen');
    if (fsBtn) {
      const getFullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
      const requestFullscreen = element => {
        if (element.requestFullscreen) return element.requestFullscreen();
        if (element.webkitRequestFullscreen) {
          element.webkitRequestFullscreen();
          return Promise.resolve();
        }
        return Promise.reject(new Error('Fullscreen API is not supported'));
      };
      const exitFullscreen = () => {
        if (document.exitFullscreen) return document.exitFullscreen();
        if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
          return Promise.resolve();
        }
        return Promise.reject(new Error('Fullscreen API is not supported'));
      };
      const updateFullscreenButton = () => {
        const active = !!getFullscreenElement();
        fsBtn.innerHTML = `<i class="fas ${active ? 'fa-compress' : 'fa-expand'}"></i>`;
        fsBtn.title = active ? '全画面表示を終了' : '全画面表示';
        if (typeof fsBtn.setAttribute === 'function') fsBtn.setAttribute('aria-label', fsBtn.title);
      };
      fsBtn.onclick = async event => {
        event.preventDefault();
        const container = document.getElementById('webrtc-video-container');
        if (!container) return;
        try {
          if (!getFullscreenElement()) {
            await requestFullscreen(container);
          } else {
            await exitFullscreen();
          }
          updateFullscreenButton();
        } catch (error) {
          console.warn('[Fullscreen] ビデオ通話の全画面切替に失敗しました:', error);
          updateFullscreenButton();
          UI.toast('全画面表示に切り替えられませんでした', 'warning');
        }
      };
      // 通話ごとに古いリスナーを外してから登録する。{once:true}だと通話中に一度も
      // 発火しない(全画面を使わない)場合に外れず、通話を重ねるたびにdocumentへ
      // 溜まり続けてしまうため、cleanupCall()で明示的に解除する方式にする
      if (this._fullscreenChangeHandler) {
        document.removeEventListener('fullscreenchange', this._fullscreenChangeHandler);
      }
      this._fullscreenChangeHandler = () => {
        updateFullscreenButton();
      };
      document.addEventListener('fullscreenchange', this._fullscreenChangeHandler);
      document.addEventListener('webkitfullscreenchange', this._fullscreenChangeHandler);
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

    if (this._fullscreenChangeHandler) {
      document.removeEventListener('fullscreenchange', this._fullscreenChangeHandler);
      document.removeEventListener('webkitfullscreenchange', this._fullscreenChangeHandler);
      this._fullscreenChangeHandler = null;
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
      const shareMode = localStorage.getItem('cfg_share_mode');
      const isChild = shareMode === 'client' || shareMode === 'child';
      const localRingSound = isChild ? localStorage.getItem('tbs_incoming_ring_sound') : null;
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

    // 履歴に追加 (上限50件)
    this.announcementHistory.unshift(annObj);
    if (this.announcementHistory.length > 50) {
      this.announcementHistory.pop();
    }

    // 履歴パネルの再描画
    this._renderAnnouncementHistory();

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
