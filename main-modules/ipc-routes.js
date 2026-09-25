'use strict';

// ローカルIPC db-request で通すコマンド。テーブルCRUDは tables/<許可テーブル>。
// parent-actions と webrtc は別経路（HTTPの親機API、webrtc-request）に残す。
const LOCAL_DB_COMMANDS = new Set([
  'device/heartbeat',
  'device/list',
  'device/disconnect',
  'audit/write',
  'status/update',
  'status/note',
  'status/ack',
  'transfer/start',
]);

function isAllowedLocalDbRequestUrl(url, allowedTables) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  if (!(allowedTables instanceof Set)) return false;
  const pathOnly = url.split('?')[0].replace(/^\//, '');
  if (!pathOnly || pathOnly.includes('\\') || pathOnly.includes('#')) return false;
  const segments = pathOnly.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false;
  if (LOCAL_DB_COMMANDS.has(pathOnly)) return true;
  if (segments[0] !== 'tables' || segments.length < 2) return false;
  return allowedTables.has(segments[1]);
}

function isAllowedWebrtcRequestUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  const pathOnly = url.split('?')[0].replace(/^\//, '');
  return pathOnly === 'webrtc/send' || pathOnly === 'webrtc/poll';
}

module.exports = {
  LOCAL_DB_COMMANDS,
  isAllowedLocalDbRequestUrl,
  isAllowedWebrtcRequestUrl,
};
