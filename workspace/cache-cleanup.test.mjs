import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectLocks } from './storage.mjs';
import { cleanupIdleProjectCaches } from './cache-cleanup.mjs';

async function fixture(t, names = ['owner']) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-cache-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const directory = await fs.realpath(temp), projectsRoot = path.join(directory, 'projects');
  await fs.mkdir(projectsRoot);
  const agents = [], activity = new Map(), acquired = [], released = [];
  const locks = new ProjectLocks(path.join(directory, 'leases'));
  const manager = { projectsRoot, running: new Map(), data: { sessions: {} },
    ctx: { agents: { list: () => agents }, sessions: { get: () => undefined },
      sandboxPolicy: { resolve: ({ session }) => ({ mode: session.mode ?? 'workspace-write' }) },
      waterfall: async (_, { sessionId }) => activity.get(sessionId) ?? [] },
    ownerAgent(agent) { while (agent.owner) agent = agent.owner; return agent; },
    locks: { async acquire(root, owner) { await locks.acquire(root, owner); acquired.push(owner); },
      async release(owner) { await locks.release(owner); released.push(owner); } } };
  for (const id of names) {
    const root = path.join(projectsRoot, id), cache = path.join(root, '.harness/npm/_cacache');
    await fs.mkdir(path.join(cache, 'content-v2'), { recursive: true });
    await fs.writeFile(path.join(cache, 'content-v2/package'), 'download');
    manager.data.sessions[id] = { root };
    agents.push({ id, status: 'idle', session: { id } });
  }
  return { manager, agents, activity, acquired, released, locks, directory,
    root: manager.data.sessions[names[0]].root,
    cache: path.join(manager.data.sessions[names[0]].root, '.harness/npm/_cacache') };
}
const low = { minFreeBytes: 1000, statfs: async () => ({ bavail: 0, bsize: 1 }) };
const exists = file => fs.lstat(file).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });

test('deletes only exact download cache under a live lease; remeasures and stops at reserve', async t => {
  const f = await fixture(t, ['one', 'two']); let free = 0;
  const preserved = ['source.js', 'node_modules/pkg/index.js', '.harness/project.json', '.harness/npm/_logs/log', '.harness/npm/config', '.harness/password', '.harness/node-gyp/header', 'outputs/result'];
  for (const relative of preserved) { const file = path.join(f.root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, relative); }
  const api = { ...fs, async rm(target, options) {
    assert.equal(target, f.cache); assert.ok(path.isAbsolute(target));
    assert.match((await f.locks.records())[0].sessionId, /^@cache-cleanup:/u);
    await fs.rm(target, options); free = 2000;
  } };
  const report = await cleanupIdleProjectCaches(f.manager, { ...low, fs: api, statfs: async () => ({ bavail: free, bsize: 1 }) });
  assert.equal(report.removed.length, 1); assert.equal(report.freeBytesAfter, 2000);
  assert.equal(await exists(f.cache), false);
  assert.equal(await exists(path.join(f.manager.data.sessions.two.root, '.harness/npm/_cacache')), true);
  for (const relative of preserved) assert.equal(await fs.readFile(path.join(f.root, relative), 'utf8'), relative);
  assert.deepEqual(f.released, f.acquired); assert.equal((await f.locks.records()).length, 0);
});

test('sufficient disk reserve does not acquire or delete anything', async t => {
  const f = await fixture(t);
  const report = await cleanupIdleProjectCaches(f.manager, { ...low, statfs: async () => ({ bavail: 1000, bsize: 1 }) });
  assert.deepEqual(report.removed, []); assert.deepEqual(f.acquired, []); assert.equal(await exists(f.cache), true);
});

test('active owner, descendant, running map and background activity all protect cache', async t => {
  for (const kind of ['owner', 'descendant', 'map', 'background']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'owner') f.agents[0].status = 'running';
    if (kind === 'descendant' || kind === 'background') {
      const child = { id: 'child', owner: f.agents[0], status: 'idle', session: {} };
      f.agents.push(child, { id: 'grandchild', owner: child, status: kind === 'descendant' ? 'running' : 'idle', session: {} });
      if (kind === 'background') f.activity.set('grandchild', [{ jobId: 'owned-job' }]);
    }
    if (kind === 'map') f.manager.running.set('unknown-live-owner', f.root);
    const report = await cleanupIdleProjectCaches(f.manager, low);
    assert.equal(report.skipped[0].code, 'PROJECT_ACTIVE'); assert.equal(await exists(f.cache), true);
  });
});

test('read-only descendant cannot trigger cleanup of its owner project', async t => {
  const f = await fixture(t);
  f.agents.push({ id: 'child', owner: f.agents[0], status: 'idle', session: { mode: 'read-only' } });
  const r = await cleanupIdleProjectCaches(f.manager, low);
  assert.equal(r.skipped[0].code, 'READ_ONLY'); assert.equal(await exists(f.cache), true);
});

