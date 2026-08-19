/**
 * TransBoard - UI共通ユーティリティ
 */

// CSVを表計算ソフトで開いた際の数式評価を防ぐ。数値リテラルは分析用途を
// 損なわないよう維持し、それ以外の危険な先頭文字には'を前置する。
function sanitizeCsvValue(value) {
  const text = String(value ?? '');
  const trimmed = text.trim();
  const numericLiteral = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (numericLiteral.test(trimmed)) return text;

  const startsDangerously = /^[\t\r\n]|^\s*[=+\-@]/.test(text);
  const alreadyQuotedDangerousValue = /^'(?=[\t\r\n])|^'(?='?\s*[=+\-@])/.test(text);
  return startsDangerously || alreadyQuotedDangerousValue ? `'${text}` : text;
}

// マスタCSVの再取込時に、上の関数が付けた保護用'を1文字だけ戻す。
// 元から'=...だった値は出力時に''=...となるため、往復後も元の値を保てる。
function restoreSanitizedCsvValue(value) {
  const text = String(value ?? '');
  return /^'(?=[\t\r\n])|^'(?='?\s*[=+\-@])/.test(text) ? text.slice(1) : text;
}

const UI = {
  sanitizeCsvValue,
  restoreSanitizedCsvValue,

  EXAM_ROOM_ICON_PRESETS: [
    { icon: 'fa-x-ray', label: 'X線/CT' },
    { icon: 'fa-magnet', label: 'MRI' },
    { icon: 'fa-radiation', label: '放射線' },
    { icon: 'fa-procedures', label: '処置' },
    { icon: 'fa-stethoscope', label: '診察' },
    { icon: 'fa-wave-square', label: 'エコー' },
    { icon: 'fa-heartbeat', label: '心電図' },
    { icon: 'fa-microscope', label: '検体' },
    { icon: 'fa-camera', label: '内視鏡' },
    { icon: 'fa-hospital-symbol', label: '検査室' },
  ],

  // 院内オフライン環境でも表示できるローカルSVG。DB値から任意パスを生成せず、
  // コード／名称を既知の画像へ対応付けることで、画像読み込みによるパストラバーサルを防ぐ。
  EXAM_IMAGE_BY_KEY: Object.freeze({
    ct: 'assets/exam-icons/ct.svg',
    mri: 'assets/exam-icons/mri.svg',
    xp: 'assets/exam-icons/xray.svg',
    xray: 'assets/exam-icons/xray.svg',
    endo: 'assets/exam-icons/endoscopy.svg',
    endoscopy: 'assets/exam-icons/endoscopy.svg',
    echo: 'assets/exam-icons/ultrasound.svg',
    ultrasound: 'assets/exam-icons/ultrasound.svg',
    angio: 'assets/exam-icons/angiography.svg',
    angiography: 'assets/exam-icons/angiography.svg',
    default: 'assets/exam-icons/generic.svg',
  }),

  _examImageKey(item) {
    const value = item || {};
    const raw = `${value.code || ''} ${value.name || ''} ${value.icon || ''}`.toLowerCase();
    if (/mri|magnet/.test(raw)) return 'mri';
    if (/\bct\b/.test(raw)) return 'ct';
    if (/\bxp\b|x-ray|xray|x線|レントゲン|radiation/.test(raw)) return 'xray';
    if (/endo|内視鏡|procedures/.test(raw)) return 'endo';
    if (/echo|エコー|ultrasound|wave-square/.test(raw)) return 'echo';
    if (/angio|血管撮影/.test(raw)) return 'angio';
    return 'default';
  },

  getExamRoomImage(room) {
    return this.EXAM_IMAGE_BY_KEY[this._examImageKey(room)] || this.EXAM_IMAGE_BY_KEY.default;
  },

  getExamTypeImage(type) {
    return this.EXAM_IMAGE_BY_KEY[this._examImageKey(type)] || this.EXAM_IMAGE_BY_KEY.default;
  },

  examImage(item, kind = 'type', className = 'exam-master-image') {
    const src = kind === 'room' ? this.getExamRoomImage(item) : this.getExamTypeImage(item);
    const alt = item?.name ? `${String(item.name)}の画像` : '検査画像';
    return `<img class="${this.escapeHTML(className)}" src="${src}" alt="${this.escapeHTML(alt)}" loading="lazy" decoding="async">`;
  },

  normalizeExamRoomIcon(icon) {
    const value = String(icon || '').trim();
    return this.EXAM_ROOM_ICON_PRESETS.some(item => item.icon === value) ? value : 'fa-x-ray';
  },


  /* ---------- 患者名マスキング (データ #1) ---------- */
  isPatientMaskEnabled() {
    const chk = document.getElementById('chk-show-patient-names');
    if (chk) return !chk.checked;
    return localStorage.getItem('cfg_show_patient_names') !== 'true';
  },

  getPatientName(name) {
    if (!name) return null;
    return this.isPatientMaskEnabled() ? '＊＊＊＊' : name;
  },

  // 検査室到着後は付き添いが手離れ(待機)し、実際に迎えに行く人は同じとは限らない。
  // 「今この欄が指しているのは付き添いか迎え担当か」を文言で明示する
  // (isActive=true: MOVING/PICKUP_REQUIREDで実際に付き添い移動中、
  //  false: それ以外は待機中=迎え担当として変更可能)
  escortRoleLabel(isActive) {
    return isActive ? '付き添い中' : '迎え担当';
  },

  // 付き添いスタッフのバッジHTML。実際に移動中(active)か、検査中等で
  // 病棟へ戻り手離れしている状態(standby)かで表示を変える（病床マップ・
  // 優先対応一覧の双方から共有）
  escortBadge(name, isActive, cssPrefix, extraClass = '', style = '') {
    const icon = isActive ? 'fa-walking' : 'fa-user-nurse';
    const suffix = isActive ? '' : `（${this.escortRoleLabel(false)}）`;
    const stateClass = isActive ? 'active' : 'standby';
    const classAttr = `${extraClass ? extraClass + ' ' : ''}${cssPrefix} ${cssPrefix}--${stateClass}`;
    const styleAttr = style ? ` style="${style}"` : '';
    return `<div class="${classAttr}"${styleAttr}><i class="fas ${icon}"></i> ${this.escapeHTML(name)}${suffix}</div>`;
  },

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

  // 今日なら時刻のみ、それ以外は日付付きで表示する。日跨ぎで残る移送
  // （継続扱いのイベント等）を時刻のみで表示すると別日のデータと誤読されるため
  formatTimeSmart(ms) {
    if (!ms) return '--:--';
    const d = new Date(ms);
    const now = new Date();
    const isToday = d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return isToday ? this.formatTime(ms) : this.formatDateTime(ms);
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
    const safeStatusClass = String(status || '').replace(/[^A-Za-z0-9_-]/g, '');
    const safeIconClass = String(iconClass || '')
      .split(/\s+/)
      .filter(token => /^fa[srlbd]?$|^fa-[A-Za-z0-9-]+$/.test(token))
      .join(' ');
    const iconHtml = safeIconClass ? `<i class="fas ${safeIconClass}" aria-hidden="true"></i> ` : '';
    return `<span class="status-badge badge-${safeStatusClass}">${iconHtml}${this.escapeHTML(label)}</span>`;
  },

  /* ---------- トースト通知 ---------- */
  // innerHTML を避け DOM API で構築することでXSS防止
  toast(message, type = 'info', duration = 4000, { actionLabel = '', onAction = null } = {}) {
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
    let actionButton = null;
    if (actionLabel && typeof onAction === 'function') {
      actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'toast-action';
      actionButton.textContent = actionLabel;
      el.appendChild(actionButton);
    }
    container.appendChild(el);
    const closeToast = () => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 250);
    };
    const timerId = setTimeout(closeToast, duration);
    if (actionButton) {
      actionButton.addEventListener('click', async () => {
        clearTimeout(timerId);
        actionButton.disabled = true;
        actionButton.textContent = '送信中…';
        try {
          const completed = await onAction();
          if (completed === false) {
            actionButton.disabled = false;
            actionButton.textContent = actionLabel;
            setTimeout(closeToast, 5000);
            return;
          }
          actionButton.textContent = '確認済み';
          setTimeout(closeToast, 600);
        } catch (error) {
          console.error('[Toast Action]', error);
          actionButton.disabled = false;
          actionButton.textContent = actionLabel;
          setTimeout(closeToast, 5000);
        }
      });
    }
    return el;
  },

  /* ---------- モーダルの放置時自動クローズ ---------- */
  // targetに操作(クリック・キー入力・タッチ)が一定時間無ければonTimeoutを呼ぶ。
  // 呼び出し元はモーダルを閉じる際、戻り値の解除関数を必ず呼ぶこと
  // (呼ばないとタイマーが残り、既に閉じた後に誤って再発火しうる)
  armIdleAutoClose(target, onTimeout, { timeoutMs = CONFIG.MODAL_IDLE_AUTO_CLOSE_MS } = {}) {
    const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'input'];
    let timer = null;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, timeoutMs);
    };
    ACTIVITY_EVENTS.forEach(type => target.addEventListener(type, reset));
    reset();
    return () => {
      clearTimeout(timer);
      ACTIVITY_EVENTS.forEach(type => target.removeEventListener(type, reset));
    };
  },

  /* ---------- 確認ダイアログ（デザイン#5: ネイティブconfirm()の代替） ---------- */
  // メッセージ本文はtextContentで挿入するためXSSの心配がない
  // opts.type: 'danger'|'warning' でアイコン・ボタン色を指定可能（未指定時は opts.danger を後方互換のショートハンドとして使用）
  // opts.title: メッセージ上部の見出し（省略時はアイコン+メッセージのみのシンプル表示）
  // opts.detail: メッセージ下部の強調警告ボックス（省略可）
  // opts.autoConfirmMs: 指定した場合、確認ボタンに残り秒数を表示しつつ、その時間が
  // 経過すると自動で確定(true)する。誤操作防止の確認自体は保ちつつ、無人での
  // 自動遷移を必要とする操作（ICスキャン等）向け
  confirmModal(message, { title, detail, danger = false, type, confirmLabel = 'OK', cancelLabel = 'キャンセル', autoConfirmMs = 0 } = {}) {
    return new Promise(resolve => {
      const effectiveType = type || (danger ? 'danger' : null);
      const iconClass = effectiveType === 'danger' ? 'fa-exclamation-triangle'
        : effectiveType === 'warning' ? 'fa-exclamation-circle'
        : 'fa-question-circle';
      const btnCls = effectiveType === 'danger' ? 'btn-danger'
        : effectiveType === 'warning' ? 'btn-warning'
        : 'btn-primary';

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay confirm-modal-overlay';

      const modal = document.createElement('div');
      modal.className = 'modal confirm-modal';
      modal.setAttribute('role', 'alertdialog');
      modal.setAttribute('aria-modal', 'true');

      const body = document.createElement('div');
      body.className = 'modal-body confirm-modal-body';
      const icon = document.createElement('i');
      icon.className = `fas ${iconClass} confirm-modal-icon${effectiveType ? ` confirm-modal-icon--${effectiveType}` : ''}`;
      icon.setAttribute('aria-hidden', 'true');

      const textCol = document.createElement('div');
      textCol.className = 'confirm-modal-text-col';
      if (title) {
        const titleEl = document.createElement('div');
        titleEl.className = 'confirm-modal-title';
        titleEl.textContent = title;
        textCol.appendChild(titleEl);
      }
      const text = document.createElement('span');
      text.className = 'confirm-modal-text';
      text.textContent = message;
      textCol.appendChild(text);
      if (detail) {
        const detailEl = document.createElement('div');
        detailEl.className = 'confirm-modal-detail';
        detailEl.textContent = detail;
        textCol.appendChild(detailEl);
      }
      body.appendChild(icon);
      body.appendChild(textCol);

      const footer = document.createElement('div');
      footer.className = 'modal-footer confirm-modal-footer';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-outline btn-sm';
      cancelBtn.textContent = cancelLabel;
      const okBtn = document.createElement('button');
      okBtn.className = `btn btn-sm ${btnCls}`;
      okBtn.textContent = confirmLabel;
      footer.appendChild(cancelBtn);
      footer.appendChild(okBtn);

      modal.appendChild(body);
      modal.appendChild(footer);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      let settled = false;
      let countdownTimer = null;
      let idleCancel = null;
      const cleanup = (result) => {
        if (settled) return;
        settled = true;
        if (countdownTimer) clearInterval(countdownTimer);
        if (idleCancel) idleCancel();
        document.removeEventListener('keydown', onKeydown);
        overlay.remove();
        resolve(result);
      };
      const onKeydown = (e) => {
        if (e.key === 'Escape') cleanup(false);
        if (e.key === 'Enter') cleanup(true);
      };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
      cancelBtn.addEventListener('click', () => cleanup(false));
      okBtn.addEventListener('click', () => cleanup(true));
      document.addEventListener('keydown', onKeydown);
      okBtn.focus();

      // autoConfirmMsは別の自動確定タイマーを既に持つため、放置クローズは二重にしない
      if (!autoConfirmMs) {
        idleCancel = UI.armIdleAutoClose(overlay, () => cleanup(false));
      }

      if (autoConfirmMs > 0) {
        let remainingSec = Math.ceil(autoConfirmMs / 1000);
        okBtn.textContent = `${confirmLabel}（${remainingSec}）`;
        countdownTimer = setInterval(() => {
          remainingSec -= 1;
          if (remainingSec <= 0) {
            cleanup(true);
          } else {
            okBtn.textContent = `${confirmLabel}（${remainingSec}）`;
          }
        }, 1000);
      }
    });
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
    if (
      typeof App !== 'undefined' &&
      typeof App.isExamTerminal === 'function' &&
      App.isExamTerminal() &&
      pageId !== 'exam-room' &&
      pageId !== 'settings'
    ) {
      pageId = 'exam-room';
    }
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

    // 設定タブから離れる際、端末一覧の5秒ポーリングを止める（放置すると画面を
    // 二度と開かなくても稼働し続けるため）
    if (pageId !== 'settings' && Settings._deviceListTimer) {
      clearInterval(Settings._deviceListTimer);
      Settings._deviceListTimer = null;
    }
  },

  /* ---------- 通知音量・ミュート状態の取得 ---------- */
  _getNotifVolume() {
    const shareMode = localStorage.getItem('cfg_share_mode');
    const isChild = shareMode === 'client' || shareMode === 'child';
    const localVol = isChild ? localStorage.getItem('tbs_notification_volume') : null;
    if (localVol !== null && localVol !== undefined) return Math.min(1, Math.max(0, parseInt(localVol, 10) / 100));
    const rec = typeof AppState !== 'undefined'
      ? AppState.systemSettings?.find(s => s.id === 'notification_volume') : null;
    return Math.min(1, Math.max(0, parseInt(rec?.value || '80', 10) / 100));
  },

  _isNotifMuted() {
    const shareMode = localStorage.getItem('cfg_share_mode');
    const isChild = shareMode === 'client' || shareMode === 'child';
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

  _isAutomaticSpeechEnabled() {
    const shareMode = localStorage.getItem('cfg_share_mode');
    const isChild = shareMode === 'client' || shareMode === 'child';
    const localValue = isChild ? localStorage.getItem('tbs_notification_auto_speech') : null;
    if (localValue !== null) return localValue !== 'false';
    const rec = typeof AppState !== 'undefined'
      ? AppState.systemSettings?.find(s => s.id === 'notification_auto_speech')
      : null;
    return rec?.value !== 'false';
  },

  /* ---------- 通知音の再生 (Web Audio API によるシンセサイズ合成) ---------- */
  playNotificationSound(type, forceVolume, { ignoreMute = false } = {}) {
    if (!ignoreMute && this._isNotifMuted()) return;
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


  /* ---------- スキャン音の再生 (合成音声) ---------- */
  playScanSound(success) {
    // スキャン音のON/OFF設定チェック
    const shareMode = localStorage.getItem('cfg_share_mode');
    const isChild = shareMode === 'client' || shareMode === 'child';
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
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  formatBedName(bed) {
    if (!bed) return '?';
    // マスター画面の「病床番号（結合）」と同じ bed_number を表示の正とする。
    // room_number は物理的な病室番号であり、ここで連結すると 706-712 のような
    // マスターに存在しない病床番号になるため表示には混ぜない。
    return `<span style="font-weight:800;">${this.escapeHTML(bed.bed_number || bed.room_number || '?')}</span>`;
  },

  // confirm() ダイアログ用: HTMLタグなしのプレーンテキスト病床名
  formatBedNamePlain(bed) {
    if (!bed) return '?';
    return String(bed.bed_number || bed.room_number || '?');
  },

  // 検査室でもマスターの「病床番号（結合）」に接尾辞だけを付けて表示する。
  formatExamBedLocationPlain(bed) {
    if (!bed) return '?';
    const bedNumber = this.formatBedNamePlain(bed);
    return /(?:号床|床)$/.test(bedNumber) ? bedNumber : `${bedNumber}号床`;
  },
};
