import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';

const ownPortableIdentity = 'portable:' + crypto.randomUUID();
const portableHeld = new Set();
const error = (code, message) => Object.assign(new Error(message), { code });
export async function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(') ') + 2).split(' ');
      // Exited processes retain /proc identity until their parent reaps them,
      // but their file descriptors and kernel flocks have already closed.
      if (fields[0] === 'Z' || fields[0] === 'X') return null;
      return fields[19] + ':' + (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; return undefined; }
  }
  if (pid === process.pid) return ownPortableIdentity;
  try { process.kill(pid, 0); return undefined; } catch (e) { return e.code === 'ESRCH' ? null : undefined; }
}
export async function ownerState(record, identity = processIdentity) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid < 1) return 'unknown';
  const actual = await identity(record.pid);
  if (actual === null) return 'dead';
  if (actual === undefined) return 'unknown';
  if (typeof record.identity !== 'string' || record.identity === 'live') return 'unknown';
  return record.identity === actual ? 'live' : 'dead';
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function noLinks(directory) {
  const absolute = path.resolve(directory), base = path.parse(absolute).root; let current = base;
  for (const component of absolute.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component); const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('LOCK_PATH_UNSAFE', 'Lock directory must not contain symbolic links.');
  }
}
async function flock(fd, signal) {
  signal?.throwIfAborted();
  // Linux flock attaches to the inherited open-file description. The child
  // exits after acquiring it; the parent's descriptor retains the OS lock.
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['-n', '-E', '73', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], windowsHide: true });
    const abort = () => child.kill('SIGKILL'); signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', code => { signal?.removeEventListener('abort', abort); if (signal?.aborted) reject(signal.reason); else if (code === 0) resolve(true); else if (code === 73) resolve(false); else reject(error('LOCK_BACKEND_FAILED', 'OS advisory lock failed.')); });
  });
}
async function publish(file, value) {
  const temp = file + '.owner-' + crypto.randomUUID(); let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    await fs.link(temp, file);
  } finally { await handle?.close(); await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

/** Linux: kernel flock held by this process's descriptor, crash-safe without
 * deleting the persistent .oslock inode. Portable mode supports live exclusion
 * but refuses stale takeover across processes rather than pretending OS proof.
 * An ambiguous legacy empty file requires operator recovery, never age-based rm.
 */
export async function acquireProcessLock(file, { timeoutMs = 2000, signal, identity = processIdentity } = {}) {
  file = path.resolve(file); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await noLinks(path.dirname(file));
  const until = Date.now() + timeoutMs, nonce = crypto.randomUUID(); let handle, ownLegacy = false, portable = false;
  const owner = { version: 2, pid: process.pid, identity: await identity(process.pid), nonce };
  if (!owner.identity) throw error('LOCK_IDENTITY_UNAVAILABLE', 'Cannot establish lock owner identity.');
  try {
    if (process.platform === 'linux') {
      const osfile = file + '.oslock';
      try { handle = await fs.open(osfile, 'wx+', 0o600); }
      catch (e) { if (e.code !== 'EEXIST') throw e; const stat = await fs.lstat(osfile); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw error('LOCK_PATH_UNSAFE', 'Unsafe lock file.'); handle = await fs.open(osfile, constants.O_RDWR | constants.O_NOFOLLOW); }
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid() || (opened.mode & 0o022)) throw error('LOCK_PATH_UNSAFE', 'Lock file must be private and singly linked.');
      if (!sameFile(opened, await fs.lstat(osfile))) throw error('LOCK_PATH_CHANGED', 'Lock path changed.');
      while (!await flock(handle.fd, signal)) {
        if (Date.now() >= until) throw error('LOCK_BUSY', 'Another process owns this operation.');
        await new Promise(resolve => setTimeout(resolve, 25)); signal?.throwIfAborted();
      }
      if ((await handle.stat()).nlink !== 1 || !sameFile(await handle.stat(), await fs.lstat(osfile))) throw error('LOCK_PATH_CHANGED', 'Lock path changed.');
      await handle.truncate(0); await handle.writeFile(JSON.stringify(owner)); await handle.sync();
    } else {
      while (portableHeld.has(file)) { if (Date.now() >= until) throw error('LOCK_BUSY', 'Another operation owns this lock.'); await new Promise(resolve => setTimeout(resolve, 10)); signal?.throwIfAborted(); }
      portableHeld.add(file); portable = true;
    }
    // Reserve the old namespace too, so legacy wx writers cannot enter while
    // an upgraded process holds the kernel lock. Publication is never empty.
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw error('LOCK_PATH_UNSAFE', 'Unsafe legacy lock.');
      let held; try { held = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw error('LOCK_RECOVERY_REQUIRED', 'Legacy lock has no verifiable process identity.'); }
      const state = await ownerState(held, identity);
      if (state !== 'dead') throw error(state === 'live' ? 'LOCK_BUSY' : 'LOCK_RECOVERY_REQUIRED', 'Legacy lock owner is active or cannot be verified.');
      if (process.platform !== 'linux') throw error('LOCK_RECOVERY_REQUIRED', 'Stale lock takeover requires the OS locking backend.');
      if (!sameFile(stat, await fs.lstat(file))) throw error('LOCK_PATH_CHANGED', 'Legacy lock changed.');
      await fs.unlink(file);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await publish(file, owner); ownLegacy = true;
    let released = false;
    return { owner, inheritedFd: handle?.fd, backend: process.platform === 'linux' ? 'flock-open-description' : 'portable-fail-closed', async release() {
      if (released) return; released = true;
      try { const current = JSON.parse(await fs.readFile(file, 'utf8')); if (current.nonce !== nonce) throw error('LOCK_OWNER_CHANGED', 'Lock ownership changed.'); await fs.unlink(file); }
      finally { await handle?.close(); if (portable) portableHeld.delete(file); }
    } };
  } catch (e) {
    if (ownLegacy) await fs.unlink(file).catch(() => {});
    await handle?.close(); if (portable) portableHeld.delete(file); throw e;
  }
}
