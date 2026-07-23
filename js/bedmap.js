/**
 * TransBoard - 病床マップ
 * map_col / map_row を使った自由配置グリッド表示
 */

const BedMap = {

  _activeFilter: 'all',

  // ── ズーム操作 ──
  _zoom: parseFloat(localStorage.getItem('cfg_bedmap_zoom')) || 1,
  ZOOM_MIN: 0.6,
  ZOOM_MAX: 2,
  ZOOM_STEP: 0.1,

  // ── 全病棟横断表示 ──
  _allWardsMode: localStorage.getItem('cfg_bedmap_all_wards') === 'true',

  render() {
    const grid = document.getElementById('bed-map-grid');
    if (!grid) return;

    // 同期: 患者名表示のクラスを設定 (デフォルト非表示が基準)
    const chk = document.getElementById('chk-show-patient-names');
    const showNames = chk ? chk.checked : (localStorage.getItem('cfg_show_patient_names') === 'true');
    if (showNames) {
      grid.classList.remove('hide-patient-names');
    } else {
      grid.classList.add('hide-patient-names');
    }

    if (this._allWardsMode) {
      this._renderAllWards(grid);
      this._applyZoom();
      return;
    }

    const ward = AppState.currentWardId;
    const beds = AppState.beds.filter(b => b.ward_id === ward);

    if (beds.length === 0) {
      grid.innerHTML = '<div class="empty-state"><i class="fas fa-bed"></i><p>病床データがありません</p></div>';
      this._applyZoom();
      return;
    }

    // map_col/map_row が設定されているか確認
    const hasMapped = beds.some(b => b.map_col !== null && b.map_col !== undefined);

    if (hasMapped) {
      this._renderGrid(grid, beds);
    } else {
      this._renderSimple(grid, beds);
    }
    this._applyZoom();
  },

  // ── 全病棟を病棟ごとにセクション分けして横断表示 ──
  _renderAllWards(grid) {
    // className再設定でrender()冒頭に付けた患者名マスク用クラスを消さないよう保持する
    const masked = grid.classList.contains('hide-patient-names');
    grid.className = 'bed-map-grid-allwards' + (masked ? ' hide-patient-names' : '');
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';

    const wards = AppState.wards || [];
    if (wards.length === 0) {
      grid.innerHTML = '<div class="empty-state"><i class="fas fa-bed"></i><p>病棟データがありません</p></div>';
      return;
    }

    const eventsList = AppState.allWardsActiveEvents || [];
    grid.innerHTML = wards.map(ward => {
      const beds = AppState.beds.filter(b => b.ward_id === ward.id)
        .sort((a, b) => a.bed_number.localeCompare(b.bed_number, 'ja', { numeric: true }));
      const bedsHtml = beds.length === 0
        ? '<div class="text-muted text-sm" style="padding:8px;">病床データがありません</div>'
        : beds.map(bed => this._renderBedCard(bed, eventsList)).join('');
      return `
        <div class="bedmap-ward-section">
          <div class="bedmap-ward-section-title"><i class="fas fa-hospital"></i> ${UI.escapeHTML(ward.name)}</div>
          <div class="bedmap-ward-section-grid">${bedsHtml}</div>
        </div>
      `;
    }).join('');

    this._bindCardEvents(grid, eventsList);
    this.applyFilter();
  },

  // ── ズーム状態の反映 ──
  _applyZoom() {
    const grid = document.getElementById('bed-map-grid');
    if (grid) grid.style.setProperty('--bedmap-zoom', this._zoom);
    const label = document.getElementById('btn-bedmap-zoom-reset');
    if (label) label.textContent = Math.round(this._zoom * 100) + '%';
  },

  zoomIn() {
    this._zoom = Math.min(this.ZOOM_MAX, +(this._zoom + this.ZOOM_STEP).toFixed(2));
    localStorage.setItem('cfg_bedmap_zoom', this._zoom);
    this._applyZoom();
  },

  zoomOut() {
    this._zoom = Math.max(this.ZOOM_MIN, +(this._zoom - this.ZOOM_STEP).toFixed(2));
    localStorage.setItem('cfg_bedmap_zoom', this._zoom);
    this._applyZoom();
  },

  zoomReset() {
    this._zoom = 1;
    localStorage.setItem('cfg_bedmap_zoom', this._zoom);
    this._applyZoom();
  },

  // ズーム・全病棟表示のコントロール類を1回だけバインドする(App.init()から呼ばれる)
  initControls() {
    document.getElementById('btn-bedmap-zoom-in')?.addEventListener('click', () => this.zoomIn());
    document.getElementById('btn-bedmap-zoom-out')?.addEventListener('click', () => this.zoomOut());
    document.getElementById('btn-bedmap-zoom-reset')?.addEventListener('click', () => this.zoomReset());

    // 病床マップ表示エリアの上でCtrl+ホイールした時のみズーム対象にする
    // (Ctrl無しの通常ホイールは#bed-map-viewportの標準スクロール=パン操作に使う)
    const viewport = document.getElementById('bed-map-viewport');
    if (viewport) {
      viewport.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        if (e.deltaY < 0) this.zoomIn(); else this.zoomOut();
      }, { passive: false });
    }

    const allWardsChk = document.getElementById('chk-bedmap-all-wards');
    if (allWardsChk) {
      allWardsChk.checked = this._allWardsMode;
      allWardsChk.addEventListener('change', async () => {
        this._allWardsMode = allWardsChk.checked;
        localStorage.setItem('cfg_bedmap_all_wards', this._allWardsMode ? 'true' : 'false');
        if (this._allWardsMode) {
          await this._loadAllWardsEvents();
        }
        this.render();
      });
    }

    this._applyZoom();
  },

  // 全病棟表示に必要な、病棟横断のアクティブ移送イベントを取得する
  async _loadAllWardsEvents() {
    try {
      const res = await API.getWardStatusEvents('', 0);
      AppState.allWardsActiveEvents = res.activeEvents || [];
    } catch (e) {
      console.error('[BedMap] 全病棟イベント取得失敗:', e);
      AppState.allWardsActiveEvents = [];
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
    grid.className = 'bed-map-grid-layout' + (grid.classList.contains('hide-patient-names') ? ' hide-patient-names' : '');
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(84px, 1fr))`;
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
    this._bindCardEvents(grid);

    // フィルターを適用
    this.applyFilter();
  },

  // ── フォールバック: シンプル一覧表示 ──
  _renderSimple(grid, beds) {
    grid.className = 'bed-map-grid-simple' + (grid.classList.contains('hide-patient-names') ? ' hide-patient-names' : '');
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(104px, 1fr))';
    grid.style.gridTemplateRows = '';

    const sorted = [...beds].sort((a, b) =>
      a.bed_number.localeCompare(b.bed_number, 'ja', { numeric: true })
    );
    grid.innerHTML = sorted.map(bed => this._renderBedCard(bed)).join('');
    this._bindCardEvents(grid);

    // フィルターを適用
    this.applyFilter();
  },

  // クリック(詳細モーダル)・右クリック(クイックステータス変更)の共通バインド
  // eventsList省略時はAppState.activeEvents(現在の病棟のみ)を使う。全病棟表示時はAppState.allWardsActiveEventsを渡す
  _bindCardEvents(grid, eventsList) {
    grid.querySelectorAll('.bed-card').forEach(card => {
      card.addEventListener('click', () => {
        try {
          BedModal.open(card.dataset.bedId);
        } catch (err) {
          console.error('[BedMap Click Error]', err);
          UI.toast('詳細ダイアログの起動に失敗しました: ' + err.message, 'danger');
        }
      });
      // 右クリックでモーダルを開かずに次ステータスへ変更できるクイックメニュー
      // (Timeline画面のコンテキストメニューを再利用。事前登録中の空床/未出棟の病床は対象外)
      card.addEventListener('contextmenu', (evt) => {
        const event = (eventsList || AppState.activeEvents).find(e => e.bed_id === card.dataset.bedId);
        if (!event || ['RETURNED', 'CANCELLED'].includes(event.current_status)) return;
        evt.preventDefault();
        TimelinePopup.hide();
        TimelineContextMenu.show(event, evt.clientX, evt.clientY);
      });
    });
  },

  // eventsList省略時はAppState.activeEvents(現在の病棟のみ)を使う。全病棟表示時はAppState.allWardsActiveEventsを渡す
  _renderBedCard(bed, eventsList) {
    const event = (eventsList || AppState.activeEvents).find(e => e.bed_id === bed.id);
    
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
      // 出棟登録〜迎え目安の全体時間に対する残り時間の割合をバーで可視化する
      const startMs = event.departed_at || event.created_at || now;
      const totalMs = event.estimated_pickup_at - startMs;
      const progressPct = totalMs > 0 ? Math.max(0, Math.min(100, (remaining / totalMs) * 100)) : (remaining > 0 ? 100 : 0);
      timerHtml = `
        <div class="bed-timer ${cls}">${txt}</div>
        <div class="bed-timer-progress" title="迎え目安までの残り時間">
          <div class="bed-timer-progress-fill ${cls}" style="width:${progressPct.toFixed(0)}%;"></div>
        </div>`;
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
      // 実際に移動中(MOVING/PICKUP_REQUIRED)か、検査中等で病棟へ戻り手離れしている状態かで表示を変える
      const isActive = CONFIG.ESCORT_ACTIVE_STATUSES.includes(status);
      staffHtml = isActive
        ? `<div class="bed-staff-badge bed-staff-badge--active" style="margin-bottom:2px;"><i class="fas fa-walking"></i> ${UI.escapeHTML(lastName)}</div>`
        : `<div class="bed-staff-badge bed-staff-badge--standby" style="margin-bottom:2px;"><i class="fas fa-user-nurse"></i> ${UI.escapeHTML(lastName)}（待機）</div>`;
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
    const eventsList = this._allWardsMode ? (AppState.allWardsActiveEvents || []) : AppState.activeEvents;
    document.querySelectorAll('.bed-card').forEach(card => {
      const bedId = card.dataset.bedId;
      const event = eventsList.find(e => e.bed_id === bedId);
      if (!event || !event.estimated_pickup_at) return;
      const timerEl = card.querySelector('.bed-timer');
      if (!timerEl) return;
      const remaining = event.estimated_pickup_at - now;
      const cls = UI.remainingClass(remaining);
      timerEl.textContent = UI.formatRemaining(remaining);
      timerEl.className = 'bed-timer ' + cls;

      const fillEl = card.querySelector('.bed-timer-progress-fill');
      if (fillEl) {
        const startMs = event.departed_at || event.created_at || now;
        const totalMs = event.estimated_pickup_at - startMs;
        const progressPct = totalMs > 0 ? Math.max(0, Math.min(100, (remaining / totalMs) * 100)) : (remaining > 0 ? 100 : 0);
        fillEl.style.width = progressPct.toFixed(0) + '%';
        fillEl.className = 'bed-timer-progress-fill ' + cls;
      }
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
