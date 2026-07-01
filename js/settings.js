/**
 * TransBoard - 設定画面
 * ・病床マスタ管理（CRUD）
 * ・検査室マスタ管理（電話番号含む）
 * ・病床マップ配置グリッドエディタ
 */

// ODBC読み取り専用安全対策: SQLクエリバリデーション
function validateReadOnlyQuery(sql) {
  if (!sql) return { valid: false, message: 'SQLクエリが空です。' };
  
  // コメントの除去 (ブロックコメントと行コメント)
  const cleanSql = sql.trim().replace(/\/\*[\s\S]*?\*\/|--.*$/gm, '');
  
  // SELECTまたはWITHで開始しているか検証 (先頭の括弧やスペースを考慮)
  if (!/^\(?(SELECT|WITH)\b/i.test(cleanSql)) {
    return { valid: false, message: '安全対策のため、SQLクエリは SELECT または WITH で開始する必要があります。' };
  }
  
  // 文字列リテラルを除去してからキーワード検証（リテラル内の単語への誤検知防止）
  const sqlWithoutStrings = cleanSql.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

  // 書き込み・変更系のキーワードを検出 (単語境界を使用)
  const forbiddenKeywords = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create',
    'truncate', 'replace', 'merge', 'grant', 'revoke',
    'exec', 'execute', 'into'
  ];

  for (const keyword of forbiddenKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(sqlWithoutStrings)) {
      return {
        valid: false,
        message: `安全対策のため、データベース書き込み/変更を伴う可能性のあるキーワード「${keyword.toUpperCase()}」は使用できません。`
      };
    }
  }
  
  // セミコロンによる複数ステートメントの検証 (文字列リテラル内を除く)
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let hasStatementsAfterSemicolon = false;
  
  for (let i = 0; i < cleanSql.length; i++) {
    const char = cleanSql[i];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      // セミコロンの後に空白以外の文字が続いているか検証
      const remaining = cleanSql.slice(i + 1).trim();
      if (remaining.length > 0) {
        hasStatementsAfterSemicolon = true;
        break;
      }
    }
  }
  
  if (hasStatementsAfterSemicolon) {
    return { valid: false, message: '安全対策のため、複数SQLステートメントの同時実行は禁止されています。' };
  }
  
  return { valid: true };
}

