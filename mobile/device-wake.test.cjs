'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto');
const {createPushServer} = require('./webpush-server.cjs');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
async function fixture(t) {
  const {default: worker, WakeDeviceRegistry} = await import('../cloudflare/worker.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-device-wake-'));
  const origin = 'https://fixture.example.ts.net', wake = 'https://wake.fixture.invalid';
  const cookieName = 'dsh-auth-' + crypto.createHash('sha256').update('fixture.example.ts.net').digest('base64url');
  const cookie = number => cookieName + '=native-fixture-' + number;
  const host = http.createServer((req, res) => {const accepted = [cookie(1), cookie(2)].some(value => (req.headers.cookie || '').split(';').map(s => s.trim()).includes(value)); res.writeHead(accepted ? 200 : 401); res.end();});
  await listen(host);
  const env = {INSTANCE_ID: '42', HARNESS_URL: origin + '/phone/', WAKE_ACCESS_KEY: 'owner-fixture-'.repeat(4), DEVICE_ADMIN_KEY: 'admin-fixture-'.repeat(4), DEVICE_SIGNING_KEY: 'signer-fixture-'.repeat(4), VAST_API_KEY: 'fixture-provider'};
  let value, pending = Promise.resolve(); const storage = {async get() {return structuredClone(value);}, async put(_key, next) {value = structuredClone(next);}, transaction(fn) {const result = pending.then(() => fn(storage)); pending = result.catch(() => {}); return result;}};
  const registry = new WakeDeviceRegistry({storage}, env);
  env.DEVICE_REGISTRY = {idFromName: name => name, get: () => registry};
  const edgeFetch = (input, options) => worker.fetch(new Request(input, options), env);
  const adminFile = path.join(directory, 'admin.key'); fs.writeFileSync(adminFile, env.DEVICE_ADMIN_KEY, {mode: 0o600});
  const cfg = {publicHost: 'fixture.example.ts.net', secretDir: directory, harnessPort: host.address().port, wakeUrl: wake, wakeDeviceAdminKeyFile: adminFile, tailscaleAutoLoginUsers: ['fixture@owner.invalid']};
  const service = createPushServer(cfg, {generateVAPIDKeys: () => ({publicKey: 'fixture', privateKey: 'fixture'}), setVapidDetails() {}}, {deviceFetch: edgeFetch});
  await listen(service.server); const base = 'http://127.0.0.1:' + service.server.address().port;
  t.after(async () => {await close(service.server); await close(host); fs.rmSync(directory, {recursive: true, force: true});});
  const call = (route, {number = 1, body, extraCookie = '', requestOrigin = origin, headers = {}} = {}) => fetch(base + '/phone/api/' + route, {method: body === undefined ? 'GET' : 'POST', headers: {Origin: requestOrigin, ...(number ? {Cookie: cookie(number) + extraCookie} : {}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {worker, env, origin, wake, cookie, call, host, service, adminFile};
}
test('paired phone routes issue only per-device credentials and revocation cannot be bypassed by cookie decoration or automatic entry', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('wake-credential', {number: 0, body: {}})).status, 401);
  assert.equal((await f.call('wake-credential', {body: {}, requestOrigin: 'https://foreign.invalid'})).status, 403);
  const issued = await f.call('wake-credential', {body: {}}); assert.equal(issued.status, 200); const one = await issued.json();
  assert.equal(one.version, 2); assert.equal(one.wakeUrl, f.wake);
  for (const secret of [f.env.WAKE_ACCESS_KEY, f.env.DEVICE_ADMIN_KEY, f.env.DEVICE_SIGNING_KEY]) assert.equal(JSON.stringify(one).includes(secret), false);
  const decorated = await (await f.call('wake-credential', {body: {pairingHash: 'attacker-controlled-ignored'}, extraCookie: '; language=cs'})).json();
  assert.equal(decorated.deviceId, one.deviceId); assert.equal(decorated.credential, one.credential);
  const two = await (await f.call('wake-credential', {number: 2, body: {}})).json(); assert.notEqual(one.deviceId, two.deviceId);
  const listed = await (await f.call('devices')).json(); assert.equal(listed.devices.length, 2); assert.equal(JSON.stringify(listed).includes('credential'), false);
  assert.equal((await f.call('devices/revoke', {number: 2, body: {deviceId: one.deviceId}})).status, 200);
  for (const body of [{}, {deviceId: one.deviceId}]) {
    const denied = await f.call('wake-credential', {body, extraCookie: '; language=en'}); assert.equal(denied.status, 401); assert.equal((await denied.json()).code, 'DEVICE_REVOKED');
  }
  const automatic = await f.call('tailscale-login', {body: {}, headers: {'Tailscale-User-Login': 'fixture@owner.invalid'}});
  assert.equal(automatic.status, 200); assert.equal(automatic.headers.get('set-cookie'), null);
  assert.equal((await f.call('wake-credential', {body: {}})).status, 401);
  const legacy = await f.call('wake-config'); assert.equal(legacy.status, 410); assert.equal((await legacy.json()).code, 'AUTH_UPGRADE_REQUIRED');
  const beforeApproval = await f.call('devices/claim-reenrollment', {body: {deviceId: one.deviceId}}); assert.equal(beforeApproval.status, 403);
  const edgeRequest = (route, body, headers = {}) => f.worker.fetch(new Request(f.wake + route, {method: 'POST', headers: {Origin: f.wake, ...headers}, body: JSON.stringify(body)}), f.env);
  const login = await edgeRequest('/api/login', {key: f.env.WAKE_ACCESS_KEY}), ownerCookie = login.headers.get('set-cookie').split(';')[0];
  const ownerApproval = await edgeRequest('/api/devices/reenroll', {deviceId: one.deviceId, confirmDeviceId: one.deviceId}, {Cookie: ownerCookie});
  assert.equal(ownerApproval.status, 200); assert.equal('credential' in await ownerApproval.json(), false);
  assert.equal((await f.call('devices/claim-reenrollment', {number: 2, body: {deviceId: one.deviceId}})).status, 403);
  const claimed = await f.call('devices/claim-reenrollment', {body: {deviceId: one.deviceId}}); assert.equal(claimed.status, 200);
  const recovered = await claimed.json(); assert.equal(recovered.reenrollment.deviceId, one.deviceId); assert.notEqual(recovered.credential, one.credential);
  await f.call('devices/revoke', {number: 2, body: {deviceId: one.deviceId}});
  assert.equal((await f.call('devices/claim-reenrollment', {body: {deviceId: one.deviceId}})).status, 403);
});
test('owner can revoke a device at the edge while both GPU-side HTTP services are stopped', async t => {
  const f = await fixture(t), one = await (await f.call('wake-credential', {body: {}})).json();
  await close(f.service.server); await close(f.host);
  const original = globalThis.fetch; globalThis.fetch = async () => Response.json({instances: {actual_status: 'exited', intended_status: 'stopped'}}); t.after(() => {globalThis.fetch = original;});
  const request = (route, body, headers = {}) => f.worker.fetch(new Request(f.wake + route, {method: body === undefined ? 'GET' : 'POST', headers: {Origin: f.wake, ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}), f.env);
  const deviceHeaders = {Origin: f.origin, Authorization: 'Bearer ' + one.credential};
  assert.equal((await request('/api/status', undefined, deviceHeaders)).status, 200);
  const login = await request('/api/login', {key: f.env.WAKE_ACCESS_KEY}), cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/devices/revoke', {deviceId: one.deviceId}, {Cookie: cookie})).status, 200);
  const denied = await request('/api/status', undefined, deviceHeaders); assert.equal(denied.status, 401); assert.equal((await denied.json()).code, 'DEVICE_REVOKED');
});
test('missing server administration credentials fail as unavailable rather than exposing a legacy key', async t => {
  const f = await fixture(t); fs.unlinkSync(f.adminFile);
  const result = await f.call('wake-credential', {body: {}}); assert.equal(result.status, 503);
  assert.equal('key' in await result.json(), false);
});
