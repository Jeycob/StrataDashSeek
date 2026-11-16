import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LiveChanges } from './changes.mjs';
import { projectGit } from './project-repository.mjs';

const execute = promisify(execFile);
const runtimeRoot = process.env.HOMEAI_RUNTIME ?? (process.env.HARNESS_NATIVE_CLI
  ? path.resolve(path.dirname(process.env.HARNESS_NATIVE_CLI), '../../../..') : '/data/harness/runtime');

async function fixture(t, options = {}, mode = 'fresh') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'live-changes-'));
  const root = path.join(directory, 'project'), sourceRoot = path.join(directory, 'source');
  const stateRoot = path.join(directory, 'state');
  await fs.mkdir(root); await fs.mkdir(sourceRoot);
  const instances = [];
  const config = { stateRoot, runtimeRoot, minimumFreeBytes: 0, scanIntervalMs: 0, ...options };
  const open = () => { const value = new LiveChanges(config); instances.push(value); return value; };
  const tracker = open();
  const project = { root, sourceRoot, settings: { projectMode: mode } };
  const write = async (name, content) => {
    const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  };
  t.after(async () => {
    for (const value of instances) await value.dispose();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'live-changes-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, sourceRoot, stateRoot, project, tracker, write, open };
}

const filesByPath = result => new Map(result.files.map(file => [file.path, file]));
const lines = diff => diff.hunks.flatMap(hunk => hunk.lines);

test('fresh projects include files created outside file tools and expose real added hunks', async t => {
  const f = await fixture(t);
  await f.tracker.initialize('one', f.project, { projectCreated: true });
  // Direct disk mutation represents shell-generated output: no fs-intent event is delivered.
  await f.write('src/hello.js', 'export const value = 1;\n');
  const result = await f.tracker.list('one', f.project, { running: true });
  assert.equal(result.version, 1); assert.equal(result.root, f.root);
  assert.equal(result.baseline.kind, 'empty'); assert.equal(result.running, true);
  assert.equal(filesByPath(result).get('src/hello.js')?.status, 'added');
  const diff = await f.tracker.diff('one', f.project, { path: 'src/hello.js' });
  assert.equal(diff.kind, 'text'); assert.ok(lines(diff).includes('+export const value = 1;'));
});

test('continue snapshots distinguish modified, deleted and added paths against the original baseline', async t => {
  const f = await fixture(t, {}, 'continue');
  await f.write('modify.txt', 'old\n'); await f.write('delete.txt', 'gone\n'); await f.write('same.txt', 'same\n');
  await f.tracker.initialize('one', f.project);
  const before = await f.tracker.list('one', f.project);
  assert.equal(before.baseline.kind, 'snapshot'); assert.equal(before.baseline.label, 'tracking-start');
  assert.equal(before.total, 0);
  await f.write('modify.txt', 'new\n'); await fs.unlink(path.join(f.root, 'delete.txt')); await f.write('add.txt', 'created\n');
  const result = await f.tracker.list('one', f.project), byPath = filesByPath(result);
  assert.equal(result.total, 3); assert.equal(byPath.get('modify.txt')?.status, 'modified');
  assert.equal(byPath.get('delete.txt')?.status, 'deleted'); assert.equal(byPath.get('add.txt')?.status, 'added');
  assert.equal(byPath.has('same.txt'), false);
  const diff = await f.tracker.diff('one', f.project, { path: 'modify.txt' });
  assert.ok(lines(diff).includes('-old')); assert.ok(lines(diff).includes('+new'));
  const deleted = await f.tracker.diff('one', f.project, { path: 'delete.txt' });
  assert.equal(deleted.kind, 'text'); assert.ok(lines(deleted).includes('-gone'));
});

test('snapshot baseline survives restart and repeated initialize never adopts edited content', async t => {
  const f = await fixture(t, {}, 'continue');
  await f.write('stable.txt', 'original\n'); await f.tracker.initialize('one', f.project);
  await f.write('stable.txt', 'first change\n'); await f.tracker.initialize('one', f.project);
  await f.tracker.dispose();
  const reopened = f.open(); await reopened.initialize('one', f.project);
  await f.write('stable.txt', 'second change\n');
  const diff = await reopened.diff('one', f.project, { path: 'stable.txt' });
  assert.ok(lines(diff).includes('-original')); assert.ok(lines(diff).includes('+second change'));
  assert.equal(lines(diff).includes('-first change'), false);
});

test('unreadable source files preserve other changes without inventing deletions', async t => {
  const f = await fixture(t, {}, 'continue');
  await f.write('blocked.txt', 'original private content\n'); await f.write('readable.txt', 'old\n');
  await f.tracker.initialize('one', f.project);
  await f.write('readable.txt', 'changed\n');
  const open = fs.open.bind(fs);
  for (const code of ['EACCES', 'EPERM']) {
    const mock = t.mock.method(fs, 'open', async (file, ...args) => {
      if (file === path.join(f.root, 'blocked.txt')) throw Object.assign(new Error('permission denied'), { code });
      return open(file, ...args);
    });
    const result = await f.tracker.list('one', f.project);
    assert.equal(result.partial, true); assert.ok(result.warnings.includes('CHANGING_OR_EXCLUDED_FILES'));
    assert.equal(filesByPath(result).has('blocked.txt'), false);
    assert.equal(filesByPath(result).get('readable.txt')?.status, 'modified');
    const diff = await f.tracker.diff('one', f.project, { path: 'readable.txt' });
    assert.ok(lines(diff).includes('+changed'));
    mock.mock.restore();
  }
  await f.write('blocked.txt', 'now readable\n');
  assert.equal(filesByPath(await f.tracker.list('one', f.project)).get('blocked.txt')?.status, 'modified');
});

test('an unreadable initial path stays unknown after snapshot creation', async t => {
  const f = await fixture(t, {}, 'continue');
  await f.write('blocked.txt', 'unrecorded initial text\n'); await f.write('readable.txt', 'old\n');
  const open = fs.open.bind(fs), mock = t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === path.join(f.root, 'blocked.txt')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return open(file, ...args);
  });
  await f.tracker.initialize('one', f.project); mock.mock.restore();
  await f.write('readable.txt', 'changed\n');
  const result = await f.tracker.list('one', f.project);
  assert.equal(result.partial, true); assert.equal(filesByPath(result).has('blocked.txt'), false);
  assert.equal(filesByPath(result).get('readable.txt')?.status, 'modified');
  await assert.rejects(f.tracker.diff('one', f.project, { path: 'blocked.txt' }), { code: 'DIFF_FILE_NOT_CHANGED' });
});

