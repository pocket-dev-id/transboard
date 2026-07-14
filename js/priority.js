/**
 * TransBoard - 優先対応一覧 & サマリー
 */

const Priority = {

  renderSummary() {
    const s = AppState.getSummary();
    document.getElementById('cnt-depart').textContent = s.depart;
    document.getElementById('cnt-escort').textContent = s.escortActive;
    const activeStaffList = document.getElementById('active-staff-list');
    if (activeStaffList) {
      if (s.activeStaffs && s.activeStaffs.length > 0) {
        activeStaffList.textContent = s.activeStaffs
          .map(item => `${item.staff.name}${item.count > 1 ? `(${item.count})` : ''}`)
          .join('、');
        activeStaffList.title = activeStaffList.textContent;
      } else {
        activeStaffList.textContent = '出ている人なし';
        activeStaffList.title = '';
      }
    }
    document.getElementById('cnt-pickup').textContent = s.pickup;
    document.getElementById('cnt-soon').textContent = s.soon;
    document.getElementById('cnt-delay').textContent = s.delay;

    // 「付き添い中」の数字は実際に移動している人数のみ。検査中などで病棟へ戻り
    // 手離れしているスタッフの人数は添字で補足する
    const standbyEl = document.getElementById('cnt-escort-standby');
    if (standbyEl) {
      standbyEl.textContent = s.escortStandby > 0 ? `（待機${s.escortStandby}）` : '';
    }

    // 迎え要がある場合はヘッダー点滅
    const pickupCard = document.getElementById('summary-pickup');
    if (s.pickup > 0) {
      pickupCard.style.animation = 'pulse 1s infinite';
    } else {
      pickupCard.style.animation = '';
    }
  },

  // 占有率（在床/空床/稼働率）と当日KPI（出棟件数・平均検査時間・迎え待ち平均）を1行で表示
  renderKpi() {
    const el = document.getElementById('kpi-strip');
    if (!el) return;

    const wardId = AppState.currentWardId;
    const beds = (AppState.beds || []).filter(b => b.ward_id === wardId);
    const total = beds.length;
    const occupied = beds.filter(b => b.patient_name).length;   // 患者割当あり
    const present = beds.filter(b => b.patient_name && b.is_present).length;
    const absent = occupied - present;
    const empty = total - occupied;
    const rate = total ? Math.round(occupied / total * 100) : 0;

    // 当日KPI: 本日の帰棟済み移送から平均を算出（ExamStats.computeMetricsを再利用）
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const events = AppState.todayEvents || [];
    // 「移動中」を記録しない運用でも出棟登録した時点でカウントするため、
    // departed_at（移動中で記録）が無ければ created_at（出棟登録時刻）で判定する
    const departsToday = events.filter(e => (e.departed_at || e.created_at || 0) >= todayMs).length;

    const examVals = [], pickupVals = [];
    if (typeof ExamStats !== 'undefined') {
      events.filter(e => e.current_status === 'RETURNED').forEach(e => {
        const m = ExamStats.computeMetrics(e);
        if (m) {
          if (m.exam != null) examVals.push(m.exam);
          if (m.pickup != null) pickupVals.push(m.pickup);
        }
      });
    }
    const avg = arr => arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length) : null;
    const examAvg = avg(examVals);
    const pickupAvg = avg(pickupVals);

    const absentNote = absent > 0 ? `<span class="kpi-sub">（不在${absent}）</span>` : '';
    const examPart = examAvg != null ? `<span class="kpi-item"><span class="kpi-k">平均検査</span> <b>${examAvg}</b>分</span>` : '';
    const pickupPart = pickupAvg != null ? `<span class="kpi-item"><span class="kpi-k">迎え待ち平均</span> <b>${pickupAvg}</b>分</span>` : '';

    el.innerHTML = `
      <span class="kpi-item kpi-rate"><span class="kpi-k">稼働率</span> <b>${rate}%</b> <span class="kpi-sub">在床${present} / 空床${empty}</span>${absentNote}</span>
      <span class="kpi-div"></span>
      <span class="kpi-item"><span class="kpi-k">本日 出棟</span> <b>${departsToday}</b>件</span>
      ${examPart}
      ${pickupPart}`;
  },

  renderPriorityList() {
    const list = document.getElementById('priority-list');
    const items = AppState.getPriorityList();

    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle" style="color:#16a34a"></i><p>現在、出棟中の患者はいません</p></div>';
      return;
    }

    list.innerHTML = items.map(item => this._renderPriorityItem(item)).join('');

    list.querySelectorAll('.priority-item').forEach(el => {
      el.addEventListener('click', () => {
        try {
          const bedId = el.dataset.bedId;
          BedModal.open(bedId);
        } catch (err) {
          console.error('[Priority Click Error]', err);
          UI.toast('詳細ダイアログの起動に失敗しました: ' + err.message, 'danger');
        }
      });
    });
  },

  _renderPriorityItem(item) {
    const { event, bed, examType, examRoom, remaining } = item;
    const status = event.current_status;

    let itemClass = '';
    if (status === 'PICKUP_REQUIRED') itemClass = 'priority-pickup';
    else if (status === 'NEARLY_DONE') itemClass = 'priority-nearly';
    else if (remaining !== null && remaining < CONFIG.SOON_THRESHOLD_MIN * 60 * 1000 && remaining > 0) itemClass = 'priority-soon';

    let timeHtml = '';
    if (event.estimated_pickup_at) {
      const remClass = UI.remainingClass(remaining);
      const remText = UI.formatRemaining(remaining);
      const pickupTime = UI.formatTime(event.estimated_pickup_at);
      timeHtml = `
        <div class="priority-time ${remClass}">
          <i class="fas fa-clock"></i> ${pickupTime}（${remText}）
        </div>`;
    }

    let icHtml = '';
    if (event.patient_ic_tag_id) {
      icHtml = `<span style="background:#e0f2fe; color:#0369a1; padding:2px 5px; border-radius:4px; font-size:9px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #bae6fd; margin-right:4px;" title="ICカードID: ${UI.escapeHTML(event.patient_ic_tag_id)}"><i class="fas fa-id-card"></i> IC</span>`;
    }

    return `
      <div class="priority-item ${itemClass}" data-bed-id="${bed ? bed.id : ''}" style="cursor:pointer;">
        <div class="priority-item-header">
          <span class="priority-bed-num">${bed ? UI.formatBedName(bed) : '?'}</span>
          <div style="display:flex; gap:4px; align-items:center;">
            ${icHtml}
            ${UI.statusBadge(status)}
          </div>
        </div>
        <div class="priority-exam-info">
          ${examType ? examType.name : '--'} ${examRoom ? '/ ' + examRoom.name : ''}
          ${event.departed_at ? ' | ' + UI.formatTime(event.departed_at) + '出棟' : ''}
        </div>
        ${timeHtml}
        ${(() => {
          if (!event.escort_staff_id) return '';
          const staffName = UI.escapeHTML(AppState.getStaffById(event.escort_staff_id)?.name || '--');
          // 実際に移動中(MOVING/PICKUP_REQUIRED)か、検査中等で病棟待機中かで表示を変える
          const isActive = CONFIG.ESCORT_ACTIVE_STATUSES.includes(status);
          return isActive
            ? `<div class="text-xs priority-escort priority-escort--active"><i class="fas fa-walking"></i> ${staffName}</div>`
            : `<div class="text-xs priority-escort priority-escort--standby"><i class="fas fa-user-nurse"></i> ${staffName}（待機）</div>`;
        })()}
      </div>
    `;
  },
};

