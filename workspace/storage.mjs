import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkbenchError, within } from './policy.mjs';

export const hash = data => crypto.createHash('sha256').update(data).digest('hex');
export async function readJSON(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
export async function atomicJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); await fs.rename(tmp, file);
}
export async function canonicalInside(root, relative, allowMissing = false) {
  root = await fs.realpath(root);
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw new WorkbenchError('OUTSIDE_PROJECT', 'Path is outside the project.', 403);
  let current = root;
  for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); } catch (e) { if (e.code === 'ENOENT' && allowMissing) break; throw e; }
    if (stat.isSymbolicLink()) throw new WorkbenchError('SYMLINK_REFUSED', 'Symbolic links cannot be edited.', 403);
  }
  return target;
}
async function ownerIdentity(pid = process.pid) {
  try { return (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19] + ':' + (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); }
  catch { try { process.kill(pid, 0); return 'live'; } catch { return null; } }
}
export class ProjectLocks {
  constructor(directory) { this.directory = directory; this.serial = Promise.resolve(); }
  exclusive(fn) {
    const run = this.serial.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const lock = path.join(this.directory, 'allocation.lock'); let handle;
      for (let i = 0; i < 100; i++) {
        try { handle = await fs.open(lock, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, identity: await ownerIdentity() })); break; }
        catch (e) { if (e.code !== 'EEXIST') throw e; const held = await readJSON(lock, {}); if (held.pid && await ownerIdentity(held.pid) !== held.identity) { await fs.unlink(lock).catch(() => {}); continue; } await new Promise(r => setTimeout(r, 20)); }
      }
      if (!handle) throw new WorkbenchError('LOCK_BUSY', 'Another workspace operation is in progress.');
      try { return await fn(); } finally { await handle.close(); await fs.unlink(lock).catch(() => {}); }
    });
    this.serial = run.catch(() => {}); return run;
  }
  async records() {
    const records = [];
    for (const name of await fs.readdir(this.directory)) {
      if (!name.endsWith('.lease.json')) continue;
      const file = path.join(this.directory, name), record = await readJSON(file, null);
      if (record && await ownerIdentity(record.pid) === record.identity) records.push(record);
      else await fs.unlink(file).catch(() => {});
    }
    return records;
  }
  async acquire(root, sessionId) {
    root = await fs.realpath(root);
    return this.exclusive(async () => {
      for (const record of await this.records()) if (record.sessionId !== sessionId && (within(root, record.root) || within(record.root, root))) throw new WorkbenchError('PROJECT_WRITER_HELD', 'Another run owns this project: ' + record.sessionId);
      const record = { root, sessionId, pid: process.pid, identity: await ownerIdentity(), at: Date.now() };
      await atomicJSON(path.join(this.directory, hash(sessionId) + '.lease.json'), record); return record;
    });
  }
  async release(sessionId) { return this.exclusive(async () => { const file = path.join(this.directory, hash(sessionId) + '.lease.json'), record = await readJSON(file, null); if (record?.pid === process.pid) await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); }); }
}
const EXCLUDED = new Set(['.git', '.harness', 'node_modules', '.agents', 'bin', 'obj', 'dist', 'build', 'coverage', '.next', '.venv', 'venv', '__pycache__']);
export async function sourceManifest(root, { maxFiles = 5000, maxBytes = 32 * 1024 * 1024, signal } = {}) {
  const files = {}; let bytes = 0, count = 0;
  async function walk(directory, relative = '') {
    signal?.throwIfAborted();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name) || entry.isSymbolicLink()) continue;
      const rel = relative ? relative + '/' + entry.name : entry.name, name = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(name, rel); continue; }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(name); if (stat.size > 1024 * 1024) continue;
      if (++count > maxFiles || bytes + stat.size > maxBytes) throw new WorkbenchError('CHECKPOINT_TOO_LARGE', 'Source checkpoint exceeds its configured budget.');
      const data = await fs.readFile(name); if (data.includes(0)) continue;
      try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { continue; }
      bytes += data.length; files[rel] = { sha256: hash(data), bytes: data.length };
    }
  }
  await walk(root); return { files, bytes, sha256: hash(JSON.stringify(Object.entries(files).sort())) };
}
export async function saveCheckpoint(root, destination, manifest) {
  const staging = destination + '.' + crypto.randomUUID(); await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const source = await canonicalInside(root, relative), data = await fs.readFile(source);
    if (hash(data) !== expected.sha256) throw new WorkbenchError('CHECKPOINT_CHANGED', 'Source changed while checkpointing; previous checkpoint is retained.');
    const target = path.join(staging, relative); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.writeFile(target, data, { mode: 0o600 });
  }
  await atomicJSON(path.join(staging, 'checkpoint-manifest.json'), manifest);
  // Versioned checkpoints are never replaced in place; readers see one complete generation.
  return staging;
}
