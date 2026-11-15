// Internal Durable Object component. The public Worker must authorize each
// operation before forwarding it; never route arbitrary paths to this object.
import {boundedJSON} from './request-json.mjs';
const scope = Object.freeze(['status', 'wake']);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = (status, code) => Object.assign(new Error(code), {status, code});
const encode = value => new TextEncoder().encode(value);
function response(value, status = 200) { return Response.json(value, {status, headers: {'cache-control': 'no-store'}}); }

export class WakeDeviceRegistry {
  constructor(ctx, env, {now = Date.now, lifetimeMs = 7 * 86400000} = {}) {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 300000 || lifetimeMs > 30 * 86400000) throw new TypeError('Invalid device lifetime');
    this.storage = ctx.storage; this.env = env; this.now = now; this.lifetimeMs = lifetimeMs;
  }
  async key() {
    if (typeof this.env.DEVICE_SIGNING_KEY !== 'string' || this.env.DEVICE_SIGNING_KEY.length < 32 || this.env.DEVICE_SIGNING_KEY === this.env.WAKE_ACCESS_KEY || this.env.DEVICE_SIGNING_KEY === this.env.DEVICE_ADMIN_KEY) throw fail(503, 'DEVICE_SIGNER_UNAVAILABLE');
    return crypto.subtle.importKey('raw', encode(this.env.DEVICE_SIGNING_KEY), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
  }
  state(value) {
    if (value === undefined) return {version: 1, devices: []};
    if (!value || value.version !== 1 || !Array.isArray(value.devices) || value.devices.length > 50) throw fail(503, 'DEVICE_STORE_INVALID');
    const ids = new Set(), pairs = new Set();
    for (const row of value.devices) {
      if (!row || !uuid.test(row.deviceId) || !/^[a-f0-9]{64}$/.test(row.pairingHash) || ids.has(row.deviceId) || pairs.has(row.pairingHash) ||
        !Number.isSafeInteger(row.generation) || row.generation < 1 || !Number.isSafeInteger(row.expiresAt) || !Number.isSafeInteger(row.createdAt) ||
        !(row.revokedAt === null || Number.isSafeInteger(row.revokedAt)) || !(row.reenrolledAt === null || Number.isSafeInteger(row.reenrolledAt)) || typeof row.name !== 'string' || row.name.length > 80) throw fail(503, 'DEVICE_STORE_INVALID');
      ids.add(row.deviceId); pairs.add(row.pairingHash);
    }
    return value;
  }
  async change(fn) {
    return this.storage.transaction(async tx => {
      const value = this.state(await tx.get('registry-v1'));
      const result = fn(value);
      await tx.put('registry-v1', value);
      return result;
    });
  }
  async dto(row) {
    const payload = ['v2', row.deviceId, row.expiresAt, row.generation].join('.');
    const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', await this.key(), encode(payload)))].map(n => n.toString(16).padStart(2, '0')).join('');
    return {version: 2, deviceId: row.deviceId, expiresAt: row.expiresAt, scope: [...scope], credential: payload + '.' + signature};
  }
  async provision({pairingHash, deviceId = null, name = ''}) {
    if (typeof pairingHash !== 'string' || !/^[a-f0-9]{64}$/.test(pairingHash) || (deviceId !== null && !uuid.test(deviceId)) || typeof name !== 'string' || name.length > 80) throw fail(400, 'INVALID_DEVICE');
    await this.key();
    const now = this.now(), freshId = crypto.randomUUID();
    const row = await this.change(value => {
      let row = value.devices.find(entry => entry.pairingHash === pairingHash);
      if (deviceId && (!row || row.deviceId !== deviceId)) throw fail(403, 'DEVICE_MISMATCH');
      if (row && row.revokedAt !== null) throw Object.assign(fail(401, 'DEVICE_REVOKED'), {deviceId: row.deviceId});
      if (!row) {
        if (value.devices.length >= 50) throw fail(429, 'DEVICE_LIMIT');
        row = {deviceId: freshId, pairingHash, name, createdAt: now, expiresAt: now + this.lifetimeMs, generation: 1, revokedAt: null, reenrolledAt: null};
        value.devices.push(row);
      } else if (row.expiresAt <= now) { row.expiresAt = now + this.lifetimeMs; row.generation++; }
      return {...row};
    });
    return this.dto(row);
  }
  async authenticate(credential) {
    if (typeof credential !== 'string' || credential.length > 256) throw fail(401, 'INVALID_DEVICE_CREDENTIAL');
    const [version, deviceId, expiry, generation, signature, extra] = credential.split('.');
    if (version !== 'v2' || !uuid.test(deviceId) || !/^[0-9]{1,16}$/.test(expiry) || !/^[0-9]{1,10}$/.test(generation) || !/^[a-f0-9]{64}$/.test(signature) || extra !== undefined) throw fail(401, 'INVALID_DEVICE_CREDENTIAL');
    const valid = await crypto.subtle.verify('HMAC', await this.key(), Uint8Array.from(signature.match(/../g), n => parseInt(n, 16)), encode([version, deviceId, expiry, generation].join('.')));
    if (!valid) throw fail(401, 'INVALID_DEVICE_CREDENTIAL');
    // The authoritative read follows the asynchronous signature check so a
    // completed revocation cannot be bypassed with an isolate-local cache.
    const row = this.state(await this.storage.get('registry-v1')).devices.find(row => row.deviceId === deviceId);
    if (!row || row.revokedAt !== null) throw Object.assign(fail(401, 'DEVICE_REVOKED'), {deviceId});
    if (Number(expiry) <= this.now()) throw fail(401, 'DEVICE_EXPIRED');
    if (row.expiresAt !== Number(expiry) || row.generation !== Number(generation)) throw fail(401, 'DEVICE_REVOKED');
    return {version: 2, deviceId, expiresAt: row.expiresAt, scope: [...scope]};
  }
  async list() {
    const value = this.state(await this.storage.get('registry-v1'));
    return value.devices.map(({deviceId, name, createdAt, expiresAt, revokedAt}) => ({deviceId, name, createdAt, expiresAt, revokedAt, scope: [...scope]}));
  }
  async revoke({deviceId}) {
    if (!uuid.test(deviceId)) throw fail(400, 'INVALID_DEVICE');
    const now = this.now();
    return this.change(value => {
      const row = value.devices.find(row => row.deviceId === deviceId);
      if (!row) throw fail(404, 'DEVICE_NOT_FOUND');
      if (row.revokedAt === null) row.revokedAt = now;
      row.reenrolledAt = null;
      return {deviceId, revokedAt: row.revokedAt};
    });
  }
  async reenroll({deviceId, confirmDeviceId}) {
    if (!uuid.test(deviceId) || confirmDeviceId !== deviceId) throw fail(400, 'DEVICE_CONFIRMATION_REQUIRED');
    await this.key(); const now = this.now();
    const row = await this.change(value => {
      const row = value.devices.find(row => row.deviceId === deviceId);
      if (!row) throw fail(404, 'DEVICE_NOT_FOUND');
      if (row.revokedAt === null) throw fail(409, 'DEVICE_NOT_REVOKED');
      row.revokedAt = null; row.generation++; row.expiresAt = now + this.lifetimeMs; row.reenrolledAt = now;
      return {...row};
    });
    return {deviceId, reenrollment: {deviceId, generation: row.generation, confirmedAt: now}};
  }
  async claimReenrollment({pairingHash, deviceId}) {
    if (!uuid.test(deviceId) || typeof pairingHash !== 'string' || !/^[a-f0-9]{64}$/.test(pairingHash)) throw fail(400, 'INVALID_DEVICE');
    await this.key(); const now = this.now();
    const row = await this.change(value => {
      const row = value.devices.find(row => row.deviceId === deviceId && row.pairingHash === pairingHash);
      if (!row || row.revokedAt !== null || row.reenrolledAt === null) throw fail(403, 'DEVICE_REENROLLMENT_REQUIRED');
      if (row.expiresAt <= now) {row.expiresAt = now + this.lifetimeMs; row.generation++;}
      return {...row};
    });
    return {...await this.dto(row), reenrollment: {deviceId, generation: row.generation, confirmedAt: row.reenrolledAt}};
  }
  async fetch(request) {
    try {
      if (request.method !== 'POST') return response({code: 'METHOD_NOT_ALLOWED'}, 405);
      const body = await boundedJSON(request, {maxBytes: 4096});
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'INVALID_REQUEST');
      const operation = new URL(request.url).pathname;
      if (operation === '/provision') return response(await this.provision(body));
      if (operation === '/authenticate') return response(await this.authenticate(body.credential));
      if (operation === '/list') return response({devices: await this.list()});
      if (operation === '/revoke') return response(await this.revoke(body));
      if (operation === '/reenroll') return response(await this.reenroll(body));
      if (operation === '/claim-reenrollment') return response(await this.claimReenrollment(body));
      return response({code: 'NOT_FOUND'}, 404);
    } catch (error) { return response({code: error.code || 'DEVICE_STORE_UNAVAILABLE', ...(uuid.test(error.deviceId) ? {deviceId: error.deviceId} : {})}, error.status || 503); }
  }
}
