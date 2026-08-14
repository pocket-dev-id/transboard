/**
 * TransBoard - 設定画面: 端末表示・動作 / アクセス保護
 */

Object.assign(Settings, {

  async _renderTerminalBehaviorSettings(body) {
    const dbZoom = AppState.systemSettings?.find(s => s.id === 'default_zoom')?.value || '1.0';
    const defaultZoom = localStorage.getItem('cfg_app_zoom') || dbZoom;

    const dbFont = AppState.systemSettings?.find(s => s.id === 'font_style')?.value || 'ud';
    const fontStyle = localStorage.getItem('cfg_font_style') || dbFont;

    const dbCardSize = AppState.systemSettings?.find(s => s.id === 'bed_card_size')?.value || 'medium';
    const bedCardSize = localStorage.getItem('cfg_bed_card_size') || dbCardSize;

    const preventSleep = localStorage.getItem('cfg_prevent_sleep') === 'true';
    const alwaysOnTop = localStorage.getItem('cfg_always_on_top') === 'true';
    const isDesktop = !!window.electronAPI;
    const currentMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const terminalRole = localStorage.getItem('cfg_terminal_role') === 'exam' ? 'exam' : 'ward';

    body.innerHTML = `
      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-columns"></i> 端末画面の役割</h3>
          <span class="settings-badge settings-badge--terminal">この端末のみ</span>
        </div>
        <p class="settings-hint">
          <i class="fas fa-info-circle"></i>
          検査室端末では病棟選択・病棟ダッシュボード・病棟通知の操作を隠し、検査室画面を直接表示します。移送元の病棟名と確認状況は検査室画面に表示されます。
        </p>
        <div style="display:flex; flex-direction:column; gap:10px;">
          <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px;">
            <input type="radio" name="terminal-role" value="ward" ${terminalRole === 'ward' ? 'checked' : ''} style="margin-top:3px;">
            <span><strong>病棟端末</strong><br><span style="font-size:11px; color:#718096;">病棟を選択して、病床・通知・申し送りを操作します。</span></span>
          </label>
          <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px;">
            <input type="radio" name="terminal-role" value="exam" ${terminalRole === 'exam' ? 'checked' : ''} style="margin-top:3px;">
            <span><strong>検査室端末</strong><br><span style="font-size:11px; color:#718096;">病棟を選択せず、検査室の進捗と病棟の確認状況を参照します。</span></span>
          </label>
        </div>
      </div>
      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-desktop"></i> 画面表示</h3>
          <span class="settings-badge settings-badge--terminal">端末ごと</span>
        </div>
        <p class="settings-hint">
          <i class="fas fa-info-circle"></i>
          この端末での見え方を調整します。保存後すぐに現在の画面へ反映されます。
        </p>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px;">
          <div class="form-group">
            <label style="font-size:12.5px; font-weight:700; color:#4a5568;">表示倍率</label>
            <select id="cfg-default-zoom" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:6px; outline:none; cursor:pointer;">
              <option value="1.0" ${defaultZoom === '1.0' ? 'selected' : ''}>100%（標準）</option>
              <option value="1.2" ${defaultZoom === '1.2' ? 'selected' : ''}>120%（中）</option>
              <option value="1.5" ${defaultZoom === '1.5' ? 'selected' : ''}>150%（大）</option>
              <option value="2.0" ${defaultZoom === '2.0' ? 'selected' : ''}>200%（極大）</option>
            </select>
          </div>
          <div class="form-group">
            <label style="font-size:12.5px; font-weight:700; color:#4a5568;">フォント</label>
            <select id="cfg-font-style" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:6px; outline:none; cursor:pointer;">
              <option value="ud" ${fontStyle === 'ud' ? 'selected' : ''}>UDゴシック（推奨）</option>
              <option value="standard" ${fontStyle === 'standard' ? 'selected' : ''}>システム標準</option>
              <option value="bold" ${fontStyle === 'bold' ? 'selected' : ''}>高コントラスト太字</option>
            </select>
          </div>
          <div class="form-group">
            <label style="font-size:12.5px; font-weight:700; color:#4a5568;">病床カードサイズ</label>
            <select id="cfg-bed-card-size" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:6px; outline:none; cursor:pointer;">
              <option value="large" ${bedCardSize === 'large' ? 'selected' : ''}>大きめ</option>
              <option value="medium" ${bedCardSize === 'medium' ? 'selected' : ''}>標準</option>
              <option value="small" ${bedCardSize === 'small' ? 'selected' : ''}>小さめ</option>
            </select>
          </div>
        </div>
        <div style="margin-top:12px;">
          <button class="btn btn-primary btn-sm" id="btn-save-terminal-behavior"><i class="fas fa-save"></i> 表示設定を保存</button>
        </div>
      </div>

      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-bolt"></i> 端末動作</h3>
          <span class="settings-badge settings-badge--terminal">端末ごと</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:12px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600; color:#2d3748;">
            <input type="checkbox" id="chk-prevent-sleep" ${preventSleep ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
            この端末でスリープを抑止する
          </label>
          <label style="display:${isDesktop ? 'flex' : 'none'}; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600; color:#2d3748;">
            <input type="checkbox" id="chk-always-on-top" ${alwaysOnTop ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
            この画面を常に最前面に表示する
          </label>
          ${isDesktop ? `
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600; color:#2d3748;">
              <input type="checkbox" id="chk-startup" style="width:16px; height:16px; cursor:pointer;">
              Windows にログイン時、TransBoard を自動的に起動する
            </label>
            <span id="startup-status-label" style="font-size:12px; color:#718096;"></span>
          </div>
          ` : ''}
        </div>
        <p class="settings-hint" style="margin-top:10px;">
          <i class="fas fa-info-circle"></i>
          端末動作の切り替えはこの端末だけに保存されます。稼働モード: ${currentMode === 'parent' ? '親機' : '子機'}
        </p>
      </div>
    `;

    const applyVisuals = () => {
      if (typeof App !== 'undefined' && App.applySystemVisualSettings) {
        App.applySystemVisualSettings();
      }
    };
    const readVisualValues = () => ({
      defaultZoomVal: body.querySelector('#cfg-default-zoom')?.value || '1.0',
      fontStyleVal: body.querySelector('#cfg-font-style')?.value || 'ud',
      bedCardSizeVal: body.querySelector('#cfg-bed-card-size')?.value || 'medium',
      terminalRoleVal: body.querySelector('input[name="terminal-role"]:checked')?.value || 'ward',
    });
    const saveLocalVisualValues = () => {
      const values = readVisualValues();
      localStorage.setItem('cfg_app_zoom', values.defaultZoomVal);
      localStorage.setItem('cfg_font_style', values.fontStyleVal);
      localStorage.setItem('cfg_bed_card_size', values.bedCardSizeVal);
      return values;
    };

    body.querySelectorAll('#cfg-default-zoom, #cfg-font-style, #cfg-bed-card-size').forEach(select => {
      select.addEventListener('change', () => {
        saveLocalVisualValues();
        applyVisuals();
      });
    });

    const saveBtn = body.querySelector('#btn-save-terminal-behavior');
    if (saveBtn) saveBtn.onclick = async () => {
      const { defaultZoomVal, fontStyleVal, bedCardSizeVal, terminalRoleVal } = saveLocalVisualValues();

      try {
        const isChildMode = currentMode === 'client' || currentMode === 'child';
        // 端末固有設定は子機から親機DBへ書き込まない。親機自身で設定した値だけを
        // 新規端末向けのデフォルトとして共有し、子機はlocalStorageを優先する。
        let failed = false;
        if (!isChildMode) {
          const results = await Promise.allSettled([
            API.patch('system_settings', 'default_zoom', { value: defaultZoomVal }),
            API.patch('system_settings', 'font_style', { value: fontStyleVal }),
            API.patch('system_settings', 'bed_card_size', { value: bedCardSizeVal }),
          ]);
          failed = results.some(result => result.status === 'rejected');
        }
        if (!failed) {
          this._writeLocalSetting('default_zoom', defaultZoomVal);
          this._writeLocalSetting('font_style', fontStyleVal);
          this._writeLocalSetting('bed_card_size', bedCardSizeVal);
          if (typeof App !== 'undefined' && App.setTerminalRole) {
            await App.setTerminalRole(terminalRoleVal);
          }
        }
        applyVisuals();
        UI.toast(failed ? 'この端末の表示は保存しました。共通デフォルトは親機へ反映できませんでした。' : '端末表示を保存しました', failed ? 'warning' : 'success');
      } catch (err) {
        console.error(err);
        applyVisuals();
        UI.toast('端末表示の保存に失敗しました: ' + err.message, 'danger');
      }
    };

    const preventSleepChk = body.querySelector('#chk-prevent-sleep');
    if (preventSleepChk) {
      preventSleepChk.onchange = () => {
        localStorage.setItem('cfg_prevent_sleep', preventSleepChk.checked ? 'true' : 'false');
        applyVisuals();
        UI.toast(preventSleepChk.checked ? 'スリープ抑止を有効にしました' : 'スリープ抑止を無効にしました', 'success');
      };
    }

    const alwaysOnTopChk = body.querySelector('#chk-always-on-top');
    if (alwaysOnTopChk) {
      alwaysOnTopChk.onchange = async () => {
        localStorage.setItem('cfg_always_on_top', alwaysOnTopChk.checked ? 'true' : 'false');
        if (window.electronAPI?.setAlwaysOnTop) {
          await window.electronAPI.setAlwaysOnTop(alwaysOnTopChk.checked);
        }
        UI.toast(alwaysOnTopChk.checked ? '常に最前面を有効にしました' : '常に最前面を無効にしました', 'success');
      };
    }

    const startupChk = body.querySelector('#chk-startup');
    const startupLabel = body.querySelector('#startup-status-label');
    if (startupChk && window.electronAPI?.getStartupSetting) {
      try {
        const info = await window.electronAPI.getStartupSetting();
        startupChk.checked = !!info.openAtLogin;
        if (startupLabel) startupLabel.textContent = info.openAtLogin ? '有効' : '無効';
      } catch (err) {
        console.warn('Failed to load startup setting', err);
        if (startupLabel) startupLabel.textContent = '取得失敗';
      }
      startupChk.onchange = async () => {
        try {
          const info = await window.electronAPI.setStartupSetting({ openAtLogin: startupChk.checked });
          startupChk.checked = !!info.openAtLogin;
          if (startupLabel) startupLabel.textContent = info.openAtLogin ? '有効' : '無効';
          UI.toast(info.openAtLogin ? 'Windows起動時の自動起動を有効にしました' : 'Windows起動時の自動起動を無効にしました', 'success');
        } catch (err) {
          console.error(err);
          startupChk.checked = !startupChk.checked;
          if (startupLabel) startupLabel.textContent = '設定失敗';
          UI.toast('自動起動設定の変更に失敗しました: ' + err.message, 'danger');
        }
      };
    }
  },

  async _renderAccessProtectionSettings(body) {
    const currentMode = localStorage.getItem('cfg_share_mode') || 'parent';
    const isClientMode = currentMode === 'client' || currentMode === 'child';
    const passcodeSetting = AppState.systemSettings?.find(s => s.id === 'admin_passcode') || { value: '0000' };
    const hasPasscode = !!passcodeSetting.value;

    body.innerHTML = `
      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-lock"></i> 設定画面保護</h3>
          <span class="settings-badge settings-badge--shared">親機・子機共通</span>
        </div>
        ${isClientMode ? `
        <div style="margin-bottom:12px; padding:10px 12px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:6px; color:#1e40af; font-size:12px; line-height:1.5;">
          <i class="fas fa-info-circle"></i>
          パスコードは親機・子機で共通です。子機では解除のみ可能で、変更は親機の設定画面から行います。
        </div>
        ` : `
        <p class="settings-hint">
          <i class="fas fa-info-circle"></i>
          親機で保存したパスコードが、親機と子機の設定画面保護に使われます。
        </p>
        `}
        <div class="form-row">
          <label style="font-size:12.5px; font-weight:700; color:#4a5568;">管理者パスコード（6文字以上）</label>
          <input type="password" id="cfg-admin-passcode" ${isClientMode ? 'disabled' : ''} placeholder="${isClientMode ? '親機で変更してください' : (hasPasscode ? '変更する場合のみ入力' : '6文字以上で入力')}" style="width:100%; max-width:260px; padding:6px 8px; border:1px solid #cbd5e0; border-radius:6px; font-size:13px; font-weight:700; ${isClientMode ? 'background:#f8fafc; color:#64748b;' : ''}">
          <small style="font-size:11px; color:#718096;">
            6文字以上で、連番・同一数字のみ・推測されやすい値は避けてください。保存時はハッシュ化されます。
          </small>
        </div>
        <div style="margin-top:12px;">
          <button class="btn btn-primary btn-sm" id="btn-save-admin-passcode" ${isClientMode ? 'disabled' : ''}><i class="fas fa-save"></i> パスコードを保存</button>
        </div>
      </div>
    `;

    const saveBtn = body.querySelector('#btn-save-admin-passcode');
    if (!saveBtn || isClientMode) return;

    saveBtn.onclick = async () => {
      const raw = (body.querySelector('#cfg-admin-passcode')?.value || '').trim();
      if (!raw) {
        UI.toast('変更するパスコードを入力してください', 'warning');
        return;
      }
      if (typeof PasscodeHash !== 'undefined' && PasscodeHash.isWeakRaw(raw)) {
        UI.toast('パスコードは6文字以上で、連番・同一数字のみ・推測されやすい値は避けてください', 'warning');
        return;
      }

      try {
        const result = await API.setAdminPasscode(raw);
        if (!result?.success) throw new Error(result?.message || 'パスコードを保存できませんでした');
        window.maintenanceToken = result.maintenanceToken || null;
        const obj = AppState.systemSettings?.find(s => s.id === 'admin_passcode');
        if (obj) obj.value = '********';
        else AppState.systemSettings.push({ id: 'admin_passcode', value: '********' });
        body.querySelector('#cfg-admin-passcode').value = '';
        UI.toast('管理者パスコードを保存しました', 'success');
      } catch (err) {
        console.error(err);
        UI.toast('パスコードの保存に失敗しました: ' + err.message, 'danger');
      }
    };
  },
});
