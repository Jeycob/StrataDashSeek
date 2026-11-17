import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WorkbenchError } from './policy.mjs';

const MIB = 1024 ** 2;
// Git for Windows also accepts its POSIX /dev/null path; Node's Windows
// os.devNull device spelling is not accepted by Git's config reader.
const options = ['--no-optional-locks', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.protectNTFS=true', '-c', 'core.protectHFS=true', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
function environment() {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  return { ...env, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
}
export function projectGit(cwd, args, { signal, input = '', maxBuffer = 8 * MIB } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...options, ...args], { cwd, env: environment(), signal, timeout: 120000, maxBuffer, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function sourceCommit(current, requested, required, signal) {
  let root;
  try { root = await fs.realpath((await projectGit(current, ['rev-parse', '--show-toplevel'], { signal })).trim()); }
  catch (error) { if (signal.aborted) throw signal.reason; if (required) throw new WorkbenchError('COMMIT_REQUIRED', 'The source project needs an available local Git commit.'); return null; }
  let commit;
  try { commit = (await projectGit(root, ['rev-parse', '--verify', '--end-of-options', (requested ?? 'HEAD') + '^{commit}'], { signal })).trim(); }
  catch { throw new WorkbenchError('COMMIT_REQUIRED', 'The source project needs an available local Git commit.'); }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new WorkbenchError('COMMIT_REQUIRED', 'Invalid source commit.');
  return { root, commit, format: commit.length === 64 ? 'sha256' : 'sha1' };
}
async function transferPack(source, target, ids, maxBytes, signal) {
  // Direct object plumbing avoids local clone hardlinks, alternates, source
  // upload-pack hooks, filter programs, credential helpers and remote fetches.
  // https://git-scm.com/docs/git-pack-objects ; https://git-scm.com/docs/shallow
  const writer = spawn('git', [...options, 'pack-objects', '--stdout', '--no-reuse-delta', '--no-reuse-object', '--window=0', '--threads=1'], { cwd: source, env: environment(), signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = spawn('git', [...options, 'index-pack', '--stdin', '--strict'], { cwd: target, env: environment(), signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const children = [writer, reader];
  const completions = children.map(child => new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new WorkbenchError('PROJECT_OBJECT_TRANSFER_FAILED', 'Git object transfer did not complete.'))); child.stderr.resume(); child.stdin.on('error', () => {}); }));
  for (const promise of completions) promise.catch(() => {});
  reader.stdout.resume(); writer.stdin.end(ids.join('\n') + '\n');
  let bytes = 0;
  const bound = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > maxBytes ? new WorkbenchError('PROJECT_COPY_LIMIT', 'The committed project exceeds the copy limit.') : null, chunk); } });
  try { await Promise.all([pipeline(writer.stdout, bound, reader.stdin, { signal }), ...completions]); }
  finally { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); await Promise.allSettled(completions); }
}
export async function createIndependentProject({ projectsRoot, sessionId, sourceRoot, mode = 'auto', baseCommit, signal, maxBytes = 128 * MIB, minimumFreeBytes = 2 * 1024 ** 3 }) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !['auto', 'fresh', 'worktree'].includes(mode) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) throw new WorkbenchError('PROJECT_REPOSITORY_CONFIG', 'Invalid independent project configuration.');
  const timeout = AbortSignal.timeout(120000), abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  abort.throwIfAborted();
  const parent = await fs.realpath(projectsRoot), source = mode === 'fresh' ? null : await sourceCommit(sourceRoot, baseCommit, mode === 'worktree', abort);
  let ids = [], total = 0;
  if (source) {
    ids = (await projectGit(source.root, ['rev-list', '--objects', '--no-object-names', '--no-walk', source.commit, '--'], { signal: abort })).trim().split('\n');
    if (!ids.length || ids.length > 50000 || ids.some(id => !new RegExp('^[a-f0-9]{' + source.commit.length + '}$').test(id)) || !ids.includes(source.commit)) throw new WorkbenchError('PROJECT_COPY_LIMIT', 'The committed project object inventory is unavailable or too large.');
    const metadata = await projectGit(source.root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: ids.join('\n') + '\n', signal: abort });
    const rows = metadata.trim().split('\n'); if (rows.length !== ids.length) throw new WorkbenchError('PROJECT_OBJECTS_UNAVAILABLE', 'The committed project objects are unavailable.');
    for (let i = 0; i < rows.length; i++) { const match = /^([a-f0-9]+) (commit|tree|blob) (\d+)$/.exec(rows[i]); if (!match || match[1] !== ids[i]) throw new WorkbenchError('PROJECT_OBJECTS_UNAVAILABLE', 'The committed project objects are unavailable.'); total += Number(match[3]); if (!Number.isSafeInteger(total) || total > maxBytes) throw new WorkbenchError('PROJECT_COPY_LIMIT', 'The committed project exceeds the copy limit.'); }
    const names = (await projectGit(source.root, ['ls-tree', '-r', '--name-only', '-z', source.commit, '--'], { signal: abort })).split('\0');
    if (names.some(name => /^\.harness(?:\/|$)/i.test(name))) throw new WorkbenchError('PROJECT_PRIVATE_PATH_CONFLICT', 'The source commit contains reserved project runtime state.');
  }
  const space = await fs.statfs(parent); if (Number(space.bavail) * Number(space.bsize) < minimumFreeBytes + total * 3 + MIB) throw new WorkbenchError('PROJECT_DISK_RESERVE', 'There is insufficient disk space for an independent project.', 507);
  const root = path.join(parent, sessionId); await fs.mkdir(root, { mode: 0o700 }); const owned = await fs.lstat(root);
  try {
    const template = path.join(root, '.empty-template'); await fs.mkdir(template, { mode: 0o700 });
    await projectGit(root, ['init', '--initial-branch=main', '--object-format=' + (source?.format ?? 'sha1'), '--template=' + template, '.'], { signal: abort });
    await fs.rmdir(template);
    let commit = source?.commit;
    if (source) {
      // Retain the exact source commit/tree as a single shallow baseline. There
      // is no borrowed object store or implicit history/network dependency.
      await fs.writeFile(path.join(root, '.git/shallow'), commit + '\n', { flag: 'wx', mode: 0o600 });
      await transferPack(source.root, root, ids, maxBytes + 8 * MIB, abort);
      await projectGit(root, ['update-ref', 'refs/heads/main', commit], { signal: abort });
      await projectGit(root, ['reset', '--hard', commit], { signal: abort });
    } else {
      await projectGit(root, ['-c', 'user.name=HomeAI', '-c', 'user.email=project@homeai.invalid', 'commit', '--allow-empty', '-m', 'Initialize independent project'], { signal: abort });
      commit = (await projectGit(root, ['rev-parse', 'HEAD'], { signal: abort })).trim();
    }
    await fs.mkdir(path.join(root, '.git/info'), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, '.git/info/exclude'), '# Private Harness runtime state\n.harness/\n', { flag: 'wx', mode: 0o600 });
    await projectGit(root, ['fsck', '--connectivity-only', '--no-reflogs'], { signal: abort });
    const gitDir = await fs.lstat(path.join(root, '.git')), common = (await projectGit(root, ['rev-parse', '--git-common-dir'], { signal: abort })).trim();
    if (!gitDir.isDirectory() || gitDir.isSymbolicLink() || path.resolve(root, common) !== path.join(root, '.git')) throw new WorkbenchError('PROJECT_GIT_NOT_INDEPENDENT', 'Project Git metadata is not independent.');
    return { root, branch: 'main', baseCommit: commit, independentRepository: true, nativeWorktree: false, sourceCommit: source?.commit, sourceObjectBytes: total };
  } catch (error) {
    // Only this unpublished newly allocated directory may be removed. A
    // replaced or moved directory is retained for operator inspection.
    const now = await fs.lstat(root).catch(() => null);
    if (now?.isDirectory() && !now.isSymbolicLink() && now.dev === owned.dev && now.ino === owned.ino && await fs.realpath(root) === root && path.dirname(root) === parent) await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
