import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KINDS = ['build', 'test', 'browser', 'acceptance'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IGNORED = new Set(['.git', 'node_modules', '.harness', '.harness-quality', '.npmcache', 'dist', 'coverage', 'playwright-report', 'test-results']);
export class QualityError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, p) => p === root || (!path.relative(root, p).startsWith('..' + path.sep) && path.relative(root, p) !== '..' && !path.isAbsolute(path.relative(root, p)));

export async function confined(root, relative, { missing = false } = {}) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative)) throw new QualityError('INVALID_PATH', 'Expected a project-relative path.');
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new QualityError('OUTSIDE_PROJECT', 'Path leaves the project.');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new QualityError('SYMLINK_REFUSED', 'Verification paths must not be symlinks.'); }
    catch (e) { if (missing && e.code === 'ENOENT') break; throw e; }
  }
  return target;
}

export async function readJson(root, relative) {
  const p = await confined(root, relative), stat = await fs.stat(p);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new QualityError('INVALID_JSON_FILE', 'JSON evidence must be a regular file no larger than 1 MiB.');
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

export function validateContract(c) {
  if (c && Object.keys(c).some(k => !['version', 'description', 'sources', 'requiredKinds', 'checks'].includes(k))) throw new QualityError('INVALID_CONTRACT', 'Unknown contract option.');
  if (!c || c.version !== 1 || !Array.isArray(c.sources) || !c.sources.length || c.sources.length > 128 || c.sources.some(s => typeof s !== 'string')) throw new QualityError('INVALID_CONTRACT', 'Declare version 1 and a nonempty sources list.');
  if (!Array.isArray(c.requiredKinds) || !c.requiredKinds.length || new Set(c.requiredKinds).size !== c.requiredKinds.length || c.requiredKinds.some(k => !KINDS.includes(k))) throw new QualityError('INVALID_CONTRACT', 'Declare unique requiredKinds.');
  if (!Array.isArray(c.checks) || !c.checks.length || c.checks.length > 32) throw new QualityError('INVALID_CONTRACT', 'Declare 1–32 checks.');
  const ids = new Set();
  for (const check of c.checks) {
    if (check && Object.keys(check).some(k => !['id','kind','command','plan','timeoutMs','cwd','env','artifacts','resultFile'].includes(k))) throw new QualityError('INVALID_CHECK', 'Unknown check option.');
    if (!check || !/^[a-z][a-z0-9_-]{0,63}$/u.test(check.id) || ids.has(check.id) || !KINDS.includes(check.kind)) throw new QualityError('INVALID_CHECK', 'Checks need a unique id and supported kind.');
    ids.add(check.id);
    if (check.kind === 'browser') {
      if (typeof check.plan !== 'string' || check.command !== undefined) throw new QualityError('INVALID_BROWSER_CHECK', 'Browser checks use the real built-in driver and a plan, never a replacement command.');
    } else {
      if (!Array.isArray(check.command) || !check.command.length || check.command.length > 64 || check.command.some(x => typeof x !== 'string' || x.includes('\0') || x.length > 16384)) throw new QualityError('INVALID_COMMAND', 'Use a bounded program-and-arguments array.');
      const program = path.basename(check.command[0]).toLowerCase().replace(/\.exe$/u, '');
      if (['bash', 'sh', 'dash', 'zsh', 'cmd', 'powershell', 'pwsh'].includes(program)) throw new QualityError('SHELL_REFUSED', 'Call verification programs directly; shell pipelines can hide failed exits.');
    }
    if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > 120000)) throw new QualityError('INVALID_TIMEOUT', 'Check timeout must be 100–120000 ms.');
    if (check.cwd !== undefined && typeof check.cwd !== 'string') throw new QualityError('INVALID_PATH', 'cwd must be project-relative.');
    if (check.artifacts !== undefined && (!Array.isArray(check.artifacts) || check.artifacts.some(p => typeof p !== 'string'))) throw new QualityError('INVALID_ARTIFACTS', 'artifacts must be relative file paths.');
    for (const [key, value] of Object.entries(check.env ?? {})) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(key) || /^(?:PATH$|HOME$|USERPROFILE$|NODE_OPTIONS$|LD_|DYLD_|HARNESS_|DSH_)/u.test(key) || typeof value !== 'string' || value.length > 4096) throw new QualityError('INVALID_ENV', 'Check environment cannot override runtime or sandbox settings.');
    }
  }
  for (const kind of c.requiredKinds) if (!c.checks.some(x => x.kind === kind)) throw new QualityError('MISSING_REQUIRED_CHECK', `No ${kind} check was declared.`);
  return c;
}

