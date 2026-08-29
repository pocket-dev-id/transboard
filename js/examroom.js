/**
 * TransBoard - 検査室進捗更新画面
 */

const ExamRoom = {

  _pendingFlashEventId: null,
  _wardAcknowledgementState: new Map(),
  _notificationHistoryLogs: [],
  _notificationHistoryAnnouncements: [],
  _roomGridStatusCache: [],
  _viewAllRoomsPatients: false,

  async render() {
    // 検査室セレクト初期化
    const select = document.getElementById('exam-room-select');
    if (select) {
      const prevValue = select.value || AppState.currentExamRoomId || '';
      select.innerHTML = '<option value=""></option>';
      AppState.examRooms.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = `${r.name}（${r.floor}）`;
        select.appendChild(opt);
      });
      select.onchange = () => {
        AppState.currentExamRoomId = select.value;
        this._viewAllRoomsPatients = false;
        this._renderQueue();
        this._updateScanInputState();
      };
      if (prevValue) select.value = prevValue;
    }

    // 全検査室の患者一覧ボタン
    const allRoomsBtn = document.getElementById('btn-exam-all-rooms');
    if (allRoomsBtn && !allRoomsBtn.dataset.listenerBound) {
      allRoomsBtn.dataset.listenerBound = 'true';
      allRoomsBtn.addEventListener('click', () => {
        this._viewAllRoomsPatients = true;
        AppState.currentExamRoomId = null;
        const roomSelect = document.getElementById('exam-room-select');
        if (roomSelect) roomSelect.value = '';
        this._renderQueue();
        this._updateScanInputState();
      });
    }

    // 患者名表示トグルイベントのバインド
    const nameChk = document.getElementById('chk-exam-show-patient-names');
    if (nameChk && !nameChk.dataset.listenerBound) {
      const savedVal = localStorage.getItem('cfg_show_patient_names') === 'true';
      nameChk.checked = savedVal;

      nameChk.dataset.listenerBound = 'true';
      nameChk.addEventListener('change', () => {
        localStorage.setItem('cfg_show_patient_names', nameChk.checked ? 'true' : 'false');
        // トグル変更時は再描画を行うことで、ブラウザの描画遅延（一瞬の露出）を防ぐ
        this._renderQueue();

        // 病棟ダッシュボードのトグルとも連動させる
        const wardChk = document.getElementById('chk-show-patient-names');
        if (wardChk) {
          wardChk.checked = nameChk.checked;
          const grid = document.getElementById('bed-map-grid');
          if (grid) {
            if (nameChk.checked) {
              grid.classList.remove('hide-patient-names');
            } else {
              grid.classList.add('hide-patient-names');
            }
          }
        }
      });
    }

    // IC登録オプションの確認
    const icSetting = AppState.systemSettings?.find(s => s.id === 'enable_patient_ic_association');
    const isIcEnabled = icSetting && icSetting.value === 'true';
    const scanArea = document.getElementById('exam-ic-scan-area');
    if (scanArea) {
      if (isIcEnabled) {
        scanArea.style.display = 'flex';
        this._updateScanInputState();
        this._bindScanEvents();

        // フォーカストラップのバインド
        const icInput = document.getElementById('exam-ic-input');
        const examPage = document.getElementById('page-exam-room');
        if (icInput && examPage && !examPage.dataset.focusTrapBound) {
          examPage.dataset.focusTrapBound = 'true';
          examPage.addEventListener('click', (e) => {
            const targetTagName = e.target.tagName.toLowerCase();
            if (!['input', 'textarea', 'select', 'button', 'a', 'option', 'i'].includes(targetTagName)) {
              if (document.getElementById('exam-room-select')?.value) {
                icInput.focus();
              }
            }
          });
        }
      } else {
        scanArea.style.display = 'none';
      }
    }

    await this._renderQueue();
  },

  _updateScanInputState() {
    const roomId = document.getElementById('exam-room-select')?.value;
    const icInput = document.getElementById('exam-ic-input');
    if (icInput) {
      const isBarcodeMode = AppState.systemSettings?.find(s => s.id === 'patient_id_scan_mode')?.value === 'barcode';
      const scanIcon = document.querySelector('#exam-ic-scan-area i');
      if (scanIcon) scanIcon.className = isBarcodeMode ? 'fas fa-barcode' : 'fas fa-id-card';
      if (!roomId) {
        icInput.disabled = true;
        icInput.placeholder = '検査室を選択してください';
        icInput.value = '';
      } else {
        icInput.disabled = false;
        icInput.placeholder = isBarcodeMode ? '患者バーコードスキャン口 (スキャンで自動遷移)' : '患者ICスキャン口 (スキャンで自動遷移)';
        setTimeout(() => icInput.focus(), 50);
      }
    }
  },

  _lastScanTimes: {},

  _bindScanEvents() {
    const icInput = document.getElementById('exam-ic-input');
    if (!icInput || icInput.dataset.listenerBound) return;
    icInput.dataset.listenerBound = 'true';

    // キーボードウェッジ方式のカードリーダー向けフォールバック
    // (PC/SC経由はapp.jsのグローバルハンドラで処理)
    icInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const icValue = icInput.value.trim();
        icInput.value = '';
        this._handleScan(icValue);
      }
    });
  },

  // 数字のみのIDは、先頭0埋めの有無が異なっていても同一患者として照合できるよう
  // 先頭の0を除去して比較する（英数字混在のIDは意図しない値の欠落を避けるためそのまま扱う）
  _normalizeIdForMatch(value) {
    const trimmed = String(value || '').trim();
    return /^\d+$/.test(trimmed) ? trimmed.replace(/^0+(?=\d)/, '') : trimmed;
  },

  async _handleScan(icValue) {
    if (!icValue) return;

    // 病床詳細モーダルは閉じた後もbody.innerHTMLが残るため、#m-ic-tag-id等の
    // 存在だけで判定すると、以前どこかで一度でも開かれたモーダルの残骸に
    // 誤って流れてしまい、検査室側のステータス更新が一切実行されなくなる。
    // オーバーレイが実際に表示中かどうかを併せて確認する
    // (js/app.jsのグローバルカード読取ハンドラと同じ判定)。
    const bedModalOpen = !document.getElementById('bed-modal-overlay')?.classList.contains('hidden');
    if (bedModalOpen) {
      // 編集モーダルのIC登録入力欄が開いている場合はそちらに流す（自動登録）
      const editIcInput = document.getElementById('m-ic-tag-id');
      if (editIcInput) {
        editIcInput.value = icValue;
        document.getElementById('btn-update-ic-tag')?.click();
        return;
      }

      // 新規移送開始フォームのIC入力欄が開いている場合はそちらに流す（フィールド入力のみ）
      const newIcInput = document.getElementById('f-ic-tag-id');
      if (newIcInput && !newIcInput.disabled) {
        newIcInput.value = icValue;
        UI.toast('ICカードを読み取りました', 'info');
        return;
      }
    }

    // 重複スキャン（チャタリング）防止: 3秒以内の同一IDのスキャンは無視
    const now = Date.now();
    if (this._lastScanTimes && this._lastScanTimes[icValue] && (now - this._lastScanTimes[icValue] < 3000)) {
      console.log(`[ExamRoom] 重複スキャン検知により無視: ${icValue}`);
      return;
    }
    if (!this._lastScanTimes) this._lastScanTimes = {};
    this._lastScanTimes[icValue] = now;

    const roomId = document.getElementById('exam-room-select')?.value;
    if (!roomId) {
      UI.toast('検査室が選択されていません', 'warning');
      UI.playScanSound(false);
      return;
    }

    try {
      const events = await API.getEventsForExamRoom(roomId);
      const relevant = events.filter(ev =>
        CONFIG.ACTIVE_STATUSES.includes(ev.current_status) &&
        ev.current_status !== 'PICKUP_REQUIRED'
      );

      const scannedId = this._normalizeIdForMatch(icValue);
      const matchEvent = relevant.find(ev => this._normalizeIdForMatch(ev.patient_ic_tag_id) === scannedId);
      if (!matchEvent) {
        UI.toast('該当する患者の移送イベントが見つかりません', 'warning');
        UI.playScanSound(false);
        return;
      }

      const actions = CONFIG.getAllowedActions(matchEvent.current_status, CONFIG.STATUS_SCOPE.EXAM);
      const currentLabel = CONFIG.STATUS_LABEL[matchEvent.current_status] || matchEvent.current_status;
      if (!actions.length) {
        UI.toast(`現在の状態（${currentLabel}）ではICカードによる自動更新はできません`, 'info');
        UI.playScanSound(false);
        return;
      }

      const bed = AppState.getBedById(matchEvent.bed_id);
      const bedName = bed ? UI.formatExamBedLocationPlain(bed) : '患者';
      const action = actions.length === 1
        ? actions[0]
        : await this._selectScanAction(matchEvent, bedName, currentLabel, actions);
      if (!action) {
        UI.playScanSound(false);
        return;
      }

      const nextLabel = this._getExamActionLabel(matchEvent, action);
      let extraFields = {};
      if (action.toStatus === 'PICKUP_REQUIRED') {
        // 迎え要への遷移は、お迎えに必要なものを選ばせる画面を確認代わりに挟む
        // （他の遷移先のような数秒自動確定は行わない）
        const chosen = await this._selectPickupAssistance(bedName);
        if (!chosen) {
          UI.playScanSound(false);
          return;
        }
        extraFields = chosen;
      } else if (actions.length === 1) {
        // 遷移先が1つに決まる典型ケース（到着・検査開始等）は、誰も画面の前にいなくても
        // 数秒で自動的に確定させる。誤ったカードの場合はこの間にキャンセルできる
        const ok = await UI.confirmModal(
          `${bedName}（現在: ${currentLabel}）を${nextLabel}にしますか？`,
          { title: 'ICスキャン確認', confirmLabel: '更新する', autoConfirmMs: 4000 }
        );
        if (!ok) {
          UI.playScanSound(false);
          return;
        }
      }

      await API.updateEventStatus(matchEvent.id, action.toStatus, extraFields, CONFIG.STATUS_SCOPE.EXAM, matchEvent.current_status, 'ic_scan');
      const label = nextLabel;
      UI.toast(`[ICスキャン] ${bedName} → ${label}`, 'success');
      UI.playScanSound(true);
      this._pendingFlashEventId = matchEvent.id;

      await App.refreshData({ force: true });
      await this._renderQueue();
    } catch (err) {
      console.error(err);
      if (await App.handleDataConflict(err)) {
        UI.playScanSound(false);
        return;
      }
      UI.toast('ICスキャン処理中にエラーが発生しました', 'danger');
      UI.playScanSound(false);
    }
  },

  _getExamActionLabel(event, action) {
    const actionLabels = AppState.getSettingJSON('action_button_labels', {});
    const directExamStart = (
      action.toStatus === 'IN_EXAM' &&
      CONFIG.isStatusHidden('ARRIVED') &&
      ['DEPART_REGISTERED', 'MOVING'].includes(event.current_status)
    );
    return directExamStart
      ? (actionLabels[`EXAM:${event.current_status}:IN_EXAM`] || '到着・検査開始')
      : (action.label || CONFIG.STATUS_LABEL[action.toStatus] || action.toStatus);
  },

  _selectScanAction(event, bedName, currentLabel, actions) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay confirm-modal-overlay';

      const modal = document.createElement('div');
      modal.className = 'modal exam-scan-action-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');

      const body = document.createElement('div');
      body.className = 'modal-body';

      const title = document.createElement('div');
      title.className = 'confirm-modal-title';
      title.textContent = 'ICスキャン後の更新先を選択';

      const text = document.createElement('div');
      text.className = 'confirm-modal-text';
      text.textContent = `${bedName}（現在: ${currentLabel}）`;

      const options = document.createElement('div');
      options.className = 'exam-scan-action-options';
      actions.forEach(action => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn ${action.cls || 'btn-primary'} exam-scan-action-option`;
        btn.textContent = this._getExamActionLabel(event, action);
        btn.addEventListener('click', () => cleanup(action));
        options.appendChild(btn);
      });

      body.appendChild(title);
      body.appendChild(text);
      body.appendChild(options);

      const footer = document.createElement('div');
      footer.className = 'modal-footer confirm-modal-footer';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-outline btn-sm';
      cancelBtn.textContent = 'キャンセル';
      footer.appendChild(cancelBtn);

      modal.appendChild(body);
      modal.appendChild(footer);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const cleanup = (result) => {
        document.removeEventListener('keydown', onKeydown);
        idleCancel();
        overlay.remove();
        resolve(result);
      };
      const onKeydown = (e) => {
        if (e.key === 'Escape') cleanup(null);
      };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
      cancelBtn.addEventListener('click', () => cleanup(null));
      document.addEventListener('keydown', onKeydown);
      const idleCancel = UI.armIdleAutoClose(overlay, () => cleanup(null));
      const first = options.querySelector('button');
      if (first) first.focus();
    });
  },

  // 終了登録（迎え要）の際に「お迎えに必要なもの」を選ばせる。任意項目のため
  // 「選択せずに登録」で即座に進めるが、閉じる/背景クリック/Escは遷移自体の
  // キャンセルとして扱う（_selectScanActionと同じnull=キャンセルの約束）
  _selectPickupAssistance(bedLabel) {
    return new Promise(resolve => {
      const types = AppState.pickupAssistanceTypes || [];
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay confirm-modal-overlay';

      const modal = document.createElement('div');
      modal.className = 'modal exam-scan-action-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');

      const body = document.createElement('div');
      body.className = 'modal-body';

      const title = document.createElement('div');
      title.className = 'confirm-modal-title';
      title.textContent = 'お迎えに必要なものを選択';

      const text = document.createElement('div');
      text.className = 'confirm-modal-text';
      text.textContent = bedLabel;

      const options = document.createElement('div');
      options.className = 'exam-scan-action-options';

      const otherRow = document.createElement('div');
      otherRow.style.cssText = 'display:none; gap:8px; align-items:center; margin-top:10px;';
      const otherInput = document.createElement('input');
      otherInput.type = 'text';
      otherInput.placeholder = '内容を入力（任意）';
      otherInput.style.cssText = 'flex:1; padding:6px 8px; border:1px solid #cbd5e0; border-radius:6px; font-size:13px;';
      const otherConfirmBtn = document.createElement('button');
      otherConfirmBtn.type = 'button';
      otherConfirmBtn.className = 'btn btn-primary btn-sm';
      otherConfirmBtn.textContent = '登録する';
      otherRow.appendChild(otherInput);
      otherRow.appendChild(otherConfirmBtn);

      types.forEach(type => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-outline exam-scan-action-option';
        btn.textContent = type.name;
        btn.addEventListener('click', () => cleanup({ pickup_assistance_type_id: type.id }));
        options.appendChild(btn);
      });
      const otherBtn = document.createElement('button');
      otherBtn.type = 'button';
      otherBtn.className = 'btn btn-outline exam-scan-action-option';
      otherBtn.textContent = 'その他（自由記入）';
      otherBtn.addEventListener('click', () => {
        otherRow.style.display = 'flex';
        otherInput.focus();
      });
      options.appendChild(otherBtn);

      const confirmOther = () => cleanup({
        pickup_assistance_type_id: 'other',
        pickup_assistance_note: otherInput.value.trim() || null,
      });
      otherConfirmBtn.addEventListener('click', confirmOther);
      otherInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmOther(); });

      body.appendChild(title);
      body.appendChild(text);
      body.appendChild(options);
      body.appendChild(otherRow);

      const footer = document.createElement('div');
      footer.className = 'modal-footer confirm-modal-footer';
      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = 'btn btn-outline btn-sm';
      skipBtn.textContent = '選択せずに登録';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-outline btn-sm';
      cancelBtn.textContent = 'キャンセル';
      footer.appendChild(skipBtn);
      footer.appendChild(cancelBtn);

      modal.appendChild(body);
      modal.appendChild(footer);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const cleanup = (result) => {
        document.removeEventListener('keydown', onKeydown);
        idleCancel();
        overlay.remove();
        resolve(result);
      };
      const onKeydown = (e) => {
        if (e.key === 'Escape') cleanup(null);
      };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
      skipBtn.addEventListener('click', () => cleanup({}));
      cancelBtn.addEventListener('click', () => cleanup(null));
      document.addEventListener('keydown', onKeydown);
      const idleCancel = UI.armIdleAutoClose(overlay, () => cleanup(null));
      const first = options.querySelector('button');
      if (first) first.focus();
    });
  },

  async _renderQueue() {
    const container = document.getElementById('exam-room-queue');
    const summaryContainer = document.getElementById('exam-room-summary-container');
    const historyArea = document.getElementById('exam-notification-history-area');
    const historyList = document.getElementById('exam-notification-history-list');
    if (!container) return;

    const roomId = document.getElementById('exam-room-select')?.value;
    const showingAllRooms = !roomId && this._viewAllRoomsPatients;

    // 「← 全検査室」戻るボタンの表示制御
    this._updateBackButton(!!roomId || showingAllRooms);

    if (!roomId && !showingAllRooms) {
      if (historyArea) historyArea.hidden = true;
      if (historyList) historyList.innerHTML = '';
      container.classList.remove('exam-queue-list-mode');
      if (summaryContainer) summaryContainer.innerHTML = '';
      const gridHtml = await this._renderRoomGrid();
      // 取得待ちの間に個別検査室・全患者一覧が選択されていたら、一覧描画で上書きしない
      if (document.getElementById('exam-room-select')?.value || this._viewAllRoomsPatients) return;
      container.innerHTML = gridHtml;
      // グリッドカードのクリックイベント
      container.querySelectorAll('[data-select-room]').forEach(card => {
        card.addEventListener('click', () => {
          const rid = card.dataset.selectRoom;
          AppState.currentExamRoomId = rid;
          this._viewAllRoomsPatients = false;
          const select = document.getElementById('exam-room-select');
          if (select) select.value = rid;
          this._renderQueue();
          this._updateScanInputState();
        });
      });
      return;
    }

    container.innerHTML = UI.loadingSpinnerHtml();
    if (historyArea) historyArea.hidden = false;
    if (historyList) historyList.innerHTML = UI.loadingSpinnerHtml();

    try {
      const { events, recentStatusLogs, recentAnnouncements } = await API.getExamRoomStatus(roomId);
      const relevant = events.filter(e => CONFIG.ACTIVE_STATUSES.includes(e.current_status));
      this._eventWardById = new Map(relevant.map(event => [String(event.id), String(event.ward_id || '')]));
      this._notifyWardAcknowledgementChanges(relevant);
      this._renderNotificationHistory(recentStatusLogs, recentAnnouncements);

      // 患者名表示のクラスを設定 (CSS側のフォールバック用)
      const nameChk = document.getElementById('chk-exam-show-patient-names');
      if (nameChk && nameChk.checked) {
        container.classList.remove('hide-patient-names');
      } else {
        container.classList.add('hide-patient-names');
      }

      if (relevant.length === 0) {
        if (summaryContainer) {
          summaryContainer.innerHTML = `
            <div id="exam-summary-bar" style="display: flex; gap: 12px; margin-bottom: 16px; width: 100%;">
              <div class="summary-card">
                <div class="summary-icon" style="background: #eff6ff; color: #3b82f6;"><i class="fas fa-shipping-fast"></i></div>
                <div class="summary-body">
                  <div class="summary-value">0</div>
                  <div class="summary-label">移動中</div>
                </div>
              </div>
              <div class="summary-card">
                <div class="summary-icon" style="background: #fef3c7; color: #d97706;"><i class="fas fa-clock"></i></div>
                <div class="summary-body">
                  <div class="summary-value">0</div>
                  <div class="summary-label">待ち</div>
                </div>
              </div>
              <div class="summary-card">
                <div class="summary-icon" style="background: #e0f2fe; color: #0284c7;"><i class="fas fa-x-ray"></i></div>
                <div class="summary-body">
                  <div class="summary-value">0</div>
                  <div class="summary-label">検査中</div>
                </div>
              </div>
              <div class="summary-card">
                <div class="summary-icon" style="background: #fee2e2; color: #dc2626;"><i class="fas fa-bell"></i></div>
                <div class="summary-body">
                  <div class="summary-value">0</div>
                  <div class="summary-label">迎え要</div>
                </div>
              </div>
            </div>
          `;
          this._renderViewToggle(summaryContainer);
        }
        container.classList.remove('exam-queue-list-mode');
        container.innerHTML = UI.emptyStateHtml('現在待機中の患者はいません', { icon: 'fas fa-check-circle', iconStyle: 'color:#16a34a' });
        return;
      }

      // サマリーメトリクス計算
      let inTransitCount = 0;
      let waitingCount = 0;
      let inExamCount = 0;
      let pickupCount = 0;

      relevant.forEach(e => {
        if (e.current_status === 'DEPART_REGISTERED' || (!CONFIG.isStatusHidden('MOVING') && e.current_status === 'MOVING')) {
          inTransitCount++;
        } else if (!CONFIG.isStatusHidden('ARRIVED') && e.current_status === 'ARRIVED') {
          waitingCount++;
        } else if (e.current_status === 'IN_EXAM' || (!CONFIG.isStatusHidden('NEARLY_DONE') && e.current_status === 'NEARLY_DONE')) {
          inExamCount++;
        } else if (e.current_status === 'PICKUP_REQUIRED') {
          pickupCount++;
        }
      });

      if (summaryContainer) {
        summaryContainer.innerHTML = `
          <div id="exam-summary-bar" style="display: flex; gap: 12px; margin-bottom: 16px; width: 100%;">
            <div class="summary-card">
              <div class="summary-icon" style="background: #eff6ff; color: #3b82f6;"><i class="fas fa-shipping-fast"></i></div>
              <div class="summary-body">
                <div class="summary-value">${inTransitCount}</div>
                <div class="summary-label">移動中</div>
              </div>
            </div>
            <div class="summary-card">
              <div class="summary-icon" style="background: #fef3c7; color: #d97706;"><i class="fas fa-clock"></i></div>
              <div class="summary-body">
                <div class="summary-value">${waitingCount}</div>
                <div class="summary-label">待ち</div>
              </div>
            </div>
            <div class="summary-card" style="border-color: #3b82f6;">
              <div class="summary-icon" style="background: #e0f2fe; color: #0284c7;"><i class="fas fa-x-ray"></i></div>
              <div class="summary-body">
                <div class="summary-value">${inExamCount}</div>
                <div class="summary-label">検査中</div>
              </div>
            </div>
            <div class="summary-card ${pickupCount > 0 ? 'alert' : ''}">
              <div class="summary-icon"><i class="fas fa-bell"></i></div>
              <div class="summary-body">
                <div class="summary-value">${pickupCount}</div>
                <div class="summary-label">迎え要</div>
              </div>
            </div>
          </div>
        `;
        this._renderViewToggle(summaryContainer);
      }

      // 優先度・待機時間での並べ替え
      const statusPriority = {
        'PICKUP_REQUIRED': 1,
        'NEARLY_DONE': 2,
        'IN_EXAM': 3,
        'ARRIVED': 4,
        'MOVING': 5,
        'DEPART_REGISTERED': 6
      };

      const getTimestampForStatus = (e) => {
        switch (e.current_status) {
          case 'PICKUP_REQUIRED': return e.pickup_ready_at || e.updated_at || e.created_at || 0;
          case 'NEARLY_DONE': return e.nearly_done_at || e.updated_at || e.created_at || 0;
          case 'IN_EXAM': return e.exam_started_at || e.updated_at || e.created_at || 0;
          case 'ARRIVED': return e.arrived_at || e.updated_at || e.created_at || 0;
          case 'MOVING': return e.departed_at || e.updated_at || e.created_at || 0;
          case 'DEPART_REGISTERED': return e.created_at || 0;
          default: return e.updated_at || e.created_at || 0;
        }
      };

      relevant.sort((a, b) => {
        const priA = statusPriority[a.current_status] || 99;
        const priB = statusPriority[b.current_status] || 99;
        if (priA !== priB) {
          return priA - priB;
        }
        const timeA = getTimestampForStatus(a);
        const timeB = getTimestampForStatus(b);
        return timeA - timeB;
      });

      const viewMode = this._getViewMode();
      container.classList.toggle('exam-queue-list-mode', viewMode === 'list');
      container.innerHTML = viewMode === 'list'
        ? this._renderQueueList(relevant, { showRoom: showingAllRooms })
        : relevant.map(e => this._renderQueueCard(e, { showRoom: showingAllRooms })).join('');

      this._bindQueueEvents(container);

      container.querySelectorAll('.btn-update-exam-pickup').forEach(btn => {
        btn.addEventListener('click', async () => {
          const eventId = btn.dataset.eventId;
          const card = btn.closest('.exam-queue-card, .exam-queue-row');
          const timeInput = card.querySelector(`.exam-pickup-time-input[data-event-id="${eventId}"]`);
          if (!timeInput) return;
          const timeStr = timeInput.value;
          if (!timeStr || !timeStr.includes(':')) return;

          btn.disabled = true;
          const oldHtml = btn.innerHTML;
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

          try {
            const [hh, mm] = timeStr.split(':').map(Number);
            const activeEvent = AppState.activeEvents.find(e => e.id === eventId) ||
                                AppState.todayEvents.find(e => e.id === eventId);
            const refDate = activeEvent && activeEvent.estimated_pickup_at ? activeEvent.estimated_pickup_at : Date.now();
            const date = new Date(refDate);
            date.setHours(hh, mm, 0, 0);
            const newEstimated = date.getTime();
            const oldTime = activeEvent?.estimated_pickup_at ? UI.formatTime(activeEvent.estimated_pickup_at) : '--:--';
            if (oldTime !== timeStr) {
              const ok = await UI.confirmModal(
                `検査終了目安を ${oldTime} から ${timeStr} に変更しますか？`,
                { title: '検査終了目安を変更', confirmLabel: '変更する' }
              );
              if (!ok) return;
            }

            await API.patch('transfer_events', eventId, { estimated_pickup_at: newEstimated });
            UI.toast('検査終了目安を変更しました', 'success');
            
            await App.refreshData({ force: true });
            await this._renderQueue();
          } catch (err) {
            console.error(err);
            UI.toast('時間の変更に失敗しました', 'danger');
          } finally {
            btn.disabled = false;
            btn.innerHTML = oldHtml;
          }
        });
      });

      // 更新時のビジュアルフラッシュ処理
      if (this._pendingFlashEventId) {
        const eventId = this._pendingFlashEventId;
        this._pendingFlashEventId = null;
        setTimeout(() => {
          const card = container.querySelector(`.exam-queue-card[data-event-id="${eventId}"], .exam-queue-row[data-event-id="${eventId}"]`);
          if (card) {
            card.style.backgroundColor = '#dcfce7'; // 薄い緑色
            setTimeout(() => {
              card.style.transition = 'background-color 0.8s ease';
              card.style.backgroundColor = '';
            }, 100);
          }
        }, 50);
      }
    } catch (e) {
      console.error(e);
      container.innerHTML = UI.emptyStateHtml('読み込みに失敗しました', { icon: null });
      if (historyList) {
        historyList.innerHTML = UI.emptyStateHtml('通知履歴を取得できませんでした', { icon: null });
      }
    }
  },

  _renderQueueCard(event, { showRoom = false } = {}) {
    const bed = AppState.getBedById(event.bed_id);
    const examType = AppState.getExamTypeById(event.exam_type_id);
    const staff = AppState.getStaffById(event.escort_staff_id);
    const now = Date.now();
    const remaining = event.estimated_pickup_at ? event.estimated_pickup_at - now : null;

    // 患者名非表示チェック状態を取得
    const nameChk = document.getElementById('chk-exam-show-patient-names');
    const showNames = nameChk ? nameChk.checked : false;

    // 描画段階で直接値を「＊＊＊＊」にする（ブラウザの描画ラグによる一瞬の露出を根本防止）
    const sourcePatientName = String(event.patient_name || bed?.patient_name || '').trim();
    const sourcePatientId = String(event.patient_id || bed?.patient_id || '').trim();
    const patientNameText = sourcePatientName
      ? (showNames ? UI.escapeHTML(sourcePatientName) : '＊＊＊＊')
      : null;
    const patientIdText = sourcePatientName
      ? (showNames ? UI.escapeHTML(sourcePatientId) : '＊＊＊＊')
      : '';

    const actionBtns = this._renderActionButtons(event);

    // 経過時間タイマーと標準時間超過の判定
    let elapsedHtml = '';
    if (event.exam_started_at) {
      const elapsedMin = Math.floor((now - event.exam_started_at) / 60000);
      const standardMin = examType ? examType.standard_duration_min : null;
      const isOver = standardMin !== null && elapsedMin > standardMin;
      const warningHtml = isOver 
        ? ` <span style="color:#dc2626; font-weight:700; margin-left:4px;"><i class="fas fa-exclamation-triangle"></i> 標準超過</span>` 
        : '';
      elapsedHtml = `
        <div class="exam-card-info-row">
          <span class="label">経過時間</span>
          <span class="${isOver ? 'text-danger' : ''}" style="${isOver ? 'color:#dc2626; font-weight:700;' : ''}">
            ${elapsedMin} 分 ${warningHtml}
          </span>
        </div>
      `;
    }

    let icHtml = '';
    if (event.patient_ic_tag_id) {
      icHtml = `<span style="background:#e0f2fe; color:#0369a1; padding:2px 5px; border-radius:4px; font-size:9px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #bae6fd; vertical-align:middle; margin-left:6px;" title="ICカードID: ${UI.escapeHTML(event.patient_ic_tag_id)}"><i class="fas fa-id-card"></i> IC</span>`;
    }
    let roomBadgeHtml = '';
    if (showRoom) {
      const roomName = AppState.getExamRoomById(event.exam_room_id)?.name || '検査室不明';
      roomBadgeHtml = `<span style="background:#ede9fe; color:#6d28d9; padding:1px 5px; border-radius:3px; font-size:9px; font-weight:700; vertical-align:middle; margin-left:6px;">${UI.escapeHTML(roomName)}</span>`;
    }
    const wardAckHtml = this._renderWardAcknowledgement(event);

    return `
      <div class="exam-queue-card status-${UI.escapeHTML(event.current_status)}" data-event-id="${UI.escapeHTML(event.id)}">
        <div class="exam-card-header" style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; flex-direction:column; gap:2px;">
            <span class="exam-card-bed">${bed ? UI.escapeHTML(UI.formatExamBedLocationPlain(bed)) : '?'} ${roomBadgeHtml}${icHtml}</span>
            ${patientNameText ? `
              <div class="exam-patient-name" style="font-weight:700; font-size:12px; color:#1e293b; display:block; position:relative; min-height:16px;">${patientNameText}</div>
              <div class="exam-patient-name" style="font-size:10px; color:#64748b; display:block; position:relative; min-height:12px; margin-top:2px;">${patientIdText}</div>
            ` : '<div style="font-size:11px; color:#94a3b8; font-style:italic;">患者情報なし</div>'}
          </div>
          ${UI.statusBadge(event.current_status)}
        </div>
        ${wardAckHtml}
        <div class="exam-card-info">
          <div class="exam-card-info-row">
            <span class="label">検査種別</span>
            <span>${examType ? `${UI.examImage(examType, 'type', 'history-exam-image')}${UI.escapeHTML(examType.name)}` : '--'}</span>
          </div>
          <div class="exam-card-info-row">
            <span class="label">出棟時刻</span>
            <span>${UI.formatTimeSmart(event.departed_at)}</span>
          </div>
          <div class="exam-card-info-row">
            <span class="label">検査開始</span>
            <span>${UI.formatTimeSmart(event.exam_started_at)}</span>
          </div>
          ${elapsedHtml}
          ${event.estimated_pickup_at ? `
          <div class="exam-card-info-row exam-pickup-control" style="align-items: center;">
            <span class="label">検査終了目安</span>
            <span style="display:inline-flex; align-items:center; gap:4px;">
              <input type="time" class="exam-pickup-time-input" data-event-id="${UI.escapeHTML(event.id)}" value="${UI.formatTime(event.estimated_pickup_at)}" style="padding: 2px 4px; border: 1px solid #cbd5e0; border-radius: 4px; font-family: inherit; font-size: 12px; font-weight: bold; width: 80px; height: 24px; box-sizing: border-box;">
              <button class="btn btn-primary btn-sm btn-update-exam-pickup" data-event-id="${UI.escapeHTML(event.id)}" style="padding: 2px 6px; font-size: 11px; width: auto; height: 24px; min-width: 0; line-height: 1; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;">変更</button>
            </span>
          </div>` : ''}
          ${event.note ? `
          <div class="exam-card-info-row">
            <span class="label">備考</span>
            <span>${UI.escapeHTML(event.note)}</span>
          </div>` : ''}
          ${staff ? `
          <div class="exam-card-info-row">
            <span class="label">付き添い</span>
            <span><i class="fas fa-user-nurse"></i> ${UI.escapeHTML(staff.name)}</span>
          </div>` : ''}
        </div>
        <div class="exam-card-actions">
          <div class="exam-primary-actions">
            ${actionBtns}
          </div>
          <div class="exam-secondary-actions">
            <button class="btn btn-success btn-sm btn-call-ward" data-event-id="${UI.escapeHTML(event.id)}" title="病棟へ連絡">
              <i class="fas fa-phone"></i> 病棟へコール
            </button>
          </div>
        </div>
      </div>
    `;
  },

  _renderActionButtons(event) {
    const actions = CONFIG.getAllowedActions(event.current_status, CONFIG.STATUS_SCOPE.EXAM);
    return actions.map(a => {
      const label = this._getExamActionLabel(event, a);
      return `<button class="btn ${UI.escapeHTML(a.cls)} btn-sm" data-exam-action="${UI.escapeHTML(a.toStatus)}" data-event-id="${UI.escapeHTML(event.id)}" data-current-status="${UI.escapeHTML(event.current_status)}">
        ${UI.escapeHTML(label)}
      </button>`;
    }).join('');
  },

  _renderWardAcknowledgement(event, { compact = false } = {}) {
    if (!CONFIG.WARD_ACK_STATUSES.includes(event.current_status)) return '';
    const log = event.latest_status_log;
    if (log?.acknowledged_at) {
      const wardName = log.acknowledged_by || AppState.wards.find(ward => ward.id === event.ward_id)?.name || '病棟';
      return `<span class="exam-ward-ack is-acknowledged${compact ? ' is-compact' : ''}">
        <i class="fas fa-check-circle"></i> ${UI.escapeHTML(wardName)}確認済 ${UI.escapeHTML(UI.formatTimeSmart(log.acknowledged_at))}
      </span>`;
    }
    return `<span class="exam-ward-ack is-pending${compact ? ' is-compact' : ''}">
      <i class="fas fa-hourglass-half"></i> 病棟確認待ち
    </span>`;
  },

  _notifyWardAcknowledgementChanges(events) {
    const activeLogIds = new Set();
    events.forEach(event => {
      if (!CONFIG.WARD_ACK_STATUSES.includes(event.current_status)) return;
      const log = event.latest_status_log;
      if (!log?.id) return;
      const logId = String(log.id);
      const acknowledged = !!log.acknowledged_at;
      const previous = this._wardAcknowledgementState.get(logId);
      activeLogIds.add(logId);
      this._wardAcknowledgementState.set(logId, acknowledged);
      if (previous === false && acknowledged) {
        const bed = AppState.getBedById(event.bed_id);
        const bedName = bed ? UI.formatExamBedLocationPlain(bed) : '患者';
        const wardName = log.acknowledged_by || AppState.wards.find(ward => ward.id === event.ward_id)?.name || '病棟';
        UI.toast(`${wardName}が${bedName}の通知を確認しました`, 'success', 5000);
      }
    });
    [...this._wardAcknowledgementState.keys()].forEach(logId => {
      if (!activeLogIds.has(logId)) this._wardAcknowledgementState.delete(logId);
    });
  },

  _renderNotificationHistory(logs, announcements) {
    const list = document.getElementById('exam-notification-history-list');
    if (!list) return;
    if (Array.isArray(logs)) this._notificationHistoryLogs = logs;
    if (Array.isArray(announcements)) this._notificationHistoryAnnouncements = announcements;

    const unconfirmedOnly = document.getElementById('exam-notification-history-unconfirmed-only');
    if (unconfirmedOnly && !unconfirmedOnly.dataset.listenerBound) {
      unconfirmedOnly.checked = localStorage.getItem('cfg_exam_notification_history_unconfirmed_only') === 'true';
      unconfirmedOnly.dataset.listenerBound = 'true';
      unconfirmedOnly.addEventListener('change', () => {
        localStorage.setItem('cfg_exam_notification_history_unconfirmed_only', unconfirmedOnly.checked ? 'true' : 'false');
        this._renderNotificationHistory();
      });
    }

    // 状態変更通知と、この検査室が受信したアナウンス送信履歴を1つの時系列に統合する。
    // アナウンスには確認/未確認の概念が無いため、「未確認のみ」表示中は対象外にする
    const statusEntries = (this._notificationHistoryLogs || [])
      .filter(log => !unconfirmedOnly?.checked || (
        CONFIG.WARD_ACK_STATUSES.includes(String(log.to_status || '')) && !log.acknowledged_at
      ))
      .map(log => ({ kind: 'status', time: Number(log.changed_at || 0), log }));
    const announceEntries = unconfirmedOnly?.checked
      ? []
      : (this._notificationHistoryAnnouncements || []).map(msg => ({ kind: 'announce', time: Number(msg.created_at || 0), msg }));
    const items = statusEntries.concat(announceEntries)
      .sort((a, b) => b.time - a.time)
      .slice(0, 20);
    if (items.length === 0) {
      const emptyLabel = unconfirmedOnly?.checked ? '未確認の通知はありません' : '通知履歴はありません';
      list.innerHTML = UI.emptyStateHtml(emptyLabel, { icon: 'fas fa-bell-slash' });
      return;
    }

    const showPatientNames = document.getElementById('chk-exam-show-patient-names')?.checked === true;
    list.innerHTML = items.map(entry => (
      entry.kind === 'announce'
        ? this._renderAnnounceHistoryItem(entry.msg)
        : this._renderStatusHistoryItem(entry.log, showPatientNames)
    )).join('');
  },

  _renderStatusHistoryItem(log, showPatientNames) {
    const bed = AppState.getBedById(log.bed_id);
    const ward = AppState.wards.find(item => String(item.id) === String(log.ward_id));
    const status = String(log.to_status || '');
    const statusLabel = CONFIG.STATUS_LABEL[status] || status || '状態変更';
    const statusIcon = CONFIG.STATUS_ICON[status] || 'fa-info-circle';
    const patientName = String(log.patient_name || bed?.patient_name || '').trim();
    const patientLabel = patientName ? (showPatientNames ? patientName : '＊＊＊＊') : '';
    const detailLabel = [patientLabel, ward?.name || ''].filter(Boolean).join(' / ');
    const changedDate = new Date(Number(log.changed_at || 0));
    const nowDate = new Date();
    const isToday = changedDate.getFullYear() === nowDate.getFullYear() &&
      changedDate.getMonth() === nowDate.getMonth() &&
      changedDate.getDate() === nowDate.getDate();
    const timeLabel = isToday
      ? UI.formatTime(log.changed_at)
      : `${changedDate.getMonth() + 1}/${changedDate.getDate()} ${UI.formatTime(log.changed_at)}`;
    const needsWardAck = CONFIG.WARD_ACK_STATUSES.includes(status);
    const ackHtml = !needsWardAck ? '' : log.acknowledged_at
      ? `<span class="notification-history-ack is-acknowledged"><i class="fas fa-check-circle"></i> ${UI.escapeHTML(log.acknowledged_by || ward?.name || '病棟')}確認済 ${UI.escapeHTML(UI.formatTimeSmart(log.acknowledged_at))}</span>`
      : '<span class="notification-history-ack is-pending"><i class="fas fa-hourglass-half"></i> 病棟確認待ち</span>';

    return `
      <div class="notification-history-item status-${UI.escapeHTML(status)}">
        <time>${UI.escapeHTML(timeLabel)}</time>
        <span class="notification-history-icon"><i class="fas ${UI.escapeHTML(statusIcon)}"></i></span>
        <div class="notification-history-open">
          <span class="notification-history-main">
            <strong>${bed ? UI.escapeHTML(UI.formatBedNamePlain(bed)) + '号床' : '病床不明'}</strong>
            <small>${UI.escapeHTML(detailLabel)}</small>
          </span>
          <span class="notification-history-status">${UI.escapeHTML(statusLabel)}</span>
        </div>
        ${ackHtml ? `<span class="notification-history-ack-row">${ackHtml}</span>` : ''}
      </div>`;
  },

  // アナウンス受信履歴には確認操作もbed_idも無いため、状態変更通知と同じ
  // レイアウトを流用しつつ、静的な行として描画する
  _renderAnnounceHistoryItem(msg) {
    const createdDate = new Date(Number(msg.created_at || 0));
    const nowDate = new Date();
    const isToday = createdDate.getFullYear() === nowDate.getFullYear() &&
      createdDate.getMonth() === nowDate.getMonth() &&
      createdDate.getDate() === nowDate.getDate();
    const timeLabel = isToday
      ? UI.formatTime(msg.created_at)
      : `${createdDate.getMonth() + 1}/${createdDate.getDate()} ${UI.formatTime(msg.created_at)}`;

    return `
      <div class="notification-history-item notification-history-item--announce">
        <time>${UI.escapeHTML(timeLabel)}</time>
        <span class="notification-history-icon"><i class="fas fa-bullhorn"></i></span>
        <div class="notification-history-open">
          <span class="notification-history-main">
            <strong>${UI.escapeHTML(msg.from_name || 'アナウンス')}</strong>
            <small>${UI.escapeHTML(msg.body || '')}</small>
          </span>
          <span class="notification-history-status">アナウンス</span>
        </div>
      </div>`;
  },

  _getViewMode() {
    return localStorage.getItem('tbs_exam_queue_view') === 'list' ? 'list' : 'card';
  },

  _renderViewToggle(host) {
    if (!host) return;
    const mode = this._getViewMode();
    host.insertAdjacentHTML('beforeend', `
      <div class="exam-view-toggle" style="justify-content:flex-end; margin:-8px 0 12px 0;">
        <button class="btn btn-outline btn-sm exam-view-btn ${mode === 'card' ? 'active' : ''}" data-exam-view="card" type="button"><i class="fas fa-th-large"></i> カード</button>
        <button class="btn btn-outline btn-sm exam-view-btn ${mode === 'list' ? 'active' : ''}" data-exam-view="list" type="button"><i class="fas fa-list"></i> 一覧</button>
      </div>
    `);
    host.querySelectorAll('[data-exam-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        localStorage.setItem('tbs_exam_queue_view', btn.dataset.examView);
        this._renderQueue();
      });
    });
  },

  _renderQueueList(events, { showRoom = false } = {}) {
    const rows = events.map(event => {
      const bed = AppState.getBedById(event.bed_id);
      const examType = AppState.getExamTypeById(event.exam_type_id);
      const staff = AppState.getStaffById(event.escort_staff_id);
      const now = Date.now();
      const nameChk = document.getElementById('chk-exam-show-patient-names');
      const showNames = nameChk ? nameChk.checked : false;
      const patientName = String(event.patient_name || bed?.patient_name || '').trim();
      const patientText = patientName ? (showNames ? UI.escapeHTML(patientName) : '＊＊＊＊') : '患者情報なし';
      const elapsedMin = event.exam_started_at ? Math.floor((now - event.exam_started_at) / 60000) : null;
      const standardMin = examType ? examType.standard_duration_min : null;
      const elapsedOver = elapsedMin !== null && standardMin !== null && elapsedMin > standardMin;
      const pickupHtml = event.estimated_pickup_at
        ? `<span style="display:inline-flex; align-items:center; gap:4px;">
            <input type="time" class="exam-pickup-time-input" data-event-id="${UI.escapeHTML(event.id)}" value="${UI.formatTime(event.estimated_pickup_at)}" style="padding:2px 4px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px; width:78px;">
            <button class="btn btn-primary btn-sm btn-update-exam-pickup" data-event-id="${UI.escapeHTML(event.id)}" style="padding:2px 6px;">変更</button>
          </span>`
        : '--';
      const roomLabel = showRoom
        ? `${UI.escapeHTML(AppState.getExamRoomById(event.exam_room_id)?.name || '検査室不明')} / `
        : '';
      return `
        <div class="exam-queue-row status-${UI.escapeHTML(event.current_status)}" data-event-id="${UI.escapeHTML(event.id)}">
          <div class="eqr-cell eqr-bed">${roomLabel}${bed ? UI.escapeHTML(UI.formatExamBedLocationPlain(bed)) : '?'}</div>
          <div class="eqr-cell" title="${UI.escapeHTML(patientName)}">${patientText}${event.patient_ic_tag_id ? ' <i class="fas fa-id-card" title="ICカード登録済"></i>' : ''}</div>
          <div class="eqr-cell eqr-status-cell">${UI.statusBadge(event.current_status)}${this._renderWardAcknowledgement(event, { compact: true })}</div>
          <div class="eqr-cell">${examType ? `${UI.examImage(examType, 'type', 'history-exam-image')}${UI.escapeHTML(examType.name)}` : '--'}</div>
          <div class="eqr-cell">${UI.formatTimeSmart(event.departed_at)}</div>
          <div class="eqr-cell">${UI.formatTimeSmart(event.exam_started_at)}</div>
          <div class="eqr-cell eqr-elapsed ${elapsedOver ? 'text-danger' : ''}">${elapsedMin === null ? '--' : `${elapsedMin}分`}</div>
          <div class="eqr-cell">${staff ? `<i class="fas fa-user-nurse"></i> ${UI.escapeHTML(staff.name)}` : '--'}</div>
          <div class="eqr-cell">${pickupHtml}</div>
          <div class="eqr-actions">
            ${this._renderActionButtons(event)}
            <button class="btn btn-success btn-sm btn-call-ward" data-event-id="${UI.escapeHTML(event.id)}" title="病棟へ連絡"><i class="fas fa-phone"></i></button>
          </div>
        </div>`;
    }).join('');
    return `
      <div class="exam-queue-list">
        <div class="exam-queue-row exam-queue-row--head">
          <div>病床</div><div>患者名</div><div>状態</div><div>検査</div><div>出棟</div><div>開始</div><div>経過</div><div>付き添い</div><div>検査終了目安</div><div>操作</div>
        </div>
        ${rows}
      </div>`;
  },

  _bindQueueEvents(container) {
    container.querySelectorAll('[data-exam-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        // 連打防止: リクエスト中は同じカードの全ボタンを無効化する
        // (成功時はキューが再描画されるためそのままでよく、失敗時は_updateStatus側で戻す)
        const card = btn.closest('.exam-queue-card, .exam-queue-row');
        if (card) card.querySelectorAll('button').forEach(b => (b.disabled = true));
        const eventId = btn.dataset.eventId;
        const newStatus = btn.dataset.examAction;
        this._updateStatus(eventId, newStatus, btn.dataset.currentStatus || null, card);
      });
    });

    container.querySelectorAll('.btn-call-ward').forEach(btn => {
      btn.addEventListener('click', () => {
        const wardId = this._eventWardById?.get(String(btn.dataset.eventId || '')) || '';
        const ward = AppState.wards.find(w => String(w.id) === wardId);
        PhoneDialog.showWardPhone(ward);
      });
    });
  },

  async _updateStatus(eventId, newStatus, expectedStatus = null, card = null) {
    const event = AppState.activeEvents.find(e => e.id === eventId) ||
                  AppState.todayEvents.find(e => e.id === eventId);
    const currentStatus = expectedStatus || event?.current_status || null;
    if (!currentStatus) {
      await App.refreshData({ force: true });
      await this._renderQueue();
      UI.toast('他端末で更新済みです。最新状態に更新しました。', 'warning');
      return;
    }

    let extraFields = {};
    if (newStatus === 'PICKUP_REQUIRED') {
      const bed = event ? AppState.getBedById(event.bed_id) : null;
      const bedLabel = bed ? UI.formatExamBedLocationPlain(bed) : '患者';
      const chosen = await this._selectPickupAssistance(bedLabel);
      if (!chosen) {
        if (card) card.querySelectorAll('button').forEach(b => (b.disabled = false));
        return;
      }
      extraFields = chosen;
    }

    try {
      await API.updateEventStatus(eventId, newStatus, extraFields, CONFIG.STATUS_SCOPE.EXAM, currentStatus);
      const label = CONFIG.STATUS_LABEL[newStatus];
      UI.toast(`${label} に更新しました`, 'success');
      UI.playScanSound(true);
      this._pendingFlashEventId = eventId;

      await App.refreshData({ force: true });
      await this._renderQueue();
    } catch (e) {
      console.error(e);
      if (card) card.querySelectorAll('button').forEach(b => (b.disabled = false));
      if (await App.handleDataConflict(e)) {
        UI.playScanSound(false);
        return;
      }
      UI.toast('更新に失敗しました', 'danger');
      UI.playScanSound(false);
    }
  },

  // ── 全検査室グリッド ──────────────────────────────────
  async _renderRoomGrid() {
    if (!AppState.examRooms || AppState.examRooms.length === 0) {
      return UI.emptyStateHtml('検査室が登録されていません', {
        icon: 'fas fa-hospital-symbol',
        hint: '設定 → 検査室マスタ から登録してください。',
      });
    }

    // 検査室は病棟をまたいで共有されるため、病棟横断の専用集計データを使う。
    // 患者情報を含むイベント本体は取得しない。取得失敗時は直前の成功結果、
    // 初回失敗時だけ現病棟の状態を最小項目へ縮めてフォールバックする。
    let allActiveEvents;
    try {
      allActiveEvents = await API.getExamRoomGridStatus();
      this._roomGridStatusCache = allActiveEvents;
    } catch (e) {
      allActiveEvents = this._roomGridStatusCache.length > 0
        ? this._roomGridStatusCache
        : AppState.activeEvents.map(event => ({
          exam_room_id: event.exam_room_id,
          current_status: event.current_status,
        }));
    }

    const activeStatuses = new Set(CONFIG.ACTIVE_STATUSES);
    const movingSet  = new Set(['DEPART_REGISTERED', ...(CONFIG.isStatusHidden('MOVING') ? [] : ['MOVING'])]);
    const examSet    = new Set([
      ...(CONFIG.isStatusHidden('ARRIVED') ? [] : ['ARRIVED']),
      'IN_EXAM',
      ...(CONFIG.isStatusHidden('NEARLY_DONE') ? [] : ['NEARLY_DONE']),
    ]);
    const pickupSet  = new Set(['PICKUP_REQUIRED']);

    const cards = AppState.examRooms.map(room => {
      const events = allActiveEvents.filter(
        e => e.exam_room_id === room.id && activeStatuses.has(e.current_status)
      );
      const total   = events.length;
      const moving  = events.filter(e => movingSet.has(e.current_status)).length;
      const inExam  = events.filter(e => examSet.has(e.current_status)).length;
      const pickup  = events.filter(e => pickupSet.has(e.current_status)).length;

      const urgentClass = pickup > 0 ? 'examroom-card--urgent' : total > 0 ? 'examroom-card--active' : '';
      const countBadge  = total > 0
        ? `<span class="examroom-card-total ${pickup > 0 ? 'urgent' : ''}">${total}</span>`
        : `<span class="examroom-card-total empty">0</span>`;

      const pills = [];
      if (moving > 0) pills.push(`<span class="examroom-pill pill-moving"><i class="fas fa-walking"></i> 移動中 ${moving}</span>`);
      if (inExam > 0) pills.push(`<span class="examroom-pill pill-exam"><i class="fas fa-flask"></i> 検査中 ${inExam}</span>`);
      if (pickup > 0) pills.push(`<span class="examroom-pill pill-pickup"><i class="fas fa-bell"></i> 迎え要 ${pickup}</span>`);

      // ARRIVED / NEARLY_DONE が非表示の場合、その状態の患者は総数には含まれるが
      // 内訳pillには現れない。「患者なし」は総数0のときだけ表示する。
      const pillsHtml = pills.length
        ? `<div class="examroom-card-pills">${pills.join('')}</div>`
        : total > 0
          ? `<div class="examroom-card-empty-note">進行中 ${total}名</div>`
          : `<div class="examroom-card-empty-note">患者なし</div>`;
      return `
        <div class="examroom-card ${urgentClass}" data-select-room="${room.id}" tabindex="0" role="button"
          aria-label="${UI.escapeHTML(room.name)} — 患者${total}名">
          <div class="examroom-card-header">
            <div class="examroom-card-icon">${UI.examImage(room, 'room')}</div>
            <div class="examroom-card-info">
              <div class="examroom-card-name">${UI.escapeHTML(room.name)}</div>
              <div class="examroom-card-floor">${UI.escapeHTML(room.floor || '')}</div>
            </div>
            ${countBadge}
          </div>
          ${pillsHtml}
        </div>`;
    });

    const totalActiveAll = allActiveEvents.filter(e => activeStatuses.has(e.current_status)).length;
    const pickupAll = allActiveEvents.filter(e => e.current_status === 'PICKUP_REQUIRED').length;

    return `
      <div class="examroom-grid-header">
        <span>全 ${AppState.examRooms.length} 検査室 &nbsp;|&nbsp; 出棟中 <strong>${totalActiveAll}</strong> 名
          ${pickupAll > 0 ? `&nbsp;<span class="examroom-grid-pickup-badge"><i class="fas fa-bell"></i> 迎え要 ${pickupAll}</span>` : ''}
        </span>
        <span style="font-size:11px; color:#94a3b8;">カードをクリックして検査室を選択</span>
      </div>
      <div class="examroom-room-grid">${cards.join('')}</div>`;
  },

  // ── 「← 全検査室」戻るボタン制御 ────────────────────
  _updateBackButton(roomSelected) {
    const header = document.querySelector('#page-exam-room .page-header');
    if (!header) return;

    let backBtn = document.getElementById('btn-examroom-back');
    if (roomSelected) {
      if (!backBtn) {
        backBtn = document.createElement('button');
        backBtn.id = 'btn-examroom-back';
        backBtn.className = 'btn btn-outline btn-sm';
        backBtn.style.cssText = 'font-size:12px;';
        backBtn.innerHTML = '<i class="fas fa-th-large"></i> 全検査室一覧';
        backBtn.addEventListener('click', () => {
          AppState.currentExamRoomId = null;
          this._viewAllRoomsPatients = false;
          const select = document.getElementById('exam-room-select');
          if (select) select.value = '';
          this._renderQueue();
          this._updateScanInputState();
        });
        header.prepend(backBtn);
      }
    } else {
      backBtn?.remove();
    }
  },
};
