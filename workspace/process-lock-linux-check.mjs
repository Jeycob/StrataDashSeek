// Explicit Linux-only kernel/crash gate, separate from portable regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireProcessLock } from './process-lock.mjs';
if (process.platform !== 'linux') throw Error('Run this gate with Linux Node, not a Windows filesystem emulation.');
async function fixture(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kernel-lease-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return path.join(directory, 'operation.lock'); }
const moduleURL = new URL('./process-lock.mjs', import.meta.url).href;
function holder(file) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import{acquireProcessLock}from${JSON.stringify(moduleURL)};await acquireProcessLock(process.argv[1]);console.log('READY');setInterval(()=>{},1000);`, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(Error('Holder failed')); }); });
  return { child, ready };
}
test('kernel lock survives helper exit, cannot be stolen, and releases on parent crash', { timeout: 10000 }, async t => {
  const file = await fixture(t), { child, ready } = holder(file); t.after(() => child.kill('SIGKILL')); await ready;
  assert.equal(spawnSync('flock', ['-n', '-E', '73', file + '.oslock', 'true']).status, 73);
  await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_BUSY' });
  const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await stopped;
  const recovered = await acquireProcessLock(file); await recovered.release();
  assert.equal(spawnSync('flock', ['-n', file + '.oslock', 'true']).status, 0);
});
test('empty new kernel namespace recovers, hardlink and symlink namespace fail closed', async t => {
  const file = await fixture(t); await fs.writeFile(file + '.oslock', '', { mode: 0o600 });
  const first = await acquireProcessLock(file); await first.release(); await fs.unlink(file + '.oslock');
  const other = file + '.source'; await fs.writeFile(other, 'preserve', { mode: 0o600 }); await fs.link(other, file + '.oslock');
  await assert.rejects(acquireProcessLock(file), { code: 'LOCK_PATH_UNSAFE' }); assert.equal(await fs.readFile(other, 'utf8'), 'preserve');
  await fs.unlink(file + '.oslock'); await fs.symlink(other, file + '.oslock'); await assert.rejects(acquireProcessLock(file), { code: 'LOCK_PATH_UNSAFE' });
});
test('release does not close a subsequently reused descriptor', async t => {
  const file = await fixture(t), lock = await acquireProcessLock(file); await lock.release();
  const unrelated = await fs.open(file + '.other', 'wx+');
  try { await lock.release(); await unrelated.writeFile('still open'); await unrelated.sync(); } finally { await unrelated.close(); }
});
test('reused PID metadata is reclaimed under OS guard without stealing the new live lease', async t => {
  const file = await fixture(t); await fs.writeFile(file, JSON.stringify({ pid: process.pid, identity: 'different-process-start:previous-boot' }), { mode: 0o600 });
  const lock = await acquireProcessLock(file); await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_BUSY' }); await lock.release();
});
test('a surviving owned checker inherits the kernel guard after its parent crashes', { timeout: 10000 }, async t => {
  const file = await fixture(t);
  const script = `import{acquireProcessLock}from${JSON.stringify(moduleURL)};import{spawn}from'node:child_process';const lock=await acquireProcessLock(process.argv[1]);const job=spawn('sleep',['0.7'],{stdio:['ignore','ignore','ignore',lock.inheritedFd]});job.once('spawn',()=>console.log('READY'));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: ['ignore', 'pipe', 'pipe'] }); t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await stopped;
  assert.equal(spawnSync('flock', ['-n', '-E', '73', file + '.oslock', 'true']).status, 73);
  const recovered = await acquireProcessLock(file, { timeoutMs: 2000 }); await recovered.release();
});
