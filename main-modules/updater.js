'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { isPrivateOrLoopbackIpv4 } = require('./net-address');

const POWERSHELL_EXE = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

let readDB = null;
let writeDB = null;
let getSettingRecord = null;
let normalizeShareMode = null;
let isClientTerminal = null;
let appendAuditLog = null;
let dialog = null;
let app = null;
let getTerminalApiToken = null;
// 親機側は自分のトークンを必要に応じて発行する。子機側のgetTerminalApiTokenと
// 対になる依存で、どちらか片方だけが欠けると親子で挙動が食い違う
let ensureApiToken = null;
let getMainWindow = () => null;
let getDbFile = () => '';
let isManagedDeployment = () => false;
let EXPECTED_UPDATE_PUBLISHER = '';
let EXPECTED_UPDATE_PUBLISHER_THUMBPRINT = '';

function configureUpdater(deps) {
  readDB = deps.readDB;
  writeDB = deps.writeDB;
  getSettingRecord = deps.getSettingRecord;
  normalizeShareMode = deps.normalizeShareMode;
  isClientTerminal = deps.isClientTerminal;
  appendAuditLog = deps.appendAuditLog;
  dialog = deps.dialog;
  app = deps.app;
  getTerminalApiToken = deps.getTerminalApiToken;
  ensureApiToken = deps.ensureApiToken;
  getMainWindow = deps.getMainWindow;
  getDbFile = deps.getDbFile;
  isManagedDeployment = deps.isManagedDeployment;
  EXPECTED_UPDATE_PUBLISHER = deps.EXPECTED_UPDATE_PUBLISHER;
  EXPECTED_UPDATE_PUBLISHER_THUMBPRINT = deps.EXPECTED_UPDATE_PUBLISHER_THUMBPRINT;
}

