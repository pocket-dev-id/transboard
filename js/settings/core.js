/**
 * TransBoard - 設定画面
 * ・病床マスタ管理（CRUD）
 * ・検査室マスタ管理（電話番号含む）
 * ・病床マップ配置グリッドエディタ
 */

const SETTINGS_TAB_DEFS = {
  wards: ['fa-hospital', '病棟マスタ', 'global', '全体'],
  beds: ['fa-bed', '病床マスタ', 'global', '全体'],
  bed_types: ['fa-tags', '病床タイプ', 'global', '全体'],
  map: ['fa-map', 'マップ配置', 'global', '全体'],
  rooms: ['fa-x-ray', '検査室マスタ', 'global', '全体'],
  exam_types: ['fa-notes-medical', '検査種別', 'global', '全体'],
  staffs: ['fa-user-nurse', 'スタッフ', 'global', '全体'],
  speech_templates: ['fa-bullhorn', 'アナウンス定型文', 'global', '全体'],
  status_customize: ['fa-sliders-h', 'ステータスカスタマイズ', 'global', '全体'],
  import: ['fa-file-import', '取り込み設定', 'parent', '親機'],
  schedule_feeds: ['fa-calendar-alt', 'スケジュール取り込み', 'parent', '親機'],
  notifications: ['fa-bell', '通知音設定', 'terminal', '端末'],
  network: ['fa-network-wired', '共有・ネットワーク設定', 'mixed', '混在'],
  terminal_behavior: ['fa-desktop', '端末表示・動作', 'terminal', '端末'],
  access_protection: ['fa-lock', 'アクセス保護', 'mixed', '共通'],
  maintenance: ['fa-toolbox', 'システム保守', 'terminal', '端末'],
};

const SETTINGS_TAB_GROUPS = {
  child: [
    ['端末・接続', ['network', 'terminal_behavior', 'notifications', 'access_protection']],
    ['全体共通', ['wards', 'beds', 'bed_types', 'map', 'rooms', 'exam_types', 'staffs', 'speech_templates', 'status_customize']],
    ['親機機能', ['import', 'schedule_feeds']],
    ['保守', ['maintenance']],
  ],
  parent: [
    ['全体共通', ['wards', 'beds', 'bed_types', 'map', 'rooms', 'exam_types', 'staffs', 'speech_templates', 'status_customize']],
    ['親機機能', ['import', 'schedule_feeds']],
    ['端末・接続', ['network', 'terminal_behavior', 'notifications', 'access_protection']],
    ['保守', ['maintenance']],
  ],
};

const SETTINGS_TAB_CATEGORIES = {
  wards: 'global', beds: 'global', bed_types: 'global',
  map: 'global', rooms: 'global', exam_types: 'global',
  staffs: 'global', speech_templates: 'global',
  status_customize: 'global',
  import: 'parent-only', schedule_feeds: 'parent-only',
  notifications: 'terminal', network: 'mixed',
  terminal_behavior: 'terminal', access_protection: 'mixed',
  maintenance: 'mixed',
};

