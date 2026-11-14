import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkbenchError, DEFAULTS, validateSettings, RepairBudget, validationKind, relativeFile, within } from './policy.mjs';
import { readJSON, atomicJSON, ProjectLocks, canonicalInside, sourceManifest, saveCheckpoint, hash } from './storage.mjs';
const run = promisify(execFile);
const notice = text => ({ id: crypto.randomUUID(), role: 'user', source: { kind: 'workspace-runtime' }, content: [{ type: 'text', text }] });

export class WorkspaceManager {
  constructor(ctx, config = {}) {
    this.ctx = ctx; this.config = config;
    this.root = config.stateRoot ?? '/data/harness/state/workbench'; this.projectsRoot = config.projectsRoot ?? '/data/harness/workspaces/projects';
    this.file = path.join(this.root, 'registry.json'); this.locks = new ProjectLocks(path.join(this.root, 'leases'));
    this.serial = Promise.resolve(); this.persistQueue = Promise.resolve(); this.running = new Map(); this.grants = new Map(); this.budgets = new Map(); this.frozenSettings = new Map(); this.pendingNotices = new Map();
  }
  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); await fs.mkdir(this.projectsRoot, { recursive: true, mode: 0o700 });
    this.data = await readJSON(this.file, { version: 1, installedAt: Date.now(), workspaces: {}, sessions: {}, trash: {} });
    await this.save();
    for (const [id, record] of Object.entries(this.data.sessions)) this.budgets.set(id, new RepairBudget(record.budget));
    // Never migrate a live legacy conversation just because this plugin loaded.
    this.existing = new Set(this.ctx.agents.list().map(a => a.id));
    for (const agent of this.ctx.agents.list()) if (agent.status === 'running') {
      const root = this.ctx.workingDirectory.get(agent.session);
      try { await this.locks.acquire(root, agent.id); this.running.set(agent.id, root); } catch (error) { this.ctx.logger.warn('Workspace lease conflict during live enrollment: ' + error.code); }
    }
  }
  inOrder(action) { const next = this.serial.then(action); this.serial = next.catch(() => {}); return next; }
  save() { const snapshot = structuredClone(this.data); const next = this.persistQueue.then(() => atomicJSON(this.file, snapshot)); this.persistQueue = next.catch(() => {}); return next; }
  workspaceFor(session) { return this.ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(session.id) || w.path === session.header.cwd); }
  settings(session) { const workspace = this.workspaceFor(session); return validateSettings(this.data.workspaces[workspace?.id ?? session.header.cwd]?.settings ?? {}); }
  async updateSettings(workspaceId, input) {
    return this.inOrder(async () => {
      if (!this.ctx.workspaceRegistry.get(workspaceId)) throw new WorkbenchError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
      const settings = validateSettings(input); await this.ctx.llm.resolveCallConfig({ provider: settings.provider, model: settings.model, reasoningEffort: settings.reasoningEffort, maxTokens: settings.maxTokens, temperature: settings.temperature });
      this.data.workspaces[workspaceId] = { settings, at: Date.now() }; await this.save(); return settings;
    });
  }
  async applyDefaults(agent, source) {
    if (source !== 'startup' || agent.session.header.origin === 'subagent' || agent.session.header.isSeeded) return;
    const settings = this.settings(agent.session);
    // Deliberately do not save the selection as the account-wide last-used default.
    await this.ctx.llm.resolveCallConfig({ provider: settings.provider, model: settings.model, reasoningEffort: settings.reasoningEffort });
    agent.model.select({ provider: settings.provider, model: settings.model, reasoningEffort: settings.reasoningEffort });
  }
  async allocatePorts() {
    const used = new Set(Object.values(this.data.sessions).flatMap(x => x.ports ?? []));
    const start = this.config.portBase ?? 21000;
    for (let base = start; base < start + 4000; base += 4) {
      const ports = [base, base + 1, base + 2, base + 3]; if (ports.some(p => used.has(p))) continue;
      const handles = [];
      try { for (const port of ports) { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); handles.push(server); } return ports; }
      catch { /* Occupied by a non-managed process; try the next allocation. */ }
      finally { for (const server of handles) await new Promise(resolve => server.close(resolve)); }
    }
    throw new WorkbenchError('NO_FREE_PORTS', 'No free project port allocation remains.');
  }
  async ensureProject(agent, signal) {
    const current = this.ctx.workingDirectory.get(agent.session);
    if (agent.session.header.origin === 'subagent') return { root: current, legacy: true };
    return this.inOrder(async () => {
      let record = this.data.sessions[agent.id];
      if (record) {
        if (!this.grants.has(agent.id) && !within(agent.session.header.cwd, record.root)) this.grants.set(agent.id, agent.ctx.sandboxPolicy.registerWritableRoot(agent.session, record.root));
        if (current !== record.root) await this.ctx.workingDirectory.set(agent, record.root, signal);
        return record;
      }
      const createdAt = typeof agent.session.header.createdAt === 'number' ? agent.session.header.createdAt : Date.parse(agent.session.header.createdAt);
      if (this.existing.has(agent.id) || !Number.isFinite(createdAt) || createdAt < this.data.installedAt) {
        record = { root: current, sourceRoot: current, legacy: true, at: Date.now() };
        this.data.sessions[agent.id] = record; this.budgets.set(agent.id, new RepairBudget()); await this.save(); return record;
      }
      const settings = this.settings(agent.session), workspace = this.workspaceFor(agent.session);
      let repository, baseCommit;
      if (settings.projectMode !== 'fresh' && settings.projectMode !== 'continue') {
        try {
          const options = { cwd: current, timeout: 10000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } };
          repository = (await run('git', ['-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', 'rev-parse', '--show-toplevel'], options)).stdout.trim();
          baseCommit = (await run('git', ['-c', 'protocol.allow=never', 'rev-parse', '--verify', (settings.baseCommit ?? 'HEAD') + '^{commit}'], options)).stdout.trim();
          await run('git', ['-c', 'protocol.allow=never', 'rev-list', '--objects', '--missing=error', baseCommit, '--'], options);
        } catch (error) { if (settings.projectMode === 'worktree') throw new WorkbenchError('COMMIT_REQUIRED', 'Existing projects require an available local Git commit before creating a worktree.'); }
      }
      if (repository && !baseCommit) throw new WorkbenchError('COMMIT_REQUIRED', 'Commit the existing repository before creating an isolated checkout.');
      let root, branch, nativeWorktree = false;
      if (repository && baseCommit) {
        const result = await this.ctx.worktrees.create(agent, { from: baseCommit }, signal);
        root = result.path; branch = result.branch; baseCommit = result.baseCommit; nativeWorktree = true;
      } else if (settings.projectMode === 'continue') root = await fs.realpath(current);
      else {
        root = path.join(this.projectsRoot, agent.id.replace(/[^a-zA-Z0-9_-]/gu, '_'));
        await fs.mkdir(root, { mode: 0o700 });
        this.grants.set(agent.id, agent.ctx.sandboxPolicy.registerWritableRoot(agent.session, root));
        await this.ctx.workingDirectory.set(agent, root, signal);
      }
      const ports = await this.allocatePorts(), databasePath = path.join(root, '.harness', 'data', 'app.sqlite');
      await fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      record = { root, sourceRoot: current, workspaceId: workspace?.id, ports, databasePath, baseCommit, branch, nativeWorktree, at: Date.now(), settings };
      this.data.sessions[agent.id] = record; this.budgets.set(agent.id, new RepairBudget()); await this.save();
      await atomicJSON(path.join(root, '.harness', 'project.json'), { sessionId: agent.id, ports, databasePath, baseCommit, root });
      this.pendingNotices.set(agent.id, notice(`Project isolation is ready. Work only in ${JSON.stringify(root)}. ${baseCommit ? `Source commit: ${baseCommit}; source checkout and uncommitted files were not copied or changed.` : 'This independent task has a new empty project.'} App/API/test ports: ${ports.join(', ')}. Use the project-specific database ${JSON.stringify(databasePath)}; never reuse another project database. Use project_exec for shell commands; it confines writes to this checkout and automatically exports PORT, API_PORT, DATABASE_URL and the prepared tool paths. Browser: /data/harness/dev/browser/node_modules/playwright; doctor: /data/harness/app/development/doctor.cjs. Validate each milestone; repeated failing checks or an unverified stage exceeding ${settings.maxStageSteps} steps will pause the run for a user strategy decision.`));
      return record;
    });
  }
  async preStep({ agent, signal, turn, step }) {
    const initiator = agent.id; agent = this.ownerAgent(agent);
    if (this.data.trash[agent.id]) throw new WorkbenchError('SESSION_IN_TRASH', 'Restore this conversation before continuing.');
    const record = await this.ensureProject(agent, signal);
    await this.locks.acquire(record.root, agent.id); this.running.set(agent.id, record.root);
    const budget = this.budgets.get(agent.id), settings = this.settings(agent.session);
    // One admission per proposed step; retries do not consume a second stage step.
    if (record.lastStep !== `${initiator}:${turn}:${step}`) { record.lastStep = `${initiator}:${turn}:${step}`; budget.step(settings.maxStageSteps); }
    record.budget = budget; await this.save();
    if (budget.blocked) throw new WorkbenchError(budget.blocked.code, budget.blocked.message + ' Open Workspace → Run review to choose a different strategy.');
  }
  ownerAgent(agent) {
    const seen = new Set();
    while (agent?.session.header.origin === 'subagent') {
      if (seen.has(agent.id)) throw new WorkbenchError('PARENT_CYCLE', 'Invalid parent chain.'); seen.add(agent.id);
      const parent = this.ctx.agents.get(agent.session.header.parentSession);
      if (!parent) throw new WorkbenchError('PARENT_UNAVAILABLE', 'The project owner must be available before a child can write.');
      agent = parent;
    }
    return agent;
  }
  toolGuard(exec) {
    const id = exec.agent?.id; if (!id) return;
    const blocked = this.budgets.get(id)?.blocked;
    if (this.data.trash[id] || blocked) return { reason: blocked?.message ?? 'Conversation is in Trash.', info: { code: blocked?.code ?? 'SESSION_IN_TRASH' } };
    const record = this.data.sessions[id]; if (!record) return;
    if (!record.legacy && ['bash', 'exec_command', 'terminal'].includes(exec.name)) return { reason: 'Use project_exec for commands in this managed project; it applies the isolated filesystem policy and project environment.' };
    const args = exec.arguments;
    if (args && ['write', 'edit', 'apply_patch', 'delete_file', 'bash'].includes(exec.name)) {
      const value = args.file_path ?? args.path ?? args.workdir;
      if (typeof value === 'string' && !within(record.root, path.resolve(record.root, value))) return { reason: 'Write/command target is outside this isolated project. Use a read tool to inspect source material.' };
      const patch = args.patch ?? args.input;
      if (exec.name === 'apply_patch' && typeof patch === 'string') for (const line of patch.split('\n')) { const match = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/u.exec(line); if (match && !within(record.root, path.resolve(record.root, match[1]))) return { reason: 'Patch target is outside this isolated project.' }; }
    }
  }
  async toolResult(exec, result, verificationKind) {
    const record = this.data.sessions[exec.agent?.id]; if (!record || exec.signal.aborted) return;
    const command = exec.arguments?.command, kind = verificationKind ?? (exec.name === 'stage_check' ? 'test' : validationKind(command));
    const exitCode = result.value?.exitCode;
    if (!kind && !result.isError && !(Number.isInteger(exitCode) && exitCode !== 0)) return;
    // A shell pipeline can hide the real check exit code. It cannot earn a pass.
    if (kind && exitCode === 0 && (exec.name === 'project_exec' ? /\|\||;\s*(?:true|exit\s+0)\b/u : /\||;|\$\(/u).test(command ?? '')) return;
    const text = result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') ?? result.error?.message ?? '';
    let manifest; try { manifest = await sourceManifest(record.root, { signal: exec.signal }); } catch (error) { record.checkpointError = error.code ?? 'CHECKPOINT_FAILED'; }
    const budget = this.budgets.get(exec.agent.id), decision = budget.observe({ kind, exitCode, text, isError: result.isError, manifestHash: manifest?.sha256 }, this.settings(exec.agent.session).noProgressLimit);
    if (decision.improved && manifest) {
      try {
        const saved = await saveCheckpoint(record.root, path.join(this.root, 'checkpoints', exec.agent.id, 'best'), manifest);
        record.checkpoints ??= {}; record.checkpoints[decision.key] = { path: saved, score: decision.score, at: Date.now(), files: Object.keys(manifest.files).length, sha256: manifest.sha256 };
      } catch (error) { record.checkpointError = error.code ?? 'CHECKPOINT_FAILED'; }
    }
    record.budget = budget; await this.save();
  }
  async review(id) {
    const agent = this.ctx.agents.get(id), owner = agent ? this.ownerAgent(agent) : undefined, record = this.data.sessions[owner?.id ?? id];
    if (!record) return undefined;
    const manifest = await sourceManifest(record.root);
    return { root: record.root, sourceHash: manifest.sha256, budget: record.budget, checkpoints: record.checkpoints, ports: record.ports, databasePath: record.databasePath };
  }
  async reportVerification(report) {
    const agent = this.ctx.agents.get(report.sessionId); if (!agent) throw new WorkbenchError('SESSION_NOT_LIVE', 'A live conversation is required to record verification.');
    if (!['test', 'build', 'browser', 'acceptance', 'all'].includes(report.kind) || !Number.isInteger(report.exitCode)) throw new WorkbenchError('INVALID_VERIFICATION', 'Invalid structured verification result.', 400);
    const owner = this.ownerAgent(agent), record = this.data.sessions[owner.id]; if (!record) throw new WorkbenchError('PROJECT_NOT_READY', 'Project isolation is not ready.');
    if (report.sourceHash && (await sourceManifest(record.root)).sha256 !== report.sourceHash) throw new WorkbenchError('STALE_VERIFICATION', 'The source changed during verification; stale evidence cannot pass a stage.');
    await this.toolResult({ agent: owner, name: 'stage_check', arguments: {}, signal: report.signal ?? new AbortController().signal }, { isError: report.exitCode !== 0, value: { exitCode: report.exitCode }, content: [{ type: 'text', text: String(report.diagnostics ?? '').slice(-16000) }] }, report.kind);
    record.lastVerification = { kind: report.kind, exitCode: report.exitCode, at: Date.now(), sourceHash: report.sourceHash, checksPassed: report.checksPassed, checksTotal: report.checksTotal }; await this.save();
  }
  async releaseIfIdle(id) {
    if (this.ctx.agents.get(id)?.status === 'running') return;
    const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
    if (activity.length) return;
    await this.locks.release(id); this.running.delete(id);
  }
  async reviewResume(id, strategy) {
    const record = this.data.sessions[id], agent = this.ctx.agents.get(id);
    if (!record || !agent || agent.status === 'running') throw new WorkbenchError('SESSION_BUSY', 'Open an idle managed conversation before resuming.');
    const budget = this.budgets.get(id); budget.resume(strategy); record.budget = budget; record.lastStep = null; await this.save();
    agent.followup(notice('The owner reviewed the paused run and chose this revised approach: ' + strategy + '. Continue the existing task in the isolated project and verify a small stage first.'));
  }
  async restoreCheckpoint(id, key, signal) {
    const record = this.data.sessions[id], checkpoint = record?.checkpoints?.[key];
    if (!checkpoint || !within(path.join(this.root, 'checkpoints', id), checkpoint.path)) throw new WorkbenchError('CHECKPOINT_NOT_FOUND', 'Checkpoint not found.', 404);
    return this.withFiles(id, async (root, policy) => {
      const manifest = await readJSON(path.join(checkpoint.path, 'checkpoint-manifest.json'), null);
      if (!manifest || hash(JSON.stringify(Object.entries(manifest.files).sort())) !== checkpoint.sha256) throw new WorkbenchError('CHECKPOINT_INVALID', 'Checkpoint manifest does not match.');
      const current = await sourceManifest(root, { signal });
      record.beforeRestore = await saveCheckpoint(root, path.join(this.root, 'checkpoints', id, 'before-restore'), current); await this.save();
      for (const [relative, expected] of Object.entries(manifest.files)) {
        relativeFile(relative); const source = await canonicalInside(path.join(checkpoint.path, 'files'), relative), bytes = await fs.readFile(source);
        if (hash(bytes) !== expected.sha256) throw new WorkbenchError('CHECKPOINT_INVALID', 'Checkpoint file checksum does not match.');
        const destination = await canonicalInside(root, relative, true); await fs.mkdir(path.dirname(destination), { recursive: true });
        const target = await this.ctx.fs.resolve(destination, { signal }), stat = await this.ctx.fs.stat(target, signal);
        if (expected.binary) { const temp = destination + '.restore-' + crypto.randomUUID(); await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, destination); }
        else await this.ctx.fs.writeText(target, bytes.toString('utf8'), stat ? { kind: 'replaceIfVersion', version: stat.version } : { kind: 'createIfAbsent' }, signal, policy);
      }
      for (const relative of Object.keys(current.files)) if (!(relative in manifest.files)) {
        const target = await this.ctx.fs.resolve(await canonicalInside(root, relative), { signal }), stat = await this.ctx.fs.stat(target, signal);
        await this.ctx.fs.deleteFile(target, { version: stat.version }, signal, policy);
      }
      return { restored: true, files: Object.keys(manifest.files).length, previousVersionRetained: true };
    }, true);
  }
  async trashSession(id) {
    if (this.ctx.agents.get(id)?.status === 'running') throw new WorkbenchError('SESSION_BUSY', 'A running conversation cannot be deleted.');
    await this.ctx.workspaceRegistry.archiveSession(id); // Native admission also checks jobs, children and schedules.
    const workspace = this.ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(id));
    this.data.trash[id] = { at: Date.now(), workspaceId: workspace?.id }; await this.save();
    // Retain the actual log and project; deletion can be undone safely.
    if (workspace) await workspace.detachSession(id);
    return { deleted: true, reversible: true };
  }
  async restoreSession(id) {
    const record = this.data.trash[id]; if (!record) throw new WorkbenchError('NOT_IN_TRASH', 'Conversation is not in Trash.', 404);
    await this.ctx.workspaceRegistry.unarchiveSession(id);
    const workspace = record.workspaceId ? this.ctx.workspaceRegistry.get(record.workspaceId) : undefined;
    if (workspace) await workspace.attachSession(id);
    delete this.data.trash[id]; await this.save(); return { restored: true };
  }
  async projectFor(id) {
    const live = this.ctx.sessions.get(id), stored = live ? undefined : await this.ctx.sessionPersistence.stat(id);
    const header = live?.header ?? stored?.header; if (!header) throw new WorkbenchError('SESSION_NOT_FOUND', 'Conversation not found.', 404);
    return { root: this.data.sessions[id]?.root ?? (live ? this.ctx.workingDirectory.get(live) : header.cwd), live, header };
  }
  async withFiles(id, action, write = false) {
    const project = await this.projectFor(id), root = await fs.realpath(project.root), owner = '@files:' + crypto.randomUUID();
    if (write) {
      await this.releaseIfIdle(id);
      if (project.live && this.ctx.sandboxPolicy.resolve({ session: project.live }).mode === 'read-only') throw new WorkbenchError('READ_ONLY', 'The selected conversation is read-only.', 403);
      await this.locks.acquire(root, owner);
    }
    try { return await action(root, { mode: 'workspace-write', workspaceRoot: root, sessionId: id }); }
    finally { if (write) await this.locks.release(owner); }
  }
  async files(id, operation, args, signal) {
    return this.withFiles(id, async (root, policy) => {
      const relative = args.path === '' && operation === 'list' ? '' : relativeFile(args.path);
      const file = await canonicalInside(root, relative, ['write', 'mkdir', 'upload'].includes(operation));
      if (operation === 'list') {
        const entries = await fs.readdir(file, { withFileTypes: true }); return { path: relative, entries: entries.filter(e => !['.git', '.harness'].includes(e.name)).slice(0,1000).map(e => ({ name: e.name, directory: e.isDirectory(), symlink: e.isSymbolicLink() })) };
      }
      const target = await this.ctx.fs.resolve(file, { signal });
      if (!within(root, this.ctx.fs.processPath(target))) throw new WorkbenchError('OUTSIDE_PROJECT', 'Resolved path is outside the project.', 403);
      if (operation === 'stat') { const info = await this.ctx.fs.stat(target, signal); return { path: relative, version: info?.version, bytes: info?.size }; }
      if (operation === 'read') { const info = await this.ctx.fs.stat(target, signal); if (info?.size > 1024 * 1024) throw new WorkbenchError('TOO_LARGE', 'Use Download for files larger than 1 MiB.', 413); const bytes = await this.ctx.fs.readBytes(target, signal, 1024 * 1024); let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) throw Error('binary'); } catch { throw new WorkbenchError('BINARY_FILE', 'Binary files can be downloaded, renamed or deleted.', 415); } return { path: relative, version: info?.version, text }; }
      if (operation === 'write') {
        if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 1024 * 1024 || args.text.includes('\0')) throw new WorkbenchError('INVALID_TEXT', 'Text exceeds the editor limit.', 413);
        const expected = args.version ? { kind: 'replaceIfVersion', version: args.version } : { kind: 'createIfAbsent' };
        return this.ctx.fs.writeText(target, args.text, expected, signal, policy);
      }
      if (operation === 'delete') {
        if (!args.version) throw new WorkbenchError('VERSION_REQUIRED', 'Read the current file before deleting it.', 400);
        return this.ctx.fs.deleteFile(target, { version: args.version }, signal, policy);
      }
      if (operation === 'rename') {
        if (!args.version) throw new WorkbenchError('VERSION_REQUIRED', 'Read the current file before renaming it.', 400);
        const destination = await canonicalInside(root, relativeFile(args.destination), true), to = await this.ctx.fs.resolve(destination, { signal });
        return this.ctx.fs.moveFile(target, to, { expectedSource: { version: args.version }, expectedDestination: { kind: 'createIfAbsent' } }, signal, policy);
      }
      if (operation === 'mkdir') { await fs.mkdir(file, { mode: 0o755 }); return { created: true }; }
      if (operation === 'download') { const data = await this.ctx.fs.readBytes(target, signal, 10 * 1024 * 1024); return { bytes: data, name: path.basename(file) }; }
      if (operation === 'upload') {
        const data = Buffer.from(args.base64 ?? '', 'base64'); if (data.length > 4 * 1024 * 1024) throw new WorkbenchError('TOO_LARGE', 'Upload limit is 4 MiB.', 413);
        await fs.writeFile(file, data, { flag: 'wx', mode: 0o644 }); return { uploaded: true };
      }
      throw new WorkbenchError('UNKNOWN_OPERATION', 'Unknown file operation.', 400);
    }, !['list', 'read', 'stat', 'download'].includes(operation));
  }
}
