/**
 * TransBoard - メインアプリケーション
 */

const WardDashboard = {
  render() {
    BedMap.render();
    Priority.renderSummary();
    Priority.renderPriorityList();
    Timeline.render();
  },
};

const PasscodeModal = {
  _onSuccess: null,

  open(onSuccess) {
    this._onSuccess = onSuccess;
    
    // 入力フォームとエラーメッセージをリセット
    const input = document.getElementById('passcode-input');
    if (input) input.value = '';
    const errMsg = document.getElementById('passcode-error-msg');
    if (errMsg) errMsg.style.display = 'none';
    
    // モーダルを表示
    const overlay = document.getElementById('passcode-modal-overlay');
    if (overlay) overlay.classList.remove('hidden');
    
    // 入力欄にフォーカスをあてる
    setTimeout(() => {
      if (input) input.focus();
    }, 50);
  },

  close() {
    const overlay = document.getElementById('passcode-modal-overlay');
    if (overlay) overlay.classList.add('hidden');
    this._onSuccess = null;
  },

  async getRequiredPasscode() {
    try {
      if (typeof API !== 'undefined' && API.getOne) {
        const latest = await API.getOne('system_settings', 'admin_passcode');
        if (latest && latest.value !== undefined && latest.value !== null) {
          const cached = AppState.systemSettings?.find(s => s.id === 'admin_passcode');
          if (cached) cached.value = latest.value;
          else {
            if (!Array.isArray(AppState.systemSettings)) AppState.systemSettings = [];
            AppState.systemSettings.push({ id: 'admin_passcode', value: latest.value });
          }
          return latest.value;
        }
      }
    } catch (err) {
      console.warn('[Passcode] Failed to fetch latest admin passcode:', err);
    }

    const passcodeSetting = AppState.systemSettings?.find(s => s.id === 'admin_passcode');
    if (passcodeSetting && passcodeSetting.value !== undefined && passcodeSetting.value !== null) {
      return passcodeSetting.value;
    }
    return '0000';
  },

  async submit() {
    const input = document.getElementById('passcode-input');
    if (!input) return;
    const inputVal = input.value;

    const requiredPasscode = await this.getRequiredPasscode();

    if (inputVal === requiredPasscode) {
      window.isAdminSession = true;
      this.close();
      if (this._onSuccess) this._onSuccess();
    } else {
      const errMsg = document.getElementById('passcode-error-msg');
      if (errMsg) errMsg.style.display = 'block';
      input.value = '';
      input.focus();
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
        }
      };
    }
  }
};

