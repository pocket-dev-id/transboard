/**
 * TransBoard - 優先対応一覧 & サマリー
 */

const Priority = {

  renderSummary() {
    const s = AppState.getSummary();
    document.getElementById('cnt-depart').textContent = s.depart;
    document.getElementById('cnt-escort').textContent = s.escort;
    document.getElementById('cnt-pickup').textContent = s.pickup;
    document.getElementById('cnt-soon').textContent = s.soon;
    document.getElementById('cnt-delay').textContent = s.delay;

    // 迎え要がある場合はヘッダー点滅
    const pickupCard = document.getElementById('summary-pickup');
    if (s.pickup > 0) {
      pickupCard.style.animation = 'pulse 1s infinite';
    } else {
      pickupCard.style.animation = '';
    }
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
        ${event.escort_staff_id ? `<div class="text-xs text-muted"><i class="fas fa-user-nurse"></i> ${AppState.getStaffById(event.escort_staff_id)?.name || '--'}</div>` : ''}
      </div>
    `;
  },
};

const StaffStatus = {
  render() {
    const panel = document.getElementById('staff-status-panel');
    if (!panel) return;

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

    panel.innerHTML = wardStaffs.map(staff => {
      const event = assignedByStaff.get(staff.id);
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
    if (['DEPART_REGISTERED', 'MOVING', 'PICKUP_REQUIRED'].includes(event.current_status)) {
      return { cls: 'active', label: '付き添い中', icon: 'fa-walking' };
    }
    return { cls: 'standby', label: '病棟待機', icon: 'fa-hourglass-half' };
  },
};
