/**
 * TransBoard - 設定画面: 共有・ネットワーク設定
 */

Object.assign(Settings, {

  // ──────────────────────────────────
  //  共有・ネットワーク設定管理
  // ──────────────────────────────────
  async _renderNetworkSettings(body) {
    // DBファイル暗号化の可用性を確認（セキュリティ B-3）
    const encStatus = window.electronAPI && window.electronAPI.getEncryptionStatus
      ? await window.electronAPI.getEncryptionStatus().catch(() => null)
      : null;

    const currentMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const currentParentIp = localStorage.getItem('cfg_parent_ip') || '';
    const currentApiToken = await API.getTerminalApiToken();
    const isStandaloneMode = currentMode === 'parent' && localStorage.getItem('cfg_standalone_mode') === 'true';

    // WebRTC音声通話の有効設定を取得
    const webrtcSetting = AppState.systemSettings?.find(s => s.id === 'enable_webrtc_call') || { value: 'true' };
    const isWebRtcEnabled = webrtcSetting.value !== 'false';

    // 患者ICカード紐づけ機能の有効設定を取得
    const icSetting = AppState.systemSettings?.find(s => s.id === 'enable_patient_ic_association') || { value: 'false' };
    const isIcEnabled = icSetting.value === 'true';

    // 読み取り方式（ICカード/バーコード）・出棟登録時の患者ID自動セット設定を取得
    const scanModeSetting = AppState.systemSettings?.find(s => s.id === 'patient_id_scan_mode') || { value: 'ic_card' };
    const isBarcodeMode = scanModeSetting.value === 'barcode';
    const autoSetPatientIdSetting = AppState.systemSettings?.find(s => s.id === 'enable_auto_set_patient_id') || { value: 'false' };
    const isAutoSetPatientIdEnabled = autoSetPatientIdSetting.value === 'true';
    const autoSetPatientIdDefaultSetting = AppState.systemSettings?.find(s => s.id === 'auto_set_patient_id_default_checked') || { value: 'false' };
    const isAutoSetPatientIdDefaultChecked = autoSetPatientIdDefaultSetting.value === 'true';

    // ローカルIPアドレス一覧を取得する（親機の場合の親切設計）
    let ipListHtml = '<li>IPアドレスの取得中...</li>';
    if (window.electronAPI && window.electronAPI.getLocalIPs) {
      try {
        const ips = await window.electronAPI.getLocalIPs();
        if (ips && ips.length > 0) {
          ipListHtml = ips.map(ip => `
            <li>
              <strong>${UI.escapeHTML(ip.name)}:</strong>
              <code style="background:#edf2f7; padding:2px 6px; border-radius:4px; font-weight:800; font-family:monospace; font-size:12px;">${UI.escapeHTML(ip.address)}</code>
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
              <span class="settings-badge settings-badge--terminal">個別設定（PCごと）</span>
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
              <span class="settings-badge settings-badge--child">子機専用設定</span>
            </h4>
            <div class="form-row" style="margin-bottom:12px;">
              <label>親機PCのIPアドレス / ホスト名</label>
              <input type="text" id="cfg-parent-ip" placeholder="例: 192.168.1.15" style="width:100%; max-width:300px; padding:8px; border:1px solid #cbd5e0; border-radius:6px;" value="${UI.escapeHTML(currentParentIp)}">
            </div>
            <div class="form-row" style="margin-bottom:12px;">
              <label>APIトークン <span style="color:#dc2626">*</span></label>
              <input type="password" id="cfg-api-token" autocomplete="off" placeholder="親機の「共有・ネットワーク設定」画面に表示されている値を入力" style="width:100%; max-width:420px; padding:8px; border:1px solid #cbd5e0; border-radius:6px; font-family:monospace; font-size:12px;" value="${UI.escapeHTML(currentApiToken)}">
              <p style="font-size:11px; color:#718096; margin:4px 0 0 0;">患者情報を含むデータの取得にはこのトークンが必須です。親機の管理者に確認してください。</p>
            </div>
            <div style="display:flex; gap:8px;">
              <button class="btn btn-outline btn-sm" id="btn-test-connection">
                <i class="fas fa-link"></i> 接続テストを実行
              </button>
              <button class="btn btn-outline btn-sm" id="btn-open-debug-log" title="診断ログをメモ帳で開く">
                <i class="fas fa-file-alt"></i> ログを開く
              </button>
            </div>
          </div>

          <!-- 親機用：ローカルIP表示 -->
          <div id="parent-config-section" style="border-top:1px solid #e2e8f0; padding-top:16px; display:${currentMode === 'parent' ? 'block' : 'none'};">
            <!-- 単独運用モードのトグル -->
            <div class="info-box" style="margin-bottom:16px;">
              <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px;">
                <input type="checkbox" id="chk-standalone-mode" ${isStandaloneMode ? 'checked' : ''} style="margin-top:3px;">
                <div>
                  <strong><i class="fas fa-desktop"></i> 単独運用モード（この1台だけで運用）</strong>
                  <div class="info-box-sub">子機を使わず、この親機1台で全工程を完結させる運用です。接続端末の表示・病棟間通話・検査室画面など、複数台前提の機能を隠してシンプルにします。あとから子機を追加する場合はOFFにしてください。</div>
                </div>
              </label>
            </div>

            <!-- 子機オンボーディング情報（単独運用モードでは非表示） -->
            <div id="parent-share-onboarding" style="display:${isStandaloneMode ? 'none' : 'block'};">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
                <i class="fas fa-info-circle"></i> 子機から接続するための情報
                <span class="settings-badge settings-badge--parent">親機専用情報</span>
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
                  <input type="text" id="cfg-api-token-display" readonly style="flex:1; max-width:420px; padding:8px; border:1px solid #fca5a5; border-radius:6px; font-family:monospace; font-size:12px; background:#fef2f2;" value="${UI.escapeHTML(AppState.systemSettings?.find(s => s.id === 'api_token')?.value || '(初回起動時に自動生成されます)')}">
                  <button class="btn btn-outline btn-sm" id="btn-copy-api-token" title="コピー"><i class="fas fa-copy"></i></button>
                  <button class="btn btn-outline btn-sm" id="btn-regen-api-token" title="再生成（全子機で再設定が必要になります）"><i class="fas fa-sync-alt"></i></button>
                </div>
                <p style="font-size:11px; color:#991b1b; margin:6px 0 0 0;">このトークンを各子機PCの「共有・ネットワーク設定」画面に入力してください。再生成すると、全ての子機で入力し直しが必要になります。</p>
              </div>
            </div>
          </div>

          <!-- WebRTC通話機能の有効/無効設定 -->
          <div id="shared-communication-section" style="border-top:1px solid #e2e8f0; padding-top:16px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-phone-alt"></i> 音声通話・ビデオ通話機能の設定
              <span class="settings-badge settings-badge--shared">全体同期・共通設定</span>
            </h4>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600; color:#2d3748;">
              <input type="checkbox" id="cfg-enable-webrtc-call" ${isWebRtcEnabled ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
              音声通話・ビデオ通話機能を使用する
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

          <!-- 患者ICカード/バーコード紐づけ機能の有効/無効設定 -->
          <div style="border-top:1px solid #e2e8f0; padding-top:16px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-id-card"></i> 患者IC/バーコード登録機能（オプション）
              <span class="settings-badge settings-badge--shared">全体同期・共通設定</span>
            </h4>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600; color:#2d3748;">
              <input type="checkbox" id="cfg-enable-patient-ic" ${isIcEnabled ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
              患者IC/バーコード登録機能を使用する（出棟時・移動中の紐づけ、帰棟・キャンセル時の自動解除）
            </label>
            <div style="font-size:11px; color:#718096; margin-top:4px; padding-left:24px;">
              チェックを入れると、病床詳細モーダルで移送を開始する際や移動中の患者に対してICカード/バーコード（スキャナーによる文字入力）を登録できるようになります。帰棟完了時やキャンセル時には自動的に紐づけが削除されます。
            </div>

            <div id="ic-scan-mode-section" style="margin-top:12px; padding-left:24px; ${isIcEnabled ? '' : 'display:none;'}">
              <div style="font-size:12px; font-weight:700; color:#2d3748; margin-bottom:6px;">読み取り方式</div>
              <div style="display:flex; gap:16px; flex-wrap:wrap;">
                <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;">
                  <input type="radio" name="patient-id-scan-mode" value="ic_card" ${isBarcodeMode ? '' : 'checked'}>
                  ICカード（NFCカードリーダーを常時監視）
                </label>
                <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;">
                  <input type="radio" name="patient-id-scan-mode" value="barcode" ${isBarcodeMode ? 'checked' : ''}>
                  バーコード（キーボード入力型スキャナー・カード監視は行いません）
                </label>
              </div>
              <div style="font-size:11px; color:#718096; margin-top:4px;">
                バーコードを選択すると、NFCカードリーダーの常時監視プロセスを起動しません。バーコードスキャナー（USBキーボード入力型）で読み取った値を各スキャン欄に入力しEnterで確定してください。
              </div>

              <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; font-weight:600; color:#2d3748; margin-top:12px;">
                <input type="checkbox" id="cfg-auto-set-patient-id" ${isAutoSetPatientIdEnabled ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
                出棟登録時、患者IDを検査室照合に使う機能を使用する
              </label>
              <div style="font-size:11px; color:#718096; margin-top:4px; padding-left:24px;">
                有効にすると、移送開始フォームに「患者IDをセット」チェックボックスが表示されます。チェックした状態で出棟登録すると、この病床に既に設定されている患者ID（新たな読み取りは不要）が検査室での照合に使われます。検査室では、患者IDが埋め込まれたバーコード（診察券・リストバンド等）をスキャンすることで該当患者を自動判定できます。
              </div>

              <div id="auto-set-patient-id-default-section" style="margin-top:10px; padding-left:24px; ${isAutoSetPatientIdEnabled ? '' : 'display:none;'}">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; font-weight:600; color:#2d3748;">
                  <input type="checkbox" id="cfg-auto-set-patient-id-default" ${isAutoSetPatientIdDefaultChecked ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
                  「患者IDをセット」を既定でチェック済みにする
                </label>
                <div style="font-size:11px; color:#718096; margin-top:4px; padding-left:24px;">
                  有効にすると、移送開始フォームを開いた時点で「患者IDをセット」チェックボックスが最初からチェックされた状態になります（都度チェックする手間を省けます）。
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    `;

    const icScanModeSection = body.querySelector('#ic-scan-mode-section');
    body.querySelector('#cfg-enable-patient-ic')?.addEventListener('change', (e) => {
      if (icScanModeSection) icScanModeSection.style.display = e.target.checked ? 'block' : 'none';
    });

    const autoSetPatientIdDefaultSection = body.querySelector('#auto-set-patient-id-default-section');
    body.querySelector('#cfg-auto-set-patient-id')?.addEventListener('change', (e) => {
      if (autoSetPatientIdDefaultSection) autoSetPatientIdDefaultSection.style.display = e.target.checked ? 'block' : 'none';
    });

    if (currentMode === 'parent' && !isStandaloneMode) this._renderDeviceList(body);

    // 役割ラジオの変更イベント
    body.querySelectorAll('input[name="network-mode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const isClient = e.target.value === 'client';
        document.getElementById('client-config-section').style.display = isClient ? 'block' : 'none';
        document.getElementById('parent-config-section').style.display = isClient ? 'none' : 'block';
      });
    });

    // 単独運用モードのトグル
    const standaloneChk = document.getElementById('chk-standalone-mode');
    if (standaloneChk) {
      standaloneChk.onchange = () => {
        const on = standaloneChk.checked;
        localStorage.setItem('cfg_standalone_mode', on ? 'true' : 'false');
        // 子機オンボーディング情報の表示切替
        const onboarding = document.getElementById('parent-share-onboarding');
        if (onboarding) onboarding.style.display = on ? 'none' : 'block';
        // 接続端末チップ・検査室タブ・通話ボタンの表示、ポーリングの開始/停止を即時反映
        App._applyStandaloneMode();
        App._startDevicePresenceMonitor();
        if (on) {
          if (this._deviceListTimer) { clearInterval(this._deviceListTimer); this._deviceListTimer = null; }
          document.getElementById('connected-devices-panel')?.remove();
        } else {
          this._renderDeviceList(body);
        }
        UI.toast(on ? '単独運用モードをONにしました' : '単独運用モードをOFFにしました', 'info');
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

        const url = `http://${parentIp}:3005/api/tables/wards`;
        const token = document.getElementById('cfg-api-token')?.value.trim() || '';
        const appVer = await window.electronAPI?.getAppVersion?.().catch(() => '?') ?? '?';
        const logLines = [
          `[設定画面接続テスト] appVersion=${appVer} url=${url}`,
          `  navigator.onLine=${navigator.onLine}`,
        ];
        try {
          // テストフェッチ（親機側のwardsマスタを取得してみる）
          const res = await parentFetch(url, {
            headers: token ? { 'X-API-Token': token } : {},
            purpose: 'connection-test',
          }, 4000);

          if (res.ok) {
            const data = await res.json();
            logLines.push(`  結果: 疎通成功 status=${res.status} wards=${data.data?.length ?? '?'}件`);

            // 第2段階: APIトークン検証。wardsはトークン不要のため疎通確認にしかならず、
            // 患者データ（beds等）はトークン必須。ここで検証しないと
            // 「テストは成功するのに実際の同期は401で全滅」という状態を見逃す
            if (token) {
              try {
                const res2 = await parentFetch(`http://${parentIp}:3005/api/tables/beds`, {
                  headers: { 'X-API-Token': token },
                  purpose: 'connection-test',
                }, 4000);
                if (res2.ok) {
                  logLines.push(`  トークン検証: 成功 status=${res2.status}`);
                  UI.toast(`✅ 接続に成功しました！ 病棟 ${data.data?.length || 0}件・APIトークン認証もOK。`, 'success');
                } else if (res2.status === 401) {
                  logLines.push(`  トークン検証: 失敗 status=401（トークン不一致）`);
                  UI.toast(`⚠ ネットワークは正常ですが、APIトークンが親機と一致しません。親機の「共有・ネットワーク設定」画面のトークンをコピーし直してください。`, 'warning', 10000);
                } else {
                  logLines.push(`  トークン検証: HTTPエラー status=${res2.status}`);
                  UI.toast(`❌ トークン検証でHTTPエラー ${res2.status}`, 'danger');
                }
              } catch (e2) {
                logLines.push(`  トークン検証: 例外 name=${e2.name} message=${e2.message}`);
                UI.toast(`❌ トークン検証中にエラー（${e2.message || e2.name}）`, 'danger');
              }
            } else {
              logLines.push('  トークン検証: スキップ（未入力）');
              UI.toast(`⚠ 疎通は成功（病棟 ${data.data?.length || 0}件）。ただしAPIトークンが未入力のため、患者データの取得はできません。`, 'warning', 10000);
            }
          } else {
            logLines.push(`  結果: HTTPエラー status=${res.status}`);
            UI.toast(`❌ 接続失敗: HTTPエラー ${res.status}`, 'danger');
          }
        } catch (e) {
          const reason = e.name === 'AbortError'
            ? 'タイムアウトしました（4秒応答なし）'
            : `${e.name || 'Error'}: ${e.message || '原因不明'}`;
          logLines.push(`  結果: 例外 name=${e.name} message=${e.message} stack=${(e.stack || '').split('\n').slice(0, 3).join(' / ')}`);
          UI.toast(`❌ 接続できませんでした（${reason}）。IPアドレスが正しいか、親機が起動しているか、またはネットワーク設定（ファイアウォール）を確認してください。`, 'danger', 8000);
        } finally {
          window.electronAPI?.appendDebugLog?.(logLines.join('\n')).catch(() => {});
          testBtn.disabled = false;
          testBtn.innerHTML = oldHtml;
        }
      };
    }

    const openLogBtn = document.getElementById('btn-open-debug-log');
    if (openLogBtn) {
      openLogBtn.onclick = () => {
        window.electronAPI?.openDebugLog?.().catch(() => {
          UI.toast('ログファイルを開けませんでした', 'danger');
        });
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
      const parentIp = body.querySelector('#cfg-parent-ip')?.value.trim() || '';
      const apiToken = body.querySelector('#cfg-api-token')?.value.trim() || '';
      const enableWebRtcCall = body.querySelector('#cfg-enable-webrtc-call')?.checked ? 'true' : 'false';
      const enablePatientIc = body.querySelector('#cfg-enable-patient-ic')?.checked ? 'true' : 'false';
      const patientIdScanMode = body.querySelector('input[name="patient-id-scan-mode"]:checked')?.value === 'barcode' ? 'barcode' : 'ic_card';
      const enableAutoSetPatientId = body.querySelector('#cfg-auto-set-patient-id')?.checked ? 'true' : 'false';
      const autoSetPatientIdDefaultChecked = body.querySelector('#cfg-auto-set-patient-id-default')?.checked ? 'true' : 'false';
      const isClientSave = mode === 'client' || mode === 'child';

      if (mode === 'client' && !parentIp) {
        UI.toast('接続先の親機IPアドレスを入力してください', 'warning');
        return;
      }

      const tokenSave = await API.setTerminalApiToken(apiToken);
      if (!tokenSave?.success) {
        UI.toast(tokenSave?.message || 'APIトークンを安全に保存できませんでした', 'danger');
        return;
      }

      // localStorageへ保存（起動時の同期ロード用）
      localStorage.setItem('cfg_share_mode', mode);
      localStorage.setItem('cfg_parent_ip', parentIp);

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
        const sharedUpdates = [
          API.patch('system_settings', 'enable_webrtc_call', { value: enableWebRtcCall }),
          API.patch('system_settings', 'enable_patient_ic_association', { value: enablePatientIc }),
          API.patch('system_settings', 'patient_id_scan_mode', { value: patientIdScanMode }),
          API.patch('system_settings', 'enable_auto_set_patient_id', { value: enableAutoSetPatientId }),
          API.patch('system_settings', 'auto_set_patient_id_default_checked', { value: autoSetPatientIdDefaultChecked }),
        ];
        const sharedResults = isClientSave
          ? await Promise.allSettled(sharedUpdates)
          : await Promise.all(sharedUpdates).then(() => []);
        const sharedFailed = sharedResults.some(result => result.status === 'rejected');

        // AppStateのシステム設定も更新
        if (!sharedFailed) {
          this._writeLocalSetting('enable_webrtc_call', enableWebRtcCall);
          this._writeLocalSetting('enable_patient_ic_association', enablePatientIc);
          this._writeLocalSetting('patient_id_scan_mode', patientIdScanMode);
          this._writeLocalSetting('enable_auto_set_patient_id', enableAutoSetPatientId);
          this._writeLocalSetting('auto_set_patient_id_default_checked', autoSetPatientIdDefaultChecked);
        }

        // 子機へ切り替えた場合は、その場で共有サーバー(3005)と取り込み監視を止める。
        // 再起動の確認は下で出すが拒否できるため、これが無いと3005で配信を続けたまま
        // 子機として振る舞う（＝LAN上に2台目の親機がいる）状態が残ってしまう。
        if (isClientSave) {
          try { await window.electronAPI?.stopParentServer?.(); } catch (e) {
            console.warn('[Network] 共有サーバーの停止に失敗:', e);
          }
        }

        if (isClientSave && sharedFailed) {
          UI.toast('この端末の接続設定は保存しました。共有設定は接続または権限の問題で反映できませんでした。', 'warning', 8000);
        } else {
          UI.toast('共有・ネットワーク設定を保存しました。稼働モードや接続先は再起動後に確実に反映されます。', 'success');
        }

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

  },

  _renderDeviceList(body) {
    const host = body.querySelector('#parent-config-section');
    if (!host) return;
    document.getElementById('connected-devices-panel')?.remove();

    host.insertAdjacentHTML('beforeend', `
      <div id="connected-devices-panel" style="margin-top:14px; padding-top:14px; border-top:1px dashed #cbd5e0;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
          <h4 style="margin:0; font-size:13px; color:#2d3748; display:flex; align-items:center; gap:8px;"><i class="fas fa-laptop-medical"></i> 接続機器一覧</h4>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:11px; color:#718096;">5秒ごとに自動更新</span>
            <button class="btn btn-outline btn-sm" id="btn-refresh-devices" title="接続機器一覧を再読み込み" aria-label="接続機器一覧を再読み込み" style="width:30px; height:28px; padding:0; justify-content:center;">
              <i class="fas fa-sync-alt"></i>
            </button>
          </div>
        </div>
        <div id="connected-devices-body" style="font-size:12px; color:#4a5568;">読み込み中...</div>
      </div>
    `);

    let renderRowsInFlight = false;
    const renderRows = async () => {
      if (renderRowsInFlight) return;
      renderRowsInFlight = true;
      const area = document.getElementById('connected-devices-body');
      if (!area) {
        renderRowsInFlight = false;
        return;
      }
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
                const esc = value => UI.escapeHTML(String(value ?? ''));
                const rawId = d.deviceId || d.id ? String(d.deviceId || d.id) : '';
                const id = esc(rawId);
                const seconds = DevicePresence.secondsSince(d, now);
                const stale = seconds !== null && seconds > 20;
                const appVersion = d.appVersion ? String(d.appVersion) : '';
                const parentVersion = AppState.appVersion ? String(AppState.appVersion) : '';
                const versionMismatch = appVersion && parentVersion && appVersion !== parentVersion;
                const versionHtml = appVersion
                  ? (versionMismatch
                      ? `<span style="color:#b45309; font-weight:800;" title="親機(v${esc(parentVersion)})とバージョンが異なります"><i class="fas fa-exclamation-triangle"></i> v${esc(appVersion)}</span>`
                      : `v${esc(appVersion)}`)
                  : '-';
                const wardName = AppState.wards?.find(w => String(w.id) === String(d.wardId))?.name;
                const displayName = esc(d.name || rawId || '-');
                const displayIp = esc(d.ip || '-');
                const displayHostname = esc(d.hostname || d.hostName || '-');
                const displayWard = esc(wardName || d.wardId || '-');
                const displayPage = esc(d.page || '-');
                return `
                  <tr style="opacity:${stale ? '.62' : '1'};">
                    <td><strong>${displayName}</strong>${stale ? ' <span style="color:#dc2626; font-size:10px; font-weight:800;">応答なし</span>' : ''}<div style="font-size:10px; color:#94a3b8;"><code>${id || '-'}</code></div></td>
                    <td>${displayIp}</td>
                    <td style="font-size:11px; color:#4a5568;">${displayHostname}</td>
                    <td>${displayWard}</td>
                    <td style="font-size:11px;">${versionHtml}</td>
                    <td>${displayPage}</td>
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
            const result = await API.disconnectDevice(btn.dataset.id);
            if (result?.success === false) {
              UI.toast(result.message || '接続機器を削除できませんでした', 'danger');
            } else {
              UI.toast('接続機器を一覧から削除しました', 'success');
            }
            renderRows();
          };
        });
      } catch (e) {
        console.error(e);
        area.innerHTML = '<div style="padding:10px; background:#fff5f5; border:1px solid #fed7d7; border-radius:6px; color:#c53030;">接続機器一覧を取得できませんでした。</div>';
      } finally {
        renderRowsInFlight = false;
      }
    };

    const refreshBtn = document.getElementById('btn-refresh-devices');
    if (refreshBtn) refreshBtn.onclick = async () => {
      const icon = refreshBtn.querySelector('i');
      refreshBtn.disabled = true;
      if (icon) icon.classList.add('fa-spin');
      await renderRows();
      if (icon) icon.classList.remove('fa-spin');
      refreshBtn.disabled = false;
    };
    if (this._deviceListTimer) clearInterval(this._deviceListTimer);
    renderRows();
    this._deviceListTimer = setInterval(renderRows, 5000);
  },

});
