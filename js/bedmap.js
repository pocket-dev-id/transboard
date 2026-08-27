/**
 * TransBoard - 病床マップ
 * map_col / map_row を使った自由配置グリッド表示
 */

const BedMap = {

  _activeFilter: 'all',

  _scheduleBadgeIcons: new Set([
    'calendar-check', 'calendar-alt', 'clock', 'clipboard-list',
    'stethoscope', 'x-ray', 'flask', 'heartbeat', 'radiation', 'file-medical-alt',
  ]),

  render() {
    const grid = document.getElementById('bed-map-grid');
    if (!grid) return;

    const ward = AppState.currentWardId;
    const beds = AppState.beds.filter(b => b.ward_id === ward);

    // 同期: 患者名表示のクラスを設定 (デフォルト非表示が基準)
    const showNames = !UI.isPatientMaskEnabled();
    if (showNames) {
      grid.classList.remove('hide-patient-names');
    } else {
      grid.classList.add('hide-patient-names');
    }

    if (beds.length === 0) {
      grid.innerHTML = UI.emptyStateHtml('病床データがありません', { icon: 'fas fa-bed' });
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
            html += `<div class="bed-cell-empty is-corridor" style="background:#f0fdf4; border-radius:6px; min-height:55px; box-sizing:border-box;"></div>`;
          } else if (cell.special === 'wall') {
            html += `<div class="bed-cell-empty is-wall" style="background:#e2e8f0; border-radius:6px; min-height:55px; box-sizing:border-box;"></div>`;
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
    this._bindScheduleBadgeHandlers(grid);

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
    this._bindScheduleBadgeHandlers(grid);

    // フィルターを適用
    this.applyFilter();
  },

  _getTodaySchedulesForBed(bed) {
    const patientId = String(bed?.patient_id || '').trim();
    if (!patientId) return [];

    const wardId = AppState.currentWardId;
    const feedsById = new Map(
      (AppState.scheduleFeeds || []).map(feed => [String(feed.id), feed])
    );
    const now = Date.now();
    const groups = new Map();

    (AppState.scheduleItems || []).forEach(item => {
      if (String(item?.identifier || '').trim() !== patientId) return;

      const feedId = item?.feed_id == null ? '' : String(item.feed_id);
      const feed = feedId ? feedsById.get(feedId) : null;
      if (feedId && !feed) return;
      if (feed?.is_active === false) return;
      if (feed?.show_on_bed_map === false) return;

      const wardIds = Array.isArray(feed?.ward_ids)
        ? feed.ward_ids
        : (Array.isArray(item?.ward_ids) ? item.ward_ids : []);
      if (wardIds.length > 0 && wardId && !wardIds.includes(wardId)) return;

      // 同じフィード内に予定が複数あっても、病床マップ上は1つの表示にまとめる。
      // 進行中 > 次に控えている予定 > 直近に終わった予定、の優先順位で1件選ぶ。
      const key = feedId || String(item?.id || 'legacy-schedule');
      const existing = groups.get(key);
      if (!existing || this._isCloserScheduleItem(item, existing.item, now)) {
        groups.set(key, { item, feed });
      }
    });

    return Array.from(groups.values());
  },

  _renderTodayScheduleBadges(bed) {
    return this._getTodaySchedulesForBed(bed).map(({ item, feed }) => {
      const configuredIcon = String(feed?.bed_map_icon || 'calendar-check');
      const icon = this._scheduleBadgeIcons.has(configuredIcon) ? configuredIcon : 'calendar-check';
      const colorValue = String(feed?.color || item?.color || '#7c3aed');
      const color = /^#[0-9a-f]{6}$/i.test(colorValue) ? colorValue : '#7c3aed';
      const abbreviation = String(feed?.bed_map_abbreviation || '').trim().slice(0, 10);
      const feedName = String(feed?.name || item?.feed_name || '本日スケジュール');
      const title = abbreviation ? `${feedName}（${abbreviation}）` : feedName;
      const abbreviationHtml = abbreviation ? `<span>${UI.escapeHTML(abbreviation)}</span>` : '';
      return `<div class="bed-schedule-badge" data-sched-id="${UI.escapeHTML(String(item?.id || ''))}" style="background:#fff;color:${color};padding:2px 5px;border-radius:4px;font-size:9px;font-weight:600;display:inline-flex;align-items:center;gap:2px;border:1px solid ${color};margin-bottom:2px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;" title="${UI.escapeHTML(title)}"><i class="fas fa-${icon}"></i>${abbreviationHtml}</div>`;
    }).join('');
  },

  _bindScheduleBadgeHandlers(grid) {
    grid.querySelectorAll('.bed-schedule-badge[data-sched-id]').forEach(badge => {
      badge.addEventListener('click', evt => {
        evt.stopPropagation();
        const item = (AppState.scheduleItems || []).find(x => String(x.id) === badge.dataset.schedId);
        if (item) Timeline._showScheduleItemPopup(item, evt.clientX, evt.clientY);
      });
    });
  },

  _isCloserScheduleItem(candidate, current, now) {
    const rank = (it) => {
      const start = Number(it?.start_ms) || 0;
      const end = it?.duration_min ? start + it.duration_min * 60000 : start;
      if (now >= start && now <= end) return 0; // 進行中
      if (start > now) return 1;                // 次に控えている
      return 2;                                  // 終了済み
    };
    const rc = rank(candidate);
    const rr = rank(current);
    if (rc !== rr) return rc < rr;
    const sc = Number(candidate?.start_ms) || 0;
    const sr = Number(current?.start_ms) || 0;
    // 進行中/次に控えている場合は開始が早い方(＝直近)を優先。
    // 終了済み同士は開始が遅い方(＝より最近終わった方)を優先。
    return rc <= 1 ? sc < sr : sc > sr;
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
        ${UI.examImage(examType, 'type', 'history-exam-image')}${UI.escapeHTML(examType.code)}
        ${examRoom ? '→' + UI.examImage(examRoom, 'room', 'history-exam-image') + UI.escapeHTML(examRoom.name) : ''}
        ${event.departed_at ? '<br>' + UI.formatTimeSmart(event.departed_at) + '出棟' : ''}
      </div>`;
    }

    let staffHtml = '';
    if (staff && CONFIG.DEPART_STATUSES.includes(status)) {
      const lastName = staff.name.split(/[\s　]/)[0];
      // 実際に移動中(MOVING/PICKUP_REQUIRED)か、検査中等で病棟へ戻り手離れしている状態かで表示を変える
      const isActive = CONFIG.ESCORT_ACTIVE_STATUSES.includes(status);
      staffHtml = UI.escortBadge(lastName, isActive, 'bed-staff-badge', '', 'margin-bottom:2px;');
    }

    let icBadgeHtml = '';
    if (event && event.patient_ic_tag_id && CONFIG.DEPART_STATUSES.includes(status)) {
      icBadgeHtml = `<div class="bed-ic-badge" style="background:#e0f2fe; color:#0369a1; padding:2px 5px; border-radius:4px; font-size:9px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #bae6fd; margin-bottom:2px;" title="ICカードID: ${UI.escapeHTML(event.patient_ic_tag_id)}"><i class="fas fa-id-card"></i> IC</div>`;
    }

    let pickupAssistHtml = '';
    if (status === 'PICKUP_REQUIRED') {
      const assistLabel = UI.pickupAssistanceLabel(event);
      if (assistLabel) {
        pickupAssistHtml = `<div class="bed-pickup-assist-badge" style="background:#fef2f2; color:#b91c1c; padding:2px 5px; border-radius:4px; font-size:9px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #fecaca; margin-bottom:2px;" title="お迎えに必要なもの: ${UI.escapeHTML(assistLabel)}"><i class="fas fa-wheelchair"></i> ${UI.escapeHTML(assistLabel)}</div>`;
      }
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

    const scheduleBadgeHtml = this._renderTodayScheduleBadges(bed);

    // 患者情報の表示部分の作成 (マスク適用時は直接 "＊＊＊＊" に置き換え)
    const showNames = !UI.isPatientMaskEnabled();

    let patientHtml = '';
    if (bed.patient_name) {
      const presenceLabel = bed.is_present ? '在床' : '不在';
      const presenceColor = bed.is_present ? '#10b981' : '#ef4444';
      
      const patientNameText = showNames ? UI.escapeHTML(bed.patient_name) : '＊＊＊＊';
      const patientIdText = showNames ? UI.escapeHTML(bed.patient_id || '') : '＊＊＊＊';

      patientHtml = `<div class="bed-patient-info" style="margin-top: 2px; border-top: 1px dashed rgba(0,0,0,0.08); padding-top: 2px;">
        <div class="bed-patient-name" title="${patientNameText}" style="font-weight:700; color:#2d3748; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; white-space:normal; word-break:break-word;">${patientNameText}</div>
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

    const cardTitle = `${bed.bed_number}号床 - ${statusLabel}${event && event.patient_ic_tag_id ? ' (ICカード登録済)' : ''}`;
    // formatBedName は内部で各値をエスケープ済みの表示用HTMLを返す。
    // ここで再度エスケープすると <span> タグそのものが病床名として表示される。
    const safeDisplayNo = displayNo;
    const safeStatusLabel = UI.escapeHTML(statusLabel);

    return `
      <div class="bed-card status-${UI.escapeHTML(status)}" data-bed-id="${UI.escapeHTML(bed.id)}" style="${cardStyle}"
           title="${UI.escapeHTML(cardTitle)}">
        ${pulseDot}
        <div class="bed-number">${safeDisplayNo}</div>
        <div class="bed-status-badge badge-${UI.escapeHTML(status)}" style="${badgeStyle}">${safeStatusLabel}</div>
        ${examInfoHtml}
        ${timerHtml}
        <div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap; margin-top:2px;">
          ${staffHtml}
          ${icBadgeHtml}
          ${pickupAssistHtml}
          ${remarksHtml}
          ${scheduleBadgeHtml}
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
        card.classList.remove('filtered-out');
      } else {
        card.style.opacity = '0.15';
        card.style.pointerEvents = 'auto';
        card.style.transform = 'scale(0.96)';
        card.style.transition = 'all 0.2s ease';
        card.classList.add('filtered-out');
      }
    });
  },
};
