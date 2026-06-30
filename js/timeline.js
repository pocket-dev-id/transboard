/**
 * TransBoard - タイムライン
 */

// ── ポップアップ（クリック詳細） ──────────────────────────────
const TimelinePopup = {
  _el: null,

  _ensureEl() {
    if (this._el) return this._el;
    const div = document.createElement('div');
    div.id = 'tl-popup';
    div.style.cssText = `
      position:fixed;z-index:9999;background:#fff;border:1px solid #e2e8f0;
      border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.18);padding:14px 16px;
      min-width:260px;max-width:340px;font-size:13px;display:none;
    `;
    document.body.appendChild(div);
    document.addEventListener('mousedown', e => {
      if (this._el && !this._el.contains(e.target)) this.hide();
    });
    this._el = div;
    return div;
  },

  show(html, x, y) {
    const el = this._ensureEl();
    el.innerHTML = html;
    el.style.display = 'block';
    const vw = window.innerWidth, vh = window.innerHeight;
    el.style.left = `${Math.min(x + 8, vw - 348)}px`;
    el.style.top  = `${Math.min(y + 8, vh - 250)}px`;
  },

  hide() { if (this._el) this._el.style.display = 'none'; },
};

// ── コンテキストメニュー（右クリック） ────────────────────────
const TimelineContextMenu = {
  _el: null,

  // 次のステータス定義
  NEXT: {
    DEPART_REGISTERED: [
      { to: 'MOVING',     label: '移動開始',   icon: 'fa-walking' },
      { to: 'CANCELLED',  label: 'キャンセル', icon: 'fa-times',  danger: true },
    ],
    MOVING: [
      { to: 'ARRIVED',    label: '検査室到着', icon: 'fa-hospital' },
      { to: 'CANCELLED',  label: 'キャンセル', icon: 'fa-times',  danger: true },
    ],
    ARRIVED: [
      { to: 'IN_EXAM',    label: '検査開始',   icon: 'fa-flask' },
      { to: 'CANCELLED',  label: 'キャンセル', icon: 'fa-times',  danger: true },
    ],
    IN_EXAM: [
      { to: 'NEARLY_DONE', label: 'あと10分',  icon: 'fa-clock' },
    ],
    NEARLY_DONE: [
      { to: 'PICKUP_REQUIRED', label: '迎え要', icon: 'fa-bell' },
    ],
    PICKUP_REQUIRED: [
      { to: 'RETURNED', label: '帰棟完了', icon: 'fa-check-circle' },
    ],
  },

  _ensureEl() {
    if (this._el) return this._el;
    const div = document.createElement('div');
    div.id = 'tl-ctx-menu';
    div.className = 'tl-ctx-menu';
    div.style.display = 'none';
    document.body.appendChild(div);
    document.addEventListener('mousedown', e => {
      if (this._el && !this._el.contains(e.target)) this.hide();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.hide();
    });
    this._el = div;
    return div;
  },

  show(event, x, y) {
    const el = this._ensureEl();
    const nexts = this.NEXT[event.current_status] || [];
    const bed = AppState.getBedById(event.bed_id);
    const bedName = bed ? `${bed.bed_number}号床` : '?';
    const statusLabel = CONFIG.STATUS_LABEL?.[event.current_status] || event.current_status;

    const statusItems = nexts.map(n => `
      <div class="tl-ctx-item${n.danger ? ' tl-ctx-item--danger' : ''}" data-to="${n.to}">
        <i class="fas ${n.icon}"></i> ${n.label}
      </div>`).join('');

    el.innerHTML = `
      <div class="tl-ctx-header">${bedName} <span class="tl-ctx-badge">${statusLabel}</span></div>
      ${statusItems}
      <div class="tl-ctx-divider"></div>
      <div class="tl-ctx-item tl-ctx-item--detail" data-action="detail">
        <i class="fas fa-info-circle"></i> 詳細・迎え目安変更
      </div>
    `;

    el.style.display = 'block';
    const vw = window.innerWidth, vh = window.innerHeight;
    el.style.left = `${Math.min(x, vw - 200)}px`;
    el.style.top  = `${Math.min(y, vh - el.scrollHeight - 8)}px`;

    // ステータス変更クリック
    el.querySelectorAll('[data-to]').forEach(btn => {
      btn.addEventListener('click', async () => {
        this.hide();
        TimelinePopup.hide();
        const newStatus = btn.dataset.to;
        try {
          await API.updateEventStatus(event.id, newStatus);
          await App.refreshData();
          Timeline.render();
          UI.toast(`${bedName}: ${CONFIG.STATUS_LABEL?.[newStatus] || newStatus} に更新しました`, 'success');
        } catch (err) {
          UI.toast('ステータスの変更に失敗しました', 'danger');
        }
      });
    });

    // 詳細表示クリック
    el.querySelector('[data-action="detail"]')?.addEventListener('click', () => {
      this.hide();
      if (bed) BedModal.open(bed.id);
    });
  },

  hide() { if (this._el) this._el.style.display = 'none'; },
};