// インストーラを直接spawnした直後にapp.quit()すると、旧exeのファイルロックが
// まだ解放されていないうちに新インストーラのサイレントアンインストール
// (electron-builder製NSISは旧バージョンを検出すると新規インストール前に
// 自動でこれを実行する)が走ってしまい、「古いアプリをアンインストールできません」
// という失敗の主因になっていた。app.quit()自体は非同期(before-quitでの
// HTTPサーバー停止・ウォッチャー停止等の後始末を含む)で、その所要時間は
// 接続端末数や状況によって変動するため、固定の待機時間では確実性が無い。
// PowerShellのWait-Processで自プロセス(PID)の実際の終了をポーリングし、
// それを確認してからインストーラを起動するラッパーを挟むことで、
// シャットダウン処理の所要時間に関わらずファイルロックの解放を待ってから
// インストーラが走るようにする(最大30秒待って、それでも終了しなければ
// 諦めて起動する。無期限にハングしないための安全弁)。
function spawnInstallerAfterOwnExit(installerPath) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$installerPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRANSBOARD_INSTALLER_PATH_B64))
$parentPid = [int]$env:TRANSBOARD_WAIT_PID
try { Wait-Process -Id $parentPid -Timeout 30 } catch {}
Start-Process -FilePath $installerPath -ArgumentList '/S' -WindowStyle Hidden
`.trim();
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(
    POWERSHELL_EXE,
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedCommand],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        TRANSBOARD_INSTALLER_PATH_B64: Buffer.from(installerPath, 'utf8').toString('base64'),
        TRANSBOARD_WAIT_PID: String(process.pid),
      },
    }
  );
  child.unref();
}

function registerUpdaterIpc(handleTrusted) {
  handleTrusted('check-for-update', async (event, { parentIp } = {}) => {
    try {
      const ymlText = await httpGetText(`${buildUpdateFeedBase(parentIp)}/latest.yml`, {
        headers: getUpdateRequestHeaders(),
      });
      const info = parseLatestYml(ymlText);
      if (!validateUpdateInfo(info)) {
        return { success: false, message: 'latest.ymlの形式が不正です' };
      }
      const currentVersion = app.getVersion();
      return {
        success: true,
        updateAvailable: compareVersions(info.version, currentVersion) > 0,
        latestVersion: info.version,
        currentVersion,
        fileName: info.path
      };
    } catch (e) {
      return { success: false, message: e.message };
    }
  });

  handleTrusted('download-and-install-update', async (event, { parentIp } = {}) => {
    try {
      if (isPerMachineInstall()) {
        // 同じ「Program Files配下で自己更新できない」状態でも、原因と取るべき行動は
        // 正反対になる。管理配布された端末で「アンインストールして入れ直せ」と案内すると
        // 利用者が管理外の操作をしてしまうため、配布元へ案内する
        return {
          success: false,
          message: isManagedDeployment()
            ? 'この端末はシステム管理者によって配布・管理されています。更新は管理者が一括で配布しますので、担当者へご連絡ください。'
            : 'このインストールは旧バージョン(Program Files配下)のため自動更新できません。管理者権限のあるユーザーで、現在のバージョンをアンインストールしてから新しいインストーラを手動で実行してください(一度だけの作業です。以後は自動更新が有効になります)。',
        };
      }
      const feedBase = buildUpdateFeedBase(parentIp);
      const isChildTerminal = isClientTerminal(readDB());
      const ymlText = await httpGetText(`${feedBase}/latest.yml`, {
        headers: getUpdateRequestHeaders(),
      });
      const info = parseLatestYml(ymlText);
      if (!validateUpdateInfo(info)) {
        return { success: false, message: 'latest.ymlの形式が不正です' };
      }
      if (compareVersions(info.version, app.getVersion()) <= 0) {
        return { success: false, message: '配信中のバージョンは現行より新しくありません' };
      }
  
      const tmpDir = path.join(app.getPath('temp'), 'transboard-update');
      fs.mkdirSync(tmpDir, { recursive: true });
      const installerPath = path.join(tmpDir, path.basename(info.path));
      const actualSha512 = await downloadToFileWithHash(
        `${feedBase}/${encodeURIComponent(path.basename(info.path))}`,
        installerPath,
        { headers: getUpdateRequestHeaders() }
      );
  
      if (actualSha512 !== info.sha512) {
        try { fs.unlinkSync(installerPath); } catch {}
        return { success: false, message: 'ダウンロードファイルの検証(sha512)に失敗しました。ファイルが破損しているか、改ざんされている可能性があります' };
      }
  
      const signatureResult = verifyWindowsCodeSignature(installerPath);
      if (!signatureResult.success) {
        if (!signatureResult.unsigned) {
          try { fs.unlinkSync(installerPath); } catch {}
          return signatureResult;
        }
        const unsignedConfirmation = await confirmUnsignedUpdate({
          version: info.version,
          fileName: info.path,
          sha512: info.sha512,
          feedBase,
          autoAcceptForChild: isChildTerminal,
        });
        if (!unsignedConfirmation.accepted) {
          try { fs.unlinkSync(installerPath); } catch {}
          return { success: false, message: unsignedConfirmation.message };
        }
        if (!isChildTerminal) {
          console.warn(`[Updater] 署名なし更新を管理者確認により許可: v${info.version}`);
        }
      }
  
      // 更新起因の万一の破損に備え、既存の.bakローリングとは別にDBを退避
      try {
        if (fs.existsSync(getDbFile())) fs.copyFileSync(getDbFile(), `${getDbFile()}.before_update`);
      } catch (e) {
        console.warn('[Updater] 更新前バックアップに失敗:', e.message);
      }
  
      console.log(`[Updater] v${info.version} のインストールを開始します`);
      spawnInstallerAfterOwnExit(installerPath);
      app.quit();
      return { success: true, version: info.version };
    } catch (e) {
      return { success: false, message: e.message };
    }
  });

  handleTrusted('get-update-dist-info', () => {
    try {
      const updatesDir = getUpdatesDir();
      const ymlPath = path.join(updatesDir, 'latest.yml');
      let serving = null;
      if (fs.existsSync(ymlPath)) {
        const info = parseLatestYml(fs.readFileSync(ymlPath, 'utf8'));
        const exeExists = info.path && fs.existsSync(path.join(updatesDir, path.basename(info.path)));
        serving = { version: info.version, fileName: info.path, fileExists: exeExists };
      }
      const archiveDir = path.join(updatesDir, 'archive');
      let archived = null;
      if (fs.existsSync(path.join(archiveDir, 'latest.yml'))) {
        const info = parseLatestYml(fs.readFileSync(path.join(archiveDir, 'latest.yml'), 'utf8'));
        archived = { version: info.version };
      }
      return { success: true, serving, archived, currentVersion: app.getVersion() };
    } catch (e) {
      return { success: false, message: e.message };
    }
  });

  handleTrusted('import-update-files', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
        title: '更新ファイルを選択（latest.yml とインストーラ .exe の両方）',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '更新ファイル (latest.yml, *.exe)', extensions: ['yml', 'exe'] }]
      });
      if (canceled || !filePaths || filePaths.length === 0) return { success: false, canceled: true };
  
      const ymlSrc = filePaths.find(f => f.toLowerCase().endsWith('.yml'));
      const exeSrc = filePaths.find(f => f.toLowerCase().endsWith('.exe'));
      if (!ymlSrc || !exeSrc) {
        return { success: false, message: 'latest.yml とインストーラ(.exe)の両方を選択してください' };
      }
  
      const info = parseLatestYml(fs.readFileSync(ymlSrc, 'utf8'));
      if (!validateUpdateInfo(info)) {
        return { success: false, message: 'latest.ymlの形式が不正です（version/path/sha512が必要）' };
      }
      if (path.basename(exeSrc) !== info.path) {
        return { success: false, message: 'latest.ymlに記載されたファイル名とインストーラ名が一致しません' };
      }
  
      // 壊れた・組み合わせ違いのファイルを配信しないよう、取込時点でsha512を照合
      const actualSha512 = await sha512OfFile(exeSrc);
      if (actualSha512 !== info.sha512) {
        return { success: false, message: 'インストーラとlatest.ymlのsha512が一致しません。ダウンロードし直すか、同じリリースの組み合わせか確認してください' };
      }
      const signatureResult = verifyWindowsCodeSignature(exeSrc);
      if (!signatureResult.success) {
        if (!signatureResult.unsigned) return signatureResult;
        const unsignedConfirmation = await confirmUnsignedUpdate({
          version: info.version,
          fileName: info.path,
          sha512: info.sha512,
        });
        if (!unsignedConfirmation.accepted) {
          return { success: false, message: unsignedConfirmation.message };
        }
        console.warn(`[Updater] 署名なし配信を管理者確認により許可: v${info.version}`);
      }
  
      const updatesDir = getUpdatesDir();
      const archiveDir = path.join(updatesDir, 'archive');
      fs.mkdirSync(updatesDir, { recursive: true });
      fs.mkdirSync(archiveDir, { recursive: true });
  
      // 現在配信中のファイルを archive へ退避（1世代・ロールバック用）
      const currentYml = path.join(updatesDir, 'latest.yml');
      if (fs.existsSync(currentYml)) {
        for (const f of fs.readdirSync(archiveDir)) {
          try { fs.unlinkSync(path.join(archiveDir, f)); } catch {}
        }
        for (const f of fs.readdirSync(updatesDir)) {
          const p = path.join(updatesDir, f);
          if (fs.statSync(p).isFile()) fs.renameSync(p, path.join(archiveDir, f));
        }
      }
  
      // 子機は latest.yml の path 名で取得するため、exeはその名前で配置する
      fs.copyFileSync(exeSrc, path.join(updatesDir, path.basename(info.path)));
      fs.copyFileSync(ymlSrc, path.join(updatesDir, 'latest.yml'));
  
      {
        const db = readDB();
        appendAuditLog(db, 'UPDATE_DIST_IMPORT', {
          targetType: 'updates',
          targetId: info.version,
          actorType: 'local_ui',
          details: { version: info.version, fileName: path.basename(info.path) },
        });
        if (!writeDB(db)) {
          console.warn(`[AuditLog] 配信ファイル取込の監査ログの永続化に失敗しました: v${info.version}`);
        }
      }
      console.log(`[Updater] 配信ファイルを取込: v${info.version}`);
      return { success: true, version: info.version };
    } catch (e) {
      return { success: false, message: e.message };
    }
  });

  handleTrusted('rollback-update-dist', () => {
    try {
      const updatesDir = getUpdatesDir();
      const archiveDir = path.join(updatesDir, 'archive');
      if (!fs.existsSync(path.join(archiveDir, 'latest.yml'))) {
        return { success: false, message: 'ロールバック可能な旧バージョンがありません' };
      }
      // 現行の配信ファイルを削除し、archiveの内容を昇格
      for (const f of fs.readdirSync(updatesDir)) {
        const p = path.join(updatesDir, f);
        if (fs.statSync(p).isFile()) fs.unlinkSync(p);
      }
      for (const f of fs.readdirSync(archiveDir)) {
        fs.renameSync(path.join(archiveDir, f), path.join(updatesDir, f));
      }
      const info = parseLatestYml(fs.readFileSync(path.join(updatesDir, 'latest.yml'), 'utf8'));
      {
        const db = readDB();
        appendAuditLog(db, 'UPDATE_DIST_ROLLBACK', {
          targetType: 'updates',
          targetId: info.version,
          actorType: 'local_ui',
          details: { version: info.version },
        });
        if (!writeDB(db)) {
          console.warn(`[AuditLog] 配信ファイルロールバックの監査ログの永続化に失敗しました: v${info.version}`);
        }
      }
      console.log(`[Updater] 配信をロールバック: v${info.version}`);
      return { success: true, version: info.version };
    } catch (e) {
      return { success: false, message: e.message };
    }
  });
}

// ── アプリ自動更新（自前軽量アップデータ） ──
// 親機の /updates/ から electron-builder 標準の latest.yml を取得し、
// バージョン比較 → sha512検証付きダウンロード → per-userインストーラのサイレント起動を行う。
// per-userインストール（nsis.perMachine:false）のためUAC昇格は発生しない。

// latest.yml から必要フィールドのみ抽出する簡易パーサ（YAML全文法は不要）
function parseLatestYml(text) {
  const result = { version: null, path: null, sha512: null };
  for (const rawLine of String(text).split(/\r?\n/)) {
    // トップレベルのキーのみ対象（インデント行は files: 配下なので無視）
    const m = rawLine.match(/^(version|path|sha512):\s*(.+)$/);
    if (m && result[m[1]] === null) {
      result[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return result;
}

function validateUpdateInfo(info) {
  if (!info || typeof info !== 'object') return false;
  if (!/^\d+\.\d+\.\d+$/.test(String(info.version || ''))) return false;
  const fileName = String(info.path || '');
  if (!fileName || fileName !== path.basename(fileName) || !fileName.toLowerCase().endsWith('.exe')) {
    return false;
  }
  return /^[A-Za-z0-9+/]{80,}={0,2}$/.test(String(info.sha512 || ''));
}

// セマンティックバージョン比較: a > b なら正、a < b なら負、同じなら0
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function getUpdateApiToken() {
  const db = readDB();
  const shareMode = normalizeShareMode(getSettingRecord(db, 'share_mode')?.value);
  if (shareMode === 'parent') return ensureApiToken();
  const terminalToken = getTerminalApiToken();
  if (!terminalToken.success || !terminalToken.token) {
    throw new Error('更新用APIトークンを取得できません');
  }
  return terminalToken.token;
}

function getUpdateRequestHeaders() {
  return { 'X-API-Token': getUpdateApiToken() };
}

function getUpdateRequestOptions(url, headers) {
  const requestOptions = { headers };
  if (String(url).startsWith('https:') && process.env.TRANSBOARD_UPDATE_CA_FILE) {
    const caPath = path.resolve(process.env.TRANSBOARD_UPDATE_CA_FILE);
    requestOptions.ca = fs.readFileSync(caPath);
  }
  return requestOptions;
}

function httpGetText(url, { timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const transport = String(url).startsWith('https:') ? https : http;
    const req = transport.get(url, getUpdateRequestOptions(url, headers), res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let totalBytes = 0;
      res.on('data', c => {
        totalBytes += c.length;
        if (totalBytes > 128 * 1024) {
          req.destroy(new Error('更新メタデータが大きすぎます'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('接続がタイムアウトしました')));
  });
}

// URLからファイルへストリーム保存しつつsha512(base64)を計算して返す
function downloadToFileWithHash(url, destPath, { timeoutMs = 300000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (error) => {
      try { fs.unlinkSync(destPath); } catch {}
      reject(error);
    };
    const transport = String(url).startsWith('https:') ? https : http;
    const req = transport.get(url, getUpdateRequestOptions(url, headers), res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const hash = crypto.createHash('sha512');
      const out = fs.createWriteStream(destPath);
      let totalBytes = 0;
      res.on('data', c => {
        totalBytes += c.length;
        if (totalBytes > 250 * 1024 * 1024) {
          req.destroy(new Error('更新ファイルが許容サイズを超えています'));
          out.destroy();
          return;
        }
        hash.update(c);
      });
      res.pipe(out);
      out.on('finish', () => resolve(hash.digest('base64')));
      out.on('error', fail);
      res.on('error', fail);
    });
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('ダウンロードがタイムアウトしました')));
  });
}

function sha512OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const s = fs.createReadStream(filePath);
    s.on('data', c => hash.update(c));
    s.on('end', () => resolve(hash.digest('base64')));
    s.on('error', reject);
  });
}

function getUpdatesDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function verifyWindowsCodeSignature(filePath) {
  if (process.platform !== 'win32') {
    return { success: false, message: '更新署名の検証はWindowsでのみ実行できます' };
  }
  if (!EXPECTED_UPDATE_PUBLISHER && !EXPECTED_UPDATE_PUBLISHER_THUMBPRINT) {
    return {
      success: false,
      unsigned: true,
      message: '更新署名の発行者または証明書フィンガープリントが未設定です。管理者に連絡してください',
    };
  }

  const script = `
