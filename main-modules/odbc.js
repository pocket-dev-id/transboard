'use strict';

const { execFile, execFileSync } = require('child_process');

const POWERSHELL_EXE = process.env.SystemRoot
  ? pathJoin(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';
const REG_EXE = process.env.SystemRoot
  ? pathJoin(process.env.SystemRoot, 'System32', 'reg.exe')
  : 'reg.exe';

function pathJoin(...parts) {
  return require('path').join(...parts);
}

let getMainWindow = () => null;

function configureOdbc(deps) {
  getMainWindow = deps.getMainWindow;
}

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

// ODBC読み取り専用安全対策: 接続文字列の強制付与
function enforceReadOnlyConnectionString(connStr) {
  if (!connStr) return { valid: false, message: '接続文字列が空です。' };
  
  const lowerConn = connStr.toLowerCase();
  
  // すでに何らかの読み取り専用オプションが指定されているか確認
  const hasReadOnly = 
    lowerConn.includes('readonly=1') ||
    lowerConn.includes('readonly=true') ||
    lowerConn.includes('mode=read') ||
    lowerConn.includes('applicationintent=readonly');
    
  let finalConnStr = connStr;
  if (!hasReadOnly) {
    const base = connStr.trim();
    const separator = base.endsWith(';') ? '' : ';';
    finalConnStr = `${base}${separator}ReadOnly=1;`;
  }
  
  return { valid: true, connectionString: finalConnStr };
}

function sanitizeOdbcError(message, connectionString = '') {
  return String(message || 'ODBC処理に失敗しました')
    .replaceAll(String(connectionString || ''), '[接続文字列]')
    .replace(/((?:PWD|Password)\s*=\s*)[^;\s]*/ig, '$1***');
}

function execOdbcPowerShell(connectionString, scriptBody, timeoutMs = 15000) {
  const safe = String(connectionString).slice(0, 500).replace(/'/g, "''");
  const ps = `
# Windows PowerShell 5.1 uses the active Windows code page for redirected
# stdout by default. Node decodes this stream as UTF-8, so force the encoding
# before emitting Japanese ODBC errors or table names.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Data
  $conn = New-Object System.Data.Odbc.OdbcConnection('${safe}')
  $conn.Open()
${scriptBody}
  $conn.Close()
} catch {
  Write-Output "ERROR:$($_.Exception.Message)"
}`.trim();

  // cmd.exeを介さず固定実行ファイルへ引数配列で渡す。EncodedCommandにより、
  // 接続文字列やSQL中の記号がコマンドラインとして再解釈されない。
  const encodedCommand = Buffer.from(ps, 'utf16le').toString('base64');
  const timeout = Math.min(Math.max(Number(timeoutMs) || 15000, 1000), 60000);
  return new Promise(resolve => {
    execFile(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
      { encoding: 'utf8', timeout, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        const out = String(stdout || '').trim();
        if (error && (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT')) {
          resolve({ success: false, error: `処理がタイムアウトしました（${Math.round(timeout / 1000)}秒）。データベースの応答が遅いか、ネットワーク/権限の問題が考えられます。` });
          return;
        }
        if (error) {
          resolve({ success: false, error: sanitizeOdbcError(error.message, connectionString) });
          return;
        }
        if (!out || out.startsWith('ERROR:')) {
          resolve({ success: false, error: sanitizeOdbcError(out ? out.slice(6) : '接続に失敗しました', connectionString) });
          return;
        }
        resolve({ success: true, output: out });
      }
    );
  });
}

async function getOdbcTablesOnParent({ connectionString }) {
  if (!connectionString) return { success: false, error: '接続文字列が指定されていません', tables: [] };
  const connResult = enforceReadOnlyConnectionString(connectionString);
  if (!connResult.valid) {
    return { success: false, error: connResult.message, tables: [] };
  }
  // 他のODBC操作（test/preview/sync）と同じくDSN指定を必須にする。
  // これが無いと、子機が任意の接続文字列（Driver=…;Server=…）を指定して
  // 親機に外部ホストへ接続させられる。
  if (!connResult.connectionString.includes('DSN=')) {
    return { success: false, error: '接続文字列にDSN指定が見つかりません。例: DSN=EMR_DB;UID=admin;PWD=pass;', tables: [] };
  }

  const result = await execOdbcPowerShell(connResult.connectionString, `
  $schema = $conn.GetSchema('Tables')
  $items = @($schema | Where-Object { $_.TABLE_TYPE -in @('TABLE','VIEW','SYSTEM TABLE') } |
    Select-Object @{N='name';E={$_.TABLE_NAME}}, @{N='type';E={$_.TABLE_TYPE}} |
    Sort-Object type, name)
  if ($items.Count -eq 0) { Write-Output '[]' } else { $items | ConvertTo-Json -Compress }`, 25000);
  if (!result.success) {
    const hint = 'テーブル一覧の取得に失敗しました。ODBCドライバがテーブル一覧の取得に対応していないか、データベースアカウントにメタデータ参照権限がない可能性があります。手動入力も利用できます。';
    return { success: false, error: `${hint}\n詳細: ${result.error}`, tables: [] };
  }
  try {
    const raw = JSON.parse(result.output);
    const tables = (Array.isArray(raw) ? raw : [raw]).map(r => ({ name: r.name, type: r.type }));
    return { success: true, tables };
  } catch (e) {
    return { success: false, error: e.message, tables: [] };
  }
}

// IPC通信でODBC接続経由でテーブル/ビュー一覧を取得する

function getOdbcDsnsOnParent() {
  const result = { system: [], user: [], drivers: [] };
  const regQuery = (hive, subkey) => {
    try {
      const registryPath = `${hive}\\SOFTWARE\\ODBC\\ODBC.INI\\${subkey}`;
      const out = execFileSync(REG_EXE, ['query', registryPath], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      return out.split('\r\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith(hive) && !l.startsWith('HKEY'))
        .map(l => { const m = l.match(/^(.+?)\s+REG_SZ\s+(.+)$/); return m ? { name: m[1].trim(), driver: m[2].trim() } : null; })
        .filter(Boolean);
    } catch { return []; }
  };
  const driverQuery = (hive) => {
    try {
      const registryPath = `${hive}\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers`;
      const out = execFileSync(REG_EXE, ['query', registryPath], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      return out.split('\r\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith(hive) && !l.startsWith('HKEY'))
        .map(l => { const m = l.match(/^(.+?)\s+REG_SZ\s+Installed$/i); return m ? m[1].trim() : null; })
        .filter(Boolean);
    } catch { return []; }
  };

  result.system  = regQuery('HKLM', 'ODBC Data Sources');
  result.user    = regQuery('HKCU', 'ODBC Data Sources');
  result.drivers = [...new Set([...driverQuery('HKLM'), ...driverQuery('HKCU')])];
  return result;
}

// IPC通信でWindowsレジストリからシステム/ユーザーDSN一覧を取得する

async function testOdbcConnectionOnParent({ connectionString, sqlQuery }) {
  // 接続文字列の検証 & 読み取り専用属性の付与
  const connResult = enforceReadOnlyConnectionString(connectionString);
  if (!connResult.valid) {
    return { success: false, message: connResult.message };
  }
  const finalConnStr = connResult.connectionString;

  // SQLクエリの安全検証
  const queryResult = validateReadOnlyQuery(sqlQuery);
  if (!queryResult.valid) {
    return { success: false, message: queryResult.message };
  }

  if (!finalConnStr || !finalConnStr.includes('DSN=')) {
    return { success: false, message: '接続文字列にDSN指定が見つかりません。例: DSN=EMR_DB;UID=admin;PWD=pass;' };
  }

  const result = await execOdbcPowerShell(finalConnStr, "  Write-Output 'OK'", 15000);
  if (!result.success) {
    return { success: false, message: 'ODBCデータベース接続テストに失敗しました: ' + result.error };
  }
  return { success: true, message: 'ODBCデータベース接続テストに成功しました。(接続先: ' + finalConnStr.split(';')[0] + ' [読み取り専用: 強制適用済、実接続確認済])' };
}

// IPC通信でODBCデータベース接続テストを行う

function buildOdbcRowFetchScript(sqlQuery, maxRows = null) {
  const safeQuery = String(sqlQuery).replace(/'/g, "''");
  const breakCheck = maxRows ? `if ($rows.Count -ge ${maxRows}) { $hasMore = $true; break }` : '';
  return `
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = '${safeQuery}'
  $cmd.CommandTimeout = 25
  $reader = $cmd.ExecuteReader()
  $cols = @()
  for ($i = 0; $i -lt $reader.FieldCount; $i++) { $cols += $reader.GetName($i) }
  $rows = New-Object System.Collections.ArrayList
  $hasMore = $false
  while ($reader.Read()) {
    ${breakCheck}
    $obj = [ordered]@{}
    foreach ($c in $cols) {
      $v = $reader[$c]
      if ($v -is [DBNull]) { $obj[$c] = '' } else { $obj[$c] = "$v" }
    }
    [void]$rows.Add((New-Object PSObject -Property $obj))
  }
  $reader.Close()
  $result = [ordered]@{ columns = @($cols); rows = @($rows); truncated = $hasMore }
  $result | ConvertTo-Json -Compress -Depth 6`;
}

function parseOdbcRows(output) {
  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed.rows) ? parsed.rows : (parsed.rows ? [parsed.rows] : []);
  const columns = Array.isArray(parsed.columns) ? parsed.columns : (parsed.columns ? [parsed.columns] : []);
  return {
    columns,
    rows,
    truncated: !!parsed.truncated,
  };
}

async function runOdbcSyncOnParent({ connectionString, sqlQuery }) {
  // 接続文字列の検証 & 読み取り専用属性の付与
  const connResult = enforceReadOnlyConnectionString(connectionString);
  if (!connResult.valid) {
    return { success: false, message: connResult.message };
  }
  const finalConnStr = connResult.connectionString;

  // SQLクエリの安全検証
  const queryResult = validateReadOnlyQuery(sqlQuery);
  if (!queryResult.valid) {
    return { success: false, message: queryResult.message };
  }

  if (!finalConnStr || !finalConnStr.includes('DSN=')) {
    return { success: false, message: '接続文字列にDSN指定が見つかりません。' };
  }

  const result = await execOdbcPowerShell(finalConnStr, buildOdbcRowFetchScript(sqlQuery, null), 30000);
  if (!result.success) {
    return { success: false, message: 'ODBC同期に失敗しました: ' + result.error };
  }

  let rows;
  try {
    rows = parseOdbcRows(result.output).rows;
  } catch (e) {
    return { success: false, message: '取得結果の解析に失敗しました: ' + e.message };
  }

  if (mainWindow) {
    getMainWindow().webContents.send('data-imported', {
      fileName: `ODBC同期 (${new Date().toLocaleString('ja-JP')})`,
      rows
    });
  }
  
  return { success: true, count: rows.length };
}

// IPC通信でODBC直接同期を実行する

async function previewOdbcQueryOnParent({ connectionString, sqlQuery } = {}) {
  const connResult = enforceReadOnlyConnectionString(connectionString);
  if (!connResult.valid) {
    return { success: false, message: connResult.message };
  }
  const finalConnStr = connResult.connectionString;

  const queryResult = validateReadOnlyQuery(sqlQuery);
  if (!queryResult.valid) {
    return { success: false, message: queryResult.message };
  }

  if (!finalConnStr || !finalConnStr.includes('DSN=')) {
    return { success: false, message: '接続文字列にDSN指定が見つかりません。' };
  }

  const result = await execOdbcPowerShell(finalConnStr, buildOdbcRowFetchScript(sqlQuery, 15), 20000);
  if (!result.success) {
    return { success: false, message: 'プレビューの取得に失敗しました: ' + result.error };
  }

  try {
    return { success: true, ...parseOdbcRows(result.output) };
  } catch (e) {
    return { success: false, message: '取得結果の解析に失敗しました: ' + e.message };
  }
}

// IPC通信でODBCクエリのプレビューを取得する。本番データには書き込まない。
handleTrusted('preview-odbc-query', (event, config) => previewOdbcQueryOnParent(config || {}));

module.exports = {
  configureOdbc,
  validateReadOnlyQuery,
  enforceReadOnlyConnectionString,
  sanitizeOdbcError,
  execOdbcPowerShell,
  getOdbcTablesOnParent,
  getOdbcDsnsOnParent,
  testOdbcConnectionOnParent,
  buildOdbcRowFetchScript,
  parseOdbcRows,
  runOdbcSyncOnParent,
  previewOdbcQueryOnParent,
};
