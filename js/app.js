/**
 * TransBoard - メインアプリケーション
 */

const WardDashboard = {
  // データに変化が無いtickでも、残り時間・遅延判定など時刻依存の表示が
  // 固まらないよう、この間隔を超えたら変化が無くても強制的に再描画する。
  FULL_RENDER_FALLBACK_MS: 25000,
  _lastSignature: null,
  _lastRenderAt: 0,

  render() {
    BedMap.render();
    Priority.renderSummary();
    Priority.renderKpi();
    Priority.renderPriorityList();
    if (typeof StaffStatus !== 'undefined') StaffStatus.render();
    if (typeof NotificationHistory !== 'undefined') NotificationHistory.render();
    if (typeof Handover !== 'undefined') Handover.render();
  },

  // ポーリングtick専用: 取得データが前回描画時と同一なら、重い全体再描画
  // (病床マップ全カード再構築＋優先度一覧再計算)を省略する。時刻依存の
  // 残り時間表示だけは軽量な更新を毎tick必ず行う。
  renderIfChanged(signature) {
    BedMap.updateTimers();
    const now = Date.now();
    if (
      signature !== null &&
      signature === this._lastSignature &&
      (now - this._lastRenderAt) < this.FULL_RENDER_FALLBACK_MS
    ) {
      return;
    }
    this.render();
    this._lastSignature = signature;
    this._lastRenderAt = now;
  },
};

// パスコードの強度確認とrenderer側の補助的な試行制限。
// ハッシュ生成・保存・照合はmainプロセスだけで行う。
const PasscodeHash = {
  LOCKOUT_MS: 60 * 1000,
  MAX_ATTEMPTS: 5,

  isWeakRaw(raw) {
    const value = String(raw || '').trim();
    if (value.length < 6) return true;
    if (/^(\d)\1+$/.test(value)) return true;
    if (['000000', '111111', '123456', '654321', '12345678', 'password', 'passcode'].includes(value.toLowerCase())) return true;
    const digits = value.split('').map(ch => Number(ch));
    if (digits.every(n => Number.isInteger(n))) {
      const asc = digits.every((n, i) => i === 0 || n === digits[i - 1] + 1);
      const desc = digits.every((n, i) => i === 0 || n === digits[i - 1] - 1);
      if (asc || desc) return true;
    }
    return false;
  },

  getRateState() {
    try { return JSON.parse(localStorage.getItem('_pc_rate') || '{}'); } catch { return {}; }
  },

  recordAttempt(failed) {
    const s = this.getRateState();
    if (failed) {
      s.attempts = (s.attempts || 0) + 1;
      s.lastAttempt = Date.now();
    } else {
      delete s.attempts;
      delete s.lastAttempt;
    }
    localStorage.setItem('_pc_rate', JSON.stringify(s));
  },

  isLocked() {
    const s = this.getRateState();
    if (!s.attempts || s.attempts < this.MAX_ATTEMPTS) return false;
    if ((Date.now() - (s.lastAttempt || 0)) > this.LOCKOUT_MS) {
      localStorage.removeItem('_pc_rate');
      return false;
    }
    return true;
  },

  remainingLockout() {
    const s = this.getRateState();
    return Math.max(0, Math.ceil((this.LOCKOUT_MS - (Date.now() - (s.lastAttempt || 0))) / 1000));
  },
};

const PasscodeModal = {
  _onSuccess: null,
  _mode: 'verify',
  SESSION_TIMEOUT_MS: 5 * 60 * 1000,
  _sessionTimer: null,
  _lastActivityAt: 0,
  _previousFocus: null,

  open(onSuccess, { setup = false } = {}) {
    this._previousFocus = document.activeElement;
    this._onSuccess = onSuccess;
    this._mode = setup ? 'setup' : 'verify';

    const input = document.getElementById('passcode-input');
    if (input) input.value = '';
    const errMsg = document.getElementById('passcode-error-msg');
    if (errMsg) errMsg.style.display = 'none';
    const title = document.getElementById('passcode-modal-title');
    if (title) {
      title.innerHTML = setup
        ? '<i class="fas fa-lock"></i> 初回パスコード設定'
        : '<i class="fas fa-lock"></i> 管理者ロック解除';
    }
    const closeBtn = document.getElementById('passcode-modal-close');
    if (closeBtn) closeBtn.style.display = '';
    const cancelBtn = document.getElementById('btn-passcode-cancel');
    if (cancelBtn) cancelBtn.style.display = '';
    const submitBtn = document.getElementById('btn-passcode-submit');
    if (submitBtn) submitBtn.textContent = setup ? '設定して開く' : '認証';
    const note = document.querySelector('#passcode-modal-body label');
    if (note) {
      note.textContent = setup
        ? '初期パスコードのままでは設定画面を開けません。6文字以上の新しいパスコードを設定してください。'
        : '設定画面を開くにはパスコードを入力してください。';
    }
    if (input) {
      input.placeholder = setup ? '新しいパスコード' : 'パスコードを入力';
    }

    const overlay = document.getElementById('passcode-modal-overlay');
    if (overlay) overlay.classList.remove('hidden');

    setTimeout(() => {
      if (input) input.focus();
    }, 50);
  },

  close() {
    const overlay = document.getElementById('passcode-modal-overlay');
    if (overlay) overlay.classList.add('hidden');
    this._onSuccess = null;
    this._mode = 'verify';
    if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
      this._previousFocus.focus();
    }
    this._previousFocus = null;
  },

  unlock() {
    window.isAdminSession = true;
    this._lastActivityAt = Date.now();
    this._scheduleSessionTimeout();
  },

  lock({ redirect = false, notify = false } = {}) {
    window.isAdminSession = false;
    this._lastActivityAt = 0;
    if (this._sessionTimer) {
      clearTimeout(this._sessionTimer);
      this._sessionTimer = null;
    }
    if (notify && typeof UI !== 'undefined') {
      UI.toast('設定画面のロックを再度有効にしました', 'info');
    }
    if (redirect && typeof UI !== 'undefined') {
      UI.switchPage('ward-dashboard');
    }
  },

  isSessionValid() {
    if (!window.isAdminSession || !this._lastActivityAt) return false;
    return (Date.now() - this._lastActivityAt) < this.SESSION_TIMEOUT_MS;
  },

  markActivity() {
    if (!window.isAdminSession) return;
    const settingsPage = document.getElementById('page-settings');
    if (!settingsPage?.classList.contains('active')) return;
    this._lastActivityAt = Date.now();
    this._scheduleSessionTimeout();
  },

  _scheduleSessionTimeout() {
    if (this._sessionTimer) clearTimeout(this._sessionTimer);
    this._sessionTimer = setTimeout(() => {
      if (!this.isSessionValid()) {
        this.lock({ redirect: true, notify: true });
      }
    }, this.SESSION_TIMEOUT_MS + 250);
  },

  async getPasscodeStatus() {
    try {
      if (typeof API !== 'undefined' && API.getPasscodeStatus) {
        return await API.getPasscodeStatus();
      }
    } catch (err) {
      console.warn('[Passcode] Failed to fetch passcode status:', err);
    }
    return { success: false, requiresSetup: true };
  },

  async submit() {
    const input = document.getElementById('passcode-input');
    if (!input) return;

    if (PasscodeHash.isLocked()) {
      const errMsg = document.getElementById('passcode-error-msg');
      if (errMsg) {
        errMsg.textContent = `試行回数超過。あと${PasscodeHash.remainingLockout()}秒後に再試行できます`;
        errMsg.style.display = 'block';
      }
      return;
    }

    const inputVal = input.value;
    if (this._mode === 'setup') {
      await this.submitInitialSetup(inputVal);
      return;
    }
    let verification;
    try {
      verification = await API.verifyAdminPasscode(inputVal);
    } catch (err) {
      console.warn('[Passcode] Verification request failed:', err);
      verification = { success: false, valid: false };
    }
    const ok = verification?.success === true && verification?.valid === true;
    if (ok) {
      PasscodeHash.recordAttempt(false);
      this.unlock();
      const onSuccess = this._onSuccess;
      this.close();
      if (onSuccess) onSuccess();
    } else {
      PasscodeHash.recordAttempt(true);
      const errMsg = document.getElementById('passcode-error-msg');
      if (errMsg) {
        if (verification?.locked) {
          errMsg.textContent = `試行回数超過。あと${verification.retryAfterSeconds || 60}秒後に再試行できます`;
          errMsg.style.display = 'block';
          input.value = '';
          input.focus();
          return;
        }
        const remaining = PasscodeHash.MAX_ATTEMPTS - (PasscodeHash.getRateState().attempts || 0);
        errMsg.textContent = remaining > 0
          ? `パスコードが違います（残り${remaining}回）`
          : `試行回数超過。1分間ロックされます`;
        errMsg.style.display = 'block';
      }
      input.value = '';
      input.focus();
    }
  },

  async submitInitialSetup(inputVal) {
    const errMsg = document.getElementById('passcode-error-msg');
    if (PasscodeHash.isWeakRaw(inputVal)) {
      if (errMsg) {
        errMsg.textContent = '6文字以上で、連番・同一数字のみ・推測されやすい値は避けてください';
        errMsg.style.display = 'block';
      }
      return;
    }
    try {
      const result = await API.setAdminPasscode(inputVal);
      if (!result?.success) throw new Error(result?.message || 'パスコードを保存できませんでした');
      const cached = AppState.systemSettings?.find(s => s.id === 'admin_passcode');
      if (cached) cached.value = '********';
      else {
        if (!Array.isArray(AppState.systemSettings)) AppState.systemSettings = [];
        AppState.systemSettings.push({ id: 'admin_passcode', value: '********' });
      }
      PasscodeHash.recordAttempt(false);
      this.unlock();
      const onSuccess = this._onSuccess;
      this.close();
      if (onSuccess) onSuccess();
    } catch (err) {
      if (errMsg) {
        errMsg.textContent = 'パスコードを保存できません。親機で設定してから再度お試しください。';
        errMsg.style.display = 'block';
      }
      console.warn('[Passcode] Failed to save initial passcode:', err);
    }
  },

  init() {
    const closeBtn = document.getElementById('passcode-modal-close');
    if (closeBtn) closeBtn.onclick = () => this.close();

    const cancelBtn = document.getElementById('btn-passcode-cancel');
    if (cancelBtn) cancelBtn.onclick = () => this.close();

    const submitBtn = document.getElementById('btn-passcode-submit');
    if (submitBtn) submitBtn.onclick = () => this.submit();

    const input = document.getElementById('passcode-input');
    if (input) {
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.submit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        }
      };
    }

    ['click', 'keydown', 'input', 'change'].forEach(type => {
      document.addEventListener(type, () => this.markActivity(), true);
    });
  }
};

// 環境識別ユーティリティ (インフラ #4: 環境分離)
const AppEnv = {
  _isDev: null,

  async detect() {
    if (this._isDev !== null) return;
    try {
      this._isDev = window.electronAPI?.isDevMode
        ? await window.electronAPI.isDevMode()
        : !!(process?.env?.NODE_ENV === 'development');
    } catch {
      this._isDev = false;
    }
  },

  get isDev() { return this._isDev === true; },
  get isProd() { return this._isDev === false; },
};

