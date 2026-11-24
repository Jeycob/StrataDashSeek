import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import localFs, { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { relativeFile } from '../../workspace/policy.mjs';
import privateSource from '../../workspace/source-private.cjs';
import { canonicalInside } from '../../workspace/storage.mjs';

const maxDirectoryEntries = 128;
const maxDirectories = 16;
const maxFingerprints = 32;
const maxFileBytes = 256 * 1024;
const maxSnapshotBytes = 1024 * 1024;
const maxPresentedPaths = 16;
const deliverableExtension = /\.(?:html?|md|txt|rtf|csv|tsv|pdf|docx|xlsx|pptx|odt|ods|odp|svg|png|jpe?g|webp|gif|zip)$/iu;
const original = Symbol.for('cordis.original');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const deadline = signal => AbortSignal.any([signal, AbortSignal.timeout(1500)]);
const identity = value => value?.[original] ?? value;
const excluded = name => name.startsWith('.') || name === 'node_modules' || privateSource.isPrivateSourcePath(name);

async function boundedEntries(rootPath, directory, probe) {
  if (directory !== rootPath) await canonicalInside(rootPath, path.relative(rootPath, directory));
  if (probe.aborted) return;
  const pin = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const fdPath = '/proc/self/fd/' + pin.fd;
    const before = await pin.stat({ bigint: true });
    if (!before.isDirectory() || await realpath(fdPath) !== directory || probe.aborted) return;
    const handle = await localFs.opendir(fdPath, { bufferSize: 16 });
    try {
      const entries = [];
      while (!probe.aborted && entries.length <= maxDirectoryEntries) {
        const item = await handle.read();
        if (item) { entries.push(item); continue; }
        const after = await lstat(directory, { bigint: true });
        if (!probe.aborted && after.isDirectory() && before.dev === after.dev && before.ino === after.ino &&
            before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
            await realpath(fdPath) === directory && !probe.aborted) return entries;
        return;
      }
    } finally { await handle.close(); }
  } finally { await pin.close(); }
}

async function fingerprint(rootPath, file, probe, limit = maxFileBytes) {
  if (probe.aborted) return;
  await canonicalInside(rootPath, path.relative(rootPath, file));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit) ||
        await realpath('/proc/self/fd/' + handle.fd) !== file) return;
    const size = Number(before.size), bytes = Buffer.alloc(size + 1);
    let count = 0;
    while (count < bytes.length && !probe.aborted) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await lstat(file, { bigint: true });
    if (!probe.aborted && count === size && after.dev === before.dev && after.ino === before.ino &&
        after.nlink === 1n && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs) {
      return { hash: digest(bytes.subarray(0, size)), size };
    }
  } finally { await handle.close(); }
}

