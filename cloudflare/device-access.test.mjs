import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {WakeDeviceRegistry} from './worker.mjs';

function fixture() {
  const env = {WAKE_ACCESS_KEY: 'owner-fixture-'.repeat(4), DEVICE_ADMIN_KEY: 'admin-fixture-'.repeat(4), DEVICE_SIGNING_KEY: 'signer-fixture-'.repeat(4), VAST_API_KEY: 'provider-fixture', INSTANCE_ID: '42', HARNESS_URL: 'https://fixture.example.ts.net/phone/'};
  let value, queue = Promise.resolve();
  const storage = {async get() {return structuredClone(value);}, async put(_key, next) {value = structuredClone(next);}, transaction(fn) {const run = queue.then(() => fn(storage)); queue = run.catch(() => {}); return run;}};
  const registry = new WakeDeviceRegistry({storage}, env);
  env.DEVICE_REGISTRY = {idFromName(name) {assert.equal(name, 'wake:42'); return name;}, get() {return registry;}};
  const call = (path, body, {cookie, admin = false, credential, origin = admin || credential ? 'https://fixture.example.ts.net' : 'https://wake.fixture.invalid'} = {}) => worker.fetch(new Request('https://wake.fixture.invalid' + path, {method: body === undefined ? 'GET' : 'POST', headers: {Origin: origin, ...(cookie ? {Cookie: cookie} : {}), ...(admin ? {Authorization: 'Bearer ' + env.DEVICE_ADMIN_KEY} : credential ? {Authorization: 'Bearer ' + credential} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}), env);
  return {env, registry, call};
}
test('paired provisioning, device scope and owner-only reenrollment are enforced by actual Worker routes', async () => {
  const f = fixture(), original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({instances: {actual_status: 'running', intended_status: 'running'}});
  try {
    assert.equal((await f.call('/api/devices/provision', {pairingHash: '1'.repeat(64)})).status, 403);
    const oneResponse = await f.call('/api/devices/provision', {pairingHash: '1'.repeat(64)}, {admin: true}); assert.equal(oneResponse.status, 200);
    const one = await oneResponse.json(), two = await (await f.call('/api/devices/provision', {pairingHash: '2'.repeat(64)}, {admin: true})).json();
    assert.equal(one.wakeUrl, 'https://wake.fixture.invalid');
    assert.equal((await f.call('/api/status', undefined, {credential: one.credential})).status, 200);
    assert.equal((await f.call('/api/request-metrics', undefined, {credential: one.credential})).status, 403);
    assert.equal((await f.call('/api/devices/list', {}, {credential: one.credential})).status, 403);
    assert.equal((await f.call('/api/devices/revoke', {deviceId: two.deviceId}, {credential: one.credential})).status, 403);
    const login = await f.call('/api/login', {key: f.env.WAKE_ACCESS_KEY}), cookie = login.headers.get('set-cookie').split(';')[0];
    const revoked = await f.call('/api/devices/revoke', {deviceId: one.deviceId}, {cookie}); assert.equal(revoked.status, 200);
    const denied = await f.call('/api/status', undefined, {credential: one.credential}); assert.equal(denied.status, 401); assert.equal((await denied.json()).code, 'DEVICE_REVOKED');
    assert.equal((await f.call('/api/status', undefined, {credential: two.credential})).status, 200);
    assert.equal((await f.call('/api/devices/provision', {pairingHash: '1'.repeat(64)}, {admin: true})).status, 401);
    assert.equal((await f.call('/api/devices/reenroll', {deviceId: one.deviceId, confirmDeviceId: one.deviceId}, {admin: true})).status, 403);
    assert.equal((await f.call('/api/devices/reenroll', {deviceId: one.deviceId}, {cookie})).status, 400);
    const reenrolled = await f.call('/api/devices/reenroll', {deviceId: one.deviceId, confirmDeviceId: one.deviceId}, {cookie}); assert.equal(reenrolled.status, 200);
    const approved = await reenrolled.json(); assert.equal(approved.reenrollment.deviceId, one.deviceId); assert.equal('credential' in approved, false);
    const next = await (await f.call('/api/devices/claim-reenrollment', {deviceId: one.deviceId, pairingHash: '1'.repeat(64)}, {admin: true})).json();
    assert.equal((await f.call('/api/status', undefined, {credential: next.credential})).status, 200);
    assert.equal((await f.call('/api/status', undefined, {credential: one.credential})).status, 401);
    const devices = await (await f.call('/api/devices/list', {}, {cookie})).json();
    assert.equal(JSON.stringify(devices).includes('credential'), false);
    assert.equal(JSON.stringify([one, next, devices]).includes(f.env.DEVICE_SIGNING_KEY), false);
  } finally {globalThis.fetch = original;}
});
test('missing durable binding or reused administrative secrets never become a permissive fallback', async () => {
  const f = fixture();
  const token = await f.registry.provision({pairingHash: '1'.repeat(64)});
  delete f.env.DEVICE_REGISTRY;
  assert.equal((await f.call('/api/status', undefined, {credential: token.credential})).status, 503);
  f.env.DEVICE_ADMIN_KEY = f.env.WAKE_ACCESS_KEY;
  assert.equal((await f.call('/api/devices/provision', {pairingHash: '2'.repeat(64)}, {admin: true})).status, 403);
});
test('rotating the historically exported owner key invalidates legacy owner login and signed cookies', async () => {
  const f = fixture(), oldKey = f.env.WAKE_ACCESS_KEY;
  const login = await f.call('/api/login', {key: oldKey}), cookie = login.headers.get('set-cookie').split(';')[0];
  f.env.WAKE_ACCESS_KEY = 'new-owner-fixture-'.repeat(4);
  assert.equal((await f.call('/api/login', {key: oldKey})).status, 401);
  assert.equal((await f.call('/api/request-metrics', undefined, {cookie})).status, 401);
  assert.equal((await f.call('/api/wake', {}, {credential: oldKey})).status, 401);
});