export async function fingerprint(root, sources) {
  const hash = crypto.createHash('sha256'), seen = new Set(); let bytes = 0;
  async function visit(relative) {
    const p = await confined(root, relative), stat = await fs.stat(p);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(p)).sort()) if (!IGNORED.has(name)) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const key = path.relative(root, p).split(path.sep).join('/'); if (seen.has(key)) return;
      seen.add(key); bytes += stat.size;
      if (seen.size > 20000 || bytes > 64 * 1024 * 1024) throw new QualityError('SOURCE_LIMIT', 'Narrow sources to at most 20000 files / 64 MiB, excluding generated output.');
      const data = await fs.readFile(p); hash.update(key + '\0' + data.length + '\0'); hash.update(data);
    } else throw new QualityError('INVALID_SOURCE', 'Sources must be regular files/directories.');
  }
  for (const source of [...new Set(sources)].sort()) await visit(source);
  return { hash: hash.digest('hex'), files: seen.size, bytes };
}

export function parseTestCounts(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/gu, '');
  const last = re => [...clean.matchAll(re)].at(-1)?.[1];
  let p = last(/(?:^|\n)\s*(?:#|ℹ)\s*pass\s+(\d+)\b/gu), f = last(/(?:^|\n)\s*(?:#|ℹ)\s*fail\s+(\d+)\b/gu);
  if (p === undefined) { p = last(/\bPassed:\s*(\d+)/gu); f = last(/\bFailed:\s*(\d+)/gu); }
  if (p === undefined) { p = last(/\b(\d+) passed\b/gu); f = last(/\b(\d+) failed\b/gu) ?? '0'; }
  return p === undefined || f === undefined ? null : { passed: Number(p), failed: Number(f) };
}

export async function runProgram(command, { cwd, env = process.env, signal, timeoutMs = 30000, outputLimit = 65536 } = {}) {
  signal?.throwIfAborted();
  return new Promise(resolve => {
    let stdout = '', stderr = '', truncated = false, timedOut = false, aborted = false, settled = false;
    const child = spawn(command[0], command.slice(1), { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      if (!Number.isInteger(child.pid)) return;
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
    };
    const abort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const append = stream => data => { const value = data.toString('utf8'); if (stream === 'stdout') { if (stdout.length + value.length > outputLimit) truncated = true; stdout = (stdout + value).slice(-outputLimit); } else { if (stderr.length + value.length > outputLimit) truncated = true; stderr = (stderr + value).slice(-outputLimit); } };
    child.stdout.on('data', append('stdout')); child.stderr.on('data', append('stderr'));
    function finish(exitCode, error) { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ exitCode, stdout, stderr, truncated, timedOut, aborted, ...(error ? { error: error.message } : {}) }); }
    child.once('error', e => finish(null, e)); child.once('close', code => finish(code));
  });
}