// 親機サーバー可用性チェック (インフラ #3: 高可用性／縮退モード)
const ParentServerMonitor = {
  _interval: null,
  _failures: 0,
  _wasUnavailable: false,

  init() {
    const mode = localStorage.getItem('cfg_share_mode');
    if (mode !== 'client' && mode !== 'child') return;
    if (this._interval) clearTimeout(this._interval);
    this._failures = 0;
    this._wasUnavailable = false;
    this._schedule(1000 + Math.floor(Math.random() * 3000));
  },

  _delay(baseMs, ratio = 0.2) {
    const jitter = baseMs * ratio;
    return Math.max(1000, Math.round(baseMs + ((Math.random() * 2 - 1) * jitter)));
  },

  _schedule(delayMs) {
    this._interval = setTimeout(async () => {
      const ok = await this._check();
      this._failures = ok ? 0 : Math.min(this._failures + 1, 5);
      const baseDelay = this._failures ? Math.min(120000, 30000 * Math.pow(2, this._failures - 1)) : 30000;
      this._schedule(this._delay(baseDelay));
    }, delayMs);
  },

  async _check() {
    const parentIp = localStorage.getItem('cfg_parent_ip');
    if (!parentIp) return true;
    try {
      const apiToken = await API.getTerminalApiToken();
      const res = await parentFetch(`http://${parentIp}:3005/api/tables/wards`, {
        headers: apiToken ? { 'X-API-Token': apiToken } : {},
      }, 5000);
      if (res.ok) {
        const recovered = this._wasUnavailable;
        if (recovered) {
          const mastersRefreshed = await App.loadMasters({ silent: true, loadHandover: false });
          const refreshed = await App.refreshData({ force: true });
          if (!mastersRefreshed || !refreshed) {
            this._wasUnavailable = true;
            App._setConnectionStatus(false, 'network');
            return false;
          }
          if (typeof CallPanel !== 'undefined' && CallPanel._renderCallPanel) {
            CallPanel._renderCallPanel();
          }
          App.renderCurrentPageData();
        }
        this._wasUnavailable = false;
        App._setConnectionStatus(true);
        return true;
      } else {
        this._wasUnavailable = true;
        App._setConnectionStatus(false, res.status === 401 ? 'unauthorized' : 'network');
        return false;
      }
    } catch (error) {
      this._wasUnavailable = true;
      App._setConnectionStatus(false, error?.unauthorized ? 'unauthorized' : 'network');
      return false;
    }
  },

  destroy() {
    if (this._interval) clearTimeout(this._interval);
  },
};

