/**
 * TransBoard - 設定画面: システム保守
 * バックアップ/復元・DB保存先・履歴自動削除・アプリ更新配信・DB概況・診断情報エクスポートをまとめる。
 * （旧: js/settings/network.js に混在していた保守系機能をここへ集約）
 */

Object.assign(Settings, {

  _formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  },

  async _renderMaintenanceSettings(body) {
    const currentMode = localStorage.getItem('cfg_share_mode') || 'parent';

    const storageInfo = window.electronAPI && window.electronAPI.getDatabaseStorageInfo
      ? await window.electronAPI.getDatabaseStorageInfo()
      : null;
    const dbInfo = window.electronAPI && window.electronAPI.getDbInfo
      ? await window.electronAPI.getDbInfo().catch(() => null)
      : null;

    const eventRetentionSetting = AppState.systemSettings?.find(s => s.id === 'event_retention_days') || { value: '0' };
    const eventRetentionDays = eventRetentionSetting.value;

    const lastBackupAt = dbInfo?.lastBackupAt || null;
    const lastBackupDaysAgo = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86400000) : null;

    body.innerHTML = `
      <!-- このアプリについて / DB概況 -->
      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-info-circle"></i> このアプリについて</h3>
        </div>
        <div class="maint-info-grid">
          <div class="maint-info-item"><span class="maint-info-label">バージョン</span><span class="maint-info-value">v${AppState.appVersion || '-'}</span></div>
          <div class="maint-info-item"><span class="maint-info-label">稼働モード</span><span class="maint-info-value">${currentMode === 'parent' ? '親機' : '子機'}</span></div>
          ${dbInfo ? `
          <div class="maint-info-item"><span class="maint-info-label">DBファイルサイズ</span><span class="maint-info-value">${this._formatBytes(dbInfo.fileSizeBytes)}</span></div>
          <div class="maint-info-item"><span class="maint-info-label">移送履歴件数</span><span class="maint-info-value">${dbInfo.counts.transfer_events}件</span></div>
          <div class="maint-info-item maint-info-item--wide"><span class="maint-info-label">DBファイルの場所</span><span class="maint-info-value maint-info-value--mono">${UI.escapeHTML(dbInfo.dbPath)}</span></div>
          ` : ''}
          <div class="maint-info-item">
            <span class="maint-info-label">最終バックアップ</span>
            <span class="maint-info-value ${lastBackupDaysAgo === null || lastBackupDaysAgo > 30 ? 'maint-info-value--warn' : ''}">
              ${lastBackupAt ? `${UI.formatDateTime(lastBackupAt)}（${lastBackupDaysAgo}日前）` : '未実施'}
            </span>
          </div>
        </div>
        <div style="margin-top:12px;">
          <button class="btn btn-outline btn-sm" id="btn-export-diagnostics"><i class="fas fa-file-medical-alt"></i> 診断情報をエクスポート</button>
          <span style="font-size:11px; color:var(--clr-text-muted); margin-left:8px;">患者情報・パスワード等は含まれません。サポート問い合わせ時に添付してください。</span>
        </div>
      </div>

      <!-- アプリの更新 -->
      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-arrow-circle-up"></i> アプリの更新</h3>
          <span class="settings-badge settings-badge--terminal">個別設定（PCごと）</span>
        </div>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600; color:var(--clr-text);">
          <input type="checkbox" id="cfg-auto-update-check" ${localStorage.getItem('cfg_auto_update_check') !== 'false' ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
          起動時と24時間ごとに更新を自動チェックする <span style="font-weight:400; color:var(--clr-text-muted); font-size:11px;">（切り替えると即時保存されます）</span>
        </label>
        <div style="font-size:11px; color:var(--clr-text-muted); margin-top:4px; padding-left:24px;">
          ${currentMode === 'parent' ? '親機は自身の配信フォルダ（下記で取り込んだ更新）をチェックします。' : '子機は親機の配信フォルダをチェックします。更新は通知のみで、インストールは常に手動で開始します。'}
        </div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
          <button class="btn btn-outline btn-sm" id="btn-check-update-now"><i class="fas fa-sync-alt"></i> 今すぐ更新を確認</button>
          <span id="upd-check-result" style="font-size:12px; color:var(--clr-text-muted);"></span>
        </div>

        <!-- 親機のみ: 子機への配信管理 -->
        <div id="update-dist-panel" style="display:${currentMode === 'parent' ? 'block' : 'none'}; margin-top:14px; padding-top:14px; border-top:1px dashed var(--clr-border);">
          <div style="font-size:13px; font-weight:700; color:var(--clr-text); margin-bottom:4px;">
            <i class="fas fa-broadcast-tower"></i> 子機への更新配信
            <span class="settings-badge settings-badge--parent">親機専用</span>
          </div>
          <p style="font-size:11px; color:var(--clr-text-muted); margin:0 0 8px 0;">
            GitHub Releases から <code style="background:#edf2f7; padding:1px 4px; border-radius:3px;">latest.yml</code> とインストーラ（.exe）をダウンロードし、ここで取り込むとLAN内の全端末（この親機を含む）へ更新を配信できます。取込時にファイルの整合性（sha512）を検証するため、破損・組み合わせ違いのファイルは配信されません。
          </p>
          <div id="upd-dist-status" style="font-size:12px; color:var(--clr-text-muted); margin-bottom:8px;">読み込み中...</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" id="btn-import-update"><i class="fas fa-file-import"></i> 更新ファイルを取込</button>
            <button class="btn btn-outline btn-sm" id="btn-rollback-update"><i class="fas fa-undo"></i> 1つ前の配信に戻す</button>
          </div>
        </div>
      </div>

      <!-- 移送履歴データの保持期間設定 -->
      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-trash-alt"></i> 移送履歴データの自動削除</h3>
          <span class="settings-badge settings-badge--shared">全体同期・共通設定</span>
        </div>
        <p class="settings-note" style="margin-bottom:12px;">
          帰棟済・キャンセル済の移送イベントを、指定した日数より古い場合に起動時に自動削除します。
          削除されたデータは復元できません。無期限の場合は手動でデータベースを管理してください。
        </p>
        <div class="form-row" style="max-width:320px;">
          <label>完了済みイベントの保持期間</label>
          <select id="cfg-event-retention-days" style="width:100%; padding:6px; border:1px solid var(--clr-border); border-radius:6px; font-size:12px; cursor:pointer;">
            <option value="0"   ${eventRetentionDays === '0'   ? 'selected' : ''}>無期限（自動削除しない）</option>
            <option value="30"  ${eventRetentionDays === '30'  ? 'selected' : ''}>30日間（約1ヶ月）</option>
            <option value="90"  ${eventRetentionDays === '90'  ? 'selected' : ''}>90日間（約3ヶ月）</option>
            <option value="180" ${eventRetentionDays === '180' ? 'selected' : ''}>180日間（約半年）</option>
            <option value="365" ${eventRetentionDays === '365' ? 'selected' : ''}>365日間（約1年）</option>
          </select>
        </div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="btn btn-primary btn-sm" id="btn-save-event-retention"><i class="fas fa-save"></i> 保持期間を保存</button>
          <button class="btn btn-outline btn-sm" id="btn-run-event-cleanup" style="border-color:#ef4444; color:#ef4444;">
            <i class="fas fa-broom"></i> 今すぐ削除を実行
          </button>
        </div>
      </div>

      <!-- データベースの保存先設定 (Desktop・親機専用) -->
      ${window.electronAPI && storageInfo && currentMode === 'parent' ? `
      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-folder-open"></i> データベースの保存先設定</h3>
          <span class="settings-badge settings-badge--parent">親機専用機能</span>
        </div>
        <p style="font-size:11px; color:var(--clr-text-muted); margin:0 0 10px 0;">
          データベースファイル（db.json）の保存先を選択します。<br>
          同一PC内の他のWindowsログインユーザーと設定や履歴を共有したい場合は「全ユーザー共有」を選択してください。
        </p>
        <div style="display:flex; flex-direction:column; gap:12px; margin-bottom:12px; background:var(--clr-bg); padding:12px; border-radius:6px; border:1px solid var(--clr-border);">
          <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px;">
            <input type="radio" name="db-storage-mode" value="user" ${storageInfo.currentMode === 'user' ? 'checked' : ''} style="margin-top:3px;">
            <div>
              <strong>ユーザー専用フォルダ（デフォルト）</strong>
              <div style="font-size:11px; color:var(--clr-text-muted); margin-top:2px;">現在のWindowsログインユーザーのみに適用されます。</div>
              <div style="font-size:10px; color:#a0aec0; font-family:monospace; margin-top:2px; word-break:break-all;">パス: ${storageInfo.userPath}</div>
            </div>
          </label>
          <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px; margin-top:8px;">
            <input type="radio" name="db-storage-mode" value="common" ${storageInfo.currentMode === 'common' ? 'checked' : ''} style="margin-top:3px;">
            <div>
              <strong>全ユーザー共有フォルダ（ProgramData）</strong>
              <div style="font-size:11px; color:var(--clr-text-muted); margin-top:2px;">このPCを使用するすべてのWindowsログインユーザーで設定・データを共有します。</div>
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

      <!-- データベースのバックアップと復元 (Desktop・親機専用) -->
      ${window.electronAPI && currentMode === 'parent' ? `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-database"></i> データベースのバックアップと復元</h3>
          <span class="settings-badge settings-badge--parent">親機専用機能</span>
        </div>
        <p style="font-size:11px; color:var(--clr-text-muted); margin:0 0 10px 0;">病棟・病床マスタ、各種設定、最近の移送履歴データを含んだデータベース（db.json）のバックアップを作成・復元します。</p>
        <div style="margin-bottom:10px;">
          <label style="display:block; font-size:12px; font-weight:700; color:var(--clr-text); margin-bottom:6px;">バックアップ形式</label>
          <label style="display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:4px; cursor:pointer;">
            <input type="radio" name="backup-mode" value="encrypted" checked> パスワードで暗号化する（患者情報を含む・推奨）
          </label>
          <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;">
            <input type="radio" name="backup-mode" value="redacted"> 患者情報を除いて出力する（平文・調査用途向け）
          </label>
        </div>
        <div class="form-row" id="backup-password-row" style="margin-bottom:12px;">
          <label style="font-size:12px;">パスワード <span style="font-size:11px; color:var(--clr-text-muted); font-weight:400;">（暗号化バックアップの作成・復元時に使用）</span></label>
          <input type="password" id="cfg-backup-password" style="width:100%; max-width:280px; padding:6px 8px; border:1px solid var(--clr-border); border-radius:6px;" placeholder="バックアップ用パスワード">
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
    `;

    // ── このアプリについて / 診断情報エクスポート ──
    document.getElementById('btn-export-diagnostics')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-export-diagnostics');
      if (!window.electronAPI?.exportDiagnosticsBundle) {
        UI.toast('デスクトップ環境でのみ実行可能です', 'warning');
        return;
      }
      btn.disabled = true;
      const oldHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 出力中...';
      try {
        const res = await window.electronAPI.exportDiagnosticsBundle();
        if (res?.success) {
          UI.toast(`診断情報を保存しました:\n${res.filePath}`, 'success');
        } else if (res && res.message !== 'Cancelled') {
          UI.toast(`診断情報の出力に失敗しました: ${res.message}`, 'danger');
        }
      } catch (e) {
        UI.toast(`診断情報の出力に失敗しました: ${e.message}`, 'danger');
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    });

    // ── アプリ更新 — 自動チェック設定・手動チェック・配信管理 ──
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
    if (currentMode === 'parent') refreshDistStatus();

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

    // ── 移送履歴データの保持期間・手動クリーンアップ ──
    const saveRetentionBtn = document.getElementById('btn-save-event-retention');
    if (saveRetentionBtn) {
      saveRetentionBtn.onclick = async () => {
        const val = document.getElementById('cfg-event-retention-days')?.value || '0';
        saveRetentionBtn.disabled = true;
        try {
          await API.patch('system_settings', 'event_retention_days', { value: val });
          const obj = AppState.systemSettings?.find(s => s.id === 'event_retention_days');
          if (obj) obj.value = val; else AppState.systemSettings.push({ id: 'event_retention_days', value: val });
          UI.toast('保持期間を保存しました', 'success');
        } catch (e) {
          UI.toast('保存に失敗しました: ' + e.message, 'danger');
        } finally {
          saveRetentionBtn.disabled = false;
        }
      };
    }

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

    // ── データベースの保存先設定 ──
    const changeDbStorageBtn = document.getElementById('btn-change-db-storage');
    if (changeDbStorageBtn && storageInfo) {
      body.querySelectorAll('input[name="db-storage-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
          const warningDiv = document.getElementById('db-storage-permission-warning');
          if (warningDiv) {
            warningDiv.style.display = (e.target.value === 'common' && !storageInfo.hasCommonWritePermission) ? 'block' : 'none';
          }
        });
      });

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
            if (window.electronAPI.relaunchApp) window.electronAPI.relaunchApp();
            else location.reload();
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

    // ── バックアップ・復元 ──
    const backupPasswordRow = document.getElementById('backup-password-row');
    body.querySelectorAll('input[name="backup-mode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        if (backupPasswordRow) backupPasswordRow.style.opacity = radio.value === 'redacted' && radio.checked ? '0.5' : '1';
      });
    });

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
            this.render(); // 最終バックアップ日時の表示を更新
          } else if (res && res.message !== 'Cancelled') {
            UI.toast(`バックアップ保存エラー: ${res.message}`, 'danger');
          }
        } catch (e) {
          UI.toast(`バックアップ保存に失敗しました: ${e.message}`, 'danger');
        }
      };
    }

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
            setTimeout(() => { window.electronAPI.relaunchApp(); }, 1500);
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
  },

});
