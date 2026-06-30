/**
 * TransBoard - 病床マップ
 * map_col / map_row を使った自由配置グリッド表示
 */

const BedMap = {

  _activeFilter: 'all',

  render() {
    const grid = document.getElementById('bed-map-grid');
    if (!grid) return;

    const ward = AppState.currentWardId;
    const beds = AppState.beds.filter(b => b.ward_id === ward);

    // 同期: 患者名表示のクラスを設定 (デフォルト非表示が基準)
    const chk = document.getElementById('chk-show-patient-names');
    const showNames = chk ? chk.checked : (localStorage.getItem('cfg_show_patient_names') === 'true');
    if (showNames) {
      grid.classList.remove('hide-patient-names');
    } else {
      grid.classList.add('hide-patient-names');
    }

    if (beds.length === 0) {
      grid.innerHTML = '<div class="empty-state"><i class="fas fa-bed"></i><p>病床データがありません</p></div>';
      return;
    }

    // map_col/map_row が設定されているか確認
    const hasMapped = beds.some(b => b.map_col !== null && b.map_col !== undefined);

    if (hasMapped) {
      this._renderGrid(grid, beds);
    } else {
      this._renderSimple(grid, beds);
    }
  },

  // ── グリッド配置描画 ──
  _renderGrid(grid, beds) {
    const wardId = AppState.currentWardId;
    const layoutSetting = AppState.systemSettings?.find(s => s.id === `map_layout_${wardId}`);
    
    let cols = 0;
    let rows = 0;
    let cells = {};

    if (layoutSetting && layoutSetting.value) {
      try {
        const parsed = JSON.parse(layoutSetting.value);
        if (parsed) {
          cols = parsed.cols || 0;
          rows = parsed.rows || 0;
          cells = parsed.cells || {};
        }
      } catch (err) {
        console.error('[BedMap] レイアウト読み込み失敗:', err);
      }
    }

    // レイアウトデータが無い、または不正な場合はベッドデータから自動計算
    const placedBeds = beds.filter(b => b.map_col !== null && b.map_col !== undefined);
    if (cols === 0 || rows === 0) {
      if (placedBeds.length === 0) { this._renderSimple(grid, beds); return; }
      const maxCol = Math.max(...placedBeds.map(b => b.map_col));
      const maxRow = Math.max(...placedBeds.map(b => b.map_row));
      cols = maxCol + 1;
      rows = maxRow + 1;
      
      // 互換セルの作成
      placedBeds.forEach(b => {
        cells[`${b.map_col},${b.map_row}`] = { bedId: b.id };
      });
    }

    // グリッドを描画
    grid.className = 'bed-map-grid-layout';
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(72px, 1fr))`;
    grid.style.gridTemplateRows    = `repeat(${rows}, auto)`;

    // bedsデータへのアクセスを高速化するためにベッドマップを作成
    const bedMap = {};
    beds.forEach(b => {
      bedMap[b.id] = b;
    });

    let html = '';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = cells[`${c},${r}`];

        if (cell && cell.bedId && bedMap[cell.bedId]) {
          html += this._renderBedCard(bedMap[cell.bedId]);
        } else if (cell) {
          if (cell.special === 'corridor') {
            html += `<div class="bed-cell-empty is-corridor" style="background:#f0fdf4; border:1px solid #86efac; border-radius:6px; min-height:55px; box-sizing:border-box;"></div>`;
          } else if (cell.special === 'wall') {
            html += `<div class="bed-cell-empty is-wall" style="background:#e2e8f0; border:1px solid #cbd5e0; border-radius:6px; min-height:55px; box-sizing:border-box;"></div>`;
          } else {
            html += `<div class="bed-cell-empty" style="min-height:55px;"></div>`;
          }
        } else {
          html += `<div class="bed-cell-empty" style="min-height:55px;"></div>`;
        }
      }
    }
    grid.innerHTML = html;

    grid.querySelectorAll('.bed-card').forEach(card => {
      card.addEventListener('click', () => {
        try {
          BedModal.open(card.dataset.bedId);
        } catch (err) {
          console.error('[BedMap Click Error]', err);
          UI.toast('詳細ダイアログの起動に失敗しました: ' + err.message, 'danger');
        }
      });
    });

    // 付箋機能は削除されました

    // フィルターを適用
    this.applyFilter();
  },

  // ── フォールバック: シンプル一覧表示 ──
  _renderSimple(grid, beds) {
    grid.className = 'bed-map-grid-simple';
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(90px, 1fr))';
    grid.style.gridTemplateRows = '';

    const sorted = [...beds].sort((a, b) =>
      a.bed_number.localeCompare(b.bed_number, 'ja', { numeric: true })
    );
    grid.innerHTML = sorted.map(bed => this._renderBedCard(bed)).join('');

    grid.querySelectorAll('.bed-card').forEach(card => {
      card.addEventListener('click', () => BedModal.open(card.dataset.bedId));
    });

    // フィルターを適用
    this.applyFilter();
  },

  _renderBedCard(bed) {
    const event = AppState.getActiveEventForBed(bed.id);
    
    // Determine the room and bed display number
    let displayNo = UI.formatBedName(bed);

    // 基本ステータスの判定
    let status = 'IN_BED';
    let statusLabel = '在床';
    
    if (event) {
      status = event.current_status;
      statusLabel = CONFIG.STATUS_LABEL[status];
    } else {
      if (bed.patient_name) {
        if (bed.is_present) {
          status = 'IN_BED';
          statusLabel = '在床';
        } else {
          status = 'ABSENT';
          statusLabel = '不在';
        }
      } else {
        status = 'EMPTY';
        statusLabel = '空床';
      }
    }

    const examType = event ? AppState.getExamTypeById(event.exam_type_id) : null;
    const examRoom = event ? AppState.getExamRoomById(event.exam_room_id) : null;
    const staff = event ? AppState.getStaffById(event.escort_staff_id) : null;
    const now = Date.now();

    let timerHtml = '';
    if (event && event.estimated_pickup_at && CONFIG.DEPART_STATUSES.includes(status)) {
      const remaining = event.estimated_pickup_at - now;
      const cls = UI.remainingClass(remaining);
      const txt = UI.formatRemaining(remaining);
      timerHtml = `<div class="bed-timer ${cls}">${txt}</div>`;
    }

    let pulseDot = '';
    if (status === 'PICKUP_REQUIRED' || status === 'NEARLY_DONE') {
      pulseDot = '<div class="bed-pulse-dot"></div>';
    }

    let examInfoHtml = '';
    if (event && examType) {
      examInfoHtml = `<div class="bed-exam-info">
        ${UI.escapeHTML(examType.code)}
        ${examRoom ? '→' + UI.escapeHTML(examRoom.name) : ''}
        ${event.departed_at ? '<br>' + UI.formatTime(event.departed_at) + '出棟' : ''}
      </div>`;
    }

    let staffHtml = '';
    if (staff && CONFIG.DEPART_STATUSES.includes(status)) {
      const lastName = staff.name.split(/[\s　]/)[0];
      staffHtml = `<div class="bed-staff-badge" style="margin-bottom:2px;"><i class="fas fa-user-nurse"></i> ${UI.escapeHTML(lastName)}</div>`;
    }

    let icBadgeHtml = '';
    if (event && event.patient_ic_tag_id && CONFIG.DEPART_STATUSES.includes(status)) {
      icBadgeHtml = `<div class="bed-ic-badge" style="background:#e0f2fe; color:#0369a1; padding:2px 5px; border-radius:4px; font-size:9px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #bae6fd; margin-bottom:2px;" title="ICカードID: ${UI.escapeHTML(event.patient_ic_tag_id)}"><i class="fas fa-id-card"></i> IC</div>`;
    }

    // 備考表示モードの読み込み
    const remarksSelect = document.getElementById('sel-remarks-mode');
    const remarksMode = remarksSelect ? remarksSelect.value : 'icon';

    let remarksHtml = '';
    if (event && event.note && CONFIG.DEPART_STATUSES.includes(status) && remarksMode !== 'hide') {
      if (remarksMode === 'text') {
        remarksHtml = `<div class="bed-note-badge" style="background:#fffbeb; color:#d97706; padding:2px 5px; border-radius:4px; font-size:9px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #fde68a; margin-bottom:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:80px;" title="${UI.escapeHTML(event.note)}"><i class="fas fa-sticky-note"></i> ${UI.escapeHTML(event.note)}</div>`;
      } else {
        remarksHtml = `<div class="bed-note-badge" style="background:#fffbeb; color:#d97706; padding:2px 5px; border-radius:4px; font-size:9px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #fde68a; margin-bottom:2px;" title="${UI.escapeHTML(event.note)}"><i class="fas fa-sticky-note"></i> 備考</div>`;
      }
    }

    // 患者情報の表示部分の作成 (マスク適用時は直接 "＊＊＊＊" に置き換え)
    const nameChk = document.getElementById('chk-show-patient-names');
    const showNames = nameChk ? nameChk.checked : (localStorage.getItem('cfg_show_patient_names') === 'true');

    let patientHtml = '';
    if (bed.patient_name) {
      const presenceLabel = bed.is_present ? '在床' : '不在';
      const presenceColor = bed.is_present ? '#10b981' : '#ef4444';
      
      const patientNameText = showNames ? UI.escapeHTML(bed.patient_name) : '＊＊＊＊';
      const patientIdText = showNames ? UI.escapeHTML(bed.patient_id || '') : '＊＊＊＊';

      patientHtml = `<div class="bed-patient-info" style="margin-top: 2px; border-top: 1px dashed rgba(0,0,0,0.08); padding-top: 2px;">
        <div class="bed-patient-name" style="font-weight:700; font-size:11px; color:#2d3748; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${patientNameText}</div>
        <div class="bed-patient-meta" style="font-size:9px; color:#718096; display:flex; justify-content:space-between; align-items:center; margin-top:1px;">
          <span>${patientIdText}</span>
          <span style="padding:1px 3px; border-radius:2px; font-size:8px; font-weight:800; color:#fff; background:${presenceColor};">${presenceLabel}</span>
        </div>
      </div>`;
    } else {
      patientHtml = `<div class="bed-patient-info" style="margin-top: 2px; border-top: 1px dashed rgba(0,0,0,0.08); padding-top: 2px; font-size:10px; color:#a0aec0; font-style:italic;">空床</div>`;
    }

    // 空床・不在・在床に応じたカスタムスタイル
    let cardStyle = '';
    let badgeStyle = '';
    if (!event) {
      if (status === 'EMPTY') {
        cardStyle = 'background: #f8fafc; border: 2px dashed #cbd5e0; color: #a0aec0; opacity: 0.75;';
        badgeStyle = 'background: #edf2f7; color: #718096;';
      } else if (status === 'ABSENT') {
        cardStyle = 'background: #fff5f5; border: 2px solid #feb2b2; color: #4a5568;';
        badgeStyle = 'background: #fee2e2; color: #ef4444;';
      } else if (status === 'IN_BED') {
        cardStyle = 'background: #ffffff; border: 2px solid #cbd5e0; color: #1a202c;';
        badgeStyle = 'background: #e2e8f0; color: #4a5568;';
      }
    }

    return `
      <div class="bed-card status-${status}" data-bed-id="${bed.id}" style="${cardStyle}"
           title="${bed.bed_number}号床 - ${statusLabel}${event && event.patient_ic_tag_id ? ' (ICカード登録済: ' + event.patient_ic_tag_id + ')' : ''}">
        ${pulseDot}
        <div class="bed-number">${displayNo}</div>
        <div class="bed-status-badge badge-${status}" style="${badgeStyle}">${statusLabel}</div>
        ${examInfoHtml}
        ${timerHtml}
        <div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap; margin-top:2px;">
          ${staffHtml}
          ${icBadgeHtml}
          ${remarksHtml}
        </div>
        ${patientHtml}
      </div>
    `;
  },



  // タイマー更新
  updateTimers() {
    const now = Date.now();
    document.querySelectorAll('.bed-card').forEach(card => {
      const bedId = card.dataset.bedId;
      const event = AppState.getActiveEventForBed(bedId);
      if (!event || !event.estimated_pickup_at) return;
      const timerEl = card.querySelector('.bed-timer');
      if (!timerEl) return;
      const remaining = event.estimated_pickup_at - now;
      timerEl.textContent = UI.formatRemaining(remaining);
      timerEl.className = 'bed-timer ' + UI.remainingClass(remaining);
    });
  },

  // リアルタイムフィルターの適用 (未実装の改善案4)
  applyFilter() {
    const filter = this._activeFilter;
    const cards = document.querySelectorAll('#bed-map-grid .bed-card');
    cards.forEach(card => {
      const statusClass = card.className;
      const status = statusClass.split(' ').find(c => c.startsWith('status-'))?.replace('status-', '') || '';
      
      let match = false;
      if (filter === 'all') {
        match = true;
      } else if (filter === 'active_transfer') {
        match = ['DEPART_REGISTERED', 'MOVING', 'ARRIVED', 'IN_EXAM', 'NEARLY_DONE', 'PICKUP_REQUIRED'].includes(status);
      } else if (filter === 'pickup') {
        match = (status === 'PICKUP_REQUIRED');
      } else if (filter === 'empty') {
        match = (status === 'EMPTY');
      } else if (filter === 'absent') {
        match = (status === 'ABSENT');
      }

      if (match) {
        card.style.opacity = '1';
        card.style.pointerEvents = 'auto';
        card.style.transform = '';
      } else {
        card.style.opacity = '0.15';
        card.style.pointerEvents = 'none';
        card.style.transform = 'scale(0.96)';
        card.style.transition = 'all 0.2s ease';
      }
    });
  },
};