const StaffStatus = {
  render() {
    const panel = document.getElementById('staff-status-panel');
    if (!panel) return;

    // 「稼働中のみ」フィルタでは空き(free)のスタッフを除外する
    const filter = localStorage.getItem('cfg_staff_filter') || 'all';
    const wardStaffs = (AppState.staffs || []).filter(staff =>
      !staff.ward_id || staff.ward_id === AppState.currentWardId
    );
    if (wardStaffs.length === 0) {
      panel.innerHTML = '<div class="empty-state"><i class="fas fa-user-nurse"></i><p>スタッフが登録されていません</p></div>';
      return;
    }

    const assignedByStaff = new Map();
    (AppState.activeEvents || []).forEach(event => {
      if (!event.escort_staff_id || !CONFIG.DEPART_STATUSES.includes(event.current_status)) return;
      const existing = assignedByStaff.get(event.escort_staff_id);
      if (!existing || this._statusWeight(event.current_status) < this._statusWeight(existing.current_status)) {
        assignedByStaff.set(event.escort_staff_id, event);
      }
    });

    const showNames = localStorage.getItem('cfg_show_patient_names') === 'true' ||
      document.getElementById('chk-show-patient-names')?.checked === true;

    const rows = wardStaffs
      .map(staff => ({ staff, event: assignedByStaff.get(staff.id) }))
      .filter(({ event }) => filter === 'busy' ? !!event : true);

    if (rows.length === 0) {
      panel.innerHTML = '<div class="empty-state"><i class="fas fa-user-nurse"></i><p>稼働中のスタッフはいません</p></div>';
      return;
    }

    panel.innerHTML = rows.map(({ staff, event }) => {
      const bed = event ? AppState.getBedById(event.bed_id) : null;
      const state = this._classify(event);
      const patientName = event?.patient_name || bed?.patient_name || '';
      const patientText = patientName ? (showNames ? UI.escapeHTML(patientName) : '＊＊＊＊') : '患者名なし';
      const bedText = bed ? `${UI.escapeHTML(UI.formatBedNamePlain(bed))}号床` : '';
      const statusText = event ? (CONFIG.STATUS_LABEL[event.current_status] || event.current_status) : '空き';
      const detail = event
        ? `<span class="staff-status-detail">${bedText} / ${patientText} / ${UI.escapeHTML(statusText)}</span>`
        : '<span class="staff-status-detail">担当中の出棟なし</span>';
      const titleText = event
        ? `${staff.name} ${bed ? UI.formatBedNamePlain(bed) + '号床' : ''} ${statusText}`
        : `${staff.name} 空き`;
      return `
        <div class="staff-status-chip ${state.cls}" title="${UI.escapeHTML(titleText)}">
          <span class="staff-status-chip-label"><i class="fas ${state.icon}"></i> ${UI.escapeHTML(staff.name)}</span>
          <span class="staff-status-filter">${state.label}</span>
          ${detail}
        </div>
      `;
    }).join('');
  },

  _statusWeight(status) {
    const order = {
      PICKUP_REQUIRED: 1,
      MOVING: 2,
      DEPART_REGISTERED: 3,
      ARRIVED: 4,
      IN_EXAM: 5,
      NEARLY_DONE: 6,
    };
    return order[status] || 99;
  },

  _classify(event) {
    if (!event) return { cls: 'free', label: '空き', icon: 'fa-check-circle' };
    if (CONFIG.ESCORT_ACTIVE_STATUSES.includes(event.current_status)) {
      return { cls: 'active', label: '付き添い中', icon: 'fa-walking' };
    }
    return { cls: 'standby', label: '病棟待機', icon: 'fa-hourglass-half' };
  },
};
