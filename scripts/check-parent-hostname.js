const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { EventEmitter } = require('events');
const code = fs.readFileSync(path.join(__dirname, '..', 'main-modules/parent-http.js'), 'utf8');
let addresses = [{ address: '192.168.1.20', family: 4 }];
let dnsError = null;
let lookups = 0;
let connected = [];
let lookupHangs = false;
const dns = { lookup(host, opts, callback) { lookups++; if (!lookupHangs) callback(dnsError, addresses); } };
const http = { request(url, options, respond) {
  const req = new EventEmitter();
  req.write = () => {};
  req.destroy = error => { if (error) req.emit('error', error); };
  req.end = () => {
    const deliver = (err, address) => {
      if (err) { req.emit('error', err); return; }
      connected.push(address);
      const res = new EventEmitter(); res.statusCode = 200; res.headers = {};
      respond(res); res.emit('data', Buffer.from('{"data":[]}')); res.emit('end');
    };
    if (options.lookup) options.lookup(url.hostname, {}, deliver);
    else deliver(null, url.hostname);
  };
  return req;
} };
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, Buffer, URL, Set, console, setTimeout, clearTimeout,
  require: name => name === 'http' ? http : name === 'dns' ? dns : (name.startsWith('.') ? require(path.join(__dirname, '../main-modules', name)) : require(name)) });
const relay = mod.exports;
relay.configureParentHttp({ readDbShared: () => ({}), getSettingRecord: (_, id) => ({ value: id === 'share_mode' ? 'parent' : '' }), normalizeShareMode: mode => mode });
(async () => {
  for (const hostname of ['TB-MASTER01', 'tb-master01.hospital.local']) for (const endpoint of ['wards', 'beds']) {
    const r = await relay.parentHttpRequest({ url: `http://${hostname}:3005/api/tables/${endpoint}`, purpose: 'connection-test' });
    assert.strictEqual(r.ok, true, 'Unconfigured LAN hostname must pass initial connection test');
  }
  assert.deepStrictEqual(connected, Array(4).fill('192.168.1.20'), 'Transport must use the validated address');
  assert.strictEqual(lookups, 4, 'Exactly one OS lookup per request prevents a second DNS resolution');
  addresses = [{ address: '8.8.8.8', family: 4 }];
  assert.strictEqual((await relay.parentHttpRequest({ url: 'http://outside.example:3005/api/tables/wards', purpose: 'connection-test' })).ok, false);
  dnsError = Object.assign(Error('not found'), { code: 'ENOTFOUND' });
  assert.strictEqual((await relay.parentHttpRequest({ url: 'http://missing-host:3005/api/tables/wards', purpose: 'connection-test' })).error, 'HOSTNAME_NOT_RESOLVED');
  for (const opts of [
    { url: 'http://TB-MASTER01:3005/api/tables/wards' },
    { url: 'http://TB-MASTER01:3005/api/tables/staffs', purpose: 'connection-test' },
    { url: 'http://TB-MASTER01:3005/api/tables/beds', purpose: 'connection-test', method: 'POST' },
    { url: 'http://8.8.8.8:3005/api/tables/wards', purpose: 'connection-test' },
  ]) assert.strictEqual((await relay.parentHttpRequest(opts)).ok, false, 'Hostname support must not broaden endpoint or method permissions');
  lookupHangs = true;
  assert.strictEqual((await relay.parentHttpRequest({ url: 'http://slow-host:3005/api/tables/wards', purpose: 'connection-test', timeoutMs: 1000 })).error, 'TIMEOUT', 'DNS resolution must share the request deadline');
  console.log('Parent hostname checks passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
