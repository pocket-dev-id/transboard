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
      list.innerHTML = UI.emptyStateHtml('現在、出棟中の患者はいません', { icon: 'fas fa-check-circle', iconStyle: 'color:#16a34a' });
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
      const pickupTime = UI.formatTimeSmart(event.estimated_pickup_at);
      timeHtml = `
        <div class="priority-time ${remClass}">
          <i class="fas fa-clock"></i> ${pickupTime}（${remText}）
        </div>`;
    }

    let icHtml = '';
    if (event.patient_ic_tag_id) {
      icHtml = `<span style="background:#e0f2fe; color:#0369a1; padding:2px 5px; border-radius:4px; font-size:9px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #bae6fd; margin-right:4px;" title="ICカードID: ${UI.escapeHTML(event.patient_ic_tag_id)}"><i class="fas fa-id-card"></i> IC</span>`;
    }

    // 終了登録(迎え要)時に選ばれた「お迎えに必要なもの」。マスタでアイコンが
    // 設定されていなければ汎用アイコン(fa-hand-paper)にフォールバックする
    let pickupAssistHtml = '';
    const pickupAssistLabel = UI.pickupAssistanceLabel(event);
    if (pickupAssistLabel) {
      const pickupAssistIcon = UI.pickupAssistanceIcon(event) || 'fa-hand-paper';
      pickupAssistHtml = `
        <div class="priority-pickup-assist">
          <i class="fas ${UI.escapeHTML(pickupAssistIcon)}"></i> ${UI.escapeHTML(pickupAssistLabel)}
        </div>`;
    }

    return `
      <div class="priority-item ${itemClass}" data-bed-id="${bed ? UI.escapeHTML(bed.id) : ''}" style="cursor:pointer;">
        <div class="priority-item-header">
          <span class="priority-bed-num">${bed ? UI.formatBedName(bed) : '?'}</span>
          <div style="display:flex; gap:4px; align-items:center;">
            ${icHtml}
            ${UI.statusBadge(status)}
          </div>
        </div>
        <div class="priority-exam-info">
          ${examType ? UI.escapeHTML(examType.name) : '--'} ${examRoom ? '/ ' + UI.escapeHTML(examRoom.name) : ''}
          ${event.departed_at ? ' | ' + UI.formatTimeSmart(event.departed_at) + '出棟' : ''}
        </div>
        ${timeHtml}
        ${pickupAssistHtml}
        ${(() => {
          if (!event.escort_staff_id) return '';
          const staffName = AppState.getStaffById(event.escort_staff_id)?.name || '--';
          // 実際に移動中(MOVING/PICKUP_REQUIRED)か、検査中等で病棟待機中かで表示を変える
          const isActive = CONFIG.ESCORT_ACTIVE_STATUSES.includes(status);
          return UI.escortBadge(staffName, isActive, 'priority-escort', 'text-xs');
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
      panel.innerHTML = UI.emptyStateHtml('スタッフが登録されていません', { icon: 'fas fa-user-nurse' });
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
      panel.innerHTML = UI.emptyStateHtml('稼働中のスタッフはいません', { icon: 'fas fa-user-nurse' });
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
      return { cls: 'active', label: UI.escortRoleLabel(true), icon: 'fa-walking' };
    }
    return { cls: 'standby', label: UI.escortRoleLabel(false), icon: 'fa-hourglass-half' };
  },
};

const NotificationHistory = {
  render() {
    const list = document.getElementById('notification-history-list');
    if (!list) return;

    const unconfirmedOnly = document.getElementById('notification-history-unconfirmed-only');
    if (unconfirmedOnly && !unconfirmedOnly.dataset.listenerBound) {
      unconfirmedOnly.checked = localStorage.getItem('cfg_notification_history_unconfirmed_only') === 'true';
      unconfirmedOnly.dataset.listenerBound = 'true';
      unconfirmedOnly.addEventListener('change', () => {
        localStorage.setItem('cfg_notification_history_unconfirmed_only', unconfirmedOnly.checked ? 'true' : 'false');
        this.render();
      });
    }

    const eventById = new Map(
      (AppState.todayEvents || []).map(event => [String(event.id), event])
    );
    // 状態変更通知と、この病棟が受信したアナウンス送信履歴を1つの時系列に統合する。
    // アナウンスには確認/未確認の概念が無いため、「未確認のみ」表示中は対象外にする
    const statusEntries = (AppState.recentStatusLogs || [])
      .filter(log => log.from_status !== log.to_status)
      .filter(log => !unconfirmedOnly?.checked || (
        CONFIG.WARD_ACK_STATUSES.includes(String(log.to_status || '')) && !log.acknowledged_at
      ))
      .map(log => ({ kind: 'status', time: Number(log.changed_at || 0), log }));
    const announceEntries = unconfirmedOnly?.checked
      ? []
      : (AppState.recentAnnouncements || []).map(msg => ({ kind: 'announce', time: Number(msg.created_at || 0), msg }));
    const entries = statusEntries.concat(announceEntries)
      .sort((a, b) => b.time - a.time)
      .slice(0, 20);

    if (entries.length === 0) {
      const emptyLabel = unconfirmedOnly?.checked ? '未確認の通知はありません' : '通知履歴はありません';
      list.innerHTML = UI.emptyStateHtml(emptyLabel, { icon: 'fas fa-bell-slash' });
      return;
    }

    list.innerHTML = entries.map(entry => (
      entry.kind === 'announce' ? this._renderAnnounceItem(entry.msg) : this._renderStatusItem(entry.log, eventById)
    )).join('');

    list.querySelectorAll('.notification-history-open[data-bed-id]:not(:disabled)').forEach(item => {
      item.addEventListener('click', () => BedModal.open(item.dataset.bedId));
    });
    list.querySelectorAll('[data-ack-log-id]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = '送信中…';
        const completed = await App.acknowledgeNotification(button.dataset.ackLogId);
        if (!completed && button.isConnected) {
          button.disabled = false;
          button.textContent = '確認する';
        }
      });
    });
  },

  _renderStatusItem(log, eventById) {
    const event = eventById.get(String(log.transfer_event_id));
    const bed = AppState.getBedById(event?.bed_id || log.bed_id);
    const status = String(log.to_status || '');
    const statusLabel = CONFIG.STATUS_LABEL[status] || status || '状態変更';
    const statusIcon = CONFIG.STATUS_ICON[status] || 'fa-info-circle';
    const changedDate = new Date(Number(log.changed_at || 0));
    const nowDate = new Date();
    const isToday = changedDate.getFullYear() === nowDate.getFullYear() &&
      changedDate.getMonth() === nowDate.getMonth() &&
      changedDate.getDate() === nowDate.getDate();
    const timeLabel = isToday
      ? UI.formatTime(log.changed_at)
      : `${changedDate.getMonth() + 1}/${changedDate.getDate()} ${UI.formatTime(log.changed_at)}`;
    const bedLabel = bed ? `${UI.formatBedNamePlain(bed)}号床` : '病床不明';
    const examRoom = AppState.getExamRoomById(event?.exam_room_id || log.exam_room_id);
    const patientName = String(event?.patient_name || log.patient_name || bed?.patient_name || '').trim();
    const patientLabel = patientName ? UI.getPatientName(patientName) : '';
    const detailLabel = [patientLabel, examRoom?.name || ''].filter(Boolean).join(' / ');
    const disabled = bed ? '' : ' disabled';
    const needsWardAck = CONFIG.WARD_ACK_STATUSES.includes(status);
    const ackHtml = !needsWardAck ? '' : log.acknowledged_at
      ? `<span class="notification-history-ack is-acknowledged" title="${UI.escapeHTML(`${log.acknowledged_by || '病棟'} ${UI.formatTimeSmart(log.acknowledged_at)}確認`)}">
          <i class="fas fa-check-circle"></i> ${UI.escapeHTML(log.acknowledged_by || '病棟')}確認済
        </span>`
      : `<button type="button" class="notification-history-ack-button" data-ack-log-id="${UI.escapeHTML(log.id)}">
          確認する
        </button>`;

    return `
      <div class="notification-history-item status-${UI.escapeHTML(status)}">
        <time>${UI.escapeHTML(timeLabel)}</time>
        <span class="notification-history-icon"><i class="fas ${UI.escapeHTML(statusIcon)}"></i></span>
        <button type="button" class="notification-history-open"
          data-bed-id="${bed ? UI.escapeHTML(bed.id) : ''}"${disabled}
          title="${UI.escapeHTML(`${bedLabel} ${statusLabel}${detailLabel ? ` ${detailLabel}` : ''}`)}">
          <span class="notification-history-main">
            <strong>${UI.escapeHTML(bedLabel)}</strong>
            <small>${UI.escapeHTML(detailLabel)}</small>
          </span>
          <span class="notification-history-status">${UI.escapeHTML(statusLabel)}</span>
        </button>
        ${ackHtml ? `<span class="notification-history-ack-row">${ackHtml}</span>` : ''}
      </div>`;
  },

  // アナウンス受信履歴には確認操作もbed_idも無いため、状態変更通知と同じ4列
  // レイアウト(time/icon/main+status/ack-row)を流用しつつ、クリック不可の
  // 静的な行として描画する(病床モーダルを開く対象が無いため)
  _renderAnnounceItem(msg) {
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
        <span class="notification-history-open">
          <span class="notification-history-main">
            <strong>${UI.escapeHTML(msg.from_name || 'アナウンス')}</strong>
            <small>${UI.escapeHTML(msg.body || '')}</small>
          </span>
          <span class="notification-history-status">アナウンス</span>
        </span>
      </div>`;
  },
};