const Settings = {

  // 現在の設定タブ
  _activeTab: 'wards',

  // グリッドエディタ状態
  _grid: {
    cols: 10,
    rows: 7,
    cells: {},   // "col,row" => { bedId } | { empty: true } | null
    dragBedId: null,
    wardId: null,
  },

  _csvDataRows: [],

  updateImportPreview() {
    const previewContainer = document.getElementById('helper-preview-container');
    if (!previewContainer || !this._csvDataRows || this._csvDataRows.length === 0) return;

    const mapMode = document.getElementById('cfg-map-mode').value;
    const bedCol = document.getElementById('cfg-map-bed')?.value || '';
    const roomCol = document.getElementById('cfg-map-room')?.value || '';
    const bedCodeCol = document.getElementById('cfg-map-bed-code')?.value || '';
    const joinChar = document.getElementById('cfg-map-join')?.value || '-';
    
    const patIdCol = document.getElementById('cfg-map-pat-id')?.value || '';
    const patNameCol = document.getElementById('cfg-map-pat-name')?.value || '';
    const presentCol = document.getElementById('cfg-map-present')?.value || '';

    const tbody = document.querySelector('#helper-preview-table tbody');
    if (!tbody) return;
    let html = '';
    
    // 先頭5行をチェック
    const rowsToCheck = this._csvDataRows.slice(0, 5);
    let mismatchCount = 0;
    
    rowsToCheck.forEach((row, idx) => {
      let combinedBedNo = '';
      if (mapMode === 'single') {
        combinedBedNo = row[bedCol] || '';
      } else {
        const roomVal = row[roomCol] || '';
        const bedCodeVal = row[bedCodeCol] || '';
        combinedBedNo = (roomVal && bedCodeVal) ? `${roomVal}${joinChar}${bedCodeVal}` : (roomVal || bedCodeVal || '');
      }

      const patientName = row[patNameCol] || '';
      const isPresentVal = row[presentCol] || '';

      // マスタ（AppState.beds）に存在するか判定
      const exists = AppState.beds.some(b => String(b.bed_number).toLowerCase() === String(combinedBedNo).toLowerCase());
      
      let statusBadge = '';
      if (exists) {
        statusBadge = '<span style="color:#10b981; font-weight:800;"><i class="fas fa-check-circle"></i> 一致あり</span>';
      } else {
        statusBadge = '<span style="color:#ef4444; font-weight:800;"><i class="fas fa-times-circle"></i> マップに未登録</span>';
        mismatchCount++;
      }

      html += `
        <tr style="border-bottom:1px solid #f3f4f6;">
          <td style="padding:4px;">${idx + 1}</td>
          <td style="padding:4px; font-weight:bold;">${UI.escapeHTML(combinedBedNo) || '<span style="color:#a0aec0;font-style:italic;">なし</span>'}</td>
          <td style="padding:4px;">${UI.escapeHTML(patientName) || '<span style="color:#a0aec0;font-style:italic;">空</span>'}</td>
          <td style="padding:4px;">${UI.escapeHTML(isPresentVal) || '<span style="color:#a0aec0;font-style:italic;">なし</span>'}</td>
          <td style="padding:4px;">${statusBadge}</td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
    previewContainer.style.display = 'block';

    const errorNote = document.getElementById('helper-preview-error-note');
    if (errorNote) {
      if (mismatchCount > 0) {
        errorNote.innerHTML = `⚠️ マップ上に登録されていない病床番号が検出されました。病室コード、病床コード、および「結合文字」の設定が、マスタ（病床設定）と完全に一致しているか確認してください。`;
      } else {
        errorNote.innerHTML = `<span style="color:#10b981;">✅ すべてのテスト行がマップ上の既存病床と一致しました！</span>`;
      }
    }
  },

  render() {
    const cont = document.getElementById('settings-content');
    if (!cont) return;
    cont.innerHTML = `
      <div class="settings-tabs">
        <button class="settings-tab-btn ${this._activeTab==='wards'?'active':''}" data-stab="wards">
          <i class="fas fa-hospital"></i> 病棟マスタ<span class="stab-badge stab-badge--global">全体</span>
        </button>
        <button class="settings-tab-btn ${this._activeTab==='beds'?'active':''}" data-stab="beds">
          <i class="fas fa-bed"></i> 病床マスタ<span class="stab-badge stab-badge--global">全体</span>
        </button>
        <button class="settings-tab-btn ${this._activeTab==='bed_types'?'active':''}" data-stab="bed_types">
          <i class="fas fa-tags"></i> 病床タイプ<span class="stab-badge stab-badge--global">全体</span>
        </button>
        <button class="settings-tab-btn ${this._activeTab==='map'?'active':''}" data-stab="map">
          <i class="fas fa-map"></i> マップ配置<span class="stab-badge stab-badge--global">全体</span>
        </button>
        <button class="settings-tab-btn ${this._activeTab==='rooms'?'active':''}" data-stab="rooms">
          <i class="fas fa-x-ray"></i> 検査室マスタ<span class="stab-badge stab-badge--global">全体</span>
        </button>
        <button class="settings-tab-btn ${this._activeTab==='exam_types'?'active':''}" data-stab="exam_types">
          <i class="fas fa-notes-medical"></i> 検査種別<span class="stab-badge stab-badge--global">全体</span>
        </button>
        <button class="settings-tab-btn ${this._activeTab==='staffs'?'active':''}" data-stab="staffs">
          <i class="fas fa-user-nurse"></i> スタッフ<span class="stab-badge stab-badge--global">全体</span>
        </button>
        <span class="stab-sep"></span>
        <button class="settings-tab-btn ${this._activeTab==='import'?'active':''}" data-stab="import">
          <i class="fas fa-file-import"></i> 取り込み設定<span class="stab-badge stab-badge--parent">親機</span>
        </button>
        <button class="settings-tab-btn ${this._activeTab==='notifications'?'active':''}" data-stab="notifications">
          <i class="fas fa-bell"></i> 通知音設定<span class="stab-badge stab-badge--terminal">端末</span>
        </button>
        <button class="settings-tab-btn ${this._activeTab==='speech_templates'?'active':''}" data-stab="speech_templates">
          <i class="fas fa-bullhorn"></i> アナウンス定型文<span class="stab-badge stab-badge--global">全体</span>
        </button>
        <button class="settings-tab-btn ${this._activeTab==='schedule_feeds'?'active':''}" data-stab="schedule_feeds">
          <i class="fas fa-calendar-alt"></i> スケジュール取り込み<span class="stab-badge stab-badge--parent">親機</span>
        </button>
        <span class="stab-sep"></span>
        <button class="settings-tab-btn ${this._activeTab==='status_customize'?'active':''}" data-stab="status_customize">
          <i class="fas fa-sliders-h"></i> ステータスカスタマイズ<span class="stab-badge stab-badge--global">全体</span>
        </button>
        <button class="settings-tab-btn ${this._activeTab==='network'?'active':''}" data-stab="network">
          <i class="fas fa-network-wired"></i> 共有・ネットワーク設定<span class="stab-badge stab-badge--terminal">端末</span>
        </button>
      </div>
      <div id="settings-tab-body"></div>
    `;
    cont.querySelectorAll('.settings-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._activeTab = btn.dataset.stab;
        this.render();
      });
    });
    this._renderTab();
  },

  _renderTab() {
    const body = document.getElementById('settings-tab-body');
    if (!body) return;
    
    // キーボードショートカットの解除
    if (this._mapKeydownHandler) {
      window.removeEventListener('keydown', this._mapKeydownHandler);
      this._mapKeydownHandler = null;
    }

    if (this._activeTab === 'beds')          this._renderBeds(body);
    if (this._activeTab === 'bed_types')     this._renderBedTypes(body);
    if (this._activeTab === 'map')           this._renderMapEditor(body);
    if (this._activeTab === 'rooms')         this._renderRooms(body);
    if (this._activeTab === 'exam_types')    this._renderExamTypes(body);
    if (this._activeTab === 'staffs')        this._renderStaffs(body);
    if (this._activeTab === 'wards')         this._renderWards(body);
    if (this._activeTab === 'import')        this._renderImportSettings(body);
    if (this._activeTab === 'notifications') this._renderNotificationSettings(body);
    if (this._activeTab === 'speech_templates') this._renderSpeechTemplates(body);
    if (this._activeTab === 'schedule_feeds') this._renderScheduleFeeds(body);
    if (this._activeTab === 'network')       this._renderNetworkSettings(body);
    if (this._activeTab === 'status_customize') this._renderStatusCustomize(body);

    this._injectCategoryBanner(body);
  },

  // 設定タブ種別バナーを先頭に挿入
  _injectCategoryBanner(body) {
    const isChild = localStorage.getItem('cfg_share_mode') === 'client';
    const categories = {
      wards: 'global', beds: 'global', bed_types: 'global',
      map: 'global', rooms: 'global', exam_types: 'global',
      staffs: 'global', speech_templates: 'global',
      import: 'parent-only', schedule_feeds: 'parent-only',
      notifications: 'terminal', network: 'terminal',
    };
    const category = categories[this._activeTab];
    if (!category) return;

    let icon, title, desc, cls;
    if (category === 'global') {
      icon = 'fa-globe'; cls = 'settings-category-banner--global';
      title = '全体共通設定';
      desc  = 'この設定は親機に保存され、全端末に反映されます。';
    } else if (category === 'terminal') {
      icon = 'fa-laptop'; cls = 'settings-category-banner--terminal';
      title = '端末固有設定';
      desc  = 'この設定はこの端末にのみ適用されます。他の端末には影響しません。';
    } else {
      icon = 'fa-server'; cls = 'settings-category-banner--parent-only';
      title = '親機専用機能';
      desc  = isChild
        ? '実際の処理（ファイル監視・取り込み）は親機で実行されます。設定自体は子機からも変更できます。'
        : 'この機能は親機でのみ実行されます。';
    }
    const banner = document.createElement('div');
    banner.className = `settings-category-banner ${cls}`;
    banner.innerHTML = `<i class="fas ${icon}"></i><span><strong>${title}</strong> — ${desc}</span>`;
    body.insertBefore(banner, body.firstChild);
  },

  // ──────────────────────────────────
  //  病床マスタ管理
  // ──────────────────────────────────

  _renderBedTypes(body) {
    const types = (AppState.bedTypes || [])
      .slice()
      .sort((a, b) => (a.sort_order || 99) - (b.sort_order || 99));

    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-tags"></i> 病床タイプマスタ</h3>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-outline btn-sm" id="btn-export-bed_types"><i class="fas fa-file-download"></i> CSV出力</button>
            <button class="btn btn-outline btn-sm" id="btn-import-bed_types"><i class="fas fa-file-upload"></i> CSV入力</button>
            <button class="btn btn-primary btn-sm" id="btn-add-bed-type"><i class="fas fa-plus"></i> タイプ追加</button>
          </div>
        </div>
        <p class="settings-hint"><i class="fas fa-info-circle"></i> 病床に割り当てるタイプを管理します。ここで追加したタイプは病床マスタで選択できます。</p>
        <table class="settings-table">
          <thead><tr><th>表示名</th><th>コード</th><th>並び順</th><th>状態</th><th>操作</th></tr></thead>
          <tbody>
            ${types.map(type => `
              <tr>
                <td class="font-bold">${type.name}</td>
                <td><code>${type.code}</code></td>
                <td>${type.sort_order ?? '-'}</td>
                <td>${type.is_active === false ? '<span style="color:#64748b; font-weight:700;">無効</span>' : '<span style="color:#16a34a; font-weight:700;">有効</span>'}</td>
                <td>
                  <button class="btn btn-outline btn-sm btn-edit-bed-type" data-type-id="${type.id}"><i class="fas fa-edit"></i></button>
                  <button class="btn btn-outline btn-sm btn-toggle-bed-type" data-type-id="${type.id}" style="margin-left:4px;">${type.is_active === false ? '有効化' : '無効化'}</button>
                </td>
              </tr>
            `).join('') || '<tr><td colspan="5" class="text-muted">病床タイプが登録されていません</td></tr>'}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('btn-add-bed-type').onclick = () => this._openBedTypeForm(null);
    body.querySelectorAll('.btn-edit-bed-type').forEach(btn => {
      btn.onclick = () => {
        const type = (AppState.bedTypes || []).find(t => t.id === btn.dataset.typeId);
        this._openBedTypeForm(type);
      };
    });
    body.querySelectorAll('.btn-toggle-bed-type').forEach(btn => {
      btn.onclick = () => this._toggleBedType(btn.dataset.typeId);
    });
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
          <div class="form-row"><label>表示名 <span style="color:#dc2626">*</span></label><input type="text" id="bt-name" value="${type?.name || ''}" placeholder="例: 一般"></div>
          <div class="form-row"><label>コード <span style="color:#dc2626">*</span></label><input type="text" id="bt-code" value="${type?.code || ''}" placeholder="例: normal" ${isNew ? '' : 'disabled'}></div>
          <div class="form-row"><label>並び順</label><input type="number" id="bt-sort" value="${type?.sort_order ?? 99}" placeholder="例: 1"></div>
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
    const type = (AppState.bedTypes || []).find(t => t.id === typeId);
    if (!type) return;
    try {
      await API.patch('bed_types', type.id, { is_active: type.is_active === false });
      await App.loadMasters();
      this._renderBedTypes(document.getElementById('settings-tab-body'));
    } catch (e) {
      UI.toast('状態の変更に失敗しました: ' + e.message, 'danger');
    }
  },

  _renderBeds(body) {
    const wardId = AppState.currentWardId;
    const beds = AppState.beds.filter(b => b.ward_id === wardId)
                  .sort((a, b) => (a.sort_order||99) - (b.sort_order||99));
    const wardName = AppState.wards.find(w => w.id === wardId)?.name || '';

    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-bed"></i> 病床マスタ — ${wardName}</h3>
          <div style="display:flex; gap:8px;">
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
          病床番号・部屋番号・タイプを管理します。マップ上の配置は「マップ配置」タブで設定してください。
        </p>
        <table class="settings-table">
          <thead>
            <tr>
              <th>病室コード</th>
              <th>病床コード</th>
              <th>病床番号(結合)</th>
              <th>タイプ</th>
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

    body.querySelectorAll('.btn-edit-bed').forEach(btn => {
      btn.onclick = () => {
        const bed = AppState.beds.find(b => b.id === btn.dataset.bedId);
        this._openBedForm(bed);
      };
    });
    body.querySelectorAll('.btn-delete-bed').forEach(btn => {
      btn.onclick = () => this._deleteBed(btn.dataset.bedId);
    });

    this._setupCsvHandlers('beds', 'beds', ['id', 'ward_id', 'bed_number', 'room_number', 'room_code', 'bed_code', 'bed_type', 'note', 'map_col', 'map_row', 'sort_order']);
  },

  _bedRow(b) {
    const typeClass = AppState.normalizeBedTypeCode(b.bed_type);
    const label = AppState.getBedTypeLabel(b.bed_type);

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
        <td class="font-bold">${rCode || '-'}</td>
        <td class="font-bold">${bCode || '-'}</td>
        <td style="color:#718096; font-size:11px;">${b.bed_number}</td>
        <td><span class="bed-type-tag type-${typeClass}">${label}</span></td>
        <td>${b.note || '-'}</td>
        <td>
          <button class="btn btn-outline btn-sm btn-edit-bed" data-bed-id="${b.id}">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-danger btn-sm btn-delete-bed" data-bed-id="${b.id}" style="margin-left:4px;">
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

    const currentType = AppState.normalizeBedTypeCode(bed?.bed_type);
    const bedTypeOptions = (AppState.bedTypes || []).map(type => `
              <option value="${type.code}" ${currentType === type.code ? 'selected' : ''}>${type.name}</option>
    `).join('');

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
            <input type="text" id="bf-room-code" value="${roomCode}" placeholder="例: 701">
          </div>
          <div class="form-row">
            <label>病床コード</label>
            <input type="text" id="bf-bed-code" value="${bedCode}" placeholder="例: 1 (空欄可)">
          </div>
          <div class="form-row">
            <label>病床タイプ</label>
            <select id="bf-type">
              ${bedTypeOptions || '<option value="normal">一般</option>'}
            </select>
          </div>
          <div class="form-row">
            <label>備考</label>
            <input type="text" id="bf-note" value="${bed?.note||''}" placeholder="メモ">
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
        bed_type: document.getElementById('bf-type').value,
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
    if (!confirm(`${bed.bed_number}号床を削除しますか？\n※出棟履歴は残ります`)) return;
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

    this._drawMapEditor();
    this._drawPalette();

    document.getElementById('map-undo').onclick = () => this._undo();
    document.getElementById('map-redo').onclick = () => this._redo();

    document.getElementById('map-size-up-col').onclick   = () => { this._saveStateToHistory(); this._grid.cols = Math.min(20, this._grid.cols + 1); this._drawMapEditor(); };
    document.getElementById('map-size-down-col').onclick = () => { this._saveStateToHistory(); this._grid.cols = Math.max(4, this._grid.cols - 1);  this._drawMapEditor(); };
    document.getElementById('map-size-up-row').onclick   = () => { this._saveStateToHistory(); this._grid.rows = Math.min(16, this._grid.rows + 1); this._drawMapEditor(); };
    document.getElementById('map-size-down-row').onclick = () => { this._saveStateToHistory(); this._grid.rows = Math.max(2, this._grid.rows - 1);  this._drawMapEditor(); };
    document.getElementById('map-save-all').onclick = () => this._saveMapLayout();
  },

  _drawPalette() {
    const el = document.getElementById('palette-beds');
    if (!el) return;
    const wardId = AppState.currentWardId;
    // 未配置 = map_col が null の病床
    const unplaced = AppState.beds.filter(b =>
      b.ward_id === wardId && (b.map_col === null || b.map_col === undefined)
    ).sort((a, b) => a.bed_number.localeCompare(b.bed_number, 'ja', { numeric: true }));

    if (unplaced.length === 0) {
      el.innerHTML = '<div class="text-muted text-sm" style="padding:8px;">全病床が配置済みです</div>';
    } else {
      el.innerHTML = unplaced.map(b => `
        <div class="palette-bed-item" draggable="true" data-bed-id="${b.id}">
          <i class="fas fa-bed"></i> ${b.bed_number}
          <span class="text-xs text-muted">${b.room_number || ''}</span>
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
          <span>${bed ? bed.bed_number : '?'}</span>
          ${bed?.room_number ? `<span class="map-cell-room">${bed.room_number}</span>` : ''}
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
      
      const promises = [];
      for (const [key, cell] of Object.entries(this._grid.cells)) {
        if (cell?.bedId) {
          const [col, row] = key.split(',').map(Number);
          promises.push(API.patch('beds', cell.bedId, { map_col: col, map_row: row }));
        }
      }
      // 未配置のものは null に更新
      for (const bed of beds) {
        const placed = Object.values(this._grid.cells).some(c => c?.bedId === bed.id);
        if (!placed) {
          promises.push(API.patch('beds', bed.id, { map_col: null, map_row: null }));
        }
      }

      // 廊下や壁を含めたセルデータ全体を JSON 文字列として system_settings に保存
      const layoutData = {
        cols: this._grid.cols,
        rows: this._grid.rows,
        cells: this._grid.cells
      };
      
      promises.push(API.create('system_settings', {
        id: `map_layout_${wardId}`,
        value: JSON.stringify(layoutData)
      }));

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
            <tr><th>検査室名</th><th>コード</th><th>階</th><th>内線番号</th><th>備考</th><th>有効</th><th>操作</th></tr>
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
        <tr style="${r.is_active === false ? 'opacity:0.5;' : ''}">
          <td class="font-bold">${r.name}</td>
          <td>${r.code}</td>
          <td>${r.floor}</td>
          <td>
            ${r.phone
              ? `<span class="phone-chip"><i class="fas fa-phone"></i> ${r.phone}</span>`
              : '<span class="text-muted">未設定</span>'}
          </td>
          <td class="text-sm text-muted">${r.note||'—'}</td>
          <td>${r.is_active !== false ? '<i class="fas fa-check-circle" style="color:#16a34a"></i>' : '<i class="fas fa-times-circle" style="color:#94a3b8"></i>'}</td>
          <td>
            <button class="btn btn-outline btn-sm btn-edit-room" data-room-id="${r.id}">
              <i class="fas fa-edit"></i>
            </button>
          </td>
        </tr>
      `).join('') || '<tr><td colspan="7" class="text-muted" style="text-align:center;">検査室が登録されていません</td></tr>';

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

    this._setupCsvHandlers('rooms', 'exam_rooms', ['id', 'name', 'code', 'floor', 'phone', 'note', 'is_active']);
  },

  _openRoomForm(room) {
    const isNew = !room;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:440px;">
        <div class="modal-header">
          <h2>${isNew ? '検査室を追加' : '検査室を編集'}</h2>
          <button class="modal-close-btn" id="room-form-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>検査室名 <span style="color:#dc2626">*</span></label>
            <input type="text" id="rf-name" value="${room?.name||''}" placeholder="例: CT室">
          </div>
          <div class="form-row">
            <label>コード <span style="color:#dc2626">*</span></label>
            <input type="text" id="rf-code" value="${room?.code||''}" placeholder="例: CT">
          </div>
          <div class="form-row">
            <label>階</label>
            <input type="text" id="rf-floor" value="${room?.floor||''}" placeholder="例: 2F">
          </div>
          <div class="form-row">
            <label><i class="fas fa-phone"></i> 内線番号</label>
            <input type="text" id="rf-phone" value="${room?.phone||''}" placeholder="例: 2001">
          </div>
          <div class="form-row">
            <label>備考</label>
            <input type="text" id="rf-note" value="${room?.note||''}" placeholder="メモ">
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
    const staffs = AppState.staffs.filter(s => s.ward_id === wardId);
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
          <thead><tr><th>名前</th><th>役職</th><th>有効</th><th>操作</th></tr></thead>
          <tbody>
            ${staffs.map(s => `
              <tr>
                <td class="font-bold">${s.name}</td>
                <td>${roleLabel[s.role]||s.role}</td>
                <td>${s.is_active ? '<i class="fas fa-check-circle" style="color:#16a34a"></i>' : '<i class="fas fa-times-circle" style="color:#94a3b8"></i>'}</td>
                <td>
                  <button class="btn btn-outline btn-sm btn-edit-staff" data-staff-id="${s.id}">
                    <i class="fas fa-edit"></i>
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
        const s = AppState.staffs.find(x => x.id === btn.dataset.staffId);
        this._openStaffForm(s);
      };
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
            <input type="text" id="sf-name" value="${staff?.name||''}" placeholder="例: 田中 花子">
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

  async _renderImportSettings(body) {
    // マスタから設定レコードを取得
    const dirSetting = AppState.systemSettings?.find(s => s.id === 'import_directory') || { value: '' };
    const currentPath = dirSetting.value || '（デフォルト: プロジェクト内の import_folder フォルダ）';

    const smbAuthSetting = AppState.systemSettings?.find(s => s.id === 'smb_auth_mode') || { value: 'current' };
    const smbUsernameSetting = AppState.systemSettings?.find(s => s.id === 'smb_username') || { value: '' };
    const smbPasswordSetting = AppState.systemSettings?.find(s => s.id === 'smb_password') || { value: '' };

    const mappingSetting = AppState.systemSettings?.find(s => s.id === 'import_mapping');
    let mapping = { bed_number: '', patient_id: '', patient_name: '', is_present: '' };
    if (mappingSetting && mappingSetting.value) {
      try { mapping = JSON.parse(mappingSetting.value); } catch(e) {}
    }

    const scheduleSetting = AppState.systemSettings?.find(s => s.id === 'import_schedule');
    let schedule = { mode: 'realtime', intervalMin: '10', times: [] };
    if (scheduleSetting && scheduleSetting.value) {
      try { schedule = JSON.parse(scheduleSetting.value); } catch(e) {}
    }

    const policySetting = AppState.systemSettings?.find(s => s.id === 'import_retention_policy');
    let policy = { action: 'archive', retentionDays: '30', clearUnlisted: false };
    if (policySetting && policySetting.value) {
      try { policy = JSON.parse(policySetting.value); } catch(e) {}
    }

    const connTypeSetting = AppState.systemSettings?.find(s => s.id === 'import_connection_type') || { value: 'csv' };
    const odbcConnSetting = AppState.systemSettings?.find(s => s.id === 'odbc_connection_string') || { value: 'DSN=EMR_DB;UID=admin;PWD=admin_pass;' };
    const odbcQuerySetting = AppState.systemSettings?.find(s => s.id === 'odbc_sql_query') || { value: 'SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS' };
    const admissionModeSetting = AppState.systemSettings?.find(s => s.id === 'admission_mode') || { value: 'csv' };

    // インポートログの取得
    let logs = [];
    try {
      const logsRes = await API.getAll('import_logs');
      logs = (logsRes.data || []).sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
    } catch (e) {
      console.error('[Settings] ログの取得失敗:', e);
    }

    const logRowsHtml = logs.length === 0
      ? '<tr><td colspan="5" class="text-center text-muted" style="padding:15px;">インポート履歴データがありません</td></tr>'
      : logs.map(l => {
        let badgeCls = 'badge-IN_BED';
        let statusLabel = '成功';
        if (l.status === 'success') { badgeCls = 'badge-RETURNED'; statusLabel = '成功'; }
        else if (l.status === 'warning') { badgeCls = 'badge-NEARLY_DONE'; statusLabel = '警告'; }
        else if (l.status === 'failed') { badgeCls = 'badge-PICKUP_REQUIRED'; statusLabel = '失敗'; }
        else if (l.status === 'archive_error') { badgeCls = 'badge-NEARLY_DONE'; statusLabel = '移動エラー'; }

        return `
          <tr>
            <td>${UI.formatDateTime(l.timestamp)}</td>
            <td class="font-bold">${l.fileName}</td>
            <td><span class="status-badge ${badgeCls}" style="padding:2px 6px; font-size:10px; border-radius:3px; display:inline-block; font-weight:800;">${statusLabel}</span></td>
            <td>${l.message || ''}</td>
            <td class="text-muted text-sm">${l.details || ''}</td>
          </tr>
        `;
      }).join('');

    const admMode = admissionModeSetting.value || 'csv';
    body.innerHTML = `
      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-procedures"></i> 在室管理モード</h3>
          <button class="btn btn-primary btn-sm" id="btn-save-admission-mode"><i class="fas fa-save"></i> 保存</button>
        </div>
        <p class="settings-hint"><i class="fas fa-info-circle"></i>
          患者の在室情報をどのように管理するか選択します。モードはいつでも変更できます。
        </p>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px;" id="admission-mode-cards">
          ${[
            { key:'csv',    icon:'fa-file-csv',    title:'CSV連携モード',  color:'#3b82f6',
              desc:'電子カルテからCSV/ODBCで在室データを自動取り込みします。病床カードへの患者登録はシステムが行います。' },
            { key:'manual', icon:'fa-hand-pointer', title:'手動登録モード', color:'#16a34a',
              desc:'スタッフが病床カードをクリックして患者を手動で登録・退院します。CSVインポートは使用しません。' },
            { key:'hybrid', icon:'fa-code-branch',  title:'ハイブリッドモード', color:'#7c3aed',
              desc:'CSV自動取り込みと手動登録を併用します。手動登録した病床はCSVの自動クリアから保護されます。' },
          ].map(m => `
            <label class="admission-mode-card ${admMode===m.key?'selected':''}" data-mode="${m.key}"
              style="border:2px solid ${admMode===m.key ? m.color : '#e2e8f0'};border-radius:10px;padding:14px;cursor:pointer;
                     background:${admMode===m.key ? m.color+'14' : '#fafafa'};display:flex;flex-direction:column;gap:8px;transition:all .15s;">
              <input type="radio" name="admission-mode" value="${m.key}" ${admMode===m.key?'checked':''} style="display:none;">
              <div style="display:flex;align-items:center;gap:8px;">
                <i class="fas ${m.icon}" style="font-size:20px;color:${m.color};"></i>
                <strong style="font-size:13px;color:#1e293b;">${m.title}</strong>
              </div>
              <p style="font-size:11.5px;color:#475569;margin:0;line-height:1.5;">${m.desc}</p>
            </label>
          `).join('')}
        </div>
      </div>

      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-file-import"></i> 自動取り込み連携設定</h3>
        </div>
        <div style="margin-bottom:16px; padding:12px; background:#fffbeb; border:1px solid #fef3c7; border-radius:8px; color:#b45309; font-size:12.5px; display:flex; align-items:flex-start; gap:10px;">
          <i class="fas fa-exclamation-triangle" style="margin-top:2px; font-size:16px; color:#d97706;"></i>
          <div>
            <strong style="display:block; margin-bottom:2px; font-weight:700;">【親機専用設定】</strong>
            <span style="font-size:11.5px; line-height:1.5; color:#92400e;">
              この「データ取り込み連携設定」は、データベースを直接所持している**親機（サーバー）のPCでのみ実行**されます。子機（クライアント）PC上では設定を変更できますが、実際のファイルスキャンや同期のバックグラウンド処理は行われません。
            </span>
          </div>
        </div>
        <p class="settings-hint">
          <i class="fas fa-info-circle"></i>
          電子カルテ連携用データの監視パス、スケジュール、カラム対応定義を設定します。
        </p>

        <!-- 接続タイプ選択 -->
        <div style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0; margin-top:16px; margin-bottom:16px;">
          <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-plug"></i> 連携方式の選択</h4>
          <div style="display:flex; gap:24px;">
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px; font-weight:600;">
              <input type="radio" name="import-conn-type" value="csv" ${connTypeSetting.value === 'csv' ? 'checked' : ''}>
              CSVファイル監視連携
            </label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px; font-weight:600;">
              <input type="radio" name="import-conn-type" value="odbc" ${connTypeSetting.value === 'odbc' ? 'checked' : ''}>
              ODBCデータベース直接同期
            </label>
          </div>
        </div>
        
        <div class="settings-form-grid" style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
          
          <!-- 左カラム：パス・マッピング・スケジュール -->
          <div style="display:flex; flex-direction:column; gap:16px;">
            
            <!-- 1. 監視フォルダパス (CSV用) -->
            <div id="csv-folder-panel" style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0; display:${connTypeSetting.value === 'csv' ? 'block' : 'none'};">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-folder-open"></i> 監視対象フォルダ</h4>
              <div class="form-row" style="margin-bottom:12px;">
                <label>絶対パス</label>
                <input type="text" id="cfg-import-path" placeholder="例: C:\\HospitalData\\Import" style="width:100%; padding:8px; border:1px solid #cbd5e0; border-radius:6px;" value="${dirSetting.value || ''}">
                <div style="margin-top:6px; font-size:11px; color:#718096;">
                  <strong>現在の有効な監視先:</strong> <code style="background:#edf2f7; padding:2px 6px; border-radius:4px;">${currentPath}</code>
                </div>
              </div>
              
              <!-- SMBネットワーク共有認証 -->
              <div style="border-top:1px dashed #cbd5e0; margin-top:12px; margin-bottom:12px; padding-top:12px;">
                <label style="font-size:12px; font-weight:700; color:#4a5568;"><i class="fas fa-network-wired"></i> SMB共有アクセス権限（ネットワークパス用）</label>
                <select id="cfg-smb-auth-mode" style="width:100%; padding:6px; margin-top:4px; border:1px solid #cbd5e0; border-radius:6px; font-size:12px; cursor:pointer;">
                  <option value="current" ${smbAuthSetting.value === 'current' ? 'selected' : ''}>現在のサインインユーザー権限を使用 (標準)</option>
                  <option value="custom" ${smbAuthSetting.value === 'custom' ? 'selected' : ''}>別のユーザー権限（認証情報を指定）</option>
                </select>
                
                <div id="smb-custom-credentials" style="display:${smbAuthSetting.value === 'custom' ? 'flex' : 'none'}; flex-direction:column; gap:8px; margin-top:8px;">
                  <div class="form-row">
                    <label style="font-size:11px; margin-bottom:2px;">ユーザー名 (Domain\\User もしくは User)</label>
                    <input type="text" id="cfg-smb-username" placeholder="例: domain\\username" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${smbUsernameSetting.value}">
                  </div>
                  <div class="form-row">
                    <label style="font-size:11px; margin-bottom:2px;">パスワード</label>
                    <input type="password" id="cfg-smb-password" placeholder="パスワードを入力" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${smbPasswordSetting.value}">
                  </div>
                </div>
              </div>

              <div style="display:flex; gap:8px;">
                <button class="btn btn-outline btn-sm" id="btn-manual-import" style="flex:1;">
                  <i class="fas fa-sync-alt"></i> 今すぐフォルダスキャン実行
                </button>
              </div>
            </div>

            <!-- 1. ODBC接続設定 (ODBC用) -->
            <div id="odbc-conn-panel" style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0; display:${connTypeSetting.value === 'odbc' ? 'block' : 'none'};">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-database"></i> ODBC接続設定 (電子カルテDB連携)</h4>
              
              <!-- 読み取り専用安全対策の通知 -->
              <div style="margin-bottom:16px; padding:12px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; color:#166534; font-size:12px; display:flex; align-items:flex-start; gap:10px;">
                <i class="fas fa-shield-alt" style="margin-top:2px; font-size:16px; color:#15803d;"></i>
                <div>
                  <strong style="display:block; margin-bottom:4px; font-weight:600; color:#14532d;">読み取り専用安全対策モード適用中</strong>
                  <span style="font-size:11px; line-height:1.5; color:#166534; display:block;">
                    電子カルテDBの誤操作・誤書き込みを防ぐため、以下の安全フィルタが有効化されています。
                  </span>
                  <ul style="margin:6px 0 0 0; padding-left:16px; font-size:11px; color:#166534; line-height:1.5;">
                    <li>接続文字列の末尾に自動的に読み取り専用属性（<code>ReadOnly=1</code>等）が付与されます。</li>
                    <li>データ抽出クエリは<code>SELECT</code>文のみ許可され、更新・削除などのクエリは自動遮断されます。</li>
                  </ul>
                </div>
              </div>

              <!-- ODBC設定パネル -->
              <div class="odbc-settings-panel">

                <!-- ① DSN選択 -->
                <div class="odbc-section">
                  <div class="odbc-section-title"><i class="fas fa-database"></i> データソース名 (DSN)</div>
                  <div style="display:flex; gap:8px; align-items:flex-end;">
                    <div style="flex:1;">
                      <label class="odbc-label">システム/ユーザーDSN <span class="odbc-hint-inline">— Windowsに登録済みのデータソース</span></label>
                      <select id="odbc-dsn-select" class="odbc-input">
                        <option value="">⏳ 読み込み中...</option>
                      </select>
                    </div>
                    <button class="btn btn-outline btn-sm" id="btn-odbc-refresh-dsn" title="DSN一覧を再取得">
                      <i class="fas fa-sync-alt"></i>
                    </button>
                  </div>
                  <div id="odbc-dsn-driver-info" style="font-size:11px; color:#64748b; margin-top:4px; min-height:16px;"></div>

                  <details style="margin-top:8px;">
                    <summary style="font-size:11px; color:#3b82f6; cursor:pointer; user-select:none;">DSNが一覧にない場合（手動入力）</summary>
                    <div style="margin-top:6px;">
                      <label class="odbc-label">DSN名を直接入力</label>
                      <input type="text" id="odbc-dsn-manual" class="odbc-input" placeholder="例: EMR_DB">
                    </div>
                  </details>
                </div>

                <!-- ② 認証 -->
                <div class="odbc-section">
                  <div class="odbc-section-title"><i class="fas fa-key"></i> 認証</div>
                  <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    <div>
                      <label class="odbc-label">ユーザー名 (UID) <span class="odbc-hint-inline">Windows認証なら空欄</span></label>
                      <input type="text" id="odbc-wiz-user" class="odbc-input" placeholder="例: readonly_user">
                    </div>
                    <div>
                      <label class="odbc-label">パスワード (PWD) <span class="odbc-hint-inline">Windows認証なら空欄</span></label>
                      <input type="password" id="odbc-wiz-pass" class="odbc-input" placeholder="••••••••">
                    </div>
                  </div>
                </div>

                <!-- ③ 接続文字列プレビュー -->
                <div class="odbc-section">
                  <div class="odbc-section-title"><i class="fas fa-code"></i> 接続文字列 <span class="odbc-hint-inline">— 上の設定から自動生成。直接編集も可</span></div>
                  <input type="text" id="cfg-odbc-conn" class="odbc-input odbc-mono"
                    placeholder="DSN=EMR_DB;UID=user;PWD=pass;"
                    value="${odbcConnSetting.value}">
                </div>

                <!-- ④ SQLクエリ -->
                <div class="odbc-section">
                  <div class="odbc-section-title"><i class="fas fa-table"></i> データ抽出SQLクエリ</div>
                  <div style="display:flex; gap:8px; align-items:flex-end; margin-bottom:4px;">
                    <div style="flex:1;">
                      <label class="odbc-label">ビュー / テーブル名</label>
                      <div style="display:flex; gap:6px; align-items:center;">
                        <select id="odbc-wiz-table" class="odbc-input" style="flex:1;">
                          <option value="">— DSNを選択後に取得 —</option>
                        </select>
                        <button class="btn btn-outline btn-sm" id="btn-odbc-fetch-tables" title="テーブル/ビュー一覧を取得" style="white-space:nowrap; flex-shrink:0;">
                          <i class="fas fa-cloud-download-alt"></i> 取得
                        </button>
                      </div>
                      <div id="odbc-table-status" style="font-size:11px; color:#64748b; margin-top:3px; min-height:14px;"></div>
                    </div>
                    <button class="btn btn-outline btn-sm" id="btn-odbc-build-query" style="white-space:nowrap; align-self:flex-end; margin-bottom:18px;">
                      <i class="fas fa-magic"></i> SQL生成
                    </button>
                  </div>
                  <textarea id="cfg-odbc-query" rows="3" class="odbc-input odbc-mono"
                    placeholder="SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS">${odbcQuerySetting.value}</textarea>
                  <div style="font-size:11px; color:#64748b; margin-top:3px;">
                    必須カラム: <code>BED_NO</code>, <code>PATIENT_ID</code>, <code>PATIENT_NAME</code>, <code>IS_PRESENT</code>（在床=1）
                  </div>
                </div>

                <!-- ⑤ テスト・同期 -->
                <div class="odbc-section" style="border:none; padding-bottom:0;">
                  <div style="display:flex; gap:8px;">
                    <button class="btn btn-outline btn-sm" id="btn-odbc-test" style="flex:1;">
                      <i class="fas fa-vial"></i> 接続テスト
                    </button>
                    <button class="btn btn-primary btn-sm" id="btn-odbc-sync" style="flex:1;">
                      <i class="fas fa-sync"></i> 今すぐ同期
                    </button>
                  </div>
                  <div id="odbc-test-result" style="margin-top:8px; font-size:12px; min-height:18px;"></div>
                </div>

              </div>
            </div>
 
            <!-- 2. カラムマッピング (共通) -->
            <div style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0;">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-table"></i> カラムマッピング (ヘッダー名 / SQL列名)</h4>
              
              <!-- 列割り当て初期設定アシスタント -->
              <div style="background:#eff6ff; padding:12px; border-radius:8px; border:1px solid #bfdbfe; margin-bottom:12px; font-size:12px;">
                <strong style="color:#1e40af; display:block; margin-bottom:4px;"><i class="fas fa-magic"></i> 列割り当て初期設定アシスタント (CSV対応)</strong>
                <span style="color:#4b5563; display:block; margin-bottom:8px;">
                  連携用CSVファイルを読み込ませることで、ヘッダー行から列をプルダウン選択＆自動予測マッピングできます。
                </span>
                
                <div style="display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-bottom:10px;">
                  <div>
                    <input type="file" id="btn-helper-csv-file" accept=".csv" style="display:none;">
                    <button class="btn btn-outline btn-sm" id="btn-trigger-helper" style="background:#ffffff; font-weight:700; border-color:#93c5fd; color:#2563eb;">
                      <i class="fas fa-file-csv"></i> サンプルCSVを選択
                    </button>
                    <span id="helper-file-status" style="margin-left:6px; color:#4b5563; font-style:italic;">選択されていません</span>
                  </div>
                  <div style="display:flex; align-items:center; gap:4px;">
                    <span style="color:#4b5563;">文字コード:</span>
                    <select id="helper-csv-encoding" style="padding:4px; font-size:11px; border:1px solid #cbd5e0; border-radius:4px; background:#fff;">
                      <option value="shift-jis" selected>Shift-JIS (Excel標準)</option>
                      <option value="utf-8">UTF-8</option>
                    </select>
                  </div>
                </div>

                <!-- リアルタイムプレビュー＆マップ整合性検査 -->
                <div id="helper-preview-container" style="display:none; margin-top:12px; padding:10px; background:#fff; border:1px solid #d1d5db; border-radius:6px;">
                  <strong style="color:#1e3a8a; display:block; margin-bottom:6px;"><i class="fas fa-eye"></i> インポートプレビュー・整合性チェック (先頭5行)</strong>
                  <div style="overflow-x:auto;">
                    <table style="width:100%; border-collapse:collapse; font-size:11px; text-align:left; min-width:300px;" id="helper-preview-table">
                      <thead>
                        <tr style="background:#f3f4f6; border-bottom:1px solid #e5e7eb;">
                          <th style="padding:4px;">行</th>
                          <th style="padding:4px;">結合病床名</th>
                          <th style="padding:4px;">患者氏名</th>
                          <th style="padding:4px;">在床</th>
                          <th style="padding:4px;">マップ登録状況</th>
                        </tr>
                      </thead>
                      <tbody>
                        <!-- 動的生成 -->
                      </tbody>
                    </table>
                  </div>
                  <div style="font-size:10px; color:#ef4444; margin-top:6px; font-weight:700;" id="helper-preview-error-note"></div>
                </div>
              </div>

              <p style="font-size:11px; color:#718096; margin:0 0 12px 0;">取得元カラム名（またはSQL抽出列名）を指定します。病床の特定方法は【単一の列】または【病室コードと病床コードの組み合わせ】を選択できます。</p>
              
              <div class="form-row" style="margin-bottom:10px;">
                <label style="font-size:12px;">病床の特定方法</label>
                <select id="cfg-map-mode" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;">
                  <option value="single" ${(!mapping.room_code || !mapping.bed_code) ? 'selected':''}>単一のカラム (例: bed_number)</option>
                  <option value="combined" ${(mapping.room_code && mapping.bed_code) ? 'selected':''}>病室コード＋病床コードの組み合わせ</option>
                </select>
              </div>

              <!-- 単一カラム指定用 -->
              <div id="map-single-container" class="form-row" style="margin-bottom:8px; display:${(!mapping.room_code || !mapping.bed_code) ? 'flex':'none'}; align-items:center; gap:8px;">
                <label style="width:120px; font-size:12px; margin:0;">病床番号 <span style="color:#dc2626">*</span></label>
                <input type="text" id="cfg-map-bed" placeholder="bed_number" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.bed_number || ''}">
              </div>

              <!-- 複数カラム指定用 -->
              <div id="map-combined-container" style="display:${(mapping.room_code && mapping.bed_code) ? 'block':'none'};">
                <div class="form-row" style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                  <label style="width:120px; font-size:12px; margin:0;">病室コード <span style="color:#dc2626">*</span></label>
                  <input type="text" id="cfg-map-room" placeholder="room_code" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.room_code || ''}">
                </div>
                <div class="form-row" style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                  <label style="width:120px; font-size:12px; margin:0;">病床コード <span style="color:#dc2626">*</span></label>
                  <input type="text" id="cfg-map-bed-code" placeholder="bed_code" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.bed_code || ''}">
                </div>
                <div class="form-row" style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                  <label style="width:120px; font-size:12px; margin:0;">結合文字</label>
                  <select id="cfg-map-join" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;">
                    <option value="-" ${mapping.join_char==='-'?'selected':''}>ハイフン (-) (例: 701-A)</option>
                    <option value="" ${mapping.join_char===''?'selected':''}>なし (例: 701A)</option>
                    <option value="/" ${mapping.join_char==='/'?'selected':''}>スラッシュ (/) (例: 701/A)</option>
                    <option value="_" ${mapping.join_char==='_'?'selected':''}>アンダーバー (_) (例: 701_A)</option>
                  </select>
                </div>
              </div>

              <div class="form-row" style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                <label style="width:120px; font-size:12px; margin:0;">患者ID</label>
                <input type="text" id="cfg-map-pat-id" placeholder="patient_id" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.patient_id || ''}">
              </div>
              <div class="form-row" style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                <label style="width:120px; font-size:12px; margin:0;">患者氏名</label>
                <input type="text" id="cfg-map-pat-name" placeholder="patient_name" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.patient_name || ''}">
              </div>
              <div class="form-row" style="margin-bottom:0; display:flex; align-items:center; gap:8px;">
                <label style="width:120px; font-size:12px; margin:0;">在床ステータス</label>
                <input type="text" id="cfg-map-present" placeholder="is_present" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.is_present || ''}">
              </div>
            </div>

          </div>

          <!-- 右カラム：スケジュール・整理ポリシー -->
          <div style="display:flex; flex-direction:column; gap:16px;">
            
            <!-- 3. スケジュール設定 (CSV用) -->
            <div id="csv-schedule-panel" style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0; display:${connTypeSetting.value === 'csv' ? 'block' : 'none'};">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-clock"></i> 同期スケジュール</h4>
              <div class="form-row" style="margin-bottom:10px;">
                <label>実行モード</label>
                <select id="cfg-sched-mode" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;">
                  <option value="realtime" ${schedule.mode==='realtime'?'selected':''}>リアルタイム監視 (即時実行)</option>
                  <option value="interval" ${schedule.mode==='interval'?'selected':''}>定期的な自動実行 (間隔指定)</option>
                  <option value="time"     ${schedule.mode==='time'?'selected':''}>指定した時刻に実行 (複数可)</option>
                </select>
              </div>
              
              <div id="sched-interval-container" class="form-row" style="margin-bottom:0; display:${schedule.mode==='interval'?'block':'none'};">
                <label>実行間隔 (分)</label>
                <select id="cfg-sched-interval" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;">
                  <option value="1"  ${schedule.intervalMin==='1'?'selected':''}>1分ごと (デモ・開発用)</option>
                  <option value="5"  ${schedule.intervalMin==='5'?'selected':''}>5分ごと</option>
                  <option value="10" ${schedule.intervalMin==='10'?'selected':''}>10分ごと</option>
                  <option value="30" ${schedule.intervalMin==='30'?'selected':''}>30分ごと</option>
                  <option value="60" ${schedule.intervalMin==='60'?'selected':''}>1時間ごと</option>
                </select>
              </div>

              <div id="sched-time-container" class="form-row" style="margin-bottom:0; display:${schedule.mode==='time'?'block':'none'};">
                <label>実行時刻 (半角コンマ区切りで複数指定可 例: 08:30,13:00,18:00)</label>
                <input type="text" id="cfg-sched-times" placeholder="08:00, 13:00" style="width:100%; padding:8px; border:1px solid #cbd5e0; border-radius:4px;" value="${(schedule.times || []).join(', ')}">
              </div>
            </div>

            <!-- 4. 整理ポリシー (CSV用) -->
            <div id="csv-policy-panel" style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0; display:${connTypeSetting.value === 'csv' ? 'block' : 'none'};">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-shield-alt"></i> 個人情報保護・整理ポリシー</h4>
              <div class="form-row" style="margin-bottom:10px;">
                <label>処理完了後のファイル処理</label>
                <select id="cfg-policy-action" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;">
                  <option value="archive" ${policy.action==='archive'?'selected':''}>archiveフォルダに退避して保管</option>
                  <option value="delete"  ${policy.action==='delete'?'selected':''}>インポート後に即時物理削除 (推奨・高セキュリティ)</option>
                  <option value="skip"    ${policy.action==='skip'?'selected':''}>そのまま残す (移動・削除しない / 権限エラー回避)</option>
                </select>
              </div>

              <div id="policy-skip-warn" style="margin:0 0 10px 0; font-size:12px; color:#744210; background:#fffbeb; border:1px solid #f6ad55; border-radius:4px; padding:6px 8px; display:${policy.action==='skip'?'block':'none'};">
                ⚠️ 取り込み済みの CSV ファイルが監視フォルダに蓄積し続けます。定期的な手動整理が必要です。
              </div>

              <div id="policy-days-container" class="form-row" style="margin-bottom:10px; display:${policy.action==='archive'?'block':'none'};">
                <label>退避ファイルの保管期間</label>
                <select id="cfg-policy-days" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;">
                  <option value="7"  ${policy.retentionDays==='7'?'selected':''}>7日間 (1週間)</option>
                  <option value="30" ${policy.retentionDays==='30'?'selected':''}>30日間 (約1ヶ月)</option>
                  <option value="90" ${policy.retentionDays==='90'?'selected':''}>90日間 (約3ヶ月)</option>
                  <option value="0"  ${policy.retentionDays==='0'?'selected':''}>無期限 (手動クリーンアップ)</option>
                </select>
              </div>

              <div class="form-row" style="margin-bottom:0;">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:normal;">
                  <input type="checkbox" id="cfg-policy-clear-unlisted" ${policy.clearUnlisted?'checked':''} style="width:16px; height:16px; cursor:pointer;">
                  CSVに載っていない病床の患者情報を空床にする
                </label>
                <p style="margin:4px 0 0 24px; font-size:12px; color:#718096;">在室患者のみ出力するEMRを使用している場合はONにしてください。CSVに行が存在しない病床を退院済みとみなして自動的にクリアします。</p>
                <p id="cfg-clear-unlisted-warn" style="margin:6px 0 0 24px; font-size:12px; color:#c53030; background:#fff5f5; border:1px solid #feb2b2; border-radius:4px; padding:6px 8px; display:${policy.clearUnlisted?'block':'none'};">
                  ⚠️ 注意: CSVが空だった場合や全行がスキップされた場合でも、掲載されていない病床の患者情報がクリアされます（空CSV時は自動でスキップします）。移送進行中の患者は保護されます。
                </p>
              </div>
            </div>

          </div>
        </div>

        <!-- 表示オプション -->
        <div style="margin-top:20px; padding:14px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;">
          <div style="font-weight:700; font-size:13px; color:#2d3748; margin-bottom:12px;">
            <i class="fas fa-eye"></i> ヘッダー表示オプション
          </div>
          <div style="display:flex; gap:24px; flex-wrap:wrap;">
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; color:#374151;">
              <input type="checkbox" id="cfg-show-sync-time" style="width:16px; height:16px; cursor:pointer;">
              最終同期時間を表示する
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; color:#374151;">
              <input type="checkbox" id="cfg-show-import-time" style="width:16px; height:16px; cursor:pointer;">
              最終データ取り込み時間を表示する
            </label>
          </div>
          <div style="font-size:11px; color:#94a3b8; margin-top:8px;">画面上部ヘッダーに表示する時刻情報を切り替えます。</div>
        </div>

        <div style="margin-top:16px; display:flex; justify-content:flex-end;">
          <button class="btn btn-primary" id="btn-save-import-all" style="padding:10px 24px; font-weight:700;">
            <i class="fas fa-save"></i> 連携設定を保存
          </button>
        </div>

        <!-- 5. 直近の取り込みログ一覧 -->
        <div style="margin-top:30px; border-top: 1px solid #e2e8f0; padding-top:20px;">
          <h4 style="margin:0 0 12px 0; font-size:15px; color:#2d3748;"><i class="fas fa-history"></i> 直近の自動インポート履歴</h4>
          <table class="settings-table" style="font-size:12px; width:100%;">
            <thead>
              <tr><th style="width:130px;">日時</th><th>ファイル名</th><th style="width:80px;">状態</th><th>内容</th><th>詳細結果</th></tr>
            </thead>
            <tbody>
              ${logRowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // 連携方式選択変更イベント
    const connRadios = body.querySelectorAll('input[name="import-conn-type"]');
    connRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        const isCsv = e.target.value === 'csv';
        document.getElementById('csv-folder-panel').style.display = isCsv ? 'block' : 'none';
        document.getElementById('csv-schedule-panel').style.display = isCsv ? 'block' : 'none';
        document.getElementById('csv-policy-panel').style.display = isCsv ? 'block' : 'none';
        document.getElementById('odbc-conn-panel').style.display = isCsv ? 'none' : 'block';
      });
    });

    // 今すぐフォルダスキャン実行ボタンイベント
    document.getElementById('btn-manual-import').onclick = async () => {
      const btn = document.getElementById('btn-manual-import');
      btn.disabled = true;
      const oldHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> スキャン中...';
      try {
        if (window.electronAPI && window.electronAPI.triggerManualImport) {
          const res = await window.electronAPI.triggerManualImport();
          if (res.success) {
            if (res.count > 0) {
              UI.toast(`📂 ${res.message}`, 'success');
            } else {
              UI.toast(`📂 ${res.message}`, 'info');
            }
            await App.loadMasters();
            this.render();
          } else {
            UI.toast(`❌ スキャンに失敗しました: ${res.message}`, 'danger');
          }
        } else {
          UI.toast('デスクトップ環境でのみ実行可能です', 'warning');
        }
      } catch (e) {
        UI.toast(`エラーが発生しました: ${e.message}`, 'danger');
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    };

    // ── DSN一覧を取得してドロップダウンに反映 ────────────────
    const _loadDsnList = async () => {
      const sel = document.getElementById('odbc-dsn-select');
      if (!sel) return;
      sel.innerHTML = '<option value="">⏳ 読み込み中...</option>';
      try {
        const data = window.electronAPI?.getOdbcDsns
          ? await window.electronAPI.getOdbcDsns()
          : { system: [], user: [], drivers: [] };

        const opts = ['<option value="">— DSNを選択 —</option>'];
        if (data.system.length) {
          opts.push('<optgroup label="システムDSN">');
          data.system.forEach(d => opts.push(`<option value="${d.name}" data-driver="${d.driver}">[SYS] ${d.name}（${d.driver}）</option>`));
          opts.push('</optgroup>');
        }
        if (data.user.length) {
          opts.push('<optgroup label="ユーザーDSN">');
          data.user.forEach(d => opts.push(`<option value="${d.name}" data-driver="${d.driver}">[USER] ${d.name}（${d.driver}）</option>`));
          opts.push('</optgroup>');
        }
        if (!data.system.length && !data.user.length) {
          opts.push('<option value="" disabled>DSNが見つかりませんでした</option>');
        }
        sel.innerHTML = opts.join('');

        // 現在の接続文字列からDSN名を復元して選択状態にする
        const currentConn = document.getElementById('cfg-odbc-conn')?.value || '';
        const m = currentConn.match(/DSN=([^;]+)/i);
        if (m) {
          const currentDsn = m[1].trim();
          const found = [...sel.options].find(o => o.value === currentDsn);
          if (found) sel.value = currentDsn;
        }
        _onDsnChange();
      } catch (e) {
        sel.innerHTML = '<option value="">取得失敗 — 手動入力を使用してください</option>';
      }
    };

    const _onDsnChange = () => {
      const sel = document.getElementById('odbc-dsn-select');
      const info = document.getElementById('odbc-dsn-driver-info');
      const selected = sel?.options[sel.selectedIndex];
      const driver = selected?.dataset?.driver || '';
      if (info) info.textContent = driver ? `ドライバ: ${driver}` : '';
      _rebuildConnStr();
    };

    const _rebuildConnStr = () => {
      const selVal    = document.getElementById('odbc-dsn-select')?.value || '';
      const manualVal = document.getElementById('odbc-dsn-manual')?.value?.trim() || '';
      const dsn  = selVal || manualVal;
      const user = document.getElementById('odbc-wiz-user')?.value?.trim() || '';
      const pass = document.getElementById('odbc-wiz-pass')?.value || '';
      if (!dsn) return;
      const parts = [`DSN=${dsn}`];
      if (user) { parts.push(`UID=${user}`); parts.push(`PWD=${pass}`); }
      else parts.push('Trusted_Connection=Yes');
      parts.push('ReadOnly=1');
      const el = document.getElementById('cfg-odbc-conn');
      if (el) el.value = parts.join(';') + ';';
    };

    document.getElementById('odbc-dsn-select')?.addEventListener('change', _onDsnChange);
    document.getElementById('odbc-dsn-manual')?.addEventListener('input', _rebuildConnStr);
    document.getElementById('odbc-wiz-user')?.addEventListener('input', _rebuildConnStr);
    document.getElementById('odbc-wiz-pass')?.addEventListener('input', _rebuildConnStr);

    document.getElementById('btn-odbc-refresh-dsn')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-odbc-refresh-dsn');
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      await _loadDsnList();
      btn.innerHTML = '<i class="fas fa-sync-alt"></i>';
    });

    // SQL生成ボタン
    document.getElementById('btn-odbc-build-query')?.addEventListener('click', () => {
      const table = _getSelectedTable() || 'V_BED_STATUS';
      const q = document.getElementById('cfg-odbc-query');
      if (q) q.value = `SELECT BED_NO AS bed_number, PATIENT_ID AS patient_id, PATIENT_NAME AS patient_name, IS_PRESENT AS is_present FROM ${table}`;
      // カラムマッピングも自動設定
      const mapMode = document.getElementById('cfg-map-mode');
      if (mapMode) { mapMode.value = 'single'; document.getElementById('map-single-container').style.display='flex'; document.getElementById('map-combined-container').style.display='none'; }
      if (document.getElementById('cfg-map-bed'))      document.getElementById('cfg-map-bed').value = 'bed_number';
      if (document.getElementById('cfg-map-pat-id'))   document.getElementById('cfg-map-pat-id').value = 'patient_id';
      if (document.getElementById('cfg-map-pat-name')) document.getElementById('cfg-map-pat-name').value = 'patient_name';
      if (document.getElementById('cfg-map-present'))  document.getElementById('cfg-map-present').value = 'is_present';
      Settings.updateImportPreview();
      UI.toast('SQL・カラムマッピングを反映しました。保存ボタンで確定してください。', 'success');
    });

    // テーブル/ビュー一覧を取得してドロップダウンに反映
    const _loadTableList = async () => {
      const connStr = document.getElementById('cfg-odbc-conn')?.value?.trim();
      const sel     = document.getElementById('odbc-wiz-table');
      const status  = document.getElementById('odbc-table-status');
      const btn     = document.getElementById('btn-odbc-fetch-tables');
      if (!connStr) { UI.toast('先に接続文字列を設定してください', 'warning'); return; }

      const prevVal = sel?.value;
      if (btn)    { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
      if (status) status.textContent = '取得中...';
      if (sel)    sel.innerHTML = '<option value="">取得中...</option>';

      try {
        const res = window.electronAPI?.getOdbcTables
          ? await window.electronAPI.getOdbcTables({ connectionString: connStr })
          : { success: false, error: 'デスクトップ環境が必要です', tables: [] };

        if (!res.success) {
          if (sel)    sel.innerHTML = '<option value="">取得失敗 — 手動入力</option><option value="__manual__">手動で入力...</option>';
          if (status) status.innerHTML = `<span style="color:#dc2626;"><i class="fas fa-times-circle"></i> ${UI.escapeHTML(res.error)}</span>`;
          return;
        }

        const views  = res.tables.filter(t => t.type === 'VIEW');
        const tables = res.tables.filter(t => t.type === 'TABLE' || t.type === 'SYSTEM TABLE');
        const opts   = ['<option value="">— 選択 —</option>'];
        if (views.length)  { opts.push('<optgroup label="ビュー">');  views.forEach(t => opts.push(`<option value="${UI.escapeHTML(t.name)}">${UI.escapeHTML(t.name)}</option>`));  opts.push('</optgroup>'); }
        if (tables.length) { opts.push('<optgroup label="テーブル">'); tables.forEach(t => opts.push(`<option value="${UI.escapeHTML(t.name)}">${UI.escapeHTML(t.name)}</option>`)); opts.push('</optgroup>'); }
        opts.push('<option value="__manual__">手動で入力...</option>');
        if (sel) {
          sel.innerHTML = opts.join('');
          if (prevVal && [...sel.options].some(o => o.value === prevVal)) sel.value = prevVal;
        }
        if (status) status.innerHTML = `<span style="color:#16a34a;"><i class="fas fa-check-circle"></i> ${res.tables.length} 件取得（ビュー ${views.length} / テーブル ${tables.length}）</span>`;
      } catch (e) {
        if (sel)    sel.innerHTML = '<option value="">エラー</option>';
        if (status) status.innerHTML = `<span style="color:#dc2626;">${UI.escapeHTML(e.message)}</span>`;
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> 取得'; }
      }
    };

    document.getElementById('btn-odbc-fetch-tables')?.addEventListener('click', _loadTableList);

    // 「手動で入力...」選択時に入力欄を表示
    document.getElementById('odbc-wiz-table')?.addEventListener('change', (e) => {
      const manualArea = document.getElementById('odbc-table-manual-area');
      if (e.target.value === '__manual__') {
        if (!manualArea) {
          const div = document.createElement('div');
          div.id = 'odbc-table-manual-area';
          div.style.marginTop = '4px';
          div.innerHTML = '<input type="text" id="odbc-table-manual-input" class="odbc-input" placeholder="テーブル/ビュー名を入力">';
          e.target.parentNode.after(div);
          div.querySelector('input').focus();
        }
      } else {
        manualArea?.remove();
      }
    });

    // SQL生成ボタン — selectとmanual inputの両方に対応
    const _getSelectedTable = () => {
      const sel = document.getElementById('odbc-wiz-table');
      if (sel?.value === '__manual__') {
        return document.getElementById('odbc-table-manual-input')?.value?.trim() || '';
      }
      return sel?.value || '';
    };

    // DSN一覧を初回ロード
    _loadDsnList();

    // ODBC接続テストボタンイベント
    document.getElementById('btn-odbc-test').onclick = async () => {
      const btn = document.getElementById('btn-odbc-test');
      const resultEl = document.getElementById('odbc-test-result');
      btn.disabled = true;
      const oldHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 接続テスト中...';
      if (resultEl) resultEl.innerHTML = '';
      try {
        const conn = document.getElementById('cfg-odbc-conn').value.trim();
        const query = document.getElementById('cfg-odbc-query').value.trim();
        if (window.electronAPI && window.electronAPI.testOdbcConnection) {
          const res = await window.electronAPI.testOdbcConnection({ connectionString: conn, sqlQuery: query });
          if (res.success) {
            if (resultEl) resultEl.innerHTML = `<span style="color:#16a34a;font-weight:700;"><i class="fas fa-check-circle"></i> ${UI.escapeHTML(res.message)}</span>`;
            UI.toast('ODBC接続テスト成功', 'success');
          } else {
            if (resultEl) resultEl.innerHTML = `<span style="color:#dc2626;font-weight:700;"><i class="fas fa-times-circle"></i> ${UI.escapeHTML(res.message)}</span>`;
            UI.toast(`接続失敗: ${res.message}`, 'danger');
          }
        } else {
          if (resultEl) resultEl.innerHTML = '<span style="color:#d97706;">デスクトップ環境でのみ実行可能です</span>';
        }
      } catch (e) {
        if (resultEl) resultEl.innerHTML = `<span style="color:#dc2626;">${UI.escapeHTML(e.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    };

    // ODBC同期実行ボタンイベント
    document.getElementById('btn-odbc-sync').onclick = async () => {
      const btn = document.getElementById('btn-odbc-sync');
      btn.disabled = true;
      const oldHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 同期実行中...';
      try {
        const conn = document.getElementById('cfg-odbc-conn').value.trim();
        const query = document.getElementById('cfg-odbc-query').value.trim();
        if (window.electronAPI && window.electronAPI.runOdbcSync) {
          const res = await window.electronAPI.runOdbcSync({ connectionString: conn, sqlQuery: query });
          if (res.success) {
            UI.toast(`✅ データベース同期が完了しました (${res.count}件のレコードを処理)`, 'success');
            await App.loadMasters();
            await App.refreshData();
            this.render();
          } else {
            UI.toast(`❌ 同期失敗: ${res.message}`, 'danger');
          }
        } else {
          UI.toast('デスクトップ環境でのみ実行可能です', 'warning');
        }
      } catch (e) {
        UI.toast(`エラー: ${e.message}`, 'danger');
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    };

    // UI要素のイベントバインド（条件表示切替）
    const modeSelect = document.getElementById('cfg-sched-mode');
    modeSelect.addEventListener('change', (e) => {
      document.getElementById('sched-interval-container').style.display = e.target.value === 'interval' ? 'block' : 'none';
      document.getElementById('sched-time-container').style.display = e.target.value === 'time' ? 'block' : 'none';
    });

    const policySelect = document.getElementById('cfg-policy-action');
    policySelect.addEventListener('change', (e) => {
      document.getElementById('policy-days-container').style.display = e.target.value === 'archive' ? 'block' : 'none';
      document.getElementById('policy-skip-warn').style.display = e.target.value === 'skip' ? 'block' : 'none';
    });

    document.getElementById('cfg-policy-clear-unlisted')?.addEventListener('change', (e) => {
      document.getElementById('cfg-clear-unlisted-warn').style.display = e.target.checked ? 'block' : 'none';
    });

    const smbModeSelect = document.getElementById('cfg-smb-auth-mode');
    if (smbModeSelect) {
      smbModeSelect.addEventListener('change', (e) => {
        document.getElementById('smb-custom-credentials').style.display = e.target.value === 'custom' ? 'block' : 'none';
      });
    }

    // 列割り当て初期設定アシスタント（CSV読み込み＆プルダウン化）
    const triggerBtn = document.getElementById('btn-trigger-helper');
    const fileInput = document.getElementById('btn-helper-csv-file');
    const fileStatus = document.getElementById('helper-file-status');
    const encodingSelect = document.getElementById('helper-csv-encoding');
    
    if (triggerBtn && fileInput) {
      let helperFile = null;
      triggerBtn.onclick = () => fileInput.click();
      
      const isUtf8 = (buf) => {
        let i = 0;
        while (i < buf.length) {
          if (buf[i] <= 0x7F) {
            i += 1;
          } else if ((buf[i] & 0xE0) === 0xC0) {
            if (i + 1 >= buf.length || (buf[i + 1] & 0xC0) !== 0x80) return false;
            i += 2;
          } else if ((buf[i] & 0xF0) === 0xE0) {
            if (i + 2 >= buf.length || (buf[i + 1] & 0xC0) !== 0x80 || (buf[i + 2] & 0xC0) !== 0x80) return false;
            i += 3;
          } else if ((buf[i] & 0xF8) === 0xF0) {
            if (i + 3 >= buf.length || (buf[i + 1] & 0xC0) !== 0x80 || (buf[i + 2] & 0xC0) !== 0x80 || (buf[i + 3] & 0xC0) !== 0x80) return false;
            i += 4;
          } else {
            return false;
          }
        }
        return true;
      };

      const processHelperFile = (file, skipAutoDetect = false) => {
        if (!file) return;
        fileStatus.textContent = file.name;

        const runReader = (encoding) => {
          const reader = new FileReader();
          reader.onload = (evt) => {
            const text = evt.target.result;
            const lines = text.split(/\r?\n/);
            if (lines.length === 0 || !lines[0]) {
              UI.toast('ファイルが空か、正しい形式ではありません', 'warning');
              return;
            }
            
            // ヘッダーパース（カンマ分割）
            const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim()).filter(Boolean);
            if (headers.length === 0) {
              UI.toast('ヘッダー列が検出されませんでした', 'warning');
              return;
            }
            
            UI.toast(`📂 CSVから ${headers.length} 個の列名を検出しました。`, 'success');
            
            // CSVデータ行をオブジェクト配列にパースして保持
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
              if (!lines[i].trim()) continue;
              const rowValues = lines[i].split(',').map(v => v.replace(/^"|"$/g, '').trim());
              const rowObj = {};
              headers.forEach((h, colIdx) => {
                rowObj[h] = rowValues[colIdx] || '';
              });
              rows.push(rowObj);
            }
            Settings._csvDataRows = rows;
          
          // 入力要素をセレクトボックスに動的置換
          const replaceInputWithSelect = (inputId, curVal) => {
            const input = document.getElementById(inputId);
            if (!input) return;
            
            const parent = input.parentElement;
            let select;
            if (input.tagName === 'SELECT') {
              select = input;
            } else {
              select = document.createElement('select');
              select.id = inputId;
              select.style.cssText = input.style.cssText;
              select.style.width = '100%';
              select.style.padding = '6px';
              select.style.border = '1px solid #cbd5e0';
              select.style.borderRadius = '4px';
              select.style.fontSize = '12px';
              select.className = input.className;
              parent.replaceChild(select, input);
            }
            
            let optHtml = `<option value="">-- マッピングしない --</option>`;
            headers.forEach(h => {
              optHtml += `<option value="${h}" ${h === curVal ? 'selected' : ''}>${h}</option>`;
            });
            optHtml += `<option value="__custom__">その他 (直接入力)</option>`;
            if (curVal && !headers.includes(curVal)) {
              optHtml += `<option value="${curVal}" selected>${curVal} (保存された値)</option>`;
            }
            select.innerHTML = optHtml;
            
            select.onchange = (ev) => {
              if (ev.target.value === '__custom__') {
                const txtInput = document.createElement('input');
                txtInput.type = 'text';
                txtInput.id = inputId;
                txtInput.style.cssText = select.style.cssText;
                txtInput.className = select.className;
                txtInput.placeholder = '直接列名を入力';
                select.parentElement.replaceChild(txtInput, select);
                txtInput.oninput = () => Settings.updateImportPreview();
              } else {
                Settings.updateImportPreview();
              }
            };
          };

          replaceInputWithSelect('cfg-map-bed', mapping.bed_number);
          replaceInputWithSelect('cfg-map-room', mapping.room_code);
          replaceInputWithSelect('cfg-map-bed-code', mapping.bed_code);
          replaceInputWithSelect('cfg-map-pat-id', mapping.patient_id);
          replaceInputWithSelect('cfg-map-pat-name', mapping.patient_name);
          replaceInputWithSelect('cfg-map-present', mapping.is_present);
          
          // 自動予測マッピング
          const autoMatchColumn = (selectId, keywords) => {
            const select = document.getElementById(selectId);
            if (!select || select.tagName !== 'SELECT') return;
            for (const h of headers) {
              const lowerH = h.toLowerCase();
              for (const kw of keywords) {
                if (lowerH.includes(kw.toLowerCase())) {
                  select.value = h;
                  return;
                }
              }
            }
          };

          autoMatchColumn('cfg-map-bed', ['bed', 'bed_number', 'ベッド', '病床', '病床番号', '床番号']);
          autoMatchColumn('cfg-map-room', ['room', 'room_code', '病室', '部屋コード']);
          autoMatchColumn('cfg-map-bed-code', ['bed_code', 'bedcode', 'ベッドコード', '床コード']);
          autoMatchColumn('cfg-map-pat-id', ['patient_id', 'id', '患者id', '患者番号', '患者コード']);
          autoMatchColumn('cfg-map-pat-name', ['patient_name', 'name', '氏名', '名前', '患者名', '患者氏名']);
          autoMatchColumn('cfg-map-present', ['is_present', 'present', 'status', '在床', '在床フラグ', '在床区分']);
          
          // プレビューの更新
          Settings.updateImportPreview();
        };

        reader.readAsText(file, encoding);
      };

      if (skipAutoDetect) {
          const encoding = encodingSelect ? encodingSelect.value : 'shift-jis';
          runReader(encoding);
        } else {
          const detectReader = new FileReader();
          detectReader.onload = (evt) => {
            const arrBuf = evt.target.result;
            const uint8 = new Uint8Array(arrBuf);
            const isUtf = isUtf8(uint8);
            const resolvedEncoding = isUtf ? 'utf-8' : 'shift-jis';
            if (encodingSelect) {
              encodingSelect.value = resolvedEncoding;
            }
            runReader(resolvedEncoding);
          };
          detectReader.readAsArrayBuffer(file);
        }
      };

      fileInput.onchange = (e) => {
        helperFile = e.target.files[0];
        if (helperFile) processHelperFile(helperFile, false);
      };

      if (encodingSelect) {
        encodingSelect.onchange = () => {
          if (helperFile) processHelperFile(helperFile, true);
        };
      }
    }

    const mapModeSelect = document.getElementById('cfg-map-mode');
    mapModeSelect.addEventListener('change', (e) => {
      document.getElementById('map-single-container').style.display = e.target.value === 'single' ? 'flex' : 'none';
      document.getElementById('map-combined-container').style.display = e.target.value === 'combined' ? 'block' : 'none';
      Settings.updateImportPreview();
    });

    const mapJoinSelect = document.getElementById('cfg-map-join');
    if (mapJoinSelect) {
      mapJoinSelect.addEventListener('change', () => {
        Settings.updateImportPreview();
      });
    }

    // 在室管理モードカード選択イベント
    body.querySelectorAll('.admission-mode-card').forEach(card => {
      card.addEventListener('click', () => {
        const colors = { csv: '#3b82f6', manual: '#16a34a', hybrid: '#7c3aed' };
        body.querySelectorAll('.admission-mode-card').forEach(c => {
          const m = c.dataset.mode;
          c.style.borderColor = '#e2e8f0';
          c.style.background = '#fafafa';
          c.querySelector('input').checked = false;
        });
        const m = card.dataset.mode;
        card.style.borderColor = colors[m];
        card.style.background = colors[m] + '14';
        card.querySelector('input').checked = true;
      });
    });

    // 在室管理モード保存
    document.getElementById('btn-save-admission-mode').onclick = async () => {
      const selected = body.querySelector('input[name="admission-mode"]:checked')?.value || 'csv';
      try {
        await API.patch('system_settings', 'admission_mode', { value: selected });
        const rec = AppState.systemSettings?.find(s => s.id === 'admission_mode');
        if (rec) rec.value = selected;
        else AppState.systemSettings?.push({ id: 'admission_mode', value: selected });
        const labels = { csv: 'CSV連携モード', manual: '手動登録モード', hybrid: 'ハイブリッドモード' };
        UI.toast(`在室管理モードを「${labels[selected]}」に変更しました`, 'success');
      } catch (e) {
        UI.toast('保存に失敗しました: ' + e.message, 'danger');
      }
    };

    // 保存ボタンイベント
    document.getElementById('btn-save-import-all').onclick = async () => {
      const saveBtn = document.getElementById('btn-save-import-all');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';

      const pathInput = document.getElementById('cfg-import-path');
      const newPath = pathInput.value.trim();

      const selectedConnType = body.querySelector('input[name="import-conn-type"]:checked').value;
      const odbcConnVal = document.getElementById('cfg-odbc-conn').value.trim();
      const odbcQueryVal = document.getElementById('cfg-odbc-query').value.trim();

      const smbAuthMode = document.getElementById('cfg-smb-auth-mode').value;
      const smbUsername = document.getElementById('cfg-smb-username').value.trim();
      const smbPassword = document.getElementById('cfg-smb-password').value;

      // マッピング構築
      const mapMode = mapModeSelect.value;
      const mappingData = {
        bed_number: mapMode === 'single' ? document.getElementById('cfg-map-bed').value.trim() : '',
        room_code: mapMode === 'combined' ? document.getElementById('cfg-map-room').value.trim() : '',
        bed_code: mapMode === 'combined' ? document.getElementById('cfg-map-bed-code').value.trim() : '',
        join_char: mapMode === 'combined' ? document.getElementById('cfg-map-join').value : '-',
        patient_id: document.getElementById('cfg-map-pat-id').value.trim(),
        patient_name: document.getElementById('cfg-map-pat-name').value.trim(),
        is_present: document.getElementById('cfg-map-present').value.trim(),
        encoding: document.getElementById('helper-csv-encoding')?.value || 'shift-jis',
      };

      if (mapMode === 'single' && !mappingData.bed_number) {
        UI.toast('単一カラム指定の場合、「病床番号」は必須項目です。', 'warning');
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 連携設定を保存';
        return;
      }
      if (mapMode === 'combined' && (!mappingData.room_code || !mappingData.bed_code)) {
        UI.toast('組み合わせ指定の場合、「病室コード」と「病床コード」は必須項目です。', 'warning');
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 連携設定を保存';
        return;
      }

      // スケジュール構築
      const scheduleMode = modeSelect.value;
      const intervalMin = document.getElementById('cfg-sched-interval').value;
      const timesStr = document.getElementById('cfg-sched-times').value;
      const timesArray = timesStr.split(',').map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));
      
      if (scheduleMode === 'time' && timesArray.length === 0) {
        UI.toast('「時刻指定モード」の時は有効な時刻(例: 08:30)を1つ以上入力してください。', 'warning');
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 連携設定を保存';
        return;
      }

      const scheduleData = {
        mode: scheduleMode,
        intervalMin: intervalMin,
        times: timesArray
      };

      // ポリシー構築
      const policyAction = policySelect.value;
      const retentionDays = document.getElementById('cfg-policy-days').value;
      const clearUnlisted = document.getElementById('cfg-policy-clear-unlisted')?.checked ?? false;

      const policyData = {
        action: policyAction,
        retentionDays: retentionDays,
        clearUnlisted: clearUnlisted
      };

      try {
        const promises = [
          API.patch('system_settings', 'import_directory', { value: newPath }),
          API.patch('system_settings', 'import_mapping', { value: JSON.stringify(mappingData) }),
          API.patch('system_settings', 'import_schedule', { value: JSON.stringify(scheduleData) }),
          API.patch('system_settings', 'import_retention_policy', { value: JSON.stringify(policyData) }),
          API.patch('system_settings', 'import_connection_type', { value: selectedConnType }),
          API.patch('system_settings', 'odbc_connection_string', { value: odbcConnVal }),
          API.patch('system_settings', 'odbc_sql_query', { value: odbcQueryVal }),
          API.patch('system_settings', 'smb_auth_mode', { value: smbAuthMode }),
          API.patch('system_settings', 'smb_username', { value: smbUsername }),
          API.patch('system_settings', 'smb_password', { value: smbPassword }),
        ];

        await Promise.all(promises);

        // AppStateのキャッシュも更新
        const updateSetting = (id, val) => {
          const obj = AppState.systemSettings?.find(s => s.id === id);
          if (obj) obj.value = val;
          else AppState.systemSettings.push({ id, value: val });
        };
        updateSetting('smb_auth_mode', smbAuthMode);
        updateSetting('smb_username', smbUsername);
        updateSetting('smb_password', smbPassword);

        // メインプロセスへ変更通知（監視先およびトリガーを再設定）
        if (window.electronAPI && window.electronAPI.updateWatchDirectory) {
          await window.electronAPI.updateWatchDirectory(newPath);
        }

        UI.toast('連携設定を保存しました。監視フォルダ・ポリシーは即時反映されます。スケジュール変更は次の検知タイミングから有効です。', 'success', 6000);
        
        await App.loadMasters();
        this.render();
      } catch (err) {
        console.error(err);
        UI.toast('設定の保存に失敗しました: ' + err.message, 'danger');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 連携設定を保存';
      }
    };
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

        if (!confirm(`「${ward.name}」を削除しますか？`)) return;

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

        if (window.App && window.App.syncWardSelect) {
          window.App.syncWardSelect();
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
      let str = String(val);
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

  _setupCsvHandlers(tabName, tableName, headers) {
    const exportBtn = document.getElementById(`btn-export-${tabName}`);
    const importBtn = document.getElementById(`btn-import-${tabName}`);
    
    if (exportBtn) {
      exportBtn.onclick = () => {
        let data = [];
        if (tableName === 'wards') data = AppState.wards;
        else if (tableName === 'beds') data = AppState.beds.filter(b => b.ward_id === AppState.currentWardId);
        else if (tableName === 'exam_rooms') data = AppState.allExamRooms || AppState.examRooms;
        else if (tableName === 'exam_types') data = AppState.examTypes;
        else if (tableName === 'staffs') data = AppState.staffs.filter(s => s.ward_id === AppState.currentWardId);
        
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
              const missing = headers.filter(h => !csvHeaders.includes(h));
              if (missing.length > 0) {
                UI.toast(`ヘッダーが一致しません。不足: ${missing.join(', ')}`, 'danger');
                return;
              }
              
              let importedCount = 0;
              for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (row.length === 0 || (row.length === 1 && !row[0])) continue;
                
                const record = {};
                headers.forEach(h => {
                  const idx = csvHeaders.indexOf(h);
                  let val = row[idx] !== undefined ? row[idx].trim() : '';
                  
                  // Convert fields to expected types
                  if (h === 'map_col' || h === 'map_row' || h === 'sort_order' || h === 'standard_duration_min') {
                    val = val === '' ? null : parseInt(val, 10);
                  } else if (h === 'is_active') {
                    val = (val === 'true' || val === '1' || val === true);
                  } else {
                    if (val === 'true') val = true;
                    else if (val === 'false') val = false;
                    else if (val === 'null') val = null;
                  }
                  
                  record[h] = val;
                });
                
                if (tableName === 'beds' || tableName === 'staffs') {
                  record.ward_id = record.ward_id || AppState.currentWardId;
                }
                
                if (!record.id) {
                  record.id = `${tableName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                }
                
                await API.create(tableName, record);
                importedCount++;
              }
              
              UI.toast(`CSVから ${importedCount} 件のマスタデータを取り込み/更新しました。`, 'success');
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
          <div style="display:flex; gap:8px;">
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
            <tr><th>検査種別名</th><th>コード</th><th>標準所要時間(分)</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${AppState.examTypes.map(t => `
              <tr>
                <td class="font-bold">${t.name}</td>
                <td>${t.code}</td>
                <td>${t.standard_duration_min}分</td>
                <td>
                  <button class="btn btn-outline btn-sm btn-edit-exam-type" data-type-id="${t.id}">
                    <i class="fas fa-edit"></i>
                  </button>
                  <button class="btn btn-danger btn-sm btn-delete-exam-type" data-type-id="${t.id}" style="margin-left:4px;">
                    <i class="fas fa-trash"></i>
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('btn-add-exam-type').onclick = () => this._openExamTypeForm(null);
    body.querySelectorAll('.btn-edit-exam-type').forEach(btn => {
      btn.onclick = () => {
        const type = AppState.examTypes.find(t => t.id === btn.dataset.typeId);
        this._openExamTypeForm(type);
      };
    });
    body.querySelectorAll('.btn-delete-exam-type').forEach(btn => {
      btn.onclick = () => this._deleteExamType(btn.dataset.typeId);
    });

    this._setupCsvHandlers('exam_types', 'exam_types', ['id', 'name', 'code', 'standard_duration_min']);
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
            <input type="text" id="et-name" value="${type?.name||''}" placeholder="例: CT">
          </div>
          <div class="form-row">
            <label>コード <span style="color:#dc2626">*</span></label>
            <input type="text" id="et-code" value="${type?.code||''}" placeholder="例: CT">
          </div>
          <div class="form-row">
            <label>標準所要時間 (分) <span style="color:#dc2626">*</span></label>
            <input type="number" id="et-duration" value="${type?.standard_duration_min||''}" placeholder="例: 30">
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

  async _deleteExamType(typeId) {
    const type = AppState.examTypes.find(t => t.id === typeId);
    if (!type) return;
    if (!confirm(`${type.name}を削除しますか？`)) return;
    try {
      await API.remove('exam_types', typeId);
      UI.toast(`${type.name}を削除しました`, 'info');
      await App.loadMasters();
      this._renderExamTypes(document.getElementById('settings-tab-body'));
    } catch (e) {
      UI.toast('削除に失敗しました', 'danger');
    }
  },

  // ──────────────────────────────────
  //  通知音設定管理
  // ──────────────────────────────────
  _renderNotificationSettings(body) {
    const isChildMode = localStorage.getItem('cfg_share_mode') === 'client';

    // 通知音設定
    let soundSettings = {
      PICKUP_REQUIRED: { enabled: true,  sound: 'alarm', toast: true },
      NEARLY_DONE:     { enabled: true,  sound: 'chime', toast: true },
      SOON:            { enabled: true,  sound: 'chime', toast: true },
      DEPART_REGISTERED: { enabled: false, sound: 'ding', toast: true },
      MOVING:          { enabled: false, sound: 'ding', toast: true },
      ARRIVED:         { enabled: false, sound: 'ding', toast: true },
      IN_EXAM:         { enabled: false, sound: 'ding', toast: true },
      RETURNED:        { enabled: false, sound: 'ding', toast: true },
    };
    const localSoundsRaw = isChildMode ? localStorage.getItem('tbs_notification_sounds') : null;
    if (localSoundsRaw) {
      try { soundSettings = { ...soundSettings, ...JSON.parse(localSoundsRaw) }; } catch(e) {}
    } else {
      const rec = AppState.systemSettings?.find(s => s.id === 'notification_sounds');
      if (rec?.value) try { soundSettings = { ...soundSettings, ...JSON.parse(rec.value) }; } catch(e) {}
    }

    // 着信音
    const incomingRingSound = isChildMode
      ? (localStorage.getItem('tbs_incoming_ring_sound') || 'ring')
      : (AppState.systemSettings?.find(s => s.id === 'incoming_ring_sound')?.value || 'ring');

    // 音量
    const localVol = isChildMode ? localStorage.getItem('tbs_notification_volume') : null;
    const volume = localVol !== null
      ? parseInt(localVol, 10)
      : parseInt(AppState.systemSettings?.find(s => s.id === 'notification_volume')?.value || '80', 10);

    // ミュート設定
    let muteCfg = { enabled: false, start: '22:00', end: '06:00' };
    const localMute = isChildMode ? localStorage.getItem('tbs_notification_mute') : null;
    if (localMute) { try { muteCfg = JSON.parse(localMute); } catch(e) {} }
    else {
      const rec = AppState.systemSettings?.find(s => s.id === 'notification_mute');
      if (rec?.value) try { muteCfg = JSON.parse(rec.value); } catch(e) {}
    }

    // スキャン音
    const localScan = isChildMode ? localStorage.getItem('tbs_notification_scan_sound') : null;
    const scanEnabled = localScan !== null
      ? localScan !== 'false'
      : AppState.systemSettings?.find(s => s.id === 'notification_scan_sound')?.value !== 'false';

    // OS通知
    const localOs = isChildMode ? localStorage.getItem('tbs_notification_os') : null;
    const osEnabled = localOs !== null
      ? localOs === 'true'
      : AppState.systemSettings?.find(s => s.id === 'notification_os')?.value === 'true';

    // インポートトースト
    const importToastEnabled = AppState.systemSettings?.find(s => s.id === 'notification_import_toast')?.value !== 'false';

    const items = [
      { key: 'PICKUP_REQUIRED',   label: '迎え要（検査終了によるお迎え要請）',        defaultSound: 'alarm' },
      { key: 'NEARLY_DONE',       label: 'あと10分（検査終了見込み10分前）',           defaultSound: 'chime' },
      { key: 'SOON',              label: 'お迎え5分前（登録済みお迎え時刻の5分前）',    defaultSound: 'chime' },
      { key: 'DEPART_REGISTERED', label: '出棟登録済（移送イベント新規登録時）',        defaultSound: 'ding' },
      { key: 'MOVING',            label: '移動中（出棟開始など移送が動き出したとき）',  defaultSound: 'ding' },
      { key: 'ARRIVED',           label: '到着（患者が検査室に到着したとき）',          defaultSound: 'ding' },
      { key: 'IN_EXAM',           label: '検査中（患者の検査が開始されたとき）',        defaultSound: 'ding' },
      { key: 'RETURNED',          label: '帰棟済（移送が完了したとき）',               defaultSound: 'ding' },
    ];

    const SOUND_OPTIONS = [
      { value: 'alarm',        label: '🚨 アラーム（警告3連打）' },
      { value: 'urgent',       label: '🔴 緊急アラーム（連続5回）' },
      { value: 'chime',        label: '🔔 チャイム（ドミソ）' },
      { value: 'double-chime', label: '🔔🔔 ダブルチャイム' },
      { value: 'fanfare',      label: '🎺 ファンファーレ' },
      { value: 'ding',         label: '🎵 サイン音（ピン）' },
      { value: 'beep',         label: '📳 ビープ（×2）' },
      { value: 'soft',         label: '🌙 ソフトトーン（穏やか）' },
    ];
    const makeSoundSelect = (selectedValue, cls, key) =>
      `<select class="${cls}" data-key="${key}" style="width:100%;padding:5px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px;">
        ${SOUND_OPTIONS.map(o => `<option value="${o.value}"${o.value === selectedValue ? ' selected' : ''}>${o.label}</option>`).join('')}
      </select>`;

    body.innerHTML = `

      <!-- ① マスター音量・ミュート -->
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-volume-up"></i> 音量・サイレントモード</h3>
          <button class="btn btn-primary btn-sm" id="btn-save-sounds-master"><i class="fas fa-save"></i> 保存</button>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:4px;">

          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;">
            <div style="font-weight:700;font-size:13px;margin-bottom:10px;"><i class="fas fa-sliders-h"></i> 通知音量（全体）</div>
            <div style="display:flex;align-items:center;gap:10px;">
              <i class="fas fa-volume-off" style="color:#94a3b8;"></i>
              <input type="range" id="notif-volume" min="0" max="100" value="${volume}"
                style="flex:1;accent-color:#3b82f6;">
              <i class="fas fa-volume-up" style="color:#3b82f6;"></i>
              <span id="notif-volume-val" style="min-width:32px;font-weight:700;font-size:13px;color:#1e293b;">${volume}%</span>
            </div>
            <div style="font-size:11px;color:#94a3b8;margin-top:6px;">
              スキャン音・通知音・着信音すべてに適用されます。ブラウザのミュートとは別です。
            </div>
            <button class="btn btn-outline btn-sm" id="btn-test-volume" style="margin-top:10px;">
              <i class="fas fa-play"></i> テスト再生
            </button>
          </div>

          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
              <div style="font-weight:700;font-size:13px;"><i class="fas fa-moon"></i> サイレントモード（時間帯自動ミュート）</div>
              <label class="toggle-switch" style="margin:0;">
                <input type="checkbox" id="mute-enabled" ${muteCfg.enabled ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div id="mute-time-row" style="display:${muteCfg.enabled ? 'flex' : 'none'};align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;">
              <span>開始</span>
              <input type="time" id="mute-start" value="${muteCfg.start || '22:00'}"
                style="border:1px solid #cbd5e0;border-radius:4px;padding:4px 6px;font-size:12px;">
              <span>〜 終了</span>
              <input type="time" id="mute-end" value="${muteCfg.end || '06:00'}"
                style="border:1px solid #cbd5e0;border-radius:4px;padding:4px 6px;font-size:12px;">
            </div>
            <div style="font-size:11px;color:#94a3b8;margin-top:8px;">
              指定した時間帯は全通知音を自動でミュートします（トーストは表示されます）。
            </div>
          </div>
        </div>
      </div>

      <!-- ② 着信音 -->
      <div class="settings-panel" style="margin-top:14px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-phone-volume"></i> 着信音・スキャン音</h3>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:4px;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;">
            <div style="font-weight:700;font-size:13px;margin-bottom:10px;">内線/ビデオ通話 着信音</div>
            <div style="display:flex;align-items:center;gap:8px;">
              <select id="incoming-ring-sound" style="flex:1;padding:6px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px;">
                <option value="ring"         ${incomingRingSound==='ring'         ?'selected':''}>📞 電話ベル</option>
                <option value="alarm"        ${incomingRingSound==='alarm'        ?'selected':''}>🚨 アラーム（3連打）</option>
                <option value="urgent"       ${incomingRingSound==='urgent'       ?'selected':''}>🔴 緊急アラーム</option>
                <option value="chime"        ${incomingRingSound==='chime'        ?'selected':''}>🔔 チャイム（ドミソ）</option>
                <option value="double-chime" ${incomingRingSound==='double-chime' ?'selected':''}>🔔🔔 ダブルチャイム</option>
                <option value="fanfare"      ${incomingRingSound==='fanfare'      ?'selected':''}>🎺 ファンファーレ</option>
                <option value="ding"         ${incomingRingSound==='ding'         ?'selected':''}>🎵 サイン音</option>
                <option value="beep"         ${incomingRingSound==='beep'         ?'selected':''}>📳 ビープ</option>
                <option value="soft"         ${incomingRingSound==='soft'         ?'selected':''}>🌙 ソフトトーン</option>
              </select>
              <button class="btn btn-outline btn-sm" id="btn-test-incoming-ring"><i class="fas fa-play"></i></button>
            </div>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;">
            <div style="font-weight:700;font-size:13px;margin-bottom:10px;">ICカード スキャン音</div>
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;">
              <input type="checkbox" id="scan-sound-enabled" ${scanEnabled ? 'checked' : ''} style="transform:scale(1.2);">
              <span>スキャン音を鳴らす<br><span style="font-size:11px;color:#94a3b8;">成功音・エラー音を再生します</span></span>
            </label>
          </div>
        </div>
      </div>

      <!-- ③ ステータス別 通知音 & トースト -->
      <div class="settings-panel" style="margin-top:14px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-bell"></i> ステータス変化の通知</h3>
          <button class="btn btn-primary btn-sm" id="btn-save-sounds"><i class="fas fa-save"></i> 保存</button>
        </div>
        <p class="settings-hint"><i class="fas fa-info-circle"></i>
          患者の移送ステータスが変化したときの通知音とトースト表示を個別に設定できます。
        </p>
        <table class="settings-table" style="margin-top:12px;">
          <thead>
            <tr>
              <th style="width:60px;text-align:center;">通知音</th>
              <th style="width:60px;text-align:center;">トースト</th>
              <th>対象イベント</th>
              <th style="width:190px;">音の種類</th>
              <th style="width:80px;text-align:center;">テスト</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(item => {
              const cfg = soundSettings[item.key] || { enabled: false, sound: item.defaultSound, toast: true };
              return `
                <tr>
                  <td style="text-align:center;">
                    <input type="checkbox" class="sound-enable-chk" data-key="${item.key}"
                      ${cfg.enabled ? 'checked' : ''} style="transform:scale(1.2);cursor:pointer;">
                  </td>
                  <td style="text-align:center;">
                    <input type="checkbox" class="sound-toast-chk" data-key="${item.key}"
                      ${cfg.toast !== false ? 'checked' : ''} style="transform:scale(1.2);cursor:pointer;">
                  </td>
                  <td>
                    <div style="font-weight:700;font-size:13px;color:#2d3748;">
                      ${CONFIG.STATUS_LABEL?.[item.key] || (item.key === 'SOON' ? 'お迎え5分前' : item.key)}
                    </div>
                    <div style="font-size:11px;color:#718096;margin-top:2px;">${item.label}</div>
                  </td>
                  <td>${makeSoundSelect(cfg.sound || item.defaultSound, 'sound-type-sel', item.key)}</td>
                  <td style="text-align:center;">
                    <button class="btn btn-outline btn-sm btn-test-sound" data-key="${item.key}"
                      style="padding:4px 8px;font-size:11px;">
                      <i class="fas fa-play"></i>
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- ④ その他の通知設定 -->
      <div class="settings-panel" style="margin-top:14px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-cog"></i> その他の通知設定</h3>
          <button class="btn btn-primary btn-sm" id="btn-save-misc-notif"><i class="fas fa-save"></i> 保存</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:8px;">

          <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:12px 14px;
            background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;gap:16px;">
            <div style="flex:1;">
              <div style="font-weight:700;font-size:13px;"><i class="fas fa-desktop"></i> OSネイティブ通知（Windowsデスクトップ通知）</div>
              <div style="font-size:11.5px;color:#64748b;margin-top:3px;line-height:1.6;">
                アプリが背面・最小化中でも迎え要・あと10分などをWindowsの通知センターに表示します。<br>
                <span style="color:#92400e;">※ Windowsの「設定 → 通知」でTransBoardの通知が許可されている必要があります。</span>
              </div>
              <button class="btn btn-outline btn-sm" id="btn-test-os-notif" style="margin-top:8px;font-size:11px;">
                <i class="fas fa-bell"></i> テスト通知を送る
              </button>
            </div>
            <label class="toggle-switch" style="margin:4px 0 0;flex-shrink:0;">
              <input type="checkbox" id="os-notif-enabled" ${osEnabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>

          <label style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;
            background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;">
            <div>
              <div style="font-weight:700;font-size:13px;"><i class="fas fa-file-csv"></i> CSVインポート完了トースト</div>
              <div style="font-size:11.5px;color:#64748b;margin-top:3px;">
                電子カルテからのCSV自動取り込みが完了したときに画面下部にトーストを表示します。
              </div>
            </div>
            <label class="toggle-switch" style="margin:0 0 0 16px;flex-shrink:0;">
              <input type="checkbox" id="import-toast-enabled" ${importToastEnabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </label>

        </div>
      </div>

      <!-- ⑤ ビデオ通話品質 -->
      <div class="settings-panel" style="margin-top:14px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-video"></i> ビデオ通話品質</h3>
        </div>
        <p class="settings-hint"><i class="fas fa-info-circle"></i> この設定はこの端末にのみ適用されます。院内Wi-Fiが不安定な場合は低画質を選択してください。</p>
        <div id="video-quality-btns" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;">
          ${[
            { key:'low',    icon:'fa-signal', label:'低画質',  sub:'320×240 / 10fps / 200kbps',   col:'#64748b' },
            { key:'medium', icon:'fa-signal', label:'標準',    sub:'640×480 / 15fps / 500kbps',   col:'#3b82f6' },
            { key:'high',   icon:'fa-signal', label:'高画質',  sub:'1280×720 / 30fps / 1500kbps', col:'#16a34a' },
          ].map(p => `
            <label style="flex:1;min-width:120px;display:flex;flex-direction:column;align-items:center;gap:4px;
              border:2px solid #e2e8f0;border-radius:8px;padding:10px 8px;cursor:pointer;
              background:#fafafa;transition:border-color .15s;" class="vq-label" data-key="${p.key}">
              <input type="radio" name="video-quality" value="${p.key}" style="display:none;">
              <i class="fas ${p.icon}" style="font-size:18px;color:${p.col};"></i>
              <span style="font-weight:700;font-size:13px;">${p.label}</span>
              <span style="font-size:10px;color:#6b7280;">${p.sub}</span>
            </label>
          `).join('')}
        </div>
        <div style="margin-top:12px;display:flex;justify-content:flex-end;">
          <button class="btn btn-primary btn-sm" id="btn-save-video-quality"><i class="fas fa-save"></i> 画質を保存</button>
        </div>
      </div>
    `;

    // ── 音量スライダー ──
    const volSlider = document.getElementById('notif-volume');
    const volVal    = document.getElementById('notif-volume-val');
    const _updateVolSlider = () => {
      const pct = volSlider.value;
      volVal.textContent = pct + '%';
      volSlider.style.background = `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${pct}%, #e2e8f0 ${pct}%, #e2e8f0 100%)`;
    };
    volSlider.addEventListener('input', _updateVolSlider);
    _updateVolSlider();
    document.getElementById('btn-test-volume').onclick = () => {
      UI.playNotificationSound('chime', parseInt(volSlider.value, 10) / 100);
    };

    // ── ミュート時間帯の表示切替 ──
    document.getElementById('mute-enabled').addEventListener('change', e => {
      document.getElementById('mute-time-row').style.display = e.target.checked ? 'flex' : 'none';
    });

    // ── マスター（音量・ミュート・スキャン・着信音）保存 ──
    document.getElementById('btn-save-sounds-master').onclick = async () => {
      const vol      = document.getElementById('notif-volume').value;
      const muteOn   = document.getElementById('mute-enabled').checked;
      const muteStart= document.getElementById('mute-start').value || '22:00';
      const muteEnd  = document.getElementById('mute-end').value   || '06:00';
      const scanOn   = document.getElementById('scan-sound-enabled').checked;
      const ringVal  = document.getElementById('incoming-ring-sound').value;

      const muteCfgNew = { enabled: muteOn, start: muteStart, end: muteEnd };

      try {
        if (isChildMode) {
          localStorage.setItem('tbs_notification_volume',    vol);
          localStorage.setItem('tbs_notification_mute',      JSON.stringify(muteCfgNew));
          localStorage.setItem('tbs_notification_scan_sound',String(scanOn));
          localStorage.setItem('tbs_incoming_ring_sound',    ringVal);
          // AppState 反映
          [
            ['notification_volume', vol],
            ['notification_mute', JSON.stringify(muteCfgNew)],
            ['notification_scan_sound', String(scanOn)],
            ['incoming_ring_sound', ringVal],
          ].forEach(([id, value]) => {
            const r = AppState.systemSettings?.find(s => s.id === id);
            if (r) r.value = value; else AppState.systemSettings?.push({ id, value });
          });
        } else {
          await Promise.all([
            API.patch('system_settings', 'notification_volume',    { value: vol }),
            API.patch('system_settings', 'notification_mute',      { value: JSON.stringify(muteCfgNew) }),
            API.patch('system_settings', 'notification_scan_sound',{ value: String(scanOn) }),
            API.patch('system_settings', 'incoming_ring_sound',    { value: ringVal }),
          ]);
          await App.loadMasters();
        }
        UI.toast('音量・ミュート設定を保存しました', 'success');
      } catch(err) {
        UI.toast('保存に失敗しました: ' + err.message, 'danger');
      }
    };

    // ── 着信音テスト ──
    document.getElementById('btn-test-incoming-ring').onclick = () => {
      const sel = document.getElementById('incoming-ring-sound');
      const rec = AppState.systemSettings?.find(s => s.id === 'incoming_ring_sound');
      if (rec) rec.value = sel.value; else AppState.systemSettings?.push({ id: 'incoming_ring_sound', value: sel.value });
      CallPanel.playIncomingRingTone();
      setTimeout(() => CallPanel.stopRingTone(), 2200);
    };

    // ── ステータス通知テスト再生 ──
    body.querySelectorAll('.btn-test-sound').forEach(btn => {
      btn.onclick = () => {
        const key = btn.dataset.key;
        const sel = body.querySelector(`.sound-type-sel[data-key="${key}"]`);
        if (sel) UI.playNotificationSound(sel.value);
      };
    });

    // ── ステータス通知保存 ──
    document.getElementById('btn-save-sounds').onclick = async () => {
      const saveBtn = document.getElementById('btn-save-sounds');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

      const newSettings = {};
      body.querySelectorAll('.sound-enable-chk').forEach(chk => {
        const key = chk.dataset.key;
        const sel  = body.querySelector(`.sound-type-sel[data-key="${key}"]`);
        const tChk = body.querySelector(`.sound-toast-chk[data-key="${key}"]`);
        newSettings[key] = {
          enabled: chk.checked,
          sound:   sel?.value || 'ding',
          toast:   tChk ? tChk.checked : true,
        };
      });

      try {
        if (isChildMode) {
          localStorage.setItem('tbs_notification_sounds', JSON.stringify(newSettings));
          const r = AppState.systemSettings?.find(s => s.id === 'notification_sounds');
          if (r) r.value = JSON.stringify(newSettings);
        } else {
          await API.patch('system_settings', 'notification_sounds', { value: JSON.stringify(newSettings) });
          await App.loadMasters();
        }
        UI.toast('通知音設定を保存しました', 'success');
      } catch(err) {
        UI.toast('保存に失敗しました: ' + err.message, 'danger');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 保存';
      }
    };

    // ── テスト通知ボタン ──
    document.getElementById('btn-test-os-notif')?.addEventListener('click', () => {
      if (window.electronAPI?.showOsNotification) {
        window.electronAPI.showOsNotification('TransBoard テスト通知', 'デスクトップ通知が正常に動作しています。TransBoard からの通知です。');
      } else {
        UI.toast('この環境ではOSネイティブ通知を使用できません', 'warning');
      }
    });

    // ── その他（OS通知・インポートトースト）保存 ──
    document.getElementById('btn-save-misc-notif').onclick = async () => {
      const osOn      = document.getElementById('os-notif-enabled').checked;
      const importOn  = document.getElementById('import-toast-enabled').checked;

      try {
        if (isChildMode) {
          localStorage.setItem('tbs_notification_os', String(osOn));
          [['notification_os', String(osOn)], ['notification_import_toast', String(importOn)]].forEach(([id, value]) => {
            const r = AppState.systemSettings?.find(s => s.id === id);
            if (r) r.value = value; else AppState.systemSettings?.push({ id, value });
          });
          // インポートトーストは全体設定（子機でも親機DBに保存）
          await API.patch('system_settings', 'notification_import_toast', { value: String(importOn) });
        } else {
          await Promise.all([
            API.patch('system_settings', 'notification_os',           { value: String(osOn) }),
            API.patch('system_settings', 'notification_import_toast', { value: String(importOn) }),
          ]);
          await App.loadMasters();
        }
        UI.toast('通知設定を保存しました', 'success');
      } catch(err) {
        UI.toast('保存に失敗しました: ' + err.message, 'danger');
      }
    };

    // ── ビデオ品質 ──
    const currentVQ = localStorage.getItem('tbs_video_quality') || 'medium';
    document.querySelectorAll('.vq-label').forEach(lbl => {
      const key = lbl.dataset.key;
      if (key === currentVQ) {
        lbl.querySelector('input').checked = true;
        lbl.style.borderColor = key === 'low' ? '#64748b' : key === 'medium' ? '#3b82f6' : '#16a34a';
        lbl.style.background = '#eff6ff';
      }
      lbl.addEventListener('click', () => {
        document.querySelectorAll('.vq-label').forEach(l => { l.style.borderColor = '#e2e8f0'; l.style.background = '#fafafa'; });
        lbl.style.borderColor = key === 'low' ? '#64748b' : key === 'medium' ? '#3b82f6' : '#16a34a';
        lbl.style.background = '#eff6ff';
        lbl.querySelector('input').checked = true;
      });
    });
    document.getElementById('btn-save-video-quality').onclick = () => {
      const sel = document.querySelector('input[name="video-quality"]:checked');
      if (!sel) return;
      localStorage.setItem('tbs_video_quality', sel.value);
      if (typeof CallPanel !== 'undefined') CallPanel._videoQualityPreset = sel.value;
      UI.toast(`ビデオ品質を「${{ low:'低画質', medium:'標準', high:'高画質' }[sel.value]}」に設定しました`, 'success');
    };
  },

  // ──────────────────────────────────
  //  共有・ネットワーク設定管理
  // ──────────────────────────────────
  async _renderNetworkSettings(body) {
    const storageInfo = window.electronAPI && window.electronAPI.getDatabaseStorageInfo
      ? await window.electronAPI.getDatabaseStorageInfo()
      : null;

    const currentMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const currentParentIp = localStorage.getItem('cfg_parent_ip') || '';

    // WebRTC音声通話の有効設定を取得
    const webrtcSetting = AppState.systemSettings?.find(s => s.id === 'enable_webrtc_call') || { value: 'true' };
    const isWebRtcEnabled = webrtcSetting.value !== 'false';

    // 患者ICカード紐づけ機能の有効設定を取得
    const icSetting = AppState.systemSettings?.find(s => s.id === 'enable_patient_ic_association') || { value: 'false' };
    const isIcEnabled = icSetting.value === 'true';

    // ズーム・フォント・カードサイズの設定値を取得 (端末個別保存に対応、未設定ならDBの全体デフォルト)
    const dbZoom = AppState.systemSettings?.find(s => s.id === 'default_zoom')?.value || '1.0';
    const defaultZoom = localStorage.getItem('cfg_app_zoom') || dbZoom;

    const dbFont = AppState.systemSettings?.find(s => s.id === 'font_style')?.value || 'ud';
    const fontStyle = localStorage.getItem('cfg_font_style') || dbFont;

    const dbCardSize = AppState.systemSettings?.find(s => s.id === 'bed_card_size')?.value || 'medium';
    const bedCardSize = localStorage.getItem('cfg_bed_card_size') || dbCardSize;

    const dbTheme = AppState.systemSettings?.find(s => s.id === 'theme_style')?.value || 'light';
    const themeStyle = localStorage.getItem('cfg_theme_style') || dbTheme;

    const showSyncSetting = AppState.systemSettings?.find(s => s.id === 'show_sync_time') || { value: 'true' };
    const showSyncTime = showSyncSetting.value !== 'false';
    const showImportSetting = AppState.systemSettings?.find(s => s.id === 'show_import_time') || { value: 'true' };
    const showImportTime = showImportSetting.value !== 'false';

    const passcodeSetting = AppState.systemSettings?.find(s => s.id === 'admin_passcode') || { value: '0000' };
    const adminPasscode = passcodeSetting.value;

    const eventRetentionSetting = AppState.systemSettings?.find(s => s.id === 'event_retention_days') || { value: '0' };
    const eventRetentionDays = eventRetentionSetting.value;

    // ローカルIPアドレス一覧を取得する（親機の場合の親切設計）
    let ipListHtml = '<li>IPアドレスの取得中...</li>';
    if (window.electronAPI && window.electronAPI.getLocalIPs) {
      try {
        const ips = await window.electronAPI.getLocalIPs();
        if (ips && ips.length > 0) {
          ipListHtml = ips.map(ip => `
            <li>
              <strong>${ip.name}:</strong> 
              <code style="background:#edf2f7; padding:2px 6px; border-radius:4px; font-weight:800; font-family:monospace; font-size:12px;">${ip.address}</code>
            </li>
          `).join('');
        } else {
          ipListHtml = '<li>有効なIPv4ネットワークアドレスが見つかりませんでした</li>';
        }
      } catch (e) {
        console.error(e);
        ipListHtml = '<li>IPアドレスの取得に失敗しました</li>';
      }
    } else {
      ipListHtml = '<li>デスクトップ環境（Electron）でのみIP表示に対応しています</li>';
    }

    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-network-wired"></i> 共有・ネットワーク設定</h3>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-outline btn-sm" id="btn-launch-wizard" style="border-color:var(--clr-primary); color:var(--clr-primary);">
              <i class="fas fa-magic"></i> 初期設定ウィザード起動
            </button>
            <button class="btn btn-primary btn-sm" id="btn-save-network">
              <i class="fas fa-save"></i> 設定を保存
            </button>
          </div>
        </div>
        <p class="settings-hint">
          <i class="fas fa-info-circle"></i>
          病棟PCと検査室PCの間でデータを共有するための設定を行います。<br>
          ※設定を変更して保存した後に、アプリケーションの再起動が必要です。
        </p>

        <div style="background:#f8fafc; padding:20px; border-radius:8px; border:1px solid #e2e8f0; margin-top:16px; display:flex; flex-direction:column; gap:16px;">
          <!-- モード選択 -->
          <div>
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-project-diagram"></i> このPCの役割を選択
              <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#e0f2fe; color:#0369a1; font-weight:800;">個別設定（PCごと）</span>
            </h4>
            <div style="display:flex; flex-direction:column; gap:12px;">
              <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px;">
                <input type="radio" name="network-mode" value="parent" ${currentMode === 'parent' ? 'checked' : ''} style="margin-top:3px;">
                <div>
                  <strong>親機（サーバー）モード</strong>
                  <div style="font-size:11px; color:#718096; margin-top:2px;">このPCのデータベースをメインとして使用します。子機PCからのアクセスを受け付ける共有機能が有効になります。</div>
                </div>
              </label>
              <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px;">
                <input type="radio" name="network-mode" value="client" ${currentMode === 'client' ? 'checked' : ''} style="margin-top:3px;">
                <div>
                  <strong>子機（クライアント）モード</strong>
                  <div style="font-size:11px; color:#718096; margin-top:2px;">別の親機PCのデータベースに接続して動作します。このPC自身のローカルDBは無視されます。</div>
                </div>
              </label>
            </div>
          </div>

          <!-- 子機用：親機接続設定 -->
          <div id="client-config-section" style="border-top:1px solid #e2e8f0; padding-top:16px; display:${currentMode === 'client' ? 'block' : 'none'};">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-plug"></i> 親機への接続設定
              <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#dbeafe; color:#1e40af; font-weight:800;">子機専用設定</span>
            </h4>
            <div class="form-row" style="margin-bottom:12px;">
              <label>親機PCのIPアドレス / ホスト名</label>
              <input type="text" id="cfg-parent-ip" placeholder="例: 192.168.1.15" style="width:100%; max-width:300px; padding:8px; border:1px solid #cbd5e0; border-radius:6px;" value="${currentParentIp}">
            </div>
            <div style="display:flex; gap:8px;">
              <button class="btn btn-outline btn-sm" id="btn-test-connection">
                <i class="fas fa-link"></i> 接続テストを実行
              </button>
            </div>
          </div>

          <!-- 親機用：ローカルIP表示 -->
          <div id="parent-config-section" style="border-top:1px solid #e2e8f0; padding-top:16px; display:${currentMode === 'parent' ? 'block' : 'none'};">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-info-circle"></i> 子機から接続するための情報
              <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#fee2e2; color:#b91c1c; font-weight:800;">親機専用情報</span>
            </h4>
            <p style="font-size:11px; color:#718096; margin:0 0 8px 0;">子機PCを設定する際は、この親機PCの以下のいずれかのIPアドレスを接続先に指定してください：</p>
            <ul style="font-size:12px; line-height:1.6; margin:0; padding-left:20px; color:#4a5568;">
              ${ipListHtml}
            </ul>
            <div style="margin-top:10px; font-size:11px; color:#718096;">
              ※共有ポート番号はデフォルトで <code style="background:#edf2f7; padding:1px 4px; border-radius:3px; font-weight:700;">3005</code> を使用します。<br>
              ※子機から接続できない場合は、この親機PCのWindowsファイアウォールでポート3005の受信規則が許可されているか確認してください。
            </div>
          </div>

          <!-- WebRTC通話機能の有効/無効設定 -->
          <div style="border-top:1px solid #e2e8f0; padding-top:16px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-phone-alt"></i> WebRTC音声通話機能の設定
              <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#f1f5f9; color:#475569; font-weight:800;">全体同期・共通設定</span>
            </h4>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600; color:#2d3748;">
              <input type="checkbox" id="cfg-enable-webrtc-call" ${isWebRtcEnabled ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
              WebRTC音声通話機能を使用する
            </label>
            <div style="font-size:11px; color:#718096; margin-top:4px; padding-left:24px;">
              チェックを外すと、画面間のリアルタイム音声通話が無効になります。簡易定型アナウンス（音声合成）や内線番号表示のみを利用できます。
            </div>
          </div>

          <!-- 患者ICカード紐づけ機能の有効/無効設定 -->
          <div style="border-top:1px solid #e2e8f0; padding-top:16px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-id-card"></i> 患者ICカード登録機能（オプション）
              <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#f1f5f9; color:#475569; font-weight:800;">全体同期・共通設定</span>
            </h4>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600; color:#2d3748;">
              <input type="checkbox" id="cfg-enable-patient-ic" ${isIcEnabled ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
              患者ICカード登録機能を使用する（出棟時・移動中の紐づけ、帰棟・キャンセル時の自動解除）
            </label>
            <div style="font-size:11px; color:#718096; margin-top:4px; padding-left:24px;">
              チェックを入れると、病床詳細モーダルにおいて出棟登録時や移動中の患者に対してICカード（スキャナーによる文字入力）を登録できるようになります。帰棟完了時やキャンセル時には自動的に紐づけが削除されます。
            </div>
          </div>

          <!-- 表示スケール・フォント設定 -->
          <div style="border-top:1px solid #e2e8f0; padding-top:16px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-desktop"></i> 表示倍率・フォント・病床カードサイズ設定
              <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#e0f2fe; color:#0369a1; font-weight:800;">個別設定（PCごと）</span>
            </h4>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:10px;">
              <div class="form-row">
                <label>表示倍率 (このPCの設定)</label>
                <select id="cfg-default-zoom" style="width:100%; max-width:200px; padding:6px; border:1px solid #cbd5e0; border-radius:6px; outline:none; cursor:pointer;">
                  <option value="1.0" ${defaultZoom === '1.0' ? 'selected' : ''}>100% (標準)</option>
                  <option value="1.2" ${defaultZoom === '1.2' ? 'selected' : ''}>120% (中)</option>
                  <option value="1.5" ${defaultZoom === '1.5' ? 'selected' : ''}>150% (大)</option>
                  <option value="2.0" ${defaultZoom === '2.0' ? 'selected' : ''}>200% (極大)</option>
                </select>
              </div>
              <div class="form-row">
                <label>基本フォントスタイル (このPCの設定)</label>
                <select id="cfg-font-style" style="width:100%; max-width:200px; padding:6px; border:1px solid #cbd5e0; border-radius:6px; outline:none; cursor:pointer;">
                  <option value="ud" ${fontStyle === 'ud' ? 'selected' : ''}>UDフォント (BIZ UDゴシック)</option>
                  <option value="standard" ${fontStyle === 'standard' ? 'selected' : ''}>標準フォント (OSゴシック)</option>
                  <option value="bold" ${fontStyle === 'bold' ? 'selected' : ''}>高コントラスト太字 (視力サポート)</option>
                </select>
              </div>
              <div class="form-row" style="grid-column: span 2;">
                <label>病床マップのカードサイズ (このPCの設定)</label>
                <select id="cfg-bed-card-size" style="width:100%; max-width:200px; padding:6px; border:1px solid #cbd5e0; border-radius:6px; outline:none; cursor:pointer;">
                  <option value="large" ${bedCardSize === 'large' ? 'selected' : ''}>大 (高さ 70px / 文字 17px)</option>
                  <option value="medium" ${bedCardSize === 'medium' ? 'selected' : ''}>中 (高さ 55px / 文字 14px - 標準)</option>
                  <option value="small" ${bedCardSize === 'small' ? 'selected' : ''}>小 (高さ 46px / 文字 12px)</option>
                </select>
              </div>
              <div class="form-row" style="grid-column: span 2;">
                <label>表示カラーテーマ (このPCの設定)</label>
                <select id="cfg-theme" style="width:100%; max-width:200px; padding:6px; border:1px solid #cbd5e0; border-radius:6px; outline:none; cursor:pointer;">
                  <option value="light" ${themeStyle === 'light' ? 'selected' : ''}>標準ライトテーマ</option>
                  <option value="dark" ${themeStyle === 'dark' ? 'selected' : ''}>ダークテーマ (Sleek Dark)</option>
                  <option value="blue" ${themeStyle === 'blue' ? 'selected' : ''}>メディカルブルーテーマ</option>
                  <option value="high-contrast" ${themeStyle === 'high-contrast' ? 'selected' : ''}>高コントラスト (白黒・黄)</option>
                  <option value="cvd" ${themeStyle === 'cvd' ? 'selected' : ''}>色覚サポートテーマ (CVD対応)</option>
                </select>
              </div>
            </div>
            <div style="font-size:11px; color:#718096; margin-top:8px;">
              ※表示設定（倍率・フォント・カードサイズ・テーマ）は端末ごとに個別保存されます（このパソコンのみに適用）。同時に、新しい端末接続時のデフォルト初期値として、親機のデータベースにも共通保存されます。
            </div>
          </div>

          <!-- 管理者パスコードの設定 (全体同期) -->
          <div style="border-top:1px solid #e2e8f0; padding-top:16px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-lock"></i> 設定画面保護パスコード
              <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#f1f5f9; color:#475569; font-weight:800;">全体同期・共通設定</span>
            </h4>
            <div class="form-row" style="margin-top:10px;">
              <label style="font-size:12.5px; font-weight:700; color:#4a5568;">管理者パスコード（数字4桁など）</label>
              <input type="password" id="cfg-admin-passcode" placeholder="${adminPasscode ? '●●●● (変更する場合のみ入力)' : '例: 0000'}" style="width:100%; max-width:200px; padding:6px 8px; border:1px solid #cbd5e0; border-radius:6px; font-size:13px; font-weight:700;">
              <div style="font-size:11px; color:#718096; margin-top:4px;">
                ※空欄のまま保存すると現在のパスコードを維持します。パスコードはSHA-256でハッシュ化して保存されます。変更内容はすべての端末で同期されます。
              </div>
            </div>
          </div>

          <!-- 移送履歴データの保持期間設定 -->
          <div class="settings-section">
            <h4 class="settings-section-title">
              <i class="fas fa-trash-alt"></i> 移送履歴データの自動削除
              <span class="settings-badge settings-badge--shared">全体同期・共通設定</span>
            </h4>
            <p class="settings-note" style="margin-bottom:12px;">
              帰棟済・キャンセル済の移送イベントを、指定した日数より古い場合に起動時に自動削除します。
              削除されたデータは復元できません。無期限の場合は手動でデータベースを管理してください。
            </p>
            <div class="form-row" style="max-width:320px;">
              <label>完了済みイベントの保持期間</label>
              <select id="cfg-event-retention-days" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:6px; font-size:12px; cursor:pointer;">
                <option value="0"   ${eventRetentionDays === '0'   ? 'selected' : ''}>無期限（自動削除しない）</option>
                <option value="30"  ${eventRetentionDays === '30'  ? 'selected' : ''}>30日間（約1ヶ月）</option>
                <option value="90"  ${eventRetentionDays === '90'  ? 'selected' : ''}>90日間（約3ヶ月）</option>
                <option value="180" ${eventRetentionDays === '180' ? 'selected' : ''}>180日間（約半年）</option>
                <option value="365" ${eventRetentionDays === '365' ? 'selected' : ''}>365日間（約1年）</option>
              </select>
            </div>
            <button class="btn btn-outline btn-sm" id="btn-run-event-cleanup" style="margin-top:8px; border-color:#ef4444; color:#ef4444;">
              <i class="fas fa-broom"></i> 今すぐ削除を実行
            </button>
          </div>

          <!-- データベースの保存先設定 (Desktop専用) -->
          ${window.electronAPI && storageInfo ? `
          <div style="border-top:1px solid #e2e8f0; padding-top:16px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-folder-open"></i> データベースの保存先設定
              <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#e0f2fe; color:#0369a1; font-weight:800;">親機専用機能</span>
            </h4>
            <p style="font-size:11px; color:#718096; margin:0 0 10px 0;">
              データベースファイル（db.json）の保存先を選択します。<br>
              同一PC内の他のWindowsログインユーザーと設定や履歴を共有したい場合は「全ユーザー共有」を選択してください。
            </p>
            <div style="display:flex; flex-direction:column; gap:12px; margin-bottom:12px; background:#fff; padding:12px; border-radius:6px; border:1px solid #e2e8f0;">
              <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px;">
                <input type="radio" name="db-storage-mode" value="user" ${storageInfo.currentMode === 'user' ? 'checked' : ''} style="margin-top:3px;">
                <div>
                  <strong>ユーザー専用フォルダ（デフォルト）</strong>
                  <div style="font-size:11px; color:#718096; margin-top:2px;">現在のWindowsログインユーザーのみに適用されます。</div>
                  <div style="font-size:10px; color:#a0aec0; font-family:monospace; margin-top:2px; word-break:break-all;">パス: ${storageInfo.userPath}</div>
                </div>
              </label>
              <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px; margin-top:8px;">
                <input type="radio" name="db-storage-mode" value="common" ${storageInfo.currentMode === 'common' ? 'checked' : ''} style="margin-top:3px;">
                <div>
                  <strong>全ユーザー共有フォルダ（ProgramData）</strong>
                  <div style="font-size:11px; color:#718096; margin-top:2px;">このPCを使用するすべてのWindowsログインユーザーで設定・データを共有します。</div>
                  <div style="font-size:10px; color:#a0aec0; font-family:monospace; margin-top:2px; word-break:break-all;">パス: ${storageInfo.commonPath}</div>
                </div>
              </label>
            </div>
            <div>
              <button class="btn btn-outline btn-sm" id="btn-change-db-storage" style="border-color:#4b5563; color:#4b5563;">
                <i class="fas fa-exchange-alt"></i> 保存先を変更して再起動
              </button>
            </div>
            <div id="db-storage-permission-warning" style="font-size:11px; color:#c53030; font-weight:700; margin-top:6px; display:${!storageInfo.hasCommonWritePermission && storageInfo.currentMode === 'user' ? 'block' : 'none'};">
              ※警告: 全ユーザー共有フォルダへの書き込み権限がありません。変更するには管理者権限（管理者として実行）が必要です。
            </div>
          </div>
          ` : ''}

          <!-- データベースのバックアップと復元 (Desktop専用) -->
          ${window.electronAPI ? `
          <div style="border-top:1px solid #e2e8f0; padding-top:16px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-database"></i> データベースのバックアップと復元
              <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#fee2e2; color:#b91c1c; font-weight:800;">親機専用機能</span>
            </h4>
            <p style="font-size:11px; color:#718096; margin:0 0 10px 0;">病棟・病床マスタ、各種設定、最近の移送履歴データを含んだデータベース（db.json）のバックアップを作成・復元します。</p>
            <div style="display:flex; gap:12px;">
              <button class="btn btn-outline btn-sm" id="btn-backup-db" style="border-color:#4b5563; color:#4b5563;">
                <i class="fas fa-file-download"></i> バックアップを保存
              </button>
              <button class="btn btn-danger btn-sm" id="btn-restore-db" style="background:#dc2626; border-color:#dc2626; color:#fff;">
                <i class="fas fa-file-upload"></i> バックアップから復元 (リストア)
              </button>
            </div>
            <div style="font-size:11px; color:#c53030; font-weight:700; margin-top:6px;">
              ※注意: バックアップから復元すると、現在のすべての履歴と設定が上書きされます。
            </div>
          </div>
          ` : ''}

          <!-- スタートアップ登録 (Desktop専用) -->
          ${window.electronAPI ? `
          <div style="border-top:1px solid #e2e8f0; padding-top:16px; margin-top:4px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-power-off"></i> Windows 起動時の自動起動
            </h4>
            <div style="display:flex; align-items:center; gap:10px;">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:normal;">
                <input type="checkbox" id="chk-startup" style="width:16px; height:16px; cursor:pointer;">
                Windows にログイン時、TransBoard を自動的に起動する
              </label>
              <span id="startup-status-label" style="font-size:12px; color:#718096;"></span>
            </div>
            <p style="margin:6px 0 0 24px; font-size:12px; color:#718096;">有効にすると Windows のスタートアップに登録され、PC 起動後に自動でアプリが起動します。</p>
          </div>
          ` : ''}
        </div>
      </div>
    `;

    if (currentMode === 'parent') this._renderDeviceList(body);

    // 役割ラジオの変更イベント
    body.querySelectorAll('input[name="network-mode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const isClient = e.target.value === 'client';
        document.getElementById('client-config-section').style.display = isClient ? 'block' : 'none';
        document.getElementById('parent-config-section').style.display = isClient ? 'none' : 'block';
      });
    });

    // ウィザード起動ボタン
    const wizardBtn = document.getElementById('btn-launch-wizard');
    if (wizardBtn) {
      wizardBtn.onclick = () => {
        Wizard.open();
      };
    }

    // 接続テストボタンイベント
    const testBtn = document.getElementById('btn-test-connection');
    if (testBtn) {
      testBtn.onclick = async () => {
        const parentIp = document.getElementById('cfg-parent-ip').value.trim();
        if (!parentIp) {
          UI.toast('親機のIPアドレスを入力してください', 'warning');
          return;
        }

        testBtn.disabled = true;
        const oldHtml = testBtn.innerHTML;
        testBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 接続テスト中...';

        try {
          // テストフェッチ（親機側のwardsマスタを取得してみる）
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 4000); // 4秒タイムアウト

          const res = await fetch(`http://${parentIp}:3005/api/tables/wards`, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (res.ok) {
            const data = await res.json();
            UI.toast(`✅ 接続に成功しました！ 親機の病棟データ (${data.data?.length || 0}件) を正常に検出。`, 'success');
          } else {
            UI.toast(`❌ 接続失敗: HTTPエラー ${res.status}`, 'danger');
          }
        } catch (e) {
          UI.toast(`❌ 接続できませんでした。IPアドレスが正しいか、親機が起動しているか、またはネットワーク設定（ファイアウォール）を確認してください。`, 'danger', 6000);
        } finally {
          testBtn.disabled = false;
          testBtn.innerHTML = oldHtml;
        }
      };
    }

    // 保存ボタンイベント
    document.getElementById('btn-save-network').onclick = async () => {
      const mode = body.querySelector('input[name="network-mode"]:checked').value;
      const parentIp = document.getElementById('cfg-parent-ip').value.trim();
      const enableWebRtcCall = document.getElementById('cfg-enable-webrtc-call').checked ? 'true' : 'false';
      const enablePatientIc = document.getElementById('cfg-enable-patient-ic').checked ? 'true' : 'false';
      const defaultZoom = document.getElementById('cfg-default-zoom').value;
      const fontStyle = document.getElementById('cfg-font-style').value;
      const bedCardSize = document.getElementById('cfg-bed-card-size').value;
      const themeStyle = document.getElementById('cfg-theme').value;
      const adminPasscodeRaw = document.getElementById('cfg-admin-passcode').value.trim();
      const eventRetentionDaysVal = document.getElementById('cfg-event-retention-days')?.value || '0';

      if (mode === 'client' && !parentIp) {
        UI.toast('接続先の親機IPアドレスを入力してください', 'warning');
        return;
      }

      // パスコードをSHA-256でハッシュ化して保存 (セキュリティ #3)
      let adminPasscode = '';
      if (adminPasscodeRaw) {
        adminPasscode = typeof PasscodeHash !== 'undefined'
          ? await PasscodeHash.hash(adminPasscodeRaw)
          : adminPasscodeRaw;
      }

      // localStorageへ保存（起動時の同期ロードおよび端末個別用）
      localStorage.setItem('cfg_share_mode', mode);
      localStorage.setItem('cfg_parent_ip', parentIp);
      localStorage.setItem('cfg_app_zoom', defaultZoom);
      localStorage.setItem('cfg_font_style', fontStyle);
      localStorage.setItem('cfg_bed_card_size', bedCardSize);
      localStorage.setItem('cfg_theme_style', themeStyle);

      // マスタDB側にも設定値（互換性保存）を反映
      try {
        await Promise.all([
          API.patch('system_settings', 'share_mode', { value: mode }),
          API.patch('system_settings', 'parent_ip', { value: parentIp }),
          API.patch('system_settings', 'enable_webrtc_call', { value: enableWebRtcCall }),
          API.patch('system_settings', 'enable_patient_ic_association', { value: enablePatientIc }),
          API.patch('system_settings', 'default_zoom', { value: defaultZoom }),
          API.patch('system_settings', 'font_style', { value: fontStyle }),
          API.patch('system_settings', 'bed_card_size', { value: bedCardSize }),
          API.patch('system_settings', 'theme_style', { value: themeStyle }),
          ...(adminPasscode ? [API.patch('system_settings', 'admin_passcode', { value: adminPasscode })] : []),
          API.patch('system_settings', 'event_retention_days', { value: eventRetentionDaysVal }),
        ]);

        // AppStateのシステム設定も更新
        const updateSetting = (id, val) => {
          const obj = AppState.systemSettings?.find(s => s.id === id);
          if (obj) obj.value = val;
          else AppState.systemSettings.push({ id, value: val });
        };
        updateSetting('enable_webrtc_call', enableWebRtcCall);
        updateSetting('enable_patient_ic_association', enablePatientIc);
        updateSetting('default_zoom', defaultZoom);
        updateSetting('font_style', fontStyle);
        updateSetting('bed_card_size', bedCardSize);
        updateSetting('theme_style', themeStyle);
        if (adminPasscode) updateSetting('admin_passcode', adminPasscode);
        updateSetting('event_retention_days', eventRetentionDaysVal);

        // 即座に変更を適用する
        if (typeof App !== 'undefined' && App.applySystemVisualSettings) {
          App.applySystemVisualSettings();
        }

        UI.toast('設定を保存しました。画面表示設定は即時適用され、ネットワーク共有設定は再起動後に有効になります。', 'success');
        
        // 再起動アラートの提示
        if (confirm('設定を完全に反映するためには、アプリケーションの再起動が必要です。今すぐ再起動しますか？')) {
          if (window.electronAPI && window.electronAPI.relaunchApp) {
            window.electronAPI.relaunchApp();
          } else {
            location.reload();
          }
        }
      } catch (err) {
        console.error(err);
        UI.toast('設定の保存に失敗しました: ' + err.message, 'danger');
      }
    };

    // 移送履歴データの手動クリーンアップ
    const runCleanupBtn = document.getElementById('btn-run-event-cleanup');
    if (runCleanupBtn) {
      runCleanupBtn.onclick = async () => {
        const days = parseInt(document.getElementById('cfg-event-retention-days')?.value || '0', 10);
        const label = days > 0 ? `${days}日以前` : '全期間';
        if (!days) {
          UI.toast('保持期間を「無期限」以外に設定してから実行してください', 'warning');
          return;
        }
        if (!confirm(`帰棟済・キャンセル済のイベントのうち${label}のものを削除します。この操作は元に戻せません。続けますか？`)) return;
        runCleanupBtn.disabled = true;
        try {
          await EventRetentionManager.run();
          UI.toast('古いイベントデータを削除しました', 'success');
        } catch (e) {
          UI.toast('削除中にエラーが発生しました: ' + e.message, 'danger');
        } finally {
          runCleanupBtn.disabled = false;
        }
      };
    }

    // データベースの保存先設定に関するイベント
    const changeDbStorageBtn = document.getElementById('btn-change-db-storage');
    if (changeDbStorageBtn && storageInfo) {
      // ラジオボタンのトグルで警告の表示切り替え
      body.querySelectorAll('input[name="db-storage-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
          const warningDiv = document.getElementById('db-storage-permission-warning');
          if (warningDiv) {
            if (e.target.value === 'common' && !storageInfo.hasCommonWritePermission) {
              warningDiv.style.display = 'block';
            } else {
              warningDiv.style.display = 'none';
            }
          }
        });
      });

      // 保存先変更実行
      changeDbStorageBtn.onclick = async () => {
        const selectedMode = body.querySelector('input[name="db-storage-mode"]:checked').value;
        if (selectedMode === storageInfo.currentMode) {
          UI.toast('現在と同じ保存先が選択されています。', 'info');
          return;
        }

        const confirmMsg = selectedMode === 'common'
          ? 'データベースの保存先を「全ユーザー共有フォルダ（ProgramData）」に変更します。\nよろしいですか？\n※既存のデータは共有フォルダへ自動的にコピーされます。'
          : 'データベースの保存先を「ユーザー専用フォルダ」に変更します。\nよろしいですか？\n※既存のデータはユーザーフォルダへ自動的にコピーされます。';

        if (!confirm(confirmMsg)) return;

        changeDbStorageBtn.disabled = true;
        const oldHtml = changeDbStorageBtn.innerHTML;
        changeDbStorageBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 変更中...';

        try {
          const res = await window.electronAPI.changeDatabaseStorageMode(selectedMode);
          if (res && res.success) {
            alert(res.message);
            if (window.electronAPI.relaunchApp) {
              window.electronAPI.relaunchApp();
            } else {
              location.reload();
            }
          } else {
            alert('変更エラー: ' + res.message);
          }
        } catch (e) {
          alert('エラーが発生しました: ' + e.message);
        } finally {
          changeDbStorageBtn.disabled = false;
          changeDbStorageBtn.innerHTML = oldHtml;
        }
      };
    }

    // バックアップボタン
    const backupBtn = document.getElementById('btn-backup-db');
    if (backupBtn) {
      backupBtn.onclick = async () => {
        try {
          const res = await window.electronAPI.backupDatabase();
          if (res && res.success) {
            UI.toast(`バックアップを保存しました:\n${res.filePath}`, 'success');
          } else if (res && res.message !== 'Cancelled') {
            UI.toast(`バックアップ保存エラー: ${res.message}`, 'danger');
          }
        } catch (e) {
          UI.toast(`バックアップ保存に失敗しました: ${e.message}`, 'danger');
        }
      };
    }

    // リストアボタン
    const restoreBtn = document.getElementById('btn-restore-db');
    if (restoreBtn) {
      restoreBtn.onclick = async () => {
        if (!confirm('バックアップから復元を実行しますか？\n現在のすべてのマスターデータ、履歴、設定が消去・上書きされ、アプリが自動再起動します。')) {
          return;
        }
        try {
          const res = await window.electronAPI.restoreDatabase();
          if (res && res.success) {
            UI.toast('復元に成功しました。アプリケーションを再起動します...', 'success');
            setTimeout(() => {
              window.electronAPI.relaunchApp();
            }, 1500);
          } else if (res && res.message !== 'Cancelled') {
            UI.toast(`復元エラー: ${res.message}`, 'danger');
          }
        } catch (e) {
          UI.toast(`復元に失敗しました: ${e.message}`, 'danger');
        }
      };
    }

    // スタートアップ登録チェックボックス
    const startupChk = document.getElementById('chk-startup');
    const startupLabel = document.getElementById('startup-status-label');
    if (startupChk && window.electronAPI?.getStartupSetting) {
      // 現在の登録状態を取得してチェックボックスに反映
      window.electronAPI.getStartupSetting().then(({ openAtLogin }) => {
        startupChk.checked = openAtLogin;
        if (startupLabel) startupLabel.textContent = openAtLogin ? '（登録済み）' : '';
      }).catch(() => {});

      startupChk.addEventListener('change', async (e) => {
        const openAtLogin = e.target.checked;
        try {
          await window.electronAPI.setStartupSetting({ openAtLogin });
          if (startupLabel) startupLabel.textContent = openAtLogin ? '（登録済み）' : '';
          UI.toast(openAtLogin ? 'スタートアップに登録しました' : 'スタートアップ登録を解除しました', 'success');
        } catch (err) {
          UI.toast('スタートアップ設定の変更に失敗しました', 'danger');
          startupChk.checked = !openAtLogin; // 失敗時は元に戻す
        }
      });
    }
  },


  // ──────────────────────────────────
  //  汎用スケジュール取り込み設定
  // ──────────────────────────────────
  async _renderScheduleFeeds(body) {
    let feeds = [];
    try {
      feeds = await API.getScheduleFeeds();
    } catch (e) {}

    const COLORS = ['#7c3aed','#2563eb','#059669','#d97706','#dc2626','#db2777','#0891b2','#4338ca'];

    const listHtml = feeds.length === 0
      ? '<p style="color:#718096;font-size:13px;">スケジュール取り込み設定がありません。「追加」から作成してください。</p>'
      : feeds.map(f => `
        <div class="settings-row" style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:8px;background:#fff;">
          <span style="width:14px;height:14px;border-radius:50%;background:${f.color||'#7c3aed'};flex-shrink:0;"></span>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:13px;">${f.name || '（名称なし）'}</div>
            <div style="font-size:11px;color:#718096;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.watch_dir || '（フォルダ未設定）'}</div>
          </div>
          <span style="font-size:11px;padding:2px 6px;border-radius:10px;background:${f.is_active?'#dcfce7':'#f1f5f9'};color:${f.is_active?'#16a34a':'#64748b'};">${f.is_active?'有効':'無効'}</span>
          <button class="btn btn-outline btn-sm sched-feed-import-btn" data-feed-id="${f.id}" style="font-size:11px;padding:4px 8px;" title="手動取り込み">
            <i class="fas fa-download"></i>
          </button>
          <button class="btn btn-outline btn-sm sched-feed-edit-btn" data-feed-id="${f.id}" style="font-size:11px;padding:4px 8px;">
            <i class="fas fa-edit"></i> 編集
          </button>
          <button class="btn btn-danger btn-sm sched-feed-del-btn" data-feed-id="${f.id}" style="font-size:11px;padding:4px 8px;background:#fee2e2;color:#dc2626;border-color:#fca5a5;">
            <i class="fas fa-trash"></i>
          </button>
        </div>`).join('');

    body.innerHTML = `
      <div class="settings-section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h3 style="margin:0;font-size:15px;">汎用スケジュール取り込み</h3>
          <button class="btn btn-primary btn-sm" id="sched-feed-add-btn"><i class="fas fa-plus"></i> 追加</button>
        </div>
        <p style="font-size:12px;color:#718096;margin:0 0 16px;">
          任意の CSV を定期的に取り込み、タイムラインにスケジュールとして表示します。<br>
          日付・時刻・タイトル列を指定するだけで使えます。複数の取り込みを設定できます。
        </p>
        <div id="sched-feed-list">${listHtml}</div>
      </div>

      <!-- フィード編集フォーム（モーダル風） -->
      <div id="sched-feed-form-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:5000;overflow-y:auto;">
        <div id="sched-feed-form-box" style="background:#fff;border-radius:12px;padding:24px;max-width:560px;margin:40px auto;box-shadow:0 20px 60px rgba(0,0,0,.2);">
          <h4 id="sched-feed-form-title" style="margin:0 0 18px;font-size:15px;">スケジュール取り込みの追加</h4>

          <input type="hidden" id="sched-form-id">

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
            <div>
              <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">取り込み名 <span style="color:#dc2626;">*</span></label>
              <input type="text" id="sched-form-name" class="form-input" placeholder="例: 手術スケジュール">
            </div>
            <div>
              <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">表示色</label>
              <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding-top:4px;">
                ${COLORS.map(c => `<span class="sched-color-chip" data-color="${c}" style="width:22px;height:22px;border-radius:50%;background:${c};cursor:pointer;border:2px solid transparent;"></span>`).join('')}
                <input type="color" id="sched-form-color" value="#7c3aed" style="width:28px;height:28px;border:none;padding:0;cursor:pointer;border-radius:4px;">
              </div>
            </div>
          </div>

          <div style="margin-bottom:12px;">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">監視フォルダ <span style="color:#dc2626;">*</span></label>
            <input type="text" id="sched-form-dir" class="form-input" placeholder="C:\\schedules\\surg または \\\\server\\share">
            <p style="font-size:11px;color:#718096;margin:3px 0 0;">CSV が配置されるフォルダのパスを指定します。UNCパス可。</p>
          </div>

          <div style="margin-bottom:12px;">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:6px;">取り込みスケジュール</label>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="radio" name="sched-form-mode" value="realtime" checked> リアルタイム監視</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="radio" name="sched-form-mode" value="interval"> 定期実行</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="radio" name="sched-form-mode" value="time"> 時刻指定</label>
            </div>
            <div id="sched-form-interval-row" style="display:none;margin-top:8px;">
              <input type="number" id="sched-form-interval" class="form-input" value="30" min="1" style="width:80px;display:inline;"> 分ごと
            </div>
            <div id="sched-form-times-row" style="display:none;margin-top:8px;">
              <input type="text" id="sched-form-times" class="form-input" placeholder="07:00,12:00,17:00">
              <p style="font-size:11px;color:#718096;margin:2px 0 0;">カンマ区切りで時刻を指定（HH:mm）</p>
            </div>
          </div>

          <div style="border-top:1px solid #e2e8f0;padding-top:14px;margin-bottom:12px;">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:8px;">CSVカラムマッピング</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">日付列（または日時一括列）</label>
                <input type="text" id="sched-map-date" class="form-input" placeholder="例: 日付 / 検査日時">
              </div>
              <div>
                <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">時刻列（任意）</label>
                <input type="text" id="sched-map-time" class="form-input" placeholder="例: 時刻 / 開始時間">
              </div>
              <div>
                <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">タイトル・内容列 <span style="color:#dc2626;">*</span></label>
                <input type="text" id="sched-map-title" class="form-input" placeholder="例: 内容 / 検査名">
              </div>
              <div>
                <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">ID列（任意）</label>
                <input type="text" id="sched-map-id" class="form-input" placeholder="例: 患者ID">
              </div>
              <div>
                <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">所要時間(分)列（任意）</label>
                <input type="text" id="sched-map-duration" class="form-input" placeholder="例: 所要時間">
              </div>
            </div>
            <p style="font-size:11px;color:#718096;margin:8px 0 0;">
              列名はCSVのヘッダ行の文字列と完全一致させてください。<br>
              日時が1列に入っている場合は「日付列」に入力し、時刻列は空欄にしてください。
            </p>
          </div>

          <div style="margin-bottom:16px;">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:6px;">取り込み後のファイル処理</label>
            <div style="display:flex;gap:16px;flex-wrap:wrap;">
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="radio" name="sched-form-policy" value="archive" checked> archiveフォルダへ移動</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="radio" name="sched-form-policy" value="delete"> 削除</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="radio" name="sched-form-policy" value="skip"> そのまま残す</label>
            </div>
          </div>

          <div style="margin-bottom:16px;">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:6px;">
              対象病棟 <span style="font-size:10px;color:#6b7280;font-weight:400;">（未選択 = 全病棟に表示）</span>
            </label>
            <div id="sched-ward-checks" style="display:flex;flex-wrap:wrap;gap:8px;">
              ${(AppState.wards || []).map(w => `
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;background:#f8fafc;padding:4px 8px;border-radius:4px;border:1px solid #e2e8f0;cursor:pointer;">
                  <input type="checkbox" class="sched-ward-chk" value="${w.id}"> ${w.name}
                </label>
              `).join('')}
              ${!(AppState.wards?.length) ? '<span style="font-size:11px;color:#94a3b8;">病棟マスタを先に登録してください</span>' : ''}
            </div>
          </div>

          <div style="margin-bottom:16px;display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="sched-form-active" checked style="width:16px;height:16px;">
            <label for="sched-form-active" style="font-size:13px;cursor:pointer;">この設定を有効にする</label>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button class="btn btn-outline btn-sm" id="sched-feed-form-cancel">キャンセル</button>
            <button class="btn btn-primary btn-sm" id="sched-feed-form-save"><i class="fas fa-save"></i> 保存</button>
          </div>
        </div>
      </div>
    `;

    const overlay = body.querySelector('#sched-feed-form-overlay');
    const colorInput = body.querySelector('#sched-form-color');

    // カラーチップ選択
    body.querySelectorAll('.sched-color-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        body.querySelectorAll('.sched-color-chip').forEach(c => c.style.border = '2px solid transparent');
        chip.style.border = '2px solid #1a202c';
        colorInput.value = chip.dataset.color;
      });
    });

    // スケジュールモード切り替え
    body.querySelectorAll('input[name="sched-form-mode"]').forEach(r => {
      r.addEventListener('change', () => {
        const m = body.querySelector('input[name="sched-form-mode"]:checked').value;
        body.querySelector('#sched-form-interval-row').style.display = m === 'interval' ? 'block' : 'none';
        body.querySelector('#sched-form-times-row').style.display = m === 'time' ? 'block' : 'none';
      });
    });

    const openForm = (feed = null) => {
      body.querySelector('#sched-feed-form-title').textContent = feed ? 'スケジュール取り込みの編集' : 'スケジュール取り込みの追加';
      body.querySelector('#sched-form-id').value = feed?.id || '';
      body.querySelector('#sched-form-name').value = feed?.name || '';
      body.querySelector('#sched-form-dir').value = feed?.watch_dir || '';
      body.querySelector('#sched-form-active').checked = feed ? (feed.is_active !== false) : true;

      const color = feed?.color || '#7c3aed';
      colorInput.value = color;
      body.querySelectorAll('.sched-color-chip').forEach(c => {
        c.style.border = c.dataset.color === color ? '2px solid #1a202c' : '2px solid transparent';
      });

      const sched = feed?.schedule || { mode: 'realtime' };
      const modeRadio = body.querySelector(`input[name="sched-form-mode"][value="${sched.mode || 'realtime'}"]`);
      if (modeRadio) modeRadio.checked = true;
      body.querySelector('#sched-form-interval').value = sched.intervalMin || '30';
      body.querySelector('#sched-form-times').value = (sched.times || []).join(',');
      body.querySelector('#sched-form-interval-row').style.display = sched.mode === 'interval' ? 'block' : 'none';
      body.querySelector('#sched-form-times-row').style.display = sched.mode === 'time' ? 'block' : 'none';

      const m = feed?.mapping || {};
      body.querySelector('#sched-map-date').value = m.col_date || m.col_datetime || '';
      body.querySelector('#sched-map-time').value = m.col_time || '';
      body.querySelector('#sched-map-title').value = m.col_title || '';
      body.querySelector('#sched-map-id').value = m.col_id || '';
      body.querySelector('#sched-map-duration').value = m.col_duration_min || '';

      const policy = (feed?.retention_policy?.action) || 'archive';
      const policyRadio = body.querySelector(`input[name="sched-form-policy"][value="${policy}"]`);
      if (policyRadio) policyRadio.checked = true;

      // 対象病棟チェック設定
      body.querySelectorAll('.sched-ward-chk').forEach(chk => {
        chk.checked = feed?.ward_ids?.length > 0 ? feed.ward_ids.includes(chk.value) : false;
      });

      overlay.style.display = 'block';
    };

    // 追加ボタン
    body.querySelector('#sched-feed-add-btn').addEventListener('click', () => openForm());

    // キャンセル
    body.querySelector('#sched-feed-form-cancel').addEventListener('click', () => { overlay.style.display = 'none'; });

    // 保存
    body.querySelector('#sched-feed-form-save').addEventListener('click', async () => {
      const name = body.querySelector('#sched-form-name').value.trim();
      const watchDir = body.querySelector('#sched-form-dir').value.trim();
      const titleCol = body.querySelector('#sched-map-title').value.trim();
      if (!name) { UI.toast('取り込み名を入力してください', 'warning'); return; }
      if (!watchDir) { UI.toast('監視フォルダを入力してください', 'warning'); return; }
      if (!titleCol) { UI.toast('タイトル列を入力してください', 'warning'); return; }

      const mode = body.querySelector('input[name="sched-form-mode"]:checked').value;
      const schedule = { mode };
      if (mode === 'interval') schedule.intervalMin = body.querySelector('#sched-form-interval').value;
      if (mode === 'time') schedule.times = body.querySelector('#sched-form-times').value.split(',').map(s => s.trim()).filter(Boolean);

      const dateCol = body.querySelector('#sched-map-date').value.trim();
      const mapping = {
        col_date: dateCol,
        col_datetime: '',
        col_time: body.querySelector('#sched-map-time').value.trim(),
        col_title: titleCol,
        col_id: body.querySelector('#sched-map-id').value.trim(),
        col_duration_min: body.querySelector('#sched-map-duration').value.trim(),
      };

      const feedId = body.querySelector('#sched-form-id').value;
      const wardIds = [...body.querySelectorAll('.sched-ward-chk:checked')].map(c => c.value);
      const data = {
        id: feedId || `feed-${Date.now()}`,
        name,
        color: colorInput.value,
        watch_dir: watchDir,
        schedule,
        mapping,
        retention_policy: { action: body.querySelector('input[name="sched-form-policy"]:checked').value },
        is_active: body.querySelector('#sched-form-active').checked,
        ward_ids: wardIds, // 空配列 = 全病棟
      };

      try {
        if (feedId) {
          await API.patch('schedule_feeds', feedId, data);
        } else {
          await API.create('schedule_feeds', data);
        }
        if (window.electronAPI?.reloadScheduleFeedTriggers) {
          await window.electronAPI.reloadScheduleFeedTriggers();
        }
        overlay.style.display = 'none';
        UI.toast('スケジュール取り込み設定を保存しました', 'success');
        this._renderScheduleFeeds(body);
      } catch (e) {
        UI.toast('保存に失敗しました: ' + e.message, 'danger');
      }
    });

    // リスト操作（編集・削除・手動取り込み）
    body.addEventListener('click', async e => {
      const editBtn = e.target.closest('.sched-feed-edit-btn');
      const delBtn = e.target.closest('.sched-feed-del-btn');
      const importBtn = e.target.closest('.sched-feed-import-btn');

      if (editBtn) {
        const feed = feeds.find(f => f.id === editBtn.dataset.feedId);
        if (feed) openForm(feed);
      } else if (delBtn) {
        if (!confirm('このスケジュール取り込み設定と取り込み済みデータをすべて削除しますか？')) return;
        const feedId = delBtn.dataset.feedId;
        try {
          await API.remove('schedule_feeds', feedId);
          // 関連するschedule_itemsも削除
          const allItems = await API.getAll('schedule_items');
          const toDelete = (allItems.data || []).filter(x => x.feed_id === feedId);
          for (const item of toDelete) {
            await API.remove('schedule_items', item.id);
          }
          if (window.electronAPI?.reloadScheduleFeedTriggers) {
            await window.electronAPI.reloadScheduleFeedTriggers();
          }
          UI.toast('削除しました', 'success');
          this._renderScheduleFeeds(body);
        } catch (err) {
          UI.toast('削除に失敗しました', 'danger');
        }
      } else if (importBtn) {
        if (!window.electronAPI?.triggerScheduleFeedImport) return;
        importBtn.disabled = true;
        const oldHtml = importBtn.innerHTML;
        importBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        try {
          const res = await window.electronAPI.triggerScheduleFeedImport(importBtn.dataset.feedId);
          if (res?.success) UI.toast('手動取り込みを実行しました', 'success');
          else UI.toast(res?.message || '取り込み失敗', 'warning');
        } catch (err) {
          UI.toast('手動取り込みに失敗しました', 'danger');
        } finally {
          importBtn.innerHTML = oldHtml;
          importBtn.disabled = false;
        }
      }
    }, { capture: false });
  },

  _renderDeviceList(body) {
    const host = body.querySelector('#parent-config-section');
    if (!host) return;
    document.getElementById('connected-devices-panel')?.remove();

    host.insertAdjacentHTML('beforeend', `
      <div id="connected-devices-panel" style="margin-top:14px; padding-top:14px; border-top:1px dashed #cbd5e0;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
          <h4 style="margin:0; font-size:13px; color:#2d3748; display:flex; align-items:center; gap:8px;"><i class="fas fa-laptop-medical"></i> 接続機器一覧</h4>
          <button class="btn btn-outline btn-sm" id="btn-refresh-devices"><i class="fas fa-sync-alt"></i> 更新</button>
        </div>
        <div id="connected-devices-body" style="font-size:12px; color:#4a5568;">読み込み中...</div>
      </div>
    `);

    const renderRows = async () => {
      const area = document.getElementById('connected-devices-body');
      if (!area) return;
      try {
        const result = await API.getConnectedDevices();
        const devices = Array.isArray(result) ? result : (result?.devices || []);
        const now = Date.now();
        if (devices.length === 0) {
          area.innerHTML = '<div style="padding:10px; background:#fff; border:1px solid #e2e8f0; border-radius:6px; color:#718096;">現在接続中の子機はありません。子機が親機へ接続するとここに表示されます。</div>';
          return;
        }

        area.innerHTML = `
          <table class="settings-table" style="margin-top:0; background:#fff;">
            <thead><tr><th>端末名</th><th>IP</th><th>病棟</th><th>画面</th><th>最終応答</th><th style="width:100px;">操作</th></tr></thead>
            <tbody>
              ${devices.map(d => {
                const id = d.deviceId || d.id;
                const lastSeen = new Date(d.lastSeen || d.last_seen || 0).getTime();
                const seconds = lastSeen ? Math.max(0, Math.floor((now - lastSeen) / 1000)) : null;
                const stale = seconds !== null && seconds > 20;
                return `
                  <tr style="opacity:${stale ? '.62' : '1'};">
                    <td><strong>${d.name || id || '-'}</strong>${stale ? ' <span style="color:#dc2626; font-size:10px; font-weight:800;">応答なし</span>' : ''}<div style="font-size:10px; color:#94a3b8;"><code>${id || '-'}</code></div></td>
                    <td>${d.ip || '-'}</td>
                    <td>${AppState.wards?.find(w => w.id === d.wardId)?.name || d.wardId || '-'}</td>
                    <td>${d.page || d.mode || '-'}</td>
                    <td>${seconds === null ? '-' : `${seconds}秒前`}</td>
                    <td><button class="btn btn-danger btn-sm btn-disconnect-device" data-id="${id || ''}" ${id ? '' : 'disabled'}>切断</button></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `;
        area.querySelectorAll('.btn-disconnect-device').forEach(btn => {
          btn.onclick = async () => {
            if (!btn.dataset.id) return;
            if (!confirm('この端末を接続一覧から削除しますか？')) return;
            await API.disconnectDevice(btn.dataset.id);
            UI.toast('接続機器を一覧から削除しました', 'success');
            renderRows();
          };
        });
      } catch (e) {
        console.error(e);
        area.innerHTML = '<div style="padding:10px; background:#fff5f5; border:1px solid #fed7d7; border-radius:6px; color:#c53030;">接続機器一覧を取得できませんでした。</div>';
      }
    };

    const refreshBtn = document.getElementById('btn-refresh-devices');
    if (refreshBtn) refreshBtn.onclick = renderRows;
    if (this._deviceListTimer) clearInterval(this._deviceListTimer);
    renderRows();
    this._deviceListTimer = setInterval(renderRows, 5000);
  },

  _renderSpeechTemplates(body) {
    const templatesSetting = AppState.systemSettings?.find(s => s.id === 'speech_templates');
    let templates = [];
    if (templatesSetting && templatesSetting.value) {
      try {
        templates = JSON.parse(templatesSetting.value);
      } catch (e) {
        console.error(e);
      }
    }
    
    // フォールバック
    if (!Array.isArray(templates) || templates.length === 0) {
      templates = [
        "連絡事項があります。",
        "間もなく、患者が出発します。",
        "患者が到着しました。",
        "検査が終了しました。お迎えをお願いします。",
        "移送をキャンセルします。",
        "至急、ご連絡ください。"
      ];
    }

    const renderList = () => {
      const listEl = document.getElementById('templates-list-container');
      if (!listEl) return;

      if (templates.length === 0) {
        listEl.innerHTML = '<div class="text-muted text-sm" style="padding:12px 0;">定型文が登録されていません</div>';
        return;
      }

      listEl.innerHTML = templates.map((t, idx) => `
        <div class="template-item-row" style="display:flex; gap:8px; align-items:center; margin-bottom:8px; background:rgba(0,0,0,0.02); padding:8px; border-radius:6px; border:1px solid #e2e8f0;">
          <span style="font-size:12px; font-weight:bold; color:#718096; width:24px; text-align:center;">${idx + 1}</span>
          <input type="text" class="template-input-text" data-index="${idx}" value="${t}" style="flex:1; padding:6px 10px; border:1px solid #cbd5e0; border-radius:4px; font-size:13px;" placeholder="アナウンスで読み上げる定型文を入力してください">
          <button class="btn btn-secondary btn-sm btn-delete-template" data-index="${idx}" style="padding:6px 10px; background:#ef4444; border-color:#ef4444; color:#fff;" title="削除">
            <i class="fas fa-trash-alt"></i>
          </button>
        </div>
      `).join('');

      // 入力値変更時の配列への即時同期
      listEl.querySelectorAll('.template-input-text').forEach(input => {
        input.addEventListener('change', (e) => {
          const idx = parseInt(e.target.dataset.index, 10);
          templates[idx] = e.target.value.trim();
        });
      });

      // 削除ボタンイベント
      listEl.querySelectorAll('.btn-delete-template').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = parseInt(btn.dataset.index, 10);
          templates.splice(idx, 1);
          renderList();
        });
      });
    };

    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-bullhorn"></i> アナウンス簡易連絡 定型文設定</h3>
          <button class="btn btn-success btn-sm" id="btn-add-template">
            <i class="fas fa-plus"></i> 定型文を追加
          </button>
        </div>
        <div class="settings-panel-body" style="padding:16px;">
          <p style="font-size:12px; color:#64748b; margin-bottom:16px; line-height:1.4;">
            コールの代わりに音声合成で読み上げて相手に伝える「ワンクリック定型アナウンス」の定型文リストを編集します。<br>
            追加・削除・編集を行った後は、最下部の「定型文設定を保存」ボタンを押してください。
          </p>
          <div id="templates-list-container" style="max-width:600px; margin-bottom:20px;"></div>
          
          <button class="btn btn-primary" id="btn-save-templates" style="padding:10px 24px; font-weight:700;">
            <i class="fas fa-save"></i> 定型文設定を保存
          </button>
        </div>
      </div>
    `;

    renderList();

    // 追加ボタンイベント
    document.getElementById('btn-add-template').onclick = () => {
      templates.push('');
      renderList();
      const inputs = body.querySelectorAll('.template-input-text');
      if (inputs.length > 0) inputs[inputs.length - 1].focus();
    };

    // 保存ボタンイベント
    document.getElementById('btn-save-templates').onclick = async () => {
      const saveBtn = document.getElementById('btn-save-templates');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';

      const cleanTemplates = templates.map(t => t.trim()).filter(t => t !== '');

      try {
        await API.patch('system_settings', 'speech_templates', { value: JSON.stringify(cleanTemplates) });

        const appSetting = AppState.systemSettings?.find(s => s.id === 'speech_templates');
        if (appSetting) {
          appSetting.value = JSON.stringify(cleanTemplates);
        } else {
          AppState.systemSettings.push({ id: 'speech_templates', value: JSON.stringify(cleanTemplates) });
        }

        UI.toast('アナウンス定型文設定を保存しました', 'success');
        templates = [...cleanTemplates];
        renderList();
      } catch (err) {
        console.error(err);
        UI.toast('設定の保存に失敗しました', 'danger');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 定型文設定を保存';
      }
    };
  },

  async _renderStatusCustomize(body) {
    const getSetting = (id, def) => {
      const s = AppState.systemSettings?.find(x => x.id === id);
      try { return JSON.parse(s?.value || def); } catch { return JSON.parse(def); }
    };
    const saveSetting = async (id, obj) => {
      const val = JSON.stringify(obj);
      await API.patch('system_settings', id, { value: val });
      const s = AppState.systemSettings?.find(x => x.id === id);
      if (s) s.value = val; else AppState.systemSettings.push({ id, value: val });
      if (typeof App !== 'undefined' && App.applySystemVisualSettings) App.applySystemVisualSettings();
    };

    const STATUS_ORDER = ['IN_BED','DEPART_REGISTERED','MOVING','ARRIVED','IN_EXAM','NEARLY_DONE','PICKUP_REQUIRED','RETURNED','CANCELLED'];
    const DEFAULT_LABELS = {
      IN_BED: '在床', DEPART_REGISTERED: '出棟登録済', MOVING: '移動中',
      ARRIVED: '検査室到着', IN_EXAM: '検査中', NEARLY_DONE: 'あと10分',
      PICKUP_REQUIRED: '迎え要', RETURNED: '帰棟済', CANCELLED: 'キャンセル',
    };
    const STATUS_COLOR_DEFAULTS = {
      IN_BED: '#f8fafc', DEPART_REGISTERED: '#dbeafe', MOVING: '#ede9fe',
      ARRIVED: '#e0f2fe', IN_EXAM: '#fefce8', NEARLY_DONE: '#fff7ed',
      PICKUP_REQUIRED: '#fee2e2', RETURNED: '#f0fdf4', CANCELLED: '#f1f5f9',
    };
    const ALL_ACTION_BTNS = [
      { key: 'DEPART_REGISTERED:MOVING',         label: '移動中へ',        scope: '病棟側' },
      { key: 'DEPART_REGISTERED:IN_EXAM',         label: '検査開始',        scope: '病棟側' },
      { key: 'MOVING:ARRIVED',                    label: '検査室到着',      scope: '病棟側' },
      { key: 'MOVING:IN_EXAM',                    label: '検査開始',        scope: '病棟側' },
      { key: 'ARRIVED:IN_EXAM',                   label: '検査開始',        scope: '病棟側' },
      { key: 'IN_EXAM:NEARLY_DONE',               label: 'あと10分',        scope: '病棟側' },
      { key: 'IN_EXAM:PICKUP_REQUIRED',           label: '迎え要',          scope: '病棟側' },
      { key: 'NEARLY_DONE:PICKUP_REQUIRED',       label: '迎え要',          scope: '病棟側' },
      { key: 'PICKUP_REQUIRED:RETURNED',          label: '帰棟完了',        scope: '病棟側' },
      { key: 'EXAM:DEPART_REGISTERED:ARRIVED',    label: '到着',            scope: '検査室側' },
      { key: 'EXAM:MOVING:ARRIVED',               label: '到着',            scope: '検査室側' },
      { key: 'EXAM:ARRIVED:IN_EXAM',              label: '検査開始',        scope: '検査室側' },
      { key: 'EXAM:IN_EXAM:NEARLY_DONE',          label: 'あと10分',        scope: '検査室側' },
      { key: 'EXAM:IN_EXAM:PICKUP_REQUIRED',      label: '終了（迎え要）',  scope: '検査室側' },
      { key: 'EXAM:NEARLY_DONE:PICKUP_REQUIRED',  label: '終了（迎え要）',  scope: '検査室側' },
    ];
    const HIDEABLE_STATUSES = ['MOVING','ARRIVED','NEARLY_DONE'];

    const customLabels   = getSetting('status_custom_labels', '{}');
    const ndMin          = parseInt((AppState.systemSettings?.find(s => s.id === 'nearly_done_minutes')?.value) || '10', 10);
    const stMin          = parseInt((AppState.systemSettings?.find(s => s.id === 'soon_threshold_min')?.value) || '15', 10);
    const statusColors   = getSetting('status_colors', '{}');
    const actionLabels   = getSetting('action_button_labels', '{}');
    const hiddenStatuses = getSetting('hidden_statuses', '[]');

    const statusLabelRows = STATUS_ORDER.map(sid => `
      <tr>
        <td style="padding:6px 8px; font-weight:600; white-space:nowrap;">${sid}</td>
        <td style="padding:6px 8px; color:#64748b;">${DEFAULT_LABELS[sid]}</td>
        <td style="padding:6px 8px;">
          <input type="text" class="custom-label-input" data-status="${sid}"
            value="${UI.escapeHTML(customLabels[sid] || '')}"
            placeholder="${DEFAULT_LABELS[sid]}"
            style="width:160px; padding:4px 8px; border:1px solid #cbd5e1; border-radius:4px; font-size:13px;">
        </td>
      </tr>`).join('');

    const ndOptions = [5,10,15,20,30].map(m => `<option value="${m}" ${m===ndMin?'selected':''}>${m}分</option>`).join('');
    const stOptions = [3,5,10,15,20,30].map(m => `<option value="${m}" ${m===stMin?'selected':''}>${m}分</option>`).join('');

    const colorRows = STATUS_ORDER.map(sid => {
      const c = statusColors[sid] || {};
      const defBg = STATUS_COLOR_DEFAULTS[sid] || '#ffffff';
      return `
        <tr>
          <td style="padding:6px 8px; font-weight:600;">${DEFAULT_LABELS[sid]}</td>
          <td style="padding:6px 8px; text-align:center;">
            <input type="color" class="sc-card-bg" data-status="${sid}"
              value="${c.card_bg || defBg}"
              style="width:48px; height:28px; cursor:pointer; border:none; padding:0;">
          </td>
          <td style="padding:6px 8px; text-align:center;">
            <input type="color" class="sc-card-border" data-status="${sid}"
              value="${c.card_border || '#94a3b8'}"
              style="width:48px; height:28px; cursor:pointer; border:none; padding:0;">
          </td>
          <td style="padding:6px 8px; text-align:center;">
            <input type="color" class="sc-badge-bg" data-status="${sid}"
              value="${c.badge_bg || defBg}"
              style="width:48px; height:28px; cursor:pointer; border:none; padding:0;">
          </td>
          <td style="padding:6px 8px; text-align:center;">
            <input type="color" class="sc-badge-text" data-status="${sid}"
              value="${c.badge_text || '#1a202c'}"
              style="width:48px; height:28px; cursor:pointer; border:none; padding:0;">
          </td>
          <td style="padding:6px 8px;">
            <button class="btn btn-outline btn-sm sc-reset-row" data-status="${sid}" title="このステータスの色をリセット">
              <i class="fas fa-undo"></i>
            </button>
          </td>
        </tr>`;
    }).join('');

    const actionLabelRows = ALL_ACTION_BTNS.map(btn => {
      const transKey = btn.key.replace(/^EXAM:/, '');
      const transLabel = transKey.split(':').map(s => DEFAULT_LABELS[s] || s).join(' → ');
      return `
        <tr>
          <td style="padding:6px 8px; color:#64748b; font-size:12px;">${btn.scope}</td>
          <td style="padding:6px 8px; font-size:12px;">${transLabel}</td>
          <td style="padding:6px 8px; color:#64748b;">${btn.label}</td>
          <td style="padding:6px 8px;">
            <input type="text" class="action-label-input" data-key="${btn.key}"
              value="${UI.escapeHTML(actionLabels[btn.key] || '')}"
              placeholder="${btn.label}"
              style="width:160px; padding:4px 8px; border:1px solid #cbd5e1; border-radius:4px; font-size:13px;">
          </td>
        </tr>`;
    }).join('');

    const hiddenCheckboxes = HIDEABLE_STATUSES.map(sid => `
      <label style="display:flex; align-items:center; gap:8px; padding:6px 0; font-size:14px;">
        <input type="checkbox" class="hidden-status-chk" data-status="${sid}"
          ${hiddenStatuses.includes(sid) ? 'checked' : ''}>
        <span><strong>${DEFAULT_LABELS[sid]}</strong>（${sid}）への遷移ボタンを非表示</span>
      </label>`).join('');

    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-sliders-h"></i> ステータスカスタマイズ</h3>
          <p style="margin:4px 0 0; font-size:12px; color:#64748b;">施設の運用フロー・用語に合わせてステータス表示を調整できます。変更はすべての端末に即時反映されます。</p>
        </div>

        <div class="settings-section" style="margin-bottom:24px;">
          <h4 class="settings-section-title"><i class="fas fa-tag"></i> ステータス表示名のカスタマイズ</h4>
          <p style="font-size:12px; color:#64748b; margin-bottom:8px;">空欄の場合はデフォルト名が使用されます。</p>
          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:13px;">
              <thead>
                <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0;">
                  <th style="padding:6px 8px; text-align:left;">ステータスID</th>
                  <th style="padding:6px 8px; text-align:left;">デフォルト名</th>
                  <th style="padding:6px 8px; text-align:left;">カスタム表示名</th>
                </tr>
              </thead>
              <tbody>${statusLabelRows}</tbody>
            </table>
          </div>
          <div style="margin-top:12px; display:flex; gap:8px;">
            <button class="btn btn-primary btn-sm" id="btn-save-status-labels"><i class="fas fa-save"></i> 表示名を保存</button>
            <button class="btn btn-outline btn-sm" id="btn-reset-status-labels"><i class="fas fa-undo"></i> すべてリセット</button>
          </div>
        </div>

        <div class="settings-section" style="margin-bottom:24px;">
          <h4 class="settings-section-title"><i class="fas fa-clock"></i> タイミングしきい値</h4>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; max-width:500px;">
            <div>
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">「あと何分」（NEARLY_DONE）</label>
              <select id="cfg-nearly-done-min" style="width:100%; padding:6px 8px; border:1px solid #cbd5e1; border-radius:4px; font-size:14px;">
                ${ndOptions}
              </select>
              <p style="font-size:11px; color:#64748b; margin-top:2px;">この分数後に迎え目安を自動設定します</p>
            </div>
            <div>
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">「まもなく迎え」閾値（SOON）</label>
              <select id="cfg-soon-threshold" style="width:100%; padding:6px 8px; border:1px solid #cbd5e1; border-radius:4px; font-size:14px;">
                ${stOptions}
              </select>
              <p style="font-size:11px; color:#64748b; margin-top:2px;">残り時間がこの分数以内で「まもなく」表示</p>
            </div>
          </div>
          <div style="margin-top:12px;">
            <button class="btn btn-primary btn-sm" id="btn-save-thresholds"><i class="fas fa-save"></i> しきい値を保存</button>
          </div>
        </div>

        <div class="settings-section" style="margin-bottom:24px;">
          <h4 class="settings-section-title"><i class="fas fa-palette"></i> ステータスカラーのカスタマイズ</h4>
          <p style="font-size:12px; color:#64748b; margin-bottom:4px;">高コントラスト・CVDテーマ有効時はテーマが優先されます。</p>
          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:13px;">
              <thead>
                <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0;">
                  <th style="padding:6px 8px; text-align:left;">ステータス</th>
                  <th style="padding:6px 8px;">カード背景</th>
                  <th style="padding:6px 8px;">カード枠線</th>
                  <th style="padding:6px 8px;">バッジ背景</th>
                  <th style="padding:6px 8px;">バッジ文字</th>
                  <th style="padding:6px 8px;"></th>
                </tr>
              </thead>
              <tbody>${colorRows}</tbody>
            </table>
          </div>
          <div style="margin-top:12px; display:flex; gap:8px;">
            <button class="btn btn-primary btn-sm" id="btn-save-colors"><i class="fas fa-save"></i> カラーを保存</button>
            <button class="btn btn-outline btn-sm" id="btn-reset-all-colors"><i class="fas fa-undo"></i> すべてリセット</button>
          </div>
        </div>

        <div class="settings-section" style="margin-bottom:24px;">
          <h4 class="settings-section-title"><i class="fas fa-hand-pointer"></i> アクションボタンラベル</h4>
          <p style="font-size:12px; color:#64748b; margin-bottom:8px;">空欄の場合はデフォルトラベルが使用されます。</p>
          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:13px;">
              <thead>
                <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0;">
                  <th style="padding:6px 8px; text-align:left;">画面</th>
                  <th style="padding:6px 8px; text-align:left;">遷移</th>
                  <th style="padding:6px 8px; text-align:left;">デフォルトラベル</th>
                  <th style="padding:6px 8px; text-align:left;">カスタムラベル</th>
                </tr>
              </thead>
              <tbody>${actionLabelRows}</tbody>
            </table>
          </div>
          <div style="margin-top:12px; display:flex; gap:8px;">
            <button class="btn btn-primary btn-sm" id="btn-save-action-labels"><i class="fas fa-save"></i> ボタンラベルを保存</button>
            <button class="btn btn-outline btn-sm" id="btn-reset-action-labels"><i class="fas fa-undo"></i> すべてリセット</button>
          </div>
        </div>

        <div class="settings-section">
          <h4 class="settings-section-title"><i class="fas fa-eye-slash"></i> 遷移ボタンの非表示化</h4>
          <p style="font-size:12px; color:#64748b; margin-bottom:8px;">使用しないステータスへの遷移ボタンを非表示にできます。<br>例: 検査室到着（ARRIVED）を使わず移動中から直接検査中に遷移する運用フロー。</p>
          ${hiddenCheckboxes}
          <div style="margin-top:12px;">
            <button class="btn btn-primary btn-sm" id="btn-save-hidden-statuses"><i class="fas fa-save"></i> 非表示設定を保存</button>
          </div>
        </div>
      </div>
    `;

    // #1 表示名の保存・リセット
    document.getElementById('btn-save-status-labels').onclick = async () => {
      const labels = {};
      body.querySelectorAll('.custom-label-input').forEach(input => {
        const v = input.value.trim();
        if (v) labels[input.dataset.status] = v;
      });
      try {
        await saveSetting('status_custom_labels', labels);
        UI.toast('ステータス表示名を保存しました', 'success');
      } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'danger'); }
    };
    document.getElementById('btn-reset-status-labels').onclick = async () => {
      if (!confirm('すべてのカスタム表示名をデフォルトに戻しますか？')) return;
      try {
        await saveSetting('status_custom_labels', {});
        body.querySelectorAll('.custom-label-input').forEach(input => { input.value = ''; });
        UI.toast('表示名をリセットしました', 'success');
      } catch (e) { UI.toast('リセットに失敗しました: ' + e.message, 'danger'); }
    };

    // #2 しきい値の保存
    document.getElementById('btn-save-thresholds').onclick = async () => {
      const ndVal = document.getElementById('cfg-nearly-done-min').value;
      const stVal = document.getElementById('cfg-soon-threshold').value;
      try {
        await Promise.all([
          API.patch('system_settings', 'nearly_done_minutes', { value: ndVal }),
          API.patch('system_settings', 'soon_threshold_min',  { value: stVal }),
        ]);
        const update = (id, val) => {
          const s = AppState.systemSettings?.find(x => x.id === id);
          if (s) s.value = val; else AppState.systemSettings.push({ id, value: val });
        };
        update('nearly_done_minutes', ndVal);
        update('soon_threshold_min', stVal);
        if (typeof App !== 'undefined' && App.applySystemVisualSettings) App.applySystemVisualSettings();
        UI.toast('しきい値を保存しました', 'success');
      } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'danger'); }
    };

    // #3 カラーの行リセット・一括保存・全リセット
    body.querySelectorAll('.sc-reset-row').forEach(btn => {
      btn.onclick = () => {
        const sid = btn.dataset.status;
        const row = btn.closest('tr');
        const defBg = STATUS_COLOR_DEFAULTS[sid] || '#ffffff';
        row.querySelector('.sc-card-bg').value    = defBg;
        row.querySelector('.sc-card-border').value = '#94a3b8';
        row.querySelector('.sc-badge-bg').value   = defBg;
        row.querySelector('.sc-badge-text').value  = '#1a202c';
      };
    });
    document.getElementById('btn-save-colors').onclick = async () => {
      const colors = {};
      STATUS_ORDER.forEach(sid => {
        const bgEl = body.querySelector(`.sc-card-bg[data-status="${sid}"]`);
        if (!bgEl) return;
        const row = bgEl.closest('tr');
        colors[sid] = {
          card_bg:    row.querySelector('.sc-card-bg').value,
          card_border: row.querySelector('.sc-card-border').value,
          badge_bg:   row.querySelector('.sc-badge-bg').value,
          badge_text: row.querySelector('.sc-badge-text').value,
        };
      });
      try {
        await saveSetting('status_colors', colors);
        UI.toast('ステータスカラーを保存しました', 'success');
      } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'danger'); }
    };
    document.getElementById('btn-reset-all-colors').onclick = async () => {
      if (!confirm('すべてのステータスカラーをデフォルトに戻しますか？')) return;
      try {
        await saveSetting('status_colors', {});
        document.documentElement.removeAttribute('style');
        if (typeof App !== 'undefined' && App.applySystemVisualSettings) App.applySystemVisualSettings();
        UI.toast('カラーをリセットしました', 'success');
        this._renderStatusCustomize(body);
      } catch (e) { UI.toast('リセットに失敗しました: ' + e.message, 'danger'); }
    };

    // #4 ボタンラベルの保存・リセット
    document.getElementById('btn-save-action-labels').onclick = async () => {
      const labels = {};
      body.querySelectorAll('.action-label-input').forEach(input => {
        const v = input.value.trim();
        if (v) labels[input.dataset.key] = v;
      });
      try {
        await saveSetting('action_button_labels', labels);
        UI.toast('ボタンラベルを保存しました', 'success');
      } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'danger'); }
    };
    document.getElementById('btn-reset-action-labels').onclick = async () => {
      if (!confirm('すべてのカスタムボタンラベルをデフォルトに戻しますか？')) return;
      try {
        await saveSetting('action_button_labels', {});
        body.querySelectorAll('.action-label-input').forEach(input => { input.value = ''; });
        UI.toast('ボタンラベルをリセットしました', 'success');
      } catch (e) { UI.toast('リセットに失敗しました: ' + e.message, 'danger'); }
    };

    // #5 非表示ステータスの保存
    document.getElementById('btn-save-hidden-statuses').onclick = async () => {
      const hidden = [];
      body.querySelectorAll('.hidden-status-chk:checked').forEach(chk => hidden.push(chk.dataset.status));
      try {
        await saveSetting('hidden_statuses', hidden);
        UI.toast('非表示設定を保存しました', 'success');
      } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'danger'); }
    };
  },
};
