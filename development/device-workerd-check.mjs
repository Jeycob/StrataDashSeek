// Actual local Cloudflare runtime and SQLite restart proof. No account mutation,
// remote bindings, provider calls, real credentials or browser automation.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {boundedJSON} from '../cloudflare/request-json.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = process.env.HARNESS_WRANGLER_CLI;
if (!cli) throw Object.assign(Error('Set HARNESS_WRANGLER_CLI to the installed pinned Wrangler CLI.'), {code: 'UNRUNNABLE'});
await fs.access(cli);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'device-workerd-'));
const fixture = {owner: 'fixture-owner-only-'.repeat(3), admin: 'fixture-admin-only-'.repeat(3), signer: 'fixture-signer-only-'.repeat(3)};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let active, requests = 0, version = null;
async function start() {
  const args = [cli, 'dev', '--local', '--ip', '127.0.0.1', '--port', '0', '--inspector-port', '0', '--show-interactive-dev-session=false', '--persist-to', path.join(temp, 'state'), '--config', path.join(root, 'cloudflare/wrangler.example.jsonc')];
  for (const [name, value] of Object.entries({INSTANCE_ID: '42', HARNESS_URL: 'https://fixture.example.ts.net/phone/', VAST_API_KEY: 'fixture-no-provider', WAKE_ACCESS_KEY: fixture.owner, DEVICE_ADMIN_KEY: fixture.admin, DEVICE_SIGNING_KEY: fixture.signer})) args.push('--var', name + ':' + value);
  const child = spawn(process.execPath, args, {cwd: root, env: {...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_KEY: ''}, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; const collect = value => {output = (output + value).slice(-65536);}; child.stdout.on('data', collect); child.stderr.on('data', collect);
  const exited = new Promise(resolve => {child.once('close', resolve); child.once('error', resolve);});
  active = {child, exited};
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    version ??= output.match(/wrangler ([0-9.]+)/)?.[1] ?? null;
    const url = output.match(/Ready on (http:\/\/127\.0\.0\.1:[0-9]+)/)?.[1];
    if (url && new URL(url).port !== '0') return url;
    if (child.exitCode !== null) throw Error('Local Wrangler exited before readiness: ' + child.exitCode);
    await sleep(50);
  }
  throw Error('Local Wrangler readiness timeout');
}
async function stop() {
  if (!active) return;
  const {child, exited} = active;
  if (child.exitCode === null && Number.isInteger(child.pid)) {
    if (process.platform === 'win32') await new Promise(resolve => {const kill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'}); kill.once('close', resolve); kill.once('error', resolve);});
    else {try {process.kill(-child.pid, 'SIGTERM');} catch {}}
  }
  let timer;
  try {await Promise.race([exited, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('Owned local runtime did not stop')), 5000);})]);}
  finally {clearTimeout(timer);}
  active = null;
}
async function request(base, route, body, {owner, admin = false, credential} = {}) {
  assert(['/api/login', '/api/devices/provision', '/api/devices/revoke', '/api/devices/reenroll', '/api/devices/claim-reenrollment', '/api/request-metrics'].includes(route));
  requests++;
  const result = await fetch(base + route, {method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000), headers: {Origin: admin || credential ? 'https://fixture.example.ts.net' : base, ...(owner ? {Cookie: owner} : {}), ...(admin ? {Authorization: 'Bearer ' + fixture.admin} : credential ? {Authorization: 'Bearer ' + credential} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {status: result.status, cookie: result.headers.get('set-cookie')?.split(';')[0], data: await boundedJSON(result, {maxBytes: 32768})};
}
async function sqliteFiles(directory) {let count = 0; for (const entry of await fs.readdir(directory, {withFileTypes: true})) {const target = path.join(directory, entry.name); if (entry.isDirectory()) count += await sqliteFiles(target); else if (entry.isFile() && entry.name.endsWith('.sqlite')) count++;} return count;}
try {
  let base = await start();
  const login = await request(base, '/api/login', {key: fixture.owner}); assert.equal(login.status, 200);
  const issued = await request(base, '/api/devices/provision', {pairingHash: '1'.repeat(64)}, {admin: true}); assert.equal(issued.status, 200);
  const one = issued.data;
  const scoped = await request(base, '/api/request-metrics', undefined, {credential: one.credential}); assert.equal(scoped.status, 403); assert.equal(scoped.data.code, 'DEVICE_SCOPE_FORBIDDEN');
  assert.equal((await request(base, '/api/devices/revoke', {deviceId: one.deviceId}, {owner: login.cookie})).status, 200);
  const denied = await request(base, '/api/devices/provision', {pairingHash: '1'.repeat(64)}, {admin: true}); assert.equal(denied.status, 401); assert.equal(denied.data.deviceId, one.deviceId);
  await stop();
  base = await start();
  const stillRevoked = await request(base, '/api/request-metrics', undefined, {credential: one.credential}); assert.equal(stillRevoked.status, 401); assert.equal(stillRevoked.data.code, 'DEVICE_REVOKED');
  const nextLogin = await request(base, '/api/login', {key: fixture.owner}); assert.equal(nextLogin.status, 200);
  const approval = await request(base, '/api/devices/reenroll', {deviceId: one.deviceId, confirmDeviceId: one.deviceId}, {owner: nextLogin.cookie}); assert.equal(approval.status, 200); assert.equal('credential' in approval.data, false);
  assert.equal((await request(base, '/api/devices/claim-reenrollment', {deviceId: one.deviceId, pairingHash: '2'.repeat(64)}, {admin: true})).status, 403);
  const claimed = await request(base, '/api/devices/claim-reenrollment', {deviceId: one.deviceId, pairingHash: '1'.repeat(64)}, {admin: true}); assert.equal(claimed.status, 200); assert.equal(claimed.data.reenrollment.deviceId, one.deviceId);
  assert.equal((await request(base, '/api/request-metrics', undefined, {credential: claimed.data.credential})).data.code, 'DEVICE_SCOPE_FORBIDDEN');
  assert.equal((await request(base, '/api/request-metrics', undefined, {credential: one.credential})).data.code, 'DEVICE_REVOKED');
  await stop();
  const databases = await sqliteFiles(path.join(temp, 'state')); assert(databases >= 1);
  console.log(JSON.stringify({passed: true, platform: process.platform, node: process.version, wrangler: version, engine: 'actual local workerd', sqliteDatabases: databases, processRestartVerified: true, requests, cloudResourcesCreated: false, testCallsLimitedTo: 'local device management and authorization'}));
} finally {
  await stop();
  const resolved = await fs.realpath(temp), parent = await fs.realpath(os.tmpdir()), info = await fs.lstat(temp);
  if (info.isDirectory() && !info.isSymbolicLink() && path.dirname(resolved) === parent && path.basename(resolved).startsWith('device-workerd-')) await fs.rm(resolved, {recursive: true, force: true});
}