test('permission-denied directories do not fail the complete changes request', async t => {
  const f = await fixture(t); await f.tracker.initialize('one', f.project);
  await f.write('blocked/file.txt', 'hidden\n'); await f.write('readable.txt', 'visible\n');
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (directory, ...args) => {
    if (directory === path.join(f.root, 'blocked')) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    return readdir(directory, ...args);
  });
  const result = await f.tracker.list('one', f.project);
  assert.equal(result.partial, true); assert.equal(filesByPath(result).has('blocked/file.txt'), false);
  assert.equal(filesByPath(result).get('readable.txt')?.status, 'added');
});

test('existing project using its source directory never claims a historical empty baseline', async t => {
  const f = await fixture(t); f.project.sourceRoot = f.root;
  await f.write('existing.txt', 'already there\n'); await f.tracker.initialize('one', f.project);
  const result = await f.tracker.list('one', f.project);
  assert.equal(result.baseline.kind, 'snapshot'); assert.equal(result.baseline.label, 'tracking-start');
  assert.equal(result.total, 0);
});

test('git base compares privately retained committed content and includes untracked files without changing the repository', async t => {
  const f = await fixture(t);
  const hooks = path.join(f.directory, 'empty-hooks'); await fs.mkdir(hooks);
  const git = async (...args) => (await execute('git', ['-c', 'core.hooksPath=' + hooks,
    '-c', 'user.name=Live Changes Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd: f.root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
  await git('init', '--quiet'); await f.write('tracked.txt', 'committed\n'); await git('add', '--', 'tracked.txt');
  await git('commit', '--quiet', '-m', 'fixture baseline');
  f.project.baseCommit = (await git('rev-parse', 'HEAD')).trim(); f.project.independentRepository = true;
  await f.tracker.initialize('one', f.project, { projectCreated: true });
  assert.equal((await f.tracker.list('one', f.project)).total, 0);
  await f.write('tracked.txt', 'working change\n'); await f.write('untracked.txt', 'new file\n');
  const statusBefore = await git('status', '--porcelain=v1');
  const result = await f.tracker.list('one', f.project);
  assert.equal(result.baseline.kind, 'git-base'); assert.equal(result.baseline.commit, f.project.baseCommit);
  assert.equal(filesByPath(result).get('tracked.txt')?.status, 'modified');
  assert.equal(filesByPath(result).get('untracked.txt')?.status, 'added');
  const diff = await f.tracker.diff('one', f.project, { path: 'tracked.txt' });
  assert.ok(lines(diff).includes('-committed')); assert.ok(lines(diff).includes('+working change'));
  assert.equal(await git('status', '--porcelain=v1'), statusBefore);
});

async function gitFixture(t, options = {}, format = 'sha1') {
  const f = await fixture(t, options), git = args => projectGit(f.root, args);
  await git(['init', '--initial-branch=main', '--template=', '--object-format=' + format, '.']);
  await f.write('tracked.txt', 'committed\n'); await git(['add', '.']);
  await git(['-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline']);
  f.project.baseCommit = (await git(['rev-parse', 'HEAD'])).trim(); f.project.independentRepository = true;
  return { ...f, git, capture: () => f.tracker.initialize('one', f.project, { projectCreated: true }) };
}

test('published Git replacement refs, alternates and hostile config never participate in later diffs or restart', async t => {
  const f = await gitFixture(t); await f.capture();
  const original = (await f.git(['rev-parse', 'HEAD:tracked.txt'])).trim();
  await f.write('tracked.txt', 'forged replacement\n'); const replacement = (await f.git(['hash-object', '-w', 'tracked.txt'])).trim();
  await f.git(['replace', original, replacement]);
  await fs.mkdir(path.join(f.root, '.git/objects/info'), { recursive: true });
  await fs.writeFile(path.join(f.root, '.git/objects/info/alternates'), f.sourceRoot.replaceAll('\\', '/') + '\n');
  const marker = path.join(f.directory, 'host-hook-ran').replaceAll('\\', '/');
  for (const [key, value] of [['core.fsmonitor', 'touch "' + marker + '"'], ['filter.hostile.smudge', 'touch "' + marker + '"'], ['diff.hostile.textconv', 'touch "' + marker + '"'], ['remote.origin.promisor', 'true'], ['remote.origin.url', 'ext::sh -c touch% ' + marker]]) await f.git(['config', key, value]);
  await f.write('.gitattributes', '*.txt filter=hostile diff=hostile\n');
  // Deleting the original object makes any accidental Git read fail even if
  // replacement objects were ignored; private historical bytes still exist.
  await fs.unlink(path.join(f.root, '.git/objects', original.slice(0, 2), original.slice(2)));
  for (const tracker of [f.tracker, f.open()]) {
    t.mock.method(tracker, 'git', () => { throw Error('HOST_GIT_AFTER_PUBLICATION'); });
    const result = await tracker.list('one', f.project, { path: 'tracked.txt' });
    assert.equal(result.baseline.storage, 'private-objects-v1');
    assert.ok(lines(result.diff).includes('-committed')); assert.ok(lines(result.diff).includes('+forged replacement'));
    assert.ok(!lines(result.diff).includes('-forged replacement'));
  }
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('initial Git capture ignores replacement refs and verifies SHA256 repository blob identities', async t => {
  const f = await gitFixture(t, {}, 'sha256');
  const original = (await f.git(['rev-parse', 'HEAD:tracked.txt'])).trim();
  await f.write('tracked.txt', 'replacement\n'); const replacement = (await f.git(['hash-object', '-w', 'tracked.txt'])).trim();
  await f.git(['replace', original, replacement]);
  await f.capture(); t.mock.method(f.tracker, 'git', () => { throw Error('HOST_GIT_AFTER_CAPTURE'); });
  const diff = await f.tracker.diff('one', f.project, { path: 'tracked.txt' });
  assert.ok(lines(diff).includes('-committed')); assert.ok(lines(diff).includes('+replacement'));
});

test('legacy Git baselines and already published projects fail unavailable without reading their Git state', async t => {
  const f = await gitFixture(t), captureGit = f.tracker.git.bind(f.tracker);
  const forbidden = t.mock.method(f.tracker, 'git', () => { throw Error('UNTRUSTED_GIT'); });
  await assert.rejects(f.tracker.initialize('one', f.project), { code: 'DIFF_BASELINE_UNAVAILABLE' });
  await assert.rejects(f.tracker.initialize('one', { ...f.project, independentRepository: false, nativeWorktree: true }, { projectCreated: true }), { code: 'DIFF_BASELINE_UNAVAILABLE' });
  assert.equal(forbidden.mock.callCount(), 0); forbidden.mock.restore(); f.tracker.git = captureGit;
  await f.capture(); const metadata = await baselineFile(f), saved = JSON.parse(await fs.readFile(metadata, 'utf8'));
  delete saved.baseline.storage; await fs.writeFile(metadata, JSON.stringify(saved));
  const reopened = f.open(), noGit = t.mock.method(reopened, 'git', () => { throw Error('LEGACY_GIT'); });
  await assert.rejects(reopened.list('one', f.project), { code: 'DIFF_BASELINE_UNAVAILABLE' });
  assert.equal(noGit.mock.callCount(), 0); assert.equal(JSON.parse(await fs.readFile(metadata, 'utf8')).baseline.storage, undefined);
});

test('Git capture bounds aggregate bytes, preserves binary and oversized classification, and checks batch content hash', async t => {
  const f = await gitFixture(t, { maxBytes: 16, maxFileBytes: 12 });
  await f.write('a.txt', '123456789\n'); await f.write('binary.bin', Buffer.from([0, 1, 2])); await f.write('large.txt', 'x'.repeat(20));
  await f.git(['add', '.']); await f.git(['-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'bounded']); f.project.baseCommit = (await f.git(['rev-parse', 'HEAD'])).trim();
  await f.capture();
  await f.write('a.txt', 'changed\n'); await f.write('binary.bin', Buffer.from([0, 1, 3])); await f.write('large.txt', 'y'.repeat(20));
  const entry = await f.tracker.initialize('one', f.project);
  assert.ok(entry.saved.warnings.includes('SOURCE_BYTE_LIMIT')); assert.ok(entry.saved.excludedPaths.includes('tracked.txt'));
  assert.equal(entry.saved.files['binary.bin'].kind, 'binary'); assert.equal(entry.saved.files['large.txt'].kind, 'oversized');
  const objects = await fs.readdir(path.join(entry.directory, 'objects')); assert.equal(objects.length, 1);
  const forged = await gitFixture(t); const realGit = forged.tracker.git.bind(forged.tracker);
  t.mock.method(forged.tracker, 'git', async (...args) => {
    const data = await realGit(...args);
    if (args[1][0] === 'cat-file') data[data.indexOf(10) + 1] ^= 1;
    return data;
  });
  await assert.rejects(forged.capture(), { code: 'DIFF_BASELINE_UNAVAILABLE' });
  await assert.rejects(fs.stat(await baselineFile(forged)), { code: 'ENOENT' });
});

test('missing or replaced private Git baseline objects never fall back to the project repository', async t => {
  const f = await gitFixture(t); const entry = await f.capture(), file = entry.saved.files['tracked.txt'];
  await f.write('tracked.txt', 'edited\n'); t.mock.method(f.tracker, 'git', () => { throw Error('HOST_GIT_FALLBACK'); });
  const object = path.join(entry.directory, 'objects', file.hash);
  await fs.writeFile(object, 'forged\n'); await assert.rejects(f.tracker.diff('one', f.project, { path: 'tracked.txt' }), { code: 'DIFF_BASELINE_UNAVAILABLE' });
  await fs.unlink(object); await assert.rejects(f.tracker.diff('one', f.project, { path: 'tracked.txt' }), { code: 'DIFF_BASELINE_UNAVAILABLE' });
});

test('secrets and generated dependency files are excluded and cannot be fetched directly', async t => {
  const f = await fixture(t); await f.tracker.initialize('one', f.project);
  const privatePaths = ['.env', '.env.production', 'server.pem', 'private.key', 'secrets/session-secret', 'session-secret', '.git/config',
    '.harness/state.json', 'node_modules/pkg/index.js'];
  for (const name of privatePaths) await f.write(name, 'DO-NOT-EXPOSE-SECRET\n');
  await f.write('.env.example', 'PUBLIC_SETTING=example\n'); await f.write('app.js', 'safe\n');
  const result = await f.tracker.list('one', f.project), byPath = filesByPath(result);
  for (const name of privatePaths) {
    assert.equal(byPath.has(name), false, name);
    await assert.rejects(f.tracker.diff('one', f.project, { path: name }), undefined, name);
  }
  assert.ok(byPath.has('.env.example')); assert.ok(byPath.has('app.js'));
  assert.equal(JSON.stringify(result).includes('DO-NOT-EXPOSE-SECRET'), false);
});

test('private paths in a legacy baseline are filtered without changing its public history or deleting recovery data', async t => {
  const f = await fixture(t, {}, 'continue'); await f.write('app.txt', 'original\n');
  await f.tracker.initialize('one', f.project); const metadata = await baselineFile(f);
  const saved = JSON.parse(await fs.readFile(metadata, 'utf8')),secret = 'FIXTURE_PRIVATE_BASELINE\n';
  const { createHash } = await import('node:crypto'), hash = createHash('sha256').update(secret).digest('hex');
  saved.files['secrets/session-secret'] = { hash, bytes: Buffer.byteLength(secret), kind: 'text' };
  const object = path.join(path.dirname(metadata), 'objects', hash); await fs.writeFile(object, secret);
  await fs.writeFile(metadata, JSON.stringify(saved)); await f.tracker.dispose();
  await f.write('secrets/session-secret', 'ROTATED_FIXTURE_VALUE\n'); await f.write('app.txt', 'changed\n');
  const reopened = f.open(), result = await reopened.list('one', f.project);
  assert.equal(result.files.some(file => file.path.includes('secrets')), false);
  assert.equal(result.baseline.at, saved.baseline.at);
  const diff = await reopened.diff('one', f.project, { path: 'app.txt' });
  assert.ok(lines(diff).includes('-original')); assert.ok(lines(diff).includes('+changed'));
  await assert.rejects(reopened.diff('one', f.project, { path: 'secrets/session-secret' }), { code: 'DIFF_PATH_EXCLUDED' });
  assert.equal(await fs.readFile(object, 'utf8'), secret, 'existing private recovery copies require a separate approved cleanup');
  assert(Object.hasOwn(JSON.parse(await fs.readFile(metadata, 'utf8')).files, 'secrets/session-secret'));
});

test('traversal cannot disclose files from another project or the state directory', async t => {
  const f = await fixture(t); await f.tracker.initialize('one', f.project);
  await fs.writeFile(path.join(f.sourceRoot, 'outside.txt'), 'private external text\n');
  for (const name of ['../source/outside.txt', path.join(f.sourceRoot, 'outside.txt'), '../state/manifest.json']) {
    await assert.rejects(f.tracker.diff('one', f.project, { path: name }));
  }
});

test('symlinked directories and files never expose outside content', async t => {
  const f = await fixture(t); await f.tracker.initialize('one', f.project);
  await fs.writeFile(path.join(f.sourceRoot, 'outside.txt'), 'private external text\n');
  // Junctions need no Windows developer-mode privilege and exercise directory traversal.
  await fs.symlink(f.sourceRoot, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.tracker.list('one', f.project);
  assert.equal(result.files.some(file => file.path.startsWith('linked/')), false);
  await assert.rejects(f.tracker.diff('one', f.project, { path: 'linked/outside.txt' }));
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(f.sourceRoot, 'outside.txt'), path.join(f.root, 'linked.txt'));
    await assert.rejects(f.tracker.diff('one', f.project, { path: 'linked.txt' }));
  }
});

test('binary and oversized files are reported without rendering their contents', async t => {
  const f = await fixture(t, { maxFileBytes: 32 }); await f.tracker.initialize('one', f.project);
  await f.write('binary.bin', Buffer.from([0, 1, 2, 3])); await f.write('large.txt', 'x'.repeat(33));
  const result = await f.tracker.list('one', f.project), byPath = filesByPath(result);
  assert.equal(byPath.get('binary.bin')?.kind, 'binary'); assert.equal(byPath.get('large.txt')?.kind, 'oversized');
  assert.equal((await f.tracker.diff('one', f.project, { path: 'binary.bin' })).kind, 'binary');
  const large = await f.tracker.diff('one', f.project, { path: 'large.txt' });
  assert.equal(large.kind, 'oversized'); assert.equal(JSON.stringify(large).includes('x'.repeat(33)), false);
});

test('file count and snapshot byte caps explicitly report incomplete coverage', async t => {
  const f = await fixture(t, { maxFiles: 2, maxBytes: 16 }, 'continue');
  await f.write('a.txt', 'a'.repeat(12)); await f.write('b.txt', 'b'.repeat(12)); await f.write('c.txt', 'c'.repeat(12));
  await f.tracker.initialize('one', f.project);
  const result = await f.tracker.list('one', f.project);
  assert.equal(result.partial, true); assert.ok(result.warnings.length > 0);
  assert.ok(result.files.length <= 2);
});

test('diff output obeys the line cap and flags truncation', async t => {
  const f = await fixture(t, { maxDiffLines: 4 }); await f.tracker.initialize('one', f.project);
  await f.write('many.txt', Array.from({ length: 25 }, (_, i) => 'line ' + i).join('\n') + '\n');
  const diff = await f.tracker.diff('one', f.project, { path: 'many.txt' });
  assert.equal(diff.kind, 'text'); assert.ok(lines(diff).length <= 4); assert.equal(diff.truncated, true);
});

test('revision tokens suppress unchanged lists and change after external disk edits', async t => {
  const f = await fixture(t); await f.tracker.initialize('one', f.project);
  await f.write('app.txt', 'first\n'); const first = await f.tracker.list('one', f.project);
  assert.ok(first.revision !== undefined);
  const unchanged = await f.tracker.list('one', f.project, { revision: first.revision });
  assert.equal(unchanged.unchanged, true); assert.equal(Object.hasOwn(unchanged, 'files'), false);
  await f.write('app.txt', 'a longer second value\n');
  const changed = await f.tracker.list('one', f.project, { revision: first.revision });
  assert.notEqual(changed.revision, first.revision); assert.notEqual(changed.unchanged, true);
  assert.ok(Array.isArray(changed.files));
});

test('simultaneous sessions keep independent contents and baselines', async t => {
  const f = await fixture(t), secondRoot = path.join(f.directory, 'second'); await fs.mkdir(secondRoot);
  const second = { ...f.project, root: secondRoot };
  await Promise.all([f.tracker.initialize('one', f.project), f.tracker.initialize('two', second)]);
  await f.write('same.txt', 'first project\n'); await fs.writeFile(path.join(secondRoot, 'same.txt'), 'second project\n');
  const [one, two] = await Promise.all([f.tracker.diff('one', f.project, { path: 'same.txt' }), f.tracker.diff('two', second, { path: 'same.txt' })]);
  assert.ok(lines(one).includes('+first project')); assert.equal(lines(one).includes('+second project'), false);
  assert.ok(lines(two).includes('+second project')); assert.equal(lines(two).includes('+first project'), false);
});

test('actual disk reserve refusal never silently substitutes an empty baseline', async t => {
  const f = await fixture(t, { minimumFreeBytes: Number.MAX_SAFE_INTEGER }, 'continue');
  await f.write('existing.txt', 'previous work\n');
  let refused = false;
  try {
    await f.tracker.initialize('one', f.project);
    const result = await f.tracker.list('one', f.project);
    assert.notEqual(result.baseline.kind, 'empty'); assert.equal(result.partial, true); assert.ok(result.warnings.length > 0);
    refused = true;
  } catch (error) {
    assert.match(String(error.code ?? '') + ' ' + error.message, /space|disk|reserve|storage/i); refused = true;
  }
  assert.equal(refused, true);
});

test('aborted reads do not produce a successful diff', async t => {
  const f = await fixture(t); await f.tracker.initialize('one', f.project); await f.write('app.txt', 'value\n');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.tracker.diff('one', f.project, { path: 'app.txt', signal: controller.signal }));
});

test('hunks remain native-compatible for files without a terminal newline', async t => {
  const f = await fixture(t, {}, 'continue'); await f.write('end.txt', 'old');
  await f.tracker.initialize('one', f.project); await f.write('end.txt', 'new');
  const diff = await f.tracker.diff('one', f.project, { path: 'end.txt' });
  assert.equal(diff.kind, 'text'); assert.ok(lines(diff).includes('-old')); assert.ok(lines(diff).includes('+new'));
  for (const line of lines(diff)) assert.match(line, /^[+ -]/);
});

test('selected-file revision avoids redundant hunks but refreshes after a content edit', async t => {
  const f = await fixture(t); await f.tracker.initialize('one', f.project); await f.write('app.txt', 'first\n');
  const first = await f.tracker.list('one', f.project, { path: 'app.txt' });
  assert.equal(first.diff.kind, 'text'); assert.ok(first.diff.revision);
  const same = await f.tracker.list('one', f.project,
    { path: 'app.txt', revision: first.revision, diffRevision: first.diff.revision });
  assert.equal(same.diffUnchanged, true); assert.equal(Object.hasOwn(same, 'diff'), false);
  await f.write('app.txt', 'second value\n');
  const changed = await f.tracker.list('one', f.project,
    { path: 'app.txt', revision: first.revision, diffRevision: first.diff.revision });
  assert.notEqual(changed.diffUnchanged, true); assert.notEqual(changed.diff.revision, first.diff.revision);
  assert.ok(lines(changed.diff).includes('+second value'));
});

test('UTF-8 BOM source snapshots retain valid original bytes after an edit', async t => {
  const f = await fixture(t, {}, 'continue'); await f.write('bom.txt', '\uFEFForiginal\n');
  await f.tracker.initialize('one', f.project); await f.write('bom.txt', '\uFEFFchanged\n');
  const diff = await f.tracker.diff('one', f.project, { path: 'bom.txt' });
  assert.equal(diff.kind, 'text'); assert.ok(lines(diff).some(line => line.startsWith('-') && line.includes('original')));
  assert.ok(lines(diff).some(line => line.startsWith('+') && line.includes('changed')));
});

test('a capped scan never labels an unvisited existing baseline file as deleted', async t => {
  const f = await fixture(t, { maxFiles: 2 }, 'continue');
  await f.write('b.txt', 'b\n'); await f.write('z.txt', 'z\n'); await f.tracker.initialize('one', f.project);
  await f.write('a.txt', 'a\n'); const result = await f.tracker.list('one', f.project);
  assert.equal(result.partial, true); assert.ok(result.warnings.length > 0);
  assert.equal(result.files.some(file => file.path === 'z.txt' && file.status === 'deleted'), false);
  assert.equal(await fs.readFile(path.join(f.root, 'z.txt'), 'utf8'), 'z\n');
});

test('ordinary filenames matching Object prototype keys retain independent added diffs', async t => {
  const f = await fixture(t); await f.tracker.initialize('one', f.project);
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  for (const name of names) await f.write(name, name + ' content\n');
  const result = await f.tracker.list('one', f.project), byPath = filesByPath(result);
  for (const name of names) {
    assert.equal(byPath.get(name)?.status, 'added', name);
    const diff = await f.tracker.diff('one', f.project, { path: name });
    assert.equal(diff.before, false, name); assert.ok(lines(diff).includes('+' + name + ' content'), name);
  }
});

async function baselineFile(f) {
  const entries = await fs.readdir(f.stateRoot, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory()); assert.equal(directories.length, 1);
  return path.join(f.stateRoot, directories[0].name, 'baseline.json');
}

test('corrupt saved baseline metadata fails closed after a restart', async t => {
  const f = await fixture(t, {}, 'continue'); await f.write('app.txt', 'original\n');
  await f.tracker.initialize('one', f.project); const metadata = await baselineFile(f); await f.tracker.dispose();
  await fs.writeFile(metadata, '{corrupt'); await f.write('app.txt', 'edited\n');
  const reopened = f.open(); await assert.rejects(reopened.initialize('one', f.project), /baseline/i);
  assert.equal(await fs.readFile(metadata, 'utf8'), '{corrupt');
});

test('tampered saved source bytes cannot be served as an authentic before image', async t => {
  const f = await fixture(t, {}, 'continue'); await f.write('app.txt', 'original\n');
  await f.tracker.initialize('one', f.project); const metadata = await baselineFile(f);
  const saved = JSON.parse(await fs.readFile(metadata, 'utf8')); await f.tracker.dispose();
  const object = path.join(path.dirname(metadata), 'objects', saved.files['app.txt'].hash);
  await fs.writeFile(object, 'forged before image\n'); await f.write('app.txt', 'edited\n');
  const reopened = f.open(); await reopened.initialize('one', f.project);
  await assert.rejects(reopened.diff('one', f.project, { path: 'app.txt' }), /baseline|retained|changed/i);
});
