'use strict';

const SIGNALING_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_SIGNALING_ID_LENGTH = 128;
const MAX_SIGNALING_MESSAGE_BYTES = 256 * 1024;
const MAX_SIGNALING_QUEUE_KEYS = 256;
const MAX_SIGNALING_ACK_CLIENTS = 128;
const EXPIRATION_MS = 30_000;
const MAX_BROADCAST_QUEUE = 100;
const MAX_UNICAST_QUEUE = 50;
const BROADCAST_TYPES = new Set(['offer', 'speech', 'answered']);
const ALLOWED_TYPES = new Set(['offer', 'answer', 'ice', 'hangup', 'busy', 'speech', 'answered']);

function isSafeSignalingId(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_SIGNALING_ID_LENGTH && SIGNALING_ID_PATTERN.test(value);
}

function createWebrtcSignalingService({ now = () => Date.now() } = {}) {
  const queue = Object.create(null);
  const cleanupTimer = setInterval(() => {
    const current = now();
    for (const key of Object.keys(queue)) {
      queue[key] = queue[key].filter(item => current - item.timestamp < EXPIRATION_MS);
      if (queue[key].length === 0) delete queue[key];
    }
  }, 60_000);
  cleanupTimer.unref?.();

  function handle(method, urlPath, bodyStr = '') {
    const cleanUrl = String(urlPath || '').replace(/^\//, '');
    const [pathname, search] = cleanUrl.split('?');
    const action = pathname.replace(/^webrtc\//, '');
    const searchParams = new URLSearchParams(search || '');

    if (action === 'send') {
      if (method !== 'POST') return { success: false, message: 'Method Not Allowed' };
      let msg;
      try { msg = JSON.parse(bodyStr || '{}'); } catch { return { success: false, message: 'Invalid JSON' }; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        return { success: false, message: 'Invalid signaling message' };
      }
      if (!ALLOWED_TYPES.has(msg.type)) return { success: false, message: 'Unsupported signaling type' };
      if (!isSafeSignalingId(msg.to)) return { success: false, message: 'Missing or invalid "to" field' };
      if (msg.from !== undefined && !isSafeSignalingId(msg.from)) return { success: false, message: 'Invalid "from" field' };
      let serialized;
      try { serialized = JSON.stringify(msg); } catch { return { success: false, message: 'Invalid signaling message' }; }
      if (Buffer.byteLength(serialized, 'utf8') > MAX_SIGNALING_MESSAGE_BYTES) {
        return { success: false, message: 'Signaling message too large' };
      }

      const isBroadcast = BROADCAST_TYPES.has(msg.type);
      const key = isBroadcast ? `bc:${msg.to}` : msg.to;
      if (!queue[key] && Object.keys(queue).length >= MAX_SIGNALING_QUEUE_KEYS) {
        return { success: false, message: 'Signaling queue is busy' };
      }
      if (!queue[key]) queue[key] = [];
      const entry = {
        msg: { ...msg, msgId: `${now()}-${Math.random().toString(36).slice(2, 8)}` },
        timestamp: now(),
        ackedBy: Object.create(null),
      };
      const max = isBroadcast ? MAX_BROADCAST_QUEUE : MAX_UNICAST_QUEUE;
      if (queue[key].length >= max) queue[key].shift();
      queue[key].push(entry);
      return { success: true };
    }

    if (action === 'poll') {
      if (method !== 'GET') return { success: false, message: 'Method Not Allowed' };
      const id = searchParams.get('id');
      const client = searchParams.get('client') || id;
      if (!isSafeSignalingId(id)) return { success: false, message: 'Missing or invalid "id" parameter' };
      if (!isSafeSignalingId(client)) return { success: false, message: 'Missing or invalid "client" parameter' };
      const current = now();
      const bcKey = `bc:${id}`;
      const bcQueue = queue[bcKey] || [];
      const liveBcQueue = bcQueue.filter(item => current - item.timestamp < EXPIRATION_MS);
      if (liveBcQueue.length > 0) queue[bcKey] = liveBcQueue;
      else if (queue[bcKey]) delete queue[bcKey];
      const bcMessages = [];
      for (const item of liveBcQueue) {
        if (item.ackedBy[client]) continue;
        if (Object.keys(item.ackedBy).length >= MAX_SIGNALING_ACK_CLIENTS) continue;
        item.ackedBy[client] = current;
        bcMessages.push(item.msg);
      }
      const ucItems = queue[id] || [];
      delete queue[id];
      const ucMessages = ucItems
        .filter(item => current - item.timestamp < EXPIRATION_MS)
        .map(item => item.msg);
      return { success: true, messages: [...bcMessages, ...ucMessages] };
    }

    return { success: false, message: 'Not Found' };
  }

  return { handle, dispose: () => clearInterval(cleanupTimer) };
}

module.exports = { createWebrtcSignalingService };