$ErrorActionPreference = 'Stop'
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRANSBOARD_SIGNATURE_PATH_B64))
$sig = Get-AuthenticodeSignature -LiteralPath $path
$name = if ($sig.SignerCertificate) {
  $sig.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
} else { '' }
$thumbprint = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { '' }
[PSCustomObject]@{ status = [string]$sig.Status; publisher = [string]$name; thumbprint = [string]$thumbprint } | ConvertTo-Json -Compress
`.trim();

  try {
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    const output = execFileSync(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          TRANSBOARD_SIGNATURE_PATH_B64: Buffer.from(filePath, 'utf8').toString('base64'),
        },
      }
    ).trim();
    const signature = JSON.parse(output);
    const publisherConfigured = Boolean(EXPECTED_UPDATE_PUBLISHER);
    const thumbprintConfigured = Boolean(EXPECTED_UPDATE_PUBLISHER_THUMBPRINT);
    const publisherMatches = !publisherConfigured || String(signature.publisher || '').localeCompare(
      EXPECTED_UPDATE_PUBLISHER,
      undefined,
      { sensitivity: 'accent' }
    ) === 0;
    const thumbprintMatches = !thumbprintConfigured ||
      String(signature.thumbprint || '').replace(/[^0-9a-f]/gi, '').toUpperCase() === EXPECTED_UPDATE_PUBLISHER_THUMBPRINT;
    if (signature.status !== 'Valid' || !publisherMatches || !thumbprintMatches) {
      return { success: false, message: '更新ファイルのデジタル署名を確認できませんでした' };
    }
    return {
      success: true,
      publisher: signature.publisher,
      thumbprint: signature.thumbprint,
      matchedBy: thumbprintConfigured ? 'thumbprint' : 'publisher'
    };
  } catch (error) {
    console.warn('[Updater] Authenticode検証に失敗:', error.message);
    return { success: false, message: '更新ファイルのデジタル署名検証に失敗しました' };
  }
}

// 未署名更新を「そもそも許可するか」のゆるいゲート。公開IPv4アドレスへの
// 平文HTTP（中間者攻撃を受けやすい典型例）だけを明確に拒否し、ホスト名
// （形式だけでは院内LANか公開ホストか判別できない）は通す。
// parent_ip は機器名・mDNS/WINS名等で運用されることもあり、ドット区切り
// IPv4の見た目チェックだけだと一律で拒否され、子機側で回復手段が無いまま
// 更新が永久にブロックされてしまう。ここを通過しても即座に無条件で
// 許可されるわけではなく、この先で人手のダイアログ確認（もしくは
// isStronglyTrustedUpdateSourceを満たす場合のみ子機の自動承認）を経る。
// isUnsignedUpdateSourceAllowed/isStronglyTrustedUpdateSourceの両方が使う
// 「HTTPS・localhost・プライベートIPv4のいずれか＝形式上明確に安全な経路」の判定
function isDefinitelySecureUpdateSource(source) {
  return source.protocol === 'https:' ||
    source.hostname === 'localhost' ||
    isPrivateOrLoopbackIpv4(source.hostname);
}

function isUnsignedUpdateSourceAllowed(feedBase) {
  if (!feedBase) return true;
  try {
    const source = new URL(feedBase);
    if (isDefinitelySecureUpdateSource(source)) return true;
    return !/^\d{1,3}(\.\d{1,3}){3}$/.test(source.hostname);
  } catch {
    return false;
  }
}

// 子機の自動承認に使う、より厳格な判定。HTTPS・localhost・プライベートIPv4
// アドレスなど「形式から明確に院内LAN/暗号化通信と分かるもの」のみを対象とし、
// ホスト名（parent_ipが機器名等で運用されているケース）はここでは対象外とする。
// ホスト名は文字列の形だけでは実際に院内LAN上のものか判別できないため
// （isUnsignedUpdateSourceAllowedで一律拒否はしないが）、子機であっても
// 人手のダイアログ確認を残す。これにより、子機の自動承認は「明確に安全な
// 経路」に限定しつつ、ホスト名運用の場合でも従来のように更新自体が
// 完全にブロックされることはない（人手で1回確認すれば通せる）。
function isStronglyTrustedUpdateSource(feedBase) {
  if (!feedBase) return true;
  try {
    const source = new URL(feedBase);
    return source.protocol === 'https:' ||
      source.hostname === 'localhost' ||
      isPrivateOrLoopbackIpv4(source.hostname);
  } catch {
    return false;
  }
}

async function confirmUnsignedUpdate({ version, fileName, sha512, feedBase = null, autoAcceptForChild = false } = {}) {
  if (!isUnsignedUpdateSourceAllowed(feedBase)) {
    return {
      accepted: false,
      message: '署名なし更新は院内LANまたはHTTPSの更新元からのみ許可されます',
    };
  }

  // 子機が親機から取得する更新ファイルは、親機側で取込時(import-update-files)に
  // 管理者が同じ確認ダイアログを既に一度通過しており、SHA-512整合性検証も
  // 呼び出し元で実施済みのため、子機ごとに同じ警告への再クリックを求めるのは
  // 実質的な安全性向上を伴わない手間であり、無人稼働中の子機で誤って
  // 「更新を中止」を押してしまう(＝更新が終わらない)主要因になっていた。
  // 子機ではこの人手による再確認を省略し、自動的に許可する。
  // ただし、この自動承認は isStronglyTrustedUpdateSource を満たす場合のみに
  // 限定する。parent_ipがホスト名で運用されている等、形式からは院内LANかを
  // 判別できないケースでは、子機であっても引き続き人手のダイアログ確認を求める
  // (isUnsignedUpdateSourceAllowed自体はホスト名も通すため、更新自体が完全に
  // ブロックされることはないが、無人での自動承認はしない)。
  if (autoAcceptForChild && isStronglyTrustedUpdateSource(feedBase)) {
    console.warn(`[Updater] 子機更新: 親機で検証済みの配布ファイルのため署名なし確認をスキップして続行します: v${version || '?'}`);
    return { accepted: true };
  }

  const result = await dialog.showMessageBox(getMainWindow(), {
    type: 'warning',
    title: '署名なし更新の確認',
    buttons: ['更新を中止', '署名なしで続行'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: `v${version || '?'} の更新ファイルにコード署名がありません`,
    detail: [
      feedBase
        ? 'APIトークン認証とSHA-512整合性検証は実施済みです。'
        : '選択したlatest.ymlとインストーラーのSHA-512整合性検証は実施済みです。',
      '配布元とハッシュ値を管理者が確認した場合のみ続行してください。',
      `ファイル: ${fileName || '?'}`,
      `SHA-512: ${sha512 || '?'}`,
    ].join('\n'),
  });
  return result.response === 1
    ? { accepted: true }
    : { accepted: false, message: '署名なし更新はキャンセルされました' };
}

// 更新フィードURLの組み立て。子機はparentIp指定、親機は自分自身(ループバック)を参照
function buildUpdateFeedBase(parentIp) {
  const configuredBase = String(process.env.TRANSBOARD_UPDATE_BASE_URL || '').trim();
  if (configuredBase) {
    let parsed;
    try { parsed = new URL(configuredBase); } catch { throw new Error('更新URLの形式が不正です'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('更新URLの形式が不正です');
    }
    return parsed.href.replace(/\/+$/, '');
  }
  const db = readDB();
  const shareMode = normalizeShareMode(getSettingRecord(db, 'share_mode')?.value);
  const configuredParentIp = String(getSettingRecord(db, 'parent_ip')?.value || '').trim();
  const requestedHost = String(parentIp || '').trim();
  const host = shareMode === 'parent' ? '127.0.0.1' : configuredParentIp;
  if (!host || (requestedHost && requestedHost !== host)) {
    throw new Error('更新元の親機アドレスが設定と一致しません');
  }
  return `http://${host}:3005/updates`;
}

