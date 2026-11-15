'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawn} = require('node:child_process'), {DatabaseSync} = require('node:sqlite');
const {NotificationOutbox} = require('./notification-outbox.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-outbox-')), file = path.join(root, 'outbox.sqlite'), boxes = []; let now = 1700000000000;
  const create = options => {const box = new NotificationOutbox(file, {now: () => now, random: () => 0.5, minFreeBytes: 0, send: async () => ({statusCode: 201}), ...options}); boxes.push(box); return box;};
  t.after(async () => {for (const box of boxes) await box.stop(); const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert(path.basename(resolved).startsWith('notification-outbox-')); assert.equal(fs.lstatSync(root).isSymbolicLink(), false); fs.rmSync(resolved, {recursive: true, force: true});});
  return {root, file, create, advance(ms) {now += ms;}};
}
test('durable enqueue survives an actual killed process and duplicate retries keep their original target snapshot', {timeout: 10000}, async t => {
  const f = fixture(t), source = 'const{NotificationOutbox}=require(process.argv[1]);const q=new NotificationOutbox(process.argv[2],{now:()=>1700000000000,minFreeBytes:0,send:async()=>({statusCode:201})});q.enqueue("done","event:1",["phoneA","phoneB"]);console.log("ready");setInterval(()=>{},1000);';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', source, require.resolve('./notification-outbox.cjs'), f.file], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const exited = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {let text = ''; const timer = setTimeout(() => reject(Error('Fixture child timeout')), 4000); child.once('error', reject); child.stdout.on('data', chunk => {text += chunk; if (text.includes('ready')) {clearTimeout(timer); resolve();}}); child.once('exit', () => {if (!text.includes('ready')) {clearTimeout(timer); reject(Error('Fixture child exited before persistence'));}});});
    child.kill('SIGKILL'); await exited;
  } finally {if (child.exitCode === null && child.signalCode === null) {child.kill('SIGKILL'); await exited;}}
  const sent = [], box = f.create({send: async target => {sent.push(target); return {statusCode: 201};}});
  assert.equal(box.metrics().queuedTargets, 2);
  assert.equal(box.enqueue('done', 'event:1', ['different-phone']).duplicate, true);
  await box.tick(); assert.deepEqual(sent, ['phoneA', 'phoneB']); assert.equal(box.metrics().providerAcceptedTargets, 2); assert.equal(box.metrics().deliveryConfirmed, false);
});
test('two transient failures retry across SQLite reopen and become provider-accepted without duplicate enqueue', async t => {
  const f = fixture(t); let calls = 0;
  const send = async () => {calls++; if (calls <= 2) throw {statusCode: 503}; return {statusCode: 201};};
  let box = f.create({send}); box.enqueue('done', 'event:retry', ['phone']);
  await box.tick(); assert.equal(box.delivery('event:retry', 'phone').attempts, 1); await box.stop();
  f.advance(1001); box = f.create({send}); assert.equal(box.enqueue('done', 'event:retry', ['phone']).duplicate, true);
  await box.tick(); assert.equal(box.delivery('event:retry', 'phone').attempts, 2); await box.stop();
  f.advance(2001); box = f.create({send}); await box.tick();
  assert.equal(calls, 3); assert.equal(box.delivery('event:retry', 'phone').phase, 'provider-accepted');
  await box.tick(); assert.equal(calls, 3);
});
test('provider410 retires a device durably and an explicit new subscription can reenable future events', async t => {
  const f = fixture(t); let calls = 0;
  let box = f.create({send: async () => {calls++; throw {statusCode: 410};}}); box.enqueue('done', 'event:gone', ['phone']); await box.tick(); await box.stop();
  box = f.create({send: async () => {calls++; return {statusCode: 201};}});
  assert.equal(box.isRetired('phone'), true); box.enqueue('done', 'event:later', ['phone']); await box.tick(); assert.equal(calls, 1);
  box.reinstate('phone'); box.enqueue('done', 'event:new-subscription', ['phone']); await box.tick(); assert.equal(calls, 2);
});
test('a late410 from a replaced in-flight subscription cannot retire its replacement', async t => {
  const f = fixture(t); let rejectOld, calls = 0;
  const box = f.create({send: async () => {calls++; if (calls === 1) return new Promise((_, reject) => {rejectOld = reject;}); return {statusCode: 201};}});
  box.enqueue('done', 'event:old-subscription', ['phone']); const tick = box.tick(); await new Promise(setImmediate);
  box.reinstate('phone'); box.enqueue('done', 'event:new-subscription', ['phone']); rejectOld({statusCode: 410}); await tick;
  assert.equal(box.isRetired('phone'), false); assert.equal(box.delivery('event:new-subscription', 'phone').phase, 'provider-accepted');
});
test('unexpired attempt leases survive controller restart, then retry without resetting the attempt bound', async t => {
  const f = fixture(t); let calls = 0;
  let box = f.create({maxAttempts: 2}); box.enqueue('error', 'event:lease', ['phone']); box.claim(); await box.stop();
  box = f.create({maxAttempts: 2, send: async () => {calls++; throw {statusCode: 503};}});
  await box.tick(); assert.equal(calls, 0);
  f.advance(30001); await box.tick(); assert.equal(calls, 1); assert.equal(box.delivery('event:lease', 'phone').phase, 'failed');
  f.advance(60000); await box.tick(); assert.equal(calls, 1);
});
test('expired events, capacity limits and failed SQLite writes are not false provider or persistence success', async t => {
  const f = fixture(t); let calls = 0;
  const box = f.create({send: async () => {calls++; return {statusCode: 201};}});
  assert.equal(box.enqueue('attention', 'event:expired', ['phone'], {occurredAt: 1}).queuedTargets, 0); await box.tick(); assert.equal(calls, 0);
  box.minFreeBytes = Number.MAX_SAFE_INTEGER;
  assert.equal(box.enqueue('attention', 'event:expired', ['phone']).duplicate, true);
  assert.throws(() => box.enqueue('done', 'event:new', ['phone']), {code: 'OUTBOX_CAPACITY'}); box.minFreeBytes = 0;
  box.db.exec('PRAGMA query_only=ON'); assert.throws(() => box.enqueue('done', 'event:readonly', ['phone'])); assert.equal(box.metrics().persistedEvents, 1);
});
test('foreign SQLite stores, linked files and malformed event identities are rejected', async t => {
  const f = fixture(t), db = new DatabaseSync(f.file); db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('fixture-retained')"); db.close();fs.chmodSync(f.file,0o600);
  assert.throws(() => f.create(), {code: 'OUTBOX_STORE_INVALID'});
  const retained = new DatabaseSync(f.file); assert.equal(retained.prepare('SELECT value FROM retained').get().value, 'fixture-retained'); retained.close();
  fs.renameSync(f.file, f.file + '.original'); fs.linkSync(f.file + '.original', f.file);
  assert.throws(() => f.create(), {code: 'OUTBOX_UNSAFE_FILE'}); fs.unlinkSync(f.file); fs.unlinkSync(f.file + '.original');
  const box = f.create(); assert.throws(() => box.enqueue('done', null, ['phone']), {code: 'INVALID_NOTIFICATION_EVENT'}); assert.throws(() => box.retire(undefined), {code: 'INVALID_NOTIFICATION_DEVICE'});
});

