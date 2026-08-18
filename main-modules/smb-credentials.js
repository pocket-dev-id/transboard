'use strict';

// スケジュール取り込み／CSV取り込みが使うSMB共有(UNCパス)の認証まわりの純粋ロジック。
// main.jsはelectronをrequireするため単体テストから読み込めない。ここへ切り出すことで
// scripts/check-schedule-feed-smb.js から直接requireして挙動を検証できるようにする。

// 子機へ機密設定を返すときのマスク値(main.jsの外部GETマスクと共有する)。
// この値が書き込み要求として戻ってきた場合は「変更なし」とみなして保存しない。
const MASKED_SECRET_VALUE = '********';

// フィード個別のSMBパスワードは system_settings に
// `smb_password__<feedId>` というIDで保存する。schedule_feeds行に直接
// 置くと、暗号化・子機マスク・監査マスク・エクスポート除外の4機構
// (いずれもsystem_settings限定)がまったく効かないため。
const SMB_FEED_PASSWORD_PREFIX = 'smb_password__';

function isFeedSmbPasswordSettingId(id) {
  return String(id || '').startsWith(SMB_FEED_PASSWORD_PREFIX);
}

function feedSmbPasswordSettingId(feedId) {
  return `${SMB_FEED_PASSWORD_PREFIX}${feedId}`;
}

// 旧ウィザードは 'credential' を書き込んでいたが、main.js・設定画面はいずれも
// 'custom' しか解釈しない(=ウィザードで設定した認証情報が一度も効いていなかった)。
// 読み取り側で吸収し、既存端末の値が自動的に復旧するようにする。
function normalizeGlobalSmbMode(value) {
  const v = String(value || '').trim();
  if (v === 'credential' || v === 'custom') return 'custom';
  return 'current';
}

// フィード側は共通設定の継承(inherit)が既定。フィールド自体を持たない
// 既存レコードも同じ扱いになる。
function normalizeFeedSmbMode(value) {
  const v = String(value || '').trim();
  if (v === 'credential' || v === 'custom') return 'custom';
  if (v === 'current') return 'current';
  return 'inherit';
}

// `\\server\share\sub\dir` から接続対象を取り出す。UNC以外はnull。
function parseUncTarget(watchPath) {
  const raw = String(watchPath || '');
  if (!raw.startsWith('\\\\')) return null;
  const parts = raw.split('\\').filter(p => p.length > 0);
  if (parts.length < 2) return null;
  const server = parts[0];
  const share = parts[1];
  return {
    server,
    share,
    target: `\\\\${server}\\${share}`,
    serverKey: server.toLowerCase(),
    shareKey: `\\\\${server}\\${share}`.toLowerCase(),
  };
}

// 資格情報の等値比較にのみ使う。ログ・レスポンスへは絶対に出さないこと。
function credentialFingerprint(username, password) {
  return `${String(username || '').toLowerCase()}\0${String(password || '')}`;
}

// フィードの設定と共通設定から、実際に使う資格情報を決める。
function resolveFeedSmbCredentials(feed, globalCredentials) {
  const mode = normalizeFeedSmbMode(feed && feed.smb_auth_mode);
  if (mode === 'inherit') {
    return { ...globalCredentials, source: 'global' };
  }
  if (mode === 'current') {
    return { mode: 'current', username: '', password: '', source: 'feed' };
  }
  return {
    mode: 'custom',
    username: String((feed && feed.smb_username) || '').trim(),
    password: String((feed && feed.smb_password) || '').trim(),
    source: 'feed',
  };
}

// Windowsはサーバー単位でしか資格情報を保持できず、同一サーバーへ別の資格情報で
// 2本目を張るとシステムエラー1219になる。さらに、稼働中のchokidarが掴んでいる共有を
// `net use /delete` すると監視は生きたままイベントが二度と来ない無言故障になる。
// どの共有をこのプロセスが張ったかを記録し、不要な張り直しと破壊的な切断を避ける。
function createSmbSessionRegistry() {
  const sessions = new Map(); // serverKey -> { fingerprint, shares:Set<shareKey>, targets:Map<shareKey,target> }

  function plan(uncTarget, fingerprint) {
    const existing = sessions.get(uncTarget.serverKey);
    if (!existing) {
      // 初回のみ前回起動の残骸を掃除してから接続する
      return { action: 'connect', deleteFirst: true, sharesToDelete: [] };
    }
    if (existing.fingerprint !== fingerprint) {
      return {
        action: 'conflict',
        deleteFirst: false,
        sharesToDelete: [],
        message: `同一サーバー（\\\\${uncTarget.server}）に対して別の資格情報が指定されています。`
          + 'Windowsの制限により1台のサーバーには1組の資格情報しか同時に使用できません。'
          + '資格情報を統一するか、別のホスト名/IPで指定してください。',
      };
    }
    if (existing.shares.has(uncTarget.shareKey)) {
      return { action: 'skip', deleteFirst: false, sharesToDelete: [] };
    }
    // 同一資格情報なら、SMBは1セッションで複数共有を多重化できるので切断は不要
    return { action: 'connect', deleteFirst: false, sharesToDelete: [] };
  }

  function commit(uncTarget, fingerprint) {
    let entry = sessions.get(uncTarget.serverKey);
    if (!entry || entry.fingerprint !== fingerprint) {
      entry = { fingerprint, shares: new Set(), targets: new Map() };
      sessions.set(uncTarget.serverKey, entry);
    }
    entry.shares.add(uncTarget.shareKey);
    entry.targets.set(uncTarget.shareKey, uncTarget.target);
  }

  // 利用者がいなくなったサーバーの共有を切断対象として返し、記録から落とす。
  // これをやらないと、フィード削除後に同じサーバーを別資格情報で使おうとした
  // 瞬間にOSレベルで1219になる。このプロセスが張った共有だけを対象にする。
  function prune(activeServerKeys) {
    const active = new Set(activeServerKeys || []);
    const targetsToDelete = [];
    for (const [serverKey, entry] of sessions) {
      if (active.has(serverKey)) continue;
      for (const target of entry.targets.values()) targetsToDelete.push(target);
      sessions.delete(serverKey);
    }
    return targetsToDelete;
  }

  function servers() {
    return [...sessions.keys()];
  }

  function reset() {
    sessions.clear();
  }

  return { plan, commit, prune, servers, reset };
}

module.exports = {
  MASKED_SECRET_VALUE,
  SMB_FEED_PASSWORD_PREFIX,
  isFeedSmbPasswordSettingId,
  feedSmbPasswordSettingId,
  normalizeGlobalSmbMode,
  normalizeFeedSmbMode,
  parseUncTarget,
  credentialFingerprint,
  resolveFeedSmbCredentials,
  createSmbSessionRegistry,
};
