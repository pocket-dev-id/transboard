'use strict';

const http = require('http');

let readDbShared = null;
let getSettingRecord = null;
let normalizeShareMode = null;

function configureParentHttp(deps) {
  readDbShared = deps.readDbShared;
  getSettingRecord = deps.getSettingRecord;
  normalizeShareMode = deps.normalizeShareMode;
}

// 子機から親機へのHTTPリクエストはmainプロセスで中継する。ただしrendererが
// 任意のLAN/ローカルサービスへ接続できないよう、設定済み親機のAPIだけに制限する。
const ALLOWED_PARENT_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_PARENT_HTTP_HEADERS = new Set(['content-type', 'x-api-token', 'x-terminal-role']);
const MAX_PARENT_REQUEST_BYTES = 1024 * 1024;
const MAX_PARENT_RESPONSE_BYTES = 5 * 1024 * 1024;

function isPrivateOrLoopbackIpv4(hostname) {
  const parts = String(hostname || '').split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function normalizeParentHttpRequest(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new Error('INVALID_REQUEST');
  }

  // 子機→親機への全リクエストが通る中継経路であり、read-onlyでshare_mode/parent_ipの
  // 2設定を読むだけのため、DB全体のディープコピーは不要
  const db = readDbShared();
  const shareMode = normalizeShareMode(getSettingRecord(db, 'share_mode')?.value);
  const configuredParentIp = String(getSettingRecord(db, 'parent_ip')?.value || '').trim();
  const allowedHosts = new Set();
  if (shareMode === 'parent') {
    allowedHosts.add('127.0.0.1');
    allowedHosts.add('localhost');
  } else if (configuredParentIp) {
    allowedHosts.add(configuredParentIp.toLowerCase());
  }

  let parsed;
  try {
    parsed = new URL(String(opts.url || ''));
  } catch {
    throw new Error('INVALID_URL');
  }
  const isConnectionTest = opts.purpose === 'connection-test';
  const isAllowedConnectionTest = (
    isConnectionTest &&
    isPrivateOrLoopbackIpv4(parsed.hostname) &&
    (parsed.pathname === '/api/tables/wards' || parsed.pathname === '/api/tables/beds')
  );
  const isConfiguredEndpoint = (
    allowedHosts.has(parsed.hostname.toLowerCase()) &&
    (parsed.pathname.startsWith('/api/') || parsed.pathname.startsWith('/updates/'))
  );
  if (
    parsed.protocol !== 'http:' ||
    parsed.port !== '3005' ||
    (!isConfiguredEndpoint && !isAllowedConnectionTest)
  ) {
    throw new Error('ENDPOINT_NOT_ALLOWED');
  }
  if (parsed.username || parsed.password) {
    throw new Error('ENDPOINT_NOT_ALLOWED');
  }

  const method = String(opts.method || 'GET').toUpperCase();
  if (!ALLOWED_PARENT_HTTP_METHODS.has(method)) {
    throw new Error('METHOD_NOT_ALLOWED');
  }
  if (isConnectionTest && method !== 'GET') {
    throw new Error('METHOD_NOT_ALLOWED');
  }

  const body = typeof opts.body === 'string' ? opts.body : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_PARENT_REQUEST_BYTES) {
    throw new Error('REQUEST_TOO_LARGE');
  }

  const headers = {};
  if (opts.headers && typeof opts.headers === 'object' && !Array.isArray(opts.headers)) {
    for (const [name, value] of Object.entries(opts.headers)) {
      const normalizedName = String(name).toLowerCase();
      if (!ALLOWED_PARENT_HTTP_HEADERS.has(normalizedName)) continue;
      if (typeof value !== 'string' || value.length > 1024) {
        throw new Error('INVALID_HEADER');
      }
      headers[normalizedName] = value;
    }
  }

  const requestedTimeout = Number(opts.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(Math.max(Math.trunc(requestedTimeout), 1000), 30000)
    : 8000;

  return { url: parsed, method, headers, body, timeoutMs };
}

function parentHttpRequest(opts) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let request;
    try {
      request = normalizeParentHttpRequest(opts);
    } catch (e) {
      finish({ ok: false, status: 0, error: e.message || 'INVALID_REQUEST' });
      return;
    }

    let req;
    try {
      req = http.request(request.url, {
        method: request.method,
        headers: request.headers,
        timeout: request.timeoutMs,
      }, (res) => {
        const chunks = [];
        let responseBytes = 0;
        res.on('data', (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > MAX_PARENT_RESPONSE_BYTES) {
            req.destroy(new Error('RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          finish({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            bodyText: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      });
    } catch (e) {
      finish({ ok: false, status: 0, error: e.message || 'REQUEST_ERROR' });
      return;
    }

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, status: 0, error: 'TIMEOUT' });
    });
    req.on('error', (e) => {
      finish({ ok: false, status: 0, error: e.message || 'NETWORK_ERROR' });
    });

    if (request.body) req.write(request.body);
    req.end();
  });
}

module.exports = {
  configureParentHttp,
  isPrivateOrLoopbackIpv4,
  normalizeParentHttpRequest,
  parentHttpRequest,
};
