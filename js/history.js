/**
 * TransBoard - 履歴・監査ビュー
 */

const HistoryView = {
  _isInitialized: false,

  async render() {
    await this._loadData();
    this._renderEventList();
    this._renderStatusLogs();
    await this._renderCallHistory();

    if (!this._isInitialized) {
      this._bindEvents();
      this._isInitialized = true;
    }
  },

  async _loadData() {
    try {
      const [eventsRes, logsRes] = await Promise.all([
        API.getAllEventsForWard(AppState.currentWardId),
        API.getAllStatusLogs(),
      ]);
      AppState.allEvents = eventsRes.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      AppState.statusLogs = logsRes.slice(0, 150); // 最大150件保持
    } catch (e) {
      console.error('[History] データのロード失敗:', e);
    }
  },

  _bindEvents() {
    const searchInput = document.getElementById('history-search');
    const filterSelect = document.getElementById('history-status-filter');
    const exportBtn = document.getElementById('btn-export-logs-csv');

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this._renderEventList();
        this._renderStatusLogs();
      });
    }
    if (filterSelect) {
      filterSelect.addEventListener('change', () => {
        this._renderEventList();
        this._renderStatusLogs();
      });
    }
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        this.exportLogsToCSV();
      });
    }
  },

  _renderEventList() {
    const el = document.getElementById('event-list');
    if (!el) return;

    const query = document.getElementById('history-search')?.value.toLowerCase().trim() || '';
    const statusFilter = document.getElementById('history-status-filter')?.value || '';
    const nameChk = document.getElementById('chk-show-patient-names');
    const showNames = nameChk ? nameChk.checked : (localStorage.getItem('cfg_show_patient_names') === 'true');

    const filtered = AppState.allEvents.filter(e => {
      const bed = AppState.getBedById(e.bed_id);
      const examType = AppState.getExamTypeById(e.exam_type_id);
      const examRoom = AppState.getExamRoomById(e.exam_room_id);
      const staff = AppState.getStaffById(e.escort_staff_id);

      // ステータス絞り込み
      if (statusFilter && e.current_status !== statusFilter) return false;

      // キーワード検索
      if (query) {
        const bedNo = bed ? bed.bed_number.toLowerCase() : '';
        const patName = bed && bed.patient_name ? bed.patient_name.toLowerCase() : '';
        const patId = bed && bed.patient_id ? bed.patient_id.toLowerCase() : '';
        const examName = examType ? examType.name.toLowerCase() : '';
        const roomName = examRoom ? examRoom.name.toLowerCase() : '';
        const staffName = staff ? staff.name.toLowerCase() : '';
        const note = e.note ? e.note.toLowerCase() : '';

        return bedNo.includes(query) ||
               patName.includes(query) ||
               patId.includes(query) ||
               examName.includes(query) ||
               roomName.includes(query) ||
               staffName.includes(query) ||
               note.includes(query);
      }
      return true;
    });

    const events = filtered.slice(0, 50);
    if (events.length === 0) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>該当するイベントがありません</p></div>';
      return;
    }

    el.innerHTML = events.map(e => {
      const bed = AppState.getBedById(e.bed_id);
      const examType = AppState.getExamTypeById(e.exam_type_id);
      const examRoom = AppState.getExamRoomById(e.exam_room_id);
      const staff = AppState.getStaffById(e.escort_staff_id);
      
      const patientName = bed && bed.patient_name ? (showNames ? UI.escapeHTML(bed.patient_name) : '＊＊＊＊') : '空床';
      const patientLabel = bed && bed.patient_name ? `<span style="font-weight:700; color:#4b5563; margin-right:6px;">[${patientName}]</span>` : '';

      return `
        <div class="history-item" style="border-left: 4px solid var(--clr-${e.current_status.toLowerCase().replace(/_/g, '-') || 'primary-border'}); padding-left: 8px;">
          <div class="history-time">${UI.formatDateTime(e.created_at)}</div>
          <div class="history-main">
            ${bed ? UI.escapeHTML(bed.bed_number) + '号床' : '不明'} ${patientLabel} - ${examType ? UI.escapeHTML(examType.name) : '--'}
          </div>
          <div class="history-sub">
            ${examRoom ? UI.escapeHTML(examRoom.name) : '--'} | ${UI.statusBadge(e.current_status)}
            ${staff ? ' | 付き添い: ' + UI.escapeHTML(staff.name) : ''}
            ${e.returned_at ? ' | 帰棟: ' + UI.formatTime(e.returned_at) : ''}
            ${e.note ? ' | <span style="color:#718096; font-style:italic;">' + UI.escapeHTML(e.note) + '</span>' : ''}
          </div>
        </div>
      `;
    }).join('');
  },

  _renderStatusLogs() {
    const el = document.getElementById('status-log-list');
    if (!el) return;

    const query = document.getElementById('history-search')?.value.toLowerCase().trim() || '';
    const statusFilter = document.getElementById('history-status-filter')?.value || '';
    const nameChk = document.getElementById('chk-show-patient-names');
    const showNames = nameChk ? nameChk.checked : (localStorage.getItem('cfg_show_patient_names') === 'true');

    const filtered = AppState.statusLogs.filter(log => {
      const event = AppState.allEvents.find(e => e.id === log.transfer_event_id);
      const bed = event ? AppState.getBedById(event.bed_id) : null;
      const examType = event ? AppState.getExamTypeById(event.exam_type_id) : null;
      const examRoom = event ? AppState.getExamRoomById(event.exam_room_id) : null;

      // ステータス絞り込み
      if (statusFilter && log.to_status !== statusFilter) return false;

      // キーワード検索
      if (query) {
        const bedNo = bed ? bed.bed_number.toLowerCase() : '';
        const patName = bed && bed.patient_name ? bed.patient_name.toLowerCase() : '';
        const patId = bed && bed.patient_id ? bed.patient_id.toLowerCase() : '';
        const examName = examType ? examType.name.toLowerCase() : '';
        const roomName = examRoom ? examRoom.name.toLowerCase() : '';
        const changedBy = log.changed_by ? log.changed_by.toLowerCase() : '';

        return bedNo.includes(query) ||
               patName.includes(query) ||
               patId.includes(query) ||
               examName.includes(query) ||
               roomName.includes(query) ||
               changedBy.includes(query);
      }
      return true;
    });

    const logs = filtered.slice(0, 50);
    if (logs.length === 0) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-list"></i><p>該当する状態変更ログがありません</p></div>';
      return;
    }

    el.innerHTML = logs.map(log => {
      const event = AppState.allEvents.find(e => e.id === log.transfer_event_id);
      const bed = event ? AppState.getBedById(event.bed_id) : null;
      const patientName = bed && bed.patient_name ? (showNames ? UI.escapeHTML(bed.patient_name) : '＊＊＊＊') : '';
      const patientLabel = patientName ? `<span style="color:#718096; font-size:11px;">[${patientName}]</span>` : '';
      
      return `
        <div class="history-item">
          <div class="history-time">${UI.formatDateTime(log.changed_at)}</div>
          <div class="history-main" style="font-size:13px;">
            ${bed ? UI.escapeHTML(bed.bed_number) + '号床' : log.transfer_event_id?.slice(0,12) || '--'} ${patientLabel}
          </div>
          <div class="history-sub" style="margin-top:2px;">
            ${log.from_status ? UI.statusBadge(log.from_status) + ' <i class="fas fa-long-arrow-alt-right" style="margin:0 4px; color:#a0aec0;"></i> ' : ''}
            ${UI.statusBadge(log.to_status)}
            <span style="margin-left: 8px; color:#4a5568; font-size:11px; background:#edf2f7; padding:2px 6px; border-radius:4px;"><i class="fas fa-user-edit"></i> ${UI.escapeHTML(log.changed_by || '--')}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  async _renderCallHistory() {
    const el = document.getElementById('call-history-list');
    if (!el) return;

    try {
      const calls = await API.getCallHistory();
      if (calls.length === 0) {
        el.innerHTML = '<div class="empty-state"><i class="fas fa-phone-slash"></i><p>通話履歴がありません</p></div>';
        return;
      }

      const callerLabels = { ward: '病棟', exam_room: '検査室' };
      const statusLabels = { calling: '呼出中', connected: '接続', ended: '終話', missed: '不応答' };

      el.innerHTML = calls.map(c => {
        const duration = c.answered_at && c.ended_at ? UI.formatDuration(c.ended_at - c.answered_at) : '--';
        return `
          <div class="history-item">
            <div class="history-time">${UI.formatDateTime(c.started_at)}</div>
            <div class="history-main">
              <i class="fas fa-phone"></i>
              ${callerLabels[c.caller_type] || c.caller_type} → ${c.caller_type === 'ward' ? '検査室' : '病棟'}
            </div>
            <div class="history-sub">
              ${statusLabels[c.status] || c.status}
              ${c.status === 'ended' ? ' | 通話時間: ' + duration : ''}
            </div>
          </div>
        `;
      }).join('');
    } catch (e) {
      el.innerHTML = '<div class="empty-state"><p>読み込み失敗</p></div>';
    }
  },

  exportLogsToCSV() {
    try {
      const headers = ['日時', '病床', '患者名', '患者ID', '検査種別', '検査室', '付き添いスタッフ', '現在のステータス', '登録時間', '出発時間', '到着時間', '帰棟時間', '備考'];
      
      const nameChk = document.getElementById('chk-show-patient-names');
      const showNames = nameChk ? nameChk.checked : (localStorage.getItem('cfg_show_patient_names') === 'true');

      const rows = AppState.allEvents.map(e => {
        const bed = AppState.getBedById(e.bed_id);
        const examType = AppState.getExamTypeById(e.exam_type_id);
        const examRoom = AppState.getExamRoomById(e.exam_room_id);
        const staff = AppState.getStaffById(e.escort_staff_id);

        const dateStr = UI.formatDateTime(e.created_at);
        const bedNo = bed ? bed.bed_number : '不明';
        const patientName = bed && bed.patient_name ? (showNames ? bed.patient_name : '＊＊＊＊') : '空床';
        const patientId = bed && bed.patient_id ? (showNames ? bed.patient_id : '＊＊＊＊') : '';
        const examName = examType ? examType.name : '';
        const roomName = examRoom ? examRoom.name : '';
        const staffName = staff ? staff.name : 'なし';
        const statusLabel = CONFIG.STATUS_LABEL[e.current_status] || e.current_status;

        const createdTime = e.created_at ? UI.formatDateTime(e.created_at) : '';
        const departedTime = e.departed_at ? UI.formatDateTime(e.departed_at) : '';
        const arrivedTime = e.arrived_at ? UI.formatDateTime(e.arrived_at) : '';
        const returnedTime = e.returned_at ? UI.formatDateTime(e.returned_at) : '';
        const note = e.note || '';

        return [
          dateStr, bedNo, patientName, patientId, examName, roomName, staffName, statusLabel,
          createdTime, departedTime, arrivedTime, returnedTime, note
        ];
      });

      const csvContent = [headers, ...rows]
        .map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      const bom = new Uint8Array([0xEF, 0xBB, 0xBF]); // UTF-8 Excel BOM
      const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `transfer_history_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      UI.toast('履歴CSVをエクスポートしました', 'success');
    } catch (e) {
      console.error('[CSV Export Error]', e);
      UI.toast('CSVの出力に失敗しました', 'danger');
    }
  }
};
