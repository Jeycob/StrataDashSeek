import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIndependentProject, projectGit } from './project-repository.mjs';
import { WorkspaceManager } from './manager.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-project-repository-')), sourceRoot = path.join(directory, 'source'), projectsRoot = path.join(directory, 'projects');
  t.after(async () => { const real = await fs.realpath(directory); assert.equal(path.dirname(real), await fs.realpath(os.tmpdir())); assert(path.basename(real).startsWith('homeai-project-repository-')); await fs.rm(real, { recursive: true, force: true }); });
  await fs.mkdir(sourceRoot); await fs.mkdir(projectsRoot);
  const create = args => createIndependentProject({ projectsRoot, sourceRoot, sessionId: 'one', minimumFreeBytes: 0, ...args });
  const git = (args, opts) => projectGit(sourceRoot, args, opts);
  await git(['init', '--initial-branch=main', '--template=', '.']);
  await git(['config', 'user.name', 'Synthetic']); await git(['config', 'user.email', 'test@example.invalid']);
  return { directory, sourceRoot, projectsRoot, create, git };
}
test('fresh project has its own committed Git baseline, ignored runtime and functional diff', async t => {
  const f = await fixture(t), p = await f.create({ mode: 'fresh' });
  assert.equal(p.independentRepository, true); assert.equal(p.nativeWorktree, false); assert.match(p.baseCommit, /^[a-f0-9]{40}$/);
  await fs.mkdir(path.join(p.root, '.harness')); await fs.writeFile(path.join(p.root, '.harness/private'), 'synthetic');
  await fs.writeFile(path.join(p.root, 'app.js'), 'first\n');
  assert.equal((await projectGit(p.root, ['status', '--porcelain'])).trim(), '?? app.js');
  await projectGit(p.root, ['add', 'app.js']); await projectGit(p.root, ['-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'first']);
  await fs.writeFile(path.join(p.root, 'app.js'), 'second\n'); assert.match(await projectGit(p.root, ['diff']), /-first\r?\n\+second/);
});
test('committed source transfers exact shallow snapshot with independent objects and leaves dirty source untouched', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.sourceRoot, 'app.js'), 'historical\n'); await f.git(['add', '.']); await f.git(['commit', '-m', 'old']);
  await fs.writeFile(path.join(f.sourceRoot, 'app.js'), 'committed\n'); await f.git(['add', '.']); await f.git(['commit', '-m', 'base']);
  const base = (await f.git(['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(f.sourceRoot, 'app.js'), 'dirty source\n'); await fs.writeFile(path.join(f.sourceRoot, 'untracked-private'), 'must not copy');
  const before = await f.git(['status', '--porcelain']);
  const p = await f.create(); assert.equal(p.baseCommit, base); assert.equal(await fs.readFile(path.join(p.root, 'app.js'), 'utf8'), 'committed\n');
  assert.equal((await projectGit(p.root, ['rev-list', '--count', 'HEAD'])).trim(), '1');
  assert.equal((await projectGit(p.root, ['remote'])).trim(), '');
  await assert.rejects(fs.stat(path.join(p.root, 'untracked-private')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(p.root, '.git/objects/info/alternates')), { code: 'ENOENT' });
  for (const name of await fs.readdir(path.join(p.root, '.git/objects/pack'))) assert.equal((await fs.stat(path.join(p.root, '.git/objects/pack', name))).nlink, 1);
  assert.equal(await f.git(['status', '--porcelain']), before); assert.equal(await fs.readFile(path.join(f.sourceRoot, 'app.js'), 'utf8'), 'dirty source\n');
  await fs.rename(f.sourceRoot, path.join(f.directory, 'source-unavailable'));
  assert.equal((await projectGit(p.root, ['show', 'HEAD:app.js'])).trim(), 'committed');
  await projectGit(p.root, ['fsck', '--full']);
});
test('source hooks, filters, aliases, helpers and inherited Git configuration are never imported or run', async t => {
  const f = await fixture(t), marker = path.join(f.directory, 'hook-ran').replaceAll('\\', '/');
  await fs.writeFile(path.join(f.sourceRoot, 'app.js'), 'committed'); await fs.writeFile(path.join(f.sourceRoot, '.gitattributes'), '*.js filter=hostile\n');
  await f.git(['add', '.']); await f.git(['commit', '-m', 'base']);
  await f.git(['config', 'filter.hostile.smudge', 'touch "' + marker + '"']); await f.git(['config', 'core.fsmonitor', 'touch "' + marker + '"']);
  const hooks = path.join(f.sourceRoot, '.git/hooks'); await fs.mkdir(hooks); await fs.writeFile(path.join(hooks, 'post-checkout'), '#!/bin/sh\ntouch "' + marker + '"\n', { mode: 0o755 });
  const original = process.env.GIT_CONFIG_COUNT; process.env.GIT_CONFIG_COUNT = '9000';
  let p; try { p = await f.create(); } finally { if (original === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = original; }
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(p.root, 'app.js'), 'utf8'), 'committed');
  assert.doesNotMatch(await fs.readFile(path.join(p.root, '.git/config'), 'utf8'), /hostile|fsmonitor|credential|remote|source/);
  await assert.rejects(fs.stat(path.join(p.root, '.git/hooks/post-checkout')), { code: 'ENOENT' });
});
test('allocation refuses existing targets, missing commits, private path conflicts and insufficient capacity without deleting caller data', async t => {
  const f = await fixture(t);
  await assert.rejects(f.create({ mode: 'worktree' }), { code: 'COMMIT_REQUIRED' });
  await fs.writeFile(path.join(f.sourceRoot, 'app.js'), 'payload'); await f.git(['add', '.']); await f.git(['commit', '-m', 'base']);
  await assert.rejects(f.create({ maxBytes: 1 }), { code: 'PROJECT_COPY_LIMIT' });
  await assert.rejects(f.create({ minimumFreeBytes: Number.MAX_SAFE_INTEGER }), { code: 'PROJECT_DISK_RESERVE' });
  assert.deepEqual(await fs.readdir(f.projectsRoot), []);
  await fs.mkdir(path.join(f.projectsRoot, 'one')); await fs.writeFile(path.join(f.projectsRoot, 'one/preserve'), 'owned');
  await assert.rejects(f.create(), { code: 'EEXIST' }); assert.equal(await fs.readFile(path.join(f.projectsRoot, 'one/preserve'), 'utf8'), 'owned');
  await fs.mkdir(path.join(f.sourceRoot, '.harness')); await fs.writeFile(path.join(f.sourceRoot, '.harness/injected'), 'refuse'); await f.git(['add', '.']); await f.git(['commit', '-m', 'private']);
  await assert.rejects(f.create({ sessionId: 'two' }), { code: 'PROJECT_PRIVATE_PATH_CONFLICT' });
  await assert.rejects(f.create({ sessionId: '../escape' }), { code: 'PROJECT_REPOSITORY_CONFIG' });
});
test('manager enrolls fresh independent projects, retains existing shared records and preserves explicit continue mode', async t => {
  const f = await fixture(t), grants = [], directories = new Map();
  const ctx = { agents: { list: () => [] }, workspaceRegistry: { list: () => [] }, workingDirectory: { get: session => directories.get(session.id) ?? f.sourceRoot, set: async (agent, root) => directories.set(agent.id, root) }, sandboxPolicy: { registerWritableRoot: (session, root) => { grants.push({ id: session.id, root }); return { dispose() {} }; } }, worktrees: { create: () => { throw Error('SHARED_WORKTREE_MUST_NOT_RUN'); } }, logger: { warn: message => { throw Error(message); } } };
  const manager = new WorkspaceManager(ctx, { stateRoot: path.join(f.directory, 'state'), projectsRoot: f.projectsRoot });
  await manager.initialize(); manager.data.installedAt = 0; manager.settings = () => ({ projectMode: 'fresh', maxStageSteps: 60 }); t.after(() => manager.changes.dispose());
  const agent = { id: 'managed', session: { id: 'managed', header: { cwd: f.sourceRoot, createdAt: Date.now(), origin: 'user' } } };
  const record = await manager.ensureProject(agent); assert.equal(record.independentRepository, true); assert.equal(record.nativeWorktree, false); assert.equal(record.gitWritableRoots, undefined);
  assert.equal((await fs.lstat(path.join(record.root, '.git'))).isDirectory(), true);
  assert.equal((await projectGit(record.root, ['status', '--porcelain'])).trim(), ''); assert.equal(grants.length, 1);
  const marker = JSON.parse(await fs.readFile(path.join(record.root, '.harness/project.json'), 'utf8')); assert.equal(marker.sessionId, agent.id);
  assert.equal(await manager.ensureProject(agent), record); assert.equal(grants.length, 1);
  manager.data.sessions.old = { root: f.sourceRoot, nativeWorktree: true, gitWritableRoots: ['retained-original'] };
  const old = { id: 'old', session: { id: 'old', header: { ...agent.session.header } } }; assert.equal((await manager.ensureProject(old)).nativeWorktree, true);
  manager.settings = () => ({ projectMode: 'continue', maxStageSteps: 60 });
  const continued = { id: 'continued', session: { id: 'continued', header: { ...agent.session.header } } };
  const previous = await manager.ensureProject(continued); assert.equal(previous.root, await fs.realpath(f.sourceRoot)); assert.equal(previous.independentRepository, false);
});

test('manager captures the private baseline before any publication and never retries failed capture against an exposed project', async t => {
  const f = await fixture(t), directories = new Map(), grants = [], captured = new Set(), warnings = [];
  const ctx = { agents: { list: () => [] }, workspaceRegistry: { list: () => [] }, workingDirectory: {
    get: session => directories.get(session.id) ?? f.sourceRoot,
    set: async (agent, root) => { assert(captured.has(agent.id)); directories.set(agent.id, root); }
  }, sandboxPolicy: { registerWritableRoot: (session, root) => { assert(captured.has(session.id)); grants.push({ id: session.id, root }); return { dispose() {} }; } }, logger: { warn: message => warnings.push(message) } };
  const manager = new WorkspaceManager(ctx, { stateRoot: path.join(f.directory, 'state'), projectsRoot: f.projectsRoot, changes: { minimumFreeBytes: 0 } });
  await manager.initialize(); manager.data.installedAt = 0; manager.settings = () => ({ projectMode: 'fresh', maxStageSteps: 60 }); t.after(() => manager.changes.dispose());
  const initialize = manager.changes.initialize.bind(manager.changes), git = manager.changes.git.bind(manager.changes); let failedGitCalls = 0;
  t.mock.method(manager.changes, 'initialize', async (id, record, options) => {
    if (options?.projectCreated) {
      assert.equal(manager.data.sessions[id], undefined); assert.equal(directories.has(id), false); assert.equal(grants.some(g => g.id === id), false);
      assert.equal(JSON.parse(await fs.readFile(manager.file, 'utf8')).sessions[id], undefined);
      try { return await initialize(id, record, options); } finally { captured.add(id); }
    }
    return initialize(id, record, options);
  });
  t.mock.method(manager.changes, 'git', async (root, ...args) => {
    if (path.basename(root) === 'failed') { failedGitCalls++; throw Object.assign(Error('synthetic capture failure'), { code: 'DIFF_BASELINE_UNAVAILABLE' }); }
    return git(root, ...args);
  });
  for (const id of ['successful', 'failed']) {
    const agent = { id, session: { id, header: { cwd: f.sourceRoot, createdAt: Date.now(), origin: 'user' } } };
    const record = await manager.ensureProject(agent); assert.equal(record.independentRepository, true); assert.equal(directories.get(id), record.root);
    if (id === 'successful') assert.equal((await manager.changes.list(id, record)).baseline.storage, 'private-objects-v1');
    else {
      assert.equal(failedGitCalls, 1); await assert.rejects(manager.changes.list(id, record), { code: 'DIFF_BASELINE_UNAVAILABLE' }); assert.equal(failedGitCalls, 1);
      assert.equal(await manager.ensureProject(agent), record); assert.equal(failedGitCalls, 1);
    }
  }
  assert.equal(warnings.length, 1); assert.match(warnings[0], /DIFF_BASELINE_UNAVAILABLE/);
});
