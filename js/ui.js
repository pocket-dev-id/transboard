/**
 * TransBoard - UI共通ユーティリティ
 */

const UI = {

  /* ---------- 時刻フォーマット ---------- */
  formatTime(ms) {
    if (!ms) return '--:--';
    const d = new Date(ms);
    return d.getHours().toString().padStart(2, '0') + ':' +
           d.getMinutes().toString().padStart(2, '0');
  },

  formatDateTime(ms) {
    if (!ms) return '--';
    const d = new Date(ms);
    return `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')} ` +
           `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  },

  formatDuration(ms) {
    if (!ms) return '--';
    const min = Math.floor(ms / 60000);
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h > 0) return `${h}時間${m}分`;
    return `${m}分`;
  },

  // 残り時間テキスト (例: "あと12分" / "5分超過")
  formatRemaining(remainingMs) {
    if (remainingMs === null || remainingMs === undefined) return '';
    const abs = Math.abs(remainingMs);
    const min = Math.ceil(abs / 60000);
    if (remainingMs < 0) return `${min}分超過`;
    if (min === 0) return '間もなく';
    return `あと${min}分`;
  },

  remainingClass(remainingMs) {
    if (remainingMs === null || remainingMs === undefined) return '';
    if (remainingMs < 0) return 'overdue';
    if (remainingMs < CONFIG.SOON_THRESHOLD_MIN * 60 * 1000) return 'urgent';
    if (remainingMs < 30 * 60 * 1000) return 'soon';
    return '';
  },

  /* ---------- ステータスバッジ ---------- */
  // 色だけでなくアイコンでも状態を識別できる（色覚・印刷・モノクロ対応）
  statusBadge(status, { icon = true } = {}) {
    const label = CONFIG.STATUS_LABEL[status] || status;
    const iconClass = icon && CONFIG.STATUS_ICON?.[status];
    const iconHtml = iconClass ? `<i class="fas ${iconClass}" aria-hidden="true"></i> ` : '';
    return `<span class="status-badge badge-${status}">${iconHtml}${this.escapeHTML(label)}</span>`;
  },

  /* ---------- トースト通知 ---------- */
  // innerHTML を避け DOM API で構築することでXSS防止
  toast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const icons = { info: 'info-circle', success: 'check-circle', warning: 'exclamation-triangle', danger: 'bell' };
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    const icon = document.createElement('i');
    icon.className = `fas fa-${icons[type] || 'info-circle'}`;
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(icon);
    el.appendChild(document.createTextNode(' '));
    el.appendChild(text);
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 250);
    }, duration);
  },

  /* ---------- 時計 ---------- */
  startClock() {
    const el = document.getElementById('clock');
    const update = () => {
      const d = new Date();
      el.textContent = d.getHours().toString().padStart(2,'0') + ':' +
                       d.getMinutes().toString().padStart(2,'0') + ':' +
                       d.getSeconds().toString().padStart(2,'0');
    };
    update();
    setInterval(update, 1000);
  },

  /* ---------- ローディング ---------- */
  showLoading(containerId) {
    const el = document.getElementById(containerId);
    if (el) el.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  },

  showEmpty(containerId, message = 'データがありません') {
    const el = document.getElementById(containerId);
    if (!el) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';
    const icon = document.createElement('i');
    icon.className = 'fas fa-inbox';
    icon.setAttribute('aria-hidden', 'true');
    const p = document.createElement('p');
    p.textContent = message;
    wrapper.appendChild(icon);
    wrapper.appendChild(p);
    el.innerHTML = '';
    el.appendChild(wrapper);
  },

  /* ---------- タブ切り替え ---------- */
  switchPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const page = document.getElementById(`page-${pageId}`);
    if (page) page.classList.add('active');
    const btn = document.querySelector(`.tab-btn[data-page="${pageId}"]`);
    if (btn) btn.classList.add('active');

    // ページごとの初期化
    if (pageId === 'ward-dashboard') WardDashboard.render();
    if (pageId === 'exam-room') ExamRoom.render();
    if (pageId === 'timeline') Timeline.render();
    if (pageId === 'history') HistoryView.render();
    if (pageId === 'settings') Settings.render();
  },

  /* ---------- 通知音量・ミュート状態の取得 ---------- */
  _getNotifVolume() {
    const isChild = localStorage.getItem('cfg_share_mode') === 'client';
    const localVol = isChild ? localStorage.getItem('tbs_notification_volume') : null;
    if (localVol !== null && localVol !== undefined) return Math.min(1, Math.max(0, parseInt(localVol, 10) / 100));
    const rec = typeof AppState !== 'undefined'
      ? AppState.systemSettings?.find(s => s.id === 'notification_volume') : null;
    return Math.min(1, Math.max(0, parseInt(rec?.value || '80', 10) / 100));
  },

  _isNotifMuted() {
    const isChild = localStorage.getItem('cfg_share_mode') === 'client';
    const localMute = isChild ? localStorage.getItem('tbs_notification_mute') : null;
    let muteCfg = null;
    if (localMute) {
      try { muteCfg = JSON.parse(localMute); } catch(e) {}
    } else if (typeof AppState !== 'undefined') {
      const rec = AppState.systemSettings?.find(s => s.id === 'notification_mute');
      if (rec?.value) try { muteCfg = JSON.parse(rec.value); } catch(e) {}
    }
    if (!muteCfg?.enabled) return false;
    const now = new Date();
    const [sh, sm] = (muteCfg.start || '22:00').split(':').map(Number);
    const [eh, em] = (muteCfg.end   || '06:00').split(':').map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    // 跨ぐ (22:00〜翌06:00) か 同日内 (ex. 09:00〜12:00) かで判定が違う
    return s > e ? (cur >= s || cur < e) : (cur >= s && cur < e);
  },

  /* ---------- 通知音の再生 (Web Audio API によるシンセサイズ合成) ---------- */
  playNotificationSound(type, forceVolume) {
    if (this._isNotifMuted()) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const vol = forceVolume !== undefined ? forceVolume : this._getNotifVolume();
    if (vol <= 0) return;
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') ctx.resume();

      // マスターゲインノード (音量制御)
      const master = ctx.createGain();
      master.gain.setValueAtTime(vol, ctx.currentTime);
      master.connect(ctx.destination);

      const connect = (node) => node.connect(master);

      const tone = (freq, time, dur, type2 = 'sine', peakGain = 0.2) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type2;
        osc.frequency.setValueAtTime(freq, time);
        g.gain.setValueAtTime(0, time);
        g.gain.linearRampToValueAtTime(peakGain, time + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, time + dur);
        osc.connect(g); connect(g);
        osc.start(time); osc.stop(time + dur + 0.05);
      };
      const now = ctx.currentTime;

      if (type === 'alarm') {
        // 高音サイン3連打（警告）
        [now, now + 0.32, now + 0.64].forEach(t => tone(880, t, 0.25, 'sawtooth', 0.15));
      } else if (type === 'chime') {
        // ドミソ上昇チャイム
        tone(523.25, now, 0.4);
        tone(659.25, now + 0.15, 0.4);
        tone(783.99, now + 0.3, 0.5);
      } else if (type === 'ding') {
        // 単音サイン（ピン）
        tone(1046.50, now, 0.8, 'sine', 0.25);
      } else if (type === 'double-chime') {
        // 二段チャイム（ポーンポーン）
        tone(880, now, 0.35);
        tone(1108.73, now + 0.02, 0.35);
        tone(880, now + 0.5, 0.35);
        tone(1108.73, now + 0.52, 0.35);
      } else if (type === 'beep') {
        // 短いビープ×2
        tone(1200, now, 0.1, 'square', 0.12);
        tone(1200, now + 0.18, 0.1, 'square', 0.12);
      } else if (type === 'fanfare') {
        // ファンファーレ（ドソミソ上昇）
        tone(523.25, now,       0.2, 'sine', 0.22);
        tone(783.99, now + 0.18, 0.2, 'sine', 0.22);
        tone(659.25, now + 0.36, 0.2, 'sine', 0.22);
        tone(1046.50,now + 0.54, 0.4, 'sine', 0.25);
      } else if (type === 'soft') {
        // 柔らかい低音チャイム（ゆっくり減衰）
        tone(349.23, now,       0.9, 'sine', 0.18);
        tone(440.00, now + 0.2, 0.9, 'sine', 0.15);
        tone(523.25, now + 0.4, 1.0, 'sine', 0.18);
      } else if (type === 'urgent') {
        // 急速アラーム（緊急）
        [0, 0.18, 0.36, 0.54, 0.72].forEach(d => tone(1320, now + d, 0.12, 'sawtooth', 0.18));
      }
    } catch (e) {
      console.warn('[Audio] Failed to play synthesized sound:', e);
    }
  },

  /* ---------- OSネイティブ通知（Electron IPC経由） ---------- */
  showOsNotification(title, body) {
    const isChild = localStorage.getItem('cfg_share_mode') === 'client';
    const localOs = isChild ? localStorage.getItem('tbs_notification_os') : null;
    let osEnabled = false;
    if (localOs !== null) {
      osEnabled = localOs === 'true';
    } else if (typeof AppState !== 'undefined') {
      const rec = AppState.systemSettings?.find(s => s.id === 'notification_os');
      osEnabled = rec?.value === 'true';
    }
    if (!osEnabled) return;
    // Electron環境ではメインプロセス経由（Windows通知センターに確実に届く）
    if (window.electronAPI?.showOsNotification) {
      window.electronAPI.showOsNotification(title, body);
    }
  },

  /* ---------- スキャン音の再生 (合成音声) ---------- */
  playScanSound(success) {
    // スキャン音のON/OFF設定チェック
    const isChild = localStorage.getItem('cfg_share_mode') === 'client';
    const localScan = isChild ? localStorage.getItem('tbs_notification_scan_sound') : null;
    let scanEnabled = true;
    if (localScan !== null) {
      scanEnabled = localScan !== 'false';
    } else if (typeof AppState !== 'undefined') {
      const rec = AppState.systemSettings?.find(s => s.id === 'notification_scan_sound');
      if (rec) scanEnabled = rec.value !== 'false';
    }
    if (!scanEnabled) return;

    if (this._isNotifMuted()) return;
    const vol = this._getNotifVolume();
    if (vol <= 0) return;

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') ctx.resume();

      const master = ctx.createGain();
      master.gain.setValueAtTime(vol, ctx.currentTime);
      master.connect(ctx.destination);

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      if (success) {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(2000, now);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now);
        osc.stop(now + 0.1);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, now);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.25, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now);
        osc.stop(now + 0.3);
      }
    } catch (e) {
      console.warn('[Audio] Failed to play scan sound:', e);
    }
  },

  escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  formatBedName(bed) {
    if (!bed) return '?';
    let displayNo = bed.bed_number;
    let joinChar = '-';
    const mappingSetting = AppState.systemSettings?.find(s => s.id === 'import_mapping');
    if (mappingSetting && mappingSetting.value) {
      try {
        const mapping = JSON.parse(mappingSetting.value);
        if (mapping.join_char !== undefined) {
          joinChar = mapping.join_char;
        }
      } catch (e) {}
    }

    let bCode = bed.bed_code || '';
    if (!bCode && bed.bed_number && bed.room_number) {
      const parts = bed.bed_number.split(joinChar);
      if (parts.length > 1 && parts[0] === bed.room_number) {
        bCode = parts.slice(1).join(joinChar);
      }
    }

    if (bed.room_number && bed.bed_number.startsWith(bed.room_number)) {
      const suffix = bed.bed_number.substring(bed.room_number.length);
      displayNo = `<span style="font-weight: 800;">${this.escapeHTML(bed.room_number)}</span><span style="color:#718096; font-weight: normal; font-size: 10px;">${this.escapeHTML(suffix)}</span>`;
    } else if (bed.room_number) {
      if (bCode) {
        displayNo = `<span style="font-weight: 800;">${this.escapeHTML(bed.room_number)}</span><span style="color:#718096; font-weight: normal; font-size: 10px;">-${this.escapeHTML(bCode)}</span>`;
      } else {
        displayNo = `<span style="font-weight: 800;">${this.escapeHTML(bed.room_number)}</span>`;
      }
    } else {
      displayNo = `<span style="font-weight: 800;">${this.escapeHTML(bed.bed_number)}</span>`;
    }
    return displayNo;
  },

  // confirm() ダイアログ用: HTMLタグなしのプレーンテキスト病床名
  formatBedNamePlain(bed) {
    if (!bed) return '?';
    if (bed.room_number && bed.bed_number.startsWith(bed.room_number)) {
      return bed.bed_number;
    }
    return bed.room_number ? `${bed.room_number}-${bed.bed_number}` : bed.bed_number;
  },
};