const App = {
 
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

    // 管理者セッション認証状態（設定画面の多重プロンプト防止用キャッシュ）
    window.isAdminSession = false;

    // パスコードモーダルの初期化
    PasscodeModal.init();
 
    // タブ切り替え
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetPage = btn.dataset.page;
        
        if (targetPage === 'settings' && !window.isAdminSession) {
          // パスコードによる設定画面全体の保護 (カスタムHTMLモーダルを使用)
          const passcodeSetting = AppState.systemSettings?.find(s => s.id === 'admin_passcode');
          let requiredPasscode = '0000'; // デフォルトフォールバック
          if (passcodeSetting && passcodeSetting.value !== undefined && passcodeSetting.value !== null) {
            requiredPasscode = passcodeSetting.value;
          }
 
          if (requiredPasscode) {
            PasscodeModal.open(() => {
              UI.switchPage(targetPage);
            });
            return; // 認証完了するまでページ遷移を待機する
          } else {
            window.isAdminSession = true;
          }
        }
        
        UI.switchPage(targetPage);
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
        }
        
        // 検査室のトグルとも連動させる
        const examChk = document.getElementById('chk-exam-show-patient-names');
        if (examChk) {
          examChk.checked = nameChk.checked;
        }
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
      WardDashboard.render();
      if (Settings && ['beds', 'map', 'staffs'].includes(Settings._activeTab)) {
        Settings.render();
      }
    });

    // 更新ボタン
    document.getElementById('btn-refresh').addEventListener('click', async () => {
      const icon = document.querySelector('#btn-refresh i');
      icon.style.animation = 'spin .5s linear infinite';
      await this.refreshData();
      WardDashboard.render();
      icon.style.animation = '';
      UI.toast('データを更新しました', 'info');
    });

    // システムリセットボタン
    document.getElementById('btn-system-reset').addEventListener('click', async () => {
      if (!confirm('出棟中の移送情報をリセットしますか？\n（患者情報やマスタデータは消去されません）')) return;
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
    });

    // タイムライン日付
    const dateInput = document.getElementById('timeline-date');
    if (dateInput) {
      dateInput.value = new Date().toISOString().split('T')[0];
      dateInput.addEventListener('change', () => Timeline._renderFullTimeline().catch(console.error));
    }
    document.getElementById('tl-today-btn')?.addEventListener('click', () => {
      if (dateInput) {
        dateInput.value = new Date().toISOString().split('T')[0];
        Timeline._renderFullTimeline().catch(console.error);
      }
    });
    document.getElementById('tl-prev-day')?.addEventListener('click', () => {
      if (dateInput && dateInput.value) {
        const d = new Date(dateInput.value);
        d.setDate(d.getDate() - 1);
        dateInput.value = d.toISOString().split('T')[0];
        Timeline._renderFullTimeline().catch(console.error);
      }
    });
    document.getElementById('tl-next-day')?.addEventListener('click', () => {
      if (dateInput && dateInput.value) {
        const d = new Date(dateInput.value);
        d.setDate(d.getDate() + 1);
        dateInput.value = d.toISOString().split('T')[0];
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
          // 新規出棟登録フォームのIC入力欄（フィールド入力）
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

    // 初期表示・フォント設定の適用
    await this.applySystemVisualSettings();

    // 初期レンダリング
    WardDashboard.render();

    // ポーリング開始
    this.startPolling();

    // 初期設定ウィザードの自動起動チェック
    const wizardSetting = AppState.systemSettings?.find(s => s.id === 'wizard_completed');
    if (!wizardSetting || wizardSetting.value !== 'true') {
      setTimeout(() => {
        Wizard.open();
      }, 500);
    }

    // デスクトップアプリ用自動インポートのリスナー登録
    if (window.electronAPI) {
      console.log('[Electron] 患者・在床情報のインポートリスナーを設定しています...');
      
      // 成功時
      window.electronAPI.onDataImported(async ({ fileName, rows }) => {
        console.log(`[Electron] インポートデータを受信 (${fileName}):`, rows);

        // 在室管理モード確認
        const admMode = AppState.systemSettings?.find(s => s.id === 'admission_mode')?.value || 'csv';
        if (admMode === 'manual') {
          UI.toast('在室管理モードが「手動登録」のためCSVインポートをスキップしました', 'warning', 5000);
          return;
        }

        let importedCount = 0;
        let skipCount = 0;

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
              is_present: hasPatient && patientName !== emptyBedLabel ? isPresent : false
            };

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
          } else {
            const activeBedIds = new Set(
              (AppState.activeEvents || [])
                .filter(e => CONFIG.DEPART_STATUSES.includes(e.current_status))
                .map(e => e.bed_id)
            );
            for (const bed of AppState.beds) {
              if (!listedBedIds.has(bed.id) && (bed.patient_name || bed.patient_id) && !activeBedIds.has(bed.id)) {
                // ハイブリッドモードでは手動登録済み病床をCSVクリアから保護
                if (admMode === 'hybrid' && bed.manually_registered) continue;
                bulkUpdates.push({ id: bed.id, patient_name: null, patient_id: null, is_present: false });
                clearCount++;
              }
            }
          }
        }

        if (bulkUpdates.length > 0) {
          try {
            await API.bulkPatch('beds', bulkUpdates);
          } catch (err) {
            console.error('[Import] バルクアップデートエラー:', err);
          }
        }

        const hasWarning = skipCount > 0;
        const status = (importedCount === 0 && rows.length > 0) ? 'warning' : (hasWarning ? 'warning' : 'success');
        const clearPart = clearCount > 0 ? `, 退院クリア: ${clearCount}件` : '';
        const detailMsg = `インポート成功: ${importedCount}件, スキップ: ${skipCount}件${clearPart}`;
        const logMsg = importedCount > 0
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
          if (importedCount > 0) {
            const clearNote = clearCount > 0 ? ` / 退院クリア: ${clearCount}件` : '';
            UI.toast(`📂 ${importedCount} 件の患者・在床情報を更新しました (スキップ: ${skipCount}件${clearNote})`, 'success');
          } else {
            UI.toast(`📂 CSVインポート完了: 更新なし (スキップ: ${skipCount}件)`, 'warning');
          }
        }
      });

      // 失敗時
      window.electronAPI.onDataImportFailed(async ({ fileName, error }) => {
        console.error(`[Electron] インポート失敗 (${fileName}):`, error);
        
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
        window.electronAPI.onScheduleImported(async ({ feedId, feedName, fileName, count }) => {
          console.log(`[ScheduleFeed] "${feedName}" 取り込み完了 (${fileName}): ${count}件`);
          UI.toast(`📅 ${feedName}: ${count}件のスケジュールを取り込みました`, 'info');
          // タイムライン表示中なら再描画
          const activePage = document.querySelector('.page.active');
          if (activePage && activePage.id === 'page-timeline') {
            Timeline._renderFullTimeline().catch(console.error);
          }
        });
      }
    }

    // タイマー更新 (30秒ごとに残り時間表示を更新)
    setInterval(() => {
      BedMap.updateTimers();
      Priority.renderSummary();
      Priority.renderPriorityList();
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

    // 子機モードのみ：ハートビート送信と接続断検知
    const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
    if (shareMode === 'client' || shareMode === 'child') {
      this._startHeartbeat();
    }

    console.log('[App] 初期化完了');
  },

  _connectionLost: false,

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

  _setConnectionStatus(ok) {
    if (ok === !this._connectionLost) return;
    this._connectionLost = !ok;
    let banner = document.getElementById('connection-lost-banner');
    if (!ok) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'connection-lost-banner';
        banner.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 親機との接続が切断されました。ネットワークを確認してください。';
        document.body.appendChild(banner);
      }
    } else {
      if (banner) banner.remove();
    }
  },

  _startHeartbeat() {
    const deviceId = (() => {
      let id = localStorage.getItem('_device_id');
      if (!id) { id = `dev-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; localStorage.setItem('_device_id', id); }
      return id;
    })();

    const sendHeartbeat = async () => {
      const wardId = AppState.currentWardId || localStorage.getItem('current_ward_id') || '';
      const name = navigator.userAgent.match(/Windows NT/) ? (location.hostname || 'Windows端末') : (location.hostname || '端末');
      try {
        const res = await API.deviceHeartbeat({
          deviceId,
          name: localStorage.getItem('_device_name') || deviceId,
          wardId,
          mode: localStorage.getItem('cfg_share_mode') || 'client',
          page: document.querySelector('.tab-btn.active')?.dataset.page || ''
        });
        this._setConnectionStatus(res !== null);
      } catch (e) {
        console.warn('[Heartbeat] failed:', e);
        this._setConnectionStatus(false);
      }
    };

    sendHeartbeat();
    setInterval(sendHeartbeat, 10000);
  },

  syncWardSelect() {
    const select = document.getElementById('ward-select');
    if (select) {
      const savedWardId = localStorage.getItem('current_ward_id');
      const current = [savedWardId, AppState.currentWardId, select.value]
        .find(id => id && AppState.wards.some(w => w.id === id));
      select.innerHTML = AppState.wards.map(w => 
        `<option value="${w.id}">${w.name}</option>`
      ).join('');
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

  async loadMasters() {
    try {
      const [wards, beds, bedTypes, examRooms, examTypes, staffs, systemSettings] = await Promise.all([
        API.getWards(),
        API.getAllBeds(),
        API.getBedTypes().catch(() => [
          { id: 'bed-type-normal', code: 'normal', name: '一般', sort_order: 1, is_active: true },
          { id: 'bed-type-isolation', code: 'isolation', name: '隔離', sort_order: 2, is_active: true },
          { id: 'bed-type-icu', code: 'icu', name: 'ICU', sort_order: 3, is_active: true }
        ]),
        API.getExamRooms(),
        API.getExamTypes(),
        API.getStaffs(),
        API.getAll('system_settings').then(res => res.data).catch(() => [])
      ]);
      AppState.wards = wards;
      AppState.beds = beds;
      AppState.bedTypes = bedTypes.filter(t => t.is_active !== false).sort((a, b) => (a.sort_order || 99) - (b.sort_order || 99));
      AppState.allExamRooms = examRooms;
      AppState.examRooms = examRooms.filter(r => r.is_active !== false);
      AppState.examTypes = examTypes;
      AppState.staffs = staffs;
      AppState.systemSettings = systemSettings;
      AppState.stickyNotes = [];
      console.log('[App] マスタ読み込み完了', { beds: beds.length, examRooms: examRooms.length, systemSettings: systemSettings.length });

      // 保持期間設定に基づき古い完了済みイベントを削除（起動時に1回）
      EventRetentionManager.run().catch(e => console.warn('[App] イベントクリーンアップ失敗:', e));
    } catch (e) {
      console.error('[App] マスタ読み込み失敗:', e);
      UI.toast('マスタデータの読み込みに失敗しました', 'danger');
    }
  },

  async refreshData() {
    try {
      const wardId = AppState.currentWardId;
      const [activeEvents, todayEvents, systemSettings] = await Promise.all([
        API.getActiveEvents(wardId),
        API.getTodayEventsForWard(wardId),
        API.getAll('system_settings').then(res => res.data).catch(() => [])
      ]);
      AppState.activeEvents = activeEvents;
      AppState.todayEvents = todayEvents;
      AppState.systemSettings = systemSettings;
      AppState.stickyNotes = [];
      AppState.lastUpdated = Date.now();

      this._setConnectionStatus(true);
      // 動的表示設定（フォント・ズーム・カードサイズ・テーマ）を即時反映
      await this.applySystemVisualSettings();
    } catch (e) {
      console.error('[App] データ更新失敗:', e);
      const shareMode = localStorage.getItem('cfg_share_mode') || 'parent';
      if (shareMode === 'client' || shareMode === 'child') {
        this._setConnectionStatus(false);
      }
    }
  },

  startPolling() {
    AppState.pollTimer = setInterval(async () => {
      const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
      await this.refreshData();

      if (currentPage === 'ward-dashboard') {
        WardDashboard.render();
      } else if (currentPage === 'exam-room') {
        ExamRoom._renderQueue();
      } else if (currentPage === 'timeline') {
        Timeline.render();
      }

      this._checkNotifications();
    }, CONFIG.POLL_INTERVAL);
  },

  async _resetAllActiveEvents() {
    try {
      const events = await API.getActiveEvents(AppState.currentWardId);
      for (const e of events) {
        if (CONFIG.ACTIVE_STATUSES.includes(e.current_status)) {
          await API.patch('transfer_events', e.id, { current_status: 'RETURNED', returned_at: Date.now() });
        }
      }
    } catch (err) {
      console.error('[Reset]', err);
    }
  },

  // 通知チェック
  _prevNotified: new Set(),
  _lastEventStatuses: new Map(),

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

  _checkNotifications() {
    const now = Date.now();
    this._updateNavBadge();
    
    // 通知音設定のロード (デフォルト値)
    let soundSettings = {
      PICKUP_REQUIRED: { enabled: true, sound: 'alarm' },
      NEARLY_DONE: { enabled: true, sound: 'chime' },
      SOON: { enabled: true, sound: 'chime' },
      DEPART_REGISTERED: { enabled: false, sound: 'ding' },
      MOVING: { enabled: false, sound: 'ding' },
      ARRIVED: { enabled: false, sound: 'ding' },
      IN_EXAM: { enabled: false, sound: 'ding' },
      RETURNED: { enabled: false, sound: 'ding' }
    };
    // 子機は端末固有の localStorage 値を優先
    const _localSounds = localStorage.getItem('cfg_share_mode') === 'client'
      ? localStorage.getItem('tbs_notification_sounds') : null;
    if (_localSounds) {
      try { soundSettings = JSON.parse(_localSounds); } catch(e) {}
    } else {
      const soundSettingRec = AppState.systemSettings?.find(s => s.id === 'notification_sounds');
      if (soundSettingRec?.value) {
        try { soundSettings = JSON.parse(soundSettingRec.value); } catch(e) {}
      }
    }

    // 今日の全イベントについてステータス変化をチェック
    (AppState.todayEvents || []).forEach(e => {
      const lastStatus = this._lastEventStatuses.get(e.id);
      
      if (lastStatus !== undefined && lastStatus !== e.current_status) {
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
      if (lastStatus !== undefined && lastStatus !== e.current_status &&
          !DEDICATED_TOAST_STATUSES.has(e.current_status)) {
        const cfg = soundSettings[e.current_status];
        if (cfg?.toast !== false) {
          const bed = AppState.getBedById(e.bed_id);
          const bedLabel = bed ? `${bed.bed_number}号床` : '';
          const statusLabel = CONFIG.STATUS_LABEL?.[e.current_status] || e.current_status;
          const patientName = bed?.patient_name ? `（${bed.patient_name}）` : '';
          const toastTypes = {
            RETURNED: 'success', ARRIVED: 'info', IN_EXAM: 'info',
            DEPART_REGISTERED: 'info', MOVING: 'info',
          };
          const toastType = toastTypes[e.current_status] || 'info';
          UI.toast(`${bedLabel}${patientName} → ${statusLabel}`, toastType, 5000);
          UI.showOsNotification(`TransBoard:${statusLabel}`, `${bedLabel}${patientName}`);
        }
      }

      // 迎え要通知
      if (e.current_status === 'PICKUP_REQUIRED' && !this._prevNotified.has(`pickup-${e.id}`)) {
        const bed = AppState.getBedById(e.bed_id);
        const cfg = soundSettings['PICKUP_REQUIRED'];
        if (cfg?.toast !== false) {
          UI.toast(`🔔 ${bed ? bed.bed_number + '号床' : ''} 迎えが必要です！`, 'danger', 6000);
          UI.showOsNotification('TransBoard:迎えが必要', `${bed ? bed.bed_number + '号床' : ''}${bed?.patient_name ? '（' + bed.patient_name + '）' : ''}`);
        }
        this._prevNotified.add(`pickup-${e.id}`);
        if (lastStatus === undefined && cfg?.enabled) UI.playNotificationSound(cfg.sound);
      }

      // あと10分通知
      if (e.current_status === 'NEARLY_DONE' && !this._prevNotified.has(`nearly-${e.id}`)) {
        const bed = AppState.getBedById(e.bed_id);
        const cfg = soundSettings['NEARLY_DONE'];
        if (cfg?.toast !== false) {
          UI.toast(`⏰ ${bed ? bed.bed_number + '号床' : ''} あと10分です`, 'warning', 5000);
          UI.showOsNotification('TransBoard:あと10分', `${bed ? bed.bed_number + '号床' : ''}`);
        }
        this._prevNotified.add(`nearly-${e.id}`);
        if (lastStatus === undefined && cfg?.enabled) UI.playNotificationSound(cfg.sound);
      }

      // 迎え目安5分前通知（時刻経過による特別トリガー）
      if (e.estimated_pickup_at && !this._prevNotified.has(`soon-${e.id}`)) {
        const remaining = e.estimated_pickup_at - now;
        if (remaining > 0 && remaining <= 5 * 60 * 1000) {
          const bed = AppState.getBedById(e.bed_id);
          const cfg = soundSettings['SOON'];
          if (cfg?.toast !== false) {
            UI.toast(`⚠️ ${bed ? bed.bed_number + '号床' : ''} 迎え目安まであと5分`, 'warning', 5000);
            UI.showOsNotification('TransBoard:迎え5分前', `${bed ? bed.bed_number + '号床' : ''}`);
          }
          this._prevNotified.add(`soon-${e.id}`);
          if (cfg?.enabled) UI.playNotificationSound(cfg.sound);
        }
      }
    });
  },

  async applySystemVisualSettings() {
    console.log('[App] 画面表示・フォント・カードサイズ設定を適用中...');

    // 1. 表示倍率（ズーム）の適用
    const localZoom = localStorage.getItem('cfg_app_zoom');
    const dbZoomSetting = AppState.systemSettings?.find(s => s.id === 'default_zoom');
    const targetZoom = localZoom || (dbZoomSetting ? dbZoomSetting.value : '1.0');

    document.body.style.zoom = targetZoom;

    const zoomSelect = document.getElementById('zoom-select');
    if (zoomSelect) {
      zoomSelect.value = targetZoom;
    }

    // 2. フォントスタイルの適用 (端末個別設定を優先)
    const localFont = localStorage.getItem('cfg_font_style');
    const fontSetting = AppState.systemSettings?.find(s => s.id === 'font_style');
    const fontStyle = localFont || (fontSetting ? fontSetting.value : 'ud');

    document.body.classList.remove('font-standard', 'font-bold');
    if (fontStyle === 'standard') {
      document.body.classList.add('font-standard');
    } else if (fontStyle === 'bold') {
      document.body.classList.add('font-bold');
    }

    // 3. 病床カードサイズの適用 (端末個別設定を優先)
    const localCardSize = localStorage.getItem('cfg_bed_card_size');
    const cardSizeSetting = AppState.systemSettings?.find(s => s.id === 'bed_card_size');
    const bedCardSize = localCardSize || (cardSizeSetting ? cardSizeSetting.value : 'medium');

    document.body.classList.remove('size-large', 'size-small');
    if (bedCardSize === 'large') {
      document.body.classList.add('size-large');
    } else if (bedCardSize === 'small') {
      document.body.classList.add('size-small');
    }

    // 4. 同期時間・取り込み時間の表示制御
    const showSyncSetting = AppState.systemSettings?.find(s => s.id === 'show_sync_time');
    const showSync = showSyncSetting ? showSyncSetting.value !== 'false' : true;
    const syncDisp = document.getElementById('sync-time-display');
    if (syncDisp) {
      if (showSync) {
        const d = new Date(AppState.lastUpdated || Date.now());
        const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        syncDisp.innerHTML = `<i class="fas fa-sync-alt"></i> 最終同期: <strong style="font-family:'Roboto Mono', monospace;">${timeStr}</strong>`;
        syncDisp.style.display = 'inline-block';
      } else {
        syncDisp.style.display = 'none';
      }
    }

    const showImportSetting = AppState.systemSettings?.find(s => s.id === 'show_import_time');
    const showImport = showImportSetting ? showImportSetting.value !== 'false' : true;
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

    // 5. カラーテーマの適用 (端末個別設定を優先)
    const localTheme = localStorage.getItem('cfg_theme_style');
    const themeSetting = AppState.systemSettings?.find(s => s.id === 'theme_style');
    const themeStyle = localTheme || (themeSetting ? themeSetting.value : 'light');

    document.body.classList.remove('theme-light', 'theme-dark', 'theme-blue', 'theme-high-contrast', 'theme-cvd');
    document.body.classList.add(`theme-${themeStyle}`);
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
    const setting = AppState.systemSettings?.find(s => s.id === 'event_retention_days');
    const days = parseInt(setting?.value || '0', 10);
    if (!days || days <= 0) return; // 0 = 無期限

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const completedStatuses = ['RETURNED', 'CANCELLED'];

    try {
      const res = await API.getAll('transfer_events');
      const stale = (res.data || []).filter(e =>
        completedStatuses.includes(e.current_status) &&
        (e.created_at || 0) < cutoff
      );

      if (stale.length === 0) return;

      await Promise.all(stale.map(e => API.remove('transfer_events', e.id)));
      console.log(`[EventRetention] ${stale.length}件の古いイベントを削除しました（${days}日以前）`);
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
