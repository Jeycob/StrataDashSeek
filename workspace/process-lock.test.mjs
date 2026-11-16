import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireProcessLock, ownerState, processIdentity } from './process-lock.mjs';
async function fixture(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'process-lease-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return path.join(directory, 'operation.lock'); }
test('process start and boot identity distinguish live owner, reused PID, dead and unknown', async () => {
  const record = { pid: 123, identity: 'start-A:boot-A' };
  assert.equal(await ownerState(record, async () => 'start-A:boot-A'), 'live');
  assert.equal(await ownerState(record, async () => 'start-B:boot-A'), 'dead');
  assert.equal(await ownerState(record, async () => 'start-A:boot-B'), 'dead');
  assert.equal(await ownerState(record, async () => null), 'dead');
  assert.equal(await ownerState(record, async () => undefined), 'unknown');
  assert.equal(await ownerState({ pid: 123, identity: 'live' }, async () => 'actual'), 'unknown');
});
test('live lock is not stolen; release is idempotent and permits the next operation', async t => {
  const file = await fixture(t), first = await acquireProcessLock(file);
  await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_BUSY' });
  await first.release(); await first.release(); const next = await acquireProcessLock(file); await next.release();
});
test('legacy empty or malformed lock requires evidence, never age-based deletion', async t => {
  const file = await fixture(t); await fs.writeFile(file, ''); await fs.utimes(file, 0, 0);
  await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_RECOVERY_REQUIRED' });
  assert.equal(await fs.readFile(file, 'utf8'), '');
  await fs.writeFile(file, '{invalid'); await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_RECOVERY_REQUIRED' });
});
test('valid live legacy metadata is protected', async t => {
  const file = await fixture(t), owner = { pid: process.pid, identity: await processIdentity() }; await fs.writeFile(file, JSON.stringify(owner));
  await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_BUSY' });
  assert.equal(JSON.parse(await fs.readFile(file)).identity, owner.identity);
});
test('hard-linked lock cannot truncate or delete another file', async t => {
  const file = await fixture(t), original = file + '.source'; await fs.writeFile(original, 'protected source');
  await fs.link(original, file);
  await assert.rejects(acquireProcessLock(file), { code: 'LOCK_PATH_UNSAFE' });
  assert.equal(await fs.readFile(original, 'utf8'), 'protected source');
});

test('an unreaped Linux zombie releases ownership without replacing the kernel lock inode', { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  const file = await fixture(t);
  // Python deliberately does not waitpid until this test has checked the actual
  // Z process. A normally spawned Node child would be reaped by libuv first.
  const driver = `import os,sys,time,json,select
pid=os.fork()
if pid==0:
 os.execl(sys.argv[1],sys.argv[1],"--input-type=module","-e",sys.argv[2],sys.argv[3],sys.argv[4])
for i in range(1000):
 try:
  state=open("/proc/%s/stat"%pid).read().rsplit(") ",1)[1].split()[0]
 except FileNotFoundError:
  state="gone"
 if state=="Z":
  print(json.dumps({"pid":pid,"state":state}),flush=True)
  if select.select([sys.stdin],[],[],10)[0]: sys.stdin.readline()
  os.waitpid(pid,0)
  sys.exit(0)
 time.sleep(.01)
raise RuntimeError("Actual zombie was not observed")
`;
  const childCode = 'const {acquireProcessLock}=await import(process.argv[1]);await acquireProcessLock(process.argv[2]);process.exit(0);';
  const child = spawn('python3', ['-c', driver, process.execPath, childCode, new URL('./process-lock.mjs', import.meta.url).href, file], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  try {
    const row = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(Error('Zombie fixture handshake timed out')), 12000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(Error('Zombie fixture exited before handshake: ' + stderr)); });
      child.stdout.on('data', chunk => { output += chunk; if (!output.includes('\n')) return; clearTimeout(timer); try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); } });
    });
    assert.equal(row.state, 'Z');
    assert.equal((await fs.readFile(`/proc/${row.pid}/stat`, 'utf8')).split(') ').at(-1).split(' ')[0], 'Z');
    const previous = JSON.parse(await fs.readFile(file, 'utf8')), inode = await fs.stat(file + '.oslock');
    assert.equal(previous.pid, row.pid); assert.equal(typeof previous.identity, 'string');
    assert.equal(await processIdentity(row.pid), null);
    assert.equal(await ownerState(previous), 'dead');
    const next = await acquireProcessLock(file, { timeoutMs: 0 });
    try {
      const current = await fs.stat(file + '.oslock'); assert.equal(current.dev, inode.dev); assert.equal(current.ino, inode.ino);
      assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pid, process.pid);
      await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_BUSY' });
    } finally { await next.release(); }
  } finally { child.stdin.end('reap\n'); const terminal = await closed; assert.deepEqual(terminal, { code: 0, signal: null }, stderr); }
});
