import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WakeDeviceRegistry} from './device-registry.mjs';

// A real on-disk SQLite fixture for the small Durable Object storage contract;
// this is local durability evidence, not a claim of a deployed Cloudflare test.
class Storage {
  constructor(file) { this.db = new DatabaseSync(file); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'); this.tail = Promise.resolve(); }
  async get(key) {const row = this.db.prepare('SELECT v FROM kv WHERE k=?').get(key); return row ? JSON.parse(row.v) : undefined;}
  async put(key, value) {if (this.failWrites) throw Error('Fixture write failure'); this.db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(key, JSON.stringify(value));}
  transaction(fn) {
    const operation = this.tail.then(async () => {this.db.exec('BEGIN IMMEDIATE'); try {const result = await fn(this); this.db.exec('COMMIT'); return result;} catch (error) {this.db.exec('ROLLBACK'); throw error;}});
    this.tail = operation.catch(() => {}); return operation;
  }
  close() {this.db.close();}
}
const env = {DEVICE_SIGNING_KEY: 'synthetic-test-signer-'.repeat(3)};
const pairingHash = number => number.toString(16).padStart(64, '0');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-device-registry-')), file = path.join(directory, 'registry.sqlite');
  let storage = new Storage(file), now = 1700000000000;
  const create = (settings = env) => new WakeDeviceRegistry({storage}, settings, {now: () => now, lifetimeMs: 300000});
  t.after(() => {storage.close(); fs.rmSync(directory, {recursive: true, force: true});});
  return {get storage() {return storage;}, create, advance(ms) {now += ms;}, restart() {storage.close(); storage = new Storage(file); return create();}};
}
test('device tokens are stable within a lease, independently scoped and signed without exposing the signer', async t => {
  const f = fixture(t), registry = f.create(), one = await registry.provision({pairingHash: pairingHash(1)}), two = await registry.provision({pairingHash: pairingHash(2)});
  assert.equal((await registry.provision({pairingHash: pairingHash(1)})).credential, one.credential);
  assert.notEqual(one.credential, two.credential);
  assert.deepEqual((await registry.authenticate(one.credential)).scope, ['status', 'wake']);
  const listed = await registry.list();
  assert.equal(JSON.stringify([one, two, listed]).includes(env.DEVICE_SIGNING_KEY), false);
  assert.equal(listed.some(row => 'credential' in row || 'pairingHash' in row), false);
  await assert.rejects(registry.authenticate(one.credential.replace('.1.', '.2.')), {code: 'INVALID_DEVICE_CREDENTIAL'});
});
test('revocation survives closing and reopening SQLite; clearing client identity cannot re-provision the same pairing', async t => {
  const f = fixture(t), registry = f.create(), one = await registry.provision({pairingHash: pairingHash(1)}), two = await registry.provision({pairingHash: pairingHash(2)});
  await registry.revoke({deviceId: one.deviceId});
  const restarted = f.restart();
  await assert.rejects(restarted.authenticate(one.credential), {status: 401, code: 'DEVICE_REVOKED'});
  await assert.rejects(restarted.provision({pairingHash: pairingHash(1)}), {code: 'DEVICE_REVOKED'});
  await assert.rejects(restarted.provision({pairingHash: pairingHash(1), deviceId: one.deviceId}), {code: 'DEVICE_REVOKED'});
  assert.equal((await restarted.authenticate(two.credential)).deviceId, two.deviceId);
});
test('expired credentials renew only through paired provisioning and retain their device identity', async t => {
  const f = fixture(t), registry = f.create(), one = await registry.provision({pairingHash: pairingHash(1)});
  f.advance(300001);
  await assert.rejects(registry.authenticate(one.credential), {code: 'DEVICE_EXPIRED'});
  const renewed = await registry.provision({pairingHash: pairingHash(1), deviceId: one.deviceId});
  assert.equal(renewed.deviceId, one.deviceId); assert.notEqual(renewed.credential, one.credential);
  assert.equal((await registry.authenticate(renewed.credential)).deviceId, one.deviceId);
  await assert.rejects(registry.provision({pairingHash: pairingHash(2), deviceId: one.deviceId}), {code: 'DEVICE_MISMATCH'});
});
test('unavailable signer and corrupt durable records fail closed without replacing state', async t => {
  const f = fixture(t);
  await assert.rejects(f.create({}).provision({pairingHash: pairingHash(1)}), {status: 503});
  assert.equal(await f.storage.get('registry-v1'), undefined);
  await f.storage.put('registry-v1', {version: 999, devices: []});
  await assert.rejects(f.create().provision({pairingHash: pairingHash(1)}), {code: 'DEVICE_STORE_INVALID'});
  assert.equal((await f.storage.get('registry-v1')).version, 999);
});
test('a failed durable revocation returns 503 and does not acknowledge a state that was never committed', async t => {
  const f = fixture(t), registry = f.create(), one = await registry.provision({pairingHash: pairingHash(1)});
  f.storage.failWrites = true;
  const result = await registry.fetch(new Request('https://internal/revoke', {method: 'POST', body: JSON.stringify({deviceId: one.deviceId})}));
  assert.equal(result.status, 503);
  assert.equal((await registry.authenticate(one.credential)).deviceId, one.deviceId);
});
test('concurrent retries share a device record and new registrations have a durable bounded limit', async t => {
  const f = fixture(t), registry = f.create();
  const retried = await Promise.all(Array.from({length: 8}, () => registry.provision({pairingHash: pairingHash(1)})));
  assert.equal(new Set(retried.map(row => row.deviceId)).size, 1);
  for (let n = 2; n <= 50; n++) await registry.provision({pairingHash: pairingHash(n)});
  await assert.rejects(f.restart().provision({pairingHash: pairingHash(51)}), {status: 429, code: 'DEVICE_LIMIT'});
});
