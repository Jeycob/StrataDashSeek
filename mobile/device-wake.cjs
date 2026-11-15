'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
const failure = (status, code) => Object.assign(new Error(code), {status, code});
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function readSecret(file) {
  if (typeof file !== 'string') throw failure(503, 'DEVICE_ADMIN_UNAVAILABLE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size < 32 || s.size > 512 || process.platform !== 'win32' && (s.mode & 0o077)) throw failure(503, 'DEVICE_ADMIN_UNAVAILABLE');
    const value = fs.readFileSync(fd, 'utf8').trim();
    if (value.length < 32 || value.length > 256) throw failure(503, 'DEVICE_ADMIN_UNAVAILABLE');
    return value;
  } finally {fs.closeSync(fd);}
}
function createDeviceWake(cfg, {fetch: send = globalThis.fetch, pairedCookie, now = Date.now} = {}) {
  function wakeOrigin() {
    let url; try {url = new URL(cfg.wakeUrl);} catch {throw failure(503, 'DEVICE_REGISTRY_UNAVAILABLE');}
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw failure(503, 'DEVICE_REGISTRY_UNAVAILABLE');
    return url.origin;
  }
  async function call(operation, body) {
    const origin = wakeOrigin(), secret = readSecret(cfg.wakeDeviceAdminKeyFile);
    let result;
    try {result = await send(origin + '/api/devices/' + operation, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: {Origin: 'https://' + cfg.publicHost, Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});}
    catch {throw failure(503, 'DEVICE_REGISTRY_UNAVAILABLE');}
    let data; try {const {boundedJSON} = await import('../cloudflare/request-json.mjs'); data = await boundedJSON(result, {maxBytes: 32768});}
    catch {throw failure(503, 'DEVICE_REGISTRY_UNAVAILABLE');}
    if (!result.ok) throw Object.assign(failure([400, 401, 403, 404, 409, 429].includes(result.status) ? result.status : 503,
      typeof data?.code === 'string' && /^[A-Z_]{1,80}$/.test(data.code) ? data.code : 'DEVICE_REGISTRY_UNAVAILABLE'), uuid.test(data?.deviceId) ? {deviceId: data.deviceId} : {});
    return data;
  }
  return {
    async provision(req, data, {claim = false} = {}) {
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.deviceId != null && !uuid.test(data.deviceId)) throw failure(400, 'INVALID_DEVICE');
      const cookie = await pairedCookie(req);
      if (!cookie) throw failure(401, 'PAIRING_REQUIRED');
      // Only the exact validated Native authentication cookie contributes to
      // pairing identity. Language/unrelated cookies cannot bypass a tombstone.
      const pairingHash = crypto.createHash('sha256').update('native-pairing-v2\0' + cfg.publicHost + '\0' + cookie).digest('hex');
      const value = await call(claim ? 'claim-reenrollment' : 'provision', {pairingHash, deviceId: data.deviceId ?? null, name: typeof data.name === 'string' ? data.name.slice(0, 80) : ''});
      const expiry = value?.expiresAt;
      if (value?.version !== 2 || !uuid.test(value.deviceId) || typeof value.credential !== 'string' || !/^v2\./.test(value.credential) || value.credential.length > 256 || !Number.isSafeInteger(expiry) || expiry <= now() || expiry > now() + 30 * 86400000 + 60000 || !Array.isArray(value.scope) || value.scope.length !== 2 || !value.scope.includes('status') || !value.scope.includes('wake')) throw failure(503, 'AUTH_UPGRADE_REQUIRED');
      if (claim && (value.deviceId !== data.deviceId || value.reenrollment?.deviceId !== data.deviceId || !Number.isSafeInteger(value.reenrollment.generation) || !Number.isSafeInteger(value.reenrollment.confirmedAt))) throw failure(503, 'DEVICE_REENROLLMENT_REQUIRED');
      return {version: 2, wakeUrl: wakeOrigin(), credential: value.credential, deviceId: value.deviceId, expiresAt: expiry, scope: ['status', 'wake'], ...(claim ? {reenrollment: value.reenrollment} : {})};
    },
    async list() {
      const value = await call('list', {});
      if (!Array.isArray(value?.devices) || value.devices.length > 50) throw failure(503, 'DEVICE_REGISTRY_UNAVAILABLE');
      return {version: 2, devices: value.devices.map(row => {
        if (!uuid.test(row?.deviceId)) throw failure(503, 'DEVICE_REGISTRY_UNAVAILABLE');
        return {deviceId: row.deviceId, name: String(row.name || '').slice(0, 80), createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt, scope: ['status', 'wake']};
      }), ownerUrl: wakeOrigin() + '/?devices=1'};
    },
    async revoke(data) {
      if (!uuid.test(data?.deviceId)) throw failure(400, 'INVALID_DEVICE');
      const value = await call('revoke', {deviceId: data.deviceId});
      if (value?.deviceId !== data.deviceId || !Number.isSafeInteger(value.revokedAt)) throw failure(503, 'DEVICE_REGISTRY_UNAVAILABLE');
      return {deviceId: value.deviceId, revokedAt: value.revokedAt};
    }
  };
}
module.exports = {createDeviceWake};
