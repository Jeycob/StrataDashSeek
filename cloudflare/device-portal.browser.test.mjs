import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import worker, {WakeDeviceRegistry} from './worker.mjs';
const require = createRequire(import.meta.url);

test('actual owner portal revokes and approves devices without waking the GPU or rendering credentials', {timeout: 40000}, async t => {
  const {chromium} = process.env.HARNESS_PLAYWRIGHT_MODULE ? require(process.env.HARNESS_PLAYWRIGHT_MODULE) : require('../runtime/require.cjs').runtimeRequire('playwright');
  const env = {INSTANCE_ID: '42', HARNESS_URL: 'https://fixture.example.ts.net/phone/', WAKE_ACCESS_KEY: 'owner-fixture-'.repeat(4), DEVICE_SIGNING_KEY: 'signer-fixture-'.repeat(4), DEVICE_ADMIN_KEY: 'admin-fixture-'.repeat(4)};
  let state, tail = Promise.resolve();
  const storage = {async get() {return structuredClone(state);}, async put(_key, value) {state = structuredClone(value);}, transaction(fn) {const next = tail.then(() => fn(storage)); tail = next.catch(() => {}); return next;}};
  const registry = new WakeDeviceRegistry({storage}, env);
  env.DEVICE_REGISTRY = {idFromName: name => name, get: () => registry};
  const one = await registry.provision({pairingHash: '1'.repeat(64), name: 'Primary phone'});
  await registry.provision({pairingHash: '2'.repeat(64), name: '<img src=invalid>'});
  const original = globalThis.fetch, external = [], errors = [];
  globalThis.fetch = async input => {external.push(new URL(typeof input === 'string' ? input : input.url).origin); throw Error('Unexpected provider request');};
  let browser;
  try {
    browser = await chromium.launch({headless: true, ...(process.env.HARNESS_BROWSER_CHANNEL ? {channel: process.env.HARNESS_BROWSER_CHANNEL} : {})});
    t.diagnostic('Actual browser version: ' + browser.version());
    const context = await browser.newContext({viewport: {width: 390, height: 844}});
    await context.route('**/*', async route => {
      const incoming = route.request();
      if (new URL(incoming.url()).origin !== 'https://wake.fixture.invalid') {external.push(new URL(incoming.url()).origin); await route.abort(); return;}
      const result = await worker.fetch(new Request(incoming.url(), {method: incoming.method(), headers: incoming.headers(), ...(['GET', 'HEAD'].includes(incoming.method()) ? {} : {body: incoming.postData()})}), env);
      await route.fulfill({status: result.status, headers: Object.fromEntries(result.headers), body: Buffer.from(await result.arrayBuffer())});
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.name));
    await page.goto('https://wake.fixture.invalid/?devices=1&lang=en');
    await page.locator('#login').waitFor({state: 'visible'});
    await page.locator('#key').fill(env.WAKE_ACCESS_KEY); await page.locator('#login button').click();
    await page.locator('#devices-list article').nth(1).waitFor();
    assert.equal(await page.locator('#devices-title').textContent(), 'Device access');
    assert.equal(await page.locator('#devices-list img').count(), 0);
    await page.locator('button[data-device-id="' + one.deviceId + '"][data-action="revoke"]').click();
    await page.locator('button[data-device-id="' + one.deviceId + '"][data-action="reenroll"]').waitFor();
    await assert.rejects(registry.authenticate(one.credential), {code: 'DEVICE_REVOKED'});
    await page.locator('button[data-device-id="' + one.deviceId + '"][data-action="reenroll"]').click();
    await page.locator('button[data-device-id="' + one.deviceId + '"][data-action="revoke"]').waitFor();
    assert.match(await page.locator('#devices-message').textContent(), /Confirm recovery on that device/);
    await assert.rejects(registry.authenticate(one.credential), {code: 'DEVICE_REVOKED'});
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({width, height: 844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    const body = await page.locator('body').innerText();
    for (const secret of [one.credential, env.WAKE_ACCESS_KEY, env.DEVICE_SIGNING_KEY, env.DEVICE_ADMIN_KEY]) assert.equal(body.includes(secret), false);
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
  } finally {globalThis.fetch = original; await browser?.close();}
});
