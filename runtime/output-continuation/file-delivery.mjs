import { createHash } from 'node:crypto';
import path from 'node:path';

const maxDirectoryEntries = 512;
const maxDirectories = 32;
const maxFingerprints = 128;
const maxFileBytes = 256 * 1024;
const maxSnapshotBytes = 4 * 1024 * 1024;
const maxPresentedPaths = 16;
const excluded = new Set(['.git', 'node_modules']);

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const deadline = signal => AbortSignal.any([signal, AbortSignal.timeout(1500)]);

// The alternate path starts only after a cut and only when the scoped Native
// filesystem can observe the same project as its present tool. Isolated guest
// projects keep their own authority and do not use host filesystem observations.
export async function captureFileDelivery(ctx, agent, signal) {
  if (ctx.get('projectExecutionMode')?.snapshot?.mode === 'isolated-guest') return;
  const scope = agent.ctx ?? ctx;
  const fs = scope.get('fs'), workingDirectory = scope.get('workingDirectory');
  if (!fs || !workingDirectory) return;
  const probe = deadline(signal);
  let root, rootPath;
  try {
    const cwd = await workingDirectory.ensure(agent, probe);
    root = await fs.resolve(cwd, { cwd, signal: probe });
    rootPath = fs.processPath(root);
    if (!path.isAbsolute(rootPath) || path.parse(rootPath).root === rootPath) return;
  } catch { return; }

  const directories = new Map(), hashes = new Map(), queue = [root];
  let remainingBytes = maxSnapshotBytes, fingerprints = 0;
  for (let index = 0; index < queue.length && !probe.aborted; index++) {
    const directory = queue[index];
    let entries;
    try { entries = await fs.listDir(directory, probe); }
    catch { continue; }
    if (entries.length > maxDirectoryEntries) continue;
    const directoryPath = fs.processPath(directory);
    directories.set(directoryPath, new Set(entries.map(entry => entry.name)));
    for (const entry of entries) {
      if (probe.aborted) break;
      if (excluded.has(entry.name) || fs.processPath(entry.target) !== path.join(directoryPath, entry.name)) continue;
      if (entry.type === 'directory' && queue.length < maxDirectories) queue.push(entry.target);
      if (entry.type !== 'file' || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
          entry.size > maxFileBytes || entry.size > remainingBytes || fingerprints >= maxFingerprints) continue;
      fingerprints++;
      remainingBytes -= entry.size;
      try {
        const bytes = await fs.readBytes(entry.target, probe, entry.size);
        const current = await fs.stat(entry.target, probe);
        if (current?.version === entry.version && bytes.length === entry.size) hashes.set(fs.processPath(entry.target), digest(bytes));
      } catch { /* An unread baseline never proves a change. */ }
    }
  }
  if (signal.aborted || !directories.has(rootPath)) return;
  return { fs, root, rootPath, directories, hashes, presented: new Set(), verified: new Map() };
}

export function recordFileDelivery(delivery, data) {
  if (!delivery || typeof data.callId !== 'string' || !data.callId || !Array.isArray(data.files)) return;
  for (const item of data.files.slice(0, maxPresentedPaths)) {
    const file = item?.path;
    if (delivery.presented.size >= maxPresentedPaths) break;
    if (typeof file === 'string' && file.length <= 4096 && path.isAbsolute(file)) delivery.presented.add(file);
  }
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

export async function observeFileDelivery(delivery, signal) {
  if (!delivery?.presented.size || signal.aborted) return false;
  const { fs, root, rootPath, hashes, presented, verified } = delivery;
  const files = [...presented];
  presented.clear();
  let confirmed = false;
  const probe = deadline(signal);
  for (const file of files) {
    if (probe.aborted || verified.size >= maxPresentedPaths) break;
    try {
      const target = await fs.resolve(file, { cwd: rootPath, signal: probe });
      if (fs.processPath(target) !== file || !fs.contains(root, target)) continue;
      const parts = path.relative(rootPath, file).split(path.sep);
      if (parts.some(part => !part || excluded.has(part))) continue;
      const current = await fs.stat(target, probe);
      if (current?.type !== 'file' || !current.size || current.version === undefined) continue;
      if (!knownAbsent(delivery, parts)) {
        if (!hashes.has(file) || current.size > maxFileBytes) continue;
        const bytes = await fs.readBytes(target, probe, current.size);
        const after = await fs.stat(target, probe);
        if (after?.version !== current.version || bytes.length !== current.size || digest(bytes) === hashes.get(file)) continue;
      }
      if (probe.aborted) break;
      verified.set(file, current.version);
      confirmed = true;
    } catch { /* A missing or unverified artifact stays incomplete. */ }
  }
  return confirmed && !signal.aborted;
}

export async function verifyFileDelivery(delivery, signal) {
  if (!delivery?.verified.size || signal.aborted) return false;
  const { fs, root, rootPath, verified } = delivery;
  const probe = deadline(signal);
  for (const [file, version] of verified) {
    if (probe.aborted) return false;
    try {
      const target = await fs.resolve(file, { cwd: rootPath, signal: probe });
      if (fs.processPath(target) !== file || !fs.contains(root, target)) continue;
      const current = await fs.stat(target, probe);
      if (!probe.aborted && current?.type === 'file' && current.version === version) return true;
    } catch { /* A previously presented file can be removed before Stop. */ }
  }
  return false;
}
