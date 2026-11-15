import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const refuse = code => { throw Object.assign(new Error(code), { code }); };

// Check ancestors too: resolving a link and then checking containment alone
// would accept symlinked projects, npm directories or even projectsRoot itself.
async function directoryWithoutLinks(fs, absolute) {
  if (!path.isAbsolute(absolute)) refuse('UNSAFE_CACHE_PATH');
  const parsed = path.parse(absolute); let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) refuse('UNSAFE_CACHE_PATH');
  }
  const canonical = await fs.realpath(absolute);
  if (path.relative(canonical, absolute) !== '') refuse('UNSAFE_CACHE_PATH');
  return canonical;
}

async function inspectCache(fs, target, maxEntries) {
  let entries = 0; const pending = [target];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of await fs.readdir(directory)) {
      if (++entries > maxEntries) refuse('CACHE_SCAN_LIMIT');
      const file = path.join(directory, name);
      if (!inside(target, file)) refuse('UNSAFE_CACHE_PATH');
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) refuse('UNSAFE_CACHE_ENTRY');
      if (stat.isDirectory()) pending.push(file);
    }
  }
}

async function idle(manager, root, sessionId, fs) {
  const relevantIds = new Set([sessionId]);
  for (const [id, record] of Object.entries(manager.data.sessions)) {
    if (typeof record.root !== 'string' || !path.isAbsolute(record.root)) continue;
    if (overlaps(root, path.resolve(record.root))) relevantIds.add(id);
    else {
      try { if (overlaps(root, await fs.realpath(record.root))) relevantIds.add(id); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const agents = manager.ctx.agents.list();
  for (const agent of agents) {
    const owner = manager.ownerAgent(agent);
    if (!owner?.id) refuse('UNKNOWN_PROJECT_ACTIVITY');
    if (relevantIds.has(owner.id)) relevantIds.add(agent.id);
  }
  for (const [id, heldRoot] of manager.running) {
    if (relevantIds.has(id) || typeof heldRoot === 'string' && overlaps(root, path.resolve(heldRoot))) refuse('PROJECT_ACTIVE');
  }
  for (const id of relevantIds) {
    const agent = agents.find(value => value.id === id);
    if (agent?.status === 'running') refuse('PROJECT_ACTIVE');
    const session = agent?.session ?? manager.ctx.sessions?.get(id);
    if (session && manager.ctx.sandboxPolicy.resolve({ session }).mode === 'read-only') refuse('READ_ONLY');
    const activity = await manager.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
    if (!Array.isArray(activity)) refuse('UNKNOWN_PROJECT_ACTIVITY');
    if (activity.length) refuse('PROJECT_ACTIVE');
  }
  // No awaits after this final running/policy check: deletion follows in the
  // same turn while the project writer lease prevents new managed writers.
  for (const agent of manager.ctx.agents.list()) {
    const owner = manager.ownerAgent(agent);
    if (relevantIds.has(agent.id) || relevantIds.has(owner?.id)) {
      if (agent.status === 'running') refuse('PROJECT_ACTIVE');
      if (manager.ctx.sandboxPolicy.resolve({ session: agent.session }).mode === 'read-only') refuse('READ_ONLY');
    }
  }
  for (const [id, heldRoot] of manager.running) {
    if (relevantIds.has(id) || typeof heldRoot === 'string' && overlaps(root, path.resolve(heldRoot))) refuse('PROJECT_ACTIVE');
  }
}

/** One bounded, best-effort pass over registered managed projects only.
 * Call as a host maintenance action, not as a model-supplied filesystem tool.
 * All project writers/background jobs must participate in ProjectLocks and
 * workspace/session-activity; this does not defend against an external OS writer.
 */
export async function cleanupIdleProjectCaches(manager, {
  minFreeBytes = 2.5 * 1024 ** 3, fs = nodeFs, statfs = fs.statfs.bind(fs), maxEntries = 100000,
} = {}) {
  if (!Number.isFinite(minFreeBytes) || minFreeBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('Invalid cache cleanup limits');
  const report = { status: 'completed', freeBytesBefore: null, freeBytesAfter: null, removed: [], skipped: [] };
  let projectsRoot;
  const available = async () => {
    try {
      const stat = await statfs(projectsRoot), bytes = Number(stat.bavail) * Number(stat.bsize);
      if (!Number.isFinite(bytes) || bytes < 0) refuse('DISK_SPACE_UNAVAILABLE');
      return bytes;
    } catch { refuse('DISK_SPACE_UNAVAILABLE'); }
  };
  try {
    projectsRoot = await directoryWithoutLinks(fs, manager.projectsRoot);
    report.freeBytesBefore = report.freeBytesAfter = await available();
  } catch (error) { report.status = 'unavailable'; report.error = error.code ?? 'CACHE_CLEANUP_UNAVAILABLE'; return report; }
  if (report.freeBytesAfter >= minFreeBytes) return report;
  const seen = new Set();
  // Snapshot registry membership once; newly created projects wait for next pass.
  for (const [sessionId, record] of Object.entries(manager.data.sessions)) {
    let locked = false; const owner = '@cache-cleanup:' + randomUUID();
    try {
      if (record.legacy || typeof record.root !== 'string' || !path.isAbsolute(record.root)) refuse('UNMANAGED_PROJECT');
      const root = path.resolve(record.root);
      if (!inside(projectsRoot, root) || path.relative(projectsRoot, root) === '') refuse('UNSAFE_PROJECT_ROOT');
      await directoryWithoutLinks(fs, root);
      if (seen.has(root)) continue;
      seen.add(root);
      await idle(manager, root, sessionId, fs);
      await manager.locks.acquire(root, owner); locked = true;
      const target = path.join(root, '.harness', 'npm', '_cacache');
      // The only removable path is this exact fixed suffix under a verified root.
      if (!inside(root, target) || !inside(projectsRoot, target)) refuse('UNSAFE_CACHE_PATH');
      for (const other of Object.values(manager.data.sessions)) {
        if (typeof other.root !== 'string' || !path.isAbsolute(other.root)) continue;
        if (inside(target, path.resolve(other.root))) refuse('CACHE_CONTAINS_PROJECT');
        try { if (inside(target, await fs.realpath(other.root))) refuse('CACHE_CONTAINS_PROJECT'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await directoryWithoutLinks(fs, target);
      const identity = await fs.lstat(target);
      await inspectCache(fs, target, maxEntries);
      if (manager.data.sessions[sessionId] !== record || path.resolve(record.root) !== root) refuse('PROJECT_CHANGED');
      await directoryWithoutLinks(fs, target);
      const current = await fs.lstat(target);
      if (identity.dev !== current.dev || identity.ino !== current.ino) refuse('CACHE_CHANGED');
      report.freeBytesAfter = await available();
      if (report.freeBytesAfter >= minFreeBytes) break;
      await idle(manager, root, sessionId, fs);
      await fs.rm(target, { recursive: true, force: false });
      report.removed.push({ sessionId });
      report.freeBytesAfter = await available();
      if (report.freeBytesAfter >= minFreeBytes) break;
    } catch (error) {
      report.skipped.push({ sessionId, code: error.code ?? 'CACHE_CLEANUP_REFUSED' });
      // Once capacity cannot be measured, do not remove further caches.
      if (error.code === 'DISK_SPACE_UNAVAILABLE') break;
    } finally {
      if (locked) await manager.locks.release(owner);
    }
  }
  return report;
}
