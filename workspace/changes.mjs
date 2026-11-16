import fs from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { WorkbenchError, relativeFile, within } from './policy.mjs';
import { atomicJSON, canonicalInside } from './storage.mjs';
import privateSource from './source-private.cjs';
const { isPrivateSourcePath } = privateSource;

const execute = promisify(execFile), MIB = 1024 ** 2;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const EXCLUDED = new Set(['.git', '.harness', '.agents', '.codex', '.aws', '.ssh', 'node_modules', 'bin', 'obj', 'dist', 'out', 'build', 'coverage', '.next', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'artifacts', 'screenshots', 'test-results', 'playwright-report', 'logs']);
function allowed(value) {
  try { relativeFile(value); } catch { return false; }
  return !/[\r\n]/u.test(value) && !isPrivateSourcePath(value) && value.split('/').every(part => !EXCLUDED.has(part)) && !value.endsWith('.log');
}
function textOf(data) {
  try { if (data.includes(0)) return null; return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { return null; }
}
function blobHash(data, algorithm = 'sha1') { return crypto.createHash(algorithm).update('blob ' + data.length + '\0').update(data).digest('hex'); }

// Check the opened descriptor before reading, not only the pathname observed by
// readdir. Linux /proc/self/fd also detects a replaced parent-directory link.
async function readStable(root, relative, limit) {
  const file = await canonicalInside(root, relative), info = await fs.lstat(file);
  if (!info.isFile() || info.size > limit) throw new WorkbenchError('DIFF_FILE_LIMIT', 'This file exceeds the comparison limit.', 413);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > limit) throw new WorkbenchError('DIFF_CHANGING_FILE', 'The file is being replaced.');
    if (process.platform === 'linux') {
      const actual = await fs.realpath('/proc/self/fd/' + handle.fd);
      if (!within(await fs.realpath(root), actual)) throw new WorkbenchError('OUTSIDE_PROJECT', 'File descriptor is outside the project.', 403);
    }
    const buffer = Buffer.alloc(opened.size + 1); let size = 0;
    while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
    const data = buffer.subarray(0, size), after = await handle.stat(), current = await fs.lstat(await canonicalInside(root, relative));
    if (data.length > limit || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || after.ino !== current.ino || after.dev !== current.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs) throw new WorkbenchError('DIFF_CHANGING_FILE', 'The file changed during comparison.');
    return data;
  } finally { await handle.close(); }
}