export async function verifyProject({ workspace, contractPath = '.harness-quality.json', kind = 'all', signal, run = runProgram, env = process.env, budgetMs = 110000 } = {}) {
  const root = await fs.realpath(workspace);
  if (kind !== 'all' && !KINDS.includes(kind)) throw new QualityError('INVALID_KIND', 'Unknown verification kind.');
  const contract = validateContract(await readJson(root, contractPath));
  const selected = contract.checks.filter(c => kind === 'all' || c.kind === kind);
  if (!selected.length) throw new QualityError('NO_CHECKS', 'No checks of that kind were declared.');
  const outputDir = await confined(root, '.harness/quality', { missing: true }); await fs.mkdir(outputDir, { recursive: true });
  const lockPath = path.join(outputDir, 'verification.lock'); let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new QualityError('VERIFICATION_BUSY', 'A verification already owns this project.'); throw e; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    const inputs = [...contract.sources, contractPath, ...contract.checks.filter(c => c.plan).map(c => c.plan)];
    const before = await fingerprint(root, inputs), startedAt = Date.now(), runId = crypto.randomUUID(), results = [];
    for (const check of selected) {
      signal?.throwIfAborted();
      const start = Date.now(), diagnostics = []; let measured = { passed: 0, failed: 1 }, artifacts = [], result;
      const remaining = budgetMs - (start - startedAt);
      if (remaining < 100) { results.push({ id: check.id, kind: check.kind, passed: false, exitCode: null, checksPassed: 0, checksTotal: 1, diagnostics: ['VERIFICATION_BUDGET_EXHAUSTED'], artifactPaths: [] }); break; }
      const cwd = await confined(root, check.cwd ?? '.');
      const resultFile = check.kind === 'browser' ? `.harness/quality/${check.id}-browser.json` : check.resultFile;
      if (resultFile) await confined(root, resultFile, { missing: true });
      const command = check.kind === 'browser' ? [process.execPath, path.join(HERE, 'browser.mjs'), '--workspace', root, '--plan', check.plan, '--output', resultFile, '--run-id', runId] : check.command;
      result = await run(command, { cwd, env: { ...env, ...check.env, HARNESS_QUALITY_RUN_ID: runId }, signal, timeoutMs: Math.min(check.timeoutMs ?? 30000, remaining) });
      if (result.aborted || signal?.aborted) throw signal?.reason ?? new QualityError('ABORTED', 'Verification cancelled.');
      if (result.exitCode !== 0 || result.timedOut) diagnostics.push(result.timedOut ? 'CHECK_TIMEOUT' : `EXIT_${result.exitCode ?? 'UNAVAILABLE'}`);
      if (result.error) diagnostics.push(result.error);
      await fs.writeFile(path.join(outputDir, check.id + '.log'), result.stdout + '\n[stderr]\n' + result.stderr, { mode: 0o600 });
      try {
        if (resultFile) {
          const reportPath = await confined(root, resultFile), stat = await fs.stat(reportPath), data = await readJson(root, resultFile);
          if (stat.mtimeMs < start - 10 || data.runId !== runId) throw new QualityError('STALE_EVIDENCE', 'Structured evidence must be produced by this run.');
          if (!Number.isInteger(data.passed) || !Number.isInteger(data.failed) || data.passed < 0 || data.failed < 0) throw new QualityError('INVALID_COUNTS', 'Invalid structured check counts.');
          measured = { passed: data.passed, failed: data.failed };
          if (check.kind === 'browser' && (data.engine !== 'chromium' || !data.screenshots?.length)) throw new QualityError('BROWSER_EVIDENCE_MISSING', 'A real Chromium run and screenshots are required.');
          for (const artifact of data.screenshots ?? []) { await confined(root, artifact.path); artifacts.push(artifact.path); }
          artifacts.push(resultFile);
          for (const failed of data.results?.filter(r => !r.passed) ?? []) diagnostics.push([failed.code ?? failed.name ?? 'ASSERTION_FAILED', failed.detail].filter(Boolean).join(': ').slice(0,500));
        } else if (check.kind === 'test' || check.kind === 'acceptance') {
          measured = parseTestCounts(result.stdout + '\n' + result.stderr) ?? { passed: 0, failed: 1 };
        } else measured = { passed: result.exitCode === 0 ? 1 : 0, failed: result.exitCode === 0 ? 0 : 1 };
        if (!measured.passed) diagnostics.push('NO_POSITIVE_CHECKS');
        if (measured.failed) diagnostics.push(`FAILED_ASSERTIONS_${measured.failed}`);
        for (const artifact of check.artifacts ?? []) { const p = await confined(root, artifact); if (!(await fs.stat(p)).isFile()) throw new QualityError('ARTIFACT_MISSING', 'Expected a regular output file.'); artifacts.push(artifact); }
      } catch (e) { diagnostics.push(e.code ?? e.message); }
      const passed = !diagnostics.length;
      results.push({ id: check.id, kind: check.kind, passed, exitCode: result.exitCode, durationMs: Date.now() - start, checksPassed: measured.passed, checksTotal: measured.passed + measured.failed, outputTruncated: result.truncated, diagnostics: diagnostics.slice(0,8), artifactPaths: artifacts, logPath: `.harness/quality/${check.id}.log` });
    }
    const after = await fingerprint(root, inputs), stale = before.hash !== after.hash;
    if (stale) for (const r of results) { r.passed = false; r.diagnostics.push('SOURCE_CHANGED_DURING_VERIFICATION'); }
    const passed = results.length === selected.length && results.every(r => r.passed);
    const verifiedKinds = [...new Set(results.filter(r => r.passed).map(r => r.kind))].filter(k => results.filter(r => r.kind === k).every(r => r.passed));
    const report = { version: 1, runId, startedAt, finishedAt: Date.now(), sourceHash: after.hash, initialSourceHash: before.hash, contractHash: digest(JSON.stringify(contract)), stale, passed, complete: passed && contract.requiredKinds.every(k => verifiedKinds.includes(k)), verifiedKinds, missingKinds: contract.requiredKinds.filter(k => !verifiedKinds.includes(k)), results };
    const temp = path.join(outputDir, runId + '.json'); await fs.writeFile(temp, JSON.stringify(report, null, 2), { mode: 0o600 }); await fs.rename(temp, path.join(outputDir, 'latest.json'));
    return report;
  } finally { await lock.close(); await fs.unlink(lockPath); }
}

export function compactReport(report) {
  return { passed: report.passed, complete: report.complete, stale: report.stale, sourceHash: report.sourceHash, missingKinds: report.missingKinds, checks: report.results.map(r => ({ id: r.id, kind: r.kind, passed: r.passed, checksPassed: r.checksPassed, checksTotal: r.checksTotal, diagnostics: r.diagnostics, logPath: r.logPath, artifactPaths: r.artifactPaths })), reportPath: '.harness/quality/latest.json' };
}

