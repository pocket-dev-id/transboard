/**
 * TransBoard - 日跨ぎ未完了出棟の一括確認ダイアログ
 * 帰棟し忘れ等で日付をまたいで残ったアクティブ移送を一覧し、
 * 行ごとに「帰棟完了 / キャンセル / 継続」を選んで整理する。
 * UI.confirmModal と同じ動的オーバーレイ方式（index.htmlへのコンテナ追加不要）。
 */

const CarryoverModal = {

  _overlay: null,

  open(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    // 二重表示防止（すでに開いていれば作り直す）
    this.close();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay carryover-overlay';
    overlay.innerHTML = `
      <div class="modal carryover-modal" role="dialog" aria-modal="true">
        <div class="modal-header carryover-header">
          <h2><i class="fas fa-exclamation-triangle"></i> 前日から未完了の出棟</h2>
          <button class="modal-close-btn" id="carryover-close" aria-label="閉じる"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body carryover-body">
          <p class="carryover-lead">帰棟／キャンセルの記録が漏れている可能性があります。各患者の状況を確認して整理してください。<br>（自動では消えません。まだ検査中の場合は「継続」を選んでください）</p>
          <div id="carryover-list" class="carryover-list"></div>
        </div>
        <div class="modal-footer carryover-footer">
          <span id="carryover-count" class="carryover-count"></span>
          <button class="btn btn-outline btn-sm" id="carryover-done">閉じる</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this._overlay = overlay;

    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });
    overlay.querySelector('#carryover-close').addEventListener('click', () => this.close());
    overlay.querySelector('#carryover-done').addEventListener('click', () => this.close());

    this._renderList(list.slice());
  },

  _renderList(items) {
    const listEl = this._overlay?.querySelector('#carryover-list');
    const countEl = this._overlay?.querySelector('#carryover-count');
    if (!listEl) return;

    if (items.length === 0) {
      // すべて片付いたら閉じる
      this.close();
      return;
    }
    if (countEl) countEl.textContent = `残り ${items.length} 件`;

    listEl.innerHTML = items.map(e => {
      const bed = AppState.getBedById(e.bed_id);
      const examType = AppState.getExamTypeById(e.exam_type_id);
      const examRoom = AppState.getExamRoomById(e.exam_room_id);
      const patientRaw = e.patient_name ?? bed?.patient_name ?? null;
      const patient = patientRaw ? UI.getPatientName(patientRaw) : '';
      const refTime = e.departed_at || e.created_at || null;
      const examInfo = `${examType ? UI.escapeHTML(examType.name) : '--'}${examRoom ? ' / ' + UI.escapeHTML(examRoom.name) : ''}`;
      return `
        <div class="carryover-row" data-event-id="${UI.escapeHTML(e.id)}">
          <div class="carryover-row-main">
            <span class="carryover-bed">${bed ? UI.formatBedName(bed) : '?'}</span>
            ${UI.statusBadge(e.current_status)}
            ${patient ? `<span class="carryover-patient">${UI.escapeHTML(patient)}</span>` : ''}
            <span class="carryover-exam">${examInfo}</span>
            <span class="carryover-time"><i class="fas fa-clock"></i> ${UI.formatDateTime(refTime)} 出棟</span>
          </div>
          <div class="carryover-row-actions">
            <button class="btn btn-success btn-sm" data-carryover-action="RETURNED" data-event-id="${UI.escapeHTML(e.id)}">帰棟完了</button>
            <button class="btn btn-secondary btn-sm" data-carryover-action="CANCELLED" data-event-id="${UI.escapeHTML(e.id)}">キャンセル</button>
            <button class="btn btn-outline btn-sm" data-carryover-action="KEEP" data-event-id="${UI.escapeHTML(e.id)}">継続</button>
          </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('[data-carryover-action]').forEach(btn => {
      btn.addEventListener('click', () => this._handleAction(btn, items));
    });
  },

  async _handleAction(btn, items) {
    const eventId = btn.dataset.eventId;
    const action = btn.dataset.carryoverAction;
    const remaining = () => items.filter(x => x.id !== eventId);

    // 「継続」はステータスを変えず一覧から外すだけ（アクティブのまま／当日は再通知しない）
    if (action === 'KEEP') {
      this._renderList(remaining());
      return;
    }

    // 帰棟/キャンセルは行全体を一時的に無効化して二重実行を防ぐ
    const row = btn.closest('.carryover-row');
    if (row) row.querySelectorAll('button').forEach(b => (b.disabled = true));
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    try {
      const target = items.find(x => x.id === eventId);
      // 帰棟完了も通常の遷移ルールを必ず通す。進行中状態からの強制帰棟は許可しない。
      if (action === 'RETURNED') {
        await API.updateEventStatus(eventId, 'RETURNED', {}, CONFIG.STATUS_SCOPE.WARD, target?.current_status || null);
      } else {
        // CANCELLEDはどの状態からも遷移可能なため、expectedStatusを省略すると
        // 他端末が既に進めていたイベントも検知されずキャンセルされてしまう。
        // RETURNED分岐と同じくexpectedStatusを渡して衝突検知させる
        await API.updateEventStatus(eventId, action, {}, CONFIG.STATUS_SCOPE.WARD, target?.current_status || null);
      }
      UI.toast(action === 'RETURNED' ? '帰棟完了にしました' : '移送をキャンセルしました', 'success');
      // 盤面へ反映
      await App.refreshData();
      const currentPage = document.querySelector('.tab-btn.active')?.dataset.page;
      if (currentPage === 'ward-dashboard') WardDashboard.render();
      else if (currentPage === 'exam-room') ExamRoom._renderQueue();
      else if (currentPage === 'timeline') Timeline.render();
      this._renderList(remaining());
    } catch (err) {
      console.error('[Carryover]', err);
      UI.toast('更新に失敗しました: ' + err.message, 'danger');
      if (row) row.querySelectorAll('button').forEach(b => (b.disabled = false));
      btn.innerHTML = action === 'RETURNED' ? '帰棟完了' : 'キャンセル';
    }
  },

  close() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
  },
};
