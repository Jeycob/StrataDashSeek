import {boundedJSON} from './request-json.mjs';
const fail = (status, code) => Object.assign(new Error(code), {status, code});
const encoder = new TextEncoder();
async function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(a)));
  const y = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(b)));
  let diff = 0; for (let n = 0; n < x.length; n++) diff |= x[n] ^ y[n]; return diff === 0;
}
export async function deviceCall(env, operation, body) {
  const binding = env.DEVICE_REGISTRY;
  if (!binding || typeof binding.idFromName !== 'function' || typeof binding.get !== 'function' || !/^[0-9]+$/.test(String(env.INSTANCE_ID))) throw fail(503, 'DEVICE_REGISTRY_UNAVAILABLE');
  const result = await binding.get(binding.idFromName('wake:' + env.INSTANCE_ID)).fetch(new Request('https://device-registry.internal/' + operation, {method: 'POST', body: JSON.stringify(body)}));
  let value; try {value = await boundedJSON(result, {maxBytes: 32768});} catch {throw fail(503, 'DEVICE_REGISTRY_UNAVAILABLE');}
  if (!result.ok) throw Object.assign(fail([400, 401, 403, 404, 409, 429, 503].includes(result.status) ? result.status : 503,
    typeof value?.code === 'string' && /^[A-Z_]{1,80}$/.test(value.code) ? value.code : 'DEVICE_REGISTRY_UNAVAILABLE'),
    typeof value?.deviceId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.deviceId) ? {deviceId: value.deviceId} : {});
  return value;
}
export async function deviceIdentity(request, env) {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  if (request.headers.get('origin') !== new URL(env.HARNESS_URL).origin) throw fail(403, 'ORIGIN_REFUSED');
  if (!authorization.startsWith('Bearer v2.')) throw fail(401, 'AUTH_UPGRADE_REQUIRED');
  const identity = await deviceCall(env, 'authenticate', {credential: authorization.slice(7)});
  if (identity?.version !== 2 || typeof identity.deviceId !== 'string' || !Array.isArray(identity.scope) || identity.scope.length !== 2 || !identity.scope.includes('status') || !identity.scope.includes('wake')) throw fail(503, 'DEVICE_REGISTRY_UNAVAILABLE');
  return identity;
}
export async function deviceManagement(request, env, ownerAuthenticated) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/devices/')) return null;
  const operation = url.pathname.slice('/api/devices/'.length);
  if (!['provision', 'list', 'revoke', 'reenroll', 'claim-reenrollment'].includes(operation)) return Response.json({code: 'NOT_FOUND'}, {status: 404});
  if (request.method !== 'POST') throw fail(405, 'METHOD_NOT_ALLOWED');
  const privateOrigin = new URL(env.HARNESS_URL).origin;
  const owner = request.headers.get('origin') === url.origin && await ownerAuthenticated();
  const configured = typeof env.DEVICE_ADMIN_KEY === 'string' && env.DEVICE_ADMIN_KEY.length >= 32 &&
    env.DEVICE_ADMIN_KEY !== env.WAKE_ACCESS_KEY && env.DEVICE_ADMIN_KEY !== env.DEVICE_SIGNING_KEY;
  const admin = configured && request.headers.get('origin') === privateOrigin &&
    await equal(request.headers.get('authorization'), 'Bearer ' + env.DEVICE_ADMIN_KEY);
  // Reenrollment is an explicit owner-portal action. A still-paired browser's
  // delegated server credential can never undo its own revocation.
  if (operation === 'reenroll' ? !owner : ['provision', 'claim-reenrollment'].includes(operation) ? !admin : !owner && !admin) throw fail(403, 'DEVICE_MANAGEMENT_FORBIDDEN');
  const body = await boundedJSON(request, {maxBytes: 4096});
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'INVALID_REQUEST');
  const value = await deviceCall(env, operation, body);
  return Response.json(operation === 'provision' || operation === 'claim-reenrollment' ? {...value, wakeUrl: url.origin} : value,
    {headers: {'cache-control': 'no-store'}});
}