test('activity starts during lock acquisition: recheck refuses and releases lease', async t => {
  const f = await fixture(t), acquire = f.manager.locks.acquire;
  f.manager.locks.acquire = async (...args) => { await acquire(...args); f.activity.set('owner', [{ jobId: 'new-job' }]); };
  const r = await cleanupIdleProjectCaches(f.manager, low);
  assert.equal(r.skipped[0].code, 'PROJECT_ACTIVE'); assert.equal(await exists(f.cache), true);
  assert.deepEqual(f.released, f.acquired);
});

test('an existing project writer lease is never released or bypassed', async t => {
  const f = await fixture(t); await f.locks.acquire(f.root, 'other-writer');
  const r = await cleanupIdleProjectCaches(f.manager, low);
  assert.equal(r.skipped[0].code, 'PROJECT_WRITER_HELD'); assert.equal(await exists(f.cache), true);
  assert.deepEqual(f.released, []); assert.equal((await f.locks.records())[0].sessionId, 'other-writer');
  await f.locks.release('other-writer');
});

test('links anywhere in cache tree or its parent path fail closed', async t => {
  for (const kind of ['inside', 'npm', 'project']) await t.test(kind, async t => {
    const f = await fixture(t), outside = path.join(f.directory, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'source');
    if (kind === 'inside') await fs.symlink(outside, path.join(f.cache, 'linked'), 'junction');
    if (kind === 'npm') { await fs.rm(path.join(f.root, '.harness/npm'), { recursive: true }); await fs.symlink(outside, path.join(f.root, '.harness/npm'), 'junction'); }
    if (kind === 'project') { const link = path.join(f.manager.projectsRoot, 'alias'); await fs.symlink(f.root, link, 'junction'); f.manager.data.sessions.owner.root = link; }
    const r = await cleanupIdleProjectCaches(f.manager, low);
    assert.equal(r.removed.length, 0); assert.match(r.skipped[0].code, /^UNSAFE_CACHE/u);
    assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'source');
  });
});

test('legacy projects and registry paths outside projectsRoot are protected', async t => {
  const f = await fixture(t, ['legacy', 'outside', 'base']);
  f.manager.data.sessions.legacy.legacy = true;
  f.manager.data.sessions.outside.root = f.directory;
  f.manager.data.sessions.base.root = f.manager.projectsRoot;
  const r = await cleanupIdleProjectCaches(f.manager, low);
  assert.deepEqual(r.skipped.map(x => x.code), ['UNMANAGED_PROJECT', 'UNSAFE_PROJECT_ROOT', 'UNSAFE_PROJECT_ROOT']);
  assert.equal(r.removed.length, 0);
});

test('failed scan releases lock and bounded scan refuses oversized trees', async t => {
  const f = await fixture(t);
  const r = await cleanupIdleProjectCaches(f.manager, { ...low, maxEntries: 1 });
  assert.equal(r.skipped[0].code, 'CACHE_SCAN_LIMIT'); assert.equal(await exists(f.cache), true);
  assert.deepEqual(f.released, f.acquired);
});

test('registered source roots inside a cache are never removed', async t => {
  const f = await fixture(t), source = path.join(f.cache, 'nested-project');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'app.js'), 'source');
  f.manager.data.sessions.nested = { root: source };
  const r = await cleanupIdleProjectCaches(f.manager, low);
  assert.equal(r.skipped[0].code, 'CACHE_CONTAINS_PROJECT');
  assert.equal(await fs.readFile(path.join(source, 'app.js'), 'utf8'), 'source');
  assert.deepEqual(f.released, f.acquired);
});

test('running-map transition during the last activity await is rechecked', async t => {
  const f = await fixture(t); let queries = 0;
  f.manager.ctx.waterfall = async () => {
    if (++queries === 2) f.manager.running.set('new-owner', f.root);
    return [];
  };
  const r = await cleanupIdleProjectCaches(f.manager, low);
  assert.equal(r.skipped[0].code, 'PROJECT_ACTIVE'); assert.equal(await exists(f.cache), true);
  assert.deepEqual(f.released, f.acquired);
});

test('cannot measure disk: never delete; failed post-removal measurement stops pass', async t => {
  const f = await fixture(t, ['one', 'two']); let calls = 0;
  const unavailable = await cleanupIdleProjectCaches(f.manager, { ...low, statfs: async () => { throw Error('denied'); } });
  assert.equal(unavailable.status, 'unavailable'); assert.equal(await exists(f.cache), true);
  const r = await cleanupIdleProjectCaches(f.manager, { ...low, statfs: async () => { if (++calls === 3) throw Error('denied'); return { bavail: 0, bsize: 1 }; } });
  assert.equal(r.removed.length, 1); assert.equal(r.skipped[0].code, 'DISK_SPACE_UNAVAILABLE');
  assert.equal(await exists(path.join(f.manager.data.sessions.two.root, '.harness/npm/_cacache')), true);
  assert.deepEqual(f.released, f.acquired);
});