test('SQLite sidecar aliases and nonprivate metadata are refused before opening or touching retained targets',async t=>{
 const f=fixture(t),retained=f.file+'.retained';fs.writeFileSync(retained,'retained target bytes',{mode:0o600});
 for(const suffix of ['-wal','-shm','-journal']){
  const sidecar=f.file+suffix;fs.linkSync(retained,sidecar);
  assert.throws(()=>f.create(),{code:'OUTBOX_UNSAFE_FILE'});assert.equal(fs.readFileSync(retained,'utf8'),'retained target bytes');assert.equal(fs.existsSync(f.file),false);fs.unlinkSync(sidecar);
  if(process.platform!=='win32'){
   fs.symlinkSync(retained,sidecar);assert.throws(()=>f.create(),{code:'OUTBOX_UNSAFE_FILE'});fs.unlinkSync(sidecar);
   fs.writeFileSync(sidecar,'private sidecar',{mode:0o600});fs.chmodSync(sidecar,0o644);assert.throws(()=>f.create(),{code:'OUTBOX_UNSAFE_FILE'});fs.chmodSync(sidecar,0o600);
   if(process.getuid()===0){fs.chownSync(sidecar,65534,65534);assert.throws(()=>f.create(),{code:'OUTBOX_UNSAFE_FILE'});fs.chownSync(sidecar,0,0);}fs.unlinkSync(sidecar);
  }
 }
 const box=f.create();if(process.platform!=='win32')for(const suffix of ['','-wal','-shm'])assert.equal(fs.statSync(f.file+suffix).mode&0o077,0);
 await box.stop();
});
