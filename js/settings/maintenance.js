/**
 * TransBoard - 設定画面: システム保守
 * 「このアプリについて」/ DB概況（サイズ・件数・最終バックアップ日時）と、
 * トラブル時にベンダーへ渡す診断情報の一括エクスポートを提供する。
 * （バックアップ/復元・DB保存先・更新配信は「共有・ネットワーク設定」タブにある）
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

    const dbInfo = window.electronAPI && window.electronAPI.getDbInfo
      ? await window.electronAPI.getDbInfo().catch(() => null)
      : null;

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
        <p style="font-size:11px; color:var(--clr-text-muted); margin:10px 0 0 0;">
          <i class="fas fa-info-circle"></i> バックアップ／復元・DB保存先・アプリ更新は「共有・ネットワーク設定」タブで管理します。
        </p>
      </div>

      <!-- 診断情報エクスポート -->
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-file-medical-alt"></i> 診断情報のエクスポート</h3>
          <span class="settings-badge settings-badge--terminal">個別設定（PCごと）</span>
        </div>
        <p style="font-size:12px; color:var(--clr-text-muted); margin:0 0 12px 0;">
          debug.log・直近の取り込みログ・システム概況を1つのファイルにまとめて出力します。
          <strong>患者情報・パスワード等は含まれません。</strong>サポート問い合わせ時に添付してください。
        </p>
        <button class="btn btn-outline btn-sm" id="btn-export-diagnostics"><i class="fas fa-file-export"></i> 診断情報をエクスポート</button>
      </div>
    `;

    // 診断情報エクスポート
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
  },

});