// 更新チェック: latest.yml を取得し現行バージョンと比較する

// v1.1.x以前は allowToChangeInstallationDirectory:true かつ perMachine未指定
// という設定で配布されており、これはelectron-builder/NSISの既知の落とし穴で
// 実質per-machineインストール(Program Files配下、HKLMにアンインストーラ登録)
// になっていた(docs/manual.mdの「旧バージョン(Program Files版)からの移行」参照)。
// 現行のper-userインストーラでこれを自動更新しようとすると、新インストーラが
// 旧バージョンの自動アンインストール(HKLM登録分)を試みて管理者権限昇格を
// 要求するが、その昇格はspawnInstallerAfterOwnExit後・app.quit()後に起こる
// ため失敗してもアプリ側で検知できず、ユーザーには「なぜか更新できない」という
// 不可解な失敗に見える。ダウンロード前に検出し、明確な案内を返す。
function isPerMachineInstall() {
  if (process.platform !== 'win32') return false;
  const exePath = String(process.execPath || '').toLowerCase();
  const programFilesRoots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432'],
  ].filter(Boolean).map(p => p.toLowerCase());
  return programFilesRoots.some(root => exePath.startsWith(root));
}

// 更新のダウンロード → sha512検証 → DB退避 → サイレントインストール起動

// ── 親機の配信管理（取込・状況・ロールバック） ──

// updatesフォルダ内の配信状況を返す

// 更新ファイルの取込: latest.yml と .exe を選択させ、sha512整合を検証してから配信位置へコピー

// ロールバック: archive内の旧配信ファイルを配信位置へ戻す

module.exports = {
  configureUpdater,
  registerUpdaterIpc,
};