export class LiveChanges {
  constructor({ stateRoot, maxFiles = 1000, maxBytes = 8 * MIB, maxFileBytes = 256 * 1024, maxDiffLines = 5000, minimumFreeBytes = 2 * 1024 ** 3, scanIntervalMs = 1000, runtimeRoot } = {}) {
    if (!path.isAbsolute(stateRoot ?? '')) throw Error('An absolute change-state directory is required');
    for (const [name, value] of Object.entries({ maxFiles, maxBytes, maxFileBytes, maxDiffLines })) if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid change limit: ' + name);
    if (!Number.isFinite(minimumFreeBytes) || minimumFreeBytes < 0 || !Number.isFinite(scanIntervalMs) || scanIntervalMs < 0) throw Error('Invalid change cache bounds');
    Object.assign(this, { stateRoot, maxFiles, maxBytes, maxFileBytes, maxDiffLines, minimumFreeBytes, scanIntervalMs, runtimeRoot });
    this.entries = new Map(); this.lifetime = new AbortController();
  }
  dispose() { this.lifetime.abort(); this.entries.clear(); }
  async git(root, args, maxBuffer = 2 * MIB, input = '') {
    const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat', GIT_EXTERNAL_DIFF: '' };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const pending = execute('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '--no-pager', ...args], { cwd: root, env, encoding: 'buffer', timeout: 8000, maxBuffer, signal: this.lifetime.signal, windowsHide: true });
    pending.child.stdin.on('error', () => {}); pending.child.stdin.end(input);
    const result = await pending;
    return result.stdout;
  }
  async scan(root, algorithm = 'sha1') {
    const files = Object.create(null), warnings = new Set(), ignored = new Set(); let bytes = 0, visited = 0, stopped = false, complete = true;
    const started = Date.now();
    const walk = async (directory, prefix = '', depth = 0) => {
      if (depth > 32) { warnings.add('SOURCE_DEPTH_LIMIT'); complete = false; return; }
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; ignored.add(prefix); warnings.add('CHANGING_OR_EXCLUDED_FILES'); complete = false; return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        this.lifetime.signal.throwIfAborted(); if (stopped) break;
        if (++visited > 10000 || Date.now() - started > 3000) { warnings.add('SOURCE_SCAN_LIMIT'); stopped = true; complete = false; break; }
        const relative = prefix ? prefix + '/' + entry.name : entry.name;
        if (!allowed(relative)) continue;
        if (entry.isSymbolicLink()) { ignored.add(relative); warnings.add('SYMLINKS_EXCLUDED'); continue; }
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(file, relative, depth + 1); continue; }
        if (!entry.isFile()) continue;
        if (Object.keys(files).length >= this.maxFiles) { warnings.add('SOURCE_FILE_LIMIT'); stopped = true; complete = false; break; }
        try {
          const stat = await fs.lstat(file);
          if (stat.size > this.maxBytes || bytes + stat.size > this.maxBytes) { ignored.add(relative); warnings.add('SOURCE_BYTE_LIMIT'); continue; }
          const data = await readStable(root, relative, this.maxBytes - bytes), text = textOf(data);
          bytes += data.length;
          files[relative] = { hash: digest(data), gitHash: blobHash(data, algorithm), bytes: data.length, kind: text === null ? 'binary' : data.length > this.maxFileBytes ? 'oversized' : 'text', ...(text !== null && data.length <= this.maxFileBytes ? { text } : {}) };
        } catch (error) {
          if (['ENOENT', 'EACCES', 'EPERM', 'DIFF_CHANGING_FILE', 'SYMLINK_REFUSED', 'ELOOP', 'OUTSIDE_PROJECT'].includes(error.code)) { ignored.add(relative); warnings.add('CHANGING_OR_EXCLUDED_FILES'); continue; }
          throw error;
        }
      }
    };
    await walk(root); return { files, bytes, warnings: [...warnings], ignored, complete, at: Date.now() };
  }
  async initialize(sessionId, project, { projectCreated = false, signal } = {}) {
    signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted();
    const root = await fs.realpath(project.root), key = digest(sessionId + '\0' + root);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { root, key, sessionId, directory: path.join(this.stateRoot, key), diffs: new Map() }; this.entries.set(key, entry);
      entry.ready = this.baseline(entry, project, projectCreated).catch(error => { this.entries.delete(key); throw error; });
    }
    await entry.ready; signal?.throwIfAborted(); return entry;
  }
  async baseline(entry, project, projectCreated) {
    await fs.mkdir(entry.directory, { recursive: true, mode: 0o700 });
    const metadata = path.join(entry.directory, 'baseline.json');
    let stored;
    try { stored = JSON.parse((await readStable(entry.directory, 'baseline.json', 2 * MIB)).toString('utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'The saved comparison baseline is unavailable.'); }
    if (stored) {
      if (stored.version !== 1 || stored.sessionId !== entry.sessionId || stored.root !== entry.root || !['empty', 'git-base', 'snapshot'].includes(stored.baseline?.kind) || !stored.files || typeof stored.files !== 'object' || Array.isArray(stored.files) || Object.keys(stored.files).length > this.maxFiles || Object.entries(stored.files).some(([name, file]) => !(allowed(name) || isPrivateSourcePath(name)) || !file || !/^[a-f0-9]{40,64}$/u.test(file.hash ?? '') || !['text', 'binary', 'oversized', 'unknown'].includes(file.kind))) throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'The saved comparison baseline is invalid.');
      // Older Git baselines borrowed the mutable project's object store. Do
      // not upgrade them by running Git after the project has been published.
      if (stored.baseline.kind === 'git-base' && (stored.baseline.storage !== 'private-objects-v1' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(stored.baseline.commit ?? '') || Object.values(stored.files).some(file => !new RegExp('^[a-f0-9]{' + stored.baseline.commit.length + '}$').test(file.gitHash ?? '') || file.kind === 'unknown' || file.kind === 'text' && !/^[a-f0-9]{64}$/u.test(file.hash)))) throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'The historical Git comparison was not retained privately.');
      stored.files = Object.assign(Object.create(null), stored.files);
      const removed = Object.entries(stored.files).filter(([name]) => isPrivateSourcePath(name));
      if (removed.length) {
        for (const [name] of removed) delete stored.files[name];
        // Older private copies are not exposed by code history. Retain their
        // immutable storage for an explicitly approved recovery/cleanup audit.
      }
      entry.saved = stored; return;
    }
    const at = Date.now(); let baseline, files = Object.create(null), warnings = [], complete = true, excludedPaths = [];
    if (project.baseCommit) {
      if (!projectCreated || project.independentRepository !== true || project.nativeWorktree || project.legacy || project.settings?.projectMode === 'continue' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(project.baseCommit)) throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'Git comparison can only be captured before a new independent project is published.');
      const data = (await this.git(entry.root, ['ls-tree', '-r', '-l', '-z', project.baseCommit, '--'])).toString('utf8');
      const captures = []; let bytes = 0;
      for (const row of data.split('\0').filter(Boolean)) {
        const match = /^(\d+) (\w+) ([a-f0-9]{40,64}) +(-|\d+)\t([\s\S]+)$/u.exec(row); if (!match) throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'Invalid Git baseline listing.');
        const [, mode, type, hash, size, name] = match; if (!allowed(name)) continue;
        if (mode === '120000' || type !== 'blob') { warnings.push('GIT_LINKS_EXCLUDED'); continue; }
        if (Object.keys(files).length >= this.maxFiles) { warnings.push('SOURCE_FILE_LIMIT'); complete = false; break; }
        const length = Number(size);
        if (hash.length !== project.baseCommit.length || !Number.isSafeInteger(length) || length < 0) throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'Invalid Git baseline object.');
        if (length <= this.maxFileBytes && bytes + length > this.maxBytes) { warnings.push('SOURCE_BYTE_LIMIT'); excludedPaths.push(name); continue; }
        files[name] = { hash, gitHash: hash, bytes: length, kind: length > this.maxFileBytes ? 'oversized' : 'unknown' };
        if (length <= this.maxFileBytes) { bytes += length; captures.push(name); }
      }
      const space = await fs.statfs(entry.directory);
      if (Number(space.bavail) * Number(space.bsize) - bytes < this.minimumFreeBytes) throw new WorkbenchError('DIFF_DISK_RESERVE', 'Insufficient space to retain a safe comparison baseline.', 507);
      await fs.mkdir(path.join(entry.directory, 'objects'), { recursive: true, mode: 0o700 });
      if (captures.length) {
        // Exactly one bounded binary batch, addressed by validated blob IDs;
        // neither pathspecs, textconv nor checkout filters interpret the data.
        const contents = await this.git(entry.root, ['cat-file', '--batch'], bytes + captures.length * 100, captures.map(name => files[name].gitHash).join('\n') + '\n');
        let offset = 0;
        for (const name of captures) {
          const file = files[name], end = contents.indexOf(10, offset), header = file.gitHash + ' blob ' + file.bytes;
          if (end < 0 || contents.subarray(offset, end).toString('ascii') !== header) throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'The Git baseline object is unavailable.');
          const next = end + 1 + file.bytes, content = contents.subarray(end + 1, next);
          if (contents[next] !== 10 || blobHash(content, project.baseCommit.length === 64 ? 'sha256' : 'sha1') !== file.gitHash) throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'The Git baseline object failed verification.');
          offset = next + 1; file.hash = digest(content); file.kind = textOf(content) === null ? 'binary' : 'text';
          if (file.kind === 'text') await fs.writeFile(path.join(entry.directory, 'objects', file.hash), content, { mode: 0o600, flag: 'wx' }).catch(async error => {
            if (error.code !== 'EEXIST') throw error;
            if (digest(await readStable(entry.directory, 'objects/' + file.hash, this.maxFileBytes)) !== file.hash) throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'The retained comparison file has changed.');
          });
        }
        if (offset !== contents.length) throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'Unexpected Git baseline data.');
      }
      baseline = { kind: 'git-base', storage: 'private-objects-v1', label: 'project-start', at: project.at ?? at, commit: project.baseCommit };
    } else if (!project.nativeWorktree && project.sourceRoot && path.resolve(project.sourceRoot) !== path.resolve(project.root) && project.settings?.projectMode !== 'continue') {
      baseline = { kind: 'empty', label: 'project-start', at: project.at ?? at };
    } else {
      const capture = await this.scan(entry.root), space = await fs.statfs(entry.root);
      if (Number(space.bavail) * Number(space.bsize) - capture.bytes < this.minimumFreeBytes) throw new WorkbenchError('DIFF_DISK_RESERVE', 'Insufficient space to retain a safe comparison baseline.', 507);
      warnings = capture.warnings; complete = capture.complete; excludedPaths = [...capture.ignored];
      await fs.mkdir(path.join(entry.directory, 'objects'), { mode: 0o700 });
      for (const [name, file] of Object.entries(capture.files)) {
        const { text, ...info } = file; files[name] = info;
        if (text !== undefined) await fs.writeFile(path.join(entry.directory, 'objects', info.hash), text, { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      }
      baseline = { kind: 'snapshot', label: projectCreated ? 'project-start' : 'tracking-start', at };
    }
    const saved = { version: 1, sessionId: entry.sessionId, root: entry.root, baseline, files, complete, excludedPaths, warnings: [...new Set(warnings)] };
    await atomicJSON(metadata, saved); entry.saved = saved;
  }
  async current(entry) {
    if (entry.current && Date.now() - entry.current.at < this.scanIntervalMs) return entry.current;
    if (!entry.pending) entry.pending = this.scan(entry.root, entry.saved.baseline.commit?.length === 64 ? 'sha256' : 'sha1').then(current => {
      const before = entry.saved.files, changed = [];
      for (const name of [...new Set([...Object.keys(before), ...Object.keys(current.files)])].sort()) {
        if ([...current.ignored].some(ignored => name === ignored || name.startsWith(ignored + '/'))) continue;
        if ((entry.saved.excludedPaths ?? []).some(ignored => name === ignored || name.startsWith(ignored + '/'))) continue;
        const old = before[name], now = current.files[name];
        // An unvisited path is unknown, not evidence of an addition/deletion.
        if (!now && old && !current.complete || !old && now && entry.saved.complete === false) continue;
        if (old && now && (entry.saved.baseline.kind === 'git-base' ? old.gitHash === now.gitHash : old.hash === now.hash)) continue;
        const kind = old?.kind === 'binary' || now?.kind === 'binary' ? 'binary' : old?.kind === 'oversized' || now?.kind === 'oversized' ? 'oversized' : now?.kind ?? 'text';
        changed.push({ path: name, status: !old ? 'added' : !now ? 'deleted' : 'modified', kind, added: null, deleted: null });
      }
      const warnings = [...new Set([...(entry.saved.warnings ?? []), ...current.warnings])];
      current.filesChanged = changed; current.warnings = warnings;
      current.revision = digest(JSON.stringify([entry.saved.baseline, changed.map(f => [f.path, before[f.path]?.hash ?? null, current.files[f.path]?.hash ?? null]), warnings]));
      entry.current = current; return current;
    }).finally(() => { entry.pending = undefined; });
    return entry.pending;
  }
  async list(sessionId, project, { running = false, path: selected, revision, diffRevision, signal } = {}) {
    const entry = await this.initialize(sessionId, project, { signal }), current = await this.current(entry); signal?.throwIfAborted();
    const value = { version: 1, sessionId, root: entry.root, baseline: entry.saved.baseline, revision: current.revision, running, updatedAt: current.at, partial: current.warnings.length > 0, warnings: current.warnings, total: current.filesChanged.length, ...(revision === current.revision ? { unchanged: true } : { files: current.filesChanged }) };
    if (selected) {
      relativeFile(selected); if (!allowed(selected)) throw new WorkbenchError('DIFF_PATH_EXCLUDED', 'This private or generated path is excluded from changes.', 403);
      if (!current.filesChanged.some(file => file.path === selected)) value.diff = null;
      else { const fileRevision = this.fileRevision(entry, current, selected); if (diffRevision === fileRevision) value.diffUnchanged = true; else value.diff = await this.selected(entry, current, selected, signal); }
    }
    return value;
  }
  fileRevision(entry, current, name) {
    relativeFile(name); if (!allowed(name)) throw new WorkbenchError('DIFF_PATH_EXCLUDED', 'This private or generated path is excluded from changes.', 403);
    if (!current.filesChanged.some(file => file.path === name)) throw new WorkbenchError('DIFF_FILE_NOT_CHANGED', 'The selected file has no captured change.', 404);
    return digest([name, entry.saved.files[name]?.hash ?? '', current.files[name]?.hash ?? ''].join('\0'));
  }
  async diff(sessionId, project, { path: selected, signal } = {}) {
    const entry = await this.initialize(sessionId, project, { signal }), current = await this.current(entry); signal?.throwIfAborted(); return this.selected(entry, current, selected, signal);
  }
  async before(entry, name) {
    const file = entry.saved.files[name]; if (!file) return null;
    if (file.kind === 'binary' || file.kind === 'oversized') return undefined;
    let data;
    try { data = await readStable(entry.directory, 'objects/' + file.hash, this.maxFileBytes); }
    catch { throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'The retained comparison file is unavailable.'); }
    if (digest(data) !== file.hash || entry.saved.baseline.kind === 'git-base' && blobHash(data, entry.saved.baseline.commit.length === 64 ? 'sha256' : 'sha1') !== file.gitHash) throw new WorkbenchError('DIFF_BASELINE_UNAVAILABLE', 'The retained comparison file has changed.');
    return textOf(data);
  }
  compare(before, after) {
    if (!this.structuredPatch) {
      const runtime = this.runtimeRoot ?? process.env.HOMEAI_RUNTIME ?? (existsSync('/data/harness/runtime/package.json') ? '/data/harness/runtime' : process.env.HARNESS_NATIVE_CLI ? path.resolve(path.dirname(process.env.HARNESS_NATIVE_CLI), '../../../..') : null);
      const require = createRequire(runtime ? path.join(runtime, 'package.json') : import.meta.url);
      this.structuredPatch = require('diff').structuredPatch;
    }
    const old = before ?? '', next = after ?? '', patch = this.structuredPatch('', '', old, next, undefined, undefined, { context: 3, timeout: 75 });
    const coarse = patch === undefined;
    let hunks = patch?.hunks.map(hunk => ({ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines: hunk.lines.filter(line => !line.startsWith('\\')) })) ?? [{ oldStart: 1, oldLines: old ? old.split('\n').length : 0, newStart: 1, newLines: next ? next.split('\n').length : 0, lines: [...(old ? old.replace(/\n$/u, '').split('\n').map(line => '-' + line) : []), ...(next ? next.replace(/\n$/u, '').split('\n').map(line => '+' + line) : [])] }];
    let added = 0, deleted = 0, shown = 0, truncated = false;
    for (const hunk of hunks) for (const line of hunk.lines) { if (line.startsWith('+')) added++; else if (line.startsWith('-')) deleted++; }
    hunks = hunks.flatMap(hunk => { const remaining = this.maxDiffLines - shown; if (remaining <= 0) { truncated = true; return []; } const lines = hunk.lines.slice(0, remaining); shown += lines.length; if (lines.length < hunk.lines.length) truncated = true; return [{ ...hunk, lines }]; });
    return { hunks, coarse, truncated, added, deleted, beforeNewline: old.endsWith('\n'), afterNewline: next.endsWith('\n') };
  }
  async selected(entry, current, name, signal) {
    const revision = this.fileRevision(entry, current, name); signal?.throwIfAborted();
    const cached = entry.diffs.get(revision); if (cached) return cached;
    const changed = current.filesChanged.find(file => file.path === name), old = entry.saved.files[name], now = current.files[name];
    let kind = changed.kind;
    const value = { version: 1, path: name, status: changed.status, revision, kind, before: Boolean(old), after: Boolean(now) };
    if (kind !== 'binary' && kind !== 'oversized') {
      const before = await this.before(entry, name), after = now?.text ?? (now ? undefined : null);
      if (before === undefined || after === undefined) kind = 'oversized'; else if (before === null && old || after === null && now) kind = 'binary';
      value.kind = kind;
      if (kind === 'text') Object.assign(value, this.compare(before, after));
    }
    signal?.throwIfAborted(); entry.diffs.set(revision, value); if (entry.diffs.size > 32) entry.diffs.delete(entry.diffs.keys().next().value); return value;
  }
}