// ── メインオブジェクト ────────────────────────────────────────
const Timeline = {

  // 永続フィルタ状態
  _filterBedType: null,   // null = すべて
  _timeRangeMode: 'fixed', // 'fixed' | 'auto'

  render() {
    this._renderMiniTimeline();
    this._renderFullTimeline().catch(console.error);
    // ミニタイムラインの「タイムラインを開く」ボタン
    const gotoBtn = document.getElementById('btn-goto-timeline');
    if (gotoBtn && !gotoBtn.dataset.bound) {
      gotoBtn.dataset.bound = '1';
      gotoBtn.addEventListener('click', () => {
        document.querySelector('.tab-btn[data-page="timeline"]')?.click();
      });
    }
  },

  // ── ミニタイムライン（ダッシュボード下部） ──────────────────
  _renderMiniTimeline() {
    const container = document.getElementById('mini-timeline');
    if (!container) return;

    const events = AppState.activeEvents.filter(e => CONFIG.DEPART_STATUSES.includes(e.current_status));
    if (events.length === 0) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-stream"></i><p>出棟中の患者がいません</p></div>';
      return;
    }

    const now = Date.now();
    const windowStart = now - 30 * 60 * 1000;
    const windowEnd   = now + 90 * 60 * 1000;
    const windowMs    = windowEnd - windowStart;
    const toPercent   = ms => Math.max(0, Math.min(100, (ms - windowStart) / windowMs * 100));

    let html = `<div class="timeline-row">
      <div class="timeline-bed-label" style="font-size:10px;color:#718096;">病床</div>
      <div class="timeline-bar-track" style="position:relative;background:transparent;">
        ${this._renderTimeAxis(windowStart, windowEnd)}
      </div>
    </div>`;

    events.forEach(e => {
      const bed = AppState.getBedById(e.bed_id);
      const segs = this._buildSegments(e, windowStart, windowEnd, toPercent);
      const editable = !['RETURNED','CANCELLED'].includes(e.current_status);
      html += `<div class="timeline-row">
        <div class="timeline-bed-label">${bed ? UI.formatBedName(bed) : '?'}</div>
        <div class="timeline-bar-track" data-event-id="${e.id}"
          data-window-start="${windowStart}" data-window-end="${windowEnd}"
          data-editable="${editable}"
          style="${editable ? 'cursor:pointer;' : ''}position:relative;">
          ${segs.map(s => `<div class="timeline-segment ${s.cls}"
            style="left:${s.left}%;width:${s.width}%;background:${s.color};" title="${s.label}">
            ${s.width > 8 ? s.label : ''}</div>`).join('')}
          <div class="timeline-now-marker" style="left:${toPercent(now)}%;"></div>
          ${e.estimated_pickup_at ? `<div class="timeline-pickup-marker" style="left:${toPercent(e.estimated_pickup_at)}%;" title="迎え目安 ${UI.formatTime(e.estimated_pickup_at)}"></div>` : ''}
        </div>
      </div>`;
    });

    container.innerHTML = html;
    this._bindClickHandlers(container, '.timeline-bar-track[data-event-id]', 'activeEvents');
    this._bindContextMenu(container, '.timeline-bar-track[data-event-id]', 'activeEvents');
  },

  _renderTimeAxis(start, end) {
    const ms = end - start, step = 15 * 60 * 1000;
    let t = Math.ceil(start / step) * step, marks = [];
    while (t <= end) {
      const pct = (t - start) / ms * 100;
      marks.push(`<div style="position:absolute;left:${pct}%;transform:translateX(-50%);font-size:10px;color:#94a3b8;top:2px;">${UI.formatTime(t)}</div>`);
      t += step;
    }
    return marks.join('');
  },

  _buildSegments(event, winStart, winEnd, toPercent) {
    const pairs = [
      { from:'departed_at',    to:'arrived_at',      cls:'seg-moving',      color:'#3b82f6', label:'移動中' },
      { from:'arrived_at',     to:'exam_started_at', cls:'seg-arrived',     color:'#0284c7', label:'到着' },
      { from:'exam_started_at',to:'nearly_done_at',  cls:'seg-in-exam',     color:'#ca8a04', label:'検査中' },
      { from:'nearly_done_at', to:'pickup_ready_at', cls:'seg-nearly-done', color:'#ea580c', label:'あと10分' },
      { from:'pickup_ready_at',to:'returned_at',     cls:'seg-pickup',      color:'#dc2626', label:'迎え要' },
      { from:'returned_at',    to:'_returned_end',   cls:'seg-returned',    color:'#16a34a', label:'帰棟' },
    ];
    const now = Date.now();
    const segments = [];

    for (const p of pairs) {
      const fromMs = event[p.from]; if (!fromMs) continue;
      let toMs = p.to === '_returned_end' ? fromMs + 30*60*1000 : (p.to ? event[p.to] : now);
      if (!toMs) continue;
      const sStart = Math.max(fromMs, winStart), sEnd = Math.min(toMs, winEnd);
      if (sStart >= winEnd || sEnd <= winStart) continue;
      const left = toPercent(sStart), width = toPercent(sEnd) - left;
      if (width < 0.5) continue;
      segments.push({ left, width, cls: p.cls, color: p.color, label: p.label });
    }

    if (segments.length === 0 && event.departed_at) {
      const left = toPercent(Math.max(event.departed_at, winStart));
      const right = toPercent(Math.min(now, winEnd));
      if (right > left) segments.push({ left, width: right - left, cls:'seg-moving', color:'#93c5fd', label:'...' });
    }
    return segments;
  },

  // ── クリックポップアップ ──────────────────────────────────
  _showEventPopup(event, x, y) {
    const bed = AppState.getBedById(event.bed_id);
    const examRoom = AppState.getExamRoomById(event.exam_room_id);
    const examType = AppState.getExamTypeById(event.exam_type_id);
    const bedName = bed ? `${bed.bed_number}号床` : '?';
    const pickupVal = event.estimated_pickup_at
      ? new Date(event.estimated_pickup_at).toTimeString().slice(0, 5) : '';

    TimelinePopup.show(`
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:10px;">
        <div style="font-weight:700;font-size:14px;">${UI.escapeHTML(bedName)}</div>
        <span style="font-size:11px;padding:2px 8px;border-radius:12px;background:#e2e8f0;color:#4a5568;">
          ${UI.escapeHTML(CONFIG.STATUS_LABEL?.[event.current_status] || event.current_status)}
        </span>
      </div>
      <div style="color:#4a5568;line-height:2.0;font-size:12px;">
        <div>👤 ${UI.escapeHTML(event.patient_name || '（患者名なし）')}</div>
        ${event.patient_id ? `<div style="color:#718096;">ID: ${UI.escapeHTML(event.patient_id)}</div>` : ''}
        ${examRoom ? `<div>🏥 ${UI.escapeHTML(examRoom.name)}${examType ? ' / '+UI.escapeHTML(examType.name) : ''}</div>` : ''}
        <div>🚶 出棟: ${UI.formatTime(event.departed_at)}</div>
        ${event.estimated_pickup_at ? `<div>🔔 迎え目安: ${UI.formatTime(event.estimated_pickup_at)}</div>` : ''}
      </div>
      <div style="margin-top:10px;border-top:1px solid #e2e8f0;padding-top:10px;">
        <div style="font-size:11px;color:#718096;margin-bottom:4px;">迎え目安を変更:</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="time" id="tl-popup-time" value="${UI.escapeHTML(pickupVal)}"
            style="border:1px solid #cbd5e0;border-radius:6px;padding:4px 8px;font-size:13px;flex:1;">
          <button id="tl-popup-save"
            style="background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;">
            更新
          </button>
        </div>
      </div>
    `, x, y);

    document.getElementById('tl-popup-save')?.addEventListener('click', async () => {
      const inp = document.getElementById('tl-popup-time');
      if (!inp || !inp.value) return;
      const [h, m] = inp.value.split(':').map(Number);
      const base = new Date(event.departed_at || Date.now());
      base.setHours(h, m, 0, 0);
      try {
        await API.patch('transfer_events', event.id, { estimated_pickup_at: base.getTime() });
        await API.addStatusLog(event.id, event.current_status, event.current_status, `目安時間変更 (${UI.formatTime(base.getTime())})`);
        await App.refreshData();
        Timeline.render();
        TimelinePopup.hide();
        UI.toast('迎え目安時間を変更しました', 'success');
      } catch (err) { UI.toast('時間の変更に失敗しました', 'danger'); }
    });
  },

  _showScheduleItemPopup(item, x, y) {
    const endMs = item.duration_min ? item.start_ms + item.duration_min * 60000 : null;
    const rawRows = Object.entries(item.raw || {})
      .map(([k,v]) => `<tr><td style="color:#718096;padding-right:8px;white-space:nowrap;">${UI.escapeHTML(k)}</td><td>${UI.escapeHTML(String(v))}</td></tr>`)
      .join('');
    TimelinePopup.show(`
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:10px;gap:8px;">
        <div style="font-weight:700;font-size:14px;flex:1;">${UI.escapeHTML(item.title || '（タイトルなし）')}</div>
        <span style="font-size:10px;padding:2px 6px;border-radius:10px;white-space:nowrap;
          background:${UI.escapeHTML(item.color||'#7c3aed')}22;color:${UI.escapeHTML(item.color||'#7c3aed')};">
          ${UI.escapeHTML(item.feed_name || '')}
        </span>
      </div>
      <div style="color:#4a5568;line-height:2.0;font-size:12px;">
        <div>🕐 ${UI.formatTime(item.start_ms)}${endMs ? ' ～ '+UI.formatTime(endMs) : ''}${item.duration_min ? `（${item.duration_min}分）` : ''}</div>
        ${item.identifier ? `<div>🔖 ID: ${UI.escapeHTML(item.identifier)}</div>` : ''}
      </div>
      ${rawRows ? `<details style="margin-top:8px;"><summary style="font-size:11px;color:#718096;cursor:pointer;">元データ</summary>
        <table style="font-size:11px;margin-top:6px;border-collapse:collapse;line-height:1.7;">${rawRows}</table></details>` : ''}
    `, x, y);
  },

  // ── 左クリックハンドラ ───────────────────────────────────
  _bindClickHandlers(container, selector, eventSource) {
    container.querySelectorAll(selector).forEach(track => {
      if (track.dataset.editable === 'false') return;
      track.addEventListener('click', evt => {
        const src = eventSource === 'activeEvents' ? AppState.activeEvents : this._dateEvents;
        const event = src?.find(x => x.id === track.dataset.eventId);
        if (!event || ['RETURNED','CANCELLED'].includes(event.current_status)) return;
        TimelineContextMenu.hide();
        this._showEventPopup(event, evt.clientX, evt.clientY);
      });
    });
  },

  // ── 右クリックコンテキストメニュー ───────────────────────
  _bindContextMenu(container, selector, eventSource) {
    container.querySelectorAll(selector).forEach(track => {
      track.addEventListener('contextmenu', evt => {
        evt.preventDefault();
        const src = eventSource === 'activeEvents' ? AppState.activeEvents : this._dateEvents;
        const event = src?.find(x => x.id === track.dataset.eventId);
        if (!event || ['RETURNED','CANCELLED'].includes(event.current_status)) return;
        TimelinePopup.hide();
        TimelineContextMenu.show(event, evt.clientX, evt.clientY);
      });
    });
  },

  _bindScheduleClickHandlers(container) {
    container.querySelectorAll('.tl-sched-bar[data-sched-id]').forEach(bar => {
      bar.addEventListener('click', evt => {
        evt.stopPropagation();
        const item = (this._scheduleItems || []).find(x => x.id === bar.dataset.schedId);
        if (item) this._showScheduleItemPopup(item, evt.clientX, evt.clientY);
      });
    });
  },

  // ── キャッシュ ──────────────────────────────────────────
  _dateEvents: null,
  _scheduleItems: null,

  // ── フルタイムライン ────────────────────────────────────
  async _renderFullTimeline() {
    const container = document.getElementById('timeline-container');
    if (!container) return;

    // ── 日付 ──
    const dateInput = document.getElementById('timeline-date');
    const targetDate = dateInput ? new Date(dateInput.value) : new Date();
    if (isNaN(targetDate.getTime())) return;
    targetDate.setHours(0, 0, 0, 0);
    const dayStart = targetDate.getTime();
    const dayEnd   = dayStart + 24 * 60 * 60 * 1000;

    // ── 表示範囲トグルボタン同期 ──
    const rangeBtn = document.getElementById('tl-range-toggle');
    if (rangeBtn) {
      rangeBtn.innerHTML = this._timeRangeMode === 'auto'
        ? '<i class="fas fa-compress-alt"></i> データ範囲'
        : '<i class="fas fa-expand-alt"></i> 固定 08-20時';
      rangeBtn.onclick = () => {
        this._timeRangeMode = this._timeRangeMode === 'auto' ? 'fixed' : 'auto';
        this._renderFullTimeline().catch(console.error);
      };
    }

    // ── イベント取得 ──
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    let events;
    if (dayStart === todayStart.getTime()) {
      events = AppState.todayEvents;
    } else {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>データを読み込み中...</p></div>';
      try {
        const all = await API.getAllEventsForWard(AppState.currentWardId);
        events = all.filter(e => {
          const ref = e.departed_at || e.created_at;
          return ref != null && ref >= dayStart && ref < dayEnd;
        });
      } catch (err) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>データの取得に失敗しました</p></div>';
        return;
      }
    }
    this._dateEvents = events;

    // ── スケジュールアイテム取得（現在病棟でフィルタ）──
    let schedItems = [];
    try {
      const allItems = await API.getScheduleItemsForRange(dayStart, dayEnd);
      const wardId = AppState.currentWardId;
      // ward_ids が空/未設定 = 全病棟に表示。特定病棟指定時は一致するものだけ表示
      schedItems = allItems.filter(item =>
        !item.ward_ids?.length || item.ward_ids.includes(wardId)
      );
    } catch(e) {}
    this._scheduleItems = schedItems;

    // ── 日付フィルタ ──
    let filtered = events.filter(e => {
      const ref = e.departed_at || e.created_at;
      return ref != null && ref >= dayStart && ref < dayEnd;
    });

    // ── A2: 病床種別フィルタ適用 ──
    if (this._filterBedType) {
      filtered = filtered.filter(e => {
        const bed = AppState.getBedById(e.bed_id);
        if (!bed) return false;
        const typeCode = AppState.normalizeBedTypeCode(bed.bed_type);
        return typeCode === this._filterBedType;
      });
    }

    // ── フィルタバー描画 (A2) ──
    this._renderFilterBar(filtered.length + schedItems.length);

    if (filtered.length === 0 && schedItems.length === 0) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-calendar"></i><p>この日のデータがありません</p></div>';
      return;
    }

    // ── A1: 時間ウィンドウ計算 ──
    let winStart, winEnd;
    if (this._timeRangeMode === 'auto') {
      const allMs = [
        ...filtered.flatMap(e => [e.departed_at, e.arrived_at, e.exam_started_at, e.nearly_done_at, e.pickup_ready_at, e.returned_at].filter(Boolean)),
        ...schedItems.flatMap(s => [s.start_ms, s.duration_min ? s.start_ms + s.duration_min*60000 : null].filter(Boolean)),
      ];
      if (allMs.length === 0) {
        winStart = dayStart + 8*3600000; winEnd = dayStart + 20*3600000;
      } else {
        winStart = Math.max(Math.min(...allMs) - 30*60000, dayStart);
        winEnd   = Math.min(Math.max(...allMs) + 60*60000, dayEnd);
      }
    } else {
      winStart = dayStart + 8*3600000;
      winEnd   = dayStart + 20*3600000;
    }
    const winMs = winEnd - winStart;
    const toPercent = ms => Math.max(0, Math.min(100, (ms - winStart) / winMs * 100));
    const now = Date.now(), nowPct = toPercent(now);

    // ── 患者ID連携: schedItems を病床行に紐付ける ──
    // bed.patient_id と item.identifier が一致するものを病床行に表示する
    const bedScheduleMap = {}; // bed_id → item[]
    const unlinkedSchedItems = [];
    schedItems.forEach(item => {
      if (item.identifier) {
        const matchBed = AppState.beds.find(b => b.patient_id && b.patient_id.trim() === item.identifier.trim());
        if (matchBed) {
          if (!bedScheduleMap[matchBed.id]) bedScheduleMap[matchBed.id] = [];
          bedScheduleMap[matchBed.id].push(item);
          return;
        }
      }
      unlinkedSchedItems.push(item);
    });

    // スケジュールバー共通描画ヘルパー
    const _schedBarHtml = (item, color) => {
      if (item.start_ms < winStart || item.start_ms > winEnd) return '';
      const left = toPercent(item.start_ms);
      const endMs = item.duration_min ? item.start_ms + item.duration_min*60000 : item.start_ms + 30*60000;
      const width = Math.max(1, toPercent(Math.min(endMs, winEnd)) - left);
      return `<div class="tl-sched-bar" data-sched-id="${UI.escapeHTML(item.id)}"
        style="position:absolute;left:${left}%;width:${width}%;height:20px;top:3px;
          background:${UI.escapeHTML(color)};border-radius:4px;cursor:pointer;
          display:flex;align-items:center;overflow:hidden;padding:0 6px;
          box-sizing:border-box;font-size:10px;color:#fff;font-weight:600;white-space:nowrap;
          opacity:0.92;border:1px solid rgba(255,255,255,0.3);"
        title="${UI.escapeHTML(item.title)}${item.identifier?' ['+item.identifier+']':''}">
        ${width > 4 ? UI.escapeHTML(item.title.length > 14 ? item.title.slice(0,14)+'…' : item.title) : ''}
      </div>`;
    };

    // ── HTML構築 ──
    const nowBar = now >= winStart && now <= winEnd
      ? `<div class="tl-marker" style="left:${nowPct}%;"><span style="position:absolute;top:-16px;left:-12px;font-size:9px;background:#dc2626;color:#fff;padding:1px 4px;border-radius:3px;">NOW</span></div>`
      : '';

    // C3: スティッキー時刻軸ヘッダ
    let html = `<div class="tl-scroll-wrap">
      <div class="tl-sticky-header">
        <div class="tl-row-label tl-sticky-label"></div>
        <div class="tl-row-track" style="height:22px;">
          ${this._renderFullTimeAxis(winStart, winEnd, winMs)}
          ${nowBar}
        </div>
      </div>
      <div class="tl-grid">`;

    // 移送行（患者ID連携スケジュールを同一行のサブトラックに表示）
    if (filtered.length > 0) {
      html += `<div class="tl-section-label"><div class="tl-row-label" style="font-size:10px;font-weight:700;color:#94a3b8;text-align:right;">移送</div><div class="tl-row-track" style="background:transparent;"></div></div>`;
      filtered.forEach(e => {
        const bed = AppState.getBedById(e.bed_id);
        const segs = this._buildSegments(e, winStart, winEnd, toPercent);
        const editable = !['RETURNED','CANCELLED'].includes(e.current_status);
        const linkedItems = bedScheduleMap[e.bed_id] || [];
        html += `<div class="tl-row${linkedItems.length ? ' tl-row--has-sched' : ''}">
          <div class="tl-row-label">${bed ? UI.formatBedName(bed) : '?'}</div>
          <div class="tl-row-track" data-event-id="${e.id}"
            data-window-start="${winStart}" data-window-end="${winEnd}"
            data-editable="${editable}"
            style="${editable?'cursor:pointer;':''}position:relative;">
            ${segs.map(s => `<div class="tl-seg ${s.cls}" style="left:${s.left}%;width:${s.width}%;background:${s.color};" title="${s.label}">
              ${s.width > 5 ? s.label : ''}</div>`).join('')}
            ${e.estimated_pickup_at && e.estimated_pickup_at >= winStart && e.estimated_pickup_at <= winEnd
              ? `<div class="timeline-pickup-marker" style="left:${toPercent(e.estimated_pickup_at)}%;" title="迎え目安 ${UI.formatTime(e.estimated_pickup_at)}"></div>` : ''}
          </div>
        </div>`;
        // 連携スケジュールを同行のサブトラックに表示
        if (linkedItems.length > 0) {
          html += `<div class="tl-row tl-row-sched-sub">
            <div class="tl-row-label" style="font-size:9px;color:#7c3aed;text-align:right;padding-right:4px;">📅</div>
            <div class="tl-row-track" style="position:relative;height:26px;background:rgba(124,58,237,0.04);border-top:none;">
              ${linkedItems.map(item => _schedBarHtml(item, item.color || '#7c3aed')).join('')}
            </div>
          </div>`;
        }
      });
    }

    // 病床にスケジュールが紐付いているが移送イベントがない場合（在床中の予定）
    const transferBedIds = new Set(filtered.map(e => e.bed_id));
    const bedOnlySchedBeds = Object.keys(bedScheduleMap).filter(bedId => !transferBedIds.has(bedId));
    if (bedOnlySchedBeds.length > 0) {
      html += `<div class="tl-section-label"><div class="tl-row-label" style="font-size:10px;font-weight:700;color:#7c3aed;text-align:right;">在床スケジュール</div><div class="tl-row-track" style="background:transparent;"></div></div>`;
      bedOnlySchedBeds.forEach(bedId => {
        const bed = AppState.getBedById(bedId);
        const items = bedScheduleMap[bedId];
        html += `<div class="tl-row">
          <div class="tl-row-label">${bed ? UI.formatBedName(bed) : '?'}</div>
          <div class="tl-row-track" style="position:relative;height:26px;">
            ${items.map(item => _schedBarHtml(item, item.color || '#7c3aed')).join('')}
          </div>
        </div>`;
      });
    }

    // 患者ID未一致のスケジュール行（フィード別グループ）
    if (unlinkedSchedItems.length > 0) {
      if (filtered.length > 0 || bedOnlySchedBeds.length > 0) html += `<div style="height:6px;min-width:900px;"></div>`;
      const feedGroups = {};
      unlinkedSchedItems.forEach(item => {
        const k = item.feed_id || 'unknown';
        if (!feedGroups[k]) feedGroups[k] = { name: item.feed_name || k, color: item.color || '#7c3aed', items: [] };
        feedGroups[k].items.push(item);
      });
      Object.values(feedGroups).forEach(g => {
        html += `<div class="tl-section-label"><div class="tl-row-label" style="font-size:10px;font-weight:700;color:${UI.escapeHTML(g.color)};text-align:right;">${UI.escapeHTML(g.name)}</div><div class="tl-row-track" style="background:transparent;"></div></div>
        <div class="tl-row">
          <div class="tl-row-label"></div>
          <div class="tl-row-track" style="position:relative;height:30px;">`;
        g.items.forEach(item => {
          html += _schedBarHtml(item, g.color);
        });
        html += `</div></div>`;
      });
    }

    html += '</div></div>';
    container.innerHTML = html;

    this._bindClickHandlers(container, '.tl-row-track[data-event-id]', 'dateEvents');
    this._bindContextMenu(container, '.tl-row-track[data-event-id]', 'dateEvents');
    this._bindScheduleClickHandlers(container);
  },

  // A2: フィルタバー描画
  _renderFilterBar(totalCount) {
    const bar = document.getElementById('timeline-filter-bar');
    if (!bar) return;

    const bedTypes = AppState.bedTypes || [];
    const chips = [{ code: null, label: 'すべて' }, ...bedTypes.map(t => ({ code: t.code, label: t.name }))];

    bar.innerHTML = `<div class="tl-filter-bar">
      <span class="tl-filter-label">病床種別:</span>
      ${chips.map(t => `
        <button class="tl-filter-chip${this._filterBedType === t.code ? ' active' : ''}"
          data-code="${t.code === null ? '' : t.code}">
          ${t.label}
        </button>`).join('')}
      <span class="tl-filter-count">${totalCount}件</span>
    </div>`;

    bar.querySelectorAll('.tl-filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.code || null;
        this._filterBedType = code;
        this._renderFullTimeline().catch(console.error);
      });
    });
  },

  _renderFullTimeAxis(start, end, winMs) {
    const step = 60 * 60 * 1000;
    let t = Math.ceil(start / step) * step, marks = [];
    while (t <= end) {
      const pct = (t - start) / winMs * 100;
      marks.push(`<div class="tl-time-mark" style="left:${pct}%;">${UI.formatTime(t)}</div>`);
      t += step;
    }
    return marks.join('');
  },
};