const App = {
  _masterSyncTimer: null,
  _masterSyncInFlight: false,
  _masterSyncIntervalMs: 30000,
  _dataImportPromise: Promise.resolve(),
  _timelineLocalDate: null,

  // 親機単独運用モード（この1台だけで完結する運用）。子機との共有はしない前提で
  // 接続端末表示・病棟間通話・検査室タブなど多端末前提のUIを隠す。share_mode の
  // 接続ルーティングには影響しない端末ローカルの表示フラグ。
  isStandalone() {
    const mode = localStorage.getItem('cfg_share_mode') || 'parent';
    return mode === 'parent' && localStorage.getItem('cfg_standalone_mode') === 'true';
  },

  // bodyクラスで単独運用UI(検査室タブ・通話ボタン・接続端末チップの非表示)を一括制御する。
  // 検査室ページを開いたまま単独ONにした場合は病棟ダッシュボードへ退避する。
  _applyStandaloneMode() {
    const standalone = this.isStandalone();
    document.body.classList.toggle('standalone-mode', standalone);
    if (standalone) {
      const activePage = document.querySelector('.tab-btn.active')?.dataset.page;
      if (activePage === 'exam-room') UI.switchPage('ward-dashboard');
    }
  },

  async _checkEncryptionStatus() {
    if (!window.electronAPI?.getEncryptionStatus) return;
    try {
      const status = await window.electronAPI.getEncryptionStatus();
      const needsWarning = !status || !status.available || (status.dbExists && !status.dbIsEncrypted);
      let banner = document.getElementById('encryption-warning-banner');
      if (!needsWarning) {
        banner?.remove();
        return;
      }
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'encryption-warning-banner';
        banner.setAttribute('role', 'alert');
        banner.style.cssText = 'margin:8px 12px;padding:10px 14px;border:1px solid #dc2626;border-radius:6px;background:#fef2f2;color:#991b1b;font-size:13px;display:flex;align-items:center;gap:10px;z-index:20;';
        const text = document.createElement('span');
        text.textContent = !status || !status.available
          ? 'この端末ではデータベース暗号化を利用できません。患者情報を含むデータは平文で保存される可能性があります。'
          : 'データベースが暗号化されていません。共有端末では使用せず、設定とOSユーザー保護を確認してください。';
        banner.appendChild(text);
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '設定を確認';
        button.style.cssText = 'margin-left:auto;padding:4px 10px;border:1px solid #991b1b;border-radius:4px;background:#fff;color:#991b1b;cursor:pointer;';
        button.addEventListener('click', () => {
          if (typeof UI !== 'undefined' && UI.switchPage) UI.switchPage('settings');
        });
        banner.appendChild(button);
        document.body.insertBefore(banner, document.body.firstChild);
      }
    } catch (err) {
      console.warn('[Security] 暗号化状態の確認に失敗しました:', err);
    }
  },

  async init() {
    console.log('[App] 初期化開始...');
 
    // 表示倍率（ズーム）のイベントバインド（起動時はDBロード後に applySystemVisualSettings で一括適用）
    const zoomSelect = document.getElementById('zoom-select');
    if (zoomSelect) {
      zoomSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        document.body.style.zoom = val;
        localStorage.setItem('cfg_app_zoom', val);
      });
    }
 
    // フルスクリーン切替のイベントバインド
    const fsBtn = document.getElementById('btn-fullscreen');
    if (fsBtn) {
      fsBtn.addEventListener('click', () => {
        if (window.electronAPI && window.electronAPI.toggleFullscreen) {
          window.electronAPI.toggleFullscreen();
        } else {
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
              console.error('[Fullscreen] エラー:', err);
              UI.toast('フルスクリーン表示に切り替えられませんでした', 'danger');
            });
          } else {
            document.exitFullscreen();
          }
        }
      });
    }
 
    // F11キーでのフルスクリーン連動
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F11') {
        e.preventDefault();
        if (fsBtn) fsBtn.click();
      }
    });
 
    // フルスクリーン状態変更検知
    if (window.electronAPI && window.electronAPI.onFullscreenChanged) {
      window.electronAPI.onFullscreenChanged((isFullscreen) => {
        const icon = document.querySelector('#btn-fullscreen i');
        if (icon) {
          icon.className = isFullscreen ? 'fas fa-compress' : 'fas fa-expand';
        }
      });
    } else {
      document.addEventListener('fullscreenchange', () => {
        const isFullscreen = !!document.fullscreenElement;
        const icon = document.querySelector('#btn-fullscreen i');
        if (icon) {
          icon.className = isFullscreen ? 'fas fa-compress' : 'fas fa-expand';
        }
      });
    }
 
    // 時計開始
    UI.startClock();

    // オフライン状態の監視開始
    OfflineManager.init();

    // 環境検出 (インフラ #4)
    await AppEnv.detect();
    await this._checkEncryptionStatus();

    // 親機サーバー可用性監視 (インフラ #3: 子機モードのみ)
    ParentServerMonitor.init();

    // 管理者セッション認証状態（設定画面の多重プロンプト防止用キャッシュ）
    window.isAdminSession = false;

    // パスコードモーダルの初期化
    PasscodeModal.init();
 
    // タブ切り替え
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const targetPage = btn.dataset.page;
        
        if (targetPage === 'settings' && !PasscodeModal.isSessionValid()) {
          // パスコードによる設定画面全体の保護 (カスタムHTMLモーダルを使用)
          const passcodeStatus = await PasscodeModal.getPasscodeStatus();

          if (!passcodeStatus?.success || passcodeStatus.requiresSetup) {
            const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
            if (shareMode === 'client' || shareMode === 'child') {
              UI.toast('初回パスコード設定は親機で行ってください。設定後に子機から開けます。', 'warning', 7000);
              return;
            }
            PasscodeModal.open(() => {
              UI.switchPage(targetPage);
              PasscodeModal.markActivity();
            }, { setup: true });
            return;
          }

          PasscodeModal.open(() => {
            UI.switchPage(targetPage);
            PasscodeModal.markActivity();
          });
          return; // 認証完了するまでページ遷移を待機する
        }
        
        UI.switchPage(targetPage);
        if (targetPage === 'settings') PasscodeModal.markActivity();
        this._renderDevicePresence(this._connectedDevicesSnapshot || [], null);
      });
    });

    // フィルターボタンイベント
    document.querySelectorAll('#bed-map-filter-bar .filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#bed-map-filter-bar .filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        BedMap._activeFilter = btn.dataset.filter;
        BedMap.applyFilter();
      });
    });

    // 患者名表示トグルイベント
    const nameChk = document.getElementById('chk-show-patient-names');
    if (nameChk) {
      const savedVal = localStorage.getItem('cfg_show_patient_names') === 'true';
      nameChk.checked = savedVal;
      const grid = document.getElementById('bed-map-grid');
      if (grid) {
        if (savedVal) {
          grid.classList.remove('hide-patient-names');
        } else {
          grid.classList.add('hide-patient-names');
        }
      }

      nameChk.addEventListener('change', () => {
        localStorage.setItem('cfg_show_patient_names', nameChk.checked ? 'true' : 'false');
        const grid = document.getElementById('bed-map-grid');
        if (grid) {
          if (nameChk.checked) {
            grid.classList.remove('hide-patient-names');
          } else {
            grid.classList.add('hide-patient-names');
          }
          BedMap.render();
          if (typeof NotificationHistory !== 'undefined') NotificationHistory.render();
        }
        
        // 検査室のトグルとも連動させる
        const examChk = document.getElementById('chk-exam-show-patient-names');
        if (examChk) {
          examChk.checked = nameChk.checked;
        }
      });
    }

    // スタッフ稼働状況の絞り込みトグル（全員／稼働中のみ）
    const staffFilter = document.getElementById('staff-status-filter');
    if (staffFilter) {
      staffFilter.value = localStorage.getItem('cfg_staff_filter') || 'all';
      staffFilter.addEventListener('change', () => {
        localStorage.setItem('cfg_staff_filter', staffFilter.value);
        if (typeof StaffStatus !== 'undefined') StaffStatus.render();
      });
    }

    // 備考表示モードの切り替えイベント
    const remarksSelect = document.getElementById('sel-remarks-mode');
    if (remarksSelect) {
      remarksSelect.addEventListener('change', () => {
        BedMap.render();
      });
    }

    // 病棟セレクト変更
    document.getElementById('ward-select').addEventListener('change', async (e) => {
      AppState.currentWardId = e.target.value;
      localStorage.setItem('current_ward_id', AppState.currentWardId);
      await this.refreshData();
      this._primeNotificationBaseline();
      WardDashboard.render();
      this._renderDevicePresence(this._connectedDevicesSnapshot || [], null);
      if (Settings && ['beds', 'map', 'staffs'].includes(Settings._activeTab)) {
        Settings.render();
      }
      // 通話パネルの病棟発信ボタン一覧は「自分自身の病棟」を除外して描画しているため、
      // 病棟切り替え後に再描画しないと除外対象が古いままになる
      if (typeof CallPanel !== 'undefined' && CallPanel._renderCallPanel) {
        CallPanel._renderCallPanel();
      }
    });

    // タイムライン日付
    const dateInput = document.getElementById('timeline-date');
    const todayValue = TimelineDate.format();
    this._timelineLocalDate = todayValue;
    if (dateInput) {
      dateInput.value = todayValue;
      dateInput.addEventListener('change', () => Timeline._renderFullTimeline().catch(console.error));
    }
    document.getElementById('tl-today-btn')?.addEventListener('click', () => {
      if (dateInput) {
        dateInput.value = TimelineDate.format();
        Timeline._renderFullTimeline().catch(console.error);
      }
    });
    document.getElementById('tl-prev-day')?.addEventListener('click', () => {
      if (dateInput && dateInput.value) {
        dateInput.value = TimelineDate.shift(dateInput.value, -1);
        Timeline._renderFullTimeline().catch(console.error);
      }
    });
    document.getElementById('tl-next-day')?.addEventListener('click', () => {
      if (dateInput && dateInput.value) {
        dateInput.value = TimelineDate.shift(dateInput.value, 1);
        Timeline._renderFullTimeline().catch(console.error);
      }
    });

    // 通話パネル（ボタン初期化のみ）
    CallPanel.init();

    // ICカードスキャンのグローバルハンドラ（タブに関わらず常に受信）
    if (window.electronAPI?.onCardScanned) {
      window.electronAPI.onCardScanned((uid) => {
        // モーダルが実際に表示中かどうか確認
        const isModalOpen = !document.getElementById('bed-modal-overlay')?.classList.contains('hidden');
        if (isModalOpen) {
          // 編集モーダルのIC登録欄（自動登録）
          const editInput = document.getElementById('m-ic-tag-id');
          if (editInput) {
            editInput.value = uid;
            document.getElementById('btn-update-ic-tag')?.click();
            return;
          }
          // 新規移送開始フォームのIC入力欄（フィールド入力）
          const newInput = document.getElementById('f-ic-tag-id');
          if (newInput && !newInput.disabled) {
            newInput.value = uid;
            UI.toast('ICカードを読み取りました', 'info');
            return;
          }
        }
        // 検査室タブのスキャン処理
        if (typeof ExamRoom !== 'undefined' && ExamRoom._handleScan) {
          ExamRoom._handleScan(uid);
        }
      });
    }

    // マスタ読み込み
    await this.loadMasters();

    // 病棟セレクトの動的同期
    this.syncWardSelect();

    // デモデータ投入（初回のみ）＆マスタ更新
    await DemoData.setup();

    // マスタ再読み込み（デモデータがmap_col等を更新した可能性があるため）
    await this.loadMasters();

    // 再度同期
    this.syncWardSelect();

    // 通話パネル描画（マスタ読み込み後）
    CallPanel._renderCallPanel();

    // イベントデータ読み込み
    await this.refreshData();
    this._primeNotificationBaseline();

    // 初期表示・フォント設定の適用
    await this.applySystemVisualSettings();

    // 初期レンダリング
    WardDashboard.render();

    // ポーリング開始
    this.startPolling();
    // 子機では親機側の病床マスター変更（追加・変更・削除）を定期的に反映する。
    this.startMasterSync();

    // 初期設定ウィザードの自動起動チェック
    const wizardSetting = AppState.systemSettings?.find(s => s.id === 'wizard_completed');
    if (!wizardSetting || wizardSetting.value !== 'true') {
      setTimeout(() => {
        Wizard.open();
      }, 500);
    } else {
      // 通常運用時のみ、日跨ぎ（帰棟し忘れ）の未完了出棟をチェックして通知する
      // （初回セットアップ中はウィザードを優先し邪魔しない）
      setTimeout(() => this.checkCarriedOver(), 800);
    }

    // デスクトップアプリ用自動インポートのリスナー登録
    if (window.electronAPI) {
      console.log('[Electron] 患者・在床情報のインポートリスナーを設定しています...');
      
      // 成功時
      window.electronAPI.onDataImported((payload = {}) => {
        // 監視と手動スキャンが同時に複数CSVを検出しても、病床マスターの更新を
        // 1ファイルずつ完了させる。並行更新によるrevision競合と取り込み失敗を防ぐ。
        this._dataImportPromise = this._dataImportPromise
          .catch(error => console.error('[Import] 前の取り込み処理が失敗しました:', error))
          .then(async () => {
        const { importId, fileName, rows = [] } = payload;
        console.log(`[Electron] インポートデータを受信 (${fileName}): ${rows.length}件`);

        // 子機から親機の連携設定を変更した直後でも、親機rendererの古いキャッシュを
        // 使わないよう、取り込み開始時に設定・病床マスターを必ず読み直す。
        const mastersLoaded = await App.loadMasters({ silent: true, loadHandover: false });
        if (!mastersLoaded) {
          if (importId && window.electronAPI.completeDataImport) {
            await window.electronAPI.completeDataImport({ importId, success: false }).catch(() => {});
          }
          UI.toast('CSV取り込み前の最新設定を取得できませんでした。原本は監視フォルダに残しています。', 'danger', 8000);
          return;
        }

        let activeBedIds;
        try {
          const eventResult = await API.getAll('transfer_events', { active_only: 'true' });
          activeBedIds = new Set(
            (eventResult?.data || [])
              .filter(event => CONFIG.ACTIVE_STATUSES.includes(event.current_status))
              .map(event => event.bed_id)
          );
        } catch (error) {
          console.error('[Import] 進行中移送の取得に失敗しました:', error);
          if (importId && window.electronAPI.completeDataImport) {
            await window.electronAPI.completeDataImport({ importId, success: false }).catch(() => {});
          }
          UI.toast('進行中の移送情報を確認できないため、CSV取り込みを中止しました。原本は残しています。', 'danger', 8000);
          return;
        }

        const admMode = AppState.systemSettings?.find(s => s.id === 'admission_mode')?.value || 'csv';

        let importedCount = 0;
        let skipCount = 0;
        // 進行中の移送がある病床で患者が入れ替わった件数（取り込み後にまとめて警告する）
        const overwrittenActiveBeds = [];

        // 病床の在室者が同一人物かの判定。サーバ側 isSameBedOccupant と優先順を揃える
        // （両者にpatient_idがあればそれで比較し、無ければ氏名で比較する）
        const hasOccupant = (rec) => Boolean(rec && (rec.patient_id || rec.patient_name));
        const isSameOccupant = (before, after) => {
          if (!hasOccupant(before) || !hasOccupant(after)) return false;
          if (before.patient_id && after.patient_id) {
            return String(before.patient_id) === String(after.patient_id);
          }
          return String(before.patient_name || '') === String(after.patient_name || '');
        };

        // ポリシー設定のロード
        let policy = { action: 'archive', retentionDays: '30', clearUnlisted: false };
        const policySetting2 = AppState.systemSettings?.find(s => s.id === 'import_retention_policy');
        if (policySetting2?.value) {
          try { policy = JSON.parse(policySetting2.value); } catch(e) {}
        }

        // カラムマッピングのロード
        let mapping = { bed_number: '', patient_id: '', patient_name: '', is_present: '' };
        const mappingSetting = AppState.systemSettings?.find(s => s.id === 'import_mapping');
        if (mappingSetting && mappingSetting.value) {
          try {
            mapping = JSON.parse(mappingSetting.value);
          } catch (e) {
            console.error('[Import] マッピング設定のパース失敗:', e);
          }
        }

        // Default import mapping. Also auto-detect common Japanese EMR CSV headers.
        const sampleRow = rows.find(row => row && Object.keys(row).length > 0) || {};
        const pickColumn = (...names) => names.find(name => Object.prototype.hasOwnProperty.call(sampleRow, name)) || '';
        const mapBed = mapping.bed_number || pickColumn('bed_number', '\u75c5\u5e8a\u756a\u53f7') || 'bed_number';
        const mapRoomCode = mapping.room_code || pickColumn('room_code', '\u75c5\u5ba4\u30b3\u30fc\u30c9');
        const mapBedCode = mapping.bed_code || pickColumn('bed_code', '\u75c5\u5e8a\u30b3\u30fc\u30c9');
        const joinChar = mapping.join_char !== undefined ? mapping.join_char : '-';

        const mapPatId = mapping.patient_id || pickColumn('patient_id', '\u60a3\u8005ID') || 'patient_id';
        const mapPatName = mapping.patient_name || pickColumn('patient_name', '\u6f22\u5b57\u6c0f\u540d', '\u60a3\u8005\u6c0f\u540d', '\u6c0f\u540d') || 'patient_name';
        const mapPresent = mapping.is_present || pickColumn('is_present');

        const bulkUpdates = [];
        const listedBedIds = new Set();
        const seenImportedBedIds = new Set();
        for (const row of rows) {
          try {
            // 1. Resolve the target bed from either a combined bed number or room/bed codes.
            let bedNoVal = '';
            let bedCandidates = [];
            let roomVal = '';
            let bedVal = '';
            
            const isCombined = Boolean(mapping.room_code && mapping.bed_code);
            if (isCombined) {
              roomVal = (row[mapRoomCode] || '').trim();
              bedVal = (row[mapBedCode] || '').trim();
              if (roomVal && bedVal) {
                bedNoVal = `${roomVal}${joinChar}${bedVal}`;
                bedCandidates = [
                  `${roomVal}${joinChar}${bedVal}`,
                  `${roomVal}${bedVal}`,
                  `${roomVal}_${bedVal}`,
                  `${roomVal}/${bedVal}`,
                  `${roomVal} ${bedVal}`
                ];
              } else {
                bedNoVal = roomVal || bedVal;
                bedCandidates = [bedNoVal];
              }
            } else {
              bedNoVal = (row[mapBed] || '').trim();
              bedCandidates = [bedNoVal];
            }

            if (!bedNoVal) {
              skipCount++;
              continue;
            }

            const normalizedCandidates = new Set(bedCandidates.filter(Boolean).map(v => String(v).trim()));
            const bed = AppState.beds.find(b => {
              const bedNumber = String(b.bed_number || '').trim();
              if (normalizedCandidates.has(bedNumber)) return true;

              if (roomVal && bedVal) {
                const masterRoom = String(b.room_code || b.room_number || '').trim();
                const masterBedCode = String(b.bed_code || '').trim();
                if (masterRoom === roomVal && masterBedCode === bedVal) return true;
                if (masterRoom === roomVal && bedNumber === bedVal) return true;
              }

              return false;
            });
            if (!bed) {
              console.warn(`[Import] 該当する病床が見つかりません: ${bedNoVal}`);
              skipCount++;
              continue;
            }

            // 同じ病床がCSVに複数行ある場合は、最後の行だけを暗黙に採用せず安全側に倒す。
            if (seenImportedBedIds.has(bed.id)) {
              console.warn(`[Import] 同一病床の重複行をスキップしました: ${bedNoVal}`);
              skipCount++;
              continue;
            }

            // ハイブリッド運用では、手動登録した病床の患者情報をCSVで上書きしない。
            // 未掲載病床のクリア対象からも除外するため listed に記録する。
            if (admMode === 'hybrid' && bed.manually_registered) {
              listedBedIds.add(bed.id);
              console.warn(`[Import] 手動登録病床をCSV更新から保護しました: ${bedNoVal}`);
              skipCount++;
              continue;
            }

            // 2. Update patient information.
            const patientName = (row[mapPatName] || '').trim();
            const patientId = (row[mapPatId] || '').trim();
            const isPresentValue = mapPresent ? (row[mapPresent] || '').trim() : '';
            const hasPatient = Boolean(patientName || patientId);
            const emptyBedLabel = '\u7a7a\u5e8a';
            
            const isPresent = mapPresent
              ? ['\u3044\u308b', '\u5728\u5e8a', '1', 'true', 'yes', 'y'].includes(isPresentValue.toLowerCase())
              : hasPatient;

            const patch = {
              id: bed.id,
              patient_name: hasPatient && patientName !== emptyBedLabel ? patientName : null,
              patient_id: hasPatient && patientName !== emptyBedLabel ? patientId : null,
              is_present: hasPatient && patientName !== emptyBedLabel ? isPresent : false,
              _occupancySource: 'csv_import'
            };

            // 進行中の移送がある病床の患者が入れ替わる場合、移送イベント側は登録時の
            // 患者名スナップショットを持ち続けるため、帰棟までダッシュボードと移送情報で
            // 別々の患者が表示される。電子カルテを正として上書き自体は続けるが、
            // 気づかないまま進まないよう取り込み後に警告する。
            if (activeBedIds.has(bed.id) && !isSameOccupant(bed, patch)) {
              overwrittenActiveBeds.push(bed.bed_number || bed.id);
            }

            seenImportedBedIds.add(bed.id);
            listedBedIds.add(bed.id);
            bulkUpdates.push(patch);
            importedCount++;
          } catch (err) {
            console.error('[Import] エラー発生:', err);
            skipCount++;
          }
        }

        // CSVに載っていない病床を空床にする（在室患者のみ出力EMR向け）
        let clearCount = 0;
        if (policy.clearUnlisted) {
          if (rows.length === 0) {
            console.warn('[Import] clearUnlisted: CSVが0件のため空床化をスキップしました');
            UI.toast('CSVが空だったため、未掲載病床の空床化はスキップしました。', 'warning', 6000);
          } else if (listedBedIds.size === 0) {
            // マッピング誤りや別形式のCSVで全病床を消さないため、有効な病床を
            // 1件も確認できない場合だけ空床化を止める。一部の不明行は妨げない。
            console.warn('[Import] 有効な病床行を確認できないため、未掲載病床の空床化をスキップしました');
            UI.toast('CSVから有効な病床を1件も確認できないため、未掲載病床の空床化をスキップしました。', 'warning', 6000);
          } else {
            for (const bed of AppState.beds) {
              if (!listedBedIds.has(bed.id) && (bed.patient_name || bed.patient_id) && !activeBedIds.has(bed.id)) {
                // ハイブリッドモードでは手動登録済み病床をCSVクリアから保護
                if (admMode === 'hybrid' && bed.manually_registered) continue;
                bulkUpdates.push({ id: bed.id, patient_name: null, patient_id: null, is_present: false, _occupancySource: 'csv_clear' });
                clearCount++;
              }
            }
          }
        }

        let writeError = null;
        if (bulkUpdates.length > 0) {
          try {
            const result = await API.bulkPatch('beds', bulkUpdates);
            if (result?.success === false) {
              throw new Error(result.message || '病床情報の更新に失敗しました');
            }
          } catch (err) {
            console.error('[Import] バルクアップデートエラー:', err);
            writeError = err;
          }
        }

        if (writeError) {
          if (importId && window.electronAPI.completeDataImport) {
            await window.electronAPI.completeDataImport({ importId, success: false }).catch(() => {});
          }
          try {
            await API.create('import_logs', {
              id: `log-${Date.now()}`,
              timestamp: Date.now(),
              fileName,
              status: 'failed',
              message: '病床情報の更新に失敗しました。原本は監視フォルダに残しています。',
              details: writeError.message
            });
          } catch (e) {
            console.error('[Import] 失敗ログの書き込み失敗:', e);
          }
          UI.toast('CSVは読み込みましたが、病床情報の保存に失敗しました。原本を確認してください。', 'danger', 8000);
          return;
        }

        // DB更新が成功した後だけ、mainへ原本の整理を依頼する。
        if (importId && window.electronAPI.completeDataImport) {
          const archiveResult = await window.electronAPI.completeDataImport({ importId, success: true }).catch(() => null);
          if (archiveResult && archiveResult.success === false) {
            console.warn('[Import] 原本の整理依頼に失敗しました:', archiveResult.message);
            UI.toast('病床情報は保存されましたが、CSV原本を整理できませんでした。監視フォルダを確認してください。', 'warning', 8000);
          }
        }

        const hasWarning = skipCount > 0;
        const changedCount = importedCount + clearCount;
        const status = (changedCount === 0 && rows.length > 0) ? 'warning' : (hasWarning ? 'warning' : 'success');
        const clearPart = clearCount > 0 ? `, 退院クリア: ${clearCount}件` : '';
        const detailMsg = `インポート成功: ${importedCount}件, スキップ: ${skipCount}件${clearPart}`;
        const logMsg = changedCount > 0
          ? `${importedCount}件の患者情報を更新しました。${clearCount > 0 ? `（${clearCount}件を退院済みとしてクリア）` : ''}`
          : '更新対象の有効な病床データがありませんでした。';

        // ログ書き込み
        try {
          await API.create('import_logs', {
            id: `log-${Date.now()}`,
            timestamp: Date.now(),
            fileName: fileName,
            status: status,
            message: logMsg,
            details: detailMsg
          });
        } catch (e) {
          console.error('[Import] ログの書き込み失敗:', e);
        }

        // マスタデータ（beds）を再読み込みし、画面を再描画する
        await App.loadMasters();
        await App.refreshData();
        
        const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
        if (currentPage === 'ward-dashboard') {
          WardDashboard.render();
        } else if (currentPage === 'settings') {
          // 設定画面を開いている場合は、ログテーブル等を更新するために再描画
          Settings.render();
        }
        
        const importToastEnabled = AppState.systemSettings?.find(s => s.id === 'notification_import_toast')?.value !== 'false';
        if (importToastEnabled) {
          if (changedCount > 0) {
            const clearNote = clearCount > 0 ? ` / 退院クリア: ${clearCount}件` : '';
            UI.toast(`📂 ${importedCount} 件の患者・在床情報を更新しました (スキップ: ${skipCount}件${clearNote})`, 'success');
          } else {
            UI.toast(`📂 CSVインポート完了: 更新なし (スキップ: ${skipCount}件)`, 'warning');
          }
        }

        // 移送中の病床で患者が入れ替わった場合の警告。取り込み通知のON/OFF設定に
        // かかわらず出す（空床化スキップの警告と同じ扱い）
        if (overwrittenActiveBeds.length > 0) {
          const shown = overwrittenActiveBeds.slice(0, 5).join('、');
          const more = overwrittenActiveBeds.length > 5 ? ` ほか${overwrittenActiveBeds.length - 5}件` : '';
          UI.toast(
            `⚠️ 移送中の${overwrittenActiveBeds.length}床でCSVにより患者情報が変わりました（${shown}${more}）。帰棟までダッシュボードと移送情報の患者名が食い違います。`,
            'warning',
            12000
          );
        }
          })
          .catch(async error => {
            console.error(`[Import] CSV取り込み処理に失敗しました (${payload.fileName || 'ファイル名不明'}):`, error);
            if (payload.importId && window.electronAPI.completeDataImport) {
              await window.electronAPI.completeDataImport({ importId: payload.importId, success: false }).catch(() => {});
            }
            UI.toast('CSV取り込み処理に失敗しました。原本は監視フォルダに残しています。', 'danger', 8000);
          });
      });

      // 失敗時
      window.electronAPI.onDataImportFailed(async ({ importId, fileName, error }) => {
        console.error(`[Electron] インポート失敗 (${fileName}):`, error);
        if (importId && window.electronAPI.completeDataImport) {
          await window.electronAPI.completeDataImport({ importId, success: false }).catch(() => {});
        }
        
        // 失敗ログ書き込み
        try {
          await API.create('import_logs', {
            id: `log-${Date.now()}`,
            timestamp: Date.now(),
            fileName: fileName,
            status: 'failed',
            message: `パースまたは読み込みに失敗しました。`,
            details: error
          });
        } catch (e) {
          console.error('[Import] ログの書き込み失敗:', e);
        }

        const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
        if (currentPage === 'settings') {
          Settings.render();
        }

        UI.toast(`❌ CSVファイル ${fileName} の読み込みに失敗しました: ${error}`, 'danger', 6000);
      });

      if (window.electronAPI.onArchiveError) {
        window.electronAPI.onArchiveError(async ({ fileName, archiveDir, error, code }) => {
          console.error(`[Electron] アーカイブエラー (${fileName}):`, error);
          try {
            await API.create('import_logs', {
              id: `log-${Date.now()}`,
              timestamp: Date.now(),
              fileName: fileName,
              status: 'archive_error',
              message: 'archiveフォルダへの移動に失敗しました。',
              details: error
            });
          } catch (e) {
            console.error('[Import] ログの書き込み失敗:', e);
          }
          UI.toast(
            `⚠️ ${fileName} のarchive移動に失敗しました。<br>` +
            (code === 'EPERM' || code === 'EACCES'
              ? '権限がありません。設定の「処理完了後のファイル処理」を「そのまま残す」に変更してください。'
              : error),
            'warning',
            10000
          );
        });
      }

      window.electronAPI.getWatchDirectory().then(dir => {
        console.log(`[Electron] 監視中のフォルダ: ${dir}`);
      });

      // スケジュール取り込み成功時
      if (window.electronAPI.onScheduleImported) {
        window.electronAPI.onScheduleImported(async ({ success = true, feedId, feedName, fileName, count, message }) => {
          if (success === false) {
            console.error(`[ScheduleFeed] "${feedName}" 取り込み失敗 (${fileName}): ${message || '保存に失敗しました'}`);
            UI.toast(`⚠️ ${feedName}: ${message || 'スケジュールの保存に失敗しました'}`, 'warning', 10000);
            return;
          }
          console.log(`[ScheduleFeed] "${feedName}" 取り込み完了 (${fileName}): ${count}件`);
          UI.toast(`📅 ${feedName}: ${count}件のスケジュールを取り込みました`, 'info');
          await App.refreshData({ force: true });
          const activePage = document.querySelector('.page.active');
          if (activePage && activePage.id === 'page-ward-dashboard') {
            WardDashboard.render();
          } else if (activePage && activePage.id === 'page-timeline') {
            Timeline._renderFullTimeline().catch(console.error);
          }
        });
      }
    }

    // タイマー更新 (30秒ごとに残り時間表示を更新)
    // 病床マップ・優先対応一覧は病棟ダッシュボードにしか存在しないため、
    // 他ページ表示中はDOM更新自体が無駄になる。ダッシュボード表示中は
    // 5秒間隔ポーリングの再描画がこれより高頻度でカバーするが、通信断・
    // バックオフ中でも時刻依存の表示（残り時間・遅延判定）が固まらないよう
    // フォールバックとして残す。
    if (this._uiRefreshTimer) clearInterval(this._uiRefreshTimer);
    this._uiRefreshTimer = setInterval(() => {
      const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
      if (currentPage === 'ward-dashboard') {
        BedMap.updateTimers();
        Priority.renderSummary();
        Priority.renderKpi();
        Priority.renderPriorityList();
      }
      this._checkNotifications();
    }, 30000);

    // バージョン表示
    if (window.electronAPI?.getAppVersion) {
      const ver = await window.electronAPI.getAppVersion().catch(() => null);
      if (ver) {
        AppState.appVersion = ver;
        this._renderAppVersion();
      }
    }

    // 稼働モード設定の整合性チェック（ローカルDBとlocalStorageの不整合を自動修復）
    await this._repairLocalShareMode();

    // 子機モードのみ：ハートビート送信と接続断検知
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    if (shareMode === 'client' || shareMode === 'child') {
      this._startHeartbeat();
    }

    // 起動時の設定サマリを診断ログへ記録（DevTools操作なしで状態確認できるように）
    if (window.electronAPI?.appendDebugLog) {
      const token = await API.getTerminalApiToken();
      const tokenSummary = token ? '設定あり' : '未設定';
      window.electronAPI.appendDebugLog(
        `[App起動] version=${AppState.appVersion || '?'} cfg_share_mode=${shareMode} ` +
        `cfg_parent_ip=${localStorage.getItem('cfg_parent_ip') || '(未設定)'} cfg_api_token=${tokenSummary}`
      ).catch(() => {});
    }

    // 単独運用モードのUI反映（検査室タブ・通話ボタン・接続端末チップの非表示）
    this._applyStandaloneMode();

    // アプリ更新チェック（親機は自身の配信フォルダ、子機は親機を参照）
    this._startUpdateCheck();
    this._startDevicePresenceMonitor();

    console.log('[App] 初期化完了');
  },

  // ── 稼働モード設定のセルフリペア ──
  // 過去の不具合で、子機の設定保存が親機のローカルDBの share_mode を 'client' に
  // 上書きしてしまうことがあった（その状態で親機を再起動すると共有サーバーが
  // 起動しなくなり、子機が全断する）。main.js はローカルDBの share_mode で
  // サーバー起動を判定するため、localStorage（この端末の真の役割）とローカルDBが
  // 食い違っていたらローカルDB側を修復する。
  async _repairLocalShareMode() {
    if (!window.electronAPI?.dbRequest) return;
    try {
      const localMode = localStorage.getItem('cfg_share_mode') || 'parent';
      const rec = await window.electronAPI.dbRequest({ url: 'tables/system_settings/share_mode', options: { method: 'GET' } });
      const dbMode = rec?.value;
      if (!dbMode || dbMode === localMode) return;

      await window.electronAPI.dbRequest({
        url: 'tables/system_settings/share_mode',
        options: { method: 'PATCH', body: JSON.stringify({ value: localMode }) }
      });
      console.warn(`[App] ローカルDBの share_mode (${dbMode}) を端末設定 (${localMode}) に合わせて修復しました`);

      if (localMode === 'parent' && dbMode === 'client') {
        // 親機なのにDBが'client'だった = 共有サーバーが起動していない状態。再起動で復旧する
        const ok = await UI.confirmModal('稼働モード設定の不整合を検出し、自動修復しました。今すぐ再起動しますか？', {
          title: '設定の自動修復',
          detail: '親機の共有サーバー（ポート3005）が設定不整合のため停止していました。再起動すると子機からの接続を受け付けられるようになります。',
          confirmLabel: '再起動'
        });
        if (ok && window.electronAPI?.relaunchApp) {
          window.electronAPI.relaunchApp();
        } else {
          UI.toast('修復を反映するには、アプリの再起動が必要です', 'warning', 8000);
        }
      }
    } catch (e) {
      console.warn('[App] share_mode 整合性チェックに失敗:', e);
    }
  },

  _connectionLost: false,
  _syncPartial: false,
  _heartbeatTimer: null,
  _heartbeatInFlight: false,
  _heartbeatFailures: 0,
  _pollInFlight: false,
  _pollFailures: 0,
  _uiRefreshTimer: null,
  _devicePresenceTimer: null,
  _devicePresenceStartupTimer: null,
  _devicePresenceInFlight: false,
  _connectedDevicesSnapshot: [],
  _refreshPromise: null,
  _refreshKey: null,

  _jitterDelay(baseMs, ratio = 0.15) {
    const jitter = baseMs * ratio;
    return Math.max(250, Math.round(baseMs + ((Math.random() * 2 - 1) * jitter)));
  },

  _backoffDelay(baseMs, failures, maxMs) {
    const capped = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, failures - 1)));
    return this._jitterDelay(capped, 0.25);
  },

  _renderAppVersion() {
    let el = document.getElementById('app-version-badge');
    if (!el) {
      el = document.createElement('span');
      el.id = 'app-version-badge';
      el.className = 'app-version-badge';
      const headerRight = document.querySelector('.header-right');
      if (headerRight) headerRight.prepend(el);
    }
    if (el) el.textContent = `v${AppState.appVersion || '-'}`;
  },

  // ── アプリ更新チェック（自前アップデータ） ──
  _updateCheckTimer: null,

  _getUpdateParentIp() {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    if (shareMode === 'client' || shareMode === 'child') {
      return localStorage.getItem('cfg_parent_ip') || '';
    }
    return ''; // 親機は自分自身(127.0.0.1)の配信フォルダを参照する
  },

  _startUpdateCheck() {
    if (!window.electronAPI?.checkForUpdate) return;

    const check = async () => {
      if (localStorage.getItem('cfg_auto_update_check') === 'false') return;
      const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
      const parentIp = this._getUpdateParentIp();
      if ((shareMode === 'client' || shareMode === 'child') && !parentIp) return;
      const res = await window.electronAPI.checkForUpdate({ parentIp }).catch(() => null);
      if (res?.success && res.updateAvailable) {
        this._showUpdateAvailable(res);
      }
    };

    // 起動直後は初期同期と重ねない。以後は24時間ごと
    setTimeout(check, 15000);
    if (this._updateCheckTimer) clearInterval(this._updateCheckTimer);
    this._updateCheckTimer = setInterval(check, 24 * 60 * 60 * 1000);
  },

  _updateNotified: false,

  _showUpdateAvailable(info) {
    const badge = document.getElementById('app-version-badge');
    if (badge) {
      badge.classList.add('update-available');
      badge.innerHTML = `v${AppState.appVersion} <i class="fas fa-arrow-circle-up"></i> v${UI.escapeHTML(info.latestVersion)}`;
      badge.title = `新しいバージョン v${info.latestVersion} が利用可能です。クリックで更新`;
      badge.onclick = () => this._promptInstallUpdate(info);
    }
    if (!this._updateNotified) {
      this._updateNotified = true;
      UI.toast(`新しいバージョン v${info.latestVersion} が利用可能です（ヘッダーのバージョン表示から更新できます）`, 'info');
    }
  },

  async _promptInstallUpdate(info) {
    const ok = await UI.confirmModal(
      `TransBoard を v${info.latestVersion} に更新しますか？`,
      {
        title: 'アプリの更新',
        detail: 'ダウンロードと検証が終わると、Windowsの確認ダイアログがもう一つ表示されます（配布ファイルが未署名のため）。「署名なしで続行」を選択するとインストールが始まり、アプリが自動的に終了します（数十秒〜数分）。データは更新前に自動バックアップされます。',
        confirmLabel: '更新する'
      }
    );
    if (!ok) return;

    UI.toast('更新をダウンロードしています...', 'info');
    const res = await window.electronAPI.downloadAndInstallUpdate({ parentIp: this._getUpdateParentIp() }).catch(e => ({ success: false, message: e.message }));
    if (!res?.success) {
      UI.toast(`更新に失敗しました: ${res?.message || '不明なエラー'}`, 'danger');
    }
    // 成功時はメインプロセス側でインストーラが起動しアプリが終了する
  },

  _connectionLostReason: null,
  _disconnectSignalCount: 0,

  _setConnectionStatus(ok, reason = 'network') {
    // 親機疎通の失敗報告は、ポーリング(5秒)・ハートビート(10秒)・
    // ParentServerMonitor(30秒)の3系統が独立に検知してくる。いずれか1回の
    // 失敗で即座にバナーを出すと、瞬間的な遅延だけでも頻繁に点滅してしまう。
    // まだバナー非表示の状態からの新規失敗シグナルは、連続2回受けるまで
    // 静観する（成功が挟まればカウンタはリセットされる）。既にバナー表示中
    // なら理由の更新・復帰は従来通り即座に反映する。
    if (ok) {
      this._disconnectSignalCount = 0;
    } else if (!this._connectionLost) {
      this._disconnectSignalCount += 1;
      if (this._disconnectSignalCount < 2) return;
    }

    // 状態も理由も変わっていなければ何もしない（理由が変わったらバナー文言を更新する）
    if (ok === !this._connectionLost && (ok || reason === this._connectionLostReason)) return;
    this._connectionLost = !ok;
    this._connectionLostReason = ok ? null : reason;
    let banner = document.getElementById('connection-lost-banner');
    if (!ok) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'connection-lost-banner';
        document.body.appendChild(banner);
      }
      // 401（トークン不一致）はネットワーク断ではないため、原因が分かる文言に切り替える
      banner.innerHTML = reason === 'unauthorized'
        ? '<span><i class="fas fa-key"></i> APIトークンが親機と一致しません。</span>'
        : '<span><i class="fas fa-exclamation-triangle"></i> 親機との接続が切断されました。</span>';
      banner.insertAdjacentHTML('beforeend', `
        <button type="button" class="btn btn-sm btn-outline" id="btn-open-connection-settings" style="margin-left:10px; padding:3px 8px; font-size:11px;">
          <i class="fas fa-cog"></i> 接続設定
        </button>
        <button type="button" class="btn btn-sm btn-outline" id="btn-open-connection-test" style="margin-left:6px; padding:3px 8px; font-size:11px;">
          <i class="fas fa-link"></i> 接続テストへ
        </button>
      `);
      const openConnectionSettings = () => {
        document.querySelector('.tab-btn[data-page="settings"]')?.click();
        setTimeout(() => document.getElementById('client-config-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
      };
      document.getElementById('btn-open-connection-settings')?.addEventListener('click', openConnectionSettings);
      document.getElementById('btn-open-connection-test')?.addEventListener('click', () => {
        openConnectionSettings();
        setTimeout(() => document.getElementById('btn-test-connection')?.focus(), 350);
      });
    } else {
      if (banner) banner.remove();
    }
    this._renderDevicePresence(this._connectedDevicesSnapshot || [], null);
  },

  _startHeartbeat() {
    const deviceId = (() => {
      let id = localStorage.getItem('_device_id');
      if (!id) { id = `dev-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; localStorage.setItem('_device_id', id); }
      return id;
    })();

    let _cachedHostname = null;
    if (window.electronAPI?.getHostname) {
      window.electronAPI.getHostname().then(h => { _cachedHostname = h || null; }).catch(() => {});
    }

    const sendHeartbeat = async () => {
      if (this._heartbeatInFlight) return;
      this._heartbeatInFlight = true;
      const wardId = AppState.currentWardId || localStorage.getItem('current_ward_id') || '';
      try {
        const res = await API.deviceHeartbeat({
          deviceId,
          name: localStorage.getItem('_device_name') || deviceId,
          hostname: _cachedHostname || undefined,
          wardId,
          mode: localStorage.getItem('cfg_share_mode') || 'client',
          appVersion: AppState.appVersion || '',
          page: document.querySelector('.tab-btn.active')?.dataset.page || ''
        });
        const ok = res !== null;
        this._setConnectionStatus(ok);
        return ok;
      } catch (e) {
        console.warn('[Heartbeat] failed:', e);
        this._setConnectionStatus(false);
        return false;
      } finally {
        this._heartbeatInFlight = false;
      }
    };

    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatFailures = 0;
    const scheduleHeartbeat = (delayMs) => {
      this._heartbeatTimer = setTimeout(async () => {
        const ok = await sendHeartbeat();
        if (ok === false) {
          this._heartbeatFailures = Math.min(this._heartbeatFailures + 1, 6);
        } else if (ok === true) {
          this._heartbeatFailures = 0;
        }
        const nextDelay = this._heartbeatFailures
          ? this._backoffDelay(10000, this._heartbeatFailures, 60000)
          : this._jitterDelay(10000);
        scheduleHeartbeat(nextDelay);
      }, delayMs);
    };
    scheduleHeartbeat(this._jitterDelay(1000, 0.8));
  },

  _startDevicePresenceMonitor() {
    if (this._devicePresenceTimer) clearInterval(this._devicePresenceTimer);
    if (this._devicePresenceStartupTimer) clearTimeout(this._devicePresenceStartupTimer);
    // 単独運用モードでは接続端末チップを表示しないため、5秒ごとのポーリング自体を止める
    if (this.isStandalone()) return;
    const refresh = () => this._refreshDevicePresence().catch(() => {});
    this._devicePresenceStartupTimer = setTimeout(() => {
      this._devicePresenceStartupTimer = null;
      refresh();
    }, this._jitterDelay(1200, 0.5));
    this._devicePresenceTimer = setInterval(refresh, 5000);
  },

  async _refreshDevicePresence() {
    if (this._devicePresenceInFlight) return;
    this._devicePresenceInFlight = true;
    try {
      const result = await API.getConnectedDevices();
      const devices = Array.isArray(result) ? result : (result?.devices || []);
      this._connectedDevicesSnapshot = devices;
      this._renderDevicePresence(devices, null);
    } catch (e) {
      console.warn('[DevicePresence] failed:', e);
      this._renderDevicePresence(this._connectedDevicesSnapshot || [], e);
    } finally {
      this._devicePresenceInFlight = false;
    }
  },

  _renderDevicePresence(devices, error) {
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const isChild = shareMode === 'client' || shareMode === 'child';
    const summary = DevicePresence.summarize(devices, {
      currentWardId: AppState.currentWardId,
      parentVersion: AppState.appVersion,
      hasConnectionProblem: isChild && this._connectionLost,
      connectionReason: this._connectionLostReason,
      error,
    });

    const wardEl = document.getElementById('device-presence-display');
    if (wardEl) {
      wardEl.className = `device-presence-chip ${summary.stateClass}`;
      if (isChild) {
        const parentState = this._connectionLost
          ? (this._connectionLostReason === 'unauthorized' ? '親機: トークン不一致' : '親機: 再接続中')
          : '親機: 接続中';
        this._updateDevicePresenceChip(wardEl, `<i class="fas fa-network-wired"></i> ${parentState} / 同じ病棟 ${summary.currentWardCount}台 / 検査室 ${summary.examCount}台${summary.warningNote}`, summary, error);
      } else {
        this._updateDevicePresenceChip(wardEl, `<i class="fas fa-network-wired"></i> 接続端末: ${summary.total}台 / この病棟 ${summary.currentWardCount} / 検査室 ${summary.examCount} / 不明 ${summary.unknownCount}${summary.warningNote}${summary.childNote}`, summary, error);
      }
    }

    const examEl = document.getElementById('exam-device-presence');
    if (examEl) {
      examEl.className = `device-presence-chip ${summary.stateClass}`;
      if (isChild) {
        const parentState = this._connectionLost
          ? (this._connectionLostReason === 'unauthorized' ? '親機トークン不一致' : '親機再接続中')
          : '親機接続中';
        this._updateDevicePresenceChip(examEl, `<i class="fas fa-network-wired"></i> ${parentState} / 病棟端末 ${summary.wardPageCount}台 / 検査室端末 ${summary.examCount}台${summary.warningNote}`, summary, error);
      } else {
        this._updateDevicePresenceChip(examEl, `<i class="fas fa-network-wired"></i> 病棟端末 ${summary.wardPageCount}台 / 検査室端末 ${summary.examCount}台${summary.warningNote}`, summary, error);
      }
    }
  },

  _updateDevicePresenceChip(el, html, summary, error) {
    el.innerHTML = html;
    el.title = `${summary.title}\nクリックで端末詳細を表示`;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', '接続端末の詳細を表示');
    el.onclick = (event) => {
      event.stopPropagation();
      this._toggleDevicePresencePopover(el, summary.devices, error);
    };
    el.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this._toggleDevicePresencePopover(el, summary.devices, error);
      }
    };
  },

  _toggleDevicePresencePopover(anchor, devices, error) {
    const existing = document.getElementById('device-presence-popover');
    if (existing && existing.dataset.anchorId === anchor.id) {
      existing.remove();
      return;
    }
    if (existing) existing.remove();

    const popover = document.createElement('div');
    popover.id = 'device-presence-popover';
    popover.className = 'device-presence-popover';
    popover.dataset.anchorId = anchor.id || '';
    popover.innerHTML = this._renderDevicePresencePopover(devices, error);
    document.body.appendChild(popover);

    const rect = anchor.getBoundingClientRect();
    const top = rect.bottom + window.scrollY + 8;
    const maxLeft = window.scrollX + window.innerWidth - popover.offsetWidth - 12;
    const left = Math.max(12 + window.scrollX, Math.min(rect.left + window.scrollX, maxLeft));
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;

    const close = (event) => {
      if (!popover.contains(event.target) && event.target !== anchor) {
        popover.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  },

  _renderDevicePresencePopover(devices, error) {
    if (error) {
      return '<div class="device-popover-title">接続端末</div><div class="device-popover-empty">端末一覧を取得できませんでした</div>';
    }
    const safeDevices = Array.isArray(devices) ? devices : [];
    const rows = safeDevices.slice(0, 12).map(device => {
      const name = UI.escapeHTML(device.name || device.hostname || device.deviceId || device.id || '端末');
      const page = UI.escapeHTML(this._devicePageLabel(device.page || device.mode || ''));
      const ward = UI.escapeHTML(device.wardId || '-');
      const seconds = DevicePresence.secondsSince(device);
      const seen = seconds === null ? '不明' : `${seconds}秒前`;
      const version = device.appVersion ? `v${UI.escapeHTML(device.appVersion)}` : '';
      const stale = seconds !== null && seconds > 20;
      return `
        <div class="device-popover-row ${stale ? 'stale' : ''}">
          <div class="device-popover-main">
            <span class="device-popover-name">${name}</span>
            <span class="device-popover-meta">${page} / 病棟 ${ward}</span>
          </div>
          <div class="device-popover-sub">${UI.escapeHTML(seen)}${version ? ` / ${version}` : ''}</div>
        </div>
      `;
    }).join('');
    const extra = safeDevices.length > 12
      ? `<div class="device-popover-more">ほか ${safeDevices.length - 12} 台</div>`
      : '';
    return `
      <div class="device-popover-title">接続端末 ${safeDevices.length}台</div>
      ${rows || '<div class="device-popover-empty">接続端末はありません</div>'}
      ${extra}
    `;
  },

  _devicePageLabel(page) {
    const labels = {
      'ward-dashboard': '病棟画面',
      'exam-room': '検査室画面',
      settings: '設定画面',
      timeline: 'タイムライン',
    };
    return labels[page] || page || '不明';
  },

  syncWardSelect() {
    const select = document.getElementById('ward-select');
    if (select) {
      const savedWardId = localStorage.getItem('current_ward_id');
      const current = [savedWardId, AppState.currentWardId, select.value]
        .find(id => id && AppState.wards.some(w => w.id === id));
      select.replaceChildren(...AppState.wards.map(ward => {
        const option = document.createElement('option');
        option.value = String(ward.id || '');
        option.textContent = String(ward.name || '');
        return option;
      }));
      if (current) {
        select.value = current;
        AppState.currentWardId = current;
      } else if (AppState.wards.length > 0) {
        select.value = AppState.wards[0].id;
        AppState.currentWardId = AppState.wards[0].id;
      }
      localStorage.setItem('current_ward_id', AppState.currentWardId);
    }
  },

  async loadMasters({ silent = false, loadHandover = true } = {}) {
    try {
      const [wards, beds, bedTypes, examRooms, examTypes, allStaffs, systemSettings] = await Promise.all([
        API.getWards(),
        API.getAllBeds(),
        API.getBedTypes().catch(() => [
          { id: 'bed-type-normal', code: 'normal', name: '一般', sort_order: 1, is_active: true },
          { id: 'bed-type-isolation', code: 'isolation', name: '隔離', sort_order: 2, is_active: true },
          { id: 'bed-type-icu', code: 'icu', name: 'ICU', sort_order: 3, is_active: true }
        ]),
        API.getExamRooms(),
        API.getExamTypes(),
        // 単発の一時的な失敗でマスタ読み込み全体(wards/beds等)まで失敗させない
        // よう、staffsだけは前回ロード分へのフォールバックを許容する
        API.getAllStaffs().catch(() => null),
        API.getAll('system_settings').then(res => Array.isArray(res?.data) ? res.data : []).catch(() => [])
      ]);
      AppState.wards = wards;
      AppState.beds = beds;
      AppState.allBedTypes = bedTypes.slice().sort((a, b) => (a.sort_order || 99) - (b.sort_order || 99));
      AppState.bedTypes = bedTypes.filter(t => t.is_active !== false).sort((a, b) => (a.sort_order || 99) - (b.sort_order || 99));
      AppState.allExamRooms = examRooms;
      AppState.examRooms = examRooms.filter(r => r.is_active !== false);
      AppState.allExamTypes = examTypes;
      AppState.examTypes = examTypes.filter(t => t.is_active !== false);
      if (Array.isArray(allStaffs)) {
        AppState.allStaffs = allStaffs;
        AppState.staffs = allStaffs.filter(s => s.is_active);
      } else {
        AppState.allStaffs = AppState.allStaffs || [];
        AppState.staffs = AppState.staffs || [];
      }
      AppState.systemSettings = systemSettings;
      AppState.stickyNotes = [];
      console.log('[App] マスタ読み込み完了', { beds: beds.length, examRooms: examRooms.length, systemSettings: systemSettings.length });

      // 申し送りメモを読み込む（現在病棟）
      if (loadHandover && typeof Handover !== 'undefined') await Handover.load().catch(() => {});
      return true;

    } catch (e) {
      console.error('[App] マスタ読み込み失敗:', e);
      if (!silent && e?.unauthorized) {
        UI.toast('APIトークンが親機と一致しないため、患者データを取得できません。設定 → 共有・ネットワーク設定 でトークンを確認してください', 'danger', 8000);
      } else if (!silent) {
        UI.toast('マスタデータの読み込みに失敗しました', 'danger');
      }
      return false;
    }
  },

  startMasterSync() {
    if (this._masterSyncTimer) clearInterval(this._masterSyncTimer);
    this._masterSyncTimer = null;
    const mode = localStorage.getItem('cfg_share_mode') || 'parent';
    if (mode !== 'client' && mode !== 'child') return;
    this._masterSyncTimer = setInterval(async () => {
      if (this._masterSyncInFlight || this._refreshPromise) return;
      this._masterSyncInFlight = true;
      try {
        const refreshed = await this.loadMasters({ silent: true, loadHandover: false });
        if (refreshed) {
          this.syncWardSelect();
          if (typeof CallPanel !== 'undefined' && CallPanel._renderCallPanel) {
            CallPanel._renderCallPanel();
          }
          this.renderCurrentPageData();
        }
      } finally {
        this._masterSyncInFlight = false;
      }
    }, this._masterSyncIntervalMs);
  },

  async refreshData({ force = false } = {}) {
    const wardId = AppState.currentWardId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const refreshKey = `${wardId || ''}:${todayMs}`;
    if (this._refreshPromise) {
      if (!force && this._refreshKey === refreshKey) return this._refreshPromise;
      return this._refreshPromise.then(() => this.refreshData({ force }));
    }
    this._refreshKey = refreshKey;
    this._refreshPromise = this._refreshDataOnce(wardId, todayMs).finally(() => {
      this._refreshPromise = null;
      this._refreshKey = null;
    });
    return this._refreshPromise;
  },

  renderCurrentPageData() {
    const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
    if (currentPage === 'ward-dashboard') {
      WardDashboard.render();
    } else if (currentPage === 'exam-room') {
      ExamRoom._renderQueue();
    } else if (currentPage === 'timeline') {
      Timeline.render();
    }
  },

  async handleDataConflict(error, message = null) {
    if (!error?.conflict) return false;
    UI.toast(message || error.message || '他端末で更新済みです。最新状態に更新します。', 'warning', 6000);
    await this.refreshData({ force: true });
    this.renderCurrentPageData();
    return true;
  },

  async _refreshDataOnce(wardId, todayMs) {
    try {
      const dayEndMs = todayMs + 24 * 60 * 60 * 1000;
      const [eventResult, settingsResult, feedsResult, itemsResult] = await Promise.allSettled([
        API.getWardStatusEvents(wardId, todayMs),
        API.getAll('system_settings').then(res => res.data),
        API.getScheduleFeeds(),
        API.getScheduleItemsForRange(todayMs, dayEndMs)
      ]);
      if (eventResult.status === 'rejected') throw eventResult.reason;
      const eventStatus = eventResult.value;
      const partialSync = [settingsResult, feedsResult, itemsResult]
        .some(result => result.status === 'rejected');
      const systemSettings = settingsResult.status === 'fulfilled'
        ? settingsResult.value
        : (AppState.systemSettings || []);
      const scheduleFeeds = feedsResult.status === 'fulfilled'
        ? feedsResult.value
        : (AppState.scheduleFeeds || []);
      const scheduleItems = itemsResult.status === 'fulfilled'
        ? itemsResult.value
        : (AppState.scheduleItems || []);
      if (AppState.currentWardId !== wardId) return false;
      AppState.activeEvents = eventStatus.activeEvents || [];
      AppState.todayEvents = eventStatus.todayEvents || [];
      AppState.recentStatusLogs = eventStatus.recentStatusLogs || [];
      AppState.systemSettings = systemSettings;
      AppState.scheduleFeeds = scheduleFeeds || [];
      AppState.scheduleItems = scheduleItems || [];
      AppState.stickyNotes = [];
      AppState.lastUpdated = Date.now();

      this._setConnectionStatus(true);
      if (partialSync !== this._syncPartial) {
        this._syncPartial = partialSync;
        UI.toast(
          partialSync ? '一部の設定・予定データを更新できません。前回のデータを表示しています。' : 'すべてのデータ同期が回復しました',
          partialSync ? 'warning' : 'success',
          5000
        );
      }
      // 動的表示設定（フォント・ズーム・カードサイズ）を即時反映
      await this.applySystemVisualSettings();
      return true;
    } catch (e) {
      console.error('[App] データ更新失敗:', e);
      const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
      if (shareMode === 'client' || shareMode === 'child') {
        this._setConnectionStatus(false, e?.unauthorized ? 'unauthorized' : 'network');
      }
      return false;
    }
  },

  startPolling() {
    if (AppState.pollTimer) clearTimeout(AppState.pollTimer);
    this._pollFailures = 0;
    const tick = async () => {
      let ok = true;
      if (this._pollInFlight) {
        AppState.pollTimer = setTimeout(tick, this._jitterDelay(CONFIG.POLL_INTERVAL));
        return;
      }
      this._pollInFlight = true;
      try {
        const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
        ok = await this.refreshData();

        if (ok) {
          const localDateValue = TimelineDate.format();
          if (this._timelineLocalDate && this._timelineLocalDate !== localDateValue) {
            const timelineDateInput = document.getElementById('timeline-date');
            if (timelineDateInput?.value === this._timelineLocalDate) {
              timelineDateInput.value = localDateValue;
            }
            this._timelineLocalDate = localDateValue;
            this.checkCarriedOver();
          }

          if (currentPage === 'ward-dashboard') {
            WardDashboard.renderIfChanged(this._dashboardDataSignature());
          } else if (currentPage === 'exam-room') {
            ExamRoom._renderQueue();
          } else if (currentPage === 'timeline') {
            Timeline.render();
          }

          this._checkNotifications();

        }
      } catch (e) {
        ok = false;
        console.error('[App] ポーリング処理に失敗:', e);
      } finally {
        this._pollInFlight = false;
        this._pollFailures = ok ? 0 : Math.min(this._pollFailures + 1, 6);
        const nextDelay = this._pollFailures
          ? this._backoffDelay(CONFIG.POLL_INTERVAL, this._pollFailures, 60000)
          : this._jitterDelay(CONFIG.POLL_INTERVAL);
        AppState.pollTimer = setTimeout(tick, nextDelay);
      }
    };
    AppState.pollTimer = setTimeout(tick, this._jitterDelay(CONFIG.POLL_INTERVAL));
  },

  // 病棟ダッシュボードの描画に使う取得済みデータをそのまま文字列化した指紋。
  // 各フィールドが漏れると「変化したのに再描画されない」表示崩れになるため、
  // 手作りの部分的な指紋ではなく、実際にレンダリングへ渡す値そのものを使う。
  _dashboardDataSignature() {
    try {
      return JSON.stringify([
        AppState.activeEvents,
        AppState.todayEvents,
        AppState.recentStatusLogs,
        AppState.systemSettings,
        AppState.scheduleItems,
      ]);
    } catch {
      return null;
    }
  },

  async resetActiveEvents() {
    if (!await UI.confirmModal('出棟中の移送情報をリセットしますか？', {
      title: '進行中の移送をリセット',
      detail: '患者情報やマスタデータは消去されません。',
      type: 'danger',
      confirmLabel: 'リセットする'
    })) return false;
    if (window.electronAPI) {
      await window.electronAPI.resetDatabase();
    } else {
      await this._resetAllActiveEvents();
    }
    this._prevNotified = new Set();
    await this.loadMasters();
    await this.refreshData();
    WardDashboard.render();
    UI.toast('出棟中の移送情報をリセットしました', 'info');
    return true;
  },

  async _resetAllActiveEvents() {
    try {
      const events = await API.getActiveEvents(AppState.currentWardId);
      for (const e of events) {
        if (CONFIG.ACTIVE_STATUSES.includes(e.current_status)) {
          await API.completeEventForMaintenance(e.id, e.current_status);
        }
      }
    } catch (err) {
      console.error('[Reset]', err);
    }
  },

  // 通知チェック
  _prevNotified: new Set(),
  _lastEventStatuses: new Map(),

  _primeNotificationBaseline() {
    this._lastEventStatuses.clear();
    this._prevNotified.clear();
    (AppState.todayEvents || []).forEach(event => {
      this._lastEventStatuses.set(event.id, event.current_status);
    });
  },

  _updateNavBadge() {
    const badge = document.getElementById('nav-pickup-badge');
    if (!badge) return;
    const count = AppState.activeEvents.filter(e => e.current_status === 'PICKUP_REQUIRED').length;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  },

  // 日跨ぎ（帰棟し忘れ等）の未完了出棟を検出し、起動時・日付変更時に一度だけ通知する。
  // 同日中は localStorage の ack で再通知を抑止（翌日は再度通知）。患者安全のため自動では消さない。
  checkCarriedOver() {
    try {
      const todayStr = new Date().toDateString();
      this._lastDateStr = todayStr;
      const list = AppState.getCarriedOverEvents();
      if (!list || list.length === 0) return;
      if (localStorage.getItem('tbs_carryover_ack') === todayStr) return; // 本日は確認済み
      localStorage.setItem('tbs_carryover_ack', todayStr);
      UI.toast(`前日から未完了の出棟が ${list.length} 件あります。確認してください。`, 'warning', 8000);
      if (typeof CarryoverModal !== 'undefined') CarryoverModal.open(list);
    } catch (e) {
      console.error('[Carryover]', e);
    }
  },

  _getNotificationStatusLog(eventId, status) {
    return (AppState.recentStatusLogs || []).find(log => (
      String(log.transfer_event_id) === String(eventId) &&
      log.to_status === status &&
      log.from_status !== log.to_status
    )) || null;
  },

  _showStatusNotificationToast(message, type, duration, event) {
    const log = event ? this._getNotificationStatusLog(event.id, event.current_status) : null;
    const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
    const canAcknowledge = log &&
      CONFIG.WARD_ACK_STATUSES.includes(event.current_status) &&
      !log.acknowledged_at &&
      currentPage === 'ward-dashboard';
    UI.toast(message, type, canAcknowledge ? Math.max(duration, 10000) : duration, canAcknowledge ? {
      actionLabel: '確認する',
      onAction: () => this.acknowledgeNotification(log.id),
    } : {});
  },

  async acknowledgeNotification(logId) {
    try {
      const result = await API.acknowledgeStatusLog(logId, AppState.currentWardId);
      const updated = result?.log;
      if (updated) {
        const index = (AppState.recentStatusLogs || []).findIndex(log => String(log.id) === String(updated.id));
        if (index >= 0) AppState.recentStatusLogs[index] = { ...AppState.recentStatusLogs[index], ...updated };
      }
      if (typeof NotificationHistory !== 'undefined') NotificationHistory.render();
      UI.toast('検査室へ確認済みを送信しました', 'success', 3000);
      return true;
    } catch (error) {
      console.error('[Notification Ack]', error);
      UI.toast(`確認状態を送信できませんでした: ${error.message}`, 'danger', 5000);
      return false;
    }
  },

  _checkNotifications() {
    const now = Date.now();
    this._updateNavBadge();

    // 通知音設定のロード (デフォルト値)
    let soundSettings = {
      PICKUP_REQUIRED: { enabled: true, sound: 'alarm' },
      NEARLY_DONE: { enabled: true, sound: 'chime' },
      SOON: { enabled: true, sound: 'chime' },
      MOVING: { enabled: false, sound: 'ding' },
      ARRIVED: { enabled: false, sound: 'ding' },
      IN_EXAM: { enabled: false, sound: 'ding' },
      RETURNED: { enabled: false, sound: 'ding' }
    };
    // 子機は端末固有の localStorage 値を優先
    const _shareMode = localStorage.getItem('cfg_share_mode');
    const _localSounds = (_shareMode === 'client' || _shareMode === 'child')
      ? localStorage.getItem('tbs_notification_sounds') : null;
    if (_localSounds) {
      try {
        const localSettings = JSON.parse(_localSounds);
        if (
          localSettings?.DEPART_REGISTERED &&
          !Object.prototype.hasOwnProperty.call(localSettings, 'MOVING')
        ) {
          localSettings.MOVING = { ...localSettings.DEPART_REGISTERED };
        }
        soundSettings = { ...soundSettings, ...localSettings };
      } catch(e) {}
    } else {
      const soundSettingRec = AppState.systemSettings?.find(s => s.id === 'notification_sounds');
      if (soundSettingRec?.value) {
        try { soundSettings = { ...soundSettings, ...JSON.parse(soundSettingRec.value) }; } catch(e) {}
      }
    }

    // 今日の全イベントについてステータス変化をチェック
    (AppState.todayEvents || []).forEach(e => {
      const hadStatus = this._lastEventStatuses.has(e.id);
      const lastStatus = this._lastEventStatuses.get(e.id);
      const statusChanged = !hadStatus || lastStatus !== e.current_status;
      
      if (statusChanged) {
        // ステータスが変化した場合
        const cfg = soundSettings[e.current_status];
        if (cfg && cfg.enabled) {
          UI.playNotificationSound(cfg.sound);
        }
      }
      // 現在のステータスを記録
      this._lastEventStatuses.set(e.id, e.current_status);

      // ステータス変化時の汎用トースト（専用ハンドラーがあるステータスは除外）
      const DEDICATED_TOAST_STATUSES = new Set(['PICKUP_REQUIRED', 'NEARLY_DONE', 'SOON']);
      if (statusChanged &&
          !DEDICATED_TOAST_STATUSES.has(e.current_status)) {
        const cfg = soundSettings[e.current_status];
        if (cfg?.toast !== false) {
          const bed = AppState.getBedById(e.bed_id);
          const bedLabel = bed ? `${bed.bed_number}号床` : '';
          const statusLabel = CONFIG.STATUS_LABEL?.[e.current_status] || e.current_status;
          const patientName = bed?.patient_name ? `（${UI.getPatientName(bed.patient_name)}）` : '';
          const toastTypes = {
            RETURNED: 'success', ARRIVED: 'info', IN_EXAM: 'info',
            DEPART_REGISTERED: 'info', MOVING: 'info',
          };
          const toastType = toastTypes[e.current_status] || 'info';
          this._showStatusNotificationToast(`${bedLabel}${patientName} → ${statusLabel}`, toastType, 5000, e);
        }
      }

      // 迎え要通知
      if (e.current_status === 'PICKUP_REQUIRED' && !this._prevNotified.has(`pickup-${e.id}`)) {
        const bed = AppState.getBedById(e.bed_id);
        const cfg = soundSettings['PICKUP_REQUIRED'];
        if (cfg?.toast !== false) {
          this._showStatusNotificationToast(`🔔 ${bed ? bed.bed_number + '号床' : ''} 迎えが必要です！`, 'danger', 6000, e);
        }
        this._prevNotified.add(`pickup-${e.id}`);
      }

      // あと10分通知
      if (e.current_status === 'NEARLY_DONE' && !this._prevNotified.has(`nearly-${e.id}`)) {
        const bed = AppState.getBedById(e.bed_id);
        const cfg = soundSettings['NEARLY_DONE'];
        if (cfg?.toast !== false) {
          this._showStatusNotificationToast(`⏰ ${bed ? bed.bed_number + '号床' : ''} あと10分です`, 'warning', 5000, e);
        }
        this._prevNotified.add(`nearly-${e.id}`);
      }

      // 迎え目安5分前通知（時刻経過による特別トリガー）
      if (e.estimated_pickup_at && !this._prevNotified.has(`soon-${e.id}`)) {
        const remaining = e.estimated_pickup_at - now;
        if (remaining > 0 && remaining <= 5 * 60 * 1000) {
          const bed = AppState.getBedById(e.bed_id);
          const cfg = soundSettings['SOON'];
          if (cfg?.toast !== false) {
            UI.toast(`⚠️ ${bed ? bed.bed_number + '号床' : ''} 迎え目安まであと5分`, 'warning', 5000);
          }
          this._prevNotified.add(`soon-${e.id}`);
          if (cfg?.enabled) UI.playNotificationSound(cfg.sound);
        }
      }
    });
  },

  async applySystemVisualSettings() {
    console.log('[App] 画面表示・フォント・カードサイズ設定を適用中...');
    this._applyZoomAndFont();
    await this._applySyncTimeDisplay();
    this._applyPowerSettings();
    this._applyStatusLabels();
    const ndMin = this._applyThresholds();
    this._applyStatusColors();
    this._applyActionButtonLabels(ndMin);
  },

  // 表示倍率・フォント・病床カードサイズの適用（端末個別設定を優先）
  _applyZoomAndFont() {
    const localZoom = localStorage.getItem('cfg_app_zoom');
    const targetZoom = localZoom || AppState.getSettingRaw('default_zoom', '1.0');
    document.body.style.zoom = targetZoom;
    const zoomSelect = document.getElementById('zoom-select');
    if (zoomSelect) zoomSelect.value = targetZoom;

    const localFont = localStorage.getItem('cfg_font_style');
    const fontStyle = localFont || AppState.getSettingRaw('font_style', 'ud');
    document.body.classList.remove('font-standard', 'font-bold');
    if (fontStyle === 'standard') document.body.classList.add('font-standard');
    else if (fontStyle === 'bold') document.body.classList.add('font-bold');

    const localCardSize = localStorage.getItem('cfg_bed_card_size');
    const bedCardSize = localCardSize || AppState.getSettingRaw('bed_card_size', 'medium');
    document.body.classList.remove('size-large', 'size-small');
    if (bedCardSize === 'large') document.body.classList.add('size-large');
    else if (bedCardSize === 'small') document.body.classList.add('size-small');
  },

  // 同期時間・取り込み時間の表示制御
  async _applySyncTimeDisplay() {
    const showSync = AppState.getSettingBool('show_sync_time', true);
    const syncDisp = document.getElementById('sync-time-display');
    if (syncDisp) {
      if (showSync) {
        const d = new Date(AppState.lastUpdated || Date.now());
        const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        const partialLabel = this._syncPartial ? '（一部未同期）' : '';
        syncDisp.innerHTML = `<i class="fas fa-sync-alt"></i> 最終同期: <strong style="font-family:'Roboto Mono', monospace;">${timeStr}</strong>${partialLabel}`;
        syncDisp.title = this._syncPartial
          ? '設定または予定データの一部を前回の取得結果から表示しています'
          : '';
        syncDisp.style.display = 'inline-block';
      } else {
        syncDisp.style.display = 'none';
      }
    }

    const showImport = AppState.getSettingBool('show_import_time', true);
    const importDisp = document.getElementById('import-time-display');
    if (importDisp) {
      if (showImport) {
        try {
          const logsRes = await API.getAll('import_logs');
          const logs = logsRes.data || [];
          const lastLog = logs.sort((a, b) => b.timestamp - a.timestamp)[0];
          if (lastLog) {
            const d = new Date(lastLog.timestamp);
            const timeStr = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
            const isSuccess = lastLog.status === 'success';
            const statusLabel = isSuccess ? '<span style="color:#16a34a; font-weight:800;">(成功)</span>' : '<span style="color:#dc2626; font-weight:800;">(失敗)</span>';
            importDisp.innerHTML = `<i class="fas fa-file-import"></i> 最終取り込み: <strong style="font-family:'Roboto Mono', monospace;">${timeStr}</strong> ${statusLabel}`;
            importDisp.style.display = 'inline-block';
          } else {
            importDisp.innerHTML = `<i class="fas fa-file-import"></i> 最終取り込み: <strong>データなし</strong>`;
            importDisp.style.display = 'inline-block';
          }
        } catch (e) {
          console.error('[App] インポートログ取得エラー:', e);
          importDisp.style.display = 'none';
        }
      } else {
        importDisp.style.display = 'none';
      }
    }
  },

  // スクリーンセイバー抑制・最前面表示の適用（端末個別設定）
  _applyPowerSettings() {
    if (window.electronAPI?.setPowerSave) {
      const preventSleep = localStorage.getItem('cfg_prevent_sleep') === 'true';
      window.electronAPI.setPowerSave(preventSleep);
    }
    if (window.electronAPI?.setAlwaysOnTop) {
      const alwaysOnTop = localStorage.getItem('cfg_always_on_top') === 'true';
      window.electronAPI.setAlwaysOnTop(alwaysOnTop);
    }
  },

  // ステータス表示名のカスタマイズ（#1）。CONFIG.STATUS_LABEL_DEFAULTS（単一情報源）にリセットしてから適用する
  _applyStatusLabels() {
    Object.assign(CONFIG.STATUS_LABEL, CONFIG.STATUS_LABEL_DEFAULTS);

    const customLabels = AppState.getSettingJSON('status_custom_labels', {});
    Object.entries(customLabels).forEach(([sid, lbl]) => {
      if (lbl && Object.prototype.hasOwnProperty.call(CONFIG.STATUS_LABEL, sid)) CONFIG.STATUS_LABEL[sid] = lbl;
    });
  },

  // 「あと何分」しきい値のカスタマイズ（#2）。NEARLY_DONEの分数を返す
  _applyThresholds() {
    const customLabels = AppState.getSettingJSON('status_custom_labels', {});
    const ndMin = AppState.getSettingInt('nearly_done_minutes', 10);
    if (ndMin > 0 && !customLabels.NEARLY_DONE) {
      CONFIG.STATUS_LABEL.NEARLY_DONE = `あと${ndMin}分`;
    }
    const stMin = AppState.getSettingInt('soon_threshold_min', 15);
    if (stMin > 0) CONFIG.SOON_THRESHOLD_MIN = stMin;
    return ndMin;
  },

  // ステータスカラーのカスタマイズ（#3）
  _applyStatusColors() {

    const STATUS_CSS_VARS = {
      IN_BED:           { card_bg: '--clr-in-bed',        card_border: '--clr-in-bed-border',      badge_bg: '--badge-in-bed-bg',        badge_text: '--badge-in-bed-text' },
      DEPART_REGISTERED:{ card_bg: '--clr-depart-reg',    card_border: '--clr-depart-reg-border',  card_text: '--clr-depart-reg-text',    badge_bg: '--badge-depart-bg',    badge_text: '--badge-depart-text' },
      MOVING:           { card_bg: '--clr-moving',        card_border: '--clr-moving-border',      card_text: '--clr-moving-text',        badge_bg: '--badge-moving-bg',    badge_text: '--badge-moving-text' },
      ARRIVED:          { card_bg: '--clr-arrived',       card_border: '--clr-arrived-border',     badge_bg: '--badge-arrived-bg',        badge_text: '--badge-arrived-text' },
      IN_EXAM:          { card_bg: '--clr-in-exam',       card_border: '--clr-in-exam-border',     card_text: '--clr-in-exam-text',       badge_bg: '--badge-in-exam-bg',   badge_text: '--badge-in-exam-text' },
      NEARLY_DONE:      { card_bg: '--clr-nearly-done',   card_border: '--clr-nearly-done-border', card_text: '--clr-nearly-done-text',   badge_bg: '--badge-nearly-done-bg',badge_text: '--badge-nearly-done-text' },
      PICKUP_REQUIRED:  { card_bg: '--clr-pickup',        card_border: '--clr-pickup-border',      card_text: '--clr-pickup-text',        badge_bg: '--badge-pickup-bg',    badge_text: '--badge-pickup-text' },
      RETURNED:         { card_bg: '--clr-returned',      card_border: '--clr-returned-border',    card_text: '--clr-returned-text',      badge_bg: '--badge-returned-bg',  badge_text: '--badge-returned-text' },
      CANCELLED:        { card_bg: '--clr-cancelled',     card_border: '--clr-cancelled-border',   card_text: '--clr-cancelled-text',     badge_bg: '--badge-cancelled-bg', badge_text: '--badge-cancelled-text' },
    };
    const colors = AppState.getSettingJSON('status_colors', null);
    if (!colors) return;
    const root = document.documentElement;
    Object.entries(colors).forEach(([sid, colorMap]) => {
      const vars = STATUS_CSS_VARS[sid];
      if (!vars || !colorMap) return;
      if (colorMap.card_bg    && vars.card_bg)    root.style.setProperty(vars.card_bg,    colorMap.card_bg);
      if (colorMap.card_border && vars.card_border) root.style.setProperty(vars.card_border, colorMap.card_border);
      if (colorMap.card_text  && vars.card_text)  root.style.setProperty(vars.card_text,  colorMap.card_text);
      if (colorMap.badge_bg   && vars.badge_bg)   root.style.setProperty(vars.badge_bg,   colorMap.badge_bg);
      if (colorMap.badge_text && vars.badge_text) root.style.setProperty(vars.badge_text, colorMap.badge_text);
    });
  },

  // アクションボタンラベルのカスタマイズ（#4）。オリジナル値を保存し、再呼び出し時にリセットしてから適用する
  _applyActionButtonLabels(ndMin) {
    if (!App._origActionButtonLabels) {
      App._origActionButtonLabels = {};
      Object.entries(CONFIG.ACTION_BUTTONS).forEach(([st, btns]) => {
        App._origActionButtonLabels[st] = btns.map(b => b.label);
      });
      App._origExamRoomActionLabels = {};
      Object.entries(CONFIG.EXAM_ROOM_ACTIONS).forEach(([st, btns]) => {
        App._origExamRoomActionLabels[st] = btns.map(b => b.label);
      });
    }
    Object.entries(App._origActionButtonLabels).forEach(([st, labels]) => {
      labels.forEach((lbl, i) => { if (CONFIG.ACTION_BUTTONS[st]?.[i]) CONFIG.ACTION_BUTTONS[st][i].label = lbl; });
    });
    Object.entries(App._origExamRoomActionLabels).forEach(([st, labels]) => {
      labels.forEach((lbl, i) => { if (CONFIG.EXAM_ROOM_ACTIONS[st]?.[i]) CONFIG.EXAM_ROOM_ACTIONS[st][i].label = lbl; });
    });

    const actionLabels = AppState.getSettingJSON('action_button_labels', {});
    Object.entries(actionLabels).forEach(([key, lbl]) => {
      if (!lbl) return;
      const parts = key.split(':');
      if (parts.length === 2) {
        const btn = CONFIG.ACTION_BUTTONS[parts[0]]?.find(b => b.toStatus === parts[1]);
        if (btn) btn.label = lbl;
      } else if (parts.length === 3 && parts[0] === 'EXAM') {
        const btn = CONFIG.EXAM_ROOM_ACTIONS[parts[1]]?.find(b => b.toStatus === parts[2]);
        if (btn) btn.label = lbl;
      }
    });
    // NEARLY_DONEボタンのラベルをしきい値から自動生成（カスタムラベルが未設定の場合）
    if (!actionLabels['IN_EXAM:NEARLY_DONE'] && ndMin > 0) {
      const wardBtn = CONFIG.ACTION_BUTTONS.IN_EXAM?.find(b => b.toStatus === 'NEARLY_DONE');
      if (wardBtn) wardBtn.label = `あと${ndMin}分`;
      const examBtn = CONFIG.EXAM_ROOM_ACTIONS.IN_EXAM?.find(b => b.toStatus === 'NEARLY_DONE');
      if (examBtn) examBtn.label = `あと${ndMin}分`;
    }
  },
};

/* ---------- オフライン状態管理 ---------- */
// navigator.onLine ベースのネットワーク状態監視（UX: オフライン時に書き込み操作を無効化）
const OfflineManager = {
  _isOnline: navigator.onLine,

  init() {
    window.addEventListener('online', () => this._handleOnline());
    window.addEventListener('offline', () => this._handleOffline());
    if (!navigator.onLine) this._handleOffline();
  },

  _handleOnline() {
    if (this._isOnline) return;
    this._isOnline = true;
    this._setWriteOpsDisabled(false);
    UI.toast('ネットワーク接続が回復しました', 'success', 3000);
  },

  _handleOffline() {
    if (!this._isOnline) return;
    this._isOnline = false;
    this._setWriteOpsDisabled(true);
    UI.toast('ネットワーク接続が切断されました。書き込み操作は制限されます。', 'warning', 8000);
  },

  // 書き込み系ボタンを無効化（読み取り操作はそのまま）
  _setWriteOpsDisabled(disabled) {
    const selector = [
      '.btn-primary', '.btn-danger', '.btn-warning',
      '.btn-success', '.btn-info', '.btn-orange',
    ].join(', ');
    document.querySelectorAll(selector).forEach(btn => {
      if (disabled) {
        if (!btn.dataset.preOfflineDisabled) {
          btn.dataset.preOfflineDisabled = btn.disabled ? 'true' : 'false';
          btn.disabled = true;
          btn.title = btn.title || 'オフライン中は操作できません';
          btn.dataset.offlineDisabled = 'true';
        }
      } else if (btn.dataset.offlineDisabled) {
        btn.disabled = btn.dataset.preOfflineDisabled === 'true';
        delete btn.dataset.offlineDisabled;
        delete btn.dataset.preOfflineDisabled;
        btn.title = btn.title === 'オフライン中は操作できません' ? '' : btn.title;
      }
    });
  },

  get isOnline() { return this._isOnline; },
};

/* ---------- 古いイベントのクリーンアップ ---------- */
// 要件定義: event_retention_days 設定に基づき完了済みイベントを自動削除
const EventRetentionManager = {
  async run() {
    try {
      if (!window.electronAPI?.cleanupEventRetention) return;
      const result = await window.electronAPI.cleanupEventRetention();
      if (result?.success && result.removed > 0) {
        console.log(`[EventRetention] ${result.removed}件の古いイベントを一括削除しました`);
      }
    } catch (e) {
      console.warn('[EventRetention] クリーンアップに失敗しました:', e);
    }
  },
};

// DOM 準備完了後に初期化
document.addEventListener('DOMContentLoaded', () => {
  ErrorHandler.init();
  App.init().catch(e => {
    console.error('[App] 起動エラー:', e);
    UI.toast('アプリの起動に失敗しました', 'danger');
  });
});