const SETTINGS_CATEGORY_META = {
  global: {
    icon: 'fa-globe',
    cls: 'settings-category-banner--global',
    title: '全体共通設定',
    desc: 'この設定は親機に保存され、全端末に反映されます。',
  },
  terminal: {
    icon: 'fa-laptop',
    cls: 'settings-category-banner--terminal',
    title: '端末固有設定',
    desc: 'この設定はこの端末にのみ適用されます。他の端末には影響しません。',
  },
  'parent-only': {
    icon: 'fa-server',
    cls: 'settings-category-banner--parent-only',
    title: '親機専用機能',
    parentDesc: 'この機能は親機でのみ実行されます。',
    childDesc: '実際の処理（ファイル監視・取り込み）は親機で実行されます。設定自体は子機からも変更できます。',
  },
  mixed: {
    icon: 'fa-layer-group',
    cls: 'settings-category-banner--mixed',
    title: '適用範囲が項目ごとに異なります',
    desc: 'このタブには「この端末のみ」「親機専用」「全端末に同期」の設定が混在します。各項目の見出しにあるバッジで適用範囲を確認してください。',
  },
};

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


  // ──────────────────────────────────
  //  共通ユーティリティ
  // ──────────────────────────────────

  // モーダルオーバーレイに Escape キーで閉じる機能を付与する
  _addEscapeClose(overlay, close) {
    const handler = (e) => {
      if (e.key === 'Escape') { close(); }
    };
    document.addEventListener('keydown', handler);
    overlay.addEventListener('remove', () => document.removeEventListener('keydown', handler), { once: true });
    // overlay.remove() では 'remove' イベントが発火しないため MutationObserver で監視
    const obs = new MutationObserver(() => {
      if (!document.body.contains(overlay)) {
        document.removeEventListener('keydown', handler);
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: false });
  },

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
        ${this._getTabGroups().map(([label, ids], idx) => `
          ${idx ? '<span class="stab-sep"></span>' : ''}
          <span class="stab-group-label">${label}</span>
          ${ids.map(id => this._renderTabButton(id)).join('')}
        `).join('')}
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

  _getTabGroups() {
    return localStorage.getItem('cfg_share_mode') === 'client'
      ? SETTINGS_TAB_GROUPS.child
      : SETTINGS_TAB_GROUPS.parent;
  },

  _renderTabButton(id) {
    const [icon, label, badgeClass, badgeLabel] = SETTINGS_TAB_DEFS[id];
    return `
      <button class="settings-tab-btn ${this._activeTab === id ? 'active' : ''}" data-stab="${id}">
        <i class="fas ${icon}"></i> ${label}<span class="stab-badge stab-badge--${badgeClass}">${badgeLabel}</span>
      </button>
    `;
  },

  _renderTab() {
    const body = document.getElementById('settings-tab-body');
    if (!body) return;
    
    // キーボードショートカットの解除
    if (this._mapKeydownHandler) {
      window.removeEventListener('keydown', this._mapKeydownHandler);
      this._mapKeydownHandler = null;
    }

    const renderers = {
      beds: '_renderBeds',
      bed_types: '_renderBedTypes',
      map: '_renderMapEditor',
      rooms: '_renderRooms',
      exam_types: '_renderExamTypes',
      staffs: '_renderStaffs',
      wards: '_renderWards',
      import: '_renderImportSettings',
      notifications: '_renderNotificationSettings',
      speech_templates: '_renderSpeechTemplates',
      schedule_feeds: '_renderScheduleFeeds',
      network: '_renderNetworkSettings',
      terminal_behavior: '_renderTerminalBehaviorSettings',
      access_protection: '_renderAccessProtectionSettings',
      maintenance: '_renderMaintenanceSettings',
      status_customize: '_renderStatusCustomize',
    };
    const renderer = renderers[this._activeTab];
    if (renderer && typeof this[renderer] === 'function') {
      this[renderer](body);
    }

    this._injectCategoryBanner(body);
  },

  // 設定タブ種別バナーを先頭に挿入
  _injectCategoryBanner(body) {
    const isChild = localStorage.getItem('cfg_share_mode') === 'client';
    const category = SETTINGS_TAB_CATEGORIES[this._activeTab];
    if (!category) return;

    const meta = SETTINGS_CATEGORY_META[category];
    const desc = category === 'parent-only'
      ? (isChild ? meta.childDesc : meta.parentDesc)
      : meta.desc;
    const banner = document.createElement('div');
    banner.className = `settings-category-banner ${meta.cls}`;
    banner.innerHTML = `<i class="fas ${meta.icon}"></i><span><strong>${meta.title}</strong> — ${desc}</span>`;
    body.insertBefore(banner, body.firstChild);
  },
};
