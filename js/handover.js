/**
 * TransBoard - 申し送りメモ板（シフト引き継ぎ）
 * 病棟単位で共有する常設メモ。親機に保存し全端末で同期する。
 * データは handover_notes テーブル（患者データ扱い＝外部アクセスはAPIトークン必須）。
 */

const Handover = {
  _showResolved: false,
  _editingId: null,   // 編集中のメモID（新規追加時は null）
  _bound: false,

  // 親機/子機ともに API 経由で現在病棟の申し送りを取得する
  async load() {
    try {
      AppState.handoverNotes = await API.getHandoverNotes(AppState.currentWardId);
    } catch (e) {
      console.warn('[Handover] 読み込み失敗', e);
    }
  },

  render() {
    const listEl = document.getElementById('handover-list');
    if (!listEl) return;

    this.bindEvents();

    const notes = (AppState.handoverNotes || []).filter(n => n.ward_id === AppState.currentWardId);
    const open = notes.filter(n => !n.is_resolved);
    const resolved = notes.filter(n => n.is_resolved);

    // 未対応件数バッジ
    const countEl = document.getElementById('handover-open-count');
    if (countEl) {
      countEl.textContent = open.length ? String(open.length) : '';
      countEl.style.display = open.length ? '' : 'none';
    }

    const shown = open.concat(this._showResolved ? resolved : []);
    if (shown.length === 0) {
      listEl.innerHTML = '<div class="text-muted text-sm" style="padding:6px 2px;">申し送りはありません</div>';
    } else {
      listEl.innerHTML = shown.map(n => this._renderCard(n)).join('');
    }

    // 対応済み表示トグル
    const rt = document.getElementById('handover-resolved-toggle');
    if (rt) {
      rt.style.display = resolved.length ? '' : 'none';
      rt.textContent = this._showResolved ? '対応済みを隠す' : `対応済みを表示（${resolved.length}）`;
    }

    // 担当者候補（スタッフマスタ）
    const dl = document.getElementById('handover-author-list');
    if (dl) {
      const staffs = (AppState.staffs || []).filter(s => s.is_active && s.ward_id === AppState.currentWardId);
      dl.innerHTML = staffs.map(s => `<option value="${UI.escapeHTML(s.name)}">`).join('');
    }
  },

  _renderCard(n) {
    const classes = ['handover-note'];
    if (n.is_resolved) classes.push('resolved');
    else if (n.is_important) classes.push('important');
    const time = n.created_at ? UI.formatTime(n.created_at) : '';
    const author = n.author ? UI.escapeHTML(n.author) : '—';
    const imp = (n.is_important && !n.is_resolved) ? '<i class="fas fa-exclamation-circle handover-imp-icon" title="重要"></i> ' : '';
    const bodyHtml = UI.escapeHTML(n.body || '').replace(/\n/g, '<br>');
    return `
      <div class="${classes.join(' ')}" data-id="${UI.escapeHTML(n.id)}">
        <div class="handover-note-body">${imp}${bodyHtml}</div>
        <div class="handover-note-meta">
          <span class="handover-note-by">${author}・${time}</span>
          <span class="handover-note-actions">
            <button class="handover-act" data-act="resolve" title="${n.is_resolved ? '未対応に戻す' : '対応済みにする'}"><i class="fas ${n.is_resolved ? 'fa-rotate-left' : 'fa-check'}"></i></button>
            <button class="handover-act" data-act="edit" title="編集"><i class="fas fa-pen"></i></button>
            <button class="handover-act" data-act="delete" title="削除"><i class="fas fa-trash"></i></button>
          </span>
        </div>
      </div>`;
  },

  // イベントは一度だけ束ねる（renderのたびに多重登録しない）
  bindEvents() {
    if (this._bound) return;
    this._bound = true;

    const addBtn = document.getElementById('btn-handover-add');
    if (addBtn) addBtn.addEventListener('click', () => this._openEditor(null));

    const cancelBtn = document.getElementById('btn-handover-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this._closeEditor());

    const saveBtn = document.getElementById('btn-handover-save');
    if (saveBtn) saveBtn.addEventListener('click', () => this._save());

    const rt = document.getElementById('handover-resolved-toggle');
    if (rt) rt.addEventListener('click', () => { this._showResolved = !this._showResolved; this.render(); });

    // カード内アクションは委譲で処理
    const listEl = document.getElementById('handover-list');
    if (listEl) {
      listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.handover-act');
        if (!btn) return;
        const card = btn.closest('.handover-note');
        if (!card) return;
        const id = card.dataset.id;
        const act = btn.dataset.act;
        if (act === 'resolve') this._toggleResolve(id);
        else if (act === 'edit') this._openEditor(id);
        else if (act === 'delete') this._remove(id);
      });
    }
  },

  _openEditor(id) {
    this._editingId = id;
    const editor = document.getElementById('handover-editor');
    const input = document.getElementById('handover-input');
    const author = document.getElementById('handover-author');
    const imp = document.getElementById('handover-important');
    if (!editor || !input) return;

    if (id) {
      const n = (AppState.handoverNotes || []).find(x => x.id === id);
      if (n) {
        input.value = n.body || '';
        if (author) author.value = n.author || '';
        if (imp) imp.checked = !!n.is_important;
      }
    } else {
      input.value = '';
      if (author) author.value = '';
      if (imp) imp.checked = false;
    }
    editor.style.display = '';
    input.focus();
  },

  _closeEditor() {
    this._editingId = null;
    const editor = document.getElementById('handover-editor');
    if (editor) editor.style.display = 'none';
  },

  async _save() {
    const input = document.getElementById('handover-input');
    const authorEl = document.getElementById('handover-author');
    const impEl = document.getElementById('handover-important');
    const body = (input?.value || '').trim();
    if (!body) {
      UI.toast('申し送り内容を入力してください', 'warning');
      return;
    }
    const author = (authorEl?.value || '').trim();
    const is_important = !!(impEl && impEl.checked);
    const now = Date.now();

    try {
      if (this._editingId) {
        await API.update('handover_notes', this._editingId, { body, author, is_important, updated_at: now });
        UI.toast('申し送りを更新しました', 'success');
      } else {
        const id = `hn-${now}-${Math.random().toString(36).slice(2, 7)}`;
        await API.create('handover_notes', {
          id,
          ward_id: AppState.currentWardId,
          body,
          author,
          is_important,
          is_resolved: false,
          created_at: now,
          updated_at: now,
        });
        UI.toast('申し送りを追加しました', 'success');
      }
      this._closeEditor();
      await this.load();
      this.render();
    } catch (e) {
      console.error('[Handover] 保存失敗', e);
      UI.toast('申し送りの保存に失敗しました', 'danger');
    }
  },

  async _toggleResolve(id) {
    const n = (AppState.handoverNotes || []).find(x => x.id === id);
    if (!n) return;
    try {
      await API.update('handover_notes', id, { is_resolved: !n.is_resolved, updated_at: Date.now() });
      await this.load();
      this.render();
    } catch (e) {
      console.error('[Handover] 状態更新失敗', e);
      UI.toast('状態の更新に失敗しました', 'danger');
    }
  },

  async _remove(id) {
    const ok = await UI.confirmModal('この申し送りを削除しますか？', {
      title: '申し送りの削除',
      type: 'danger',
      confirmLabel: '削除する',
    });
    if (!ok) return;
    try {
      await API.delete('handover_notes', id);
      UI.toast('申し送りを削除しました', 'success');
      await this.load();
      this.render();
    } catch (e) {
      console.error('[Handover] 削除失敗', e);
      UI.toast('削除に失敗しました', 'danger');
    }
  },
};
