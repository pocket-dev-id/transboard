/**
 * TransBoard - 病床詳細・移送開始モーダル
 */

const BedModal = {
  currentBedId: null,
  currentEventId: null,
  currentEventStatus: null,
  _pendingTransferEventId: null,
  _pendingFlash: false,

  open(bedId) {
    if (this.currentBedId !== bedId) {
      this._pendingTransferEventId = null;
      this._historyCache = null;
      this._historyVisibleCount = 5;
    }
    this.currentBedId = bedId;
    const bed = AppState.getBedById(bedId);
    if (!bed) return;

    const event = AppState.getActiveEventForBed(bedId);
    this.currentEventId = event ? event.id : null;
    this.currentEventStatus = event ? event.current_status : null;

    const overlay = document.getElementById('bed-modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    const footer = document.getElementById('modal-footer');

    title.innerHTML = `${UI.formatBedName(bed)}号床`;
    overlay.classList.remove('hidden');

    // 在室管理モード判定
    const admMode = AppState.systemSettings?.find(s => s.id === 'admission_mode')?.value || 'csv';
    const isManual = admMode === 'manual' || admMode === 'hybrid';

    const modal = document.getElementById('bed-modal');
    if (event) {
      body.innerHTML = this._renderEventDetail(bed, event) + this._renderBedHistorySection(bedId);
      footer.innerHTML = this._renderActionButtons(event, isManual);
      // 迎え要ステータスのとき警戒色を付与
      if (event.current_status === 'PICKUP_REQUIRED') {
        modal.classList.add('status-urgent');
      } else {
        modal.classList.remove('status-urgent');
      }
    } else {
      modal.classList.remove('status-urgent');
      // 手動/ハイブリッドモードでは在室登録バナーを先頭に追加
      body.innerHTML = (isManual ? this._renderManualPatientBanner(bed) : '') + this._renderDepartForm(bed) + this._renderBedHistorySection(bedId);
      footer.innerHTML = `
        <button class="btn btn-primary btn-lg" id="btn-transfer-start" ${!bed.patient_name ? 'disabled' : ''}>
          <i class="fas fa-walking"></i> 移送を開始
        </button>
        ${isManual ? `
          <button class="btn btn-success" id="btn-patient-register" style="${bed.patient_name ? 'display:none;' : ''}">
            <i class="fas fa-user-plus"></i> 在室登録
          </button>
          <button class="btn btn-outline" id="btn-patient-edit" style="${!bed.patient_name ? 'display:none;' : ''}">
            <i class="fas fa-user-edit"></i> 患者情報を編集
          </button>
          <button class="btn btn-danger btn-sm" id="btn-patient-discharge" style="${!bed.patient_name ? 'display:none;' : ''}">
            <i class="fas fa-door-open"></i> 退院
          </button>
        ` : ''}
        <button class="btn btn-outline" id="btn-modal-cancel">キャンセル</button>
      `;
    }

    this._bindEvents(event);

    // 手動モード用ボタンイベント
    if (isManual) {
      document.getElementById('btn-patient-register')?.addEventListener('click', () => {
        this.close();
        PatientRegModal.open(bedId);
      });
      document.getElementById('btn-patient-edit')?.addEventListener('click', () => {
        this.close();
        PatientRegModal.open(bedId, bed);
      });
      document.getElementById('btn-patient-edit-inline')?.addEventListener('click', () => {
        this.close();
        PatientRegModal.open(bedId, bed);
      });
      document.getElementById('btn-patient-discharge')?.addEventListener('click', async () => {
        if (!await UI.confirmModal(`${UI.formatBedNamePlain(bed)}号床の患者（${UI.getPatientName(bed.patient_name)}）を退院しますか？`, { title: '退院確認', danger: true, confirmLabel: '退院する' })) return;
        try {
          await API.patch('beds', bedId, {
            patient_name: null, patient_id: null, is_present: false,
            admission_date: null, patient_note: null, manually_registered: false,
            _occupancySource: 'manual_discharge'
          });
          API.writeAuditLog('PATIENT_DISCHARGE', {
            targetType: 'bed', targetId: bedId,
            details: { bed_number: bed.bed_number, patient_id: bed.patient_id },
          });
          await App.loadMasters();
          BedMap.render();
          this.close();
          UI.toast('退院しました', 'success');
        } catch (e) {
          UI.toast('退院処理に失敗しました: ' + e.message, 'danger');
        }
      });
    }

    // Focus the first input field to prevent focus-stealing or uneditable state in Electron/Windows
    if (!event) {
      setTimeout(() => {
        // 新規登録フォームは検査種別にフォーカス（IC入力はPC/SC経由で自動入力のため不要）
        document.getElementById('f-exam-type')?.focus();
      }, 50);
    } else {
      const icSetting = AppState.systemSettings?.find(s => s.id === 'enable_patient_ic_association');
      const isIcEnabled = icSetting && icSetting.value === 'true';
      if (isIcEnabled) {
        setTimeout(() => {
          document.getElementById('m-ic-tag-id')?.focus();
        }, 50);
      }
    }

    if (this._pendingFlash) {
      this._pendingFlash = false;
      setTimeout(() => {
        const flashTarget = document.getElementById('m-ic-tag-id')?.parentElement?.parentElement;
        if (flashTarget) {
          flashTarget.style.backgroundColor = '#dcfce7'; // 薄い緑色
          setTimeout(() => {
            flashTarget.style.transition = 'background-color 0.8s ease';
            flashTarget.style.backgroundColor = '#f7fafc';
          }, 100);
        }
      }, 100);
    }
  },

  close() {
    document.getElementById('bed-modal-overlay').classList.add('hidden');
    this.currentBedId = null;
    this.currentEventId = null;
    this.currentEventStatus = null;
    this._pendingTransferEventId = null;
  },

  _getModalEventExpectedStatus(event) {
    return this.currentEventStatus || event?.current_status || null;
  },

  async _handleEventPatchConflict(err) {
    if (await App.handleDataConflict(err)) {
      this.close();
      return true;
    }
    return false;
  },

  // 手動モード用: 患者情報バナー（在室登録/編集導線）
  _renderManualPatientBanner(bed) {
    if (!bed.patient_name) {
      return `
        <div style="background:#f0fdf4;border:2px dashed #86efac;border-radius:8px;
          padding:14px 16px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div>
            <div style="font-weight:700;color:#15803d;font-size:13px;"><i class="fas fa-user-plus"></i> 空床 — 患者未登録</div>
            <div style="font-size:11.5px;color:#166534;margin-top:3px;">「在室登録」ボタンで患者情報を登録してください。</div>
          </div>
          <i class="fas fa-bed" style="font-size:24px;color:#86efac;"></i>
        </div>`;
    }
    const presence = bed.is_present ? '在床' : '不在';
    const presClr = bed.is_present ? '#16a34a' : '#dc2626';
    const admDate = bed.admission_date ? `<div style="font-size:11px;color:#6b7280;">入室日: ${UI.formatDateTime(bed.admission_date).split(' ')[0]}</div>` : '';
    const note = bed.patient_note ? `<div style="font-size:11px;color:#6b7280;margin-top:2px;"><i class="fas fa-sticky-note"></i> ${UI.escapeHTML(bed.patient_note)}</div>` : '';
    return `
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;
        padding:12px 14px;margin-bottom:12px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div>
          <div style="font-weight:700;font-size:15px;color:#1e293b;">${UI.escapeHTML(bed.patient_name)}</div>
          <div style="font-size:12px;color:#64748b;">${bed.patient_id ? 'ID: ' + UI.escapeHTML(bed.patient_id) : 'ID未設定'}</div>
          ${admDate}${note}
        </div>
        <span style="padding:3px 8px;border-radius:4px;font-size:11px;font-weight:800;color:#fff;
          background:${presClr};white-space:nowrap;">${presence}</span>
      </div>`;
  },

  _renderDepartForm(bed) {
    const formDisabled = !bed.patient_name;
    const disabledAttr = formDisabled ? 'disabled' : '';
    const examTypeOptions = AppState.examTypes.map(t =>
      `<option value="${UI.escapeHTML(t.id)}">${UI.escapeHTML(t.name)}（標準${UI.escapeHTML(t.standard_duration_min)}分）</option>`
    ).join('');

    const examRoomOptions = AppState.examRooms.map(r =>
      `<option value="${UI.escapeHTML(r.id)}">${UI.escapeHTML(r.name)}（${UI.escapeHTML(r.floor || '')}）</option>`
    ).join('');
    const examTypeCards = AppState.examTypes.map((t, idx) => `
      <button type="button" class="option-card ${idx === 0 ? 'selected' : ''}" data-select-target="f-exam-type" data-value="${UI.escapeHTML(t.id)}" ${disabledAttr}>
        <span class="option-card-title">${UI.escapeHTML(t.name)}</span>
        <span class="option-card-sub">標準 ${UI.escapeHTML(t.standard_duration_min)}分</span>
      </button>
    `).join('');
    const examRoomCards = AppState.examRooms.map((r, idx) => {
      const roomIcon = UI.normalizeExamRoomIcon(r.icon);
      return `
        <button type="button" class="option-card ${idx === 0 ? 'selected' : ''}" data-select-target="f-exam-room" data-value="${UI.escapeHTML(r.id)}" ${disabledAttr}>
          <span class="option-card-title"><i class="fas ${UI.escapeHTML(roomIcon)}"></i> ${UI.escapeHTML(r.name)}</span>
          <span class="option-card-sub">${UI.escapeHTML(r.floor || 'フロア未設定')}</span>
        </button>
      `;
    }).join('');

    const busyStaffIds = AppState.getBusyEscortStaffIds();
    const staffOptions = `<option value="">（なし）</option>` +
      AppState.staffs.filter(s => s.ward_id === AppState.currentWardId).map(s =>
        `<option value="${UI.escapeHTML(s.id)}">${UI.escapeHTML(s.name)}${busyStaffIds.has(s.id) ? '（⚠付き添い中）' : ''}</option>`
      ).join('');

    // 患者IC登録設定が有効かどうか
    const icSetting = AppState.systemSettings?.find(s => s.id === 'enable_patient_ic_association');
    const isIcEnabled = icSetting && icSetting.value === 'true';

    // 患者バナーの追加
    let patientBanner = '';
    if (bed.patient_name) {
      const presenceLabel = bed.is_present ? '在床' : '不在';
      const presenceColor = bed.is_present ? '#10b981' : '#ef4444';
      patientBanner = `
        <div style="background:#f7fafc; border:1px solid #e2e8f0; border-radius:6px; padding:10px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-size:11px; color:#718096;">入院患者</div>
            <div style="font-size:15px; font-weight:700; color:#2d3748;">${UI.escapeHTML(bed.patient_name)} <span style="font-size:12px; font-weight:normal; color:#4a5568;">(${UI.escapeHTML(bed.patient_id || 'ID未設定')})</span></div>
          </div>
          <span style="padding:3px 8px; border-radius:4px; font-size:10px; font-weight:800; color:#fff; background:${presenceColor};">${presenceLabel}</span>
        </div>
      `;
    } else {
      patientBanner = `
        <div style="background:#fff5f5; border:1px solid #fed7d7; border-radius:6px; padding:10px; margin-bottom:12px; font-size:12px; color:#c53030; font-weight:bold; text-align:center;">
          現在、この病床は空床です。移送は開始できません。
        </div>
      `;
    }

    return `
      ${patientBanner}
      <div class="status-display-row" style="${!bed.patient_name ? 'opacity:0.5;' : ''}">
        <span class="status-badge badge-IN_BED">在床</span>
        <span class="status-arrow"><i class="fas fa-arrow-right"></i></span>
        <span class="status-badge badge-MOVING">移動中</span>
      </div>
      <div class="form-row" style="${!bed.patient_name ? 'pointer-events:none; opacity:0.5;' : ''}">
        <label>検査種別 <span style="color:#dc2626">*</span></label>
        <select id="f-exam-type" class="visually-hidden-select" ${disabledAttr}>${examTypeOptions}</select>
        <div class="option-card-grid" role="listbox" aria-label="検査種別">${examTypeCards}</div>
      </div>
      <div class="form-row" style="${!bed.patient_name ? 'pointer-events:none; opacity:0.5;' : ''}">
        <label>行き先検査室 <span style="color:#dc2626">*</span></label>
        <select id="f-exam-room" class="visually-hidden-select" ${disabledAttr}>${examRoomOptions}</select>
        <div class="option-card-grid" role="listbox" aria-label="行き先検査室">${examRoomCards}</div>
      </div>
      <div class="form-row" style="${!bed.patient_name ? 'pointer-events:none; opacity:0.5;' : ''}">
        <label>付き添い看護師</label>
        <select id="f-escort-staff" ${disabledAttr}>${staffOptions}</select>
      </div>
      <div class="form-row" style="${!bed.patient_name ? 'pointer-events:none; opacity:0.5;' : ''}">
        <label>想定所要時間（分）</label>
        <input type="number" id="f-duration" min="5" max="300" placeholder="検査種別から自動設定" ${disabledAttr}>
      </div>
      ${isIcEnabled ? `
      <div class="form-row" style="${!bed.patient_name ? 'pointer-events:none; opacity:0.5;' : ''}">
        <label><i class="fas fa-id-card"></i> 患者ICカード（スキャン）登録</label>
        <input type="text" id="f-ic-tag-id" placeholder="スキャン口（カードをかざしてください）" ${disabledAttr}>
      </div>
      ` : ''}
      <div class="form-row" style="${!bed.patient_name ? 'pointer-events:none; opacity:0.5;' : ''}">
        <label>備考（車椅子・ストレッチャー等）</label>
        <textarea id="f-note" placeholder="例: 車椅子使用、酸素持参" ${disabledAttr}></textarea>
      </div>
    `;
  },

  // 病床履歴セクション(折りたたみ状態のスケルエトンのみ。フェッチはトグル初回クリック時)
  _renderBedHistorySection(bedId) {
    return `
      <div class="bed-history-section" data-bed-id="${UI.escapeHTML(bedId)}">
        <button type="button" class="bed-history-toggle" id="btn-bed-history-toggle">
          <i class="fas fa-history"></i> この病床の履歴
          <i class="fas fa-chevron-down bed-history-toggle-caret"></i>
        </button>
        <div class="bed-history-body hidden" id="bed-history-body"></div>
      </div>
    `;
  },

  // 過去イベント1件分の行(展開すると進捗タイムラインを表示)
  _renderBedHistoryRow(event, index) {
    const examType = AppState.getExamTypeById(event.exam_type_id);
    const examRoom = AppState.getExamRoomById(event.exam_room_id);
    const patientName = UI.getPatientName(event.patient_name || '');
    const startTime = event.departed_at || event.created_at;
    const durationHtml = (startTime && event.returned_at)
      ? `<span class="bed-history-duration">${UI.formatDuration(event.returned_at - startTime)}</span>`
      : '';
    return `
      <div class="bed-history-row" data-history-index="${index}">
        <div class="bed-history-row-main">
          <span class="bed-history-patient">${patientName ? UI.escapeHTML(patientName) : '患者名なし'}</span>
          <span class="bed-history-exam">${examType ? UI.escapeHTML(examType.name) : '--'}${examRoom ? ' / ' + UI.escapeHTML(examRoom.name) : ''}</span>
          ${UI.statusBadge(event.current_status)}
          <span class="bed-history-time"><i class="fas fa-clock"></i> ${UI.formatDateTime(startTime)} → ${event.returned_at ? UI.formatDateTime(event.returned_at) : '--'}</span>
          ${durationHtml}
          <i class="fas fa-chevron-down bed-history-row-caret"></i>
        </div>
        <div class="bed-history-row-detail hidden">${this._renderProgressTimelineHTML(event)}</div>
      </div>
    `;
  },

  // 病床履歴の取得(初回トグル時のみ)＋一覧描画。_historyCacheへ結果をキャッシュし、
  // 同一モーダル表示中の再トグルでは再フェッチしない。
  // 検査室移送履歴(transfer_events)と在室ログ(bed_occupancy_log、移送を伴わない
  // 入退院も含む)を並行取得し、1入院〜退院の滞在ごとに統合する
  async _loadBedHistory(bedId) {
    const bodyEl = document.getElementById('bed-history-body');
    if (!bodyEl) return;

    if (!this._historyCache || this._historyCache.bedId !== bedId) {
      bodyEl.innerHTML = '<div class="bed-history-empty"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div>';
      try {
        const [events, occupancy] = await Promise.all([
          API.getPastEventsForBed(bedId, AppState.currentWardId, this.currentEventId),
          API.getOccupancyHistoryForBed(bedId),
        ]);
        this._historyCache = { bedId, items: this._mergeBedHistory(events, occupancy) };
      } catch (err) {
        console.error('[BedHistory]', err);
        bodyEl.innerHTML = '<div class="bed-history-empty">履歴の取得に失敗しました</div>';
        return;
      }
    }
    this._renderBedHistoryList();
  },

  // 在室ログの各滞在(started_at〜ended_at)に含まれるtransfer_eventsを入れ子にする。
  // 在室ログに紐付かない(＝本機能導入前からの)transfer_eventsは単独行のまま残す
  _mergeBedHistory(events, occupancy) {
    const claimedEventIds = new Set();
    const occupancyItems = occupancy.map(occ => {
      const nested = events.filter(e => {
        const t = e.departed_at || e.created_at;
        return t != null && occ.started_at != null && occ.ended_at != null && t >= occ.started_at && t <= occ.ended_at;
      });
      nested.forEach(e => claimedEventIds.add(e.id));
      nested.sort((a, b) => (b.departed_at || b.created_at || 0) - (a.departed_at || a.created_at || 0));
      return { type: 'occupancy', time: occ.ended_at, occupancy: occ, nestedEvents: nested };
    });
    const standaloneItems = events
      .filter(e => !claimedEventIds.has(e.id))
      .map(e => ({ type: 'event', time: e.returned_at || e.created_at, event: e }));

    return [...occupancyItems, ...standaloneItems].sort((a, b) => (b.time || 0) - (a.time || 0));
  },

  _renderBedHistoryList() {
    const bodyEl = document.getElementById('bed-history-body');
    if (!bodyEl || !this._historyCache) return;

    const items = this._historyCache.items;
    const caveatHtml = '<div class="bed-history-caveat"><i class="fas fa-info-circle"></i> 検査室への移送を伴わない入退室は、本機能導入日以降の記録のみ表示されます。</div>';
    if (items.length === 0) {
      bodyEl.innerHTML = '<div class="bed-history-empty">過去の入退室履歴はありません</div>' + caveatHtml;
      return;
    }

    const visibleCount = Math.min(this._historyVisibleCount || 5, items.length);
    const rowsHtml = items.slice(0, visibleCount).map((item, i) => item.type === 'occupancy'
      ? this._renderOccupancyHistoryRow(item.occupancy, item.nestedEvents, i)
      : this._renderBedHistoryRow(item.event, i)
    ).join('');
    const remaining = items.length - visibleCount;
    const loadMoreHtml = remaining > 0
      ? `<button type="button" class="bed-history-loadmore" id="btn-bed-history-loadmore">もっと見る (+${Math.min(5, remaining)}件)</button>`
      : '';

    bodyEl.innerHTML = `<div class="bed-history-list">${rowsHtml}</div>${loadMoreHtml}${caveatHtml}`;
  },

  // 在室ログ1件分の行(1入院〜退院の滞在)。滞在中に検査室移送があれば
  // 展開して各移送(_renderBedHistoryRowを再利用)を表示する
  _renderOccupancyHistoryRow(occ, nestedEvents, index) {
    const patientName = UI.getPatientName(occ.patient_name || '');
    const hasTransfers = nestedEvents.length > 0;
    const nestedHtml = hasTransfers
      ? nestedEvents.map((e, i) => this._renderBedHistoryRow(e, `${index}-${i}`)).join('')
      : '';
    return `
      <div class="bed-history-occupancy-row" data-history-index="occ-${index}">
        <div class="bed-history-occupancy-row-main${hasTransfers ? '' : ' bed-history-occupancy-row-main--static'}">
          <span class="bed-history-patient">${patientName ? UI.escapeHTML(patientName) : '患者名なし'}</span>
          <span class="bed-history-time"><i class="fas fa-clock"></i> ${UI.formatDateTime(occ.started_at)} → ${occ.ended_at ? UI.formatDateTime(occ.ended_at) : '--'}</span>
          ${hasTransfers
            ? `<span class="bed-history-occupancy-badge"><i class="fas fa-exchange-alt"></i> 検査室へ移送あり (${nestedEvents.length}件)</span><i class="fas fa-chevron-down bed-history-row-caret"></i>`
            : `<span class="bed-history-no-transfer-badge">検査室への移送なし（在室のみ）</span>`}
        </div>
        ${hasTransfers ? `<div class="bed-history-occupancy-detail hidden">${nestedHtml}</div>` : ''}
      </div>
    `;
  },

  // 移送1件の進捗タイムライン(移送開始〜帰棟完了)HTML。現在進行中イベントと
  // 病床履歴の展開表示の両方から共有される
  _renderProgressTimelineHTML(event) {
    const timelineItems = [
      { label: '移送開始', time: event.departed_at || event.created_at, icon: 'walking' },
      { label: '検査室到着', time: event.arrived_at, icon: 'map-marker-alt' },
      { label: '検査開始', time: event.exam_started_at, icon: 'flask' },
      { label: 'あと10分', time: event.nearly_done_at, icon: 'clock' },
      { label: '迎え要', time: event.pickup_ready_at, icon: 'bell' },
      { label: '帰棟完了', time: event.returned_at, icon: 'home' },
    ].filter(item => item.time);

    return timelineItems.map(item => `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:12px;">
        <i class="fas fa-${item.icon}" style="color:#3b82f6;width:16px;text-align:center;"></i>
        <span style="font-weight:600;min-width:80px;">${item.label}</span>
        <span>${item.time ? UI.formatDateTime(item.time) : '--'}</span>
      </div>
    `).join('');
  },

  _renderEventDetail(bed, event) {
    const examType = AppState.getExamTypeById(event.exam_type_id);
    const examRoom = AppState.getExamRoomById(event.exam_room_id);
    const staff = AppState.getStaffById(event.escort_staff_id);
    const now = Date.now();
    const remaining = event.estimated_pickup_at ? event.estimated_pickup_at - now : null;
    const timelineHtml = this._renderProgressTimelineHTML(event);

    // 患者情報の表示バナー
    let patientBanner = '';
    if (bed.patient_name) {
      const presenceLabel = bed.is_present ? '在床' : '不在';
      const presenceColor = bed.is_present ? '#10b981' : '#ef4444';
      patientBanner = `
        <div style="background:#f7fafc; border:1px solid #e2e8f0; border-radius:6px; padding:10px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-size:11px; color:#718096;">入院患者</div>
            <div style="font-size:15px; font-weight:700; color:#2d3748;">${UI.escapeHTML(bed.patient_name)} <span style="font-size:12px; font-weight:normal; color:#4a5568;">(${UI.escapeHTML(bed.patient_id || 'ID未設定')})</span></div>
          </div>
          <span style="padding:3px 8px; border-radius:4px; font-size:10px; font-weight:800; color:#fff; background:${presenceColor};">${presenceLabel}</span>
        </div>
      `;
    }

    // 患者IC登録設定が有効かどうか
    const icSetting = AppState.systemSettings?.find(s => s.id === 'enable_patient_ic_association');
    const isIcEnabled = icSetting && icSetting.value === 'true';
    let icRegistrationHtml = '';
    
    if (isIcEnabled && event.current_status !== 'RETURNED' && event.current_status !== 'CANCELLED') {
      const currentIcTag = event.patient_ic_tag_id || '';
      const currentIcTagHtml = UI.escapeHTML(currentIcTag);
      icRegistrationHtml = `
        <div class="divider"></div>
        <div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#718096;"><i class="fas fa-id-card"></i> 患者ICカード（スキャン）登録</div>
        <div style="background:#f7fafc; border:1px solid #cbd5e0; border-radius:6px; padding:10px; display:flex; flex-direction:column; gap:8px;">
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="text" id="m-ic-tag-id" value="${currentIcTagHtml}" placeholder="スキャン口（カードをかざしてください）" style="flex:1; padding: 6px 10px; border: 1px solid #cbd5e0; border-radius: 4px; font-family: inherit; font-size: 13px;">
            <button class="btn btn-primary" id="btn-update-ic-tag" style="padding: 6px 12px; font-size: 13px; font-weight: bold; width: auto; height: auto;">登録</button>
            ${currentIcTag ? `<button class="btn btn-danger" id="btn-clear-ic-tag" style="padding: 6px 12px; font-size: 13px; font-weight: bold; width: auto; height: auto; background:#ef4444; border-color:#ef4444; color:#fff;">解除</button>` : ''}
          </div>
          <div style="font-size:11px; color:#718096; margin-top:2px;">
            <i class="fas fa-info-circle"></i> このダイアログを開いた状態でICカードをかざすと自動で登録されます。
          </div>
        </div>
      `;
    }

    const urgentBanner = event.current_status === 'PICKUP_REQUIRED'
      ? `<div class="modal-urgent-banner">
           <i class="fas fa-bell modal-urgent-bell"></i>
           <span>迎えが必要です。早急に対応してください。</span>
         </div>`
      : '';

    return `
      ${urgentBanner}
      ${patientBanner}
      <div style="margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          ${UI.statusBadge(event.current_status)}
          ${remaining !== null ? `<span class="priority-time ${UI.remainingClass(remaining)}">${UI.formatRemaining(remaining)}</span>` : ''}
        </div>
        <div class="modal-info-grid">
          <div class="modal-info-item">
            <div class="label">検査種別</div>
            <div class="value">${examType ? UI.escapeHTML(examType.name) : '--'}</div>
          </div>
          <div class="modal-info-item">
            <div class="label">行き先検査室</div>
            <div class="value">${examRoom ? UI.escapeHTML(examRoom.name) : '--'}</div>
          </div>
          <div class="modal-info-item">
            <div class="label">付き添い看護師</div>
            <div class="value" style="display:flex; align-items:center; gap:4px;">
              <select id="m-escort-staff" style="padding: 2px 4px; border: 1px solid #cbd5e0; border-radius: 4px; font-family: inherit; font-size: 13px; font-weight: bold; width: 120px;">
                ${`<option value="">（なし）</option>` + AppState.staffs.filter(s => s.ward_id === AppState.currentWardId).map(s => {
                  const isBusy = AppState.getBusyEscortStaffIds(event.id).has(s.id);
                  return `<option value="${UI.escapeHTML(s.id)}" ${event.escort_staff_id === s.id ? 'selected' : ''}>${UI.escapeHTML(s.name)}${isBusy ? '（⚠付き添い中）' : ''}</option>`;
                }).join('')}
              </select>
              <button class="btn btn-primary" id="btn-update-escort-staff" style="padding: 3px 6px; font-size: 11px; width: auto; height: auto; min-width: 0; line-height: 1;">変更</button>
            </div>
          </div>
          <div class="modal-info-item">
            <div class="label">迎え目安</div>
            <div class="value" style="display:flex; align-items:center; gap:4px;">
              <input type="time" id="m-pickup-time" value="${event.estimated_pickup_at ? UI.formatTime(event.estimated_pickup_at) : ''}" style="padding: 2px 4px; border: 1px solid #cbd5e0; border-radius: 4px; font-family: inherit; font-size: 13px; font-weight: bold; width: 85px;">
              <button class="btn btn-primary" id="btn-update-pickup-time" style="padding: 3px 6px; font-size: 11px; width: auto; height: auto; min-width: 0; line-height: 1;">変更</button>
            </div>
          </div>
          <div class="modal-info-item">
            <div class="label">想定所要時間</div>
            <div class="value">${event.expected_duration_min ? event.expected_duration_min + '分' : '--'}</div>
          </div>
          <div class="modal-info-item" style="grid-column: span 2; border-top: 1px dashed rgba(0,0,0,0.06); padding-top: 8px; margin-top: 4px;">
            <div class="label" style="margin-bottom:4px;">備考（車椅子・ストレッチャー等）</div>
            <div class="value" style="display:flex; align-items:center; gap:8px; width: 100%;">
              <input type="text" id="m-event-note" value="${UI.escapeHTML(event.note || '')}" placeholder="備考を入力" style="flex: 1; padding: 4px 8px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 12.5px; font-weight: bold;">
              <button class="btn btn-primary" id="btn-update-event-note" style="padding: 6px 12px; font-size: 12px; font-weight: bold; width: auto; height: auto; min-width: 0; line-height: 1.2;">変更</button>
            </div>
          </div>
        </div>
        ${icRegistrationHtml}
        <div class="divider"></div>
        <div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#718096;">進捗タイムライン</div>
        ${timelineHtml}
      </div>
    `;
  },

  _renderActionButtons(event, isManual = false) {
    const status = event.current_status;
    const actions = CONFIG.getAllowedActions(status, CONFIG.STATUS_SCOPE.WARD);

    if (actions.length === 0 && status !== 'RETURNED' && status !== 'CANCELLED') return '';

    // キャンセルは左（破壊的操作）、それ以外は右（主要操作）に分離
    const cancelAction = actions.find(a => a.toStatus === 'CANCELLED');
    const primaryActions = actions.filter(a => a.toStatus !== 'CANCELLED');

    const leftHtml = cancelAction
      ? `<button class="btn btn-secondary btn-sm modal-btn-cancel" data-action-status="CANCELLED">
           <i class="fas fa-ban"></i> キャンセル
         </button>`
      : '<span></span>';

    let rightHtml = `<button class="btn btn-outline btn-sm" id="btn-modal-close">閉じる</button>`;
    rightHtml += `<button class="btn modal-btn-call" id="btn-modal-call">
      <i class="fas fa-phone"></i> 検査室へコール
    </button>`;
    primaryActions.forEach(action => {
      rightHtml += `<button class="btn ${action.cls}" data-action-status="${action.toStatus}">${UI.escapeHTML(action.label)}</button>`;
    });
    if (isManual) {
      rightHtml += `<button class="btn btn-outline btn-sm" id="btn-patient-edit-inline">
        <i class="fas fa-user-edit"></i> 患者情報を編集
      </button>`;
    }

    return `<div class="modal-footer-split">
      <div class="modal-footer-left">${leftHtml}</div>
      <div class="modal-footer-right">${rightHtml}</div>
    </div>`;
  },

  _bindEvents(event) {
    // 閉じる
    document.getElementById('modal-close').onclick = () => this.close();
    document.getElementById('bed-modal-overlay').onclick = (e) => {
      if (e.target === document.getElementById('bed-modal-overlay')) this.close();
    };

    const cancelBtn = document.getElementById('btn-modal-cancel');
    if (cancelBtn) cancelBtn.onclick = () => this.close();
    const closeBtn = document.getElementById('btn-modal-close');
    if (closeBtn) closeBtn.onclick = () => this.close();

    // 病床履歴: トグル(初回のみフェッチ)＋行展開・もっと見るはイベント委譲
    const historyToggleBtn = document.getElementById('btn-bed-history-toggle');
    if (historyToggleBtn) {
      historyToggleBtn.onclick = async () => {
        const bodyEl = document.getElementById('bed-history-body');
        if (!bodyEl) return;
        const willShow = bodyEl.classList.contains('hidden');
        historyToggleBtn.classList.toggle('expanded', willShow);
        if (willShow) {
          bodyEl.classList.remove('hidden');
          await this._loadBedHistory(this.currentBedId);
        } else {
          bodyEl.classList.add('hidden');
        }
      };
    }
    const historyBodyEl = document.getElementById('bed-history-body');
    if (historyBodyEl) {
      historyBodyEl.onclick = (e) => {
        if (e.target.closest('#btn-bed-history-loadmore')) {
          this._historyVisibleCount = (this._historyVisibleCount || 5) + 5;
          this._renderBedHistoryList();
          return;
        }
        const occHeader = e.target.closest('.bed-history-occupancy-row-main');
        if (occHeader) {
          const detail = occHeader.parentElement.querySelector('.bed-history-occupancy-detail');
          if (detail) detail.classList.toggle('hidden');
          occHeader.classList.toggle('expanded', detail && !detail.classList.contains('hidden'));
          return;
        }
        const row = e.target.closest('.bed-history-row');
        if (row) {
          const detail = row.querySelector('.bed-history-row-detail');
          if (detail) detail.classList.toggle('hidden');
          row.classList.toggle('expanded', detail && !detail.classList.contains('hidden'));
        }
      };
    }

    // フォーカストラップのバインド
    const icSetting = AppState.systemSettings?.find(s => s.id === 'enable_patient_ic_association');
    const isIcEnabled = icSetting && icSetting.value === 'true';
    if (isIcEnabled) {
      // 編集モーダルのみクリックフォーカストラップを適用（新規フォームはPC/SC自動入力のため不要）
      const editIcInput = document.getElementById('m-ic-tag-id');
      if (editIcInput) {
        const modalEl = document.getElementById('bed-modal');
        if (modalEl) {
          modalEl.onclick = (e) => {
            const targetTagName = e.target.tagName.toLowerCase();
            if (!['input', 'textarea', 'select', 'button', 'a', 'option', 'i'].includes(targetTagName)) {
              editIcInput.focus();
            }
          };
        }
      }
    }

    // 移送開始
    const submitBtn = document.getElementById('btn-transfer-start');
    if (submitBtn) {
      // 検査種別変更で所要時間自動入力
      const examTypeSelect = document.getElementById('f-exam-type');
      const durationInput = document.getElementById('f-duration');
      examTypeSelect.onchange = () => {
        const t = AppState.getExamTypeById(examTypeSelect.value);
        if (t) durationInput.value = t.standard_duration_min;
      };
      // 初期値設定
      if (examTypeSelect.value) {
        const t = AppState.getExamTypeById(examTypeSelect.value);
        if (t) durationInput.value = t.standard_duration_min;
      }
      this._bindOptionCardSelectors();

      submitBtn.onclick = () => this._startTransfer();
    }

    // 状態遷移ボタン
    document.querySelectorAll('[data-action-status]').forEach(btn => {
      btn.onclick = () => this._updateStatus(btn.dataset.actionStatus);
    });

    // 電話番号表示ボタン
    const callBtn = document.getElementById('btn-modal-call');
    if (callBtn && event) {
      callBtn.onclick = () => {
        CallPanel.callFromEvent(event.id);
      };
    }

    // 迎え目安時間の変更
    const updateTimeBtn = document.getElementById('btn-update-pickup-time');
    if (updateTimeBtn && event) {
      updateTimeBtn.onclick = async () => {
        const timeInput = document.getElementById('m-pickup-time');
        if (!timeInput) return;
        const timeStr = timeInput.value;
        if (!timeStr || !timeStr.includes(':')) return;

        updateTimeBtn.disabled = true;
        updateTimeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

        try {
          const [hh, mm] = timeStr.split(':').map(Number);
          const date = new Date(event.estimated_pickup_at || Date.now());
          date.setHours(hh, mm, 0, 0);
          const newEstimated = date.getTime();

          await API.patchEventFields(
            event.id,
            { estimated_pickup_at: newEstimated },
            this._getModalEventExpectedStatus(event)
          );
          UI.toast('迎え目安を変更しました', 'success');
          
          await App.refreshData();
          
          // 画面の再描画
          const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
          if (currentPage === 'ward-dashboard') {
            WardDashboard.render();
          } else if (currentPage === 'exam-room') {
            ExamRoom._renderQueue();
          } else if (currentPage === 'timeline') {
            Timeline.render();
          }
          
          // モーダルをリロードして変更内容を反映
          const bed = AppState.getBedById(this.currentBedId);
          if (bed) {
            BedModal.open(bed.id);
          }
        } catch (err) {
          console.error(err);
          if (await this._handleEventPatchConflict(err)) return;
          UI.toast('時間の変更に失敗しました', 'danger');
          updateTimeBtn.disabled = false;
          updateTimeBtn.innerHTML = '変更';
        }
      };
    }

    // 付き添い看護師の変更
    const updateStaffBtn = document.getElementById('btn-update-escort-staff');
    if (updateStaffBtn && event) {
      updateStaffBtn.onclick = async () => {
        const staffSelect = document.getElementById('m-escort-staff');
        if (!staffSelect) return;
        const newStaffId = staffSelect.value || null;

        updateStaffBtn.disabled = true;
        updateStaffBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

        try {
          await API.patchEventFields(
            event.id,
            { escort_staff_id: newStaffId },
            this._getModalEventExpectedStatus(event)
          );
          UI.toast('付き添い看護師を変更しました', 'success');
          
          await App.refreshData();
          
          const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
          if (currentPage === 'ward-dashboard') {
            WardDashboard.render();
          } else if (currentPage === 'exam-room') {
            ExamRoom._renderQueue();
          } else if (currentPage === 'timeline') {
            Timeline.render();
          }
          
          const bed = AppState.getBedById(this.currentBedId);
          if (bed) {
            BedModal.open(bed.id);
          }
        } catch (err) {
          console.error(err);
          if (await this._handleEventPatchConflict(err)) return;
          UI.toast('付き添い看護師の変更に失敗しました', 'danger');
          updateStaffBtn.disabled = false;
          updateStaffBtn.innerHTML = '変更';
        }
      };
    }
    // 備考の変更
    const updateNoteBtn = document.getElementById('btn-update-event-note');
    if (updateNoteBtn && event) {
      updateNoteBtn.onclick = async () => {
        const noteInput = document.getElementById('m-event-note');
        if (!noteInput) return;
        const newNote = noteInput.value.trim();

        updateNoteBtn.disabled = true;
        updateNoteBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

        try {
          await API.patchEventFields(
            event.id,
            { note: newNote },
            this._getModalEventExpectedStatus(event)
          );
          UI.toast('備考を更新しました', 'success');
          
          await App.refreshData();
          
          const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
          if (currentPage === 'ward-dashboard') {
            WardDashboard.render();
          } else if (currentPage === 'exam-room') {
            ExamRoom._renderQueue();
          } else if (currentPage === 'timeline') {
            Timeline.render();
          }
          
          const bed = AppState.getBedById(this.currentBedId);
          if (bed) {
            BedModal.open(bed.id);
          }
        } catch (err) {
          console.error(err);
          if (await this._handleEventPatchConflict(err)) return;
          UI.toast('備考の更新に失敗しました', 'danger');
          updateNoteBtn.disabled = false;
          updateNoteBtn.innerHTML = '変更';
        }
      };
    }

    // ICタグ登録・解除のバインド
    if (isIcEnabled && event && event.current_status !== 'RETURNED' && event.current_status !== 'CANCELLED') {
      const updateIcBtn = document.getElementById('btn-update-ic-tag');
      const clearIcBtn = document.getElementById('btn-clear-ic-tag');
      const icInput = document.getElementById('m-ic-tag-id');

      const performUpdateIc = async (icValue) => {
        if (!icValue) {
          UI.toast('ICタグIDを入力してください', 'warning');
          UI.playScanSound(false);
          return;
        }
        
        if (updateIcBtn) {
          updateIcBtn.disabled = true;
          updateIcBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        }

        try {
          await API.patchEventFields(
            event.id,
            { patient_ic_tag_id: icValue },
            this._getModalEventExpectedStatus(event)
          );
          UI.toast('患者ICカードを登録しました', 'success');
          UI.playScanSound(true);
          this._pendingFlash = true;
          
          await App.refreshData();
          
          // 画面の再描画
          const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
          if (currentPage === 'ward-dashboard') {
            WardDashboard.render();
          } else if (currentPage === 'exam-room') {
            ExamRoom._renderQueue();
          } else if (currentPage === 'timeline') {
            Timeline.render();
          }
          
          // モーダルをリロードして変更内容を反映
          const bed = AppState.getBedById(this.currentBedId);
          if (bed) {
            BedModal.open(bed.id);
          }
        } catch (err) {
          console.error(err);
          if (await this._handleEventPatchConflict(err)) return;
          UI.toast('ICカードの登録に失敗しました', 'danger');
          UI.playScanSound(false);
          if (updateIcBtn) {
            updateIcBtn.disabled = false;
            updateIcBtn.innerHTML = '登録';
          }
        }
      };

      if (updateIcBtn) {
        updateIcBtn.onclick = () => {
          const icValue = icInput.value.trim();
          performUpdateIc(icValue);
        };
      }

      if (icInput) {
        icInput.onkeydown = (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const icValue = icInput.value.trim();
            performUpdateIc(icValue);
          }
        };
      }

      if (clearIcBtn) {
        clearIcBtn.onclick = async () => {
          clearIcBtn.disabled = true;
          clearIcBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

          try {
            await API.patchEventFields(
              event.id,
              { patient_ic_tag_id: null },
              this._getModalEventExpectedStatus(event)
            );
            UI.toast('患者ICカードの紐づけを解除しました', 'success');
            UI.playScanSound(true);
            this._pendingFlash = true;
            
            await App.refreshData();
            
            // 画面の再描画
            const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
            if (currentPage === 'ward-dashboard') {
              WardDashboard.render();
            } else if (currentPage === 'exam-room') {
              ExamRoom._renderQueue();
            } else if (currentPage === 'timeline') {
              Timeline.render();
            }

            const bed = AppState.getBedById(this.currentBedId);
            if (bed) {
              BedModal.open(bed.id);
            }
          } catch (err) {
            console.error(err);
            if (await this._handleEventPatchConflict(err)) return;
            UI.toast('ICカード紐づけの解除に失敗しました', 'danger');
            UI.playScanSound(false);
            clearIcBtn.disabled = false;
            clearIcBtn.innerHTML = '解除';
          }
        };
      }
    }
  },

  async _startTransfer() {
    const bed = AppState.getBedById(this.currentBedId);
    if (!bed) return;

    const examTypeId = document.getElementById('f-exam-type').value;
    const examRoomId = document.getElementById('f-exam-room').value;
    const escortStaffId = document.getElementById('f-escort-staff').value;
    const duration = parseInt(document.getElementById('f-duration').value);
    const note = document.getElementById('f-note').value;
    const icTagInput = document.getElementById('f-ic-tag-id');
    const icTagId = icTagInput ? icTagInput.value.trim() : null;

    if (!examTypeId || !examRoomId) {
      UI.toast('検査種別と検査室は必須です', 'warning');
      return;
    }

    const btn = document.getElementById('btn-transfer-start');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 開始中...';

    try {
      const durationMin = isNaN(duration) ? 30 : duration;
      if (!this._pendingTransferEventId) {
        this._pendingTransferEventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
      }

      await API.startTransfer({
        eventId: this._pendingTransferEventId,
        bedId: this.currentBedId,
        wardId: AppState.currentWardId,
        examTypeId,
        examRoomId,
        escortStaffId: escortStaffId || null,
        expectedDurationMin: durationMin,
        note: note || '',
        patientName: bed.patient_name || null,
        patientId: bed.patient_id || null,
        patientIcTagId: icTagId || null,
      });

      UI.toast(`${bed.bed_number}号床の移送を開始しました`, 'success');
      this._pendingTransferEventId = null;
      this.close();
      await App.refreshData();
      
      // 即座に画面を再描画する
      const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
      if (currentPage === 'ward-dashboard') {
        WardDashboard.render();
      } else if (currentPage === 'exam-room') {
        ExamRoom._renderQueue();
      } else if (currentPage === 'timeline') {
        Timeline.render();
      }
    } catch (e) {
      console.error(e);
      if (await App.handleDataConflict(e, '他端末で移送が開始されています。最新状態に更新します。')) {
        this.close();
        return;
      }
      UI.toast('移送開始に失敗しました: ' + e.message, 'danger');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-walking"></i> 移送を開始';
    }
  },

  async _updateStatus(newStatus) {
    if (!this.currentEventId) return;
    const event = AppState.activeEvents.find(e => e.id === this.currentEventId);
    if (!event) {
      await App.handleDataConflict({ conflict: true, message: '他端末で更新済みです。最新状態に更新します。' });
      this.close();
      return;
    }
    const bed = AppState.getBedById(event.bed_id);

    // キャンセルの場合は確認ダイアログを表示する
    if (newStatus === 'CANCELLED') {
      const ok = confirm('本当にこの移送をキャンセルしますか？');
      if (!ok) {
        return;
      }
    }

    const btn = document.querySelector(`[data-action-status="${newStatus}"]`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }

    try {
      const extraFields = {};
      if (newStatus === 'RETURNED' || newStatus === 'CANCELLED') {
        extraFields.patient_ic_tag_id = null;
      }
      await API.updateEventStatus(
        this.currentEventId,
        newStatus,
        extraFields,
        CONFIG.STATUS_SCOPE.WARD,
        this.currentEventStatus || event.current_status
      );
      const label = CONFIG.STATUS_LABEL[newStatus];
      UI.toast(`${bed ? bed.bed_number + '号床' : ''} → ${label}`, 'success');
      this.close();
      await App.refreshData();
      
      // 即座に画面を再描画する
      const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
      if (currentPage === 'ward-dashboard') {
        WardDashboard.render();
      } else if (currentPage === 'exam-room') {
        ExamRoom._renderQueue();
      } else if (currentPage === 'timeline') {
        Timeline.render();
      }
    } catch (e) {
      console.error(e);
      if (await App.handleDataConflict(e)) {
        this.close();
        return;
      }
      UI.toast('更新に失敗しました', 'danger');
    }
  },

  _bindOptionCardSelectors() {
    document.querySelectorAll('.option-card[data-select-target]').forEach(card => {
      card.addEventListener('click', () => {
        if (card.disabled) return;
        const select = document.getElementById(card.dataset.selectTarget);
        if (!select) return;
        select.value = card.dataset.value || '';
        select.dispatchEvent(new Event('change'));
        document.querySelectorAll(`.option-card[data-select-target="${card.dataset.selectTarget}"]`).forEach(peer => {
          const selected = peer === card;
          peer.classList.toggle('selected', selected);
          peer.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
      });
    });
  },
};

// ── 手動在室登録ダイアログ ───────────────────────────────────────
const PatientRegModal = {

  open(bedId, existingBed = null) {
    const old = document.getElementById('patient-reg-overlay');
    if (old) old.remove();

    const bedObj = existingBed || AppState.getBedById(bedId);
    const isEdit = !!(bedObj?.patient_name);
    const titleText = isEdit ? '患者情報を編集' : '在室患者を登録';

    // 既存データ
    const defName = bedObj?.patient_name || '';
    const defId   = bedObj?.patient_id   || '';
    const defNote = bedObj?.patient_note || '';
    const defDate = bedObj?.admission_date
      ? new Date(bedObj.admission_date).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const defPresent = bedObj?.is_present !== false; // デフォルト在床

    const overlay = document.createElement('div');
    overlay.id = 'patient-reg-overlay';
    overlay.className = 'phone-dialog-overlay';
    overlay.innerHTML = `
      <div class="phone-dialog" role="dialog" style="border-color:#16a34a;max-width:400px;width:94%;">
        <div class="phone-dialog-header" style="background:#16a34a;color:#fff;">
          <i class="fas fa-user-plus"></i>
          <span>${titleText}</span>
          <button class="phone-dialog-close" id="prm-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="phone-dialog-body" style="padding:18px;display:flex;flex-direction:column;gap:12px;">

          <div class="form-row" style="margin:0;">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">
              患者氏名 <span style="color:#dc2626;">*</span>
            </label>
            <input type="text" id="prm-name" class="form-input" placeholder="例: 山田 太郎"
              value="${UI.escapeHTML(defName)}" style="width:100%;">
          </div>

          <div class="form-row" style="margin:0;">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">患者ID</label>
            <input type="text" id="prm-id" class="form-input" placeholder="例: P-12345"
              value="${UI.escapeHTML(defId)}" style="width:100%;">
          </div>

          <div class="form-row" style="margin:0;">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">入室日</label>
            <input type="date" id="prm-date" class="form-input" value="${defDate}" style="width:100%;">
          </div>

          <div class="form-row" style="margin:0;">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:6px;">在室状況</label>
            <div style="display:flex;gap:16px;">
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
                <input type="radio" name="prm-presence" value="true" ${defPresent?'checked':''}> 在床
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
                <input type="radio" name="prm-presence" value="false" ${!defPresent?'checked':''}> 不在（一時外出など）
              </label>
            </div>
          </div>

          <div class="form-row" style="margin:0;">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">備考</label>
            <textarea id="prm-note" class="form-input" rows="2"
              placeholder="例: 糖尿病、歩行困難" style="width:100%;resize:vertical;">${UI.escapeHTML(defNote)}</textarea>
          </div>

        </div>
        <div class="phone-dialog-footer" style="display:flex;gap:10px;padding:12px 18px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          ${isEdit ? `<button class="btn btn-danger btn-sm" id="prm-discharge" style="margin-right:auto;">
            <i class="fas fa-door-open"></i> 退院
          </button>` : ''}
          <button class="btn btn-outline" id="prm-cancel">キャンセル</button>
          <button class="btn btn-success" id="prm-save"><i class="fas fa-save"></i> 登録する</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    const closeAndReopen = () => { overlay.remove(); BedModal.open(bedId); };
    document.getElementById('prm-close').onclick = closeAndReopen;
    document.getElementById('prm-cancel').onclick = closeAndReopen;

    // 退院ボタン
    document.getElementById('prm-discharge')?.addEventListener('click', async () => {
      const bedLabel = bedObj ? UI.formatBedNamePlain(bedObj) + '号床' : '';
      if (!confirm(`${bedLabel}の患者（${defName}）を退院しますか？`)) return;
      try {
        await API.patch('beds', bedId, {
          patient_name: null, patient_id: null, is_present: false,
          admission_date: null, patient_note: null, manually_registered: false,
          _occupancySource: 'manual_discharge'
        });
        await App.loadMasters();
        BedMap.render();
        overlay.remove();
        UI.toast('退院しました', 'success');
        BedModal.open(bedId);
      } catch (e) {
        UI.toast('退院処理に失敗しました: ' + e.message, 'danger');
      }
    });

    // 登録ボタン
    document.getElementById('prm-save').addEventListener('click', async () => {
      const name = document.getElementById('prm-name').value.trim();
      if (!name) { UI.toast('患者氏名は必須です', 'warning'); return; }
      const patId = document.getElementById('prm-id').value.trim();
      const dateVal = document.getElementById('prm-date').value;
      const admDate = dateVal ? new Date(dateVal).getTime() : Date.now();
      const isPresent = document.querySelector('input[name="prm-presence"]:checked')?.value !== 'false';
      const note = document.getElementById('prm-note').value.trim();

      const saveBtn = document.getElementById('prm-save');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

      try {
        await API.patch('beds', bedId, {
          patient_name: name,
          patient_id: patId || null,
          is_present: isPresent,
          admission_date: admDate,
          patient_note: note || null,
          manually_registered: true,
          _occupancySource: 'manual_register',
        });
        API.writeAuditLog(isEdit ? 'PATIENT_UPDATE' : 'PATIENT_REGISTER', {
          targetType: 'bed', targetId: bedId,
          details: { patient_id: patId || null },
        });
        await App.loadMasters();
        BedMap.render();
        overlay.remove();
        UI.toast(isEdit ? '患者情報を更新しました' : `${UI.escapeHTML(UI.getPatientName(name))} さんを登録しました`, 'success');
        BedModal.open(bedId);
      } catch (e) {
        UI.toast('登録に失敗しました: ' + e.message, 'danger');
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 登録する';
      }
    });

    // フォーカス
    setTimeout(() => document.getElementById('prm-name')?.focus(), 60);
  },
};
