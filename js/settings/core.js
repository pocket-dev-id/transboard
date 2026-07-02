/**
 * TransBoard - 設定画面
 * ・病床マスタ管理（CRUD）
 * ・検査室マスタ管理（電話番号含む）
 * ・病床マップ配置グリッドエディタ
 */

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
        <span class="stab-group-label">マスタ管理</span>
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
        <span class="stab-group-label">表示・通知</span>
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
        <span class="stab-group-label">システム</span>
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
};