// The alternate path starts only after a cut and only when the scoped Native
// filesystem can observe the same project as its present tool. Isolated guest
// projects keep their own authority and do not use host filesystem observations.
export async function captureFileDelivery(ctx, agent, signal) {
  if (process.platform !== 'linux') return;
  const probe = deadline(signal);
  const start = await projectScope(ctx, agent, probe);
  if (!start) return;
  const { rootPath } = start;

  const directories = new Map(), hashes = new Map(), queue = [rootPath];
  let remainingBytes = maxSnapshotBytes, fingerprints = 0;
  for (let index = 0; index < queue.length && !probe.aborted; index++) {
    const directory = queue[index];
    let entries;
    try { entries = await boundedEntries(rootPath, directory, probe); }
    catch { continue; }
    if (!entries) continue;
    directories.set(directory, new Set(entries.map(entry => entry.name)));
    for (const entry of entries) {
      if (probe.aborted) break;
      if (excluded(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && queue.length < maxDirectories) queue.push(file);
      if (!entry.isFile() || !deliverableExtension.test(entry.name) || !remainingBytes || fingerprints >= maxFingerprints) continue;
      fingerprints++;
      try {
        const captured = await fingerprint(rootPath, file, probe, Math.min(remainingBytes, maxFileBytes));
        if (captured) {
          remainingBytes -= captured.size;
          hashes.set(file, captured.hash);
        }
      } catch { /* An unread baseline never proves a change. */ }
    }
  }
  if (signal.aborted || !directories.has(rootPath) || !await sameProject(ctx, start, agent, probe)) return;
  return { ...start, directories, hashes, pending: new Map(), verified: new Map(), credited: new Set() };
}

export function recordFileDelivery(delivery, data) {
  if (!delivery || !Array.isArray(data.files)) return false;
  const versions = delivery.pending.get(data.callId);
  if (!versions) return false;
  delivery.pending.delete(data.callId);
  let confirmed = false;
  for (const item of data.files.slice(0, maxPresentedPaths)) {
    const file = item?.path, proof = versions.get(file);
    if (!proof || delivery.verified.size >= maxPresentedPaths && !delivery.verified.has(file)) continue;
    delivery.verified.set(file, proof);
    if (delivery.credited.size < maxFingerprints && !delivery.credited.has(proof.hash)) {
      delivery.credited.add(proof.hash);
      confirmed = true;
    }
  }
  return confirmed;
}

function knownAbsent(delivery, parts) {
  let directory = delivery.rootPath;
  for (const name of parts) {
    const entries = delivery.directories.get(directory);
    if (!entries) return false;
    if (!entries.has(name)) return true;
    directory = path.join(directory, name);
  }
  return false;
}

async function projectScope(ctx, agent, probe) {
  try {
    const mode = ctx.get('projectExecutionMode');
    if (mode && mode.assertUnchanged().mode !== 'host-compat') return;
    const scope = agent.ctx ?? ctx;
    const fs = scope.get('fs'), workingDirectory = scope.get('workingDirectory');
    if (!fs || !workingDirectory || probe.aborted) return;
    const cwd = await workingDirectory.ensure(agent, probe);
    const root = await fs.resolve(cwd, { cwd, signal: probe });
    const rootPath = fs.processPath(root);
    if (!path.isAbsolute(rootPath) || path.parse(rootPath).root === rootPath || await realpath(rootPath) !== rootPath) return;
    const info = await lstat(rootPath, { bigint: true });
    if (!probe.aborted && info.isDirectory()) {
      return { scope, mode: identity(mode), fs, workingDirectory, cwd, root, rootPath, dev: info.dev, ino: info.ino };
    }
  } catch { /* No local project proof is available. */ }
}

async function sameProject(ctx, delivery, agent, probe) {
  const live = await projectScope(ctx, agent, probe);
  return live && !probe.aborted && live.scope === delivery.scope && live.mode === delivery.mode &&
    identity(live.fs) === identity(delivery.fs) && identity(live.workingDirectory) === identity(delivery.workingDirectory) &&
    live.cwd === delivery.cwd && live.rootPath === delivery.rootPath && live.root.targetKey === delivery.root.targetKey &&
    live.dev === delivery.dev && live.ino === delivery.ino;
}

async function deliveryTarget(delivery, supplied, probe) {
  const { rootPath, fs, root } = delivery;
  const file = path.resolve(rootPath, supplied);
  const relative = relativeFile(path.relative(rootPath, file).split(path.sep).join('/'));
  if (relative.split('/').some(excluded) || !deliverableExtension.test(relative)) return;
  await canonicalInside(rootPath, relative);
  const target = await fs.resolve(file, { cwd: rootPath, signal: probe });
  if (!probe.aborted && fs.processPath(target) === file && fs.contains(root, target)) return { file, target, relative };
}

async function changedVersions(delivery, files, probe) {
  const { fs, rootPath, hashes } = delivery;
  const versions = new Map();
  if (!Array.isArray(files) || files.length === 0 || files.length > maxPresentedPaths) return versions;
  for (const item of files) {
    if (probe.aborted) break;
    const supplied = item?.path;
    if (typeof supplied !== 'string' || !supplied.trim() || supplied.length > 4096) continue;
    try {
      const scoped = await deliveryTarget(delivery, supplied, probe);
      if (!scoped) continue;
      const { file, target, relative } = scoped;
      const current = await fs.stat(target, probe);
      if (current?.type !== 'file' || !current.size || current.size > maxFileBytes || current.version === undefined) continue;
      const absent = knownAbsent(delivery, relative.split('/'));
      if (!absent && !hashes.has(file)) continue;
      const captured = await fingerprint(rootPath, file, probe);
      const after = await fs.stat(target, probe);
      if (!captured || captured.size !== current.size || after?.version !== current.version || captured.hash === hashes.get(file)) continue;
      if (probe.aborted) break;
      versions.set(file, { version: current.version, hash: captured.hash });
    } catch { /* A missing or unverified artifact stays incomplete. */ }
  }
  return versions;
}

async function currentVersions(delivery, versions, probe) {
  const { fs } = delivery;
  const current = new Map();
  for (const [file, proof] of versions) {
    if (probe.aborted) break;
    try {
      const scoped = await deliveryTarget(delivery, file, probe);
      if (!scoped) continue;
      const info = await fs.stat(scoped.target, probe);
      if (!probe.aborted && info?.type === 'file' && info.version === proof.version) current.set(file, proof);
    } catch { /* A previously presented file can be removed before Stop. */ }
  }
  return current;
}

export async function trackFileDelivery(ctx, delivery, turn, exec, next) {
  const probe = deadline(exec.signal);
  let versions;
  try {
    if (await sameProject(ctx, delivery, exec.agent, probe)) versions = await changedVersions(delivery, exec.arguments?.files, probe);
  } catch { /* Proof is optional. Preserve the ordinary tool call. */ }
  const result = await next();
  // Keep the proof around the awaitable tool body. A later tool in the same
  // batch cannot lend its write to this presentation. The final durable event
  // still has to confirm that the SDK accepted the result.
  try {
    if (!versions?.size || result.isError || result.value?.turn !== turn || !Array.isArray(result.value.files) ||
        !await sameProject(ctx, delivery, exec.agent, probe)) return result;
    for (const file of versions.keys()) {
      if (!result.value.files.some(item => item?.path === file)) versions.delete(file);
    }
    const current = await currentVersions(delivery, versions, probe);
    if (current.size && await sameProject(ctx, delivery, exec.agent, probe) && !probe.aborted) delivery.pending.set(exec.callId, current);
  } catch { /* Proof cannot replace a successful or failed Native result. */ }
  return result;
}

export async function verifyFileDelivery(ctx, delivery, agent, signal) {
  if (!delivery?.verified.size || signal.aborted) return false;
  const probe = deadline(signal);
  if (!await sameProject(ctx, delivery, agent, probe)) return false;
  const current = await currentVersions(delivery, delivery.verified, probe);
  return current.size > 0 && await sameProject(ctx, delivery, agent, probe) && !probe.aborted;
}
