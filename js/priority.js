/**
 * TransBoard - 優先対応一覧 & サマリー
 */

const Priority = {

  renderSummary() {
    const s = AppState.getSummary();
    document.getElementById('cnt-depart').textContent = s.depart;
    document.getElementById('cnt-escort').textContent = s.escortActive;
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
    const departsToday = events.filter(e => e.departed_at && e.departed_at >= todayMs).length;

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

  // スタッフごとの稼働状況(付き添い中/病棟待機/空き)を一覧表示する
  renderStaffStatus() {
    const panel = document.getElementById('staff-status-panel');
    if (!panel) return;

    const staffs = (AppState.staffs || [])
      .filter(s => s.is_active && s.ward_id === AppState.currentWardId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    if (staffs.length === 0) {
      panel.innerHTML = '<div class="text-muted text-sm" style="padding:4px 0;">スタッフが登録されていません</div>';
      return;
    }

    const STATUS_META = {
      active:  { cls: 'active',  label: '付き添い中', icon: 'fa-walking' },
      standby: { cls: 'standby', label: '病棟待機',   icon: 'fa-clock' },
      free:    { cls: 'free',    label: '空き',       icon: 'fa-check' },
    };

    // 稼働状況を付与。「稼働中のみ」フィルタでは空き(free)を除外し、
    // 付き添いに関わっているスタッフ(付き添い中/病棟待機)だけを表示する
    const filter = localStorage.getItem('cfg_staff_filter') || 'all';
    const rows = staffs
      .map(staff => ({ staff, status: AppState.getStaffEscortStatus(staff.id) || 'free' }))
      .filter(row => filter === 'busy' ? row.status !== 'free' : true);

    if (rows.length === 0) {
      panel.innerHTML = '<div class="text-muted text-sm" style="padding:4px 0;">稼働中のスタッフはいません</div>';
      return;
    }

    panel.innerHTML = rows.map(({ staff, status }) => {
      const meta = STATUS_META[status];
      return `
        <span class="staff-status-chip ${meta.cls}">
          <i class="fas ${meta.icon}"></i> ${UI.escapeHTML(staff.name)}
          <span class="staff-status-chip-label">${meta.label}</span>
        </span>`;
    }).join('');
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
        <span class="priority-time ${remClass}">
          <i class="fas fa-clock"></i> ${pickupTime}（${remText}）
        </span>`;
    }

    let icHtml = '';
    if (event.patient_ic_tag_id) {
      icHtml = `<span style="background:#e0f2fe; color:#0369a1; padding:2px 5px; border-radius:4px; font-size:10px; font-weight:800; display:inline-flex; align-items:center; gap:2px; border: 1px solid #bae6fd;" title="ICカードID: ${UI.escapeHTML(event.patient_ic_tag_id)}"><i class="fas fa-id-card"></i> IC</span>`;
    }

    const patientName = bed ? UI.getPatientName(bed.patient_name) : null;
    const patientHtml = patientName
      ? `<span class="priority-patient-name">${UI.escapeHTML(patientName)}</span>`
      : '';

    const examInfo = `${examType ? UI.escapeHTML(examType.name) : '--'}${examRoom ? ' / ' + UI.escapeHTML(examRoom.name) : ''}`;
    const departInfo = event.departed_at ? UI.formatTime(event.departed_at) + '出棟' : '';

    // 付き添いスタッフは実際に移動中(MOVING/PICKUP_REQUIRED)か、検査中等で病棟待機中かで表示を変える
    let escortInfo = '';
    if (event.escort_staff_id) {
      const staffName = UI.escapeHTML(AppState.getStaffById(event.escort_staff_id)?.name || '--');
      const isActive = CONFIG.ESCORT_ACTIVE_STATUSES.includes(status);
      escortInfo = isActive
        ? `<span class="priority-escort priority-escort--active"><i class="fas fa-walking"></i> 付き添い中: ${staffName}</span>`
        : `<span class="priority-escort priority-escort--standby"><i class="fas fa-user-nurse"></i> 担当: ${staffName}（病棟待機）</span>`;
    }

    return `
      <div class="priority-item priority-row ${itemClass}" data-bed-id="${bed ? bed.id : ''}">
        <span class="priority-bed-num">${bed ? UI.formatBedName(bed) : '?'}</span>
        ${UI.statusBadge(status)}
        ${patientHtml}
        <span class="priority-exam-info">${examInfo}${departInfo ? ' | ' + departInfo : ''}</span>
        ${timeHtml}
        ${escortInfo}
        ${icHtml}
      </div>
    `;
  },
};
