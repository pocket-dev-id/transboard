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

    // DBファイル暗号化の可用性を確認（セキュリティ B-3）
    const encStatus = window.electronAPI && window.electronAPI.getEncryptionStatus
      ? await window.electronAPI.getEncryptionStatus().catch(() => null)
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

    const preventSleep = localStorage.getItem('cfg_prevent_sleep') === 'true';
    const alwaysOnTop  = localStorage.getItem('cfg_always_on_top') === 'true';

    body.innerHTML = `
      ${encStatus && !encStatus.available ? `
      <div class="settings-panel" style="margin-bottom:16px; background:#fef2f2; border:1px solid #fca5a5;">
        <div style="display:flex; align-items:flex-start; gap:10px; padding:4px;">
          <i class="fas fa-exclamation-triangle" style="color:#dc2626; font-size:18px; margin-top:2px;"></i>
          <div>
            <strong style="color:#991b1b;">この端末ではデータベースの暗号化機能が利用できません</strong>
            <p style="font-size:12px; color:#991b1b; margin:4px 0 0 0;">
              OSの資格情報ストア（Windows資格情報マネージャー等）にアクセスできないため、患者情報を含むデータベースファイルが平文で保存されています。
              OSアカウントのログインパスワード設定や、資格情報ストアの状態をご確認ください。
            </p>
          </div>
        </div>
      </div>
      ` : ''}
      <!-- 端末動作設定 -->
      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-desktop"></i> 端末動作設定</h3>
        </div>
        <p class="settings-hint">
          <i class="fas fa-info-circle"></i>
          この端末にのみ適用される動作設定です。保存不要で即時反映されます。
        </p>
        <div style="display:flex; flex-direction:column; gap:12px;">
          <label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-size:13px; font-weight:600;">
            <input type="checkbox" id="chk-prevent-sleep" ${preventSleep ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
            <div>
              <div><i class="fas fa-moon" style="color:#7c3aed; margin-right:4px;"></i> スクリーンセイバー・スリープを抑制する</div>
              <div style="font-size:11px; color:var(--clr-text-muted); font-weight:400; margin-top:1px;">有効にするとディスプレイのスリープ・スクリーンセイバーの起動を防止します（常時表示モニター向け）</div>
            </div>
          </label>
          <label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-size:13px; font-weight:600;">
            <input type="checkbox" id="chk-always-on-top" ${alwaysOnTop ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
            <div>
              <div><i class="fas fa-layer-group" style="color:#0284c7; margin-right:4px;"></i> 常に最前面に表示する</div>
              <div style="font-size:11px; color:var(--clr-text-muted); font-weight:400; margin-top:1px;">有効にすると他のウィンドウより手前に固定表示されます（ナースステーション掲示板モード向け）</div>
            </div>
          </label>
        </div>
      </div>

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
            <div class="form-row" style="margin-bottom:12px;">
              <label>APIトークン <span style="color:#dc2626">*</span></label>
              <input type="text" id="cfg-api-token" placeholder="親機の「共有・ネットワーク設定」画面に表示されている値を入力" style="width:100%; max-width:420px; padding:8px; border:1px solid #cbd5e0; border-radius:6px; font-family:monospace; font-size:12px;" value="${localStorage.getItem('cfg_api_token') || ''}">
              <p style="font-size:11px; color:#718096; margin:4px 0 0 0;">患者情報を含むデータの取得にはこのトークンが必須です。親機の管理者に確認してください。</p>
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
            <div style="margin-top:14px; padding-top:14px; border-top:1px dashed #fca5a5;">
              <label style="font-size:12px; font-weight:700; color:#991b1b;">APIトークン（患者情報保護用・子機に設定する値）</label>
              <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                <input type="text" id="cfg-api-token-display" readonly style="flex:1; max-width:420px; padding:8px; border:1px solid #fca5a5; border-radius:6px; font-family:monospace; font-size:12px; background:#fef2f2;" value="${AppState.systemSettings?.find(s => s.id === 'api_token')?.value || '(初回起動時に自動生成されます)'}">
                <button class="btn btn-outline btn-sm" id="btn-copy-api-token" title="コピー"><i class="fas fa-copy"></i></button>
                <button class="btn btn-outline btn-sm" id="btn-regen-api-token" title="再生成（全子機で再設定が必要になります）"><i class="fas fa-sync-alt"></i></button>
              </div>
              <p style="font-size:11px; color:#991b1b; margin:6px 0 0 0;">このトークンを各子機PCの「共有・ネットワーク設定」画面に入力してください。再生成すると、全ての子機で入力し直しが必要になります。</p>
            </div>
          </div>

          <!-- アプリの更新・配信 -->
          <div style="border-top:1px solid #e2e8f0; padding-top:16px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-arrow-circle-up"></i> アプリの更新
              <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#e0f2fe; color:#0369a1; font-weight:800;">個別設定（PCごと）</span>
            </h4>
            <div style="font-size:12px; color:#4a5568; margin-bottom:8px;">
              現在のバージョン: <b>v${AppState.appVersion || '-'}</b>
            </div>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600; color:#2d3748;">
              <input type="checkbox" id="cfg-auto-update-check" ${localStorage.getItem('cfg_auto_update_check') !== 'false' ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
              起動時と24時間ごとに更新を自動チェックする
            </label>
            <div style="font-size:11px; color:#718096; margin-top:4px; padding-left:24px;">
              ${currentMode === 'parent' ? '親機は自身の配信フォルダ（下記で取り込んだ更新）をチェックします。' : '子機は親機の配信フォルダをチェックします。更新は通知のみで、インストールは常に手動で開始します。'}
            </div>
            <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
              <button class="btn btn-outline btn-sm" id="btn-check-update-now"><i class="fas fa-sync-alt"></i> 今すぐ更新を確認</button>
              <span id="upd-check-result" style="font-size:12px; color:#64748b;"></span>
            </div>

            <!-- 親機のみ: 子機への配信管理 -->
            <div id="update-dist-panel" style="display:${currentMode === 'parent' ? 'block' : 'none'}; margin-top:14px; padding-top:14px; border-top:1px dashed #cbd5e0;">
              <div style="font-size:13px; font-weight:700; color:#2d3748; margin-bottom:4px;">
                <i class="fas fa-broadcast-tower"></i> 子機への更新配信
                <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:#fee2e2; color:#b91c1c; font-weight:800;">親機専用</span>
              </div>
              <p style="font-size:11px; color:#718096; margin:0 0 8px 0;">
                GitHub Releases から <code style="background:#edf2f7; padding:1px 4px; border-radius:3px;">latest.yml</code> とインストーラ（.exe）をダウンロードし、ここで取り込むとLAN内の全端末（この親機を含む）へ更新を配信できます。取込時にファイルの整合性（sha512）を検証するため、破損・組み合わせ違いのファイルは配信されません。
              </p>
              <div id="upd-dist-status" style="font-size:12px; color:#4a5568; margin-bottom:8px;">読み込み中...</div>
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button class="btn btn-primary btn-sm" id="btn-import-update"><i class="fas fa-file-import"></i> 更新ファイルを取込</button>
                <button class="btn btn-outline btn-sm" id="btn-rollback-update"><i class="fas fa-undo"></i> 1つ前の配信に戻す</button>
              </div>
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

            <!-- ビデオ通話品質 -->
            <div style="margin-top:14px; padding-top:14px; border-top:1px dashed #e2e8f0;">
              <div style="font-size:13px; font-weight:700; color:#2d3748; margin-bottom:4px;"><i class="fas fa-video"></i> ビデオ通話品質</div>
              <p style="font-size:11px; color:#718096; margin:0 0 10px 0;"><i class="fas fa-info-circle"></i> この設定はこの端末にのみ適用されます。院内Wi-Fiが不安定な場合は低画質を選択してください。</p>
              <div id="video-quality-btns" style="display:flex;gap:10px;flex-wrap:wrap;">
                ${[
                  { key:'low',    icon:'fa-signal', label:'低画質',  sub:'320×240 / 10fps / 200kbps',   col:'#64748b' },
                  { key:'medium', icon:'fa-signal', label:'標準',    sub:'640×480 / 15fps / 500kbps',   col:'#3b82f6' },
                  { key:'high',   icon:'fa-signal', label:'高画質',  sub:'1280×720 / 30fps / 1500kbps', col:'#16a34a' },
                ].map(p => `
                  <label style="flex:1;min-width:110px;display:flex;flex-direction:column;align-items:center;gap:4px;
                    border:2px solid #e2e8f0;border-radius:8px;padding:10px 8px;cursor:pointer;
                    background:#fafafa;transition:border-color .15s;" class="vq-label" data-key="${p.key}">
                    <input type="radio" name="video-quality" value="${p.key}" style="display:none;">
                    <i class="fas ${p.icon}" style="font-size:18px;color:${p.col};"></i>
                    <span style="font-weight:700;font-size:13px;">${p.label}</span>
                    <span style="font-size:10px;color:#6b7280;">${p.sub}</span>
                  </label>
                `).join('')}
              </div>
              <div style="margin-top:10px;display:flex;justify-content:flex-end;">
                <button class="btn btn-primary btn-sm" id="btn-save-video-quality"><i class="fas fa-save"></i> 画質を保存</button>
              </div>
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
            <div style="margin-bottom:10px;">
              <label style="display:block; font-size:12px; font-weight:700; color:#2d3748; margin-bottom:6px;">バックアップ形式</label>
              <label style="display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:4px; cursor:pointer;">
                <input type="radio" name="backup-mode" value="encrypted" checked> パスワードで暗号化する（患者情報を含む・推奨）
              </label>
              <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;">
                <input type="radio" name="backup-mode" value="redacted"> 患者情報を除いて出力する（平文・調査用途向け）
              </label>
            </div>
            <div class="form-row" id="backup-password-row" style="margin-bottom:12px;">
              <label style="font-size:12px;">パスワード <span style="font-size:11px; color:#718096; font-weight:400;">（暗号化バックアップの作成・復元時に使用）</span></label>
              <input type="password" id="cfg-backup-password" style="width:100%; max-width:280px; padding:6px 8px; border:1px solid #cbd5e0; border-radius:6px;" placeholder="バックアップ用パスワード">
            </div>
            <div style="display:flex; gap:12px;">
              <button class="btn btn-outline btn-sm" id="btn-backup-db" style="border-color:#4b5563; color:#4b5563;">
                <i class="fas fa-file-download"></i> バックアップを保存
              </button>
              <button class="btn btn-danger btn-sm" id="btn-restore-db" style="background:#dc2626; border-color:#dc2626; color:#fff;">
                <i class="fas fa-file-upload"></i> バックアップから復元 (リストア)
              </button>
            </div>
            <div style="font-size:11px; color:#c53030; font-weight:700; margin-top:6px;">
              ※注意: バックアップから復元すると、現在のすべての履歴と設定が上書きされます。<br>
              ※パスワードは忘れないよう安全な場所に控えてください。忘れると復元できません。
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
        const distPanel = document.getElementById('update-dist-panel');
        if (distPanel) distPanel.style.display = isClient ? 'none' : 'block';
      });
    });

    // 端末動作設定 — スリープ抑制
    const preventSleepChk = body.querySelector('#chk-prevent-sleep');
    if (preventSleepChk) {
      preventSleepChk.onchange = () => {
        const val = preventSleepChk.checked;
        localStorage.setItem('cfg_prevent_sleep', val ? 'true' : 'false');
        if (window.electronAPI?.setPowerSave) {
          window.electronAPI.setPowerSave(val);
          UI.toast(val ? 'スリープ・スクリーンセイバーを抑制します' : 'スリープ抑制を解除しました', 'info');
        }
      };
    }

    // 端末動作設定 — 最前面表示
    const alwaysOnTopChk = body.querySelector('#chk-always-on-top');
    if (alwaysOnTopChk) {
      alwaysOnTopChk.onchange = () => {
        const val = alwaysOnTopChk.checked;
        localStorage.setItem('cfg_always_on_top', val ? 'true' : 'false');
        if (window.electronAPI?.setAlwaysOnTop) {
          window.electronAPI.setAlwaysOnTop(val);
          UI.toast(val ? '最前面表示を有効にしました' : '最前面表示を解除しました', 'info');
        }
      };
    }

    // ウィザード起動ボタン
    const wizardBtn = document.getElementById('btn-launch-wizard');
    if (wizardBtn) {
      wizardBtn.onclick = () => {
        Wizard.open();
      };
    }

    // APIトークンのコピー・再生成ボタン
    const copyTokenBtn = document.getElementById('btn-copy-api-token');
    if (copyTokenBtn) {
      copyTokenBtn.onclick = async () => {
        const val = document.getElementById('cfg-api-token-display')?.value || '';
        try {
          await navigator.clipboard.writeText(val);
          UI.toast('APIトークンをコピーしました', 'success');
        } catch (e) {
          UI.toast('コピーに失敗しました', 'danger');
        }
      };
    }
    const regenTokenBtn = document.getElementById('btn-regen-api-token');
    if (regenTokenBtn) {
      regenTokenBtn.onclick = async () => {
        const ok = await UI.confirmModal('APIトークンを再生成しますか？', {
          title: 'APIトークンの再生成',
          detail: '再生成すると、現在このトークンを設定している全ての子機で再入力が必要になります。',
          type: 'warning',
          confirmLabel: '再生成する',
        });
        if (!ok) return;
        try {
          const newToken = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');
          await API.patch('system_settings', 'api_token', { value: newToken });
          const s = AppState.systemSettings?.find(x => x.id === 'api_token');
          if (s) s.value = newToken; else AppState.systemSettings.push({ id: 'api_token', value: newToken });
          document.getElementById('cfg-api-token-display').value = newToken;
          UI.toast('APIトークンを再生成しました。各子機の設定画面で入力し直してください。', 'success', 6000);
        } catch (e) {
          UI.toast('再生成に失敗しました: ' + e.message, 'danger');
        }
      };
    }

    // アプリ更新 — 自動チェック設定・手動チェック・配信管理
    const autoUpdateChk = document.getElementById('cfg-auto-update-check');
    if (autoUpdateChk) {
      autoUpdateChk.onchange = () => {
        localStorage.setItem('cfg_auto_update_check', autoUpdateChk.checked ? 'true' : 'false');
        UI.toast(autoUpdateChk.checked ? '更新の自動チェックを有効にしました' : '更新の自動チェックを無効にしました', 'info');
      };
    }

    const checkUpdateBtn = document.getElementById('btn-check-update-now');
    if (checkUpdateBtn) {
      checkUpdateBtn.onclick = async () => {
        const resultEl = document.getElementById('upd-check-result');
        if (!window.electronAPI?.checkForUpdate) {
          if (resultEl) resultEl.textContent = 'この環境では更新チェックを利用できません';
          return;
        }
        checkUpdateBtn.disabled = true;
        if (resultEl) resultEl.textContent = '確認中...';
        const res = await window.electronAPI.checkForUpdate({ parentIp: App._getUpdateParentIp() }).catch(e => ({ success: false, message: e.message }));
        checkUpdateBtn.disabled = false;
        if (!resultEl) return;
        if (!res?.success) {
          resultEl.textContent = `確認できませんでした（${res?.message || '不明なエラー'}）`;
          resultEl.style.color = '#b91c1c';
        } else if (res.updateAvailable) {
          resultEl.textContent = `新しいバージョン v${res.latestVersion} が利用可能です`;
          resultEl.style.color = '#16a34a';
          App._showUpdateAvailable(res);
        } else {
          resultEl.textContent = `最新です (v${res.currentVersion})`;
          resultEl.style.color = '#64748b';
        }
      };
    }

    // 親機のみ: 配信状況の表示・取込・ロールバック
    const refreshDistStatus = async () => {
      const statusEl = document.getElementById('upd-dist-status');
      if (!statusEl || !window.electronAPI?.getUpdateDistInfo) return;
      const info = await window.electronAPI.getUpdateDistInfo().catch(() => null);
      if (!info?.success) {
        statusEl.textContent = '配信状況を取得できませんでした';
        return;
      }
      const parts = [];
      if (info.serving) {
        if (info.serving.fileExists) {
          parts.push(`配信中: <b style="color:#16a34a;">v${UI.escapeHTML(info.serving.version || '?')}</b>（${UI.escapeHTML(info.serving.fileName || '')}）`);
        } else {
          parts.push(`<span style="color:#b91c1c;">配信設定 v${UI.escapeHTML(info.serving.version || '?')} のインストーラが見つかりません。再取込してください</span>`);
        }
      } else {
        parts.push('配信中の更新はありません');
      }
      if (info.archived?.version) {
        parts.push(`ロールバック可: v${UI.escapeHTML(info.archived.version)}`);
      }
      statusEl.innerHTML = parts.join(' ｜ ');
      const rollbackBtn = document.getElementById('btn-rollback-update');
      if (rollbackBtn) rollbackBtn.disabled = !info.archived?.version;
    };
    if ((localStorage.getItem('cfg_share_mode') || 'parent') === 'parent') refreshDistStatus();

    const importUpdateBtn = document.getElementById('btn-import-update');
    if (importUpdateBtn) {
      importUpdateBtn.onclick = async () => {
        if (!window.electronAPI?.importUpdateFiles) return;
        importUpdateBtn.disabled = true;
        const res = await window.electronAPI.importUpdateFiles().catch(e => ({ success: false, message: e.message }));
        importUpdateBtn.disabled = false;
        if (res?.canceled) return;
        if (res?.success) {
          UI.toast(`v${res.version} の配信を開始しました。各端末は次回チェック時に更新通知を受け取ります`, 'success', 6000);
          refreshDistStatus();
        } else {
          UI.toast(`取込に失敗しました: ${res?.message || '不明なエラー'}`, 'danger', 6000);
        }
      };
    }

    const rollbackUpdateBtn = document.getElementById('btn-rollback-update');
    if (rollbackUpdateBtn) {
      rollbackUpdateBtn.onclick = async () => {
        if (!window.electronAPI?.rollbackUpdateDist) return;
        const ok = await UI.confirmModal('配信を1つ前のバージョンに戻しますか？', {
          title: '配信のロールバック',
          detail: '現在配信中のファイルは削除され、前回取込のバージョンが再配信されます。すでに新バージョンへ更新済みの端末を戻すには、その端末で旧インストーラを手動実行してください。',
          type: 'warning',
          confirmLabel: '戻す',
        });
        if (!ok) return;
        const res = await window.electronAPI.rollbackUpdateDist().catch(e => ({ success: false, message: e.message }));
        if (res?.success) {
          UI.toast(`配信を v${res.version} に戻しました`, 'success');
          refreshDistStatus();
        } else {
          UI.toast(`ロールバックに失敗しました: ${res?.message || '不明なエラー'}`, 'danger');
        }
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
          const reason = e.name === 'AbortError'
            ? 'タイムアウトしました（4秒応答なし）'
            : `${e.name || 'Error'}: ${e.message || '原因不明'}`;
          UI.toast(`❌ 接続できませんでした（${reason}）。IPアドレスが正しいか、親機が起動しているか、またはネットワーク設定（ファイアウォール）を確認してください。`, 'danger', 8000);
        } finally {
          testBtn.disabled = false;
          testBtn.innerHTML = oldHtml;
        }
      };
    }

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

    // 保存ボタンイベント
    const saveNetworkBtn = body.querySelector('#btn-save-network');
    if (saveNetworkBtn) saveNetworkBtn.onclick = async () => {
      const mode = body.querySelector('input[name="network-mode"]:checked').value;
      const parentIp = document.getElementById('cfg-parent-ip').value.trim();
      const apiToken = document.getElementById('cfg-api-token')?.value.trim() || '';
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
      localStorage.setItem('cfg_api_token', apiToken);
      localStorage.setItem('cfg_app_zoom', defaultZoom);
      localStorage.setItem('cfg_font_style', fontStyle);
      localStorage.setItem('cfg_bed_card_size', bedCardSize);
      localStorage.setItem('cfg_theme_style', themeStyle);

      // マスタDB側にも設定値（互換性保存）を反映
      try {
        // 稼働モード・親機IPは「この端末自身」の設定のため、共有APIルーティング
        // （API.patch）を通さず常にローカルDBへ直接書き込む。
        // API.patch経由にすると子機からの保存が親機のDBの share_mode を'client'に
        // 上書きし、親機の再起動後に共有サーバー(3005)が起動しなくなる事故が起きる。
        // main.js は起動時にローカルDBの share_mode を見てサーバー起動を判定している。
        if (window.electronAPI?.dbRequest) {
          await Promise.all([
            window.electronAPI.dbRequest({ url: 'tables/system_settings/share_mode', options: { method: 'PATCH', body: JSON.stringify({ value: mode }) } }),
            window.electronAPI.dbRequest({ url: 'tables/system_settings/parent_ip', options: { method: 'PATCH', body: JSON.stringify({ value: parentIp }) } }),
          ]);
        }
        await Promise.all([
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
    }; // if (saveNetworkBtn)

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

        if (!await UI.confirmModal(confirmMsg, { title: 'データベース保存先の変更', type: 'warning', confirmLabel: '変更する' })) return;

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

    // バックアップ形式の切り替えに応じてパスワード欄の要否を調整
    const backupPasswordRow = document.getElementById('backup-password-row');
    body.querySelectorAll('input[name="backup-mode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        if (backupPasswordRow) backupPasswordRow.style.opacity = radio.value === 'redacted' && radio.checked ? '0.5' : '1';
      });
    });

    // バックアップボタン
    const backupBtn = document.getElementById('btn-backup-db');
    if (backupBtn) {
      backupBtn.onclick = async () => {
        const mode = body.querySelector('input[name="backup-mode"]:checked')?.value || 'encrypted';
        const password = document.getElementById('cfg-backup-password')?.value || '';
        if (mode === 'encrypted' && !password) {
          UI.toast('暗号化バックアップにはパスワードの入力が必要です', 'warning');
          return;
        }
        try {
          const res = await window.electronAPI.backupDatabase({ mode, password });
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
        if (!await UI.confirmModal('バックアップから復元を実行しますか？', { title: 'バックアップから復元', detail: '現在のすべてのマスターデータ、履歴、設定が消去・上書きされ、アプリが自動再起動します。', danger: true, confirmLabel: '復元を実行' })) {
          return;
        }
        const password = document.getElementById('cfg-backup-password')?.value || '';
        try {
          const res = await window.electronAPI.restoreDatabase({ password });
          if (res && res.success) {
            UI.toast('復元に成功しました。アプリケーションを再起動します...', 'success');
            setTimeout(() => {
              window.electronAPI.relaunchApp();
            }, 1500);
          } else if (res && res.passwordRequired) {
            UI.toast('このバックアップはパスワードで保護されています。パスワード欄に入力してから再度お試しください。', 'warning', 6000);
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
            <thead><tr><th>端末名</th><th>IP</th><th>ホスト名</th><th>病棟</th><th>バージョン</th><th>画面</th><th>最終応答</th><th style="width:100px;">操作</th></tr></thead>
            <tbody>
              ${devices.map(d => {
                const id = d.deviceId || d.id;
                const lastSeen = new Date(d.lastSeen || d.last_seen || 0).getTime();
                const seconds = lastSeen ? Math.max(0, Math.floor((now - lastSeen) / 1000)) : null;
                const stale = seconds !== null && seconds > 20;
                const versionMismatch = d.appVersion && AppState.appVersion && d.appVersion !== AppState.appVersion;
                const versionHtml = d.appVersion
                  ? (versionMismatch
                      ? `<span style="color:#b45309; font-weight:800;" title="親機(v${AppState.appVersion})とバージョンが異なります"><i class="fas fa-exclamation-triangle"></i> v${UI.escapeHTML(d.appVersion)}</span>`
                      : `v${UI.escapeHTML(d.appVersion)}`)
                  : '-';
                return `
                  <tr style="opacity:${stale ? '.62' : '1'};">
                    <td><strong>${d.name || id || '-'}</strong>${stale ? ' <span style="color:#dc2626; font-size:10px; font-weight:800;">応答なし</span>' : ''}<div style="font-size:10px; color:#94a3b8;"><code>${id || '-'}</code></div></td>
                    <td>${d.ip || '-'}</td>
                    <td style="font-size:11px; color:#4a5568;">${d.hostname || d.hostName || '-'}</td>
                    <td>${AppState.wards?.find(w => w.id === d.wardId)?.name || d.wardId || '-'}</td>
                    <td style="font-size:11px;">${versionHtml}</td>
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
            if (!await UI.confirmModal('この端末を接続一覧から削除しますか？', { title: '端末を接続一覧から削除', type: 'warning', confirmLabel: '削除' })) return;
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
