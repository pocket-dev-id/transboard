/**
 * TransBoard - 設定画面: ステータスカスタマイズ
 */

Object.assign(Settings, {

  // WCAG相対輝度からコントラスト比を算出（デザイン#3）
  _contrastRatio(hex1, hex2) {
    const luminance = (hex) => {
      const c = hex.replace('#', '');
      const rgb = [0, 2, 4].map(i => parseInt(c.substr(i, 2), 16) / 255);
      const [r, g, b] = rgb.map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    try {
      const l1 = luminance(hex1);
      const l2 = luminance(hex2);
      const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (lighter + 0.05) / (darker + 0.05);
    } catch { return null; }
  },

  async _renderStatusCustomize(body) {
    const saveSetting = async (id, obj) => {
      const val = JSON.stringify(obj);
      await API.patch('system_settings', id, { value: val });
      const s = AppState.systemSettings?.find(x => x.id === id);
      if (s) s.value = val; else AppState.systemSettings.push({ id, value: val });
      if (typeof App !== 'undefined' && App.applySystemVisualSettings) App.applySystemVisualSettings();
    };

    const STATUS_ORDER = ['IN_BED','MOVING','ARRIVED','IN_EXAM','NEARLY_DONE','PICKUP_REQUIRED','RETURNED','CANCELLED'];
    // デフォルト表示名・デフォルト色は config.js を単一の情報源とする（コード#2）
    const DEFAULT_LABELS = CONFIG.STATUS_LABEL_DEFAULTS;
    const STATUS_COLOR_DEFAULTS = CONFIG.STATUS_DEFAULT_COLORS;
    const ALL_ACTION_BTNS = [
      { key: 'MOVING:ARRIVED',                    label: '検査室到着',      scope: '病棟側' },
      { key: 'MOVING:IN_EXAM',                    label: '検査開始',        scope: '病棟側' },
      { key: 'ARRIVED:IN_EXAM',                   label: '検査開始',        scope: '病棟側' },
      { key: 'IN_EXAM:NEARLY_DONE',               label: 'あと10分',        scope: '病棟側' },
      { key: 'IN_EXAM:PICKUP_REQUIRED',           label: '迎え要',          scope: '病棟側' },
      { key: 'NEARLY_DONE:PICKUP_REQUIRED',       label: '迎え要',          scope: '病棟側' },
      { key: 'PICKUP_REQUIRED:RETURNED',          label: '帰棟完了',        scope: '病棟側' },
      { key: 'EXAM:MOVING:ARRIVED',               label: '到着',            scope: '検査室側' },
      { key: 'EXAM:MOVING:IN_EXAM',               label: '到着・検査開始',  scope: '検査室側' },
      { key: 'EXAM:ARRIVED:IN_EXAM',              label: '検査開始',        scope: '検査室側' },
      { key: 'EXAM:IN_EXAM:NEARLY_DONE',          label: 'あと10分',        scope: '検査室側' },
      { key: 'EXAM:IN_EXAM:PICKUP_REQUIRED',      label: '終了（迎え要）',  scope: '検査室側' },
      { key: 'EXAM:NEARLY_DONE:PICKUP_REQUIRED',  label: '終了（迎え要）',  scope: '検査室側' },
    ];
    const HIDEABLE_STATUSES = ['ARRIVED','NEARLY_DONE'];

    const customLabels   = AppState.getSettingJSON('status_custom_labels', {});
    const ndMin          = AppState.getSettingInt('nearly_done_minutes', 10);
    const stMin          = AppState.getSettingInt('soon_threshold_min', 15);
    const statusColors   = AppState.getSettingJSON('status_colors', {});
    const actionLabels   = AppState.getSettingJSON('action_button_labels', {});
    const hiddenStatuses = AppState.getSettingJSON('hidden_statuses', []);
    const skipArrivedStep = hiddenStatuses.includes('ARRIVED');
    ALL_ACTION_BTNS.forEach(item => {
      if (item.key.endsWith(':NEARLY_DONE')) item.label = `あと${ndMin}分`;
    });
    const safeHex = (value, fallback) => (
      /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback
    );

    const statusLabelRows = STATUS_ORDER.map(sid => `
      <tr>
        <td style="font-weight:600; white-space:nowrap;">${sid}</td>
        <td style="color:var(--clr-text-muted);">${DEFAULT_LABELS[sid]}</td>
        <td>
          <input type="text" class="custom-label-input settings-input-text" data-status="${sid}"
            value="${UI.escapeHTML(customLabels[sid] || '')}"
            placeholder="${DEFAULT_LABELS[sid]}">
        </td>
      </tr>`).join('');

    const ndOptions = [5,10,15,20,30].map(m => `<option value="${m}" ${m===ndMin?'selected':''}>${m}分</option>`).join('');
    const stOptions = [3,5,10,15,20,30].map(m => `<option value="${m}" ${m===stMin?'selected':''}>${m}分</option>`).join('');

    const colorRows = STATUS_ORDER.map(sid => {
      const c = statusColors[sid] || {};
      const defBg = safeHex(STATUS_COLOR_DEFAULTS[sid], '#ffffff');
      const cardBg = safeHex(c.card_bg, defBg);
      const cardBorder = safeHex(c.card_border, '#94a3b8');
      const badgeBg = safeHex(c.badge_bg, defBg);
      const badgeText = safeHex(c.badge_text, '#1a202c');
      const ratio = this._contrastRatio(badgeBg, badgeText);
      const lowContrast = ratio !== null && ratio < 4.5;
      return `
        <tr>
          <td style="font-weight:600;">${DEFAULT_LABELS[sid]}</td>
          <td style="text-align:center;">
            <input type="color" class="sc-card-bg settings-color-swatch" data-status="${sid}" value="${cardBg}">
          </td>
          <td style="text-align:center;">
            <input type="color" class="sc-card-border settings-color-swatch" data-status="${sid}" value="${cardBorder}">
          </td>
          <td style="text-align:center;">
            <input type="color" class="sc-badge-bg settings-color-swatch" data-status="${sid}" value="${badgeBg}">
          </td>
          <td style="text-align:center;">
            <input type="color" class="sc-badge-text settings-color-swatch" data-status="${sid}" value="${badgeText}">
          </td>
          <td style="text-align:center;">
            <span class="settings-preview-badge sc-preview-badge" data-status="${sid}"
              style="background:${badgeBg}; color:${badgeText};">${DEFAULT_LABELS[sid]}</span>
            <i class="fas fa-exclamation-triangle settings-contrast-warn sc-contrast-warn" data-status="${sid}"
              title="コントラスト比が低く読みにくい可能性があります（${ratio ? ratio.toFixed(1) : '?'}:1 / 推奨4.5:1以上）"
              style="display:${lowContrast ? 'inline' : 'none'};"></i>
          </td>
          <td>
            <button class="btn btn-outline btn-sm sc-reset-row" data-status="${sid}" title="このステータスの色をリセット">
              <i class="fas fa-undo"></i>
            </button>
          </td>
        </tr>`;
    }).join('');

    const actionLabelRows = ALL_ACTION_BTNS.map(btn => {
      const transKey = btn.key.replace(/^EXAM:/, '');
      const transLabel = transKey.split(':').map(s => DEFAULT_LABELS[s] || s).join(' → ');
      return `
        <tr>
          <td style="color:var(--clr-text-muted); font-size:12px;">${btn.scope}</td>
          <td style="font-size:12px;">${transLabel}</td>
          <td style="color:var(--clr-text-muted);">${btn.label}</td>
          <td>
            <input type="text" class="action-label-input settings-input-text" data-key="${btn.key}"
              value="${UI.escapeHTML(actionLabels[btn.key] || '')}"
              placeholder="${btn.label}">
          </td>
        </tr>`;
    }).join('');

    const hiddenCheckboxes = HIDEABLE_STATUSES.map(sid => `
      <label style="display:flex; align-items:center; gap:8px; padding:6px 0; font-size:14px;">
        <input type="checkbox" class="hidden-status-chk" data-status="${sid}"
          ${hiddenStatuses.includes(sid) ? 'checked' : ''}>
        <span><strong>${DEFAULT_LABELS[sid]}</strong>（${sid}）を使用しない中間ステータスとして扱う</span>
      </label>`).join('');

    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-sliders-h"></i> ステータスカスタマイズ</h3>
          <p style="margin:4px 0 0; font-size:12px; color:#64748b;">施設の運用フロー・用語に合わせてステータス表示を調整できます。変更はすべての端末に即時反映されます。</p>
        </div>

        <div class="settings-section" style="margin-bottom:24px;">
          <h4 class="settings-section-title"><i class="fas fa-tag"></i> ステータス表示名のカスタマイズ</h4>
          <p style="font-size:12px; color:#64748b; margin-bottom:8px;">空欄の場合はデフォルト名が使用されます。</p>
          <div style="overflow-x:auto;">
            <table class="settings-table">
              <thead>
                <tr>
                  <th>ステータスID</th>
                  <th>デフォルト名</th>
                  <th>カスタム表示名</th>
                </tr>
              </thead>
              <tbody>${statusLabelRows}</tbody>
            </table>
          </div>
          <div style="margin-top:12px; display:flex; gap:8px;">
            <button class="btn btn-primary btn-sm" id="btn-save-status-labels"><i class="fas fa-save"></i> 表示名を保存</button>
            <button class="btn btn-outline btn-sm" id="btn-reset-status-labels"><i class="fas fa-undo"></i> すべてリセット</button>
          </div>
        </div>

        <div class="settings-section" style="margin-bottom:24px;">
          <h4 class="settings-section-title"><i class="fas fa-clock"></i> タイミングしきい値</h4>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; max-width:500px;">
            <div>
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">「あと何分」（NEARLY_DONE）</label>
              <select id="cfg-nearly-done-min" style="width:100%; padding:6px 8px; border:1px solid #cbd5e1; border-radius:4px; font-size:14px;">
                ${ndOptions}
              </select>
              <p style="font-size:11px; color:#64748b; margin-top:2px;">この分数後に迎え目安を自動設定します</p>
            </div>
            <div>
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">「まもなく迎え」閾値（SOON）</label>
              <select id="cfg-soon-threshold" style="width:100%; padding:6px 8px; border:1px solid #cbd5e1; border-radius:4px; font-size:14px;">
                ${stOptions}
              </select>
              <p style="font-size:11px; color:#64748b; margin-top:2px;">残り時間がこの分数以内で「まもなく」表示</p>
            </div>
          </div>
          <div style="margin-top:12px;">
            <button class="btn btn-primary btn-sm" id="btn-save-thresholds"><i class="fas fa-save"></i> しきい値を保存</button>
          </div>
        </div>

        <div class="settings-section" style="margin-bottom:24px;">
          <h4 class="settings-section-title"><i class="fas fa-palette"></i> ステータスカラーのカスタマイズ</h4>
          <p style="font-size:12px; color:#64748b; margin-bottom:4px;">高コントラスト・CVDテーマ有効時はテーマが優先されます。</p>
          <div style="overflow-x:auto;">
            <table class="settings-table">
              <thead>
                <tr>
                  <th>ステータス</th>
                  <th>カード背景</th>
                  <th>カード枠線</th>
                  <th>バッジ背景</th>
                  <th>バッジ文字</th>
                  <th>プレビュー</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${colorRows}</tbody>
            </table>
          </div>
          <div style="margin-top:12px; display:flex; gap:8px;">
            <button class="btn btn-primary btn-sm" id="btn-save-colors"><i class="fas fa-save"></i> カラーを保存</button>
            <button class="btn btn-outline btn-sm" id="btn-reset-all-colors"><i class="fas fa-undo"></i> すべてリセット</button>
          </div>
        </div>

        <div class="settings-section" style="margin-bottom:24px;">
          <h4 class="settings-section-title"><i class="fas fa-hand-pointer"></i> アクションボタンラベル</h4>
          <p style="font-size:12px; color:#64748b; margin-bottom:8px;">空欄の場合はデフォルトラベルが使用されます。</p>
          <div style="overflow-x:auto;">
            <table class="settings-table">
              <thead>
                <tr>
                  <th>画面</th>
                  <th>遷移</th>
                  <th>デフォルトラベル</th>
                  <th>カスタムラベル</th>
                </tr>
              </thead>
              <tbody>${actionLabelRows}</tbody>
            </table>
          </div>
          <div style="margin-top:12px; display:flex; gap:8px;">
            <button class="btn btn-primary btn-sm" id="btn-save-action-labels"><i class="fas fa-save"></i> ボタンラベルを保存</button>
            <button class="btn btn-outline btn-sm" id="btn-reset-action-labels"><i class="fas fa-undo"></i> すべてリセット</button>
          </div>
        </div>

        <div class="settings-section" style="margin-bottom:24px;">
          <h4 class="settings-section-title"><i class="fas fa-toggle-on"></i> 検査室到着ステップ</h4>
          <label style="display:flex; align-items:flex-start; gap:10px; padding:10px 12px; border:1px solid #cbd5e1; border-radius:6px; background:#f8fafc; max-width:720px;">
            <input type="checkbox" id="chk-skip-arrived-step" ${skipArrivedStep ? 'checked' : ''} style="margin-top:3px;">
            <span>
              <strong>「検査室到着」と「検査開始」を統合する</strong><br>
              <span style="font-size:12px; color:#64748b;">ONにすると検査室側の到着操作で直接「検査中」へ進み、到着時刻と検査開始時刻を同時に記録します。OFFでは従来どおり「検査室到着」後に「検査開始」を押します。</span>
            </span>
          </label>
        </div>

        <div class="settings-section">
          <h4 class="settings-section-title"><i class="fas fa-eye-slash"></i> 使用しない中間ステータス</h4>
          <p style="font-size:12px; color:#64748b; margin-bottom:8px;">選択した中間ステータスは運用フローから除外されます。病棟・検査室・ICスキャン・子機からの更新にも反映され、可能な場合は次の有効なステータスへ直接進めます。<br>例: 検査室到着（ARRIVED）を使わず移動中から直接検査中に遷移する運用フロー。</p>
          ${hiddenCheckboxes}
          <div style="margin-top:12px;">
            <button class="btn btn-primary btn-sm" id="btn-save-hidden-statuses"><i class="fas fa-save"></i> 非表示設定を保存</button>
          </div>
        </div>
      </div>
    `;

    // #1 表示名の保存・リセット
    document.getElementById('btn-save-status-labels').onclick = async () => {
      const labels = {};
      body.querySelectorAll('.custom-label-input').forEach(input => {
        const v = input.value.trim();
        if (v) labels[input.dataset.status] = v;
      });
      try {
        await saveSetting('status_custom_labels', labels);
        UI.toast('ステータス表示名を保存しました', 'success');
      } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'danger'); }
    };
    document.getElementById('btn-reset-status-labels').onclick = async () => {
      if (!await UI.confirmModal('すべてのカスタム表示名をデフォルトに戻しますか？')) return;
      try {
        await saveSetting('status_custom_labels', {});
        body.querySelectorAll('.custom-label-input').forEach(input => { input.value = ''; });
        UI.toast('表示名をリセットしました', 'success');
      } catch (e) { UI.toast('リセットに失敗しました: ' + e.message, 'danger'); }
    };

    // #2 しきい値の保存
    document.getElementById('btn-save-thresholds').onclick = async () => {
      const ndVal = document.getElementById('cfg-nearly-done-min').value;
      const stVal = document.getElementById('cfg-soon-threshold').value;
      try {
        await Promise.all([
          API.patch('system_settings', 'nearly_done_minutes', { value: ndVal }),
          API.patch('system_settings', 'soon_threshold_min',  { value: stVal }),
        ]);
        const update = (id, val) => {
          const s = AppState.systemSettings?.find(x => x.id === id);
          if (s) s.value = val; else AppState.systemSettings.push({ id, value: val });
        };
        update('nearly_done_minutes', ndVal);
        update('soon_threshold_min', stVal);
        if (typeof App !== 'undefined' && App.applySystemVisualSettings) App.applySystemVisualSettings();
        UI.toast('しきい値を保存しました', 'success');
      } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'danger'); }
    };

    // #3 カラーのライブプレビュー・コントラスト警告更新（デザイン#2・#3）
    const updateRowPreview = (row) => {
      const badgeBg = row.querySelector('.sc-badge-bg').value;
      const badgeText = row.querySelector('.sc-badge-text').value;
      const preview = row.querySelector('.sc-preview-badge');
      const warnIcon = row.querySelector('.sc-contrast-warn');
      if (preview) {
        preview.style.background = badgeBg;
        preview.style.color = badgeText;
      }
      if (warnIcon) {
        const ratio = this._contrastRatio(badgeBg, badgeText);
        const lowContrast = ratio !== null && ratio < 4.5;
        warnIcon.style.display = lowContrast ? 'inline' : 'none';
        warnIcon.title = `コントラスト比が低く読みにくい可能性があります（${ratio ? ratio.toFixed(1) : '?'}:1 / 推奨4.5:1以上）`;
      }
    };
    body.querySelectorAll('.sc-badge-bg, .sc-badge-text').forEach(input => {
      input.addEventListener('input', () => updateRowPreview(input.closest('tr')));
    });

    // #3 カラーの行リセット・一括保存・全リセット
    body.querySelectorAll('.sc-reset-row').forEach(btn => {
      btn.onclick = () => {
        const sid = btn.dataset.status;
        const row = btn.closest('tr');
        const defBg = STATUS_COLOR_DEFAULTS[sid] || '#ffffff';
        row.querySelector('.sc-card-bg').value    = defBg;
        row.querySelector('.sc-card-border').value = '#94a3b8';
        row.querySelector('.sc-badge-bg').value   = defBg;
        row.querySelector('.sc-badge-text').value  = '#1a202c';
        updateRowPreview(row);
      };
    });
    document.getElementById('btn-save-colors').onclick = async () => {
      const colors = {};
      STATUS_ORDER.forEach(sid => {
        const bgEl = body.querySelector(`.sc-card-bg[data-status="${sid}"]`);
        if (!bgEl) return;
        const row = bgEl.closest('tr');
        colors[sid] = {
          card_bg:    row.querySelector('.sc-card-bg').value,
          card_border: row.querySelector('.sc-card-border').value,
          badge_bg:   row.querySelector('.sc-badge-bg').value,
          badge_text: row.querySelector('.sc-badge-text').value,
        };
      });
      try {
        await saveSetting('status_colors', colors);
        UI.toast('ステータスカラーを保存しました', 'success');
      } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'danger'); }
    };
    document.getElementById('btn-reset-all-colors').onclick = async () => {
      if (!await UI.confirmModal('すべてのステータスカラーをデフォルトに戻しますか？')) return;
      try {
        await saveSetting('status_colors', {});
        document.documentElement.removeAttribute('style');
        if (typeof App !== 'undefined' && App.applySystemVisualSettings) App.applySystemVisualSettings();
        UI.toast('カラーをリセットしました', 'success');
        this._renderStatusCustomize(body);
      } catch (e) { UI.toast('リセットに失敗しました: ' + e.message, 'danger'); }
    };

    // #4 ボタンラベルの保存・リセット
    document.getElementById('btn-save-action-labels').onclick = async () => {
      const labels = {};
      body.querySelectorAll('.action-label-input').forEach(input => {
        const v = input.value.trim();
        if (v) labels[input.dataset.key] = v;
      });
      try {
        await saveSetting('action_button_labels', labels);
        UI.toast('ボタンラベルを保存しました', 'success');
      } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'danger'); }
    };
    document.getElementById('btn-reset-action-labels').onclick = async () => {
      if (!await UI.confirmModal('すべてのカスタムボタンラベルをデフォルトに戻しますか？')) return;
      try {
        await saveSetting('action_button_labels', {});
        body.querySelectorAll('.action-label-input').forEach(input => { input.value = ''; });
        UI.toast('ボタンラベルをリセットしました', 'success');
      } catch (e) { UI.toast('リセットに失敗しました: ' + e.message, 'danger'); }
    };

    // #5 非表示ステータスの保存
    const skipArrivedChk = document.getElementById('chk-skip-arrived-step');
    const arrivedHiddenChk = body.querySelector('.hidden-status-chk[data-status="ARRIVED"]');
    if (skipArrivedChk && arrivedHiddenChk) {
      skipArrivedChk.addEventListener('change', () => {
        arrivedHiddenChk.checked = skipArrivedChk.checked;
      });
      arrivedHiddenChk.addEventListener('change', () => {
        skipArrivedChk.checked = arrivedHiddenChk.checked;
      });
    }

    document.getElementById('btn-save-hidden-statuses').onclick = async () => {
      const hidden = [];
      body.querySelectorAll('.hidden-status-chk:checked').forEach(chk => hidden.push(chk.dataset.status));
      try {
        await saveSetting('hidden_statuses', hidden);
        if (typeof WardDashboard !== 'undefined') WardDashboard.render();
        if (typeof ExamRoom !== 'undefined') ExamRoom.render();
        if (typeof Timeline !== 'undefined') Timeline.render();
        if (typeof Priority !== 'undefined') {
          Priority.renderSummary();
          Priority.renderPriorityList();
        }
        UI.toast('非表示設定を保存しました', 'success');
      } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'danger'); }
    };
  },

});
