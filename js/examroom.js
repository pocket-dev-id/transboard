/**
 * TransBoard - 検査室進捗更新画面
 */

const ExamRoom = {

  _pendingFlashEventId: null,

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
        this._renderQueue();
        this._updateScanInputState();
      };
      if (prevValue) select.value = prevValue;
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
      if (!roomId) {
        icInput.disabled = true;
        icInput.placeholder = '検査室を選択してください';
        icInput.value = '';
      } else {
        icInput.disabled = false;
        icInput.placeholder = '患者ICスキャン口 (スキャンで自動遷移)';
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

  async _handleScan(icValue) {
    if (!icValue) return;

    // 編集モーダルのIC登録入力欄が開いている場合はそちらに流す（自動登録）
    const editIcInput = document.getElementById('m-ic-tag-id');
    if (editIcInput) {
      editIcInput.value = icValue;
      document.getElementById('btn-update-ic-tag')?.click();
      return;
    }

    // 新規出棟登録フォームのIC入力欄が開いている場合はそちらに流す（フィールド入力のみ）
    const newIcInput = document.getElementById('f-ic-tag-id');
    if (newIcInput && !newIcInput.disabled) {
      newIcInput.value = icValue;
      UI.toast('ICカードを読み取りました', 'info');
      return;
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
        ['DEPART_REGISTERED', 'MOVING', 'ARRIVED', 'IN_EXAM', 'NEARLY_DONE'].includes(ev.current_status)
      );

      const matchEvent = relevant.find(ev => ev.patient_ic_tag_id === icValue);
      if (!matchEvent) {
        UI.toast('該当する患者の移送イベントが見つかりません', 'warning');
        UI.playScanSound(false);
        return;
      }

      const statusActions = {
        DEPART_REGISTERED: { nextStatus: 'ARRIVED', message: '到着にしますか？' },
        MOVING: { nextStatus: 'ARRIVED', message: '到着にしますか？' },
        ARRIVED: { nextStatus: 'PICKUP_REQUIRED', message: '終了（迎え要）にしますか？' },
        IN_EXAM: { nextStatus: 'PICKUP_REQUIRED', message: '終了（迎え要）にしますか？' },
      };

      const action = statusActions[matchEvent.current_status];
      if (!action) {
        UI.toast('このステータスではICカードによる自動更新はできません', 'info');
        UI.playScanSound(false);
        return;
      }

      const bed = AppState.getBedById(matchEvent.bed_id);
      const bedName = bed ? UI.formatBedName(bed) : '患者';
      const currentLabel = CONFIG.STATUS_LABEL[matchEvent.current_status] || matchEvent.current_status;
      if (!confirm(`${bedName}（現在: ${currentLabel}）を${action.message}`)) {
        UI.playScanSound(false);
        return;
      }

      await API.updateEventStatus(matchEvent.id, action.nextStatus);
      const label = CONFIG.STATUS_LABEL[action.nextStatus];
      UI.toast(`[ICスキャン] ${bedName} → ${label}`, 'success');
      UI.playScanSound(true);
      this._pendingFlashEventId = matchEvent.id;

      await this._renderQueue();
      await App.refreshData();
    } catch (err) {
      console.error(err);
      UI.toast('ICスキャン処理中にエラーが発生しました', 'danger');
      UI.playScanSound(false);
    }
  },

  async _renderQueue() {
    const container = document.getElementById('exam-room-queue');
    const summaryContainer = document.getElementById('exam-room-summary-container');
    if (!container) return;

    const roomId = document.getElementById('exam-room-select')?.value;

    // 「← 全検査室」戻るボタンの表示制御
    this._updateBackButton(!!roomId);

    if (!roomId) {
      if (summaryContainer) summaryContainer.innerHTML = '';
      container.innerHTML = this._renderRoomGrid();
      // グリッドカードのクリックイベント
      container.querySelectorAll('[data-select-room]').forEach(card => {
        card.addEventListener('click', () => {
          const rid = card.dataset.selectRoom;
          AppState.currentExamRoomId = rid;
          const select = document.getElementById('exam-room-select');
          if (select) select.value = rid;
          this._renderQueue();
          this._updateScanInputState();
        });
      });
      return;
    }

    container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    try {
      const events = await API.getEventsForExamRoom(roomId);
      const relevant = events.filter(e =>
        ['DEPART_REGISTERED', 'MOVING', 'ARRIVED', 'IN_EXAM', 'NEARLY_DONE', 'PICKUP_REQUIRED'].includes(e.current_status)
      );

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
        }
        container.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle" style="color:#16a34a"></i><p>現在待機中の患者はいません</p></div>';
        return;
      }

      // サマリーメトリクス計算
      let inTransitCount = 0;
      let waitingCount = 0;
      let inExamCount = 0;
      let pickupCount = 0;

      relevant.forEach(e => {
        if (['DEPART_REGISTERED', 'MOVING'].includes(e.current_status)) {
          inTransitCount++;
        } else if (e.current_status === 'ARRIVED') {
          waitingCount++;
        } else if (['IN_EXAM', 'NEARLY_DONE'].includes(e.current_status)) {
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

      container.innerHTML = relevant.map(e => this._renderQueueCard(e)).join('');

      container.querySelectorAll('[data-exam-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const eventId = btn.dataset.eventId;
          const newStatus = btn.dataset.examAction;
          this._updateStatus(eventId, newStatus);
        });
      });

      container.querySelectorAll('.btn-call-ward').forEach(btn => {
        btn.addEventListener('click', () => {
          // 病棟側の電話番号表示（wardマスタから取得）
          const ward = AppState.wards.find(w => w.id === AppState.currentWardId);
          PhoneDialog.showWardPhone(ward);
        });
      });

      container.querySelectorAll('.btn-update-exam-pickup').forEach(btn => {
        btn.addEventListener('click', async () => {
          const eventId = btn.dataset.eventId;
          const card = btn.closest('.exam-queue-card');
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

            await API.patch('transfer_events', eventId, { estimated_pickup_at: newEstimated });
            UI.toast('迎え目安を変更しました', 'success');
            
            await App.refreshData();
            await this._renderQueue();
          } catch (err) {
            console.error(err);
            UI.toast('時間の変更に失敗しました', 'danger');
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
          const card = container.querySelector(`.exam-queue-card[data-event-id="${eventId}"]`);
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
      container.innerHTML = '<div class="empty-state"><p>読み込みに失敗しました</p></div>';
    }
  },

  _renderQueueCard(event) {
    const bed = AppState.getBedById(event.bed_id);
    const examType = AppState.getExamTypeById(event.exam_type_id);
    const staff = AppState.getStaffById(event.escort_staff_id);
    const now = Date.now();
    const remaining = event.estimated_pickup_at ? event.estimated_pickup_at - now : null;

    // 患者名非表示チェック状態を取得
    const nameChk = document.getElementById('chk-exam-show-patient-names');
    const showNames = nameChk ? nameChk.checked : false;

    // 描画段階で直接値を「＊＊＊＊」にする（ブラウザの描画ラグによる一瞬の露出を根本防止）
    const patientNameText = bed && bed.patient_name 
      ? (showNames ? bed.patient_name : '＊＊＊＊') 
      : null;
    const patientIdText = bed && bed.patient_name 
      ? (showNames ? (bed.patient_id || '') : '＊＊＊＊') 
      : '';

    const actions = CONFIG.EXAM_ROOM_ACTIONS[event.current_status] || [];
    const actionBtns = actions.map(a =>
      `<button class="btn ${a.cls} btn-sm" data-exam-action="${a.toStatus}" data-event-id="${event.id}">
        ${a.label}
      </button>`
    ).join('');

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
      icHtml = `<span style="background:#e0f2fe; color:#0369a1; padding:2px 5px; border-radius:4px; font-size:9px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #bae6fd; vertical-align:middle; margin-left:6px;" title="ICカードID: ${event.patient_ic_tag_id}"><i class="fas fa-id-card"></i> IC</span>`;
    }

    return `
      <div class="exam-queue-card status-${event.current_status}" data-event-id="${event.id}">
        <div class="exam-card-header" style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; flex-direction:column; gap:2px;">
            <span class="exam-card-bed">${bed ? UI.formatBedName(bed) : '?'} ${icHtml}</span>
            ${patientNameText ? `
              <div class="exam-patient-name" style="font-weight:700; font-size:12px; color:#1e293b; display:block; position:relative; min-height:16px;">${patientNameText}</div>
              <div class="exam-patient-name" style="font-size:10px; color:#64748b; display:block; position:relative; min-height:12px; margin-top:2px;">${patientIdText}</div>
            ` : '<div style="font-size:11px; color:#94a3b8; font-style:italic;">患者情報なし</div>'}
          </div>
          ${UI.statusBadge(event.current_status)}
        </div>
        <div class="exam-card-info">
          <div class="exam-card-info-row">
            <span class="label">検査種別</span>
            <span>${examType ? examType.name : '--'}</span>
          </div>
          <div class="exam-card-info-row">
            <span class="label">出棟時刻</span>
            <span>${UI.formatTime(event.departed_at)}</span>
          </div>
          <div class="exam-card-info-row">
            <span class="label">検査開始</span>
            <span>${UI.formatTime(event.exam_started_at)}</span>
          </div>
          ${elapsedHtml}
          ${event.estimated_pickup_at ? `
          <div class="exam-card-info-row" style="align-items: center;">
            <span class="label">迎え目安</span>
            <span style="display:inline-flex; align-items:center; gap:4px;">
              <input type="time" class="exam-pickup-time-input" data-event-id="${event.id}" value="${UI.formatTime(event.estimated_pickup_at)}" style="padding: 2px 4px; border: 1px solid #cbd5e0; border-radius: 4px; font-family: inherit; font-size: 12px; font-weight: bold; width: 80px; height: 24px; box-sizing: border-box;">
              <button class="btn btn-primary btn-sm btn-update-exam-pickup" data-event-id="${event.id}" style="padding: 2px 6px; font-size: 11px; width: auto; height: 24px; min-width: 0; line-height: 1; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;">変更</button>
            </span>
          </div>` : ''}
          ${event.note ? `
          <div class="exam-card-info-row">
            <span class="label">備考</span>
            <span>${event.note}</span>
          </div>` : ''}
          ${staff ? `
          <div class="exam-card-info-row">
            <span class="label">付き添い</span>
            <span><i class="fas fa-user-nurse"></i> ${staff.name}</span>
          </div>` : ''}
        </div>
        <div class="exam-card-actions">
          ${actionBtns}
          <button class="btn btn-success btn-sm btn-call-ward" data-event-id="${event.id}">
            <i class="fas fa-phone"></i> 病棟へコール
          </button>
        </div>
      </div>
    `;
  },

  async _updateStatus(eventId, newStatus) {
    const event = AppState.activeEvents.find(e => e.id === eventId) ||
                  AppState.todayEvents.find(e => e.id === eventId);

    try {
      await API.updateEventStatus(eventId, newStatus);
      const label = CONFIG.STATUS_LABEL[newStatus];
      UI.toast(`${label} に更新しました`, 'success');
      UI.playScanSound(true);
      this._pendingFlashEventId = eventId;
      
      await this._renderQueue();
      await App.refreshData();
    } catch (e) {
      console.error(e);
      UI.toast('更新に失敗しました', 'danger');
      UI.playScanSound(false);
    }
  },

  // ── 全検査室グリッド ──────────────────────────────────
  _renderRoomGrid() {
    if (!AppState.examRooms || AppState.examRooms.length === 0) {
      return `<div class="empty-state">
        <i class="fas fa-hospital-symbol"></i>
        <p>検査室が登録されていません</p>
        <p style="font-size:11px;margin-top:4px;">設定 → 検査室マスタ から登録してください。</p>
      </div>`;
    }

    const activeStatuses = new Set(CONFIG.ACTIVE_STATUSES);
    const movingSet  = new Set(['DEPART_REGISTERED', 'MOVING']);
    const examSet    = new Set(['ARRIVED', 'IN_EXAM', 'NEARLY_DONE']);
    const pickupSet  = new Set(['PICKUP_REQUIRED']);

    const cards = AppState.examRooms.map(room => {
      const events = AppState.activeEvents.filter(
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

      const pillsHtml = pills.length
        ? `<div class="examroom-card-pills">${pills.join('')}</div>`
        : `<div class="examroom-card-empty-note">患者なし</div>`;

      return `
        <div class="examroom-card ${urgentClass}" data-select-room="${room.id}" tabindex="0" role="button"
          aria-label="${UI.escapeHTML(room.name)} — 患者${total}名">
          <div class="examroom-card-header">
            <div class="examroom-card-icon"><i class="fas fa-x-ray"></i></div>
            <div class="examroom-card-info">
              <div class="examroom-card-name">${UI.escapeHTML(room.name)}</div>
              <div class="examroom-card-floor">${UI.escapeHTML(room.floor || '')}</div>
            </div>
            ${countBadge}
          </div>
          ${pillsHtml}
        </div>`;
    });

    const totalActiveAll = AppState.activeEvents.filter(e => activeStatuses.has(e.current_status)).length;
    const pickupAll = AppState.activeEvents.filter(e => e.current_status === 'PICKUP_REQUIRED').length;

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
