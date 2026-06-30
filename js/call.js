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

  // 再接続タイマー & チャット履歴
  reconnectTimeout: null,
  chatMessages: [], // { senderType, name, text, timestamp }

  // ビデオ品質・統計・デバイス選択
  _videoQualityPreset: localStorage.getItem('tbs_video_quality') || 'medium',
  _statsInterval: null,
  _prevStats: null,
  _selectedAudioInput: null,
  _selectedVideoInput: null,

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
      <button class="call-room-btn" data-room-id="${r.id}">
        <span class="call-room-name">${r.name}</span>
        <span class="call-room-phone">${r.phone ? '内線 ' + r.phone : '番号未設定'}</span>
      </button>
    `).join('');

    body.innerHTML = `
      <div class="call-section-title"><i class="fas fa-phone-alt"></i> 検査室へ発信 (WebRTC / アナウンス)</div>
      <div class="call-room-list">${roomBtns || '<div class="text-muted text-sm">検査室データ読込中...</div>'}</div>
      <div class="divider"></div>
      <div class="call-history-title"><i class="fas fa-history"></i> 最近の通話履歴</div>
      <div id="call-history-mini" style="margin-bottom: 8px;"></div>
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
        const room = AppState.getExamRoomById(btn.dataset.roomId);
        if (room) {
          this.showCallSelectionDialog(room.id);
        }
      });
    });

    this._loadRecentCalls();
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
          <span class="text-muted" style="font-size:9.5px;">${UI.formatTime(a.timestamp)}</span>
        </div>
        <div style="color:#475569; padding-left:14px; word-break:break-all; line-height:1.2; font-style:italic;">"${UI.escapeHTML(a.text)}"</div>
      </div>
    `).join('');
  },

  // ── 最近の発信・通話履歴 ──
  async _loadRecentCalls() {
    const el = document.getElementById('call-history-mini');
    if (!el) return;
    try {
      const calls = await API.getCallHistory();
      if (calls.length === 0) {
        el.innerHTML = '<div style="font-size:11px;color:#94a3b8;padding:4px 0;">通話履歴なし</div>';
        return;
      }
      el.innerHTML = calls.slice(0, 6).map(c => {
        const room = AppState.getExamRoomById(c.exam_room_id);
        const iconColor = c.status === 'missed' ? '#dc2626' : '#16a34a';
        return `
          <div class="call-entry">
            <span><i class="fas fa-phone-alt" style="color:${iconColor};font-size:10px;"></i> ${room ? room.name : '検査室'}</span>
            <span class="text-muted">${UI.formatTime(c.started_at)}</span>
          </div>`;
      }).join('');
    } catch (e) {
      el.innerHTML = '';
    }
  },

  // ── 病棟側から呼び出す（検査室画面用）──
  callFromEvent(eventId) {
    const ev = AppState.activeEvents.find(e => e.id === eventId);
    if (!ev) return;
    const room = AppState.getExamRoomById(ev.exam_room_id);
    if (room) {
      this.showCallSelectionDialog(room.id);
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

  getNameById(id) {
    if (id.startsWith('ward-')) {
      const w = AppState.wards.find(x => x.id === id);
      return w ? w.name : '病棟';
    }
    const room = AppState.getExamRoomById(id);
    return room ? room.name : '検査室';
  },

  startListening() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      // WebRTC設定の取得
      const webrtcSetting = AppState.systemSettings?.find(s => s.id === 'enable_webrtc_call');
      if (webrtcSetting && webrtcSetting.value === 'false') {
        return; // WebRTC通話が無効の場合はポーリングを行わない
      }

      const myId = this.getMyId();
      if (!myId) return;

      try {
        const res = await API.webrtcPoll(myId);
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
      } catch (e) {
        console.error('[WebRTC Poll Error]', e);
      }
    }, 1500);
  },

  async handleSignalingMessage(msg) {
    console.log('[WebRTC Signaling] Received:', msg.type, 'from:', msg.from);

    if (msg.type === 'offer') {
      if (this.peerConnection || this.isCalling || this.isConnected) {
        // 話し中の場合は拒否シグナル
        await API.webrtcSend({
          from: this.getMyId(),
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
      if (this.peerConnection) {
        try {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          this.setConnectedState();
        } catch (e) {
          console.error('[WebRTC] setRemoteDescription Answer error:', e);
        }
      }
    } 
    else if (msg.type === 'ice') {
      if (this.peerConnection && msg.candidate) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (e) {
          console.error('[WebRTC] addIceCandidate error:', e);
        }
      }
    } 
    else if (msg.type === 'hangup') {
      this.cleanupCall('相手が切断しました');
    }
    else if (msg.type === 'busy') {
      this.cleanupCall('話し中、または応答がありません');
    }
    else if (msg.type === 'answered') {
      // 同じIDを持つ別端末が応答した → ダイアログを静かに閉じる
      if (!this.isConnected && !this.isCalling) {
        this.stopRingTone();
        const overlay = document.getElementById('webrtc-call-overlay');
        if (overlay) overlay.remove();
      }
    }
    else if (msg.type === 'speech') {
      this.playAnnouncement(msg.text, msg.from);
    }
    else if (msg.type === 'chat') {
      this.appendChatMessage('remote', msg.text);
    }
  },

  // ── コール選択ダイアログ (音声通話 or 定型アナウンス) ──
  showCallSelectionDialog(targetId) {
    const targetName = this.getNameById(targetId);
    
    const old = document.getElementById('webrtc-call-overlay');
    if (old) old.remove();

    const room = targetId.startsWith('ward-') ? null : AppState.getExamRoomById(targetId);
    const ward = targetId.startsWith('ward-') ? AppState.wards.find(x => x.id === targetId) : null;
    const phoneNum = room ? room.phone : (ward ? ward.phone : '');

    // 定型文リストの構築 (データベースから動的に取得)
    const myName = this.getNameById(this.getMyId());
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
            <span>音声通話を開始 (WebRTC)</span>
          </button>
          <!-- ビデオ通話を開始するボタン -->
          <button class="btn btn-primary" id="webrtc-btn-start-video" style="padding: 12px; font-size: 14px; font-weight: bold; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: var(--shadow-sm);">
            <i class="fas fa-video" style="font-size: 15px;"></i>
            <span>ビデオ通話を開始 (WebRTC)</span>
          </button>
    ` : `
          <!-- 無効化時の表示 -->
          <button class="btn btn-secondary" id="webrtc-btn-start-voice" disabled style="padding: 12px; font-size: 13px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; opacity: 0.6; cursor: not-allowed; pointer-events: none;">
            <i class="fas fa-phone-slash" style="font-size: 16px;"></i>
            <span>通話・ビデオ機能は無効化されています</span>
          </button>
    `;

    const templateBtns = templates.map((t, idx) => `
      <button class="btn btn-sm btn-outline btn-send-announcement" data-text="${t}" style="font-size:11.5px; padding:8px 10px; text-align:left; white-space:normal; line-height:1.2; width:100%; display:flex; align-items:center; gap:6px;">
        <i class="fas fa-bullhorn" style="color:#3b82f6;"></i>
        <span>${t}</span>
      </button>
    `).join('');

    const overlay = document.createElement('div');
    overlay.id = 'webrtc-call-overlay';
    overlay.className = 'phone-dialog-overlay';
    overlay.innerHTML = `
      <div class="phone-dialog" role="dialog" style="border-color: #3b82f6; max-width: 360px;">
        <div class="phone-dialog-header" style="background: #3b82f6; color: white;">
          <i class="fas fa-phone-alt"></i>
          <span>連絡方法の選択: ${targetName}</span>
          <button class="phone-dialog-close" id="webrtc-btn-close-selection"><i class="fas fa-times"></i></button>
        </div>
        <div class="phone-dialog-body" style="padding: 16px; display:flex; flex-direction:column; gap:16px;">
          
          ${voiceBtnHtml}
 
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
            <div style="font-size: 10px; color: #64748b;">(固定電話からかける場合の内線番号)</div>
            <div style="font-size: 18px; font-weight: 800; color: #1e293b; margin-top: 2px;">内線 ${phoneNum}</div>
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
        this.startCall(targetId); // WebRTC通話を開始
      };
      const vBtn = document.getElementById('webrtc-btn-start-video');
      if (vBtn) {
        vBtn.onclick = () => {
          this.isVideoCall = true;
          overlay.remove();
          this.startCall(targetId);
        };
      }
    }
 
    // アナウンス送信共通関数
    const sendAnnounce = async (text) => {
      if (!text?.trim()) { UI.toast('テキストを入力してください', 'warning'); return; }
      try {
        await API.webrtcSend({ from: this.getMyId(), to: targetId, type: 'speech', text: text.trim() });
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

  async startCall(targetId) {
    const myId = this.getMyId();
    if (!myId) {
      UI.toast('自身のIDを特定できませんでした。検査室または病棟を選択してください。', 'danger');
      return;
    }
    if (myId === targetId) {
      UI.toast('自分自身には架電できません。', 'warning');
      return;
    }

    this.targetId = targetId;
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
      const isWardCaller = myId.startsWith('ward-');
      this.currentCallId = `call-${Date.now()}`;
      await API.create('calls', {
        id: this.currentCallId,
        caller_type: isWardCaller ? 'ward' : 'exam_room',
        exam_room_id: isWardCaller ? targetId : myId,
        ward_id: isWardCaller ? myId : targetId,
        status: 'calling',
        started_at: Date.now()
      });

    } catch (e) {
      console.error('[WebRTC] Start Call Error:', e);
      this.cleanupCall('マイクへのアクセスが拒否されたか、マイクが見つかりません');
    }
  },

  showIncomingCallDialog(callerId, offerSdp) {
    const callerName = this.getNameById(callerId);
    
    const old = document.getElementById('webrtc-call-overlay');
    if (old) old.remove();

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
          <div style="font-size: 22px; font-weight: bold; margin-bottom: 8px; color: #1e293b;">${callerName}</div>
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

    document.getElementById('webrtc-btn-accept').onclick = async () => {
      this.stopRingTone();
      // 同じIDを開いている他端末に「応答済み」を通知
      await API.webrtcSend({ from: this.getMyId(), to: this.getMyId(), type: 'answered' }).catch(() => {});
      await this.acceptCall(callerId, offerSdp);
    };

    document.getElementById('webrtc-btn-reject').onclick = async () => {
      this.stopRingTone();
      await API.webrtcSend({
        from: this.getMyId(),
        to: callerId,
        type: 'busy'
      });
      // 不応答として記録
      const isWardCaller = callerId.startsWith('ward-');
      await API.create('calls', {
        id: `call-missed-${Date.now()}`,
        caller_type: isWardCaller ? 'ward' : 'exam_room',
        exam_room_id: isWardCaller ? this.getMyId() : callerId,
        ward_id: isWardCaller ? callerId : this.getMyId(),
        status: 'missed',
        started_at: Date.now(),
        ended_at: Date.now()
      });
      this.cleanupCall('着信を拒否しました');
    };
  },

  async acceptCall(callerId, offerSdp) {
    this.isCalling = false;
    this.isConnected = true;

    this.showConnectedDialog(callerId);

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(this._getMediaConstraints());

      this.createPeerConnection();

      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });

      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offerSdp));

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      await API.webrtcSend({
        from: this.getMyId(),
        to: callerId,
        type: 'answer',
        sdp: answer
      });

      // 通話開始の記録
      const isWardCaller = callerId.startsWith('ward-');
      this.currentCallId = `call-${Date.now()}`;
      await API.create('calls', {
        id: this.currentCallId,
        caller_type: isWardCaller ? 'ward' : 'exam_room',
        exam_room_id: isWardCaller ? this.getMyId() : callerId,
        ward_id: isWardCaller ? callerId : this.getMyId(),
        status: 'connected',
        started_at: Date.now()
      });

      this.startCallTimer();

    } catch (e) {
      console.error('[WebRTC] Accept Call Error:', e);
      this.cleanupCall('マイクが見つからないか、応答処理中にエラーが発生しました');
    }
  },

  createPeerConnection() {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    this.peerConnection = new RTCPeerConnection(config);

    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate && this.targetId) {
        await API.webrtcSend({
          from: this.getMyId(),
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
          
          this.appendChatMessage('system', '⚠️ 音声接続が切断されました。再接続を試みています...');
          
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
            
            this.appendChatMessage('system', '✅ 音声接続が正常に復旧しました。');
            UI.toast('通話が再接続されました', 'success');
          }
        }
      }
    };
  },

  setConnectedState() {
    this.stopRingTone();
    this.isCalling = false;
    this.isConnected = true;
    this.showConnectedDialog(this.targetId);
    this.startCallTimer();
    this._startStatsPolling();
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
          const localVideo = document.getElementById('webrtc-local-video');
          if (localVideo) localVideo.srcObject = new MediaStream([newTrack, ...this.localStream.getAudioTracks()]);
          this.localStream.getVideoTracks().forEach(t => t.stop());
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
    const old = document.getElementById('webrtc-call-overlay');
    if (old) old.remove();

    const room = targetId.startsWith('ward-') ? null : AppState.getExamRoomById(targetId);
    const ward = targetId.startsWith('ward-') ? AppState.wards.find(x => x.id === targetId) : null;
    const phoneNum = room ? room.phone : (ward ? ward.phone : '');

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
            <div style="font-size: 20px; font-weight: bold; color: #1e293b;" id="webrtc-call-target-name">${targetName}</div>
            ${phoneNum ? `<div style="font-size: 11px; color: #64748b; margin-top: 2px;">(内線番号: ${phoneNum})</div>` : ''}
            <div id="webrtc-call-status-label" style="color: #3b82f6; font-size: 13px; font-weight: bold; margin-top: 6px; animation: pulse 1.5s infinite;">
              <i class="fas fa-phone-volume"></i> 呼び出し中...
            </div>
          </div>
          
          <!-- チャット履歴表示エリア -->
          <div style="border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc; height: 120px; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px;" id="webrtc-chat-log">
          </div>
          
          <!-- チャット入力欄 -->
          <div style="display: flex; gap: 6px;">
            <input type="text" id="webrtc-chat-input" placeholder="メッセージを入力..." style="flex: 1; padding: 6px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 12px;">
            <button class="btn btn-primary" id="webrtc-btn-send-chat" style="padding: 6px 12px; font-size: 12px; min-width: auto; height: auto;">
              <i class="fas fa-paper-plane"></i>
            </button>
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

    // チャットのバインド
    this.renderExistingChatMessages();
    this.bindChatEvents();
  },

  showConnectedDialog(targetId) {
    const targetName = this.getNameById(targetId);
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
          <button id="webrtc-btn-fullscreen" title="全画面表示" style="position:absolute; bottom:8px; right:8px; background:rgba(0,0,0,0.5); border:none; color:white; width:32px; height:32px; border-radius:6px; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center; z-index:10;">
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
            <div style="font-size: 18px; font-weight: bold; color: #1e293b;" id="webrtc-call-target-name">${targetName}</div>
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
          
          <!-- チャット履歴表示エリア -->
          <div style="border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc; height: ${isVideo ? '90px' : '120px'}; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px;" id="webrtc-chat-log">
          </div>
          
          <!-- チャット入力欄 -->
          <div style="display: flex; gap: 6px;">
            <input type="text" id="webrtc-chat-input" placeholder="メッセージを入力..." style="flex: 1; padding: 6px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 12px;">
            <button class="btn btn-primary" id="webrtc-btn-send-chat" style="padding: 6px 12px; font-size: 12px; min-width: auto; height: auto;">
              <i class="fas fa-paper-plane"></i>
            </button>
          </div>
        </div>
        <div class="phone-dialog-footer" style="display: flex; gap: 12px; justify-content: center; padding: 8px 16px; background: #f8fafc; border-top: 1px solid #e2e8f0;">
          <button class="btn btn-danger" id="webrtc-btn-hangup" style="flex: 1; padding: 8px; font-weight: bold;">
            <i class="fas fa-phone-slash"></i> 通話を終了
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('webrtc-btn-hangup').onclick = () => this.hangupCall();

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
      fsBtn.onclick = () => {
        const container = document.getElementById('webrtc-video-container');
        if (!container) return;
        if (!document.fullscreenElement) {
          container.requestFullscreen().catch(() => {});
          fsBtn.innerHTML = '<i class="fas fa-compress"></i>';
        } else {
          document.exitFullscreen().catch(() => {});
          fsBtn.innerHTML = '<i class="fas fa-expand"></i>';
        }
      };
      document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && fsBtn) {
          fsBtn.innerHTML = '<i class="fas fa-expand"></i>';
        }
      }, { once: true });
    }

    // チャットのバインド
    this.renderExistingChatMessages();
    this.bindChatEvents();
  },

  async hangupCall() {
    if (this.targetId) {
      await API.webrtcSend({
        from: this.getMyId(),
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

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.chatMessages = []; // 通話終了時にチャット履歴をクリア

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

    // 通話終了をDBに反映
    if (this.currentCallId) {
      try {
        await API.patch('calls', this.currentCallId, {
          status: 'ended',
          ended_at: Date.now()
        });
      } catch (e) {}
      this.currentCallId = null;
    }

    const overlay = document.getElementById('webrtc-call-overlay');
    if (overlay) {
      if (message) {
        const body = overlay.querySelector('.phone-dialog-body');
        if (body) {
          body.innerHTML = `<div style="color: #dc2626; font-weight: bold; font-size: 15px; padding: 10px 0;">${message}</div>`;
        }
        const footer = overlay.querySelector('.phone-dialog-footer');
        if (footer) footer.style.display = 'none';
        setTimeout(() => overlay.remove(), 1500);
      } else {
        overlay.remove();
      }
    }

    this.isCalling = false;
    this.isConnected = false;
    this.targetId = null;

    // 通話履歴リロード
    this._loadRecentCalls();
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
        gain.gain.linearRampToValueAtTime(0.1, this._audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.1, this._audioCtx.currentTime + 1.0);
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

  playIncomingRingTone() {
    this.stopRingTone();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new AudioCtx();
      const ringSetting = AppState.systemSettings?.find(s => s.id === 'incoming_ring_sound');
      const ringSound = ringSetting?.value || 'ring';
      
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
        
        const vol = UI._getNotifVolume();
        const master = this._audioCtx.createGain();
        master.gain.setValueAtTime(vol, this._audioCtx.currentTime);
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
  playAnnouncement(text, fromId) {
    const fromName = this.getNameById(fromId);
    const annObj = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      text: text,
      fromId: fromId,
      fromName: fromName,
      timestamp: Date.now()
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

    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(item.text);
      utterance.lang = 'ja-JP';
      utterance.rate = 1.0;
      utterance.pitch = 1.0;

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
        gain.connect(ctx.destination);
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

  // ── 簡易チャット関連ヘルパー関数 ──
  sendChatMessage() {
    const input = document.getElementById('webrtc-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    const myId = this.getMyId();
    if (!myId || !this.targetId) return;

    // チャットパケットをシグナリングで送信
    API.webrtcSend({
      from: myId,
      to: this.targetId,
      type: 'chat',
      text: text
    }).catch(err => {
      console.error('[WebRTC Chat] Send Error:', err);
    });

    // 自分の履歴に追加してUIに反映
    this.appendChatMessage('me', text);
    input.value = '';
  },

  appendChatMessage(senderType, text) {
    const name = senderType === 'me' ? '自分' : (senderType === 'system' ? 'システム' : this.getNameById(this.targetId));
    this.chatMessages.push({ senderType, name, text, timestamp: Date.now() });

    // UIへメッセージバブルを追加
    const log = document.getElementById('webrtc-chat-log');
    if (!log) return;

    let bubble = '';
    const eName = UI.escapeHTML(name);
    const eText = UI.escapeHTML(text);
    if (senderType === 'me') {
      bubble = `<div style="align-self: flex-end; background: #dbeafe; color: #1e40af; padding: 6px 10px; border-radius: 12px 12px 0 12px; font-size: 11px; max-width: 80%; word-break: break-all; box-shadow: 0 1px 1px rgba(0,0,0,0.05); margin-bottom: 2px;">
        <span style="font-size: 8px; opacity: 0.6; display: block; text-align: right; margin-bottom: 2px;">${eName}</span>
        ${eText}
      </div>`;
    } else if (senderType === 'remote') {
      bubble = `<div style="align-self: flex-start; background: #ffffff; border: 1px solid #e2e8f0; color: #334155; padding: 6px 10px; border-radius: 12px 12px 12px 0; font-size: 11px; max-width: 80%; word-break: break-all; box-shadow: 0 1px 1px rgba(0,0,0,0.05); margin-bottom: 2px;">
        <span style="font-size: 8px; color: #64748b; display: block; margin-bottom: 2px;">${eName}</span>
        ${eText}
      </div>`;
    } else {
      bubble = `<div style="align-self: center; font-size: 9.5px; color: #94a3b8; margin: 4px 0; background: #f1f5f9; padding: 2px 8px; border-radius: 10px;">
        ${eText}
      </div>`;
    }

    log.innerHTML += bubble;
    log.scrollTop = log.scrollHeight;
  },

  bindChatEvents() {
    const sendBtn = document.getElementById('webrtc-btn-send-chat');
    const input = document.getElementById('webrtc-chat-input');
    if (sendBtn && input) {
      sendBtn.onclick = () => this.sendChatMessage();
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.sendChatMessage();
        }
      };
    }
  },

  renderExistingChatMessages() {
    const log = document.getElementById('webrtc-chat-log');
    if (!log) return;
    log.innerHTML = '';
    this.chatMessages.forEach(msg => {
      let bubble = '';
      const eName = UI.escapeHTML(msg.name);
      const eText = UI.escapeHTML(msg.text);
      if (msg.senderType === 'me') {
        bubble = `<div style="align-self: flex-end; background: #dbeafe; color: #1e40af; padding: 6px 10px; border-radius: 12px 12px 0 12px; font-size: 11px; max-width: 80%; word-break: break-all; box-shadow: 0 1px 1px rgba(0,0,0,0.05); margin-bottom: 2px;">
          <span style="font-size: 8px; opacity: 0.6; display: block; text-align: right; margin-bottom: 2px;">${eName}</span>
          ${eText}
        </div>`;
      } else if (msg.senderType === 'remote') {
        bubble = `<div style="align-self: flex-start; background: #ffffff; border: 1px solid #e2e8f0; color: #334155; padding: 6px 10px; border-radius: 12px 12px 12px 0; font-size: 11px; max-width: 80%; word-break: break-all; box-shadow: 0 1px 1px rgba(0,0,0,0.05); margin-bottom: 2px;">
          <span style="font-size: 8px; color: #64748b; display: block; margin-bottom: 2px;">${eName}</span>
          ${eText}
        </div>`;
      } else {
        bubble = `<div style="align-self: center; font-size: 9.5px; color: #94a3b8; margin: 4px 0; background: #f1f5f9; padding: 2px 8px; border-radius: 10px;">
          ${eText}
        </div>`;
      }
      log.innerHTML += bubble;
    });
    log.scrollTop = log.scrollHeight;
  }
};

// ── 病棟電話ダイアログの代替（WebRTC通話開始へバイパス）──
const PhoneDialog = {
  showWardPhone(ward) {
    if (ward) {
      CallPanel.showCallSelectionDialog(ward.id);
    } else {
      UI.toast('病棟情報を取得できませんでした', 'warning');
    }
  }
};
