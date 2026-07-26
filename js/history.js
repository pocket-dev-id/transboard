/**
 * TransBoard - 履歴・監査ビュー
 */

// CSVを表計算ソフトで開いた際、外部由来の値が数式として評価されないようにする。
// 引用符で囲むだけでは数式インジェクションを防げないため、危険な先頭文字には
// アポストロフィを付けて文字列として扱わせる。
function escapeCSVCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const HistoryView = {
  _isInitialized: false,

  async render() {
    await this._loadData();
    ExamStats.render();
    this._renderEventList();
    this._renderStatusLogs();
    await this._renderCallHistory();

    if (!this._isInitialized) {
      this._bindEvents();
      ExamStats.bindEvents();
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

      const statusLabels = { calling: '呼出中', connected: '接続', ended: '終話', missed: '不応答' };

      el.innerHTML = calls.map(c => {
        const duration = c.answered_at && c.ended_at ? UI.formatDuration(c.ended_at - c.answered_at) : '--';
        const fromId = c.from_id ?? (c.caller_type === 'ward' ? c.ward_id : c.exam_room_id);
        const toId = c.to_id ?? (c.caller_type === 'ward' ? c.exam_room_id : c.ward_id);
        const fromName = fromId ? CallPanel.getNameById(fromId) : '不明';
        const toName = toId ? CallPanel.getNameById(toId) : '不明';
        return `
          <div class="history-item">
            <div class="history-time">${UI.formatDateTime(c.started_at)}</div>
            <div class="history-main">
              <i class="fas fa-phone"></i>
              ${UI.escapeHTML(fromName)} → ${UI.escapeHTML(toName)}
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
        .map(r => r.map(escapeCSVCell).join(','))
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

// ─────────────────────────────────────────────────────────────
//  検査時間実績: 帰棟済みの移送イベントから実測時間を集計する
//  （追加のデータ記録は不要 — transfer_eventsの既存タイムスタンプから導出）
// ─────────────────────────────────────────────────────────────
const ExamStats = {
  // 異常値ガード: 負値と12時間超はサンプルから除外する
  MAX_METRIC_MIN: 12 * 60,
  // 標準時間への反映提案を出す条件: 実績平均との差が±5分以上かつサンプル3件以上
  SUGGEST_DIFF_MIN: 5,
  SUGGEST_MIN_SAMPLES: 3,

  // 1イベントから4指標を分単位で導出する。タイムスタンプが欠けている指標はnull
  // （遷移ボタン非表示でステータスをスキップする運用ではその指標のサンプルが減るだけ）
  computeMetrics(e) {
    const diffMin = (from, to) => {
      if (!from || !to) return null;
      const min = (to - from) / 60000;
      if (min < 0 || min > this.MAX_METRIC_MIN) return null;
      return min;
    };
    return {
      transit: diffMin(e.departed_at, e.arrived_at),        // 移動時間
      exam:    diffMin(e.exam_started_at, e.pickup_ready_at), // 検査所要時間
      pickup:  diffMin(e.pickup_ready_at, e.returned_at),   // 迎え待ち時間
      total:   diffMin(e.departed_at, e.returned_at),       // 総時間（病棟不在）
    };
  },

  // RETURNED＋期間でフィルタし、グループごとに各指標の平均・件数を算出する
  aggregate(events, { periodDays = 30, groupBy = 'examType' } = {}) {
    const cutoff = periodDays > 0 ? Date.now() - periodDays * 24 * 60 * 60 * 1000 : 0;
    const completed = (events || []).filter(e =>
      e.current_status === 'RETURNED' && e.returned_at && e.returned_at >= cutoff
    );

    const groups = new Map();
    for (const e of completed) {
      const key = groupBy === 'examRoom' ? (e.exam_room_id || '(不明)') : (e.exam_type_id || '(不明)');
      if (!groups.has(key)) {
        groups.set(key, { key, count: 0, sums: { transit: [0, 0], exam: [0, 0], pickup: [0, 0], total: [0, 0] } });
      }
      const g = groups.get(key);
      g.count++;
      const m = this.computeMetrics(e);
      for (const k of ['transit', 'exam', 'pickup', 'total']) {
        if (m[k] !== null) { g.sums[k][0] += m[k]; g.sums[k][1]++; }
      }
    }

    return [...groups.values()].map(g => {
      const avg = {};
      for (const k of ['transit', 'exam', 'pickup', 'total']) {
        avg[k] = g.sums[k][1] > 0 ? g.sums[k][0] / g.sums[k][1] : null;
      }
      return { key: g.key, count: g.count, avg, examSamples: g.sums.exam[1] };
    }).sort((a, b) => b.count - a.count);
  },

  _fmt(min) {
    return min === null ? '--' : `${Math.round(min)}分`;
  },

  render() {
    const container = document.getElementById('exam-stats-table');
    if (!container) return;

    const periodDays = parseInt(document.getElementById('exam-stats-period')?.value ?? '30', 10);
    const groupBy = document.getElementById('exam-stats-groupby')?.value || 'examType';
    const rows = this.aggregate(AppState.allEvents, { periodDays, groupBy });

    if (rows.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:16px;"><i class="fas fa-stopwatch"></i><p>対象期間に帰棟済みの移送がありません</p></div>';
      return;
    }

    const isExamType = groupBy === 'examType';
    const header = `
      <tr>
        <th>${isExamType ? '検査種別' : '検査室'}</th>
        <th>件数</th>
        <th>移動平均</th>
        <th>検査平均</th>
        ${isExamType ? '<th>標準時間</th><th>差（実績−標準）</th>' : ''}
        <th>迎え待ち平均</th>
        <th>総時間平均</th>
        ${isExamType ? '<th></th>' : ''}
      </tr>`;

    const body = rows.map(r => {
      let name = r.key;
      let standardCells = '';
      let actionCell = '';
      if (isExamType) {
        const type = AppState.allExamTypes?.find(t => t.id === r.key) || AppState.examTypes?.find(t => t.id === r.key);
        name = type ? type.name : r.key;
        const std = type ? type.standard_duration_min : null;
        if (std != null && r.avg.exam !== null) {
          // 色判定と表示のズレを避けるため、丸めた値で統一する
          const diff = Math.round(r.avg.exam - std);
          const diffCls = diff >= 1 ? 'exam-stats-over' : (diff <= -1 ? 'exam-stats-under' : '');
          standardCells = `<td>${std}分</td><td class="${diffCls}">${diff >= 0 ? '+' : ''}${diff}分</td>`;
          // 反映提案: 乖離が大きくサンプルが十分、かつ丸め後の平均が有効値(1分以上)の場合のみ
          if (Math.abs(diff) >= this.SUGGEST_DIFF_MIN && r.examSamples >= this.SUGGEST_MIN_SAMPLES && Math.round(r.avg.exam) >= 1) {
            actionCell = `<td><button class="btn btn-outline btn-sm btn-apply-standard" data-type-id="${UI.escapeHTML(r.key)}" data-avg="${Math.round(r.avg.exam)}" data-samples="${r.examSamples}" title="検査種別マスタの標準時間を実績平均に更新します" style="padding:2px 8px; font-size:11px; white-space:nowrap;"><i class="fas fa-sync-alt"></i> 実績平均に更新</button></td>`;
          } else {
            actionCell = '<td></td>';
          }
        } else {
          standardCells = '<td>--</td><td>--</td>';
          actionCell = '<td></td>';
        }
      } else {
        const room = AppState.allExamRooms?.find(x => x.id === r.key) || AppState.examRooms?.find(x => x.id === r.key);
        name = room ? room.name : r.key;
      }
      return `
        <tr>
          <td class="font-bold">${UI.escapeHTML(String(name))}</td>
          <td>${r.count}件</td>
          <td>${this._fmt(r.avg.transit)}</td>
          <td>${this._fmt(r.avg.exam)}</td>
          ${standardCells}
          <td>${this._fmt(r.avg.pickup)}</td>
          <td>${this._fmt(r.avg.total)}</td>
          ${actionCell}
        </tr>`;
    }).join('');

    container.innerHTML = `<div style="overflow-x:auto;"><table class="settings-table exam-stats-table"><thead>${header}</thead><tbody>${body}</tbody></table></div>`;

    // 標準時間への反映ボタン
    container.querySelectorAll('.btn-apply-standard').forEach(btn => {
      btn.addEventListener('click', () => {
        const apply = () => this._applyStandardDuration(btn.dataset.typeId, parseInt(btn.dataset.avg, 10), parseInt(btn.dataset.samples, 10) || 0);
        if (window.isAdminSession) apply();
        else PasscodeModal.open(() => { apply(); });
      });
    });
  },

  async _applyStandardDuration(typeId, avgMin, samples = 0) {
    const type = AppState.allExamTypes?.find(t => t.id === typeId) || AppState.examTypes?.find(t => t.id === typeId);
    if (!type || !Number.isFinite(avgMin) || avgMin <= 0) return;
    // 標準時間は全病棟共通のため、根拠となった実績のスコープ(病棟・件数)を明示して判断材料にする
    const ward = AppState.wards.find(w => w.id === AppState.currentWardId);
    const basis = `${ward ? ward.name : '現在の病棟'}の実績${samples > 0 ? `${samples}件` : ''}の平均`;
    const ok = await UI.confirmModal(
      `${type.name} の標準時間を ${type.standard_duration_min}分 → ${avgMin}分（${basis}）に更新しますか？`,
      { title: '標準時間の更新（全病棟共通）', detail: '今後の出棟登録の所要時間の自動入力と検査室画面の超過警告に、全病棟で反映されます。', confirmLabel: '更新する' }
    );
    if (!ok) return;
    try {
      await API.patch('exam_types', typeId, { standard_duration_min: avgMin });
      await App.loadMasters();
      this.render();
      UI.toast(`${type.name} の標準時間を ${avgMin}分に更新しました`, 'success');
    } catch (e) {
      console.error('[ExamStats] 標準時間の更新失敗:', e);
      UI.toast('標準時間の更新に失敗しました: ' + e.message, 'danger');
    }
  },

  bindEvents() {
    document.getElementById('exam-stats-period')?.addEventListener('change', () => this.render());
    document.getElementById('exam-stats-groupby')?.addEventListener('change', () => this.render());
    document.getElementById('btn-exam-stats-csv')?.addEventListener('click', () => this.exportDetailCSV());
  },

  // 明細CSV: 1行=1完了イベント。Excelでピボット分析できる粒度で出力する
  exportDetailCSV() {
    try {
      const periodDays = parseInt(document.getElementById('exam-stats-period')?.value ?? '30', 10);
      const cutoff = periodDays > 0 ? Date.now() - periodDays * 24 * 60 * 60 * 1000 : 0;
      const completed = (AppState.allEvents || []).filter(e =>
        e.current_status === 'RETURNED' && e.returned_at && e.returned_at >= cutoff
      );
      if (completed.length === 0) {
        UI.toast('対象期間に帰棟済みの移送がありません', 'warning');
        return;
      }

      const fmtTime = ms => ms ? UI.formatDateTime(ms) : '';
      const fmtMin = min => min === null ? '' : Math.round(min);
      const headers = ['日付', '病床', '検査種別', '検査室', '出棟', '到着', '検査開始', '迎え要', '帰棟',
        '移動(分)', '検査(分)', '迎え待ち(分)', '総時間(分)', '予定(分)', '予実差(分)'];
      const rows = completed.map(e => {
        const bed = AppState.getBedById(e.bed_id);
        const type = AppState.getExamTypeById(e.exam_type_id);
        const room = AppState.getExamRoomById(e.exam_room_id);
        const m = this.computeMetrics(e);
        // 文字列で保存されているケースを考慮し数値化してから予定/予実差の両方に使う
        const plannedNum = Number(e.expected_duration_min);
        const planned = Number.isFinite(plannedNum) ? plannedNum : '';
        const planDiff = (m.exam !== null && Number.isFinite(plannedNum))
          ? Math.round(m.exam - plannedNum) : '';
        return [
          e.returned_at ? new Date(e.returned_at).toLocaleDateString('ja-JP') : '',
          bed ? bed.bed_number : '',
          type ? type.name : '',
          room ? room.name : '',
          fmtTime(e.departed_at), fmtTime(e.arrived_at), fmtTime(e.exam_started_at),
          fmtTime(e.pickup_ready_at), fmtTime(e.returned_at),
          fmtMin(m.transit), fmtMin(m.exam), fmtMin(m.pickup), fmtMin(m.total),
          planned, planDiff,
        ];
      });

      const csvContent = [headers, ...rows]
        .map(r => r.map(escapeCSVCell).join(','))
        .join('\n');
      const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
      const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      // ファイル名はローカル日付で生成する（toISOStringはUTCのため深夜に前日名になる）
      const d = new Date();
      const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      link.setAttribute('download', `exam_time_stats_${localDate}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      UI.toast('検査時間実績の明細CSVをエクスポートしました', 'success');
    } catch (e) {
      console.error('[ExamStats CSV Error]', e);
      UI.toast('CSVの出力に失敗しました', 'danger');
    }
  },
};
