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
      icHtml = `<span style="background:#e0f2fe; color:#0369a1; padding:2px 5px; border-radius:4px; font-size:9px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #bae6fd; margin-right:4px;" title="ICカードID: ${event.patient_ic_tag_id}"><i class="fas fa-id-card"></i> IC</span>`;
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
