import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { WorkbenchError, within } from './policy.mjs';
import privateSource from './source-private.cjs';
import { acquireProcessLock, processIdentity, ownerState } from './process-lock.mjs';
const { isPrivateSourcePath } = privateSource;

export const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function sourceBytes(root, file) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new WorkbenchError('CHECKPOINT_CHANGED', 'Source is linked, oversized or changed.');
    // O_NOFOLLOW protects only the final component. Confirm the opened inode,
    // not a pre-open path check, when a guest may replace an ancestor symlink.
    if (process.platform === 'linux') {
      const actual = await fs.realpath('/proc/self/fd/' + handle.fd);
      if (actual !== file || !within(root, actual)) throw new WorkbenchError('CHECKPOINT_CHANGED', 'Opened source escaped its project.');
    }
    const buffer = Buffer.alloc(stat.size + 1); let size = 0;
    while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size > stat.size) throw new WorkbenchError('CHECKPOINT_CHANGED', 'Source grew while being captured.');
    return buffer.subarray(0, size);
  }
  finally { await handle.close(); }
}
export async function readJSON(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
export async function syncDirectory(directory) {
  if (process.platform !== 'linux') return;
  const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export async function atomicJSON(file, data, { durable = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  let handle;
  try { handle = await fs.open(tmp, 'wx', 0o600); await handle.writeFile(JSON.stringify(data, null, 2)); if (durable) await handle.sync(); await handle.close(); handle = null; await fs.rename(tmp, file); if (durable) await syncDirectory(path.dirname(file)); }
  finally { await handle?.close(); await fs.unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function syncTreeDirectories(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await syncTreeDirectories(path.join(directory, entry.name));
  await syncDirectory(directory);
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
export class ProjectLocks {
  constructor(directory) { this.directory = directory; this.serial = Promise.resolve(); }
  exclusive(fn) {
    const run = this.serial.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const lock = await acquireProcessLock(path.join(this.directory, 'allocation.lock'));
      try { return await fn(); } finally { await lock.release(); }
    });
    this.serial = run.catch(() => {}); return run;
  }
  async records() {
    const records = [];
    for (const name of await fs.readdir(this.directory)) {
      if (!name.endsWith('.lease.json')) continue;
      const file = path.join(this.directory, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new WorkbenchError('LEASE_RECOVERY_REQUIRED', 'Unsafe project lease requires review.');
      const record = await readJSON(file, null);
      if (!record || typeof record.root !== 'string' || typeof record.sessionId !== 'string') throw new WorkbenchError('LEASE_RECOVERY_REQUIRED', 'Malformed project lease requires review.');
      if (await ownerState(record) === 'dead') await fs.unlink(file);
      else records.push(record);
    }
    return records;
  }
  async acquire(root, sessionId) {
    root = await fs.realpath(root);
    return this.exclusive(async () => {
      for (const record of await this.records()) if (record.sessionId !== sessionId && (within(root, record.root) || within(record.root, root))) throw new WorkbenchError('PROJECT_WRITER_HELD', 'Another run owns this project: ' + record.sessionId);
      const record = { root, sessionId, pid: process.pid, identity: await processIdentity(), at: Date.now() };
      await atomicJSON(path.join(this.directory, hash(sessionId) + '.lease.json'), record); return record;
    });
  }
  async release(sessionId) { return this.exclusive(async () => { const file = path.join(this.directory, hash(sessionId) + '.lease.json'), record = await readJSON(file, null); if (record?.pid === process.pid && record.identity === await processIdentity()) await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); }); }
}
const EXCLUDED = new Set(['.git', '.harness', 'node_modules', '.agents', 'bin', 'obj', 'dist', 'out', 'build', 'coverage', '.next', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'artifacts', 'screenshots', 'test-results', 'playwright-report', 'logs']);
export const excludedSourcePath = relative => isPrivateSourcePath(relative) || relative.split('/').some(part => EXCLUDED.has(part) || part.endsWith('.log'));
export function manifestDigest(manifest) {
  return manifest.version === 2 ? hash(JSON.stringify({ version: 2, inventoryComplete: manifest.inventoryComplete, inventory: Object.entries(manifest.inventory).sort(), files: Object.entries(manifest.files).sort() })) : hash(JSON.stringify(Object.entries(manifest.files).sort()));
}
export async function sourceManifest(root, { maxFiles = 5000, maxBytes = 32 * 1024 * 1024, maxEntries = 50000, signal } = {}) {
  root = await fs.realpath(root);
  const files = Object.create(null), inventory = Object.create(null); let bytes = 0, count = 0, entries = 0, inventoryComplete = true;
  async function walk(directory, relative = '') {
    signal?.throwIfAborted();
    let listing; try { listing = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (!relative) throw error; inventory[relative] = { kind: 'directory', state: 'excluded', reason: 'unreadable' }; inventoryComplete = false; return; }
    for (const entry of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (++entries > maxEntries) throw new WorkbenchError('CHECKPOINT_TOO_LARGE', 'Source inventory exceeds its configured limit.');
      const rel = relative ? relative + '/' + entry.name : entry.name, name = path.join(directory, entry.name);
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
      const reason = isPrivateSourcePath(rel) ? 'private' : entry.isSymbolicLink() ? 'symlink' : EXCLUDED.has(entry.name) ? 'generated-or-runtime' : entry.name.endsWith('.log') ? 'log' : null;
      if (reason) { inventory[rel] = { kind, state: 'excluded', reason }; continue; }
      if (entry.isDirectory()) { inventory[rel] = { kind, state: 'directory' }; await walk(name, rel); continue; }
      if (!entry.isFile()) { inventory[rel] = { kind, state: 'excluded', reason: 'special-file' }; continue; }
      const stat = await fs.lstat(name);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkbenchError('CHECKPOINT_CHANGED', 'Source changed during inventory.');
      if (stat.nlink !== 1) { inventory[rel] = { kind, state: 'excluded', reason: 'hard-link' }; continue; }
      if (stat.size > 1024 * 1024) { inventory[rel] = { kind, state: 'excluded', reason: 'per-file-limit', bytes: stat.size, mtimeMs: stat.mtimeMs }; continue; }
      if (++count > maxFiles || bytes + stat.size > maxBytes) throw new WorkbenchError('CHECKPOINT_TOO_LARGE', 'Source checkpoint exceeds its configured budget.');
      const data = await sourceBytes(root, await canonicalInside(root, rel));
      if (data.length > 1024 * 1024 || bytes + data.length > maxBytes) throw new WorkbenchError('CHECKPOINT_CHANGED', 'Source grew during inventory.');
      let binary = data.includes(0);
      try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { binary = true; }
      bytes += data.length; files[rel] = { sha256: hash(data), bytes: data.length, binary };
      inventory[rel] = { kind, state: 'backed-up' };
    }
  }
  await walk(root); const manifest = { version: 2, inventoryComplete, inventory, files, bytes };
  if (Buffer.byteLength(JSON.stringify(manifest)) > 8 * 1024 ** 2) throw new WorkbenchError('CHECKPOINT_TOO_LARGE', 'Source inventory metadata exceeds limit.');
  return { ...manifest, sha256: manifestDigest(manifest) };
}
export async function saveCheckpoint(root, destination, manifest, { signal, minFreeBytes = 2 * 1024 ** 3 } = {}) {
  if (Object.keys(manifest.files).some(isPrivateSourcePath)) throw new WorkbenchError('CHECKPOINT_PRIVATE_PATH', 'Private runtime files cannot be retained in a source checkpoint.');
  const capacity = await fs.statfs(root);
  const available = Number(capacity.bavail) * Number(capacity.bsize);
  if (!Number.isFinite(available) || !Number.isFinite(manifest.bytes) || available - manifest.bytes < minFreeBytes) throw new WorkbenchError('CHECKPOINT_DISK_RESERVE', 'Keeping disk reserve; previous checkpoint is retained.');
  const staging = destination + '.' + crypto.randomUUID(); await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
  for (const [relative, expected] of Object.entries(manifest.files)) {
    signal?.throwIfAborted();
    const source = await canonicalInside(root, relative), data = await sourceBytes(await fs.realpath(root), source);
    if (data.length !== expected.bytes || hash(data) !== expected.sha256) throw new WorkbenchError('CHECKPOINT_CHANGED', 'Source changed while checkpointing; previous checkpoint is retained.');
    const target = path.join(staging, 'files', relative); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); const output = await fs.open(target, 'wx', 0o600); try { await output.writeFile(data); await output.sync(); } finally { await output.close(); }
  }
  await atomicJSON(path.join(staging, 'checkpoint-manifest.json'), manifest, { durable: true });
  await syncTreeDirectories(staging); await syncDirectory(path.dirname(staging));
  // Versioned checkpoints are never replaced in place; readers see one complete generation.
  return staging;
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
}
