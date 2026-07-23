/**
 * TransBoard - 設定画面: 取り込み設定・通知音設定・アナウンス定型文・スケジュール取り込み
 */

// ODBC読み取り専用安全対策: SQLクエリバリデーション
function validateReadOnlyQuery(sql) {
  if (!sql) return { valid: false, message: 'SQLクエリが空です。' };
  
  // コメントの除去 (ブロックコメントと行コメント)
  const cleanSql = sql.trim().replace(/\/\*[\s\S]*?\*\/|--.*$/gm, '');
  
  // SELECTまたはWITHで開始しているか検証 (先頭の括弧やスペースを考慮)
  if (!/^\(?(SELECT|WITH)\b/i.test(cleanSql)) {
    return { valid: false, message: '安全対策のため、SQLクエリは SELECT または WITH で開始する必要があります。' };
  }
  
  // 文字列リテラルを除去してからキーワード検証（リテラル内の単語への誤検知防止）
  const sqlWithoutStrings = cleanSql.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

  // 書き込み・変更系のキーワードを検出 (単語境界を使用)
  const forbiddenKeywords = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create',
    'truncate', 'replace', 'merge', 'grant', 'revoke',
    'exec', 'execute', 'into'
  ];

  for (const keyword of forbiddenKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(sqlWithoutStrings)) {
      return {
        valid: false,
        message: `安全対策のため、データベース書き込み/変更を伴う可能性のあるキーワード「${keyword.toUpperCase()}」は使用できません。`
      };
    }
  }
  
  // セミコロンによる複数ステートメントの検証 (文字列リテラル内を除く)
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let hasStatementsAfterSemicolon = false;
  
  for (let i = 0; i < cleanSql.length; i++) {
    const char = cleanSql[i];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      // セミコロンの後に空白以外の文字が続いているか検証
      const remaining = cleanSql.slice(i + 1).trim();
      if (remaining.length > 0) {
        hasStatementsAfterSemicolon = true;
        break;
      }
    }
  }
  
  if (hasStatementsAfterSemicolon) {
    return { valid: false, message: '安全対策のため、複数SQLステートメントの同時実行は禁止されています。' };
  }
  
  return { valid: true };
}

