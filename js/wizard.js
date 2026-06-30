/**
 * TransBoard - 初期機能設定ウィザード
 */

const Wizard = {
  currentStep: 1,
  totalSteps: 4,
  config: {},

  open() {
    const gs = id => AppState.systemSettings?.find(s => s.id === id)?.value;
    this.config = {
      share_mode:                   gs('share_mode')                   || 'parent',
      parent_ip:                    gs('parent_ip')                    || '',
      import_connection_type:       gs('import_connection_type')       || 'csv',
      import_directory:             gs('import_directory')             || '',
      odbc_connection_string:       gs('odbc_connection_string')       || '',
      odbc_sql_query:               gs('odbc_sql_query')               || 'SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS',
      smb_auth_mode:                gs('smb_auth_mode')                || 'current',
      smb_username:                 gs('smb_username')                 || '',
      smb_password:                 gs('smb_password')                 || '',
      admission_mode:               gs('admission_mode')               || 'csv',
      theme_style:                  gs('theme_style')                  || 'light',
      font_style:                   gs('font_style')                   || 'ud',
      default_zoom:                 gs('default_zoom')                 || '1.0',
      enable_patient_ic_association: gs('enable_patient_ic_association') || 'false',
      insert_demo: false
    };

    this.currentStep = 1;
    this._renderModal();
  },

  _renderModal() {
    let overlay = document.getElementById('wizard-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'wizard-modal-overlay';
      overlay.className = 'modal-overlay';
      document.body.appendChild(overlay);
    }
    overlay.classList.remove('hidden');

    const stepLabels = ['稼働モード', '連携設定', '表示・管理', '確認と完了'];

    const progressDots = stepLabels.map((label, i) => {
      const n = i + 1;
      const done    = n < this.currentStep;
      const current = n === this.currentStep;
      return `
        <div class="wiz-step-item ${done ? 'done' : ''} ${current ? 'current' : ''}">
          <div class="wiz-step-circle">${done ? '<i class="fas fa-check"></i>' : n}</div>
          <div class="wiz-step-label">${label}</div>
        </div>
        ${i < stepLabels.length - 1 ? '<div class="wiz-step-connector"></div>' : ''}
      `;
    }).join('');

    overlay.innerHTML = `
      <div class="modal wiz-modal">
        <div class="modal-header" style="padding-bottom:0; border-bottom:none;">
          <h2 style="font-weight:800; font-size:16px; display:flex; align-items:center; gap:8px;">
            <i class="fas fa-magic" style="color:var(--clr-primary);"></i> 初期機能設定ウィザード
          </h2>
          <button class="modal-close-btn" id="wizard-x-close"><i class="fas fa-times"></i></button>
        </div>

        <div class="wiz-progress">${progressDots}</div>

        <div class="modal-body wiz-body">
          ${this._getStepContent()}
        </div>

        <div class="modal-footer" style="justify-content:space-between;">
          <div>
            ${this.currentStep > 1
              ? `<button class="btn btn-outline" id="wizard-prev"><i class="fas fa-chevron-left"></i> 戻る</button>`
              : ''}
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-outline" id="wizard-cancel">スキップ</button>
            ${this.currentStep < this.totalSteps
              ? `<button class="btn btn-primary" id="wizard-next">次へ <i class="fas fa-chevron-right"></i></button>`
              : `<button class="btn btn-success" id="wizard-finish"><i class="fas fa-check-circle"></i> 設定を適用して完了</button>`
            }
          </div>
        </div>
      </div>
    `;

    this._bindEvents();
  },

  // ─────────────────────────────────────────────────────
  //  ステップ別コンテンツ
  // ─────────────────────────────────────────────────────

  _getStepContent() {
    switch (this.currentStep) {
      case 1: return this._step1();
      case 2: return this._step2();
      case 3: return this._step3();
      case 4: return this._step4();
      default: return '';
    }
  },

  // ── Step 1: 稼働モード ──────────────────────────────
  _step1() {
    const sel = v => this.config.share_mode === v;
    return `
      <h4 class="wiz-step-title">1. 稼働モードの選択</h4>
      <p class="wiz-step-desc">このPCの役割を選択してください。すでに親機が院内にある場合は「子機モード」を選んで接続します。</p>
      <div class="wiz-radio-group">
        ${this._radioCard('share_mode', 'parent', sel('parent'),
          'fa-server', '親機モード（スタンドアロン / サーバー）',
          'このPCがマスターデータと履歴を管理します。他クライアントからの接続を受け付けます。')}
        ${this._radioCard('share_mode', 'client', sel('client'),
          'fa-laptop', '子機モード（クライアント）',
          'ネットワーク上の親機PCに接続し、表示の同期・操作を行います。')}
      </div>
      <div id="parent-ip-container" class="wiz-sub-panel" style="display:${sel('client') ? 'block' : 'none'};">
        <label class="wiz-label">親機のIPアドレス <span style="color:#dc2626">*</span></label>
        <input type="text" id="wizard-parent-ip" value="${this.config.parent_ip}"
          placeholder="例: 192.168.1.100"
          class="wiz-input" style="font-family:monospace;">
      </div>
    `;
  },

  // ── Step 2: 電子カルテ連携 ──────────────────────────
  _step2() {
    const sel = v => this.config.import_connection_type === v;
    return `
      <h4 class="wiz-step-title">2. 電子カルテ連携の設定</h4>
      <p class="wiz-step-desc">病床の在床患者リストを電子カルテから自動取得する方法を選択してください。</p>
      <div class="wiz-radio-group">
        ${this._radioCard('conn_type', 'csv', sel('csv'),
          'fa-file-csv', 'CSVファイル連携（フォルダ監視）',
          '電子カルテが出力するCSVファイルを監視し、定期的に在床患者リストを取り込みます。')}
        ${this._radioCard('conn_type', 'odbc', sel('odbc'),
          'fa-database', 'ODBCデータベース直接連携',
          '電子カルテのDBビューから直接SELECTクエリを発行して在床情報をリアルタイム同期します。')}
        ${this._radioCard('conn_type', 'none', sel('none'),
          'fa-hand-paper', '手動入力（外部連携なし）',
          '外部との連携なし。病棟マップの空床に手動で患者情報を登録します。')}
      </div>

      <!-- CSV: フォルダパス + SMB認証 -->
      <div id="csv-dir-container" class="wiz-sub-panel" style="display:${sel('csv') ? 'block' : 'none'};">
        <label class="wiz-label">CSV出力先フォルダの絶対パス</label>
        <input type="text" id="wizard-csv-dir" value="${this.config.import_directory}"
          placeholder="例: C:\\EMR_Export  または  \\\\fileserver\\share\\emr" class="wiz-input">
        <div class="wiz-hint"><i class="fas fa-network-wired"></i> ネットワーク共有（SMB）パスを使う場合は下の認証設定を入力してください。</div>
        <div style="margin-top:10px;">
          <label class="wiz-label" style="margin-bottom:6px;">SMB認証モード</label>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <label class="wiz-inline-radio">
              <input type="radio" name="smb_auth_mode" value="current"
                ${this.config.smb_auth_mode !== 'credential' ? 'checked' : ''}>
              現在のWindowsユーザーで接続
            </label>
            <label class="wiz-inline-radio">
              <input type="radio" name="smb_auth_mode" value="credential"
                ${this.config.smb_auth_mode === 'credential' ? 'checked' : ''}>
              別アカウントで接続
            </label>
          </div>
          <div id="smb-cred-fields" style="display:${this.config.smb_auth_mode === 'credential' ? 'grid' : 'none'}; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px;">
            <div>
              <label class="wiz-label">ユーザー名</label>
              <input type="text" id="wizard-smb-user" value="${this.config.smb_username}" class="wiz-input" placeholder="domain\\user">
            </div>
            <div>
              <label class="wiz-label">パスワード</label>
              <input type="password" id="wizard-smb-pass" value="${this.config.smb_password}" class="wiz-input" placeholder="••••••••">
            </div>
          </div>
        </div>
      </div>

      <!-- ODBC: 接続文字列ビルダー + SQLクエリ -->
      <div id="odbc-container" class="wiz-sub-panel" style="display:${sel('odbc') ? 'block' : 'none'};">
        <div class="wiz-odbc-builder">
          <div class="wiz-odbc-builder-header">
            <i class="fas fa-magic"></i> 接続文字列ビルダー
            <span style="font-size:10px; font-weight:400; color:#64748b; margin-left:4px;">— 入力すると自動で接続文字列を生成します</span>
          </div>
          <div class="wiz-odbc-grid">
            <div>
              <label class="wiz-label">DSN名 <span class="wiz-optional">（ODBCデータソース名）</span></label>
              <input type="text" id="wiz-odbc-dsn" class="wiz-input" placeholder="例: EMR_DB">
            </div>
            <div>
              <label class="wiz-label">ドライバ <span class="wiz-optional">（DSNがない場合）</span></label>
              <input type="text" id="wiz-odbc-driver" class="wiz-input" placeholder="例: SQL Server">
            </div>
            <div>
              <label class="wiz-label">サーバー / ホスト</label>
              <input type="text" id="wiz-odbc-server" class="wiz-input" placeholder="例: 192.168.1.10\\SQLEXPRESS">
            </div>
            <div>
              <label class="wiz-label">データベース名</label>
              <input type="text" id="wiz-odbc-db" class="wiz-input" placeholder="例: EMR_Production">
            </div>
            <div>
              <label class="wiz-label">ユーザーID (UID)</label>
              <input type="text" id="wiz-odbc-uid" class="wiz-input" placeholder="例: readonly_user">
            </div>
            <div>
              <label class="wiz-label">パスワード (PWD)</label>
              <input type="password" id="wiz-odbc-pwd" class="wiz-input" placeholder="••••••••">
            </div>
          </div>
          <div style="margin-top:8px;">
            <label class="wiz-label">生成された接続文字列 <span class="wiz-optional">（直接編集も可）</span></label>
            <input type="text" id="wiz-odbc-connstr" value="${UI.escapeHTML(this.config.odbc_connection_string)}"
              class="wiz-input" style="font-family:monospace; font-size:11px;"
              placeholder="DSN=EMR_DB;UID=user;PWD=pass; または Driver={SQL Server};Server=...">
            <button class="btn btn-outline btn-sm" id="btn-wiz-odbc-test" style="margin-top:6px;">
              <i class="fas fa-plug"></i> 接続テスト
            </button>
            <span id="wiz-odbc-test-result" style="font-size:11px; margin-left:8px;"></span>
          </div>
        </div>

        <div style="margin-top:12px;">
          <label class="wiz-label">データ抽出SQLクエリ</label>
          <textarea id="wiz-odbc-query" rows="3" class="wiz-input" style="font-family:monospace; font-size:11.5px; resize:vertical;"
            placeholder="SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS">${UI.escapeHTML(this.config.odbc_sql_query)}</textarea>
          <div class="wiz-hint">
            <i class="fas fa-info-circle"></i>
            必須カラム: <code>BED_NO</code>（病床番号）, <code>PATIENT_ID</code>, <code>PATIENT_NAME</code>, <code>IS_PRESENT</code>（在床=1/0）
          </div>
        </div>
      </div>
    `;
  },

  // ── Step 3: 表示・管理設定 ──────────────────────────
  _step3() {
    const admSel = v => this.config.admission_mode === v;
    return `
      <h4 class="wiz-step-title">3. 表示・管理設定</h4>
      <p class="wiz-step-desc">画面の表示スタイルと在室管理の運用モードを設定します。あとから設定画面でいつでも変更できます。</p>

      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:16px;">
        <div>
          <label class="wiz-label">カラーテーマ</label>
          <select id="wizard-theme" class="wiz-input">
            <option value="light"         ${this.config.theme_style === 'light'         ? 'selected' : ''}>標準ライト</option>
            <option value="dark"          ${this.config.theme_style === 'dark'          ? 'selected' : ''}>ダーク</option>
            <option value="blue"          ${this.config.theme_style === 'blue'          ? 'selected' : ''}>メディカルブルー</option>
            <option value="high-contrast" ${this.config.theme_style === 'high-contrast' ? 'selected' : ''}>高コントラスト</option>
            <option value="cvd"           ${this.config.theme_style === 'cvd'           ? 'selected' : ''}>色覚サポート (CVD対応)</option>
          </select>
        </div>
        <div>
          <label class="wiz-label">表示倍率</label>
          <select id="wizard-zoom" class="wiz-input">
            <option value="0.8" ${this.config.default_zoom === '0.8' ? 'selected' : ''}>やや縮小 (80%)</option>
            <option value="1.0" ${this.config.default_zoom === '1.0' ? 'selected' : ''}>等倍 (100%)</option>
            <option value="1.2" ${this.config.default_zoom === '1.2' ? 'selected' : ''}>やや拡大 (120%)</option>
          </select>
        </div>
        <div>
          <label class="wiz-label">フォント</label>
          <select id="wizard-font" class="wiz-input">
            <option value="ud"       ${this.config.font_style === 'ud'       ? 'selected' : ''}>UDフォント</option>
            <option value="standard" ${this.config.font_style === 'standard' ? 'selected' : ''}>標準ゴシック</option>
          </select>
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <label class="wiz-label" style="margin-bottom:8px;">在室管理モード</label>
        <div class="wiz-radio-group" style="gap:8px;">
          ${this._radioCard('admission_mode', 'csv', admSel('csv'),
            'fa-file-import', 'CSVインポートモード',
            '電子カルテ連携で取り込まれる在床リストをもとに患者を管理します。')}
          ${this._radioCard('admission_mode', 'manual', admSel('manual'),
            'fa-user-plus', '手動登録モード',
            '担当スタッフが手動で患者を在室登録します。外部連携なしの病棟向け。')}
          ${this._radioCard('admission_mode', 'hybrid', admSel('hybrid'),
            'fa-layer-group', 'ハイブリッドモード',
            'CSVで取り込みつつ、CSVにない患者を手動で追加登録できます。')}
        </div>
      </div>

      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; font-weight:700; color:var(--clr-text);">
        <input type="checkbox" id="wizard-ic-association" ${this.config.enable_patient_ic_association === 'true' ? 'checked' : ''}>
        患者ICカード（RFID）連携機能を有効化する
      </label>
    `;
  },

  // ── Step 4: 確認と完了 ──────────────────────────────
  _step4() {
    const modeLabel   = this.config.share_mode === 'parent' ? '親機モード' : '子機モード';
    const connLabels  = { csv: 'CSVファイル連携', odbc: 'ODBCデータベース連携', none: '手動入力' };
    const admLabels   = { csv: 'CSVインポート', manual: '手動登録', hybrid: 'ハイブリッド' };
    const themeLabels = { light: '標準ライト', dark: 'ダーク', blue: 'メディカルブルー', 'high-contrast': '高コントラスト', cvd: '色覚サポート' };

    const rows = [
      ['稼働モード',     modeLabel],
      this.config.share_mode === 'client' ? ['接続先親機IP', this.config.parent_ip || '（未設定）'] : null,
      ['外部連携方式',   connLabels[this.config.import_connection_type]],
      this.config.import_connection_type === 'csv'  ? ['CSV監視フォルダ', this.config.import_directory || '（未設定）'] : null,
      this.config.import_connection_type === 'odbc' ? ['ODBC接続文字列', this.config.odbc_connection_string ? '✅ 設定済み' : '⚠ 未設定'] : null,
      this.config.import_connection_type === 'odbc' ? ['SQLクエリ',       this.config.odbc_sql_query ? '✅ 設定済み' : '⚠ 未設定'] : null,
      ['在室管理モード', admLabels[this.config.admission_mode]],
      ['カラーテーマ',   themeLabels[this.config.theme_style]],
      ['表示倍率',       parseFloat(this.config.default_zoom) * 100 + '%'],
      ['フォント',       this.config.font_style === 'ud' ? 'UDフォント' : '標準ゴシック'],
      ['ICカード連携',   this.config.enable_patient_ic_association === 'true' ? '有効' : '無効'],
    ].filter(Boolean);

    const tableRows = rows.map(([k, v]) => `
      <tr>
        <td style="font-weight:700; color:#64748b; white-space:nowrap; padding:6px 10px;">${k}</td>
        <td style="padding:6px 10px;">${UI.escapeHTML(String(v))}</td>
      </tr>
    `).join('');

    const clientWarning = this.config.share_mode === 'client' ? `
      <div class="wiz-callout wiz-callout-warn">
        <i class="fas fa-exclamation-triangle"></i>
        <span><strong>子機モード:</strong> 親機PC (${UI.escapeHTML(this.config.parent_ip || '未指定')}) が起動・共有サーバーが動作している必要があります。</span>
      </div>` : '';

    const demoCheck = this.config.share_mode === 'parent' ? `
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; font-weight:700; margin-top:14px; color:var(--clr-text);">
        <input type="checkbox" id="wizard-insert-demo" ${this.config.insert_demo ? 'checked' : ''}>
        病床・検査室・スタッフのサンプルデモデータを追加する（初回向け）
      </label>` : '';

    return `
      <h4 class="wiz-step-title">4. 設定内容の確認と完了</h4>
      <p class="wiz-step-desc">設定に間違いがないかご確認ください。既存の移送履歴や登録データはそのまま維持されます。</p>
      <table style="width:100%; border-collapse:collapse; font-size:12px; background:rgba(0,0,0,.02); border-radius:8px; overflow:hidden; border:1px solid var(--clr-border);">
        ${tableRows}
      </table>
      ${clientWarning}
      ${demoCheck}
    `;
  },

  // ─────────────────────────────────────────────────────
  //  ユーティリティ
  // ─────────────────────────────────────────────────────

  _radioCard(name, value, checked, icon, title, desc) {
    return `
      <label class="wiz-radio-card ${checked ? 'selected' : ''}">
        <input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}>
        <i class="fas ${icon} wiz-radio-icon"></i>
        <div>
          <span class="wiz-radio-title">${title}</span>
          <span class="wiz-radio-desc">${desc}</span>
        </div>
      </label>
    `;
  },

  // ─────────────────────────────────────────────────────
  //  イベントバインド
  // ─────────────────────────────────────────────────────

  _bindEvents() {
    const overlay = document.getElementById('wizard-modal-overlay');
    if (!overlay) return;

    // 閉じる / スキップ
    document.getElementById('wizard-x-close')?.addEventListener('click', () => this.close());
    document.getElementById('wizard-cancel')?.addEventListener('click', () => this.close());

    // 戻る
    document.getElementById('wizard-prev')?.addEventListener('click', () => {
      this._saveCurrentStepState();
      this.currentStep--;
      this._renderModal();
    });

    // 次へ
    document.getElementById('wizard-next')?.addEventListener('click', () => {
      if (this._validateStep()) {
        this._saveCurrentStepState();
        this.currentStep++;
        this._renderModal();
      }
    });

    // 完了
    document.getElementById('wizard-finish')?.addEventListener('click', () => this.finish());

    // Step 1: 稼働モード切り替え
    overlay.querySelectorAll('input[name="share_mode"]').forEach(r => {
      r.addEventListener('change', () => {
        this._saveCurrentStepState();
        this.config.share_mode = r.value;
        this._renderModal();
      });
    });

    // Step 2: 連携方式切り替え
    overlay.querySelectorAll('input[name="conn_type"]').forEach(r => {
      r.addEventListener('change', () => {
        this._saveCurrentStepState();
        this.config.import_connection_type = r.value;
        this._renderModal();
      });
    });

    // Step 2: SMB認証モード切り替え
    overlay.querySelectorAll('input[name="smb_auth_mode"]').forEach(r => {
      r.addEventListener('change', () => {
        const credFields = document.getElementById('smb-cred-fields');
        if (credFields) credFields.style.display = r.value === 'credential' ? 'grid' : 'none';
        this.config.smb_auth_mode = r.value;
      });
    });

    // Step 2: ODBCビルダー → 接続文字列自動生成
    const odbcInputs = ['wiz-odbc-dsn', 'wiz-odbc-driver', 'wiz-odbc-server', 'wiz-odbc-db', 'wiz-odbc-uid', 'wiz-odbc-pwd'];
    odbcInputs.forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => this._buildOdbcConnStr());
    });

    // Step 2: ODBC接続テスト
    document.getElementById('btn-wiz-odbc-test')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-wiz-odbc-test');
      const result = document.getElementById('wiz-odbc-test-result');
      const connStr = document.getElementById('wiz-odbc-connstr')?.value || '';
      const query   = document.getElementById('wiz-odbc-query')?.value || '';
      if (!connStr) { result.innerHTML = '<span style="color:#dc2626">接続文字列を入力してください</span>'; return; }
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> テスト中...';
      result.innerHTML = '';
      try {
        const res = await window.electronAPI?.testOdbcConnection?.({ connStr, query });
        if (res && res.success) {
          result.innerHTML = `<span style="color:#16a34a"><i class="fas fa-check-circle"></i> 接続成功 (${res.rowCount ?? '?'}行取得)</span>`;
        } else {
          result.innerHTML = `<span style="color:#dc2626"><i class="fas fa-times-circle"></i> ${UI.escapeHTML(res?.error || '接続失敗')}</span>`;
        }
      } catch (e) {
        result.innerHTML = `<span style="color:#dc2626"><i class="fas fa-times-circle"></i> ${UI.escapeHTML(e.message)}</span>`;
      }
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plug"></i> 接続テスト';
    });

    // Step 3: 在室管理モード切り替え
    overlay.querySelectorAll('input[name="admission_mode"]').forEach(r => {
      r.addEventListener('change', () => {
        this._saveCurrentStepState();
        this.config.admission_mode = r.value;
        this._renderModal();
      });
    });

    // Step 4: デモデータ
    document.getElementById('wizard-insert-demo')?.addEventListener('change', e => {
      this.config.insert_demo = e.target.checked;
    });
  },

  // ODBCビルダー → 接続文字列を自動生成してテキストボックスに反映
  _buildOdbcConnStr() {
    const dsn    = document.getElementById('wiz-odbc-dsn')?.value.trim()    || '';
    const driver = document.getElementById('wiz-odbc-driver')?.value.trim() || '';
    const server = document.getElementById('wiz-odbc-server')?.value.trim() || '';
    const db     = document.getElementById('wiz-odbc-db')?.value.trim()     || '';
    const uid    = document.getElementById('wiz-odbc-uid')?.value.trim()    || '';
    const pwd    = document.getElementById('wiz-odbc-pwd')?.value           || '';

    let parts = [];
    if (dsn)    parts.push(`DSN=${dsn}`);
    if (driver) parts.push(`Driver={${driver}}`);
    if (server) parts.push(`Server=${server}`);
    if (db)     parts.push(`Database=${db}`);
    if (uid)    parts.push(`UID=${uid}`);
    if (pwd)    parts.push(`PWD=${pwd}`);

    const connStr = parts.length ? parts.join(';') + ';' : '';
    const el = document.getElementById('wiz-odbc-connstr');
    if (el) el.value = connStr;
  },

  // ─────────────────────────────────────────────────────
  //  状態保存・バリデーション
  // ─────────────────────────────────────────────────────

  _saveCurrentStepState() {
    if (this.currentStep === 1) {
      const r = document.querySelector('input[name="share_mode"]:checked');
      if (r) this.config.share_mode = r.value;
      const ip = document.getElementById('wizard-parent-ip');
      if (ip) this.config.parent_ip = ip.value.trim();
    }
    if (this.currentStep === 2) {
      const r = document.querySelector('input[name="conn_type"]:checked');
      if (r) this.config.import_connection_type = r.value;

      // CSV
      const dir = document.getElementById('wizard-csv-dir');
      if (dir) this.config.import_directory = dir.value.trim();
      const smbMode = document.querySelector('input[name="smb_auth_mode"]:checked');
      if (smbMode) this.config.smb_auth_mode = smbMode.value;
      const smbUser = document.getElementById('wizard-smb-user');
      if (smbUser) this.config.smb_username = smbUser.value;
      const smbPass = document.getElementById('wizard-smb-pass');
      if (smbPass) this.config.smb_password = smbPass.value;

      // ODBC
      const connStr = document.getElementById('wiz-odbc-connstr');
      if (connStr) this.config.odbc_connection_string = connStr.value.trim();
      const query = document.getElementById('wiz-odbc-query');
      if (query) this.config.odbc_sql_query = query.value.trim();
    }
    if (this.currentStep === 3) {
      const theme = document.getElementById('wizard-theme');
      if (theme) this.config.theme_style = theme.value;
      const zoom  = document.getElementById('wizard-zoom');
      if (zoom)  this.config.default_zoom = zoom.value;
      const font  = document.getElementById('wizard-font');
      if (font)  this.config.font_style = font.value;
      const ic    = document.getElementById('wizard-ic-association');
      if (ic)    this.config.enable_patient_ic_association = ic.checked ? 'true' : 'false';
      const adm   = document.querySelector('input[name="admission_mode"]:checked');
      if (adm)   this.config.admission_mode = adm.value;
    }
  },

  _validateStep() {
    if (this.currentStep === 1 && this.config.share_mode === 'client') {
      const ip = document.getElementById('wizard-parent-ip')?.value.trim();
      if (!ip) { UI.toast('子機モードでは親機IPアドレスを入力してください', 'warning'); return false; }
    }
    if (this.currentStep === 2 && this.config.import_connection_type === 'odbc') {
      const cs = document.getElementById('wiz-odbc-connstr')?.value.trim();
      if (!cs) { UI.toast('ODBC接続文字列を入力してください', 'warning'); return false; }
    }
    return true;
  },

  // ─────────────────────────────────────────────────────
  //  保存・完了
  // ─────────────────────────────────────────────────────

  async finish() {
    const finishBtn = document.getElementById('wizard-finish');
    if (finishBtn) { finishBtn.disabled = true; finishBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 適用中...'; }

    try {
      this._saveCurrentStepState();

      const promises = [
        API.patch('system_settings', 'share_mode',                    { value: this.config.share_mode }),
        API.patch('system_settings', 'parent_ip',                     { value: this.config.parent_ip }),
        API.patch('system_settings', 'import_connection_type',        { value: this.config.import_connection_type }),
        API.patch('system_settings', 'import_directory',              { value: this.config.import_directory }),
        API.patch('system_settings', 'odbc_connection_string',        { value: this.config.odbc_connection_string }),
        API.patch('system_settings', 'odbc_sql_query',                { value: this.config.odbc_sql_query }),
        API.patch('system_settings', 'smb_auth_mode',                 { value: this.config.smb_auth_mode }),
        API.patch('system_settings', 'smb_username',                  { value: this.config.smb_username }),
        API.patch('system_settings', 'smb_password',                  { value: this.config.smb_password }),
        API.patch('system_settings', 'admission_mode',                { value: this.config.admission_mode }),
        API.patch('system_settings', 'theme_style',                   { value: this.config.theme_style }),
        API.patch('system_settings', 'default_zoom',                  { value: this.config.default_zoom }),
        API.patch('system_settings', 'font_style',                    { value: this.config.font_style }),
        API.patch('system_settings', 'enable_patient_ic_association', { value: this.config.enable_patient_ic_association }),
        API.patch('system_settings', 'wizard_completed',              { value: 'true' }),
      ];

      await Promise.all(promises);

      localStorage.setItem('cfg_share_mode', this.config.share_mode);
      localStorage.setItem('cfg_parent_ip', this.config.parent_ip || '');

      if (this.config.share_mode === 'parent' && this.config.insert_demo) {
        await API.patch('system_settings', 'demo_inserted', { value: 'false' });
        await DemoData.setup();
      }

      UI.toast('初期設定が完了しました！', 'success');

      await App.loadMasters();
      await App.refreshData();
      await App.applySystemVisualSettings();
      WardDashboard.render();
      this.close();

      UI.toast('稼働モード設定を完全に反映するため、アプリの再起動を推奨します。', 'info');
    } catch (err) {
      console.error('[Wizard Finish Error]', err);
      UI.toast('設定の適用に失敗しました: ' + err.message, 'danger');
      if (finishBtn) {
        finishBtn.disabled = false;
        finishBtn.innerHTML = '<i class="fas fa-check-circle"></i> 設定を適用して完了';
      }
    }
  },

  close() {
    document.getElementById('wizard-modal-overlay')?.classList.add('hidden');
  }
};
