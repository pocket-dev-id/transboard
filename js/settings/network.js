/**
 * TransBoard - 設定画面: 共有・ネットワーク設定
 */

Object.assign(Settings, {

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
        if (await UI.confirmModal('設定を完全に反映するためには、アプリケーションの再起動が必要です。今すぐ再起動しますか？', { confirmLabel: '再起動' })) {
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
        if (!await UI.confirmModal(`帰棟済・キャンセル済のイベントのうち${label}のものを削除します。この操作は元に戻せません。続けますか？`, { danger: true, confirmLabel: '削除' })) return;
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

        if (!await UI.confirmModal(confirmMsg)) return;

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
        if (!await UI.confirmModal('バックアップから復元を実行しますか？\n現在のすべてのマスターデータ、履歴、設定が消去・上書きされ、アプリが自動再起動します。', { danger: true, confirmLabel: '復元' })) {
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
            if (!await UI.confirmModal('この端末を接続一覧から削除しますか？', { danger: true, confirmLabel: '削除' })) return;
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

});