Object.assign(Settings, {

  async _renderImportSettings(body) {
    // マスタから設定レコードを取得
    const dirSetting = AppState.systemSettings?.find(s => s.id === 'import_directory') || { value: '' };
    const currentPath = dirSetting.value || '（デフォルト: プロジェクト内の import_folder フォルダ）';

    // アーカイブフォルダの状況を取得（セキュリティ C-1: 平文残留の可視化）
    const archiveInfo = window.electronAPI && window.electronAPI.getArchiveInfo
      ? await window.electronAPI.getArchiveInfo().catch(() => ({ exists: false, count: 0 }))
      : { exists: false, count: 0 };

    const smbAuthSetting = AppState.systemSettings?.find(s => s.id === 'smb_auth_mode') || { value: 'current' };
    const smbUsernameSetting = AppState.systemSettings?.find(s => s.id === 'smb_username') || { value: '' };
    const smbPasswordSetting = AppState.systemSettings?.find(s => s.id === 'smb_password') || { value: '' };

    const mappingSetting = AppState.systemSettings?.find(s => s.id === 'import_mapping');
    let mapping = { bed_number: '', patient_id: '', patient_name: '', is_present: '' };
    if (mappingSetting && mappingSetting.value) {
      try { mapping = JSON.parse(mappingSetting.value); } catch(e) {}
    }

    const scheduleSetting = AppState.systemSettings?.find(s => s.id === 'import_schedule');
    let schedule = { mode: 'realtime', intervalMin: '10', times: [] };
    if (scheduleSetting && scheduleSetting.value) {
      try { schedule = JSON.parse(scheduleSetting.value); } catch(e) {}
    }

    const policySetting = AppState.systemSettings?.find(s => s.id === 'import_retention_policy');
    let policy = { action: 'archive', retentionDays: '30', clearUnlisted: false };
    if (policySetting && policySetting.value) {
      try { policy = JSON.parse(policySetting.value); } catch(e) {}
    }

    const connTypeSetting = AppState.systemSettings?.find(s => s.id === 'import_connection_type') || { value: 'csv' };
    const odbcConnSetting = AppState.systemSettings?.find(s => s.id === 'odbc_connection_string') || { value: 'DSN=EMR_DB;UID=admin;PWD=admin_pass;' };
    const odbcQuerySetting = AppState.systemSettings?.find(s => s.id === 'odbc_sql_query') || { value: 'SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS' };

    const showSyncTime = (AppState.systemSettings?.find(s => s.id === 'show_sync_time')?.value ?? 'true') !== 'false';
    const showImportTime = (AppState.systemSettings?.find(s => s.id === 'show_import_time')?.value ?? 'true') !== 'false';
    const admissionModeSetting = AppState.systemSettings?.find(s => s.id === 'admission_mode') || { value: 'csv' };

    // インポートログの取得
    let logs = [];
    try {
      const logsRes = await API.getAll('import_logs');
      logs = (logsRes.data || []).sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
    } catch (e) {
      console.error('[Settings] ログの取得失敗:', e);
    }

    const logRowsHtml = logs.length === 0
      ? '<tr><td colspan="5" class="text-center text-muted" style="padding:15px;">インポート履歴データがありません</td></tr>'
      : logs.map(l => {
        let badgeCls = 'badge-IN_BED';
        let statusLabel = '成功';
        if (l.status === 'success') { badgeCls = 'badge-RETURNED'; statusLabel = '成功'; }
        else if (l.status === 'warning') { badgeCls = 'badge-NEARLY_DONE'; statusLabel = '警告'; }
        else if (l.status === 'failed') { badgeCls = 'badge-PICKUP_REQUIRED'; statusLabel = '失敗'; }
        else if (l.status === 'archive_error') { badgeCls = 'badge-NEARLY_DONE'; statusLabel = '移動エラー'; }

        return `
          <tr>
            <td>${UI.formatDateTime(l.timestamp)}</td>
            <td class="font-bold">${l.fileName}</td>
            <td><span class="status-badge ${badgeCls}" style="padding:2px 6px; font-size:10px; border-radius:3px; display:inline-block; font-weight:800;">${statusLabel}</span></td>
            <td>${l.message || ''}</td>
            <td class="text-muted text-sm">${l.details || ''}</td>
          </tr>
        `;
      }).join('');

    const admMode = admissionModeSetting.value || 'csv';
    body.innerHTML = `
      <div class="settings-panel" style="margin-bottom:16px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-procedures"></i> 在室管理モード</h3>
          <button class="btn btn-primary btn-sm" id="btn-save-admission-mode"><i class="fas fa-save"></i> 保存</button>
        </div>
        <p class="settings-hint"><i class="fas fa-info-circle"></i>
          患者の在室情報をどのように管理するか選択します。モードはいつでも変更できます。
        </p>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px;" id="admission-mode-cards">
          ${[
            { key:'csv',    icon:'fa-file-csv',    title:'CSV連携モード',  color:'#3b82f6',
              desc:'電子カルテからCSV/ODBCで在室データを自動取り込みします。病床カードへの患者登録はシステムが行います。' },
            { key:'manual', icon:'fa-hand-pointer', title:'手動登録モード', color:'#16a34a',
              desc:'スタッフが病床カードをクリックして患者を手動で登録・退院します。CSVインポートは使用しません。' },
            { key:'hybrid', icon:'fa-code-branch',  title:'ハイブリッドモード', color:'#7c3aed',
              desc:'CSV自動取り込みと手動登録を併用します。手動登録した病床はCSVの自動クリアから保護されます。' },
          ].map(m => `
            <label class="admission-mode-card ${admMode===m.key?'selected':''}" data-mode="${m.key}"
              style="border:2px solid ${admMode===m.key ? m.color : '#e2e8f0'};border-radius:10px;padding:14px;cursor:pointer;
                     background:${admMode===m.key ? m.color+'14' : '#fafafa'};display:flex;flex-direction:column;gap:8px;transition:all .15s;">
              <input type="radio" name="admission-mode" value="${m.key}" ${admMode===m.key?'checked':''} style="display:none;">
              <div style="display:flex;align-items:center;gap:8px;">
                <i class="fas ${m.icon}" style="font-size:20px;color:${m.color};"></i>
                <strong style="font-size:13px;color:#1e293b;">${m.title}</strong>
              </div>
              <p style="font-size:11.5px;color:#475569;margin:0;line-height:1.5;">${m.desc}</p>
            </label>
          `).join('')}
        </div>
      </div>

      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-file-import"></i> 自動取り込み連携設定</h3>
        </div>
        <div style="margin-bottom:16px; padding:12px; background:#fffbeb; border:1px solid #fef3c7; border-radius:8px; color:#b45309; font-size:12.5px; display:flex; align-items:flex-start; gap:10px;">
          <i class="fas fa-exclamation-triangle" style="margin-top:2px; font-size:16px; color:#d97706;"></i>
          <div>
            <strong style="display:block; margin-bottom:2px; font-weight:700;">【親機専用設定】</strong>
            <span style="font-size:11.5px; line-height:1.5; color:#92400e;">
              この「データ取り込み連携設定」は、データベースを直接所持している**親機（サーバー）のPCでのみ実行**されます。子機（クライアント）PC上では設定を変更できますが、実際のファイルスキャンや同期のバックグラウンド処理は行われません。
            </span>
          </div>
        </div>
        <p class="settings-hint">
          <i class="fas fa-info-circle"></i>
          電子カルテ連携用データの監視パス、スケジュール、カラム対応定義を設定します。
        </p>

        <!-- 接続タイプ選択 -->
        <div style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0; margin-top:16px; margin-bottom:16px;">
          <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-plug"></i> 連携方式の選択</h4>
          <div style="display:flex; gap:24px;">
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px; font-weight:600;">
              <input type="radio" name="import-conn-type" value="csv" ${connTypeSetting.value === 'csv' ? 'checked' : ''}>
              CSVファイル監視連携
            </label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px; font-weight:600;">
              <input type="radio" name="import-conn-type" value="odbc" ${connTypeSetting.value === 'odbc' ? 'checked' : ''}>
              ODBCデータベース直接同期
            </label>
          </div>
        </div>
        
        <div class="settings-form-grid" style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
          
          <!-- 左カラム：パス・マッピング・スケジュール -->
          <div style="display:flex; flex-direction:column; gap:16px;">
            
            <!-- 1. 監視フォルダパス (CSV用) -->
            <div id="csv-folder-panel" style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0; display:${connTypeSetting.value === 'csv' ? 'block' : 'none'};">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-folder-open"></i> 監視対象フォルダ</h4>
              <div class="form-row" style="margin-bottom:12px;">
                <label>絶対パス</label>
                <input type="text" id="cfg-import-path" placeholder="例: C:\\HospitalData\\Import" style="width:100%; padding:8px; border:1px solid #cbd5e0; border-radius:6px;" value="${dirSetting.value || ''}">
                <div style="margin-top:6px; font-size:11px; color:#718096;">
                  <strong>現在の有効な監視先:</strong> <code style="background:#edf2f7; padding:2px 6px; border-radius:4px;">${currentPath}</code>
                </div>
              </div>
              
              <!-- SMBネットワーク共有認証 -->
              <div style="border-top:1px dashed #cbd5e0; margin-top:12px; margin-bottom:12px; padding-top:12px;">
                <label style="font-size:12px; font-weight:700; color:#4a5568;"><i class="fas fa-network-wired"></i> SMB共有アクセス権限（ネットワークパス用）</label>
                <select id="cfg-smb-auth-mode" style="width:100%; padding:6px; margin-top:4px; border:1px solid #cbd5e0; border-radius:6px; font-size:12px; cursor:pointer;">
                  <option value="current" ${smbAuthSetting.value === 'current' ? 'selected' : ''}>現在のサインインユーザー権限を使用 (標準)</option>
                  <option value="custom" ${smbAuthSetting.value === 'custom' ? 'selected' : ''}>別のユーザー権限（認証情報を指定）</option>
                </select>
                
                <div id="smb-custom-credentials" style="display:${smbAuthSetting.value === 'custom' ? 'flex' : 'none'}; flex-direction:column; gap:8px; margin-top:8px;">
                  <div class="form-row">
                    <label style="font-size:11px; margin-bottom:2px;">ユーザー名 (Domain\\User もしくは User)</label>
                    <input type="text" id="cfg-smb-username" placeholder="例: domain\\username" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${smbUsernameSetting.value}">
                  </div>
                  <div class="form-row">
                    <label style="font-size:11px; margin-bottom:2px;">パスワード</label>
                    <input type="password" id="cfg-smb-password" placeholder="パスワードを入力" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${smbPasswordSetting.value}">
                  </div>
                </div>
              </div>

              <div style="display:flex; gap:8px;">
                <button class="btn btn-outline btn-sm" id="btn-manual-import" style="flex:1;">
                  <i class="fas fa-sync-alt"></i> 今すぐフォルダスキャン実行
                </button>
              </div>
            </div>

            <!-- 1. ODBC接続設定 (ODBC用) -->
            <div id="odbc-conn-panel" style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0; display:${connTypeSetting.value === 'odbc' ? 'block' : 'none'};">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-database"></i> ODBC接続設定 (電子カルテDB連携)</h4>
              
              <!-- 読み取り専用安全対策の通知 -->
              <div style="margin-bottom:16px; padding:12px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; color:#166534; font-size:12px; display:flex; align-items:flex-start; gap:10px;">
                <i class="fas fa-shield-alt" style="margin-top:2px; font-size:16px; color:#15803d;"></i>
                <div>
                  <strong style="display:block; margin-bottom:4px; font-weight:600; color:#14532d;">読み取り専用安全対策モード適用中</strong>
                  <span style="font-size:11px; line-height:1.5; color:#166534; display:block;">
                    電子カルテDBの誤操作・誤書き込みを防ぐため、以下の安全フィルタが有効化されています。
                  </span>
                  <ul style="margin:6px 0 0 0; padding-left:16px; font-size:11px; color:#166534; line-height:1.5;">
                    <li>接続文字列の末尾に自動的に読み取り専用属性（<code>ReadOnly=1</code>等）が付与されます。</li>
                    <li>データ抽出クエリは<code>SELECT</code>文のみ許可され、更新・削除などのクエリは自動遮断されます。</li>
                  </ul>
                </div>
              </div>

              <!-- ODBC設定パネル -->
              <div class="odbc-settings-panel">

                <!-- ① DSN選択 -->
                <div class="odbc-section">
                  <div class="odbc-section-title"><i class="fas fa-database"></i> データソース名 (DSN)</div>
                  <div style="display:flex; gap:8px; align-items:flex-end;">
                    <div style="flex:1;">
                      <label class="odbc-label">システム/ユーザーDSN <span class="odbc-hint-inline">— Windowsに登録済みのデータソース</span></label>
                      <select id="odbc-dsn-select" class="odbc-input">
                        <option value="">⏳ 読み込み中...</option>
                      </select>
                    </div>
                    <button class="btn btn-outline btn-sm" id="btn-odbc-refresh-dsn" title="DSN一覧を再取得">
                      <i class="fas fa-sync-alt"></i>
                    </button>
                  </div>
                  <div id="odbc-dsn-driver-info" style="font-size:11px; color:#64748b; margin-top:4px; min-height:16px;"></div>

                  <details style="margin-top:8px;">
                    <summary style="font-size:11px; color:#3b82f6; cursor:pointer; user-select:none;">DSNが一覧にない場合（手動入力）</summary>
                    <div style="margin-top:6px;">
                      <label class="odbc-label">DSN名を直接入力</label>
                      <input type="text" id="odbc-dsn-manual" class="odbc-input" placeholder="例: EMR_DB">
                    </div>
                  </details>
                </div>

                <!-- ② 認証 -->
                <div class="odbc-section">
                  <div class="odbc-section-title"><i class="fas fa-key"></i> 認証</div>
                  <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    <div>
                      <label class="odbc-label">ユーザー名 (UID) <span class="odbc-hint-inline">Windows認証なら空欄</span></label>
                      <input type="text" id="odbc-wiz-user" class="odbc-input" placeholder="例: readonly_user">
                    </div>
                    <div>
                      <label class="odbc-label">パスワード (PWD) <span class="odbc-hint-inline">Windows認証なら空欄</span></label>
                      <input type="password" id="odbc-wiz-pass" class="odbc-input" placeholder="••••••••">
                    </div>
                  </div>
                </div>

                <!-- ③ 接続文字列プレビュー -->
                <div class="odbc-section">
                  <div class="odbc-section-title"><i class="fas fa-code"></i> 接続文字列 <span class="odbc-hint-inline">— 上の設定から自動生成。直接編集も可</span></div>
                  <input type="text" id="cfg-odbc-conn" class="odbc-input odbc-mono"
                    placeholder="DSN=EMR_DB;UID=user;PWD=pass;"
                    value="${odbcConnSetting.value}">
                </div>

                <!-- ④ SQLクエリ -->
                <div class="odbc-section">
                  <div class="odbc-section-title"><i class="fas fa-table"></i> データ抽出SQLクエリ</div>
                  <div style="display:flex; gap:8px; align-items:flex-end; margin-bottom:4px;">
                    <div style="flex:1;">
                      <label class="odbc-label">ビュー / テーブル名</label>
                      <div style="display:flex; gap:6px; align-items:center;">
                        <select id="odbc-wiz-table" class="odbc-input" style="flex:1;">
                          <option value="">— DSNを選択後に取得 —</option>
                        </select>
                        <button class="btn btn-outline btn-sm" id="btn-odbc-fetch-tables" title="テーブル/ビュー一覧を取得" style="white-space:nowrap; flex-shrink:0;">
                          <i class="fas fa-cloud-download-alt"></i> 取得
                        </button>
                      </div>
                      <div id="odbc-table-status" style="font-size:11px; color:#64748b; margin-top:3px; min-height:14px;"></div>
                    </div>
                    <button class="btn btn-outline btn-sm" id="btn-odbc-build-query" style="white-space:nowrap; align-self:flex-end; margin-bottom:18px;">
                      <i class="fas fa-magic"></i> SQL生成
                    </button>
                  </div>
                  <textarea id="cfg-odbc-query" rows="3" class="odbc-input odbc-mono"
                    placeholder="SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS">${odbcQuerySetting.value}</textarea>
                  <div style="font-size:11px; color:#64748b; margin-top:3px;">
                    必須カラム: <code>BED_NO</code>, <code>PATIENT_ID</code>, <code>PATIENT_NAME</code>, <code>IS_PRESENT</code>（在床=1）
                  </div>
                </div>

                <!-- ⑤ テスト・同期 -->
                <div class="odbc-section" style="border:none; padding-bottom:0;">
                  <div style="display:flex; gap:8px;">
                    <button class="btn btn-outline btn-sm" id="btn-odbc-test" style="flex:1;">
                      <i class="fas fa-vial"></i> 接続テスト
                    </button>
                    <button class="btn btn-primary btn-sm" id="btn-odbc-sync" style="flex:1;">
                      <i class="fas fa-sync"></i> 今すぐ同期
                    </button>
                  </div>
                  <div id="odbc-test-result" style="margin-top:8px; font-size:12px; min-height:18px;"></div>
                </div>

              </div>
            </div>
 
            <!-- 2. カラムマッピング (共通) -->
            <div style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0;">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-table"></i> カラムマッピング (ヘッダー名 / SQL列名)</h4>
              
              <!-- 列割り当て初期設定アシスタント -->
              <div style="background:#eff6ff; padding:12px; border-radius:8px; border:1px solid #bfdbfe; margin-bottom:12px; font-size:12px;">
                <strong style="color:#1e40af; display:block; margin-bottom:4px;"><i class="fas fa-magic"></i> 列割り当て初期設定アシスタント (CSV対応)</strong>
                <span style="color:#4b5563; display:block; margin-bottom:8px;">
                  連携用CSVファイルを読み込ませることで、ヘッダー行から列をプルダウン選択＆自動予測マッピングできます。
                </span>
                
                <div style="display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-bottom:10px;">
                  <div>
                    <input type="file" id="btn-helper-csv-file" accept=".csv" style="display:none;">
                    <button class="btn btn-outline btn-sm" id="btn-trigger-helper" style="background:#ffffff; font-weight:700; border-color:#93c5fd; color:#2563eb;">
                      <i class="fas fa-file-csv"></i> サンプルCSVを選択
                    </button>
                    <span id="helper-file-status" style="margin-left:6px; color:#4b5563; font-style:italic;">選択されていません</span>
                  </div>
                  <div style="display:flex; align-items:center; gap:4px;">
                    <span style="color:#4b5563;">文字コード:</span>
                    <select id="helper-csv-encoding" style="padding:4px; font-size:11px; border:1px solid #cbd5e0; border-radius:4px; background:#fff;">
                      <option value="shift-jis" selected>Shift-JIS (Excel標準)</option>
                      <option value="utf-8">UTF-8</option>
                    </select>
                  </div>
                </div>

                <!-- リアルタイムプレビュー＆マップ整合性検査 -->
                <div id="helper-preview-container" style="display:none; margin-top:12px; padding:10px; background:#fff; border:1px solid #d1d5db; border-radius:6px;">
                  <strong style="color:#1e3a8a; display:block; margin-bottom:6px;"><i class="fas fa-eye"></i> インポートプレビュー・整合性チェック (先頭5行)</strong>
                  <div style="overflow-x:auto;">
                    <table style="width:100%; border-collapse:collapse; font-size:11px; text-align:left; min-width:300px;" id="helper-preview-table">
                      <thead>
                        <tr style="background:#f3f4f6; border-bottom:1px solid #e5e7eb;">
                          <th style="padding:4px;">行</th>
                          <th style="padding:4px;">結合病床名</th>
                          <th style="padding:4px;">患者氏名</th>
                          <th style="padding:4px;">在床</th>
                          <th style="padding:4px;">マップ登録状況</th>
                        </tr>
                      </thead>
                      <tbody>
                        <!-- 動的生成 -->
                      </tbody>
                    </table>
                  </div>
                  <div style="font-size:10px; color:#ef4444; margin-top:6px; font-weight:700;" id="helper-preview-error-note"></div>
                </div>
              </div>

              <p style="font-size:11px; color:#718096; margin:0 0 12px 0;">取得元カラム名（またはSQL抽出列名）を指定します。病床の特定方法は【単一の列】または【病室コードと病床コードの組み合わせ】を選択できます。</p>
              
              <div class="form-row" style="margin-bottom:10px;">
                <label style="font-size:12px;">病床の特定方法</label>
                <select id="cfg-map-mode" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;">
                  <option value="single" ${(!mapping.room_code || !mapping.bed_code) ? 'selected':''}>単一のカラム (例: bed_number)</option>
                  <option value="combined" ${(mapping.room_code && mapping.bed_code) ? 'selected':''}>病室コード＋病床コードの組み合わせ</option>
                </select>
              </div>

              <!-- 単一カラム指定用 -->
              <div id="map-single-container" class="form-row" style="margin-bottom:8px; display:${(!mapping.room_code || !mapping.bed_code) ? 'flex':'none'}; align-items:center; gap:8px;">
                <label style="width:120px; font-size:12px; margin:0;">病床番号 <span style="color:#dc2626">*</span></label>
                <input type="text" id="cfg-map-bed" placeholder="bed_number" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.bed_number || ''}">
              </div>

              <!-- 複数カラム指定用 -->
              <div id="map-combined-container" style="display:${(mapping.room_code && mapping.bed_code) ? 'block':'none'};">
                <div class="form-row" style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                  <label style="width:120px; font-size:12px; margin:0;">病室コード <span style="color:#dc2626">*</span></label>
                  <input type="text" id="cfg-map-room" placeholder="room_code" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.room_code || ''}">
                </div>
                <div class="form-row" style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                  <label style="width:120px; font-size:12px; margin:0;">病床コード <span style="color:#dc2626">*</span></label>
                  <input type="text" id="cfg-map-bed-code" placeholder="bed_code" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.bed_code || ''}">
                </div>
                <div class="form-row" style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                  <label style="width:120px; font-size:12px; margin:0;">結合文字</label>
                  <select id="cfg-map-join" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;">
                    <option value="-" ${mapping.join_char==='-'?'selected':''}>ハイフン (-) (例: 701-A)</option>
                    <option value="" ${mapping.join_char===''?'selected':''}>なし (例: 701A)</option>
                    <option value="/" ${mapping.join_char==='/'?'selected':''}>スラッシュ (/) (例: 701/A)</option>
                    <option value="_" ${mapping.join_char==='_'?'selected':''}>アンダーバー (_) (例: 701_A)</option>
                  </select>
                </div>
              </div>

              <div class="form-row" style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                <label style="width:120px; font-size:12px; margin:0;">患者ID</label>
                <input type="text" id="cfg-map-pat-id" placeholder="patient_id" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.patient_id || ''}">
              </div>
              <div class="form-row" style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                <label style="width:120px; font-size:12px; margin:0;">患者氏名</label>
                <input type="text" id="cfg-map-pat-name" placeholder="patient_name" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.patient_name || ''}">
              </div>
              <div class="form-row" style="margin-bottom:0; display:flex; align-items:center; gap:8px;">
                <label style="width:120px; font-size:12px; margin:0;">在床ステータス</label>
                <input type="text" id="cfg-map-present" placeholder="is_present" style="flex:1; padding:6px; border:1px solid #cbd5e0; border-radius:4px; font-size:12px;" value="${mapping.is_present || ''}">
              </div>
            </div>

          </div>

          <!-- 右カラム：スケジュール・整理ポリシー -->
          <div style="display:flex; flex-direction:column; gap:16px;">
            
            <!-- 3. スケジュール設定 (CSV用) -->
            <div id="csv-schedule-panel" style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0; display:${connTypeSetting.value === 'csv' ? 'block' : 'none'};">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-clock"></i> 同期スケジュール</h4>
              <div class="form-row" style="margin-bottom:10px;">
                <label>実行モード</label>
                <select id="cfg-sched-mode" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;">
                  <option value="realtime" ${schedule.mode==='realtime'?'selected':''}>リアルタイム監視 (即時実行)</option>
                  <option value="interval" ${schedule.mode==='interval'?'selected':''}>定期的な自動実行 (間隔指定)</option>
                  <option value="time"     ${schedule.mode==='time'?'selected':''}>指定した時刻に実行 (複数可)</option>
                </select>
              </div>
              
              <div id="sched-interval-container" class="form-row" style="margin-bottom:0; display:${schedule.mode==='interval'?'block':'none'};">
                <label>実行間隔 (分)</label>
                <select id="cfg-sched-interval" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;">
                  <option value="1"  ${schedule.intervalMin==='1'?'selected':''}>1分ごと (デモ・開発用)</option>
                  <option value="5"  ${schedule.intervalMin==='5'?'selected':''}>5分ごと</option>
                  <option value="10" ${schedule.intervalMin==='10'?'selected':''}>10分ごと</option>
                  <option value="30" ${schedule.intervalMin==='30'?'selected':''}>30分ごと</option>
                  <option value="60" ${schedule.intervalMin==='60'?'selected':''}>1時間ごと</option>
                </select>
              </div>

              <div id="sched-time-container" class="form-row" style="margin-bottom:0; display:${schedule.mode==='time'?'block':'none'};">
                <label>実行時刻 (半角コンマ区切りで複数指定可 例: 08:30,13:00,18:00)</label>
                <input type="text" id="cfg-sched-times" placeholder="08:00, 13:00" style="width:100%; padding:8px; border:1px solid #cbd5e0; border-radius:4px;" value="${(schedule.times || []).join(', ')}">
              </div>
            </div>

            <!-- 4. 整理ポリシー (CSV用) -->
            <div id="csv-policy-panel" style="background:#f8fafc; padding:16px; border-radius:8px; border:1px solid #e2e8f0; display:${connTypeSetting.value === 'csv' ? 'block' : 'none'};">
              <h4 style="margin:0 0 10px 0; font-size:14px; color:#2d3748;"><i class="fas fa-shield-alt"></i> 個人情報保護・整理ポリシー</h4>
              <div class="form-row" style="margin-bottom:10px;">
                <label>処理完了後のファイル処理</label>
                <select id="cfg-policy-action" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;">
                  <option value="archive" ${policy.action==='archive'?'selected':''}>archiveフォルダに退避して保管</option>
                  <option value="delete"  ${policy.action==='delete'?'selected':''}>インポート後に即時物理削除 (推奨・高セキュリティ)</option>
                  <option value="skip"    ${policy.action==='skip'?'selected':''}>そのまま残す (移動・削除しない / 権限エラー回避)</option>
                </select>
              </div>

              <div id="policy-skip-warn" style="margin:0 0 10px 0; font-size:12px; color:#744210; background:#fffbeb; border:1px solid #f6ad55; border-radius:4px; padding:6px 8px; display:${policy.action==='skip'?'block':'none'};">
                ⚠️ 取り込み済みの CSV ファイルが監視フォルダに蓄積し続けます。定期的な手動整理が必要です。
              </div>

              <div id="policy-days-container" class="form-row" style="margin-bottom:10px; display:${policy.action==='archive'?'block':'none'};">
                <label>退避ファイルの保管期間</label>
                <select id="cfg-policy-days" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;">
                  <option value="7"  ${policy.retentionDays==='7'?'selected':''}>7日間 (1週間)</option>
                  <option value="30" ${policy.retentionDays==='30'?'selected':''}>30日間 (約1ヶ月)</option>
                  <option value="90" ${policy.retentionDays==='90'?'selected':''}>90日間 (約3ヶ月)</option>
                  <option value="0"  ${policy.retentionDays==='0'?'selected':''}>無期限 (手動クリーンアップ)</option>
                </select>
                <p style="margin:6px 0 0 0; font-size:12px; color:#c53030; background:#fff5f5; border:1px solid #feb2b2; border-radius:4px; padding:6px 8px;">
                  ⚠️ archiveフォルダ内のCSVファイルには患者氏名・IDが平文のまま保管されます。保管期間中は暗号化されません。
                  ${archiveInfo.exists ? `現在 <strong>${archiveInfo.count}件</strong> のファイルが保管されています。` : ''}
                </p>
              </div>

              <div class="form-row" style="margin-bottom:0;">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:normal;">
                  <input type="checkbox" id="cfg-policy-clear-unlisted" ${policy.clearUnlisted?'checked':''} style="width:16px; height:16px; cursor:pointer;">
                  CSVに載っていない病床の患者情報を空床にする
                </label>
                <p style="margin:4px 0 0 24px; font-size:12px; color:#718096;">在室患者のみ出力するEMRを使用している場合はONにしてください。CSVに行が存在しない病床を退院済みとみなして自動的にクリアします。</p>
                <p id="cfg-clear-unlisted-warn" style="margin:6px 0 0 24px; font-size:12px; color:#c53030; background:#fff5f5; border:1px solid #feb2b2; border-radius:4px; padding:6px 8px; display:${policy.clearUnlisted?'block':'none'};">
                  ⚠️ 注意: CSVが空だった場合や全行がスキップされた場合でも、掲載されていない病床の患者情報がクリアされます（空CSV時は自動でスキップします）。移送進行中の患者は保護されます。
                </p>
              </div>
            </div>

          </div>
        </div>

        <!-- 表示オプション -->
        <div style="margin-top:20px; padding:14px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;">
          <div style="font-weight:700; font-size:13px; color:#2d3748; margin-bottom:12px;">
            <i class="fas fa-eye"></i> ヘッダー表示オプション
          </div>
          <div style="display:flex; gap:24px; flex-wrap:wrap;">
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; color:#374151;">
              <input type="checkbox" id="cfg-show-sync-time" style="width:16px; height:16px; cursor:pointer;" ${showSyncTime ? 'checked' : ''}>
              最終同期時間を表示する
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; color:#374151;">
              <input type="checkbox" id="cfg-show-import-time" style="width:16px; height:16px; cursor:pointer;" ${showImportTime ? 'checked' : ''}>
              最終データ取り込み時間を表示する
            </label>
          </div>
          <div style="font-size:11px; color:#94a3b8; margin-top:8px;">画面上部ヘッダーに表示する時刻情報を切り替えます。</div>
        </div>

        <div style="margin-top:16px; display:flex; justify-content:flex-end;">
          <button class="btn btn-primary" id="btn-save-import-all" style="padding:10px 24px; font-weight:700;">
            <i class="fas fa-save"></i> 連携設定を保存
          </button>
        </div>

        <!-- 5. 直近の取り込みログ一覧 -->
        <div style="margin-top:30px; border-top: 1px solid #e2e8f0; padding-top:20px;">
          <h4 style="margin:0 0 12px 0; font-size:15px; color:#2d3748;"><i class="fas fa-history"></i> 直近の自動インポート履歴</h4>
          <table class="settings-table" style="font-size:12px; width:100%;">
            <thead>
              <tr><th style="width:130px;">日時</th><th>ファイル名</th><th style="width:80px;">状態</th><th>内容</th><th>詳細結果</th></tr>
            </thead>
            <tbody>
              ${logRowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // 連携方式選択変更イベント
    const connRadios = body.querySelectorAll('input[name="import-conn-type"]');
    connRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        const isCsv = e.target.value === 'csv';
        document.getElementById('csv-folder-panel').style.display = isCsv ? 'block' : 'none';
        document.getElementById('csv-schedule-panel').style.display = isCsv ? 'block' : 'none';
        document.getElementById('csv-policy-panel').style.display = isCsv ? 'block' : 'none';
        document.getElementById('odbc-conn-panel').style.display = isCsv ? 'none' : 'block';
      });
    });

    // 今すぐフォルダスキャン実行ボタンイベント
    document.getElementById('btn-manual-import').onclick = async () => {
      const btn = document.getElementById('btn-manual-import');
      btn.disabled = true;
      const oldHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> スキャン中...';
      try {
        if (window.electronAPI && window.electronAPI.triggerManualImport) {
          const res = await window.electronAPI.triggerManualImport();
          if (res.success) {
            if (res.count > 0) {
              UI.toast(`📂 ${res.message}`, 'success');
            } else {
              UI.toast(`📂 ${res.message}`, 'info');
            }
            await App.loadMasters();
            this.render();
          } else {
            UI.toast(`❌ スキャンに失敗しました: ${res.message}`, 'danger');
          }
        } else {
          UI.toast('デスクトップ環境でのみ実行可能です', 'warning');
        }
      } catch (e) {
        UI.toast(`エラーが発生しました: ${e.message}`, 'danger');
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    };

    // ── DSN一覧を取得してドロップダウンに反映 ────────────────
    const _loadDsnList = async () => {
      const sel = document.getElementById('odbc-dsn-select');
      if (!sel) return;
      sel.innerHTML = '<option value="">⏳ 読み込み中...</option>';
      try {
        const data = window.electronAPI?.getOdbcDsns
          ? await window.electronAPI.getOdbcDsns()
          : { system: [], user: [], drivers: [] };

        const opts = ['<option value="">— DSNを選択 —</option>'];
        if (data.system.length) {
          opts.push('<optgroup label="システムDSN">');
          data.system.forEach(d => opts.push(`<option value="${d.name}" data-driver="${d.driver}">[SYS] ${d.name}（${d.driver}）</option>`));
          opts.push('</optgroup>');
        }
        if (data.user.length) {
          opts.push('<optgroup label="ユーザーDSN">');
          data.user.forEach(d => opts.push(`<option value="${d.name}" data-driver="${d.driver}">[USER] ${d.name}（${d.driver}）</option>`));
          opts.push('</optgroup>');
        }
        if (!data.system.length && !data.user.length) {
          opts.push('<option value="" disabled>DSNが見つかりませんでした</option>');
        }
        sel.innerHTML = opts.join('');

        // 現在の接続文字列からDSN名を復元して選択状態にする
        const currentConn = document.getElementById('cfg-odbc-conn')?.value || '';
        const m = currentConn.match(/DSN=([^;]+)/i);
        if (m) {
          const currentDsn = m[1].trim();
          const found = [...sel.options].find(o => o.value === currentDsn);
          if (found) sel.value = currentDsn;
        }
        _onDsnChange();
      } catch (e) {
        sel.innerHTML = '<option value="">取得失敗 — 手動入力を使用してください</option>';
      }
    };

    const _onDsnChange = () => {
      const sel = document.getElementById('odbc-dsn-select');
      const info = document.getElementById('odbc-dsn-driver-info');
      const selected = sel?.options[sel.selectedIndex];
      const driver = selected?.dataset?.driver || '';
      if (info) info.textContent = driver ? `ドライバ: ${driver}` : '';
      _rebuildConnStr();
    };

    const _rebuildConnStr = () => {
      const selVal    = document.getElementById('odbc-dsn-select')?.value || '';
      const manualVal = document.getElementById('odbc-dsn-manual')?.value?.trim() || '';
      const dsn  = selVal || manualVal;
      const user = document.getElementById('odbc-wiz-user')?.value?.trim() || '';
      const pass = document.getElementById('odbc-wiz-pass')?.value || '';
      if (!dsn) return;
      const parts = [`DSN=${dsn}`];
      if (user) { parts.push(`UID=${user}`); parts.push(`PWD=${pass}`); }
      else parts.push('Trusted_Connection=Yes');
      parts.push('ReadOnly=1');
      const el = document.getElementById('cfg-odbc-conn');
      if (el) el.value = parts.join(';') + ';';
    };

    document.getElementById('odbc-dsn-select')?.addEventListener('change', _onDsnChange);
    document.getElementById('odbc-dsn-manual')?.addEventListener('input', _rebuildConnStr);
    document.getElementById('odbc-wiz-user')?.addEventListener('input', _rebuildConnStr);
    document.getElementById('odbc-wiz-pass')?.addEventListener('input', _rebuildConnStr);

    document.getElementById('btn-odbc-refresh-dsn')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-odbc-refresh-dsn');
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      await _loadDsnList();
      btn.innerHTML = '<i class="fas fa-sync-alt"></i>';
    });

    // SQL生成ボタン
    document.getElementById('btn-odbc-build-query')?.addEventListener('click', () => {
      const table = _getSelectedTable() || 'V_BED_STATUS';
      const q = document.getElementById('cfg-odbc-query');
      if (q) q.value = `SELECT BED_NO AS bed_number, PATIENT_ID AS patient_id, PATIENT_NAME AS patient_name, IS_PRESENT AS is_present FROM ${table}`;
      // カラムマッピングも自動設定
      const mapMode = document.getElementById('cfg-map-mode');
      if (mapMode) { mapMode.value = 'single'; document.getElementById('map-single-container').style.display='flex'; document.getElementById('map-combined-container').style.display='none'; }
      if (document.getElementById('cfg-map-bed'))      document.getElementById('cfg-map-bed').value = 'bed_number';
      if (document.getElementById('cfg-map-pat-id'))   document.getElementById('cfg-map-pat-id').value = 'patient_id';
      if (document.getElementById('cfg-map-pat-name')) document.getElementById('cfg-map-pat-name').value = 'patient_name';
      if (document.getElementById('cfg-map-present'))  document.getElementById('cfg-map-present').value = 'is_present';
      Settings.updateImportPreview();
      UI.toast('SQL・カラムマッピングを反映しました。保存ボタンで確定してください。', 'success');
    });

    // テーブル/ビュー一覧を取得してドロップダウンに反映
    const _loadTableList = async () => {
      const connStr = document.getElementById('cfg-odbc-conn')?.value?.trim();
      const sel     = document.getElementById('odbc-wiz-table');
      const status  = document.getElementById('odbc-table-status');
      const btn     = document.getElementById('btn-odbc-fetch-tables');
      if (!connStr) { UI.toast('先に接続文字列を設定してください', 'warning'); return; }

      const prevVal = sel?.value;
      if (btn)    { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
      if (status) status.textContent = '取得中...';
      if (sel)    sel.innerHTML = '<option value="">取得中...</option>';

      try {
        const res = window.electronAPI?.getOdbcTables
          ? await window.electronAPI.getOdbcTables({ connectionString: connStr })
          : { success: false, error: 'デスクトップ環境が必要です', tables: [] };

        if (!res.success) {
          if (sel)    sel.innerHTML = '<option value="">取得失敗 — 手動入力</option><option value="__manual__">手動で入力...</option>';
          if (status) status.innerHTML = `<span style="color:#dc2626;"><i class="fas fa-times-circle"></i> ${UI.escapeHTML(res.error)}</span>`;
          return;
        }

        const views  = res.tables.filter(t => t.type === 'VIEW');
        const tables = res.tables.filter(t => t.type === 'TABLE' || t.type === 'SYSTEM TABLE');
        const opts   = ['<option value="">— 選択 —</option>'];
        if (views.length)  { opts.push('<optgroup label="ビュー">');  views.forEach(t => opts.push(`<option value="${UI.escapeHTML(t.name)}">${UI.escapeHTML(t.name)}</option>`));  opts.push('</optgroup>'); }
        if (tables.length) { opts.push('<optgroup label="テーブル">'); tables.forEach(t => opts.push(`<option value="${UI.escapeHTML(t.name)}">${UI.escapeHTML(t.name)}</option>`)); opts.push('</optgroup>'); }
        opts.push('<option value="__manual__">手動で入力...</option>');
        if (sel) {
          sel.innerHTML = opts.join('');
          if (prevVal && [...sel.options].some(o => o.value === prevVal)) sel.value = prevVal;
        }
        if (status) status.innerHTML = `<span style="color:#16a34a;"><i class="fas fa-check-circle"></i> ${res.tables.length} 件取得（ビュー ${views.length} / テーブル ${tables.length}）</span>`;
      } catch (e) {
        if (sel)    sel.innerHTML = '<option value="">エラー</option>';
        if (status) status.innerHTML = `<span style="color:#dc2626;">${UI.escapeHTML(e.message)}</span>`;
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> 取得'; }
      }
    };

    document.getElementById('btn-odbc-fetch-tables')?.addEventListener('click', _loadTableList);

    // 「手動で入力...」選択時に入力欄を表示
    document.getElementById('odbc-wiz-table')?.addEventListener('change', (e) => {
      const manualArea = document.getElementById('odbc-table-manual-area');
      if (e.target.value === '__manual__') {
        if (!manualArea) {
          const div = document.createElement('div');
          div.id = 'odbc-table-manual-area';
          div.style.marginTop = '4px';
          div.innerHTML = '<input type="text" id="odbc-table-manual-input" class="odbc-input" placeholder="テーブル/ビュー名を入力">';
          e.target.parentNode.after(div);
          div.querySelector('input').focus();
        }
      } else {
        manualArea?.remove();
      }
    });

    // SQL生成ボタン — selectとmanual inputの両方に対応
    const _getSelectedTable = () => {
      const sel = document.getElementById('odbc-wiz-table');
      if (sel?.value === '__manual__') {
        return document.getElementById('odbc-table-manual-input')?.value?.trim() || '';
      }
      return sel?.value || '';
    };

    // DSN一覧を初回ロード
    _loadDsnList();

    // ODBC接続テストボタンイベント
    document.getElementById('btn-odbc-test').onclick = async () => {
      const btn = document.getElementById('btn-odbc-test');
      const resultEl = document.getElementById('odbc-test-result');
      btn.disabled = true;
      const oldHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 接続テスト中...';
      if (resultEl) resultEl.innerHTML = '';
      try {
        const conn = document.getElementById('cfg-odbc-conn').value.trim();
        const query = document.getElementById('cfg-odbc-query').value.trim();
        if (window.electronAPI && window.electronAPI.testOdbcConnection) {
          const res = await window.electronAPI.testOdbcConnection({ connectionString: conn, sqlQuery: query });
          if (res.success) {
            if (resultEl) resultEl.innerHTML = `<span style="color:#16a34a;font-weight:700;"><i class="fas fa-check-circle"></i> ${UI.escapeHTML(res.message)}</span>`;
            UI.toast('ODBC接続テスト成功', 'success');
          } else {
            if (resultEl) resultEl.innerHTML = `<span style="color:#dc2626;font-weight:700;"><i class="fas fa-times-circle"></i> ${UI.escapeHTML(res.message)}</span>`;
            UI.toast(`接続失敗: ${res.message}`, 'danger');
          }
        } else {
          if (resultEl) resultEl.innerHTML = '<span style="color:#d97706;">デスクトップ環境でのみ実行可能です</span>';
        }
      } catch (e) {
        if (resultEl) resultEl.innerHTML = `<span style="color:#dc2626;">${UI.escapeHTML(e.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    };

    // ODBC同期実行ボタンイベント
    document.getElementById('btn-odbc-sync').onclick = async () => {
      const btn = document.getElementById('btn-odbc-sync');
      btn.disabled = true;
      const oldHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 同期実行中...';
      try {
        const conn = document.getElementById('cfg-odbc-conn').value.trim();
        const query = document.getElementById('cfg-odbc-query').value.trim();
        if (window.electronAPI && window.electronAPI.runOdbcSync) {
          const res = await window.electronAPI.runOdbcSync({ connectionString: conn, sqlQuery: query });
          if (res.success) {
            UI.toast(`✅ データベース同期が完了しました (${res.count}件のレコードを処理)`, 'success');
            await App.loadMasters();
            await App.refreshData();
            this.render();
          } else {
            UI.toast(`❌ 同期失敗: ${res.message}`, 'danger');
          }
        } else {
          UI.toast('デスクトップ環境でのみ実行可能です', 'warning');
        }
      } catch (e) {
        UI.toast(`エラー: ${e.message}`, 'danger');
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    };

    // UI要素のイベントバインド（条件表示切替）
    const modeSelect = document.getElementById('cfg-sched-mode');
    modeSelect.addEventListener('change', (e) => {
      document.getElementById('sched-interval-container').style.display = e.target.value === 'interval' ? 'block' : 'none';
      document.getElementById('sched-time-container').style.display = e.target.value === 'time' ? 'block' : 'none';
    });

    const policySelect = document.getElementById('cfg-policy-action');
    policySelect.addEventListener('change', (e) => {
      document.getElementById('policy-days-container').style.display = e.target.value === 'archive' ? 'block' : 'none';
      document.getElementById('policy-skip-warn').style.display = e.target.value === 'skip' ? 'block' : 'none';
    });

    document.getElementById('cfg-policy-clear-unlisted')?.addEventListener('change', (e) => {
      document.getElementById('cfg-clear-unlisted-warn').style.display = e.target.checked ? 'block' : 'none';
    });

    const smbModeSelect = document.getElementById('cfg-smb-auth-mode');
    if (smbModeSelect) {
      smbModeSelect.addEventListener('change', (e) => {
        document.getElementById('smb-custom-credentials').style.display = e.target.value === 'custom' ? 'block' : 'none';
      });
    }

    // 列割り当て初期設定アシスタント（CSV読み込み＆プルダウン化）
    const triggerBtn = document.getElementById('btn-trigger-helper');
    const fileInput = document.getElementById('btn-helper-csv-file');
    const fileStatus = document.getElementById('helper-file-status');
    const encodingSelect = document.getElementById('helper-csv-encoding');
    
    if (triggerBtn && fileInput) {
      let helperFile = null;
      triggerBtn.onclick = () => fileInput.click();
      
      const isUtf8 = (buf) => {
        let i = 0;
        while (i < buf.length) {
          if (buf[i] <= 0x7F) {
            i += 1;
          } else if ((buf[i] & 0xE0) === 0xC0) {
            if (i + 1 >= buf.length || (buf[i + 1] & 0xC0) !== 0x80) return false;
            i += 2;
          } else if ((buf[i] & 0xF0) === 0xE0) {
            if (i + 2 >= buf.length || (buf[i + 1] & 0xC0) !== 0x80 || (buf[i + 2] & 0xC0) !== 0x80) return false;
            i += 3;
          } else if ((buf[i] & 0xF8) === 0xF0) {
            if (i + 3 >= buf.length || (buf[i + 1] & 0xC0) !== 0x80 || (buf[i + 2] & 0xC0) !== 0x80 || (buf[i + 3] & 0xC0) !== 0x80) return false;
            i += 4;
          } else {
            return false;
          }
        }
        return true;
      };

      const processHelperFile = (file, skipAutoDetect = false) => {
        if (!file) return;
        fileStatus.textContent = file.name;

        const runReader = (encoding) => {
          const reader = new FileReader();
          reader.onload = (evt) => {
            const text = evt.target.result;
            const lines = text.split(/\r?\n/);
            if (lines.length === 0 || !lines[0]) {
              UI.toast('ファイルが空か、正しい形式ではありません', 'warning');
              return;
            }
            
            // ヘッダーパース（カンマ分割）
            const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim()).filter(Boolean);
            if (headers.length === 0) {
              UI.toast('ヘッダー列が検出されませんでした', 'warning');
              return;
            }
            
            UI.toast(`📂 CSVから ${headers.length} 個の列名を検出しました。`, 'success');
            
            // CSVデータ行をオブジェクト配列にパースして保持
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
              if (!lines[i].trim()) continue;
              const rowValues = lines[i].split(',').map(v => v.replace(/^"|"$/g, '').trim());
              const rowObj = {};
              headers.forEach((h, colIdx) => {
                rowObj[h] = rowValues[colIdx] || '';
              });
              rows.push(rowObj);
            }
            Settings._csvDataRows = rows;
          
          // 入力要素をセレクトボックスに動的置換
          const replaceInputWithSelect = (inputId, curVal) => {
            const input = document.getElementById(inputId);
            if (!input) return;
            
            const parent = input.parentElement;
            let select;
            if (input.tagName === 'SELECT') {
              select = input;
            } else {
              select = document.createElement('select');
              select.id = inputId;
              select.style.cssText = input.style.cssText;
              select.style.width = '100%';
              select.style.padding = '6px';
              select.style.border = '1px solid #cbd5e0';
              select.style.borderRadius = '4px';
              select.style.fontSize = '12px';
              select.className = input.className;
              parent.replaceChild(select, input);
            }
            
            let optHtml = `<option value="">-- マッピングしない --</option>`;
            headers.forEach(h => {
              optHtml += `<option value="${h}" ${h === curVal ? 'selected' : ''}>${h}</option>`;
            });
            optHtml += `<option value="__custom__">その他 (直接入力)</option>`;
            if (curVal && !headers.includes(curVal)) {
              optHtml += `<option value="${curVal}" selected>${curVal} (保存された値)</option>`;
            }
            select.innerHTML = optHtml;
            
            select.onchange = (ev) => {
              if (ev.target.value === '__custom__') {
                const txtInput = document.createElement('input');
                txtInput.type = 'text';
                txtInput.id = inputId;
                txtInput.style.cssText = select.style.cssText;
                txtInput.className = select.className;
                txtInput.placeholder = '直接列名を入力';
                select.parentElement.replaceChild(txtInput, select);
                txtInput.oninput = () => Settings.updateImportPreview();
              } else {
                Settings.updateImportPreview();
              }
            };
          };

          replaceInputWithSelect('cfg-map-bed', mapping.bed_number);
          replaceInputWithSelect('cfg-map-room', mapping.room_code);
          replaceInputWithSelect('cfg-map-bed-code', mapping.bed_code);
          replaceInputWithSelect('cfg-map-pat-id', mapping.patient_id);
          replaceInputWithSelect('cfg-map-pat-name', mapping.patient_name);
          replaceInputWithSelect('cfg-map-present', mapping.is_present);
          
          // 自動予測マッピング
          const autoMatchColumn = (selectId, keywords) => {
            const select = document.getElementById(selectId);
            if (!select || select.tagName !== 'SELECT') return;
            for (const h of headers) {
              const lowerH = h.toLowerCase();
              for (const kw of keywords) {
                if (lowerH.includes(kw.toLowerCase())) {
                  select.value = h;
                  return;
                }
              }
            }
          };

          autoMatchColumn('cfg-map-bed', ['bed', 'bed_number', 'ベッド', '病床', '病床番号', '床番号']);
          autoMatchColumn('cfg-map-room', ['room', 'room_code', '病室', '部屋コード']);
          autoMatchColumn('cfg-map-bed-code', ['bed_code', 'bedcode', 'ベッドコード', '床コード']);
          autoMatchColumn('cfg-map-pat-id', ['patient_id', 'id', '患者id', '患者番号', '患者コード']);
          autoMatchColumn('cfg-map-pat-name', ['patient_name', 'name', '氏名', '名前', '患者名', '患者氏名']);
          autoMatchColumn('cfg-map-present', ['is_present', 'present', 'status', '在床', '在床フラグ', '在床区分']);
          
          // プレビューの更新
          Settings.updateImportPreview();
        };

        reader.readAsText(file, encoding);
      };

      if (skipAutoDetect) {
          const encoding = encodingSelect ? encodingSelect.value : 'shift-jis';
          runReader(encoding);
        } else {
          const detectReader = new FileReader();
          detectReader.onload = (evt) => {
            const arrBuf = evt.target.result;
            const uint8 = new Uint8Array(arrBuf);
            const isUtf = isUtf8(uint8);
            const resolvedEncoding = isUtf ? 'utf-8' : 'shift-jis';
            if (encodingSelect) {
              encodingSelect.value = resolvedEncoding;
            }
            runReader(resolvedEncoding);
          };
          detectReader.readAsArrayBuffer(file);
        }
      };

      fileInput.onchange = (e) => {
        helperFile = e.target.files[0];
        if (helperFile) processHelperFile(helperFile, false);
      };

      if (encodingSelect) {
        encodingSelect.onchange = () => {
          if (helperFile) processHelperFile(helperFile, true);
        };
      }
    }

    const mapModeSelect = document.getElementById('cfg-map-mode');
    mapModeSelect.addEventListener('change', (e) => {
      document.getElementById('map-single-container').style.display = e.target.value === 'single' ? 'flex' : 'none';
      document.getElementById('map-combined-container').style.display = e.target.value === 'combined' ? 'block' : 'none';
      Settings.updateImportPreview();
    });

    const mapJoinSelect = document.getElementById('cfg-map-join');
    if (mapJoinSelect) {
      mapJoinSelect.addEventListener('change', () => {
        Settings.updateImportPreview();
      });
    }

    // 在室管理モードカード選択イベント
    body.querySelectorAll('.admission-mode-card').forEach(card => {
      card.addEventListener('click', () => {
        const colors = { csv: '#3b82f6', manual: '#16a34a', hybrid: '#7c3aed' };
        body.querySelectorAll('.admission-mode-card').forEach(c => {
          const m = c.dataset.mode;
          c.style.borderColor = '#e2e8f0';
          c.style.background = '#fafafa';
          c.querySelector('input').checked = false;
        });
        const m = card.dataset.mode;
        card.style.borderColor = colors[m];
        card.style.background = colors[m] + '14';
        card.querySelector('input').checked = true;
      });
    });

    // 在室管理モード保存
    document.getElementById('btn-save-admission-mode').onclick = async () => {
      const selected = body.querySelector('input[name="admission-mode"]:checked')?.value || 'csv';
      try {
        await API.patch('system_settings', 'admission_mode', { value: selected });
        const rec = AppState.systemSettings?.find(s => s.id === 'admission_mode');
        if (rec) rec.value = selected;
        else AppState.systemSettings?.push({ id: 'admission_mode', value: selected });
        const labels = { csv: 'CSV連携モード', manual: '手動登録モード', hybrid: 'ハイブリッドモード' };
        UI.toast(`在室管理モードを「${labels[selected]}」に変更しました`, 'success');
      } catch (e) {
        UI.toast('保存に失敗しました: ' + e.message, 'danger');
      }
    };

    // 保存ボタンイベント
    document.getElementById('btn-save-import-all').onclick = async () => {
      const saveBtn = document.getElementById('btn-save-import-all');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';

      const pathInput = document.getElementById('cfg-import-path');
      const newPath = pathInput.value.trim();

      const selectedConnType = body.querySelector('input[name="import-conn-type"]:checked').value;
      const odbcConnVal = document.getElementById('cfg-odbc-conn').value.trim();
      const odbcQueryVal = document.getElementById('cfg-odbc-query').value.trim();
      const showSyncTimeVal = document.getElementById('cfg-show-sync-time').checked ? 'true' : 'false';
      const showImportTimeVal = document.getElementById('cfg-show-import-time').checked ? 'true' : 'false';

      const smbAuthMode = document.getElementById('cfg-smb-auth-mode').value;
      const smbUsername = document.getElementById('cfg-smb-username').value.trim();
      const smbPassword = document.getElementById('cfg-smb-password').value;

      // マッピング構築
      const mapMode = mapModeSelect.value;
      const mappingData = {
        bed_number: mapMode === 'single' ? document.getElementById('cfg-map-bed').value.trim() : '',
        room_code: mapMode === 'combined' ? document.getElementById('cfg-map-room').value.trim() : '',
        bed_code: mapMode === 'combined' ? document.getElementById('cfg-map-bed-code').value.trim() : '',
        join_char: mapMode === 'combined' ? document.getElementById('cfg-map-join').value : '-',
        patient_id: document.getElementById('cfg-map-pat-id').value.trim(),
        patient_name: document.getElementById('cfg-map-pat-name').value.trim(),
        is_present: document.getElementById('cfg-map-present').value.trim(),
        encoding: document.getElementById('helper-csv-encoding')?.value || 'shift-jis',
      };

      if (mapMode === 'single' && !mappingData.bed_number) {
        UI.toast('単一カラム指定の場合、「病床番号」は必須項目です。', 'warning');
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 連携設定を保存';
        return;
      }
      if (mapMode === 'combined' && (!mappingData.room_code || !mappingData.bed_code)) {
        UI.toast('組み合わせ指定の場合、「病室コード」と「病床コード」は必須項目です。', 'warning');
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 連携設定を保存';
        return;
      }

      // スケジュール構築
      const scheduleMode = modeSelect.value;
      const intervalMin = document.getElementById('cfg-sched-interval').value;
      const timesStr = document.getElementById('cfg-sched-times').value;
      const timesArray = timesStr.split(',').map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));
      
      if (scheduleMode === 'time' && timesArray.length === 0) {
        UI.toast('「時刻指定モード」の時は有効な時刻(例: 08:30)を1つ以上入力してください。', 'warning');
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 連携設定を保存';
        return;
      }

      const scheduleData = {
        mode: scheduleMode,
        intervalMin: intervalMin,
        times: timesArray
      };

      // ポリシー構築
      const policyAction = policySelect.value;
      const retentionDays = document.getElementById('cfg-policy-days').value;
      const clearUnlisted = document.getElementById('cfg-policy-clear-unlisted')?.checked ?? false;

      const policyData = {
        action: policyAction,
        retentionDays: retentionDays,
        clearUnlisted: clearUnlisted
      };

      try {
        const promises = [
          API.patch('system_settings', 'import_directory', { value: newPath }),
          API.patch('system_settings', 'import_mapping', { value: JSON.stringify(mappingData) }),
          API.patch('system_settings', 'import_schedule', { value: JSON.stringify(scheduleData) }),
          API.patch('system_settings', 'import_retention_policy', { value: JSON.stringify(policyData) }),
          API.patch('system_settings', 'import_connection_type', { value: selectedConnType }),
          API.patch('system_settings', 'odbc_connection_string', { value: odbcConnVal }),
          API.patch('system_settings', 'odbc_sql_query', { value: odbcQueryVal }),
          API.patch('system_settings', 'smb_auth_mode', { value: smbAuthMode }),
          API.patch('system_settings', 'smb_username', { value: smbUsername }),
          API.patch('system_settings', 'smb_password', { value: smbPassword }),
          API.patch('system_settings', 'show_sync_time', { value: showSyncTimeVal }),
          API.patch('system_settings', 'show_import_time', { value: showImportTimeVal }),
        ];

        await Promise.all(promises);

        // AppStateのキャッシュも更新
        const updateSetting = (id, val) => {
          const obj = AppState.systemSettings?.find(s => s.id === id);
          if (obj) obj.value = val;
          else AppState.systemSettings.push({ id, value: val });
        };
        updateSetting('smb_auth_mode', smbAuthMode);
        updateSetting('smb_username', smbUsername);
        updateSetting('smb_password', smbPassword);
        updateSetting('show_sync_time', showSyncTimeVal);
        updateSetting('show_import_time', showImportTimeVal);

        // メインプロセスへ変更通知（監視先およびトリガーを再設定）
        if (window.electronAPI && window.electronAPI.updateWatchDirectory) {
          await window.electronAPI.updateWatchDirectory(newPath);
        }

        UI.toast('連携設定を保存しました。監視フォルダ・ポリシーは即時反映されます。スケジュール変更は次の検知タイミングから有効です。', 'success', 6000);
        
        await App.loadMasters();
        this.render();
      } catch (err) {
        console.error(err);
        UI.toast('設定の保存に失敗しました: ' + err.message, 'danger');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 連携設定を保存';
      }
    };
  },

  // ──────────────────────────────────
  //  通知音設定管理
  // ──────────────────────────────────
  _renderNotificationSettings(body) {
    const isChildMode = localStorage.getItem('cfg_share_mode') === 'client';

    // 通知音設定
    let soundSettings = {
      PICKUP_REQUIRED: { enabled: true,  sound: 'alarm', toast: true },
      NEARLY_DONE:     { enabled: true,  sound: 'chime', toast: true },
      SOON:            { enabled: true,  sound: 'chime', toast: true },
      DEPART_REGISTERED: { enabled: false, sound: 'ding', toast: true },
      MOVING:          { enabled: false, sound: 'ding', toast: true },
      ARRIVED:         { enabled: false, sound: 'ding', toast: true },
      IN_EXAM:         { enabled: false, sound: 'ding', toast: true },
      RETURNED:        { enabled: false, sound: 'ding', toast: true },
    };
    const localSoundsRaw = isChildMode ? localStorage.getItem('tbs_notification_sounds') : null;
    if (localSoundsRaw) {
      try { soundSettings = { ...soundSettings, ...JSON.parse(localSoundsRaw) }; } catch(e) {}
    } else {
      const rec = AppState.systemSettings?.find(s => s.id === 'notification_sounds');
      if (rec?.value) try { soundSettings = { ...soundSettings, ...JSON.parse(rec.value) }; } catch(e) {}
    }

    // 着信音
    const incomingRingSound = isChildMode
      ? (localStorage.getItem('tbs_incoming_ring_sound') || 'ring')
      : (AppState.systemSettings?.find(s => s.id === 'incoming_ring_sound')?.value || 'ring');

    // 音量
    const localVol = isChildMode ? localStorage.getItem('tbs_notification_volume') : null;
    const volume = localVol !== null
      ? parseInt(localVol, 10)
      : parseInt(AppState.systemSettings?.find(s => s.id === 'notification_volume')?.value || '80', 10);

    // ミュート設定
    let muteCfg = { enabled: false, start: '22:00', end: '06:00' };
    const localMute = isChildMode ? localStorage.getItem('tbs_notification_mute') : null;
    if (localMute) { try { muteCfg = JSON.parse(localMute); } catch(e) {} }
    else {
      const rec = AppState.systemSettings?.find(s => s.id === 'notification_mute');
      if (rec?.value) try { muteCfg = JSON.parse(rec.value); } catch(e) {}
    }

    // スキャン音
    const localScan = isChildMode ? localStorage.getItem('tbs_notification_scan_sound') : null;
    const scanEnabled = localScan !== null
      ? localScan !== 'false'
      : AppState.systemSettings?.find(s => s.id === 'notification_scan_sound')?.value !== 'false';

    // OS通知
    const localOs = isChildMode ? localStorage.getItem('tbs_notification_os') : null;
    const osEnabled = localOs !== null
      ? localOs === 'true'
      : AppState.systemSettings?.find(s => s.id === 'notification_os')?.value === 'true';

    // インポートトースト
    const importToastEnabled = AppState.systemSettings?.find(s => s.id === 'notification_import_toast')?.value !== 'false';

    const items = [
      { key: 'PICKUP_REQUIRED',   label: '迎え要（検査終了によるお迎え要請）',        defaultSound: 'alarm' },
      { key: 'NEARLY_DONE',       label: 'あと10分（検査終了見込み10分前）',           defaultSound: 'chime' },
      { key: 'SOON',              label: 'お迎え5分前（登録済みお迎え時刻の5分前）',    defaultSound: 'chime' },
      { key: 'DEPART_REGISTERED', label: '出棟登録済（移送イベント新規登録時）',        defaultSound: 'ding' },
      { key: 'MOVING',            label: '移動中（出棟開始など移送が動き出したとき）',  defaultSound: 'ding' },
      { key: 'ARRIVED',           label: '到着（患者が検査室に到着したとき）',          defaultSound: 'ding' },
      { key: 'IN_EXAM',           label: '検査中（患者の検査が開始されたとき）',        defaultSound: 'ding' },
      { key: 'RETURNED',          label: '帰棟済（移送が完了したとき）',               defaultSound: 'ding' },
    ];

    const SOUND_OPTIONS = [
      { value: 'alarm',        label: '🚨 アラーム（警告3連打）' },
      { value: 'urgent',       label: '🔴 緊急アラーム（連続5回）' },
      { value: 'chime',        label: '🔔 チャイム（ドミソ）' },
      { value: 'double-chime', label: '🔔🔔 ダブルチャイム' },
      { value: 'fanfare',      label: '🎺 ファンファーレ' },
      { value: 'ding',         label: '🎵 サイン音（ピン）' },
      { value: 'beep',         label: '📳 ビープ（×2）' },
      { value: 'soft',         label: '🌙 ソフトトーン（穏やか）' },
    ];
    const makeSoundSelect = (selectedValue, cls, key) =>
      `<select class="${cls}" data-key="${key}" style="width:100%;padding:5px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px;">
        ${SOUND_OPTIONS.map(o => `<option value="${o.value}"${o.value === selectedValue ? ' selected' : ''}>${o.label}</option>`).join('')}
      </select>`;

    body.innerHTML = `

      <!-- ① マスター音量・ミュート -->
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-volume-up"></i> 音量・サイレントモード</h3>
          <button class="btn btn-primary btn-sm" id="btn-save-sounds-master"><i class="fas fa-save"></i> 保存</button>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:4px;">

          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;">
            <div style="font-weight:700;font-size:13px;margin-bottom:10px;"><i class="fas fa-sliders-h"></i> 通知音量（全体）</div>
            <div style="display:flex;align-items:center;gap:10px;">
              <i class="fas fa-volume-off" style="color:#94a3b8;"></i>
              <input type="range" id="notif-volume" min="0" max="100" value="${volume}"
                style="flex:1;accent-color:#3b82f6;">
              <i class="fas fa-volume-up" style="color:#3b82f6;"></i>
              <span id="notif-volume-val" style="min-width:32px;font-weight:700;font-size:13px;color:#1e293b;">${volume}%</span>
            </div>
            <div style="font-size:11px;color:#94a3b8;margin-top:6px;">
              スキャン音・通知音・着信音すべてに適用されます。ブラウザのミュートとは別です。
            </div>
            <button class="btn btn-outline btn-sm" id="btn-test-volume" style="margin-top:10px;">
              <i class="fas fa-play"></i> テスト再生
            </button>
          </div>

          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
              <div style="font-weight:700;font-size:13px;"><i class="fas fa-moon"></i> サイレントモード（時間帯自動ミュート）</div>
              <label class="toggle-switch" style="margin:0;">
                <input type="checkbox" id="mute-enabled" ${muteCfg.enabled ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div id="mute-time-row" style="display:${muteCfg.enabled ? 'flex' : 'none'};align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;">
              <span>開始</span>
              <input type="time" id="mute-start" value="${muteCfg.start || '22:00'}"
                style="border:1px solid #cbd5e0;border-radius:4px;padding:4px 6px;font-size:12px;">
              <span>〜 終了</span>
              <input type="time" id="mute-end" value="${muteCfg.end || '06:00'}"
                style="border:1px solid #cbd5e0;border-radius:4px;padding:4px 6px;font-size:12px;">
            </div>
            <div style="font-size:11px;color:#94a3b8;margin-top:8px;">
              指定した時間帯は全通知音を自動でミュートします（トーストは表示されます）。
            </div>
          </div>
        </div>
      </div>

      <!-- ② 着信音 -->
      <div class="settings-panel" style="margin-top:14px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-phone-volume"></i> 着信音・スキャン音</h3>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:4px;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;">
            <div style="font-weight:700;font-size:13px;margin-bottom:10px;">内線/ビデオ通話 着信音</div>
            <div style="display:flex;align-items:center;gap:8px;">
              <select id="incoming-ring-sound" style="flex:1;padding:6px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px;">
                <option value="ring"         ${incomingRingSound==='ring'         ?'selected':''}>📞 電話ベル</option>
                <option value="alarm"        ${incomingRingSound==='alarm'        ?'selected':''}>🚨 アラーム（3連打）</option>
                <option value="urgent"       ${incomingRingSound==='urgent'       ?'selected':''}>🔴 緊急アラーム</option>
                <option value="chime"        ${incomingRingSound==='chime'        ?'selected':''}>🔔 チャイム（ドミソ）</option>
                <option value="double-chime" ${incomingRingSound==='double-chime' ?'selected':''}>🔔🔔 ダブルチャイム</option>
                <option value="fanfare"      ${incomingRingSound==='fanfare'      ?'selected':''}>🎺 ファンファーレ</option>
                <option value="ding"         ${incomingRingSound==='ding'         ?'selected':''}>🎵 サイン音</option>
                <option value="beep"         ${incomingRingSound==='beep'         ?'selected':''}>📳 ビープ</option>
                <option value="soft"         ${incomingRingSound==='soft'         ?'selected':''}>🌙 ソフトトーン</option>
              </select>
              <button class="btn btn-outline btn-sm" id="btn-test-incoming-ring"><i class="fas fa-play"></i></button>
            </div>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;">
            <div style="font-weight:700;font-size:13px;margin-bottom:10px;">ICカード スキャン音</div>
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;">
              <input type="checkbox" id="scan-sound-enabled" ${scanEnabled ? 'checked' : ''} style="transform:scale(1.2);">
              <span>スキャン音を鳴らす<br><span style="font-size:11px;color:#94a3b8;">成功音・エラー音を再生します</span></span>
            </label>
          </div>
        </div>
      </div>

      <!-- ③ ステータス別 通知音 & トースト -->
      <div class="settings-panel" style="margin-top:14px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-bell"></i> ステータス変化の通知</h3>
          <button class="btn btn-primary btn-sm" id="btn-save-sounds"><i class="fas fa-save"></i> 保存</button>
        </div>
        <p class="settings-hint"><i class="fas fa-info-circle"></i>
          患者の移送ステータスが変化したときの通知音とトースト表示を個別に設定できます。
        </p>
        <table class="settings-table" style="margin-top:12px;">
          <thead>
            <tr>
              <th style="width:60px;text-align:center;">通知音</th>
              <th style="width:60px;text-align:center;">トースト</th>
              <th>対象イベント</th>
              <th style="width:190px;">音の種類</th>
              <th style="width:80px;text-align:center;">テスト</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(item => {
              const cfg = soundSettings[item.key] || { enabled: false, sound: item.defaultSound, toast: true };
              return `
                <tr>
                  <td style="text-align:center;">
                    <input type="checkbox" class="sound-enable-chk" data-key="${item.key}"
                      ${cfg.enabled ? 'checked' : ''} style="transform:scale(1.2);cursor:pointer;">
                  </td>
                  <td style="text-align:center;">
                    <input type="checkbox" class="sound-toast-chk" data-key="${item.key}"
                      ${cfg.toast !== false ? 'checked' : ''} style="transform:scale(1.2);cursor:pointer;">
                  </td>
                  <td>
                    <div style="font-weight:700;font-size:13px;color:#2d3748;">
                      ${CONFIG.STATUS_LABEL?.[item.key] || (item.key === 'SOON' ? 'お迎え5分前' : item.key)}
                    </div>
                    <div style="font-size:11px;color:#718096;margin-top:2px;">${item.label}</div>
                  </td>
                  <td>${makeSoundSelect(cfg.sound || item.defaultSound, 'sound-type-sel', item.key)}</td>
                  <td style="text-align:center;">
                    <button class="btn btn-outline btn-sm btn-test-sound" data-key="${item.key}"
                      style="padding:4px 8px;font-size:11px;">
                      <i class="fas fa-play"></i>
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- ④ その他の通知設定 -->
      <div class="settings-panel" style="margin-top:14px;">
        <div class="settings-panel-header">
          <h3><i class="fas fa-cog"></i> その他の通知設定</h3>
          <button class="btn btn-primary btn-sm" id="btn-save-misc-notif"><i class="fas fa-save"></i> 保存</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:8px;">

          <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:12px 14px;
            background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;gap:16px;">
            <div style="flex:1;">
              <div style="font-weight:700;font-size:13px;"><i class="fas fa-desktop"></i> OSネイティブ通知（Windowsデスクトップ通知）</div>
              <div style="font-size:11.5px;color:#64748b;margin-top:3px;line-height:1.6;">
                アプリが背面・最小化中でも迎え要・あと10分などをWindowsの通知センターに表示します。<br>
                <span style="color:#92400e;">※ Windowsの「設定 → 通知」でTransBoardの通知が許可されている必要があります。</span>
              </div>
              <button class="btn btn-outline btn-sm" id="btn-test-os-notif" style="margin-top:8px;font-size:11px;">
                <i class="fas fa-bell"></i> テスト通知を送る
              </button>
            </div>
            <label class="toggle-switch" style="margin:4px 0 0;flex-shrink:0;">
              <input type="checkbox" id="os-notif-enabled" ${osEnabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>

          <label style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;
            background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;">
            <div>
              <div style="font-weight:700;font-size:13px;"><i class="fas fa-file-csv"></i> CSVインポート完了トースト</div>
              <div style="font-size:11.5px;color:#64748b;margin-top:3px;">
                電子カルテからのCSV自動取り込みが完了したときに画面下部にトーストを表示します。
              </div>
            </div>
            <label class="toggle-switch" style="margin:0 0 0 16px;flex-shrink:0;">
              <input type="checkbox" id="import-toast-enabled" ${importToastEnabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </label>

        </div>
      </div>

    `;

    // ── 音量スライダー ──
    const volSlider = document.getElementById('notif-volume');
    const volVal    = document.getElementById('notif-volume-val');
    const _updateVolSlider = () => {
      const pct = volSlider.value;
      volVal.textContent = pct + '%';
      volSlider.style.background = `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${pct}%, #e2e8f0 ${pct}%, #e2e8f0 100%)`;
    };
    volSlider.addEventListener('input', _updateVolSlider);
    _updateVolSlider();
    document.getElementById('btn-test-volume').onclick = () => {
      UI.playNotificationSound('chime', parseInt(volSlider.value, 10) / 100);
    };

    // ── ミュート時間帯の表示切替 ──
    document.getElementById('mute-enabled').addEventListener('change', e => {
      document.getElementById('mute-time-row').style.display = e.target.checked ? 'flex' : 'none';
    });

    // ── マスター（音量・ミュート・スキャン・着信音）保存 ──
    document.getElementById('btn-save-sounds-master').onclick = async () => {
      const vol      = document.getElementById('notif-volume').value;
      const muteOn   = document.getElementById('mute-enabled').checked;
      const muteStart= document.getElementById('mute-start').value || '22:00';
      const muteEnd  = document.getElementById('mute-end').value   || '06:00';
      const scanOn   = document.getElementById('scan-sound-enabled').checked;
      const ringVal  = document.getElementById('incoming-ring-sound').value;

      const muteCfgNew = { enabled: muteOn, start: muteStart, end: muteEnd };

      try {
        if (isChildMode) {
          localStorage.setItem('tbs_notification_volume',    vol);
          localStorage.setItem('tbs_notification_mute',      JSON.stringify(muteCfgNew));
          localStorage.setItem('tbs_notification_scan_sound',String(scanOn));
          localStorage.setItem('tbs_incoming_ring_sound',    ringVal);
          // AppState 反映
          [
            ['notification_volume', vol],
            ['notification_mute', JSON.stringify(muteCfgNew)],
            ['notification_scan_sound', String(scanOn)],
            ['incoming_ring_sound', ringVal],
          ].forEach(([id, value]) => {
            const r = AppState.systemSettings?.find(s => s.id === id);
            if (r) r.value = value; else AppState.systemSettings?.push({ id, value });
          });
        } else {
          await Promise.all([
            API.patch('system_settings', 'notification_volume',    { value: vol }),
            API.patch('system_settings', 'notification_mute',      { value: JSON.stringify(muteCfgNew) }),
            API.patch('system_settings', 'notification_scan_sound',{ value: String(scanOn) }),
            API.patch('system_settings', 'incoming_ring_sound',    { value: ringVal }),
          ]);
          await App.loadMasters();
        }
        UI.toast('音量・ミュート設定を保存しました', 'success');
      } catch(err) {
        UI.toast('保存に失敗しました: ' + err.message, 'danger');
      }
    };

    // ── 着信音テスト ──
    document.getElementById('btn-test-incoming-ring').onclick = () => {
      const sel = document.getElementById('incoming-ring-sound');
      const rec = AppState.systemSettings?.find(s => s.id === 'incoming_ring_sound');
      if (rec) rec.value = sel.value; else AppState.systemSettings?.push({ id: 'incoming_ring_sound', value: sel.value });
      CallPanel.playIncomingRingTone();
      setTimeout(() => CallPanel.stopRingTone(), 2200);
    };

    // ── ステータス通知テスト再生 ──
    body.querySelectorAll('.btn-test-sound').forEach(btn => {
      btn.onclick = () => {
        const key = btn.dataset.key;
        const sel = body.querySelector(`.sound-type-sel[data-key="${key}"]`);
        if (sel) UI.playNotificationSound(sel.value);
      };
    });

    // ── ステータス通知保存 ──
    document.getElementById('btn-save-sounds').onclick = async () => {
      const saveBtn = document.getElementById('btn-save-sounds');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

      const newSettings = {};
      body.querySelectorAll('.sound-enable-chk').forEach(chk => {
        const key = chk.dataset.key;
        const sel  = body.querySelector(`.sound-type-sel[data-key="${key}"]`);
        const tChk = body.querySelector(`.sound-toast-chk[data-key="${key}"]`);
        newSettings[key] = {
          enabled: chk.checked,
          sound:   sel?.value || 'ding',
          toast:   tChk ? tChk.checked : true,
        };
      });

      try {
        if (isChildMode) {
          localStorage.setItem('tbs_notification_sounds', JSON.stringify(newSettings));
          const r = AppState.systemSettings?.find(s => s.id === 'notification_sounds');
          if (r) r.value = JSON.stringify(newSettings);
        } else {
          await API.patch('system_settings', 'notification_sounds', { value: JSON.stringify(newSettings) });
          await App.loadMasters();
        }
        UI.toast('通知音設定を保存しました', 'success');
      } catch(err) {
        UI.toast('保存に失敗しました: ' + err.message, 'danger');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 保存';
      }
    };

    // ── テスト通知ボタン ──
    document.getElementById('btn-test-os-notif')?.addEventListener('click', () => {
      if (window.electronAPI?.showOsNotification) {
        window.electronAPI.showOsNotification('TransBoard テスト通知', 'デスクトップ通知が正常に動作しています。TransBoard からの通知です。');
      } else {
        UI.toast('この環境ではOSネイティブ通知を使用できません', 'warning');
      }
    });

    // ── その他（OS通知・インポートトースト）保存 ──
    document.getElementById('btn-save-misc-notif').onclick = async () => {
      const osOn      = document.getElementById('os-notif-enabled').checked;
      const importOn  = document.getElementById('import-toast-enabled').checked;

      try {
        if (isChildMode) {
          localStorage.setItem('tbs_notification_os', String(osOn));
          [['notification_os', String(osOn)], ['notification_import_toast', String(importOn)]].forEach(([id, value]) => {
            const r = AppState.systemSettings?.find(s => s.id === id);
            if (r) r.value = value; else AppState.systemSettings?.push({ id, value });
          });
          // インポートトーストは全体設定（子機でも親機DBに保存）
          await API.patch('system_settings', 'notification_import_toast', { value: String(importOn) });
        } else {
          await Promise.all([
            API.patch('system_settings', 'notification_os',           { value: String(osOn) }),
            API.patch('system_settings', 'notification_import_toast', { value: String(importOn) }),
          ]);
          await App.loadMasters();
        }
        UI.toast('通知設定を保存しました', 'success');
      } catch(err) {
        UI.toast('保存に失敗しました: ' + err.message, 'danger');
      }
    };

  },

  // ──────────────────────────────────
  //  汎用スケジュール取り込み設定
  // ──────────────────────────────────
  async _renderScheduleFeeds(body) {
    let feeds = [];
    try {
      feeds = await API.getScheduleFeeds();
    } catch (e) {}

    const COLORS = ['#7c3aed','#2563eb','#059669','#d97706','#dc2626','#db2777','#0891b2','#4338ca'];

    const schedModeLabel = { realtime: 'リアルタイム監視', interval: '定期実行', time: '時刻指定' };

    const listHtml = feeds.length === 0
      ? '<p style="color:#718096;font-size:13px;">スケジュール取り込み設定がありません。「追加」から作成してください。</p>'
      : feeds.map(f => {
          const mode = schedModeLabel[f.schedule?.mode] || 'リアルタイム監視';
          const modeDetail = f.schedule?.mode === 'interval'
            ? `（${f.schedule.intervalMin}分ごと）`
            : f.schedule?.mode === 'time'
            ? `（${(f.schedule.times||[]).join(', ')}）`
            : '';
          const titleCol = f.mapping?.col_title || '';
          const dateCol = f.mapping?.col_date || f.mapping?.col_datetime || '';
          const wardNames = (f.ward_ids?.length > 0)
            ? f.ward_ids.map(id => AppState.wards?.find(w => w.id === id)?.name || id).join(', ')
            : '全病棟';
          return `
          <div class="settings-row" style="border:1px solid #e2e8f0;border-radius:8px;margin-bottom:8px;background:#fff;overflow:hidden;">
            <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;">
              <span style="width:14px;height:14px;border-radius:50%;background:${f.color||'#7c3aed'};flex-shrink:0;"></span>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:700;font-size:13px;">${f.name || '（名称なし）'}</div>
                <div style="font-size:11px;color:#718096;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${f.watch_dir||''}">
                  <i class="fas fa-folder" style="margin-right:3px;"></i>${f.watch_dir || '（フォルダ未設定）'}
                </div>
              </div>
              <span style="font-size:11px;padding:2px 6px;border-radius:10px;background:${f.is_active?'#dcfce7':'#f1f5f9'};color:${f.is_active?'#16a34a':'#64748b'};flex-shrink:0;">${f.is_active?'有効':'無効'}</span>
              <button class="btn btn-outline btn-sm sched-feed-import-btn" data-feed-id="${f.id}" style="font-size:11px;padding:4px 8px;flex-shrink:0;" title="手動取り込み実行">
                <i class="fas fa-download"></i>
              </button>
              <button class="btn btn-outline btn-sm sched-feed-edit-btn" data-feed-id="${f.id}" style="font-size:11px;padding:4px 8px;flex-shrink:0;">
                <i class="fas fa-edit"></i> 編集
              </button>
              <button class="btn btn-danger btn-sm sched-feed-del-btn" data-feed-id="${f.id}" style="font-size:11px;padding:4px 8px;background:#fee2e2;color:#dc2626;border-color:#fca5a5;flex-shrink:0;">
                <i class="fas fa-trash"></i>
              </button>
            </div>
            <div style="display:flex;gap:16px;padding:6px 12px 8px 36px;background:#f8fafc;border-top:1px solid #f1f5f9;font-size:11px;color:#64748b;flex-wrap:wrap;">
              <span><i class="fas fa-clock" style="margin-right:3px;color:#94a3b8;"></i>${mode}${modeDetail}</span>
              ${dateCol ? `<span><i class="fas fa-calendar-alt" style="margin-right:3px;color:#94a3b8;"></i>日付列: <code>${dateCol}</code></span>` : ''}
              ${titleCol ? `<span><i class="fas fa-tag" style="margin-right:3px;color:#94a3b8;"></i>タイトル列: <code>${titleCol}</code></span>` : ''}
              <span><i class="fas fa-hospital" style="margin-right:3px;color:#94a3b8;"></i>${wardNames}</span>
            </div>
          </div>`;
        }).join('');

    body.innerHTML = `
      <div class="settings-section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h3 style="margin:0;font-size:15px;">汎用スケジュール取り込み</h3>
          <button class="btn btn-primary btn-sm" id="sched-feed-add-btn"><i class="fas fa-plus"></i> 追加</button>
        </div>
        <p style="font-size:12px;color:#718096;margin:0 0 16px;">
          任意の CSV を定期的に取り込み、タイムラインにスケジュールとして表示します。<br>
          日付・時刻・タイトル列を指定するだけで使えます。複数の取り込みを設定できます。
        </p>
        <div id="sched-feed-list">${listHtml}</div>
      </div>

      <!-- フィード編集フォーム（モーダル風） -->
      <div id="sched-feed-form-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:5000;overflow-y:auto;">
        <div id="sched-feed-form-box" style="background:#fff;border-radius:12px;max-width:600px;margin:32px auto 48px;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;">

          <!-- ヘッダ -->
          <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
            <h4 id="sched-feed-form-title" style="margin:0;font-size:15px;font-weight:800;">スケジュール取り込みの追加</h4>
            <button id="sched-feed-form-close-x" style="background:none;border:none;cursor:pointer;font-size:18px;color:#94a3b8;line-height:1;" title="閉じる">&times;</button>
          </div>

          <div style="padding:20px 24px;">
            <input type="hidden" id="sched-form-id">

            <!-- ① 基本情報 -->
            <div style="margin-bottom:18px;">
              <div style="font-size:11px;font-weight:800;color:#64748b;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px;">① 基本情報</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                <div>
                  <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">取り込み名 <span style="color:#dc2626;">*</span></label>
                  <input type="text" id="sched-form-name" class="form-input" placeholder="例: 手術スケジュール">
                </div>
                <div>
                  <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">表示色</label>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding-top:4px;">
                    ${COLORS.map(c => `<span class="sched-color-chip" data-color="${c}" style="width:22px;height:22px;border-radius:50%;background:${c};cursor:pointer;border:2px solid transparent;transition:transform .1s;" title="${c}"></span>`).join('')}
                    <input type="color" id="sched-form-color" value="#7c3aed" style="width:28px;height:28px;border:none;padding:0;cursor:pointer;border-radius:4px;" title="カスタムカラー">
                  </div>
                </div>
              </div>
            </div>

            <!-- ② 監視フォルダ -->
            <div style="margin-bottom:18px;padding-top:14px;border-top:1px solid #f1f5f9;">
              <div style="font-size:11px;font-weight:800;color:#64748b;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px;">② 監視フォルダ</div>
              <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">フォルダパス <span style="color:#dc2626;">*</span></label>
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="text" id="sched-form-dir" class="form-input" placeholder="C:\\schedules\\surg または \\\\server\\share" style="flex:1;">
                <button class="btn btn-outline btn-sm" id="sched-btn-select-folder" style="flex-shrink:0;white-space:nowrap;" title="フォルダを選択">
                  <i class="fas fa-folder-open"></i> 選択
                </button>
              </div>
              <p style="font-size:11px;color:#718096;margin:4px 0 0;">CSVが配置されるフォルダのパスを指定します（UNCパス可）。</p>
            </div>

            <!-- ③ 取り込みスケジュール -->
            <div style="margin-bottom:18px;padding-top:14px;border-top:1px solid #f1f5f9;">
              <div style="font-size:11px;font-weight:800;color:#64748b;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px;">③ 取り込みタイミング</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                ${[
                  { val:'realtime', icon:'fa-bolt', label:'リアルタイム監視', desc:'ファイルを検知次第すぐに取り込む' },
                  { val:'interval', icon:'fa-redo',  label:'定期実行',         desc:'指定した分ごとに取り込む' },
                  { val:'time',     icon:'fa-clock', label:'時刻指定',         desc:'指定した時刻に取り込む' },
                ].map(o => `
                  <label class="sched-mode-card" data-val="${o.val}" style="flex:1;min-width:130px;display:flex;flex-direction:column;gap:3px;
                    border:2px solid #e2e8f0;border-radius:8px;padding:10px 12px;cursor:pointer;background:#fafafa;transition:border-color .15s;">
                    <input type="radio" name="sched-form-mode" value="${o.val}" style="display:none;">
                    <span style="font-size:13px;font-weight:700;"><i class="fas ${o.icon}" style="width:14px;"></i> ${o.label}</span>
                    <span style="font-size:10px;color:#6b7280;">${o.desc}</span>
                  </label>
                `).join('')}
              </div>
              <div id="sched-form-interval-row" style="display:none;margin-top:10px;display:none;">
                <label style="font-size:12px;color:#374151;display:flex;align-items:center;gap:8px;">
                  <input type="number" id="sched-form-interval" class="form-input" value="30" min="1" style="width:72px;">
                  分ごとに取り込む
                </label>
              </div>
              <div id="sched-form-times-row" style="display:none;margin-top:10px;">
                <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">実行時刻（カンマ区切り・HH:mm）</label>
                <input type="text" id="sched-form-times" class="form-input" placeholder="07:00,12:00,17:00">
              </div>
            </div>

            <!-- ④ CSVカラムマッピング -->
            <div style="margin-bottom:18px;padding-top:14px;border-top:1px solid #f1f5f9;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                <div style="font-size:11px;font-weight:800;color:#64748b;letter-spacing:.06em;text-transform:uppercase;">④ CSVカラムマッピング</div>
                <button class="btn btn-outline btn-sm" id="sched-btn-load-headers" style="font-size:11px;">
                  <i class="fas fa-magic"></i> CSVからヘッダを読み込む
                </button>
              </div>
              <div id="sched-headers-hint" style="display:none;margin-bottom:8px;padding:8px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:11px;color:#1e40af;"></div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div>
                  <label style="font-size:11px;color:#374151;font-weight:700;display:block;margin-bottom:3px;">日付列（または日時一括列）</label>
                  <input type="text" id="sched-map-date" class="form-input sched-map-input" placeholder="例: 日付 / 検査日時" list="sched-headers-list">
                </div>
                <div>
                  <label style="font-size:11px;color:#374151;font-weight:700;display:block;margin-bottom:3px;">時刻列 <span style="color:#94a3b8;font-weight:400;">（任意）</span></label>
                  <input type="text" id="sched-map-time" class="form-input sched-map-input" placeholder="例: 時刻 / 開始時間" list="sched-headers-list">
                </div>
                <div>
                  <label style="font-size:11px;color:#374151;font-weight:700;display:block;margin-bottom:3px;">タイトル・内容列 <span style="color:#dc2626;">*</span></label>
                  <input type="text" id="sched-map-title" class="form-input sched-map-input" placeholder="例: 内容 / 検査名" list="sched-headers-list">
                </div>
                <div>
                  <label style="font-size:11px;color:#374151;font-weight:700;display:block;margin-bottom:3px;">ID列 <span style="color:#94a3b8;font-weight:400;">（任意）</span></label>
                  <input type="text" id="sched-map-id" class="form-input sched-map-input" placeholder="例: 患者ID" list="sched-headers-list">
                </div>
                <div>
                  <label style="font-size:11px;color:#374151;font-weight:700;display:block;margin-bottom:3px;">所要時間(分)列 <span style="color:#94a3b8;font-weight:400;">（任意）</span></label>
                  <input type="text" id="sched-map-duration" class="form-input sched-map-input" placeholder="例: 所要時間" list="sched-headers-list">
                </div>
              </div>
              <datalist id="sched-headers-list"></datalist>
              <p style="font-size:11px;color:#718096;margin:8px 0 0;">
                列名はCSVのヘッダ行と完全一致させてください。日時が1列の場合は「日付列」に入力し、時刻列は空欄にしてください。
              </p>
            </div>

            <!-- ⑤ ファイル処理・対象病棟・有効/無効 -->
            <div style="margin-bottom:16px;padding-top:14px;border-top:1px solid #f1f5f9;">
              <div style="font-size:11px;font-weight:800;color:#64748b;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px;">⑤ その他の設定</div>

              <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:6px;">取り込み後のファイル処理</label>
              <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;">
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="radio" name="sched-form-policy" value="archive" checked> archiveフォルダへ移動</label>
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="radio" name="sched-form-policy" value="delete"> 削除</label>
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="radio" name="sched-form-policy" value="skip"> そのまま残す</label>
              </div>

              <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:6px;">
                対象病棟 <span style="font-size:10px;color:#6b7280;font-weight:400;">（未選択 = 全病棟に表示）</span>
              </label>
              <div id="sched-ward-checks" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
                ${(AppState.wards || []).map(w => `
                  <label style="display:flex;align-items:center;gap:4px;font-size:12px;background:#f8fafc;padding:4px 8px;border-radius:4px;border:1px solid #e2e8f0;cursor:pointer;">
                    <input type="checkbox" class="sched-ward-chk" value="${w.id}"> ${w.name}
                  </label>
                `).join('')}
                ${!(AppState.wards?.length) ? '<span style="font-size:11px;color:#94a3b8;">病棟マスタを先に登録してください</span>' : ''}
              </div>

              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                <input type="checkbox" id="sched-form-active" checked style="width:16px;height:16px;">
                この設定を有効にする
              </label>
            </div>
          </div>

          <!-- フッタ -->
          <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
            <button class="btn btn-outline btn-sm" id="sched-feed-form-cancel">キャンセル</button>
            <button class="btn btn-primary btn-sm" id="sched-feed-form-save"><i class="fas fa-save"></i> 保存</button>
          </div>
        </div>
      </div>
    `;

    const overlay = body.querySelector('#sched-feed-form-overlay');
    const colorInput = body.querySelector('#sched-form-color');

    // カラーチップ選択
    body.querySelectorAll('.sched-color-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        body.querySelectorAll('.sched-color-chip').forEach(c => { c.style.border = '2px solid transparent'; c.style.transform = ''; });
        chip.style.border = '2px solid #1a202c';
        chip.style.transform = 'scale(1.25)';
        colorInput.value = chip.dataset.color;
      });
    });

    // スケジュールモードカード切り替え
    const updateModeCards = () => {
      const m = body.querySelector('input[name="sched-form-mode"]:checked')?.value || 'realtime';
      body.querySelectorAll('.sched-mode-card').forEach(card => {
        const active = card.dataset.val === m;
        card.style.borderColor = active ? '#3b82f6' : '#e2e8f0';
        card.style.background  = active ? '#eff6ff' : '#fafafa';
      });
      body.querySelector('#sched-form-interval-row').style.display = m === 'interval' ? 'block' : 'none';
      body.querySelector('#sched-form-times-row').style.display    = m === 'time'     ? 'block' : 'none';
    };
    body.querySelectorAll('.sched-mode-card').forEach(card => {
      card.addEventListener('click', () => {
        const radio = card.querySelector('input[type="radio"]');
        if (radio) { radio.checked = true; updateModeCards(); }
      });
    });

    // フォルダ選択ダイアログ
    body.querySelector('#sched-btn-select-folder').addEventListener('click', async () => {
      if (!window.electronAPI?.selectFolder) { UI.toast('フォルダ選択はElectron環境でのみ利用できます', 'warning'); return; }
      const selected = await window.electronAPI.selectFolder();
      if (selected) {
        body.querySelector('#sched-form-dir').value = selected;
      }
    });

    // CSVヘッダ読み込み
    body.querySelector('#sched-btn-load-headers').addEventListener('click', async () => {
      const dir = body.querySelector('#sched-form-dir').value.trim();
      if (!dir) { UI.toast('先に監視フォルダを指定してください', 'warning'); return; }
      if (!window.electronAPI?.readCsvHeaders) { UI.toast('この機能はElectron環境でのみ利用できます', 'warning'); return; }
      const btn = body.querySelector('#sched-btn-load-headers');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 読み込み中...';
      try {
        const result = await window.electronAPI.readCsvHeaders(dir);
        if (!result.ok) {
          const msg = result.reason === 'no_csv' ? 'フォルダ内にCSVファイルが見つかりません' : `読み取りエラー: ${result.reason}`;
          UI.toast(msg, 'warning');
          return;
        }
        const datalist = body.querySelector('#sched-headers-list');
        datalist.innerHTML = result.headers.map(h => `<option value="${UI.escapeHTML(h)}">`).join('');
        const hint = body.querySelector('#sched-headers-hint');
        hint.style.display = 'block';
        hint.innerHTML = `<i class="fas fa-check-circle"></i> <strong>${result.filename}</strong> のヘッダを読み込みました: ${result.headers.map(h => `<code>${UI.escapeHTML(h)}</code>`).join(' / ')}`;
      } catch (e) {
        UI.toast('CSVの読み込みに失敗しました: ' + e.message, 'danger');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-magic"></i> CSVからヘッダを読み込む';
      }
    });

    // Escキー・背景クリックで閉じる
    const closeForm = () => { overlay.style.display = 'none'; };
    overlay.addEventListener('click', e => { if (e.target === overlay) closeForm(); });
    this._addEscapeClose(overlay, closeForm);
    body.querySelector('#sched-feed-form-close-x').addEventListener('click', closeForm);

    const openForm = (feed = null) => {
      body.querySelector('#sched-feed-form-title').textContent = feed ? 'スケジュール取り込みの編集' : 'スケジュール取り込みの追加';
      body.querySelector('#sched-form-id').value = feed?.id || '';
      body.querySelector('#sched-form-name').value = feed?.name || '';
      body.querySelector('#sched-form-dir').value = feed?.watch_dir || '';
      body.querySelector('#sched-form-active').checked = feed ? (feed.is_active !== false) : true;

      const color = feed?.color || '#7c3aed';
      colorInput.value = color;
      body.querySelectorAll('.sched-color-chip').forEach(c => {
        c.style.border = c.dataset.color === color ? '2px solid #1a202c' : '2px solid transparent';
      });

      const sched = feed?.schedule || { mode: 'realtime' };
      const modeRadio = body.querySelector(`input[name="sched-form-mode"][value="${sched.mode || 'realtime'}"]`);
      if (modeRadio) modeRadio.checked = true;
      body.querySelector('#sched-form-interval').value = sched.intervalMin || '30';
      body.querySelector('#sched-form-times').value = (sched.times || []).join(',');
      updateModeCards();

      // ヘッダヒントをリセット
      const hint = body.querySelector('#sched-headers-hint');
      if (hint) { hint.style.display = 'none'; hint.innerHTML = ''; }
      const datalist = body.querySelector('#sched-headers-list');
      if (datalist) datalist.innerHTML = '';

      const m = feed?.mapping || {};
      body.querySelector('#sched-map-date').value = m.col_date || m.col_datetime || '';
      body.querySelector('#sched-map-time').value = m.col_time || '';
      body.querySelector('#sched-map-title').value = m.col_title || '';
      body.querySelector('#sched-map-id').value = m.col_id || '';
      body.querySelector('#sched-map-duration').value = m.col_duration_min || '';

      const policy = (feed?.retention_policy?.action) || 'archive';
      const policyRadio = body.querySelector(`input[name="sched-form-policy"][value="${policy}"]`);
      if (policyRadio) policyRadio.checked = true;

      // 対象病棟チェック設定
      body.querySelectorAll('.sched-ward-chk').forEach(chk => {
        chk.checked = feed?.ward_ids?.length > 0 ? feed.ward_ids.includes(chk.value) : false;
      });

      overlay.style.display = 'block';
    };

    // 追加ボタン
    body.querySelector('#sched-feed-add-btn').addEventListener('click', () => openForm());

    // キャンセル
    body.querySelector('#sched-feed-form-cancel').addEventListener('click', closeForm);

    // 保存
    body.querySelector('#sched-feed-form-save').addEventListener('click', async () => {
      const name = body.querySelector('#sched-form-name').value.trim();
      const watchDir = body.querySelector('#sched-form-dir').value.trim();
      const titleCol = body.querySelector('#sched-map-title').value.trim();
      if (!name) { UI.toast('取り込み名を入力してください', 'warning'); return; }
      if (!watchDir) { UI.toast('監視フォルダを入力してください', 'warning'); return; }
      if (!titleCol) { UI.toast('タイトル列を入力してください', 'warning'); return; }

      const mode = body.querySelector('input[name="sched-form-mode"]:checked').value;
      const schedule = { mode };
      if (mode === 'interval') schedule.intervalMin = body.querySelector('#sched-form-interval').value;
      if (mode === 'time') schedule.times = body.querySelector('#sched-form-times').value.split(',').map(s => s.trim()).filter(Boolean);

      const dateCol = body.querySelector('#sched-map-date').value.trim();
      const mapping = {
        col_date: dateCol,
        col_datetime: '',
        col_time: body.querySelector('#sched-map-time').value.trim(),
        col_title: titleCol,
        col_id: body.querySelector('#sched-map-id').value.trim(),
        col_duration_min: body.querySelector('#sched-map-duration').value.trim(),
      };

      const feedId = body.querySelector('#sched-form-id').value;
      const wardIds = [...body.querySelectorAll('.sched-ward-chk:checked')].map(c => c.value);
      const data = {
        id: feedId || `feed-${Date.now()}`,
        name,
        color: colorInput.value,
        watch_dir: watchDir,
        schedule,
        mapping,
        retention_policy: { action: body.querySelector('input[name="sched-form-policy"]:checked').value },
        is_active: body.querySelector('#sched-form-active').checked,
        ward_ids: wardIds, // 空配列 = 全病棟
      };

      try {
        if (feedId) {
          await API.patch('schedule_feeds', feedId, data);
        } else {
          await API.create('schedule_feeds', data);
        }
        if (window.electronAPI?.reloadScheduleFeedTriggers) {
          await window.electronAPI.reloadScheduleFeedTriggers();
        }
        closeForm();
        UI.toast('スケジュール取り込み設定を保存しました', 'success');
        this._renderScheduleFeeds(body);
      } catch (e) {
        UI.toast('保存に失敗しました: ' + e.message, 'danger');
      }
    });

    // リスト操作（編集・削除・手動取り込み）
    body.addEventListener('click', async e => {
      const editBtn = e.target.closest('.sched-feed-edit-btn');
      const delBtn = e.target.closest('.sched-feed-del-btn');
      const importBtn = e.target.closest('.sched-feed-import-btn');

      if (editBtn) {
        const feed = feeds.find(f => f.id === editBtn.dataset.feedId);
        if (feed) openForm(feed);
      } else if (delBtn) {
        if (!await UI.confirmModal('このスケジュール取り込み設定と取り込み済みデータをすべて削除しますか？', { title: 'スケジュール取り込み設定を削除', danger: true, confirmLabel: '削除' })) return;
        const feedId = delBtn.dataset.feedId;
        try {
          await API.remove('schedule_feeds', feedId);
          const allItems = await API.getAll('schedule_items');
          const toDelete = (allItems.data || []).filter(x => x.feed_id === feedId);
          for (const item of toDelete) {
            await API.remove('schedule_items', item.id);
          }
          if (window.electronAPI?.reloadScheduleFeedTriggers) {
            await window.electronAPI.reloadScheduleFeedTriggers();
          }
          UI.toast('削除しました', 'success');
          this._renderScheduleFeeds(body);
        } catch (err) {
          UI.toast('削除に失敗しました', 'danger');
        }
      } else if (importBtn) {
        if (!window.electronAPI?.triggerScheduleFeedImport) return;
        importBtn.disabled = true;
        const oldHtml = importBtn.innerHTML;
        importBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        try {
          const res = await window.electronAPI.triggerScheduleFeedImport(importBtn.dataset.feedId);
          if (res?.success) UI.toast('手動取り込みを実行しました', 'success');
          else UI.toast(res?.message || '取り込み失敗', 'warning');
        } catch (err) {
          UI.toast('手動取り込みに失敗しました', 'danger');
        } finally {
          importBtn.innerHTML = oldHtml;
          importBtn.disabled = false;
        }
      }
    }, { capture: false });
  },

  _renderSpeechTemplates(body) {
    const templatesSetting = AppState.systemSettings?.find(s => s.id === 'speech_templates');
    let templates = [];
    if (templatesSetting && templatesSetting.value) {
      try {
        templates = JSON.parse(templatesSetting.value);
      } catch (e) {
        console.error(e);
      }
    }
    
    // フォールバック
    if (!Array.isArray(templates) || templates.length === 0) {
      templates = [
        "連絡事項があります。",
        "間もなく、患者が出発します。",
        "患者が到着しました。",
        "検査が終了しました。お迎えをお願いします。",
        "移送をキャンセルします。",
        "至急、ご連絡ください。"
      ];
    }

    const renderList = () => {
      const listEl = document.getElementById('templates-list-container');
      if (!listEl) return;

      if (templates.length === 0) {
        listEl.innerHTML = '<div class="text-muted text-sm" style="padding:12px 0;">定型文が登録されていません</div>';
        return;
      }

      listEl.innerHTML = templates.map((t, idx) => `
        <div class="template-item-row" style="display:flex; gap:8px; align-items:center; margin-bottom:8px; background:rgba(0,0,0,0.02); padding:8px; border-radius:6px; border:1px solid #e2e8f0;">
          <span style="font-size:12px; font-weight:bold; color:#718096; width:24px; text-align:center;">${idx + 1}</span>
          <input type="text" class="template-input-text" data-index="${idx}" value="${t}" style="flex:1; padding:6px 10px; border:1px solid #cbd5e0; border-radius:4px; font-size:13px;" placeholder="アナウンスで読み上げる定型文を入力してください">
          <button class="btn btn-secondary btn-sm btn-delete-template" data-index="${idx}" style="padding:6px 10px; background:#ef4444; border-color:#ef4444; color:#fff;" title="削除">
            <i class="fas fa-trash-alt"></i>
          </button>
        </div>
      `).join('');

      // 入力値変更時の配列への即時同期
      listEl.querySelectorAll('.template-input-text').forEach(input => {
        input.addEventListener('change', (e) => {
          const idx = parseInt(e.target.dataset.index, 10);
          templates[idx] = e.target.value.trim();
        });
      });

      // 削除ボタンイベント
      listEl.querySelectorAll('.btn-delete-template').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = parseInt(btn.dataset.index, 10);
          templates.splice(idx, 1);
          renderList();
        });
      });
    };

    const announceNameSetting = AppState.systemSettings?.find(s => s.id === 'announce_patient_name');
    const announceNameChecked = announceNameSetting?.value === 'true';

    body.innerHTML = `
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h3><i class="fas fa-bullhorn"></i> アナウンス簡易連絡 定型文設定</h3>
          <button class="btn btn-success btn-sm" id="btn-add-template">
            <i class="fas fa-plus"></i> 定型文を追加
          </button>
        </div>
        <div class="settings-panel-body" style="padding:16px;">
          <label style="display:flex; align-items:center; gap:8px; font-size:13px; font-weight:700; color:#334155; margin-bottom:16px; cursor:pointer; user-select:none;">
            <input type="checkbox" id="chk-announce-patient-name" ${announceNameChecked ? 'checked' : ''} style="cursor:pointer; transform:scale(1.1);">
            <span>自動音声アナウンス（出棟・到着・お迎え要請時）に患者名を含める</span>
          </label>
          <p style="font-size:12px; color:#64748b; margin-bottom:16px; line-height:1.4;">
            コールの代わりに音声合成で読み上げて相手に伝える「ワンクリック定型アナウンス」の定型文リストを編集します。<br>
            追加・削除・編集を行った後は、最下部の「定型文設定を保存」ボタンを押してください。
          </p>
          <div id="templates-list-container" style="max-width:600px; margin-bottom:20px;"></div>

          <button class="btn btn-primary" id="btn-save-templates" style="padding:10px 24px; font-weight:700;">
            <i class="fas fa-save"></i> 定型文設定を保存
          </button>
        </div>
      </div>
    `;

    renderList();

    // 患者名アナウンス設定は即時保存（他のON/OFFトグルと同じ挙動）
    document.getElementById('chk-announce-patient-name').addEventListener('change', async (e) => {
      const value = e.target.checked ? 'true' : 'false';
      try {
        await API.patch('system_settings', 'announce_patient_name', { value });
        if (announceNameSetting) {
          announceNameSetting.value = value;
        } else {
          AppState.systemSettings.push({ id: 'announce_patient_name', value });
        }
        UI.toast('設定を保存しました', 'success');
      } catch (err) {
        console.error(err);
        UI.toast('設定の保存に失敗しました', 'danger');
        e.target.checked = !e.target.checked;
      }
    });

    // 追加ボタンイベント
    document.getElementById('btn-add-template').onclick = () => {
      templates.push('');
      renderList();
      const inputs = body.querySelectorAll('.template-input-text');
      if (inputs.length > 0) inputs[inputs.length - 1].focus();
    };

    // 保存ボタンイベント
    document.getElementById('btn-save-templates').onclick = async () => {
      const saveBtn = document.getElementById('btn-save-templates');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';

      const cleanTemplates = templates.map(t => t.trim()).filter(t => t !== '');

      try {
        await API.patch('system_settings', 'speech_templates', { value: JSON.stringify(cleanTemplates) });

        const appSetting = AppState.systemSettings?.find(s => s.id === 'speech_templates');
        if (appSetting) {
          appSetting.value = JSON.stringify(cleanTemplates);
        } else {
          AppState.systemSettings.push({ id: 'speech_templates', value: JSON.stringify(cleanTemplates) });
        }

        UI.toast('アナウンス定型文設定を保存しました', 'success');
        templates = [...cleanTemplates];
        renderList();
      } catch (err) {
        console.error(err);
        UI.toast('設定の保存に失敗しました', 'danger');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 定型文設定を保存';
      }
    };
  },

});
