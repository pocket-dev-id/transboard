/**
 * TransBoard - 設定画面: マスタ管理（病床・病床タイプ・マップ配置・検査室・スタッフ・病棟・検査種別）
 */

Object.assign(Settings, {

  // ──────────────────────────────────
  //  病床マスタ管理
  // ──────────────────────────────────

  /* removed bed type management */
  /*
    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-tags"></i> 病床タイプマスタ</h3>
          <div style="display:flex; gap:8px; align-items:center;">
            <label style="display:flex; align-items:center; gap:5px; font-size:12px; color:var(--clr-text-muted); cursor:pointer; user-select:none;">
              <input type="checkbox" id="chk-show-inactive-bed-types" style="cursor:pointer;">
              無効を表示
            </label>
            <button class="btn btn-outline btn-sm" id="btn-export-bed_types"><i class="fas fa-file-download"></i> CSV出力</button>
            <button class="btn btn-outline btn-sm" id="btn-import-bed_types"><i class="fas fa-file-upload"></i> CSV入力</button>
            <button class="btn btn-primary btn-sm" id="btn-add-bed-type"><i class="fas fa-plus"></i> タイプ追加</button>
          </div>
        </div>
        <p class="settings-hint"><i class="fas fa-info-circle"></i> 病床に割り当てるタイプを管理します。ここで追加したタイプは病床マスタで選択できます。</p>
        <table class="settings-table">
          <thead><tr><th>表示名</th><th>コード</th><th>並び順</th><th>状態</th><th>操作</th></tr></thead>
          <tbody id="bed-types-tbody"></tbody>
        </table>
      </div>
    `;

    const _renderBedTypesTable = (showInactive) => {
      const all = AppState.allBedTypes || AppState.bedTypes;
      const rows = showInactive ? all : all.filter(t => t.is_active !== false);
      const inactiveCount = all.filter(t => t.is_active === false).length;
      const tbody = document.getElementById('bed-types-tbody');
      if (!tbody) return;
      tbody.innerHTML = rows.map(type => `
        <tr class="${type.is_active === false ? 'row--inactive' : ''}">
          <td class="font-bold">${UI.escapeHTML(type.name)}</td>
          <td><code>${UI.escapeHTML(type.code)}</code></td>
          <td>${UI.escapeHTML(type.sort_order ?? '-')}</td>
          <td>${type.is_active === false ? '<span style="color:#64748b; font-weight:700;">無効</span>' : '<span style="color:#16a34a; font-weight:700;">有効</span>'}</td>
          <td>
            <button class="btn btn-outline btn-sm btn-edit-bed-type" data-type-id="${UI.escapeHTML(type.id)}"><i class="fas fa-edit"></i></button>
            <button class="btn btn-outline btn-sm btn-toggle-bed-type" data-type-id="${UI.escapeHTML(type.id)}" style="margin-left:4px;">${type.is_active === false ? '有効化' : '無効化'}</button>
          </td>
        </tr>
      `).join('') || '<tr><td colspan="5" class="text-muted">病床タイプが登録されていません</td></tr>';

      const chk = document.getElementById('chk-show-inactive-bed-types');
      if (chk) chk.title = inactiveCount > 0 ? `無効の病床タイプが ${inactiveCount} 件あります` : '無効の病床タイプはありません';

      tbody.querySelectorAll('.btn-edit-bed-type').forEach(btn => {
        btn.onclick = () => {
          const type = (AppState.allBedTypes || AppState.bedTypes).find(t => t.id === btn.dataset.typeId);
          this._openBedTypeForm(type);
        };
      });
      tbody.querySelectorAll('.btn-toggle-bed-type').forEach(btn => {
        btn.onclick = () => this._toggleBedType(btn.dataset.typeId);
      });
    };

    _renderBedTypesTable(false);

    document.getElementById('chk-show-inactive-bed-types').onchange = (e) => _renderBedTypesTable(e.target.checked);
    document.getElementById('btn-add-bed-type').onclick = () => this._openBedTypeForm(null);
    this._setupCsvHandlers('bed_types', 'bed_types', ['id', 'code', 'name', 'sort_order', 'is_active']);
  },

  _openBedTypeForm(type) {
    const isNew = !type;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px;">
        <div class="modal-header">
          <h2>${isNew ? '病床タイプを追加' : '病床タイプを編集'}</h2>
          <button class="modal-close-btn" id="bt-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div class="form-row"><label>表示名 <span style="color:#dc2626">*</span></label><input type="text" id="bt-name" value="${UI.escapeHTML(type?.name || '')}" placeholder="例: 一般"></div>
          <div class="form-row"><label>コード <span style="color:#dc2626">*</span></label><input type="text" id="bt-code" value="${UI.escapeHTML(type?.code || '')}" placeholder="例: normal" ${isNew ? '' : 'disabled'}></div>
          <div class="form-row"><label>並び順</label><input type="number" id="bt-sort" value="${UI.escapeHTML(type?.sort_order ?? 99)}" placeholder="例: 1"></div>
          <div class="form-row">
            <label>状態</label>
            <select id="bt-active">
              <option value="true" ${type?.is_active !== false ? 'selected' : ''}>有効</option>
              <option value="false" ${type?.is_active === false ? 'selected' : ''}>無効</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="bt-save"><i class="fas fa-save"></i> ${isNew ? '追加' : '保存'}</button>
          <button class="btn btn-outline" id="bt-cancel">キャンセル</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById('bt-close').onclick = close;
    document.getElementById('bt-cancel').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    this._addEscapeClose(overlay, close);
    setTimeout(() => document.getElementById('bt-name')?.focus(), 50);

    document.getElementById('bt-save').onclick = async () => {
      const name = document.getElementById('bt-name').value.trim();
      const code = document.getElementById('bt-code').value.trim();
      const sortOrder = parseInt(document.getElementById('bt-sort').value, 10);
      const isActive = document.getElementById('bt-active').value === 'true';
      if (!name || !code) { UI.toast('表示名とコードを入力してください', 'warning'); return; }

      const data = { name, code, sort_order: Number.isFinite(sortOrder) ? sortOrder : 99, is_active: isActive };
      try {
        if (isNew) {
          const id = `bed-type-${code.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${Date.now()}`;
          await API.create('bed_types', { id, ...data });
          UI.toast(`${name}を追加しました`, 'success');
        } else {
          await API.patch('bed_types', type.id, data);
          UI.toast(`${name}を更新しました`, 'success');
        }
        close();
        await App.loadMasters();
        this._renderBedTypes(document.getElementById('settings-tab-body'));
      } catch (e) {
        UI.toast('保存に失敗しました: ' + e.message, 'danger');
      }
    };
  },

  async _toggleBedType(typeId) {
    const type = (AppState.allBedTypes || AppState.bedTypes || []).find(t => t.id === typeId);
    if (!type) return;
    try {
      await API.patch('bed_types', type.id, { is_active: type.is_active === false });
      await App.loadMasters();
      this._renderBedTypes(document.getElementById('settings-tab-body'));
    } catch (e) {
      UI.toast('状態の変更に失敗しました: ' + e.message, 'danger');
    }
  }, */

  _renderBeds(body) {
    const wardId = AppState.currentWardId;
    const beds = AppState.beds.filter(b => b.ward_id === wardId)
                  .sort((a, b) => (a.sort_order||99) - (b.sort_order||99));
    const wardName = AppState.wards.find(w => w.id === wardId)?.name || '';

    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-bed"></i> 病床マスタ — ${UI.escapeHTML(wardName)}</h3>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-danger btn-sm" id="btn-delete-all-beds" title="この病棟の病床をすべて削除します">
              <i class="fas fa-trash-alt"></i> 全削除
            </button>
            <button class="btn btn-outline btn-sm" id="btn-export-beds" title="病床マスタをCSVファイルに出力します">
              <i class="fas fa-file-download"></i> CSV出力
            </button>
            <button class="btn btn-outline btn-sm" id="btn-import-beds" title="CSVファイルから病床マスタを取り込みます">
              <i class="fas fa-file-upload"></i> CSV入力
            </button>
            <button class="btn btn-primary btn-sm" id="btn-add-bed">
              <i class="fas fa-plus"></i> 病床追加
            </button>
          </div>
        </div>
        <p class="settings-hint">
          <i class="fas fa-info-circle"></i>
          病床番号・部屋番号を管理します。マップ上の配置は「マップ配置」タブで設定してください。
        </p>
        <table class="settings-table">
          <thead>
            <tr>
              <th>病室コード</th>
              <th>病床コード</th>
              <th>病床番号(結合)</th>
              <th>備考</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="bed-table-body">
            ${beds.map(b => this._bedRow(b)).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('btn-add-bed').onclick = () => this._openBedForm(null);

    document.getElementById('btn-delete-all-beds').onclick = async () => {
      const targetBeds = AppState.beds.filter(b => b.ward_id === wardId);
      if (targetBeds.length === 0) { UI.toast('削除する病床がありません', 'info'); return; }
      const occupiedCount = targetBeds.filter(b => b.patient_name || b.patient_id).length;
      const ok = await UI.confirmModal(`「${wardName}」の病床 ${targetBeds.length} 件をすべて削除します。`, {
        title: '病床を全削除',
        detail: (occupiedCount > 0 ? `うち ${occupiedCount} 件は患者が在室中です（在室記録は退院扱いで閉じられます）。` : '')
          + 'マップ配置情報も失われます。この操作は元に戻せません。',
        danger: true,
        confirmLabel: `全削除（${targetBeds.length}件）`,
      });
      if (!ok) return;
      const btn = document.getElementById('btn-delete-all-beds');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 削除中...'; }
      try {
        await Promise.all(targetBeds.map(b => API.remove('beds', b.id)));
        await App.loadMasters();
        this._renderBeds(document.getElementById('settings-tab-body'));
        UI.toast(`病床 ${targetBeds.length} 件を削除しました`, 'success');
      } catch (e) {
        console.error(e);
        UI.toast('削除に失敗しました: ' + e.message, 'danger');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-trash-alt"></i> 全削除'; }
      }
    };

    body.querySelectorAll('.btn-edit-bed').forEach(btn => {
      btn.onclick = () => {
        const bed = AppState.beds.find(b => b.id === btn.dataset.bedId);
        this._openBedForm(bed);
      };
    });
    body.querySelectorAll('.btn-delete-bed').forEach(btn => {
      btn.onclick = () => this._deleteBed(btn.dataset.bedId);
    });

    this._setupCsvHandlers('beds', 'beds', ['id', 'ward_id', 'bed_number', 'room_number', 'room_code', 'bed_code', 'note', 'map_col', 'map_row', 'sort_order']);
  },

  _bedRow(b) {
    let joinChar = '-';
    const mappingSetting = AppState.systemSettings?.find(s => s.id === 'import_mapping');
    if (mappingSetting && mappingSetting.value) {
      try {
        const mapping = JSON.parse(mappingSetting.value);
        if (mapping.join_char !== undefined) {
          joinChar = mapping.join_char;
        }
      } catch (e) {}
    }

    let rCode = b.room_code || '';
    let bCode = b.bed_code || '';
    if (!rCode && !bCode && b.bed_number) {
      const parts = b.bed_number.split(joinChar);
      if (parts.length > 1) {
        rCode = parts[0];
        bCode = parts.slice(1).join(joinChar);
      } else {
        rCode = b.bed_number;
        bCode = '';
      }
    }

    return `
      <tr>
        <td class="font-bold">${UI.escapeHTML(rCode || '-')}</td>
        <td class="font-bold">${UI.escapeHTML(bCode || '-')}</td>
        <td style="color:#718096; font-size:11px;">${UI.escapeHTML(b.bed_number)}</td>
        <td>${UI.escapeHTML(b.note || '-')}</td>
        <td>
          <button class="btn btn-outline btn-sm btn-edit-bed" data-bed-id="${UI.escapeHTML(b.id)}">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-danger btn-sm btn-delete-bed" data-bed-id="${UI.escapeHTML(b.id)}" style="margin-left:4px;">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>`;
  },

  _openBedForm(bed) {
    const wardId = AppState.currentWardId;
    const isNew = !bed;

    let joinChar = '-';
    const mappingSetting = AppState.systemSettings?.find(s => s.id === 'import_mapping');
    if (mappingSetting && mappingSetting.value) {
      try {
        const mapping = JSON.parse(mappingSetting.value);
        if (mapping.join_char !== undefined) {
          joinChar = mapping.join_char;
        }
      } catch (e) {}
    }

    let roomCode = bed?.room_code || '';
    let bedCode = bed?.bed_code || '';
    if (!roomCode && !bedCode && bed?.bed_number) {
      const parts = bed.bed_number.split(joinChar);
      if (parts.length > 1) {
        roomCode = parts[0];
        bedCode = parts.slice(1).join(joinChar);
      } else {
        roomCode = bed.bed_number;
        bedCode = '';
      }
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px;">
        <div class="modal-header">
          <h2>${isNew ? '病床を追加' : '病床を編集'}</h2>
          <button class="modal-close-btn" id="bed-form-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>病室コード <span style="color:#dc2626">*</span></label>
            <input type="text" id="bf-room-code" value="${UI.escapeHTML(roomCode)}" placeholder="例: 701">
          </div>
          <div class="form-row">
            <label>病床コード</label>
            <input type="text" id="bf-bed-code" value="${UI.escapeHTML(bedCode)}" placeholder="例: 1 (空欄可)">
          </div>
          <div class="form-row">
            <label>備考</label>
            <input type="text" id="bf-note" value="${UI.escapeHTML(bed?.note || '')}" placeholder="メモ">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="bf-save">
            <i class="fas fa-save"></i> ${isNew ? '追加' : '保存'}
          </button>
          <button class="btn btn-outline" id="bf-cancel">キャンセル</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById('bed-form-close').onclick = close;
    document.getElementById('bf-cancel').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    this._addEscapeClose(overlay, close);

    // Focus the first input field to prevent focus-stealing or uneditable state in Electron/Windows
    setTimeout(() => {
      document.getElementById('bf-room-code')?.focus();
    }, 50);

    document.getElementById('bf-save').onclick = async () => {
      const roomVal = document.getElementById('bf-room-code').value.trim();
      const bedVal = document.getElementById('bf-bed-code').value.trim();
      if (!roomVal && !bedVal) { UI.toast('病室コードまたは病床コードの入力が必要です', 'warning'); return; }

      let bedNumber = '';
      if (roomVal && bedVal) {
        bedNumber = `${roomVal}${joinChar}${bedVal}`;
      } else {
        bedNumber = roomVal || bedVal;
      }

      const data = {
        ward_id: wardId,
        bed_number: bedNumber,
        room_number: roomVal,
        room_code: roomVal,
        bed_code: bedVal,
        note: document.getElementById('bf-note').value.trim(),
        map_col: bed?.map_col ?? null,
        map_row: bed?.map_row ?? null,
        sort_order: bed?.sort_order ?? 99,
      };
      try {
        if (isNew) {
          const newId = `bed-${Date.now()}`;
          await API.create('beds', { id: newId, ...data });
          UI.toast(`${bedNumber}号床を追加しました`, 'success');
        } else {
          await API.patch('beds', bed.id, data);
          UI.toast(`${bedNumber}号床を更新しました`, 'success');
        }
        close();
        await App.loadMasters();
        this._renderBeds(document.getElementById('settings-tab-body'));
      } catch (e) {
        UI.toast('保存に失敗しました: ' + e.message, 'danger');
      }
    };
  },

  async _deleteBed(bedId) {
    const bed = AppState.beds.find(b => b.id === bedId);
    if (!bed) return;
    const isOccupied = !!(bed.patient_name || bed.patient_id);
    const detail = isOccupied
      ? `この病床には患者が在室中です（${UI.getPatientName(bed.patient_name || '')}）。削除すると在室記録は退院扱いで閉じられます。出棟履歴は残ります。`
      : '出棟履歴は残ります。';
    if (!await UI.confirmModal(`${bed.bed_number}号床を削除しますか？`, {
      title: '病床を削除',
      detail,
      type: 'warning',
      danger: isOccupied,
      confirmLabel: '削除',
    })) return;
    try {
      await API.remove('beds', bedId);
      UI.toast(`${bed.bed_number}号床を削除しました`, 'info');
      await App.loadMasters();
      this._renderBeds(document.getElementById('settings-tab-body'));
    } catch (e) {
      UI.toast('削除に失敗しました', 'danger');
    }
  },

  // ──────────────────────────────────
  //  病床マップ配置グリッドエディタ
  // ──────────────────────────────────
  _renderMapEditor(body) {
    const wardId = AppState.currentWardId;
    const beds = AppState.beds.filter(b => b.ward_id === wardId);
    this._grid.wardId = wardId;

    // 履歴スタックの初期化
    this._historyStack = [];
    this._redoStack = [];

    // グリッドサイズ調整
    const maxCol = Math.max(9, ...beds.map(b => b.map_col ?? 0));
    const maxRow = Math.max(6, ...beds.map(b => b.map_row ?? 0));
    this._grid.cols = Math.min(16, maxCol + 2);
    this._grid.rows = Math.min(12, maxRow + 2);

    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-map"></i> 病床マップ配置エディタ</h3>
          <div style="display:flex;gap:8px;align-items:center;">
            <button class="btn btn-outline btn-sm" id="map-undo" title="元に戻す (Ctrl+Z)" disabled><i class="fas fa-undo"></i> 元に戻す</button>
            <button class="btn btn-outline btn-sm" id="map-redo" title="やり直す (Ctrl+Y)" disabled><i class="fas fa-redo"></i> やり直す</button>
            <span style="border-left: 1px solid #cbd5e0; height: 16px; margin: 0 4px;"></span>
            <button class="btn btn-outline btn-sm" id="map-size-down-col" title="列を減らす"><i class="fas fa-minus"></i> 列</button>
            <button class="btn btn-outline btn-sm" id="map-size-up-col" title="列を増やす"><i class="fas fa-plus"></i> 列</button>
            <button class="btn btn-outline btn-sm" id="map-size-down-row" title="行を減らす"><i class="fas fa-minus"></i> 行</button>
            <button class="btn btn-outline btn-sm" id="map-size-up-row" title="行を増やす"><i class="fas fa-plus"></i> 行</button>
            <button class="btn btn-success btn-sm" id="map-save-all">
              <i class="fas fa-save"></i> 配置を保存
            </button>
          </div>
        </div>
        <p class="settings-hint">
          <i class="fas fa-info-circle"></i>
          左の病床リストから病床をドラッグしてグリッドにドロップします。配置済みの病床はグリッド上でドラッグ移動できます。
          右クリック（または長押し）で削除。「空マス」は廊下や壁として使えます。
        </p>
        <div class="map-editor-layout">
          <!-- 未配置の病床リスト -->
          <div class="map-bed-palette">
            <div class="palette-title"><i class="fas fa-list"></i> 未配置の病床</div>
            <div id="palette-beds"></div>
            <div class="palette-title" style="margin-top:12px;"><i class="fas fa-border-none"></i> 特殊マス</div>
            <div class="palette-special">
              <div class="palette-special-item" draggable="true" data-special="corridor" id="drag-corridor">
                <i class="fas fa-minus"></i> 廊下
              </div>
              <div class="palette-special-item" draggable="true" data-special="wall" id="drag-wall">
                <i class="fas fa-square"></i> 壁
              </div>
              <div class="palette-special-item" draggable="true" data-special="clear" id="drag-clear">
                <i class="fas fa-eraser"></i> 消去
              </div>
            </div>
          </div>
          <!-- グリッド -->
          <div class="map-editor-wrap">
            <div class="map-grid-container">
              <div class="map-col-labels" id="map-col-labels"></div>
              <div class="map-editor-body">
                <div class="map-row-labels" id="map-row-labels"></div>
                <div class="map-editor-grid" id="map-editor-grid"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // グリッドデータを system_settings もしくは beds から再構築
    this._grid.cells = {};
    const layoutSetting = AppState.systemSettings?.find(s => s.id === `map_layout_${wardId}`);
    if (layoutSetting && layoutSetting.value) {
      try {
        const parsed = JSON.parse(layoutSetting.value);
        this._grid.cells = parsed.cells || {};
        if (parsed.cols) this._grid.cols = parsed.cols;
        if (parsed.rows) this._grid.rows = parsed.rows;
      } catch (err) {
        console.error('[Settings] マップレイアウトのパース失敗:', err);
      }
    } else {
      beds.forEach(b => {
        if (b.map_col !== null && b.map_col !== undefined &&
            b.map_row !== null && b.map_row !== undefined) {
          const key = `${b.map_col},${b.map_row}`;
          this._grid.cells[key] = { bedId: b.id };
        }
      });
    }

    // キーボードショートカットのバインド
    this._mapKeydownHandler = (e) => {
      if (this._activeTab !== 'map') return;
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this._undo();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this._redo();
      }
    };
    window.addEventListener('keydown', this._mapKeydownHandler);

    // 既存データの救済: 過去に列・行を減らしたことで範囲外に取り残された病床を
    // 未配置へ戻す。この時点ではメモリ上の状態を直すだけで、確定するのは
    // 「配置を保存」を押したときなので、開いただけで勝手に保存されることはない。
    const recovered = this._pruneOutOfRangeCells();

    this._drawMapEditor();
    this._drawPalette();

    if (recovered.length > 0) {
      const names = recovered
        .map(b => b.bed_number)
        .sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }))
        .join('、');
      UI.toast(`マップ範囲外にあった ${recovered.length} 件の病床（${names}）を未配置に戻しました。配置し直して「配置を保存」してください。`, 'warning', 12000);
    }

    document.getElementById('map-undo').onclick = () => this._undo();
    document.getElementById('map-redo').onclick = () => this._redo();

    document.getElementById('map-size-up-col').onclick   = () => this._resizeGrid(Math.min(20, this._grid.cols + 1), this._grid.rows);
    document.getElementById('map-size-down-col').onclick = () => this._resizeGrid(Math.max(4, this._grid.cols - 1),  this._grid.rows);
    document.getElementById('map-size-up-row').onclick   = () => this._resizeGrid(this._grid.cols, Math.min(16, this._grid.rows + 1));
    document.getElementById('map-size-down-row').onclick = () => this._resizeGrid(this._grid.cols, Math.max(2, this._grid.rows - 1));
    document.getElementById('map-save-all').onclick = () => this._saveMapLayout();
  },

  // グリッドの現在の行数・列数の外に出たセルを取り除く。
  // 病床が置かれていたセルは未配置(map_col/map_row = null)へ戻すことで、
  // パレットから再配置できる状態にする(_onDropの消去処理と同じ扱い)。
  // 戻り値: 未配置へ戻した病床の配列
  _pruneOutOfRangeCells() {
    const g = this._grid;
    const freedBeds = [];
    for (const key of Object.keys(g.cells)) {
      const [col, row] = key.split(',').map(Number);
      if (col < g.cols && row < g.rows) continue;
      const cell = g.cells[key];
      if (cell?.bedId) {
        const bed = AppState.getBedById(cell.bedId);
        if (bed) {
          bed.map_col = null;
          bed.map_row = null;
          freedBeds.push(bed);
        }
      }
      delete g.cells[key];
    }
    return freedBeds;
  },

  // 指定サイズへ縮小したときに未配置へ戻ることになる病床を、実際に縮小する前に調べる
  _bedsOutsideRange(cols, rows) {
    return Object.entries(this._grid.cells)
      .filter(([key, cell]) => {
        if (!cell?.bedId) return false;
        const [col, row] = key.split(',').map(Number);
        return col >= cols || row >= rows;
      })
      .map(([, cell]) => AppState.getBedById(cell.bedId))
      .filter(Boolean);
  },

  // 縮小によって病床が範囲外になる場合は確認を取ってから縮小する
  async _resizeGrid(nextCols, nextRows) {
    const affected = this._bedsOutsideRange(nextCols, nextRows);
    if (affected.length > 0) {
      const names = affected
        .map(b => b.bed_number)
        .sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }))
        .join('、');
      const ok = await UI.confirmModal(`縮小すると ${affected.length} 件の病床が範囲外になります。`, {
        title: '範囲外になる病床があります',
        detail: `対象: ${names}。これらの病床は未配置に戻り、パレットから再配置できます（この操作は「元に戻す」で取り消せます）。`,
        type: 'warning',
        confirmLabel: '未配置に戻して縮小',
      });
      if (!ok) return;
    }
    this._saveStateToHistory();
    this._grid.cols = nextCols;
    this._grid.rows = nextRows;
    this._pruneOutOfRangeCells();
    this._drawMapEditor();
    this._drawPalette();
  },

  _drawPalette() {
    const el = document.getElementById('palette-beds');
    if (!el) return;
    const wardId = AppState.currentWardId;
    // 未配置 = 現在のグリッドに置かれていない病床。
    // map_col ではなくグリッドの実状態を基準にすることで、レイアウト情報と
    // 病床マスタがずれている場合（範囲外・削除済み等）でも取りこぼさない。
    // これは保存時(_saveMapLayout)に map_col を null にする条件とも一致する。
    const placedBedIds = new Set(
      Object.values(this._grid.cells).map(c => c?.bedId).filter(Boolean)
    );
    const unplaced = AppState.beds.filter(b =>
      b.ward_id === wardId && !placedBedIds.has(b.id)
    ).sort((a, b) => a.bed_number.localeCompare(b.bed_number, 'ja', { numeric: true }));

    if (unplaced.length === 0) {
      el.innerHTML = '<div class="text-muted text-sm" style="padding:8px;">全病床が配置済みです</div>';
    } else {
      el.innerHTML = unplaced.map(b => `
        <div class="palette-bed-item" draggable="true" data-bed-id="${UI.escapeHTML(b.id)}">
          <i class="fas fa-bed"></i> ${UI.escapeHTML(b.bed_number)}
          <span class="text-xs text-muted">${UI.escapeHTML(b.room_number || '')}</span>
        </div>
      `).join('');
    }

    // ドラッグ開始
    el.querySelectorAll('.palette-bed-item').forEach(item => {
      item.addEventListener('dragstart', e => {
        this._grid.dragBedId = item.dataset.bedId;
        this._grid.dragSpecial = null;
        e.dataTransfer.effectAllowed = 'move';
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
    });

    // 特殊マスのドラッグ
    document.querySelectorAll('.palette-special-item').forEach(item => {
      item.addEventListener('dragstart', e => {
        this._grid.dragBedId = null;
        this._grid.dragSpecial = item.dataset.special;
        e.dataTransfer.effectAllowed = 'move';
      });
    });
  },

  _drawMapEditor() {
    const grid = document.getElementById('map-editor-grid');
    const colLabels = document.getElementById('map-col-labels');
    const rowLabels = document.getElementById('map-row-labels');
    if (!grid) return;

    const { cols, rows, cells } = this._grid;

    // 列ラベル
    colLabels.innerHTML = `<div class="map-corner-label"></div>` +
      Array.from({ length: cols }, (_, c) =>
        `<div class="map-col-label">${c + 1}</div>`
      ).join('');

    // 行ラベル
    rowLabels.innerHTML = Array.from({ length: rows }, (_, r) =>
      `<div class="map-row-label">${r + 1}</div>`
    ).join('');

    // グリッド本体
    grid.style.gridTemplateColumns = `repeat(${cols}, 72px)`;
    grid.style.gridTemplateRows    = `repeat(${rows}, 64px)`;

    let html = '';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const key = `${c},${r}`;
        const cell = cells[key];
        html += this._cellHTML(c, r, cell);
      }
    }
    grid.innerHTML = html;

    // ドロップ
    grid.querySelectorAll('.map-editor-cell').forEach(cell => {
      const c = parseInt(cell.dataset.col);
      const r = parseInt(cell.dataset.row);

      cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('drag-over'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));

      cell.addEventListener('drop', e => {
        e.preventDefault();
        cell.classList.remove('drag-over');
        this._onDrop(c, r);
      });

      // 右クリックで削除
      cell.addEventListener('contextmenu', e => {
        e.preventDefault();
        this._clearCell(c, r);
      });
    });

    // 配置済み病床のドラッグ（グリッド内移動）
    grid.querySelectorAll('.map-cell-bed[draggable]').forEach(item => {
      item.addEventListener('dragstart', e => {
        const key = `${item.dataset.col},${item.dataset.row}`;
        const cell = this._grid.cells[key];
        if (cell?.bedId) {
          this._grid.dragBedId = cell.bedId;
          this._grid.dragFromKey = key;
          this._grid.dragSpecial = null;
          e.dataTransfer.effectAllowed = 'move';
        }
      });
    });
  },

  _cellHTML(c, r, cell) {
    let inner = '';
    let extraCls = '';

    if (cell?.bedId) {
      const bed = AppState.getBedById(cell.bedId);
      inner = `
        <div class="map-cell-bed" draggable="true" data-col="${c}" data-row="${r}"
             title="右クリックで削除">
          <i class="fas fa-bed"></i>
          <span>${bed ? UI.escapeHTML(bed.bed_number) : '?'}</span>
          ${bed?.room_number ? `<span class="map-cell-room">${UI.escapeHTML(bed.room_number)}</span>` : ''}
        </div>`;
      extraCls = 'has-bed';
    } else if (cell?.special === 'corridor') {
      inner = `<div class="map-cell-special corridor"><i class="fas fa-minus"></i><span>廊下</span></div>`;
      extraCls = 'is-corridor';
    } else if (cell?.special === 'wall') {
      inner = `<div class="map-cell-special wall"><i class="fas fa-square"></i><span>壁</span></div>`;
      extraCls = 'is-wall';
    }

    return `<div class="map-editor-cell ${extraCls}" data-col="${c}" data-row="${r}">${inner}</div>`;
  },

  _onDrop(col, row) {
    this._saveStateToHistory();
    const key = `${col},${row}`;
    const g = this._grid;

    if (g.dragSpecial === 'clear') {
      // 消去
      if (g.cells[key]?.bedId) {
        // 病床を未配置に戻す → map_col/map_row を null に
        const bedId = g.cells[key].bedId;
        const bed = AppState.getBedById(bedId);
        if (bed) { bed.map_col = null; bed.map_row = null; }
      }
      delete g.cells[key];
    } else if (g.dragSpecial === 'corridor') {
      g.cells[key] = { special: 'corridor' };
    } else if (g.dragSpecial === 'wall') {
      g.cells[key] = { special: 'wall' };
    } else if (g.dragBedId) {
      // 元の位置を消す（グリッド内移動の場合）
      if (g.dragFromKey && g.dragFromKey !== key) {
        delete g.cells[g.dragFromKey];
      }
      // 既存の病床をパレットへ退避
      if (g.cells[key]?.bedId) {
        const prevBed = AppState.getBedById(g.cells[key].bedId);
        if (prevBed) { prevBed.map_col = null; prevBed.map_row = null; }
      }
      // 配置
      g.cells[key] = { bedId: g.dragBedId };
      const bed = AppState.getBedById(g.dragBedId);
      if (bed) { bed.map_col = col; bed.map_row = row; }
    }

    g.dragBedId   = null;
    g.dragSpecial = null;
    g.dragFromKey = null;

    this._drawMapEditor();
    this._drawPalette();
  },

  _clearCell(col, row) {
    const key = `${col},${row}`;
    if (!this._grid.cells[key]) return;
    this._saveStateToHistory();
    if (this._grid.cells[key]?.bedId) {
      const bed = AppState.getBedById(this._grid.cells[key].bedId);
      if (bed) { bed.map_col = null; bed.map_row = null; }
    }
    delete this._grid.cells[key];
    this._drawMapEditor();
    this._drawPalette();
  },

  // ──────────────────────────────────
  //  Undo / Redo 処理用ヘルパー
  // ──────────────────────────────────
  _saveStateToHistory() {
    if (!this._historyStack) this._historyStack = [];
    if (!this._redoStack) this._redoStack = [];
    
    const state = {
      cells: JSON.parse(JSON.stringify(this._grid.cells)),
      cols: this._grid.cols,
      rows: this._grid.rows
    };
    this._historyStack.push(state);
    if (this._historyStack.length > 50) {
      this._historyStack.shift();
    }
    this._redoStack = [];
    
    this._updateUndoRedoButtons();
  },

  _undo() {
    if (!this._historyStack || this._historyStack.length === 0) return;
    
    const currentState = {
      cells: JSON.parse(JSON.stringify(this._grid.cells)),
      cols: this._grid.cols,
      rows: this._grid.rows
    };
    this._redoStack.push(currentState);
    
    const previousState = this._historyStack.pop();
    this._restoreState(previousState);
  },

  _redo() {
    if (!this._redoStack || this._redoStack.length === 0) return;
    
    const currentState = {
      cells: JSON.parse(JSON.stringify(this._grid.cells)),
      cols: this._grid.cols,
      rows: this._grid.rows
    };
    this._historyStack.push(currentState);
    
    const nextState = this._redoStack.pop();
    this._restoreState(nextState);
  },

  _restoreState(state) {
    this._grid.cells = state.cells;
    this._grid.cols = state.cols;
    this._grid.rows = state.rows;
    
    // AppState.bedsの同期
    const wardId = AppState.currentWardId;
    AppState.beds.forEach(b => {
      if (b.ward_id === wardId) {
        b.map_col = null;
        b.map_row = null;
      }
    });
    
    Object.entries(this._grid.cells).forEach(([key, cell]) => {
      if (cell?.bedId) {
        const [col, row] = key.split(',').map(Number);
        const bed = AppState.getBedById(cell.bedId);
        if (bed) {
          bed.map_col = col;
          bed.map_row = row;
        }
      }
    });
    
    this._drawMapEditor();
    this._drawPalette();
    this._updateUndoRedoButtons();
  },

  _updateUndoRedoButtons() {
    const btnUndo = document.getElementById('map-undo');
    const btnRedo = document.getElementById('map-redo');
    if (btnUndo) {
      btnUndo.disabled = !this._historyStack || this._historyStack.length === 0;
    }
    if (btnRedo) {
      btnRedo.disabled = !this._redoStack || this._redoStack.length === 0;
    }
  },

  async _saveMapLayout() {
    const btn = document.getElementById('map-save-all');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';
    try {
      const wardId = AppState.currentWardId;
      const beds = AppState.beds.filter(b => b.ward_id === wardId);
      
      // マップ配置の座標は患者データと無関係のため、他端末での病床更新（患者割当・
      // 在室状況の変化等）と衝突して保存全体が失敗しないよう、楽観的排他ロックを
      // 使わずに保存する。
      // 以前は病床ごとに個別のPATCHリクエストをPromise.allで並列送信していたが、
      // 各リクエストは親機側で独立にDB全体を読み書きするため、病床数が多い病棟では
      // 実質的に直列化して合計の所要時間が病床数に比例して伸びる。特に子機からの
      // 保存はHTTP+IPC中継の往復が病床数分積み重なり、8秒のリクエストタイムアウトを
      // 超えて保存が失敗する・画面が固まって見える不具合の原因になっていた。
      // bulkPatchで1回のリクエスト・1回のDB書き込みにまとめる。
      const bedUpdates = [];
      for (const [key, cell] of Object.entries(this._grid.cells)) {
        if (cell?.bedId) {
          const [col, row] = key.split(',').map(Number);
          bedUpdates.push({ id: cell.bedId, map_col: col, map_row: row });
        }
      }
      // 未配置のものは null に更新
      for (const bed of beds) {
        const placed = Object.values(this._grid.cells).some(c => c?.bedId === bed.id);
        if (!placed) {
          bedUpdates.push({ id: bed.id, map_col: null, map_row: null });
        }
      }

      // 廊下や壁を含めたセルデータ全体を JSON 文字列として system_settings に保存
      const layoutData = {
        cols: this._grid.cols,
        rows: this._grid.rows,
        cells: this._grid.cells
      };

      const promises = [];
      if (bedUpdates.length > 0) {
        promises.push(API.bulkPatch('beds', bedUpdates, { skipRevisionCheck: true }));
      }
      promises.push(API.create('system_settings', {
        id: `map_layout_${wardId}`,
        value: JSON.stringify(layoutData)
      }, { skipRevisionCheck: true }));

      await Promise.all(promises);
      await App.loadMasters();
      UI.toast('マップ配置を保存しました', 'success');
      // ダッシュボードのマップも更新
      BedMap.render();
    } catch (e) {
      UI.toast('保存に失敗しました: ' + e.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-save"></i> 配置を保存';
    }
  },

  // ──────────────────────────────────
  //  検査室マスタ管理
  // ──────────────────────────────────
  _renderRooms(body) {
    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-x-ray"></i> 検査室マスタ</h3>
          <div style="display:flex; gap:8px; align-items:center;">
            <label style="display:flex; align-items:center; gap:5px; font-size:12px; color:var(--clr-text-muted); cursor:pointer; user-select:none;">
              <input type="checkbox" id="chk-show-inactive-rooms" style="cursor:pointer;">
              無効を表示
            </label>
            <button class="btn btn-outline btn-sm" id="btn-export-rooms" title="検査室マスタをCSVファイルに出力します">
              <i class="fas fa-file-download"></i> CSV出力
            </button>
            <button class="btn btn-outline btn-sm" id="btn-import-rooms" title="CSVファイルから検査室マスタを取り込みます">
              <i class="fas fa-file-upload"></i> CSV入力
            </button>
            <button class="btn btn-primary btn-sm" id="btn-add-room">
              <i class="fas fa-plus"></i> 検査室追加
            </button>
          </div>
        </div>
        <table class="settings-table" id="rooms-table">
          <thead>
            <tr><th>アイコン</th><th>検査室名</th><th>コード</th><th>階</th><th>内線番号</th><th>備考</th><th>有効</th><th>操作</th></tr>
          </thead>
          <tbody id="rooms-tbody">
          </tbody>
        </table>
      </div>
    `;

    const _renderRoomsTable = (showInactive) => {
      const all = AppState.allExamRooms || AppState.examRooms;
      const rows = showInactive ? all : all.filter(r => r.is_active !== false);
      const inactiveCount = all.filter(r => r.is_active === false).length;
      const tbody = document.getElementById('rooms-tbody');
      if (!tbody) return;
      tbody.innerHTML = rows.map(r => `
        <tr class="${r.is_active === false ? 'row--inactive' : ''}">
          <td><span class="room-icon-preview">${UI.examImage(r, 'room')}</span></td>
          <td class="font-bold">${UI.escapeHTML(r.name)}</td>
          <td>${UI.escapeHTML(r.code)}</td>
          <td>${UI.escapeHTML(r.floor || '')}</td>
          <td>
            ${r.phone
              ? `<span class="phone-chip"><i class="fas fa-phone"></i> ${UI.escapeHTML(r.phone)}</span>`
              : '<span class="text-muted">未設定</span>'}
          </td>
          <td class="text-sm text-muted">${UI.escapeHTML(r.note || '—')}</td>
          <td>${r.is_active !== false ? '<i class="fas fa-check-circle" style="color:#16a34a"></i>' : '<i class="fas fa-times-circle" style="color:#94a3b8"></i>'}</td>
          <td>
            <button class="btn btn-outline btn-sm btn-edit-room" data-room-id="${UI.escapeHTML(r.id)}">
              <i class="fas fa-edit"></i>
            </button>
          </td>
        </tr>
      `).join('') || '<tr><td colspan="8" class="text-muted" style="text-align:center;">検査室が登録されていません</td></tr>';

      // 無効件数ヒント
      const chk = document.getElementById('chk-show-inactive-rooms');
      if (chk) chk.title = inactiveCount > 0 ? `無効の検査室が ${inactiveCount} 件あります` : '無効の検査室はありません';

      tbody.querySelectorAll('.btn-edit-room').forEach(btn => {
        btn.onclick = () => {
          const room = (AppState.allExamRooms || AppState.examRooms).find(r => r.id === btn.dataset.roomId);
          this._openRoomForm(room);
        };
      });
    };

    _renderRoomsTable(false);

    document.getElementById('chk-show-inactive-rooms').onchange = (e) => _renderRoomsTable(e.target.checked);
    document.getElementById('btn-add-room').onclick = () => this._openRoomForm(null);
    body.querySelectorAll('.btn-edit-room').forEach(btn => {
      btn.onclick = () => {
        const room = (AppState.allExamRooms || AppState.examRooms).find(r => r.id === btn.dataset.roomId);
        this._openRoomForm(room);
      };
    });

    this._setupCsvHandlers('rooms', 'exam_rooms', ['id', 'name', 'code', 'floor', 'phone', 'note', 'is_active', 'icon'], { optionalHeaders: ['icon'] });
  },

  _openRoomForm(room) {
    const isNew = !room;
    const selectedIcon = UI.normalizeExamRoomIcon(room?.icon);
    const iconOptions = UI.EXAM_ROOM_ICON_PRESETS.map(item => `
      <label class="room-icon-option ${item.icon === selectedIcon ? 'selected' : ''}">
        <input type="radio" name="rf-icon" value="${UI.escapeHTML(item.icon)}" ${item.icon === selectedIcon ? 'checked' : ''}>
        <span class="room-icon-option-preview"><i class="fas ${UI.escapeHTML(item.icon)}"></i></span>
        <span>${UI.escapeHTML(item.label)}</span>
      </label>
    `).join('');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px;">
        <div class="modal-header">
          <h2>${isNew ? '検査室を追加' : '検査室を編集'}</h2>
          <button class="modal-close-btn" id="room-form-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>検査室名 <span style="color:#dc2626">*</span></label>
            <input type="text" id="rf-name" value="${UI.escapeHTML(room?.name || '')}" placeholder="例: CT室">
          </div>
          <div class="form-row">
            <label>コード <span style="color:#dc2626">*</span></label>
            <input type="text" id="rf-code" value="${UI.escapeHTML(room?.code || '')}" placeholder="例: CT">
          </div>
          <div class="form-row">
            <label>階</label>
            <input type="text" id="rf-floor" value="${UI.escapeHTML(room?.floor || '')}" placeholder="例: 2F">
          </div>
          <div class="form-row">
            <label>アイコン</label>
            <div class="room-icon-picker">${iconOptions}</div>
          </div>
          <div class="form-row">
            <label><i class="fas fa-phone"></i> 内線番号</label>
            <input type="text" id="rf-phone" value="${UI.escapeHTML(room?.phone || '')}" placeholder="例: 2001">
          </div>
          <div class="form-row">
            <label>備考</label>
            <input type="text" id="rf-note" value="${UI.escapeHTML(room?.note || '')}" placeholder="メモ">
          </div>
          <div class="form-row">
            <label>有効</label>
            <select id="rf-active">
              <option value="true"  ${room?.is_active!==false?'selected':''}>有効</option>
              <option value="false" ${room?.is_active===false?'selected':''}>無効</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="rf-save">
            <i class="fas fa-save"></i> ${isNew ? '追加' : '保存'}
          </button>
          <button class="btn btn-outline" id="rf-cancel">キャンセル</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById('room-form-close').onclick = close;
    document.getElementById('rf-cancel').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    this._addEscapeClose(overlay, close);
    overlay.querySelectorAll('input[name="rf-icon"]').forEach(input => {
      input.addEventListener('change', () => {
        overlay.querySelectorAll('.room-icon-option').forEach(label => {
          label.classList.toggle('selected', label.querySelector('input')?.checked);
        });
      });
    });

    // Focus the first input field to prevent focus-stealing or uneditable state in Electron/Windows
    setTimeout(() => {
      document.getElementById('rf-name')?.focus();
    }, 50);

    document.getElementById('rf-save').onclick = async () => {
      const name = document.getElementById('rf-name').value.trim();
      const code = document.getElementById('rf-code').value.trim();
      if (!name || !code) { UI.toast('検査室名とコードは必須です', 'warning'); return; }
      const data = {
        name,
        code,
        floor: document.getElementById('rf-floor').value.trim(),
        icon: UI.normalizeExamRoomIcon(overlay.querySelector('input[name="rf-icon"]:checked')?.value),
        phone: document.getElementById('rf-phone').value.trim(),
        note: document.getElementById('rf-note').value.trim(),
        is_active: document.getElementById('rf-active').value === 'true',
      };
      try {
        if (isNew) {
          const newId = `room-${code.toLowerCase()}-${Date.now()}`;
          await API.create('exam_rooms', { id: newId, ...data });
          UI.toast(`${name}を追加しました`, 'success');
        } else {
          await API.patch('exam_rooms', room.id, data);
          UI.toast(`${name}を更新しました`, 'success');
        }
        close();
        await App.loadMasters();
        // 通話パネルも更新
        CallPanel._renderCallPanel();
        this._renderRooms(document.getElementById('settings-tab-body'));
      } catch (e) {
        UI.toast('保存に失敗しました: ' + e.message, 'danger');
      }
    };
  },

  // ──────────────────────────────────
  //  スタッフマスタ管理
  // ──────────────────────────────────
  _renderStaffs(body) {
    const wardId = AppState.currentWardId;
    const staffs = (AppState.allStaffs || AppState.staffs).filter(s => s.ward_id === wardId);
    const roleLabel = { nurse: '看護師', leader: 'リーダー', admin: '管理者' };

    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-user-nurse"></i> スタッフマスタ</h3>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-outline btn-sm" id="btn-export-staffs" title="スタッフマスタをCSVファイルに出力します">
              <i class="fas fa-file-download"></i> CSV出力
            </button>
            <button class="btn btn-outline btn-sm" id="btn-import-staffs" title="CSVファイルからスタッフマスタを取り込みます">
              <i class="fas fa-file-upload"></i> CSV入力
            </button>
            <button class="btn btn-primary btn-sm" id="btn-add-staff">
              <i class="fas fa-plus"></i> スタッフ追加
            </button>
          </div>
        </div>
        <table class="settings-table">
          <thead><tr><th>名前</th><th>役職</th><th>状態</th><th>操作</th></tr></thead>
          <tbody>
            ${staffs.map(s => `
              <tr class="${s.is_active === false ? 'row--inactive' : ''}">
                <td class="font-bold">${UI.escapeHTML(s.name)}</td>
                <td>${UI.escapeHTML(roleLabel[s.role] || s.role)}</td>
                <td>${s.is_active !== false ? '<span style="color:#16a34a; font-weight:700;">有効</span>' : '<span style="color:#64748b; font-weight:700;">無効</span>'}</td>
                <td>
                  <button class="btn btn-outline btn-sm btn-edit-staff" data-staff-id="${UI.escapeHTML(s.id)}">
                    <i class="fas fa-edit"></i>
                  </button>
                  <button class="btn btn-outline btn-sm btn-toggle-staff" data-staff-id="${UI.escapeHTML(s.id)}" style="margin-left:4px;">
                    ${s.is_active === false ? '有効化' : '無効化'}
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('btn-add-staff').onclick = () => this._openStaffForm(null);
    body.querySelectorAll('.btn-edit-staff').forEach(btn => {
      btn.onclick = () => {
        const s = (AppState.allStaffs || AppState.staffs).find(x => x.id === btn.dataset.staffId);
        this._openStaffForm(s);
      };
    });
    body.querySelectorAll('.btn-toggle-staff').forEach(btn => {
      btn.onclick = () => this._toggleStaff(btn.dataset.staffId);
    });

    this._setupCsvHandlers('staffs', 'staffs', ['id', 'name', 'role', 'ward_id', 'is_active']);
  },

  _openStaffForm(staff) {
    const isNew = !staff;
    const wardId = AppState.currentWardId;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:400px;">
        <div class="modal-header">
          <h2>${isNew ? 'スタッフを追加' : 'スタッフを編集'}</h2>
          <button class="modal-close-btn" id="sf-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>名前 <span style="color:#dc2626">*</span></label>
            <input type="text" id="sf-name" value="${UI.escapeHTML(staff?.name || '')}" placeholder="例: 田中 花子">
          </div>
          <div class="form-row">
            <label>役職</label>
            <select id="sf-role">
              <option value="nurse"  ${staff?.role==='nurse'?'selected':''}>看護師</option>
              <option value="leader" ${staff?.role==='leader'?'selected':''}>リーダー</option>
              <option value="admin"  ${staff?.role==='admin'?'selected':''}>管理者</option>
            </select>
          </div>
          <div class="form-row">
            <label>有効</label>
            <select id="sf-active">
              <option value="true"  ${staff?.is_active!==false?'selected':''}>有効</option>
              <option value="false" ${staff?.is_active===false?'selected':''}>無効</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="sf-save">
            <i class="fas fa-save"></i> ${isNew ? '追加' : '保存'}
          </button>
          <button class="btn btn-outline" id="sf-cancel">キャンセル</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById('sf-close').onclick = close;
    document.getElementById('sf-cancel').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    this._addEscapeClose(overlay, close);

    // Focus the first input field to prevent focus-stealing or uneditable state in Electron/Windows
    setTimeout(() => {
      document.getElementById('sf-name')?.focus();
    }, 50);

    document.getElementById('sf-save').onclick = async () => {
      const name = document.getElementById('sf-name').value.trim();
      if (!name) { UI.toast('名前は必須です', 'warning'); return; }
      const data = {
        name,
        role: document.getElementById('sf-role').value,
        is_active: document.getElementById('sf-active').value === 'true',
        ward_id: wardId,
      };
      try {
        if (isNew) {
          await API.create('staffs', { id: `staff-${Date.now()}`, ...data });
          UI.toast(`${name}を追加しました`, 'success');
        } else {
          await API.patch('staffs', staff.id, data);
          UI.toast(`${name}を更新しました`, 'success');
        }
        close();
        await App.loadMasters();
        this._renderStaffs(document.getElementById('settings-tab-body'));
      } catch (e) {
        UI.toast('保存に失敗しました: ' + e.message, 'danger');
      }
    };
  },

  async _toggleStaff(staffId) {
    const staff = (AppState.allStaffs || AppState.staffs).find(s => s.id === staffId);
    if (!staff) return;
    try {
      await API.patch('staffs', staff.id, { is_active: staff.is_active === false });
      await App.loadMasters();
      this._renderStaffs(document.getElementById('settings-tab-body'));
    } catch (e) {
      UI.toast('状態の変更に失敗しました: ' + e.message, 'danger');
    }
  },

  // ──────────────────────────────────
  //  病棟マスタ管理
  // ──────────────────────────────────
  _renderWards(body) {
    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-hospital"></i> 病棟マスタ</h3>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-outline btn-sm" id="btn-export-wards" title="病棟マスタをCSVファイルに出力します">
              <i class="fas fa-file-download"></i> CSV出力
            </button>
            <button class="btn btn-outline btn-sm" id="btn-import-wards" title="CSVファイルから病棟マスタを取り込みます">
              <i class="fas fa-file-upload"></i> CSV入力
            </button>
            <button class="btn btn-primary btn-sm" id="btn-add-ward">
              <i class="fas fa-plus"></i> 病棟追加
            </button>
          </div>
        </div>
        <table class="settings-table">
          <thead>
            <tr><th>病棟名</th><th>ID</th><th>内線番号</th><th>備考</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${AppState.wards.map(w => `
              <tr>
                <td class="font-bold">${UI.escapeHTML(w.name)}</td>
                <td>${UI.escapeHTML(w.id)}</td>
                <td>
                  ${w.phone
                    ? `<span class="phone-chip"><i class="fas fa-phone"></i> ${UI.escapeHTML(w.phone)}</span>`
                    : '<span class="text-muted">未設定</span>'}
                </td>
                <td class="text-sm text-muted">${UI.escapeHTML(w.note || '—')}</td>
                <td>
                  <button class="btn btn-outline btn-sm btn-edit-ward" data-ward-id="${UI.escapeHTML(w.id)}">
                    <i class="fas fa-edit"></i>
                  </button>
                  <button class="btn btn-danger btn-sm btn-delete-ward" data-ward-id="${UI.escapeHTML(w.id)}" style="padding: 4px 8px; margin-left: 4px;">
                    <i class="fas fa-trash-alt"></i>
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('btn-add-ward').onclick = () => this._openWardForm(null);
    body.querySelectorAll('.btn-edit-ward').forEach(btn => {
      btn.onclick = () => {
        const ward = AppState.wards.find(w => w.id === btn.dataset.wardId);
        this._openWardForm(ward);
      };
    });
    body.querySelectorAll('.btn-delete-ward').forEach(btn => {
      btn.onclick = async () => {
        const wardId = btn.dataset.wardId;
        const ward = AppState.wards.find(w => w.id === wardId);
        if (!ward) return;

        const linkedBeds = AppState.beds.filter(b => b.ward_id === wardId);
        if (linkedBeds.length > 0) {
          UI.toast('この病棟には病床が登録されているため削除できません。先に病床を削除してください。', 'danger', 6000);
          return;
        }

        if (!await UI.confirmModal(`「${ward.name}」を削除しますか？`, { title: '病棟を削除', type: 'warning', confirmLabel: '削除' })) return;

        try {
          await API.remove('wards', wardId);
          UI.toast(`${ward.name}を削除しました`, 'success');
          await App.loadMasters();

          if (window.App && window.App.syncWardSelect) {
            window.App.syncWardSelect();
          }

          this._renderWards(document.getElementById('settings-tab-body'));
        } catch (e) {
          UI.toast('削除に失敗しました: ' + e.message, 'danger');
        }
      };
    });

    this._setupCsvHandlers('wards', 'wards', ['id', 'name', 'phone', 'note']);
  },

  _openWardForm(ward) {
    const isNew = !ward;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:440px;">
        <div class="modal-header">
          <h2>${isNew ? '病棟を追加' : '病棟を編集'}</h2>
          <button class="modal-close-btn" id="ward-form-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>病棟名 <span style="color:#dc2626">*</span></label>
            <input type="text" id="wf-name" value="${UI.escapeHTML(ward?.name || '')}" placeholder="例: 7階東病棟">
          </div>
          ${isNew ? `
          <div class="form-row">
            <label>病棟ID <span style="color:#dc2626">*</span>（半角英数・ハイフン・アンダースコアのみ）</label>
            <input type="text" id="wf-id" value="" placeholder="例: ward-3">
          </div>
          ` : ''}
          <div class="form-row">
            <label><i class="fas fa-phone"></i> 内線番号</label>
            <input type="text" id="wf-phone" value="${UI.escapeHTML(ward?.phone || '')}" placeholder="例: 7201">
          </div>
          <div class="form-row">
            <label>備考</label>
            <input type="text" id="wf-note" value="${UI.escapeHTML(ward?.note || '')}" placeholder="例: ナースステーション">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="wf-save">
            <i class="fas fa-save"></i> ${isNew ? '追加' : '保存'}
          </button>
          <button class="btn btn-outline" id="wf-cancel">キャンセル</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById('ward-form-close').onclick = close;
    document.getElementById('wf-cancel').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    this._addEscapeClose(overlay, close);

    setTimeout(() => {
      document.getElementById('wf-name')?.focus();
    }, 50);

    document.getElementById('wf-save').onclick = async () => {
      const name = document.getElementById('wf-name').value.trim();
      if (!name) { UI.toast('病棟名は必須です', 'warning'); return; }

      let id = ward?.id;
      if (isNew) {
        id = document.getElementById('wf-id').value.trim();
        if (!id) { UI.toast('病棟IDは必須です', 'warning'); return; }
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) { UI.toast('病棟IDは半角英数・ハイフン・アンダースコアのみ使用できます', 'warning'); return; }
        if (AppState.wards.some(w => w.id === id)) {
          UI.toast('この病棟IDはすでに存在します', 'warning');
          return;
        }
      }

      const data = {
        name,
        phone: document.getElementById('wf-phone').value.trim(),
        note: document.getElementById('wf-note').value.trim(),
      };

      try {
        if (isNew) {
          await API.create('wards', { id, ...data });
          UI.toast(`${name}を追加しました`, 'success');
        } else {
          await API.patch('wards', ward.id, data);
          UI.toast(`${name}を更新しました`, 'success');
        }
        close();
        await App.loadMasters();

        if (typeof App !== 'undefined' && App.syncWardSelect) {
          App.syncWardSelect();
        }

        this._renderWards(document.getElementById('settings-tab-body'));
      } catch (e) {
        UI.toast('保存に失敗しました: ' + e.message, 'danger');
      }
    };
  },

  // ──────────────────────────────────
  //  CSVインポート/エクスポート ヘルパーメソッド
  // ──────────────────────────────────
  _parseCSV(text) {
    const lines = [];
    let row = [""];
    let inQuotes = false;
    
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const next = text[i+1];
      if (c === '"') {
        if (inQuotes && next === '"') {
          row[row.length - 1] += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        row.push("");
      } else if ((c === '\r' || c === '\n') && !inQuotes) {
        if (c === '\r' && next === '\n') { i++; }
        lines.push(row);
        row = [""];
      } else {
        row[row.length - 1] += c;
      }
    }
    if (row.length > 1 || row[0] !== "") {
      lines.push(row);
    }
    return lines;
  },

  _generateCSV(headers, rows) {
    const escapeField = (val) => {
      if (val === null || val === undefined) return '';
      const str = UI.sanitizeCsvValue(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const csvLines = [headers.map(escapeField).join(',')];
    rows.forEach(row => {
      const line = headers.map(h => escapeField(row[h])).join(',');
      csvLines.push(line);
    });

    return csvLines.join('\r\n');
  },

  _downloadCSV(fileName, csvContent) {
    // UTF-8 BOM
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  },

  _setupCsvHandlers(tabName, tableName, headers, { optionalHeaders = [] } = {}) {
    const exportBtn = document.getElementById(`btn-export-${tabName}`);
    const importBtn = document.getElementById(`btn-import-${tabName}`);
    
    if (exportBtn) {
      exportBtn.onclick = () => {
        let data = [];
        if (tableName === 'wards') data = AppState.wards;
        else if (tableName === 'beds') data = AppState.beds.filter(b => b.ward_id === AppState.currentWardId);
        else if (tableName === 'exam_rooms') data = (AppState.allExamRooms || AppState.examRooms).map(room => ({
          ...room,
          icon: UI.normalizeExamRoomIcon(room.icon),
        }));
        else if (tableName === 'exam_types') data = AppState.examTypes;
        else if (tableName === 'staffs') data = (AppState.allStaffs || AppState.staffs).filter(s => s.ward_id === AppState.currentWardId);
        
        const csvContent = this._generateCSV(headers, data);
        this._downloadCSV(`${tableName}_master_${Date.now()}.csv`, csvContent);
        UI.toast('CSVファイルを出力しました (Excel対応UTF-8 BOM付き)', 'success');
      };
    }
    
    if (importBtn) {
      importBtn.onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv';
        input.onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          
          const reader = new FileReader();
          reader.onload = async (event) => {
            try {
              const text = event.target.result;
              const rows = this._parseCSV(text);
              if (rows.length < 2) {
                UI.toast('有効なデータが見つかりません', 'warning');
                return;
              }
              
              const csvHeaders = rows[0].map(h => h.trim());
              const optionalSet = new Set(optionalHeaders);
              const missing = headers.filter(h => !optionalSet.has(h) && !csvHeaders.includes(h));
              if (missing.length > 0) {
                UI.toast(`ヘッダーが一致しません。不足: ${missing.join(', ')}`, 'danger');
                return;
              }
              
              const records = [];
              const seenIds = new Set();
              const seenBedNumbers = new Set();
              for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (row.length === 0 || (row.length === 1 && !row[0])) continue;
                
                const record = {};
                headers.forEach(h => {
                  const idx = csvHeaders.indexOf(h);
                   let val = idx >= 0 && row[idx] !== undefined ? row[idx].trim() : '';
                   val = UI.restoreSanitizedCsvValue(val);
                   const rawValue = val;
                  
                  // Convert fields to expected types
                   if (h === 'map_col' || h === 'map_row' || h === 'sort_order' || h === 'standard_duration_min') {
                     val = val === '' ? null : parseInt(val, 10);
                     if (rawValue !== '' && !/^-?\d+$/.test(rawValue)) {
                       throw new Error(`${i + 1}行目の${h}は整数で指定してください`);
                     }
                  } else if (h === 'is_active') {
                    val = (val === 'true' || val === '1' || val === true);
                  } else {
                    if (val === 'true') val = true;
                    else if (val === 'false') val = false;
                    else if (val === 'null') val = null;
                  }
                  
                  record[h] = val;
                });

                if (tableName === 'exam_rooms') {
                  record.icon = UI.normalizeExamRoomIcon(record.icon);
                }
                
                if (tableName === 'beds' || tableName === 'staffs') {
                  record.ward_id = record.ward_id || AppState.currentWardId;
                }
                
                if (!record.id) {
                  record.id = `${tableName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                }
                
                if (seenIds.has(String(record.id))) {
                  throw new Error(`${i + 1}行目のIDがCSV内で重複しています: ${record.id}`);
                }
                seenIds.add(String(record.id));
                if ((tableName === 'beds' || tableName === 'staffs') &&
                    !AppState.wards.some(ward => String(ward.id) === String(record.ward_id))) {
                  throw new Error(`${i + 1}行目の病棟IDが存在しません: ${record.ward_id}`);
                }
                if (tableName === 'beds') {
                  const bedNumber = String(record.bed_number || '').trim();
                  if (!bedNumber) throw new Error(`${i + 1}行目の病床番号が空です`);
                  if (seenBedNumbers.has(bedNumber)) {
                    throw new Error(`${i + 1}行目の病床番号がCSV内で重複しています: ${bedNumber}`);
                  }
                  seenBedNumbers.add(bedNumber);
                }
                records.push(record);
              }
              
              const result = await API.bulkUpsert(tableName, records);
              if (result?.success === false) {
                throw new Error(result.message || 'マスターの一括保存に失敗しました');
              }
              UI.toast(`CSVから ${records.length} 件のマスタデータを一括反映しました。`, 'success');
              await App.loadMasters();
              this._renderTab();
            } catch (err) {
              console.error(err);
              UI.toast('CSVのインポートに失敗しました: ' + err.message, 'danger');
            }
          };
          reader.readAsText(file, 'utf-8');
        };
        input.click();
      };
    }
  },

  // ──────────────────────────────────
  //  検査種別マスタ管理
  // ──────────────────────────────────
  _renderExamTypes(body) {
    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-notes-medical"></i> 検査種別マスタ</h3>
          <div style="display:flex; gap:8px; align-items:center;">
            <label style="display:flex; align-items:center; gap:5px; font-size:12px; color:var(--clr-text-muted); cursor:pointer; user-select:none;">
              <input type="checkbox" id="chk-show-inactive-exam-types" style="cursor:pointer;">
              無効を表示
            </label>
            <button class="btn btn-outline btn-sm" id="btn-export-exam_types" title="検査種別マスタをCSVファイルに出力します">
              <i class="fas fa-file-download"></i> CSV出力
            </button>
            <button class="btn btn-outline btn-sm" id="btn-import-exam_types" title="CSVファイルから検査種別マスタを取り込みます">
              <i class="fas fa-file-upload"></i> CSV入力
            </button>
            <button class="btn btn-primary btn-sm" id="btn-add-exam-type">
              <i class="fas fa-plus"></i> 検査種別追加
            </button>
          </div>
        </div>
        <table class="settings-table">
          <thead>
            <tr><th>検査種別名</th><th>コード</th><th>標準所要時間(分)</th><th>有効</th><th>操作</th></tr>
          </thead>
          <tbody id="exam-types-tbody"></tbody>
        </table>
      </div>
    `;

    const _renderExamTypesTable = (showInactive) => {
      const all = AppState.allExamTypes || AppState.examTypes;
      const rows = showInactive ? all : all.filter(t => t.is_active !== false);
      const inactiveCount = all.filter(t => t.is_active === false).length;
      const tbody = document.getElementById('exam-types-tbody');
      if (!tbody) return;
      tbody.innerHTML = rows.map(t => `
        <tr class="${t.is_active === false ? 'row--inactive' : ''}">
          <td><span class="room-icon-preview">${UI.examImage(t, 'type')}</span></td>
          <td class="font-bold">${UI.escapeHTML(t.name)}</td>
          <td>${UI.escapeHTML(t.code)}</td>
          <td>${UI.escapeHTML(t.standard_duration_min)}分</td>
          <td>${t.is_active !== false ? '<i class="fas fa-check-circle" style="color:#16a34a"></i>' : '<i class="fas fa-times-circle" style="color:#94a3b8"></i>'}</td>
          <td>
            <button class="btn btn-outline btn-sm btn-edit-exam-type" data-type-id="${UI.escapeHTML(t.id)}">
              <i class="fas fa-edit"></i>
            </button>
            <button class="btn btn-outline btn-sm btn-toggle-exam-type" data-type-id="${UI.escapeHTML(t.id)}" style="margin-left:4px;">
              ${t.is_active === false ? '有効化' : '無効化'}
            </button>
          </td>
        </tr>
      `).join('') || '<tr><td colspan="5" class="text-muted" style="text-align:center;">検査種別が登録されていません</td></tr>';

      const chk = document.getElementById('chk-show-inactive-exam-types');
      if (chk) chk.title = inactiveCount > 0 ? `無効の検査種別が ${inactiveCount} 件あります` : '無効の検査種別はありません';

      tbody.querySelectorAll('.btn-edit-exam-type').forEach(btn => {
        btn.onclick = () => {
          const type = (AppState.allExamTypes || AppState.examTypes).find(t => t.id === btn.dataset.typeId);
          this._openExamTypeForm(type);
        };
      });
      tbody.querySelectorAll('.btn-toggle-exam-type').forEach(btn => {
        btn.onclick = () => this._toggleExamType(btn.dataset.typeId);
      });
    };

    _renderExamTypesTable(false);

    document.getElementById('chk-show-inactive-exam-types').onchange = (e) => _renderExamTypesTable(e.target.checked);
    document.getElementById('btn-add-exam-type').onclick = () => this._openExamTypeForm(null);
    this._setupCsvHandlers('exam_types', 'exam_types', ['id', 'name', 'code', 'standard_duration_min', 'is_active']);
  },

  async _toggleExamType(typeId) {
    const type = (AppState.allExamTypes || AppState.examTypes || []).find(t => t.id === typeId);
    if (!type) return;
    try {
      await API.patch('exam_types', type.id, { is_active: type.is_active === false });
      await App.loadMasters();
      this._renderExamTypes(document.getElementById('settings-tab-body'));
    } catch (e) {
      UI.toast('状態の変更に失敗しました: ' + e.message, 'danger');
    }
  },

  _openExamTypeForm(type) {
    const isNew = !type;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:400px;">
        <div class="modal-header">
          <h2>${isNew ? '検査種別を追加' : '検査種別を編集'}</h2>
          <button class="modal-close-btn" id="et-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>検査種別名 <span style="color:#dc2626">*</span></label>
            <input type="text" id="et-name" value="${UI.escapeHTML(type?.name || '')}" placeholder="例: CT">
          </div>
          <div class="form-row">
            <label>コード <span style="color:#dc2626">*</span></label>
            <input type="text" id="et-code" value="${UI.escapeHTML(type?.code || '')}" placeholder="例: CT">
          </div>
          <div class="form-row">
            <label>標準所要時間 (分) <span style="color:#dc2626">*</span></label>
            <input type="number" id="et-duration" value="${UI.escapeHTML(type?.standard_duration_min || '')}" placeholder="例: 30">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="et-save">
            <i class="fas fa-save"></i> ${isNew ? '追加' : '保存'}
          </button>
          <button class="btn btn-outline" id="et-cancel">キャンセル</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById('et-close').onclick = close;
    document.getElementById('et-cancel').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    this._addEscapeClose(overlay, close);

    setTimeout(() => {
      document.getElementById('et-name')?.focus();
    }, 50);

    document.getElementById('et-save').onclick = async () => {
      const name = document.getElementById('et-name').value.trim();
      const code = document.getElementById('et-code').value.trim();
      const durationVal = document.getElementById('et-duration').value.trim();
      
      if (!name || !code || !durationVal) { UI.toast('すべての必須フィールドを入力してください', 'warning'); return; }
      
      const data = {
        name,
        code,
        standard_duration_min: parseInt(durationVal, 10),
      };

      try {
        if (isNew) {
          const newId = `exam-${code.toLowerCase()}-${Date.now()}`;
          await API.create('exam_types', { id: newId, ...data });
          UI.toast(`${name}を追加しました`, 'success');
        } else {
          await API.patch('exam_types', type.id, data);
          UI.toast(`${name}を更新しました`, 'success');
        }
        close();
        await App.loadMasters();
        this._renderExamTypes(document.getElementById('settings-tab-body'));
      } catch (e) {
        UI.toast('保存に失敗しました: ' + e.message, 'danger');
      }
    };
  },

});
