/**
 * TransBoard - 初期機能設定ウィザード
 */

const Wizard = {
  currentStep: 1,
  totalSteps: 4,
  config: {},

  async open() {
    const gs = id => AppState.systemSettings?.find(s => s.id === id)?.value;
    const terminalApiToken = await API.getTerminalApiToken();
    this.config = {
      // 未設定のときの画面上の初期値だけ親機にする。localStorage とローカルDBへは
      // 利用者が完了するまで書かない。AppState の share_mode は親機の値なので使わない。
      share_mode:                   readLocalShareMode() || 'parent',
      standalone:                   localStorage.getItem('cfg_standalone_mode') === 'true',
      terminal_role:                localStorage.getItem('cfg_terminal_role') === 'exam' ? 'exam' : 'ward',
      parent_ip:                    localStorage.getItem('cfg_parent_ip') || '',
      api_token:                    terminalApiToken,
      ward_id: localStorage.getItem('current_ward_id') || '',
      device_name: localStorage.getItem('_device_name') || '',
      import_connection_type:       gs('import_connection_type')       || 'csv',
      import_directory:             gs('import_directory')             || '',
      odbc_connection_string:       gs('odbc_connection_string')       || '',
      odbc_sql_query:               gs('odbc_sql_query')               || 'SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS',
      // 旧版のウィザードは 'credential' を書いていたが、main.js・設定画面はいずれも
      // 'custom' しか解釈しない（＝当時の設定は一度も効いていなかった）。読み取り時に
      // 読み替えて、保存し直すだけで自動的に復旧するようにする。
      smb_auth_mode:                (gs('smb_auth_mode') === 'credential' ? 'custom' : gs('smb_auth_mode')) || 'current',
      smb_username:                 gs('smb_username')                 || '',
      smb_password:                 gs('smb_password')                 || '',
      admission_mode:               gs('admission_mode') === 'hybrid' ? 'hybrid' : 'csv',
      font_style:                   localStorage.getItem('cfg_font_style') || gs('font_style') || 'ud',
      default_zoom:                 localStorage.getItem('cfg_app_zoom') || gs('default_zoom') || '1.0',
      enable_patient_ic_association: gs('enable_patient_ic_association') || 'false',
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

    const stepLabels = this.config.share_mode === 'client'
      ? ['接続設定', '端末・表示設定', '確認と完了']
      : ['稼働モード', '連携設定', '端末・表示設定', '確認と完了'];
    const steps = this.config.share_mode === 'client' ? [1, 3, 4] : [1, 2, 3, 4];
    this.totalSteps = steps.length;
    const stepIndex = steps.indexOf(this.currentStep);

    const progressDots = stepLabels.map((label, i) => {
      const n = i + 1;
      const done    = i < stepIndex;
      const current = i === stepIndex;
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
            ${this.currentStep !== 4
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
    // ウィザード上は3択(単独/親機共有/子機)。standalone/parentはどちらもshare_mode='parent'に集約する
    const role = this.config.share_mode === 'client' ? 'client' : (this.config.standalone ? 'standalone' : 'parent');
    const sel = v => role === v;
    return `
      <h4 class="wiz-step-title">1. 稼働モードの選択</h4>
      <p class="wiz-step-desc">このPCの役割を選択してください。1台だけで使う場合は「単独運用」、複数台で共有する場合は「親機」または「子機」を選びます。</p>
      <div class="wiz-radio-group">
        ${this._radioCard('wiz_role', 'standalone', sel('standalone'),
          'fa-desktop', '単独運用モード（この1台だけ）',
          'このPC1台で全工程を完結させます。接続端末表示・病棟間通話・検査室画面など複数台前提の機能は隠されます。')}
        ${this._radioCard('wiz_role', 'parent', sel('parent'),
          'fa-server', '親機モード（子機と共有 / サーバー）',
          'このPCがマスターデータと履歴を管理し、子機PCからの接続を受け付けます。')}
        ${this._radioCard('wiz_role', 'client', sel('client'),
          'fa-laptop', '子機モード（クライアント）',
          'ネットワーク上の親機PCに接続し、表示の同期・操作を行います。')}
      </div>
      <div class="wiz-sub-panel" style="margin-top:16px;">
        <label class="wiz-label">この端末の画面役割</label>
        <div class="wiz-radio-group" style="gap:8px;">
          ${this._radioCard('terminal_role', 'ward', this.config.terminal_role === 'ward',
            'fa-hospital', '病棟端末',
            '病棟選択・病床・通知を操作します。')}
          ${this._radioCard('terminal_role', 'exam', this.config.terminal_role === 'exam',
            'fa-x-ray', '検査室端末',
            '病棟選択を隠し、検査室の進捗管理を直接表示します。')}
        </div>
      </div>
      <div id="parent-ip-container" class="wiz-sub-panel" style="display:${sel('client') ? 'block' : 'none'};">
        <label class="wiz-label">親機のIPアドレス <span style="color:#dc2626">*</span></label>
        <input type="text" id="wizard-parent-ip" value="${UI.escapeHTML(this.config.parent_ip)}"
          placeholder="例: 192.168.1.100"
          class="wiz-input" style="font-family:monospace;">
        <label class="wiz-label" style="margin-top:10px;">APIトークン <span style="color:#dc2626">*</span></label>
        <input type="password" id="wizard-api-token" autocomplete="off" value="${UI.escapeHTML(this.config.api_token)}"
          placeholder="親機の「共有・ネットワーク設定」画面に表示されている値を入力"
          class="wiz-input" style="font-family:monospace; font-size:11px;">
        <div class="wiz-hint"><i class="fas fa-shield-alt"></i> 患者情報を含むデータの取得にはこのトークンが必須です。親機の管理者に確認してください。</div>
        <div style="display:flex; align-items:center; gap:8px; margin-top:10px;">
          <button class="btn btn-outline btn-sm" id="btn-wiz-test-connection">
            <i class="fas fa-plug"></i> 接続テスト
          </button>
          <button class="btn btn-outline btn-sm" id="btn-wiz-open-debug-log" title="診断ログをメモ帳で開く">
            <i class="fas fa-file-alt"></i> ログを開く
          </button>
        </div>
        <span id="wiz-test-connection-result" style="font-size:11px; display:block; margin-top:6px;"></span>
      </div>
    `;
  },

  // ── Step 2: 電子カルテ連携 ──────────────────────────
  _step2() {
    if (this.config.share_mode === 'client') {
      return `
        <h4 class="wiz-step-title">2. 電子カルテ連携の設定</h4>
        <p class="wiz-step-desc">この設定は親機でのみ行います。子機は親機が取り込んだ在床データを自動的に受け取ります。</p>
        <div class="wiz-sub-panel" style="text-align:center; padding:36px 16px; color:#64748b;">
          <i class="fas fa-server" style="font-size:28px; color:#94a3b8; margin-bottom:10px; display:block;"></i>
          子機では設定不要です。「次へ」に進んでください。
        </div>
      `;
    }
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
        <input type="text" id="wizard-csv-dir" value="${UI.escapeHTML(this.config.import_directory)}"
          placeholder="例: C:\\EMR_Export  または  \\\\fileserver\\share\\emr" class="wiz-input">
        <div class="wiz-hint"><i class="fas fa-network-wired"></i> ネットワーク共有（SMB）パスを使う場合は下の認証設定を入力してください。</div>
        <div style="margin-top:10px;">
          <label class="wiz-label" style="margin-bottom:6px;">SMB認証モード</label>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <label class="wiz-inline-radio">
              <input type="radio" name="smb_auth_mode" value="current"
                ${this.config.smb_auth_mode !== 'custom' ? 'checked' : ''}>
              現在のWindowsユーザーで接続
            </label>
            <label class="wiz-inline-radio">
              <input type="radio" name="smb_auth_mode" value="custom"
                ${this.config.smb_auth_mode === 'custom' ? 'checked' : ''}>
              別アカウントで接続
            </label>
          </div>
          <div id="smb-cred-fields" style="display:${this.config.smb_auth_mode === 'custom' ? 'grid' : 'none'}; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px;">
            <div>
              <label class="wiz-label">ユーザー名</label>
              <input type="text" id="wizard-smb-user" value="${UI.escapeHTML(this.config.smb_username)}" class="wiz-input" placeholder="domain\\user">
            </div>
            <div>
              <label class="wiz-label">パスワード</label>
              <input type="password" id="wizard-smb-pass" value="${UI.escapeHTML(this.config.smb_password)}" class="wiz-input" placeholder="••••••••">
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
      <h4 class="wiz-step-title">端末・表示設定</h4>
      <p class="wiz-step-desc">病棟・端末名・表示設定はこの端末に保存します。共有の管理設定は親機で設定します。</p>
      <label class="wiz-label">端末表示名 <span style="color:#dc2626">*</span></label>
      <input id="wizard-device-name" class="wiz-input" maxlength="64" value="${UI.escapeHTML(this.config.device_name || '')}" placeholder="例: 3階ナースステーション">
      ${this.config.terminal_role === 'ward' ? `
      <label class="wiz-label">担当病棟 <span style="color:#dc2626">*</span></label>
      <select id="wizard-ward" class="wiz-input">
        <option value="">病棟を選択してください</option>
        ${(this.config.wards || AppState.wards || []).map(w => `<option value="${UI.escapeHTML(String(w.id))}" ${String(w.id) === this.config.ward_id ? 'selected' : ''}>${UI.escapeHTML(w.name)}</option>`).join('')}
      </select>` : ''}

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px;">
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

      ${this.config.share_mode === 'parent' ? `
      <div style="margin-bottom:16px;">
        <label class="wiz-label" style="margin-bottom:8px;">在室管理モード</label>
        <div class="wiz-radio-group" style="gap:8px;">
          ${this._radioCard('admission_mode', 'csv', admSel('csv'),
            'fa-file-import', 'CSVインポートモード',
            '電子カルテ連携で取り込まれる在床リストをもとに患者を管理します。')}
          ${this._radioCard('admission_mode', 'hybrid', admSel('hybrid'),
            'fa-layer-group', 'ハイブリッドモード',
            'CSVで取り込みつつ、CSVにない患者を手動で追加登録できます。')}
        </div>
      </div>
      ` : `
      <div class="wiz-hint" style="margin-bottom:16px;"><i class="fas fa-info-circle"></i> 在室管理モードは親機の設定に従います。</div>
      `}

      ${this.config.share_mode === 'parent' ? `<label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; font-weight:700; color:var(--clr-text);">
        <input type="checkbox" id="wizard-ic-association" ${this.config.enable_patient_ic_association === 'true' ? 'checked' : ''}>
        患者ICカード（RFID）連携機能を有効化する
      </label>` : ''}
    `;
  },

  // ── Step 4: 確認と完了 ──────────────────────────────
  _step4() {
    const modeLabel   = this.config.share_mode === 'client'
      ? '子機モード'
      : (this.config.standalone ? '単独運用モード（この1台だけ）' : '親機モード（子機と共有）');
    const connLabels  = { csv: 'CSVファイル連携', odbc: 'ODBCデータベース連携', none: '手動入力' };
    const admLabels   = { csv: 'CSVインポート', hybrid: 'ハイブリッド' };

    const rows = [
      ['稼働モード',     modeLabel],
      this.config.share_mode === 'client' ? ['接続先親機IP', this.config.parent_ip || '（未設定）'] : null,
      ['画面役割', this.config.terminal_role === 'exam' ? '検査室' : '病棟'],
      ['端末表示名', this.config.device_name],
      this.config.terminal_role === 'ward' ? ['担当病棟', (this.config.wards || AppState.wards || []).find(w => String(w.id) === this.config.ward_id)?.name || this.config.ward_id] : null,
      this.config.share_mode === 'parent' ? ['外部連携方式', connLabels[this.config.import_connection_type]] : null,
      this.config.share_mode === 'parent' && this.config.import_connection_type === 'csv'  ? ['CSV監視フォルダ', this.config.import_directory || '（未設定）'] : null,
      this.config.share_mode === 'parent' && this.config.import_connection_type === 'odbc' ? ['ODBC接続文字列', this.config.odbc_connection_string ? '✅ 設定済み' : '⚠ 未設定'] : null,
      this.config.share_mode === 'parent' && this.config.import_connection_type === 'odbc' ? ['SQLクエリ',       this.config.odbc_sql_query ? '✅ 設定済み' : '⚠ 未設定'] : null,
      this.config.share_mode === 'parent' ? ['在室管理モード', admLabels[this.config.admission_mode]] : null,
      ['表示倍率',       parseFloat(this.config.default_zoom) * 100 + '%'],
      ['フォント',       this.config.font_style === 'ud' ? 'UDフォント' : '標準ゴシック'],
      this.config.share_mode === 'parent' ? ['ICカード連携', this.config.enable_patient_ic_association === 'true' ? '有効' : '無効'] : null,
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
        <div>
          <strong>子機モード — 設定後に再起動が必要です</strong><br>
          <span style="font-size:11px; font-weight:400;">親機PC (${UI.escapeHTML(this.config.parent_ip || '未指定')}) が起動・共有サーバーが動作している必要があります。
          「設定を適用して完了」ボタンを押すと再起動を促す画面に切り替わります。</span>
        </div>
      </div>` : '';

    const standaloneNote = (this.config.share_mode === 'parent' && this.config.standalone) ? `
      <div class="wiz-callout wiz-callout-info">
        <i class="fas fa-desktop"></i>
        <div>
          <strong>単独運用モード — この1台だけで運用します</strong><br>
          <span style="font-size:11px; font-weight:400;">検査室画面・病棟間通話・接続端末表示は隠されます。全工程を病棟画面から操作してください。あとから子機を追加する場合は「共有・ネットワーク設定」でOFFにできます。</span>
        </div>
      </div>` : '';

    return `
      <h4 class="wiz-step-title">設定内容の確認と完了</h4>
      <p class="wiz-step-desc">設定に間違いがないかご確認ください。既存の移送履歴や登録データはそのまま維持されます。</p>
      <table style="width:100%; border-collapse:collapse; font-size:12px; background:rgba(0,0,0,.02); border-radius:8px; overflow:hidden; border:1px solid var(--clr-border);">
        ${tableRows}
      </table>
      ${clientWarning}
      ${standaloneNote}
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
      this.currentStep = this.config.share_mode === 'client' && this.currentStep === 3 ? 1 : this.currentStep - 1;
      this._renderModal();
    });

    // 次へ
    document.getElementById('wizard-next')?.addEventListener('click', async () => {
      const btn = document.getElementById('wizard-next');
      if (this._advancing) return;
      this._advancing = true;
      if (btn) btn.disabled = true;
      try {
        this._saveCurrentStepState();
        if (this._validateStep() && (this.currentStep !== 1 || await this._verifyClientConnection())) {
          this.currentStep = this.config.share_mode === 'client' && this.currentStep === 1 ? 3 : this.currentStep + 1;
          this._renderModal();
        }
      } catch (err) {
        UI.toast('接続確認に失敗しました: ' + err.message, 'danger');
      } finally {
        this._advancing = false;
        if (btn) btn.disabled = false;
      }
    });

    // 完了
    document.getElementById('wizard-finish')?.addEventListener('click', () => this.finish());

    // Step 1: 稼働モード切り替え（単独/親機共有/子機の3択→share_mode+standaloneに集約）
    overlay.querySelectorAll('input[name="terminal_role"]').forEach(r => {
      r.addEventListener('change', () => {
        this.config.terminal_role = r.value === 'exam' ? 'exam' : 'ward';
      });
    });

    overlay.querySelectorAll('input[name="wiz_role"]').forEach(r => {
      r.addEventListener('change', () => {
        this._saveCurrentStepState();
        this.config.share_mode = r.value === 'client' ? 'client' : 'parent';
        this.config.standalone = r.value === 'standalone';
        this._renderModal();
      });
    });

    // Step 1: 親機への接続テスト
    document.getElementById('btn-wiz-test-connection')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-wiz-test-connection');
      const result = document.getElementById('wiz-test-connection-result');
      const parentIp = document.getElementById('wizard-parent-ip')?.value.trim();
      if (!parentIp) {
        if (result) result.innerHTML = '<span style="color:#dc2626">親機のIPアドレスを入力してください</span>';
        return;
      }
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> テスト中...';
      if (result) result.innerHTML = '';
      const token = document.getElementById('wizard-api-token')?.value.trim() || '';
      const testResult = await testParentConnection(parentIp, token, 'Wizard接続テスト');
      if (result) {
        switch (testResult.outcome) {
          case 'ok':
            result.innerHTML = `<span style="color:#16a34a"><i class="fas fa-check-circle"></i> 接続成功（病棟 ${testResult.wardsCount ?? '?'}件・APIトークン認証もOK）</span>`;
            break;
          case 'token-mismatch':
            result.innerHTML = `<span style="color:#d97706"><i class="fas fa-key"></i> ネットワークは正常ですが、<b>APIトークンが親機と一致しません</b>。親機の「共有・ネットワーク設定」画面のトークンをコピーし直してください</span>`;
            break;
          case 'token-http-error':
            result.innerHTML = `<span style="color:#dc2626"><i class="fas fa-times-circle"></i> トークン検証でHTTPエラー ${testResult.status}</span>`;
            break;
          case 'token-exception':
            result.innerHTML = `<span style="color:#dc2626"><i class="fas fa-times-circle"></i> トークン検証中にエラー（${UI.escapeHTML(testResult.error.message || testResult.error.name)}）</span>`;
            break;
          case 'no-token':
            result.innerHTML = `<span style="color:#d97706"><i class="fas fa-exclamation-triangle"></i> 疎通は成功（病棟 ${testResult.wardsCount ?? '?'}件）。ただし<b>APIトークンが未入力</b>のため、患者データの取得はできません。親機のトークンを入力してください</span>`;
            break;
          case 'http-error':
            result.innerHTML = `<span style="color:#dc2626"><i class="fas fa-times-circle"></i> HTTPエラー ${testResult.status}</span>`;
            break;
          case 'exception':
            result.innerHTML = `<span style="color:#dc2626"><i class="fas fa-times-circle"></i> 接続できませんでした（${UI.escapeHTML(testResult.reason)}）。IPアドレスや親機の起動状態、ファイアウォールを確認してください</span>`;
            break;
        }
      }
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plug"></i> 接続テスト';
    });

    // 診断ログをメモ帳等で開く（DevTools操作なしで確認できるようにする）
    document.getElementById('btn-wiz-open-debug-log')?.addEventListener('click', () => {
      window.electronAPI?.openDebugLog?.().catch(() => {
        UI.toast('ログファイルを開けませんでした', 'danger');
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
        if (credFields) credFields.style.display = r.value === 'custom' ? 'grid' : 'none';
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
      const r = document.querySelector('input[name="wiz_role"]:checked');
      if (r) {
        this.config.share_mode = r.value === 'client' ? 'client' : 'parent';
        this.config.standalone = r.value === 'standalone';
      }
      const terminalRole = document.querySelector('input[name="terminal_role"]:checked');
      if (terminalRole) this.config.terminal_role = terminalRole.value === 'exam' ? 'exam' : 'ward';
      const ip = document.getElementById('wizard-parent-ip');
      if (ip) this.config.parent_ip = ip.value.trim();
      const token = document.getElementById('wizard-api-token');
      if (token) this.config.api_token = token.value.trim();
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
      const ward = document.getElementById('wizard-ward');
      if (ward) this.config.ward_id = ward.value;
      const name = document.getElementById('wizard-device-name');
      if (name) this.config.device_name = name.value.trim();
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
      const token = document.getElementById('wizard-api-token')?.value.trim();
      if (!token) { UI.toast('APIトークンを入力してください', 'warning'); return false; }
    }
    if (this.currentStep === 2 && this.config.share_mode === 'parent' && this.config.import_connection_type === 'odbc') {
      const cs = document.getElementById('wiz-odbc-connstr')?.value.trim();
      if (!cs) { UI.toast('ODBC接続文字列を入力してください', 'warning'); return false; }
    }
    if (this.currentStep === 3) {
      this._saveCurrentStepState();
      if (!this.config.device_name) { UI.toast('端末表示名を入力してください', 'warning'); return false; }
      if (this.config.terminal_role === 'ward' && !(this.config.wards || AppState.wards || []).some(w => String(w.id) === this.config.ward_id)) {
        UI.toast('担当病棟を選択してください', 'warning'); return false;
      }
    }
    return true;
  },

  async _verifyClientConnection() {
    if (this.config.share_mode !== 'client') return true;
    if (!this.config.parent_ip || !this.config.api_token) {
      UI.toast('親機IPアドレスとAPIトークンを入力してください', 'warning'); return false;
    }
    const result = await testParentConnection(this.config.parent_ip, this.config.api_token, 'Wizard完了前検証');
    if (result.outcome !== 'ok') {
      UI.toast('親機への接続・認証を確認できませんでした。接続テストで設定を確認してください', 'danger'); return false;
    }
    // Fetch choices from the selected parent, not the previously loaded local DB.
    const res = await parentFetch(`http://${this.config.parent_ip}:3005/api/tables/wards`, {
      headers: { 'X-API-Token': this.config.api_token }, purpose: 'connection-test',
    }, 4000);
    if (!res.ok) throw new Error('親機の病棟一覧を取得できませんでした');
    this.config.wards = (await res.json()).data || [];
    return true;
  },

  // ─────────────────────────────────────────────────────
  //  保存・完了
  // ─────────────────────────────────────────────────────

  async finish() {
    if (this._finishing) return;
    this._finishing = true;
    const finishBtn = document.getElementById('wizard-finish');
    if (finishBtn) { finishBtn.disabled = true; finishBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 適用中...'; }

    try {
      this._saveCurrentStepState();

      if (!await this._verifyClientConnection()) return;
      if (!this.config.device_name || (this.config.terminal_role === 'ward' &&
          !(this.config.wards || AppState.wards || []).some(w => String(w.id) === this.config.ward_id))) {
        throw new Error('端末表示名と担当病棟を確認してください');
      }
      localStorage.removeItem('cfg_wizard_completed');
      // Persist pending first: any later failure must remain visibly incomplete.
      const role = {
        shareMode: this.config.share_mode, parentIp: this.config.parent_ip || '',
        terminalRole: this.config.terminal_role === 'exam' ? 'exam' : 'ward',
        wardId: this.config.ward_id || '', deviceName: this.config.device_name,
        setupCompleted: false, provisioningError: '',
      };
      const pending = await window.electronAPI?.setTerminalRole?.(role);
      if (!pending?.success) throw new Error(pending?.message || '端末設定を保存できませんでした');
      App._terminalSetupPending = true;
      const tokenSave = await API.setTerminalApiToken(this.config.api_token || '');
      if (!tokenSave?.success) throw new Error(tokenSave?.message || 'APIトークンを安全に保存できませんでした');
      await saveLocalShareModeSettings(this.config.share_mode, this.config.parent_ip || '');
      localStorage.setItem('cfg_share_mode', role.shareMode);
      localStorage.setItem('cfg_parent_ip', role.parentIp);
      localStorage.setItem('cfg_terminal_role', role.terminalRole);
      localStorage.setItem('current_ward_id', role.wardId);
      localStorage.setItem('_device_name', role.deviceName);
      localStorage.setItem('cfg_app_zoom', this.config.default_zoom);
      localStorage.setItem('cfg_font_style', this.config.font_style);
      localStorage.setItem('cfg_standalone_mode',
        (this.config.share_mode === 'parent' && this.config.standalone) ? 'true' : 'false');

      // Child setup has no shared writes. Local display overrides already exist.
      if (this.config.share_mode === 'parent') {
        const ids = ['enable_patient_ic_association', 'import_connection_type', 'import_directory',
          'odbc_connection_string', 'odbc_sql_query', 'smb_auth_mode', 'smb_username',
          'smb_password', 'admission_mode'];
        for (const id of ids) {
          const result = await API.patch('system_settings', id, { value: this.config[id] });
          if (result?.success === false) throw new Error(result.message || '共有設定を保存できませんでした');
        }
        const completed = await API.patch('system_settings', 'wizard_completed', { value: 'true' });
        if (completed?.success === false) throw new Error(completed.message || '完了状態を保存できませんでした');
        if (await App.loadMasters() === false) throw new Error('マスターを読み込めませんでした');
        AppState.currentWardId = this.config.ward_id;
        App.syncWardSelect();
        if (await App.refreshData() === false) throw new Error('データを読み込めませんでした');
        await App.applySystemVisualSettings();
      }
      const saved = await window.electronAPI.setTerminalRole({ ...role, setupCompleted: true });
      if (!saved?.success) throw new Error(saved?.message || '完了状態を保存できませんでした');
      localStorage.setItem('cfg_wizard_completed', 'true');
      App._terminalSetupPending = false;
      UI.toast('初期設定が完了しました', 'success');

      if (this.config.share_mode === 'client') {
        // 子機モード: データ接続先が変わるため再起動するまで正常動作しない
        // loadMasters() を呼ばず、再起動を促す専用画面に切り替える
        this._showClientRestartScreen();
        return;
      }

      // 単独運用モードのUI反映（検査室タブ・通話ボタン・接続端末チップ）とポーリング再判定
      App._applyStandaloneMode();
      App._applyTerminalRoleMode({ navigate: false });
      App._startDevicePresenceMonitor();
      if (App.isExamTerminal()) UI.switchPage('exam-room');
      else WardDashboard.render();
      this.close();
    } catch (err) {
      console.error('[Wizard Finish Error]', err);
      UI.toast('設定の適用に失敗しました: ' + err.message, 'danger');
    } finally {
      this._finishing = false;
      if (finishBtn) {
        finishBtn.disabled = false;
        finishBtn.innerHTML = '<i class="fas fa-check-circle"></i> 設定を適用して完了';
      }
    }
  },

  // 子機モード完了後に再起動を促す画面を表示する
  _showClientRestartScreen() {
    const overlay = document.getElementById('wizard-modal-overlay');
    if (!overlay) return;

    overlay.innerHTML = `
      <div class="modal wiz-modal" style="max-width:480px; text-align:center;">
        <div class="modal-body" style="padding:40px 32px;">
          <div style="font-size:48px; margin-bottom:16px; color:#3b82f6;">
            <i class="fas fa-check-circle" style="color:#16a34a;"></i>
          </div>
          <h2 style="font-size:20px; font-weight:800; margin-bottom:8px;">設定が完了しました</h2>
          <p style="color:#64748b; font-size:13px; line-height:1.7; margin-bottom:24px;">
            子機モードの設定を保存しました。<br>
            接続先の親機 (<strong>${UI.escapeHTML(this.config.parent_ip || '未指定')}</strong>) へのデータ接続を有効にするには、アプリを再起動してください。
          </p>
          <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:12px 16px; margin-bottom:24px; font-size:12px; color:#1e40af; text-align:left;">
            <i class="fas fa-info-circle"></i>
            <strong>再起動するまでの間</strong>、マスタデータや病床マップが正しく表示されない場合があります。
            再起動後に自動的に親機から最新データを取得します。
          </div>
          <div style="display:flex; gap:12px; justify-content:center;">
            <button class="btn btn-primary btn-lg" id="wiz-relaunch-btn" style="min-width:160px;">
              <i class="fas fa-redo"></i> 今すぐ再起動
            </button>
            <button class="btn btn-outline" id="wiz-close-btn" style="min-width:120px;">
              後で再起動
            </button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('wiz-relaunch-btn')?.addEventListener('click', () => {
      if (window.electronAPI?.relaunchApp) {
        window.electronAPI.relaunchApp();
      } else {
        location.reload();
      }
    });

    document.getElementById('wiz-close-btn')?.addEventListener('click', () => {
      this.close();
    });
  },

  close() {
    document.getElementById('wizard-modal-overlay')?.classList.add('hidden');
  }
};
