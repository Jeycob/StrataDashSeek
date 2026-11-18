import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkbenchError, DEFAULTS, validateSettings, RepairBudget, REPAIR_POLICY_VERSION, validationKind, relativeFile, within, operationFingerprint } from './policy.mjs';
import { readJSON, atomicJSON, ProjectLocks, canonicalInside, sourceManifest, saveCheckpoint, hash } from './storage.mjs';
import { LiveChanges } from './changes.mjs';
import { previewCheckpointRestore, restoreCheckpointTransaction, recoverCheckpointRestore, checkpointRecoveryStatus } from './checkpoint-restore.mjs';
import { classifyToolOutcome, classifyVerificationOutcome, recoveryContext, normalizeVerificationCommand } from './tool-recovery.mjs';
import { guideFirstCheck } from './verification-guidance.mjs';
import { verificationStatusMayBeMasked } from './shell-status.mjs';
import { beginUserRequest } from './turn-budget.mjs';
import { prepareAutomaticRequest, automaticReview, admitAutomaticStep } from './automatic-review.mjs';
import {automaticReceipt,reconcileAutomatic,retainAutomaticProcess} from './automatic-recovery.mjs';
import { registeredSelection, validateWorkspaceModel } from './model-selection.mjs';
import { createIndependentProject } from './project-repository.mjs';
import { bindProjectExecution } from './execution-mode.mjs';
import privateSource from './source-private.cjs';
const { isPrivateSourcePath } = privateSource;
const run = promisify(execFile);
const notice = text => ({ id: crypto.randomUUID(), role: 'user', source: { kind: 'workspace-runtime' }, content: [{ type: 'text', text }] });

export class WorkspaceManager {
  constructor(ctx, config = {}, executionBinding) {
    Object.defineProperty(this, 'execution', { value: bindProjectExecution(executionBinding), enumerable: true });
    this.ctx = ctx; this.config = config; this.repairPolicyVersion = REPAIR_POLICY_VERSION;
    this.root = config.stateRoot ?? '/data/harness/state/workbench'; this.projectsRoot = config.projectsRoot ?? '/data/harness/workspaces/projects';
    this.file = path.join(this.root, 'registry.json'); this.locks = new ProjectLocks(path.join(this.root, 'leases'));
    this.changes = new LiveChanges({ ...config.changes, stateRoot: path.join(this.root, 'changes') }, this.execution);
    this.serial = Promise.resolve(); this.persistQueue = Promise.resolve(); this.running = new Map(); this.grants = new Map(); this.budgets = new Map(); this.frozenSettings = new Map(); this.pendingNotices = new Map(); this.pendingDiagnostics = new Map(); this.resultWork = new Map(); this.automaticReviews = new Map();
  }
  async initialize() {
    await this.checked(() => fs.mkdir(this.root, { recursive: true, mode: 0o700 })); await this.checked(() => fs.mkdir(this.projectsRoot, { recursive: true, mode: 0o700 }));
    this.data = await this.checked(() => readJSON(this.file, { version: 1, installedAt: Date.now(), workspaces: {}, sessions: {}, trash: {} }));
    await this.save();
    for (const [id, record] of Object.entries(this.data.sessions)) this.budgets.set(id, new RepairBudget(record.budget));
    // Never migrate a live legacy conversation just because this plugin loaded.
    this.existing = new Set(this.ctx.agents.list().map(a => a.id));
    for (const agent of this.ctx.agents.list()) if (agent.status === 'running') {
      const root = this.ctx.workingDirectory.get(agent.session);
      try { await this.locks.acquire(root, agent.id); this.running.set(agent.id, root); } catch (error) { this.ctx.logger.warn('Workspace lease conflict during live enrollment: ' + error.code); }
    }
    this.execution.assertUnchanged();
  }
  async checked(action) { this.execution.assertUnchanged(); const value = await action(); this.execution.assertUnchanged(); return value; }
  inOrder(action) { const next = this.serial.then(() => this.checked(action)); this.serial = next.catch(() => {}); return next; }
  save() { this.execution.assertUnchanged(); const snapshot = structuredClone(this.data); const next = this.persistQueue.then(() => this.checked(() => atomicJSON(this.file, snapshot))); this.persistQueue = next.catch(() => {}); return next; }
  workspaceFor(session) { return this.ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(session.id) || w.path === session.header.cwd); }
  settings(session) { const workspace = this.workspaceFor(session); return validateSettings(this.data.workspaces[workspace?.id ?? session.header.cwd]?.settings ?? {}); }
  async updateSettings(workspaceId, input) {
    return this.inOrder(async () => {
      if (!this.ctx.workspaceRegistry.get(workspaceId)) throw new WorkbenchError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
      const settings = validateSettings(input); await this.checked(() => validateWorkspaceModel(this.ctx, input));
      const overrides = Object.fromEntries(Object.keys(input).map(key => [key, settings[key]]));
      const previous = this.data.workspaces[workspaceId];
      this.data.workspaces[workspaceId] = { settings: overrides, at: Date.now() };
      try { await this.save(); } catch (error) { if (previous === undefined) delete this.data.workspaces[workspaceId]; else this.data.workspaces[workspaceId] = previous; throw error; }
      return settings;
    });
  }
  async applyDefaults(agent, source) {
    this.execution.assertUnchanged();
    if (source !== 'startup' || agent.session.header.origin === 'subagent' || agent.session.header.isSeeded || this.data.modelPreferences?.[agent.id]) return;
    const settings = this.settings(agent.session);
    // Deliberately do not save the selection as the account-wide last-used default.
    const selection = await registeredSelection(this.ctx, settings, { defaultEffort: true });
    this.execution.assertUnchanged();
    agent.model.select(selection);
  }
  async allocatePorts() {
    this.execution.assertUnchanged();
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
    return this.execution.assertUnchanged().mode === 'isolated-guest' ? this.ensureIsolatedProject(agent, signal) : this.ensureHostProject(agent, signal);
  }
  independentRecord(record) { return Boolean(record && !record.legacy && !record.nativeWorktree && record.independentRepository === true && record.settings?.projectMode !== 'continue'); }
  async assertIndependentProject(record, ownerId) {
    if (this.execution.assertUnchanged().mode !== 'isolated-guest' || !this.independentRecord(record)) throw new WorkbenchError('PROJECT_RUNTIME_NOT_ISOLATED', 'This conversation needs an independently enrolled project. Existing files are retained.');
    const root = await this.checked(() => fs.realpath(record.root)), base = await this.checked(() => fs.realpath(this.projectsRoot));
    if (root !== record.root || path.dirname(root) !== base) throw new WorkbenchError('PROJECT_RUNTIME_NOT_ISOLATED', 'Project path is not independently enrolled.');
    if (Object.entries(this.data.sessions).some(([id, other]) => id !== ownerId && typeof other.root === 'string' && (within(root, other.root) || within(other.root, root)))) throw new WorkbenchError('PROJECT_RUNTIME_SHARED', 'Project directories overlap.');
    const git = path.join(root, '.git'), info = await this.checked(() => fs.lstat(git));
    if (!info.isDirectory() || info.isSymbolicLink() || await this.checked(() => fs.realpath(git)) !== git) throw new WorkbenchError('PROJECT_RUNTIME_GIT_SHARED', 'Project Git metadata is shared.');
    for (const name of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) {
      try { await this.checked(() => fs.lstat(path.join(git, name))); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new WorkbenchError('PROJECT_RUNTIME_GIT_SHARED', 'Project Git metadata borrows another repository.');
    }
    return root;
  }
  // The existing6b enrollment path is retained as an explicit composition.
  async ensureHostProject(agent, signal) {
    if (this.execution.assertUnchanged().mode !== 'host-compat') throw new WorkbenchError('PROJECT_EXECUTION_MODE_MISMATCH', 'Host enrollment is unavailable in this execution mode.');
    const current = this.ctx.workingDirectory.get(agent.session);
    if (agent.session.header.origin === 'subagent') return { root: current, legacy: true };
    return this.inOrder(async () => {
      let record = this.data.sessions[agent.id];
      if (record) {
        if (!this.grants.has(agent.id) && !within(agent.session.header.cwd, record.root)) this.grants.set(agent.id, this.ctx.sandboxPolicy.registerWritableRoot(agent.session, record.root));
        if (current !== record.root) await this.checked(() => this.ctx.workingDirectory.set(agent, record.root, signal));
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
          repository = (await this.checked(() => run('git', ['-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', 'rev-parse', '--show-toplevel'], options))).stdout.trim();
          baseCommit = (await this.checked(() => run('git', ['-c', 'protocol.allow=never', 'rev-parse', '--verify', (settings.baseCommit ?? 'HEAD') + '^{commit}'], options))).stdout.trim();
          await this.checked(() => run('git', ['-c', 'protocol.allow=never', 'rev-list', '--objects', '--missing=error', baseCommit, '--'], options));
        } catch (error) { this.execution.assertUnchanged(); if (settings.projectMode === 'worktree') throw new WorkbenchError('COMMIT_REQUIRED', 'Existing projects require an available local Git commit before creating a worktree.'); }
      }
      if (repository && !baseCommit) throw new WorkbenchError('COMMIT_REQUIRED', 'Commit the existing repository before creating an isolated checkout.');
      let root, branch, nativeWorktree = false;
      if (repository && baseCommit) {
        const result = await this.checked(() => this.ctx.worktrees.create(agent, { from: baseCommit }, signal));
        root = result.path; branch = result.branch; baseCommit = result.baseCommit; nativeWorktree = true;
      } else if (settings.projectMode === 'continue') root = await this.checked(() => fs.realpath(current));
      else {
        root = path.join(this.projectsRoot, agent.id.replace(/[^a-zA-Z0-9_-]/gu, '_'));
        await this.checked(() => fs.mkdir(root, { mode: 0o700 }));
        this.grants.set(agent.id, this.ctx.sandboxPolicy.registerWritableRoot(agent.session, root));
        await this.checked(() => this.ctx.workingDirectory.set(agent, root, signal));
      }
      const ports = await this.checked(() => this.allocatePorts()), databasePath = path.join(root, '.harness', 'data', 'app.sqlite');
      let gitWritableRoots;
      if (nativeWorktree) {
        const gitOptions = { cwd: root, timeout: 10000, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } };
        const gitDir = await this.checked(async () => fs.realpath((await this.checked(() => run('git', ['rev-parse', '--absolute-git-dir'], gitOptions))).stdout.trim()));
        const common = await this.checked(async () => fs.realpath(path.resolve(root, (await this.checked(() => run('git', ['rev-parse', '--git-common-dir'], gitOptions))).stdout.trim())));
        // Commit metadata only; never grant the source checkout, hooks or config.
        gitWritableRoots = [gitDir];
        for (const part of ['objects', 'refs', 'logs']) { const candidate = path.join(common, part); try { gitWritableRoots.push(await this.checked(() => fs.realpath(candidate))); } catch { this.execution.assertUnchanged(); } }
      }
      await this.checked(() => fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 }));
      if (settings.projectMode !== 'continue') {
        const ignore = path.join(root, '.gitignore'), before = await this.checked(() => fs.readFile(ignore, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }));
        if (!before.split(/\r?\n/u).includes('.harness/')) await this.checked(() => fs.writeFile(ignore, before + (before.endsWith('\n') || !before ? '' : '\n') + '\n# Private Harness runtime state\n.harness/\n'));
      }
      record = { root, sourceRoot: current, workspaceId: workspace?.id, ports, databasePath, baseCommit, branch, nativeWorktree, gitWritableRoots, at: Date.now(), settings };
      this.data.sessions[agent.id] = record; this.budgets.set(agent.id, new RepairBudget()); await this.save();
      await this.checked(() => atomicJSON(path.join(root, '.harness', 'project.json'), { sessionId: agent.id, ports, databasePath, baseCommit, root }));
      // Change tracking is optional: a full source baseline must never prevent
      // the user's project from starting when disk reserve is unavailable.
      try { await this.checked(() => this.changes.initialize(agent.id, record, { projectCreated: true, signal })); }
      catch (error) { this.execution.assertUnchanged(); this.ctx.logger?.warn('Change baseline unavailable: ' + (error.code ?? 'CHANGES_UNAVAILABLE')); }
      this.pendingNotices.set(agent.id, notice(`Project isolation is ready. Work only in ${JSON.stringify(root)}. ${baseCommit ? `Source commit: ${baseCommit}; source checkout and uncommitted files were not copied or changed.` : 'This independent task has a new empty project.'} App/API/test ports: ${ports.join(', ')}. Use the project-specific database ${JSON.stringify(databasePath)}; never reuse another project database. bash and project_exec use the same confined foreground project executor and export PORT, API_PORT, DATABASE_URL and the prepared tool paths. Read-only permissions stay read-only. For a temporary server, use run_in_background:true and keep its registry-issued job ID; inspect it with job_output and stop only that owned job with job_kill. Do not use nohup, setsid, pkill or killall for project process management. Run milestone verification in the foreground so its real completion is recorded. Browser: /data/harness/dev/browser/node_modules/playwright; doctor: /data/harness/app/development/doctor.cjs; quality contract documentation: /data/harness/app/quality/README.md. Declare .harness-quality.json early and use verify_project for build/test/browser/acceptance milestones. Browser checks require navigation, positive UI assertions and screenshots. Passing unit tests alone is not completion. Work in small milestones. After ${settings.maxStageSteps} steps the controller automatically checks the declared project contract; ordinary failures receive a bounded repair window. Step and check counts record actual work and never require another approval by themselves. Repeated errors without progress stop with retained files and a concrete diagnostic.`));
      return record;
    });
  }
  async ensureIsolatedProject(agent, signal) {
    if (this.execution.assertUnchanged().mode !== 'isolated-guest') throw new WorkbenchError('PROJECT_EXECUTION_MODE_MISMATCH', 'Guest enrollment requires isolated mode.');
    const current = this.ctx.workingDirectory.get(agent.session);
    if (agent.session.header.origin === 'subagent') return { root: current, legacy: true };
    return this.inOrder(async () => {
      let record = this.data.sessions[agent.id];
      if (record) {
        if (!this.independentRecord(record)) return record; // Retain existing host records without granting, copying or relabeling.
        await this.assertIndependentProject(record, agent.id);
        if (!this.grants.has(agent.id) && !within(agent.session.header.cwd, record.root)) this.grants.set(agent.id, this.ctx.sandboxPolicy.registerWritableRoot(agent.session, record.root));
        if (current !== record.root) await this.checked(() => this.ctx.workingDirectory.set(agent, record.root, signal));
        return record;
      }
      const createdAt = typeof agent.session.header.createdAt === 'number' ? agent.session.header.createdAt : Date.parse(agent.session.header.createdAt);
      if (this.existing.has(agent.id) || !Number.isFinite(createdAt) || createdAt < this.data.installedAt) {
        record = { root: current, sourceRoot: current, legacy: true, at: Date.now() };
        this.data.sessions[agent.id] = record; this.budgets.set(agent.id, new RepairBudget()); await this.save(); return record;
      }
      const settings = this.settings(agent.session), workspace = this.workspaceFor(agent.session);
      let root, branch, baseCommit, sourceCommit, independentRepository = false;
      const nativeWorktree = false;
      if (settings.projectMode === 'continue') {
        root = await this.checked(() => fs.realpath(current));
        record = { root, sourceRoot:current, workspaceId:workspace?.id, nativeWorktree:false, independentRepository:false, at:Date.now(), settings };
        this.data.sessions[agent.id] = record; this.budgets.set(agent.id, new RepairBudget()); await this.save();
        return record;
      } else {
        ({ root, branch, baseCommit, sourceCommit, independentRepository } = await this.checked(() => createIndependentProject({ projectsRoot: this.projectsRoot, sessionId: agent.id, sourceRoot: current, mode: settings.projectMode, baseCommit: settings.baseCommit, signal })));
      }
      const ports = await this.checked(() => this.allocatePorts()), databasePath = path.join(root, '.harness', 'data', 'app.sqlite');
      await this.checked(() => fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 }));
      record = { root, sourceRoot: current, workspaceId: workspace?.id, ports, databasePath, baseCommit, sourceCommit, branch, independentRepository, nativeWorktree, at: Date.now(), settings };
      await this.checked(() => atomicJSON(path.join(root, '.harness', 'project.json'), { sessionId: agent.id, ports, databasePath, baseCommit, root }));
      // Change tracking is optional: a full source baseline must never prevent
      // the user's project from starting when disk reserve is unavailable.
      // Capture Git while this fresh independent root is still unpublished:
      // neither an executor nor the editor may mutate its object store yet.
      try { await this.checked(() => this.changes.initialize(agent.id, record, { projectCreated: true, signal })); }
      catch (error) { this.execution.assertUnchanged(); this.ctx.logger?.warn('Change baseline unavailable: ' + (error.code ?? 'CHANGES_UNAVAILABLE')); }
      this.data.sessions[agent.id] = record; this.budgets.set(agent.id, new RepairBudget()); await this.save();
      if (independentRepository) {
        this.grants.set(agent.id, this.ctx.sandboxPolicy.registerWritableRoot(agent.session, root));
        await this.checked(() => this.ctx.workingDirectory.set(agent, root, signal));
      }
      this.pendingNotices.set(agent.id, notice(`Project files are prepared. Command and editor readiness are checked separately when requested. Work only in ${JSON.stringify(root)}. ${sourceCommit ? `Source commit: ${sourceCommit}; independent shallow Git baseline, with no borrowed object store. Source checkout and uncommitted files were not copied or changed.` : independentRepository ? 'This independent task has a new empty Git repository and an initial commit.' : 'This conversation retains its selected existing directory; commands require an independently enrolled project.'} App/API/test ports: ${ports.join(', ')}. Use the project-specific database ${JSON.stringify(databasePath)}; never reuse another project database. bash and project_exec require the same isolated guest executor, where this project is mounted at /workspace and DATABASE_URL=file:/workspace/.harness/data/app.sqlite. PORT, API_PORT and TEST_PORT use the assigned values. If runtime admission or prepared tools are unavailable, report the diagnostic and retain the files. Read-only permissions stay read-only. For a temporary server, use run_in_background:true and keep its registry-issued job ID; inspect it with job_output and stop only that owned job with job_kill. Do not use nohup, setsid, pkill or killall for project process management. Run milestone verification in the foreground so its real completion is recorded. When the immutable guest toolchain is available, its quality contract documentation is /opt/homeai/quality/README.md. Declare .harness-quality.json early and use verify_project for build/test/browser/acceptance milestones. Browser checks require navigation, positive UI assertions and screenshots. Passing unit tests alone is not completion. Work in small milestones. After ${settings.maxStageSteps} steps the controller automatically checks the declared project contract; ordinary failures receive a bounded repair window. Step and check counts record actual work and never require another approval by themselves. Repeated errors without progress stop with retained files and a concrete diagnostic.`));
      return record;
    });
  }
  async preStep({ agent, signal, turn, step, messages }) {
    const executionAgent = agent, initiator = agent.id, accessSession = agent.session; agent = this.ownerAgent(agent);
    await this.drainToolResults(agent.id);
    if (this.data.trash[agent.id]) throw new WorkbenchError('SESSION_IN_TRASH', 'Restore this conversation before continuing.');
    const record = await this.ensureProject(agent, signal);
    if (!record.legacy && this.environmentReady) {
      const environment = await this.checked(() => this.environmentReady), kind = this.settings(agent.session).environment;
      if (kind === 'web' && !environment.browser?.ok || kind === 'dotnet' && !environment.dotnet?.available) throw new WorkbenchError('ENVIRONMENT_UNAVAILABLE', 'Prepared environment preflight failed. Open Workspace → Environment; do not install replacements.', 503);
    }
    this.execution.assertUnchanged(); await this.locks.acquire(record.root, agent.id);
    try { this.execution.assertUnchanged(); } catch (error) { await this.locks.release(agent.id); throw error; }
    this.running.set(agent.id, record.root);
    await this.checked(() => this.ensureRestoreRecovered(agent.id, record.root));
    const budget = this.budgets.get(agent.id), settings = this.settings(agent.session);
    // Do not replace a request's accounting while one of its child steps is
    // still completing a verification through the owner-scoped observer.
    const pendingReview = this.automaticReviews.get(agent.id);
    if (pendingReview) { try { await pendingReview; } catch (error) { if (signal?.aborted) throw error; } }
    signal?.throwIfAborted(); this.execution.assertUnchanged();
    await this.reconcileAutomatic(agent.id);
    if(['dispatching','unknown'].includes(budget.automatic?.continuation?.state)&&budget.automatic.recovery?.canContinue!==true)throw new WorkbenchError('AUTOMATIC_CONTINUATION_UNCONFIRMED','The recorded continuation has no confirmed durable acceptance. It will not be submitted again.');
    const effective = { ...DEFAULTS, ...settings }, freshHuman = prepareAutomaticRequest(record, budget, { turn, messages, owner: initiator === agent.id }, effective.maxStageSteps);
    if (initiator === agent.id && beginUserRequest(record, budget, { turn, messages })) {
      delete record.stageBudgetWarningStage; delete record.stageBudgetWarningInspection;
    }
    const stepKey = `${initiator}:${turn}:${step}`;
    if (!Object.hasOwn(budget.automatic.admitted, stepKey)) {
      let review = this.automaticReviews.get(agent.id);
      if (!review) {
        review = automaticReview(this, { agent, executionAgent, signal }, record, budget, effective, freshHuman);
        this.automaticReviews.set(agent.id, review);
      }
      try { await review; this.execution.assertUnchanged(); } finally { if (this.automaticReviews.get(agent.id) === review) this.automaticReviews.delete(agent.id); }
      if (!Object.hasOwn(budget.automatic.admitted, stepKey) && admitAutomaticStep(budget, effective)) { budget.automatic.admitted[stepKey] = true; record.lastStep = stepKey; }
    }
    await this.checked(() => guideFirstCheck(this, agent, record, budget, signal));
    record.budget = budget; await this.save();
    if (budget.blocked) throw new WorkbenchError(budget.blocked.code, budget.blocked.message + ' Files and verification results are retained. See Workspace → Run review for details.');
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
    const isolated = this.execution.assertUnchanged().mode === 'isolated-guest';
    const id = exec.agent?.id; if (!id) return;
    const blocked = this.budgets.get(id)?.blocked;
    if (this.data.trash[id] || blocked) return { reason: blocked?.message ?? 'Conversation is in Trash.', info: { code: blocked?.code ?? 'SESSION_IN_TRASH' } };
    const record = this.data.sessions[id];
    if (isolated && ['bash', 'project_exec', 'exec_command', 'terminal'].includes(exec.name) && !this.independentRecord(record)) return { reason: 'Model commands require an independently enrolled project; existing files are retained.', info: { code: 'PROJECT_RUNTIME_NOT_ISOLATED' } };
    if (isolated && (['exec_command', 'terminal'].includes(exec.name) || exec.name === 'bash' && !exec.managedProjectShell)) return { reason: 'Managed commands require the installed guest executor; host execution is refused.' };
    if (!record) return;
    // Capture admitted operation identity before execution; queued/concurrent
    // results must never borrow another call's target or current directory.
    if (typeof exec.callId === 'string') {
      this.operationScopes ??= new Map();
      const key = id + '\0' + exec.callId;
      if (!this.operationScopes.has(key)) try { this.operationScopes.set(key, operationFingerprint(exec, record.root)); }
      catch { this.ctx.logger?.warn('Tool operation identity unavailable.'); }
    }
    if (!record.legacy && (['exec_command', 'terminal'].includes(exec.name) || exec.name === 'bash' && !exec.managedProjectShell)) return { reason: 'Managed commands require the installed project executor; unconfined execution is refused.' };
    const args = exec.arguments;
    if (args && ['write', 'edit', 'apply_patch', 'delete_file', 'bash'].includes(exec.name)) {
      const value = args.file_path ?? args.path ?? args.workdir;
      if (typeof value === 'string' && !within(record.root, path.resolve(record.root, value))) return { reason: 'Write/command target is outside this isolated project. Use a read tool to inspect source material.' };
      const patch = args.patch ?? args.input;
      if (exec.name === 'apply_patch' && typeof patch === 'string') for (const line of patch.split('\n')) { const match = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/u.exec(line); if (match && !within(record.root, path.resolve(record.root, match[1]))) return { reason: 'Patch target is outside this isolated project.' }; }
    }
  }
  // The SDK final observer sees every outcome, including schema/guard failures
  // and post-execute policy decisions. It cannot alter the authoritative result.
  // Serialize bookkeeping per project and drain it before the next model step.
  observeToolResult(exec, result) {
    const id = exec.agent?.id; if (!id) return;
    const key = typeof exec.callId === 'string' ? id + '\0' + exec.callId : null;
    let operationScope = key ? this.operationScopes?.get(key) : undefined;
    if (key) this.operationScopes?.delete(key);
    if (!operationScope) try { operationScope = operationFingerprint(exec, this.data.sessions[id]?.root); }
    catch { this.ctx.logger?.warn('Tool operation identity unavailable.'); }
    const captured = { ...exec, operationScope };
    const work = (this.resultWork.get(id) ?? Promise.resolve()).then(() => this.toolResult(captured, result)).catch(error => {
      this.ctx.logger?.warn('Tool diagnostic bookkeeping unavailable: ' + (error.code ?? 'DIAGNOSTIC_UNAVAILABLE'));
    });
    this.resultWork.set(id, work);
    void work.then(() => { if (this.resultWork.get(id) === work) this.resultWork.delete(id); });
  }
  async drainToolResults(id) { await this.resultWork.get(id); }
  async toolResult(exec, result, verificationKind, receipt) {
    const id=exec.agent?.id,record = this.data.sessions[id]; if (!record) return;
    const automatic=this.budgets.get(id)?.automatic;
    if(exec.name==='verify_project'&&automatic?.accountedCallId===exec.callId)return;
    if(!receipt&&automaticReceipt(this,exec,result)){
      record.budget=this.budgets.get(id);await this.save();
      if(exec.signal?.aborted||automatic.uncertain||automatic.operation.rangeRequired&&(!automatic.operation.rangeQualified||!automatic.operation.rangeSettled))return;
    }
    if(exec.signal?.aborted)return;
    if(receipt&&receipt!==automatic?.receipt)throw new WorkbenchError('AUTOMATIC_TERMINAL_RECEIPT_MISMATCH','Reconciliation requires the retained final observer receipt.');
    const structured = exec.name === 'verify_project', value = result.value;
    // A registry-issued acknowledgement means work is still running. It is
    // neither failed verification nor a stage pass; inspect the owned job and
    // use foreground verification for a completed project milestone.
    if (!result.isError && ['bash', 'project_exec'].includes(exec.name) && value?.kind === 'background' && typeof value.jobId === 'string') return;
    let operationScope = exec.operationScope;
    if (!operationScope) try { operationScope = operationFingerprint(exec, record.root); } catch {}
    const command = exec.arguments?.command, kind = verificationKind ?? (structured ? exec.arguments?.kind ?? 'all' : exec.name === 'stage_check' ? 'test' : validationKind(command));
    const exitCode = structured && typeof value?.passed === 'boolean' ? value.passed ? 0 : 1 : value?.exitCode;
    const rendered = result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') ?? result.error?.message ?? '';
    // Display compaction may omit the test totals. Use the executor's existing
    // bounded streams for accounting; never reopen an output/spill path.
    const streams = ['bash', 'project_exec', 'exec_command', 'terminal'].includes(exec.name)
      ? [value?.stdout, value?.stderr].map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean)
      : [];
    const text = [rendered, ...streams].join('\n');
    const input = { kind, exitCode, text, isError: result.isError, timedOut: value?.timedOut, aborted: value?.aborted, errorCode: result.error?.info?.code };
    const recovery = structured ? classifyVerificationOutcome(value, input) : classifyToolOutcome(input);
    if (recovery.category === 'cancelled') return;
    if (structured && record.lastVerification) record.lastVerification.accepted = !recovery.failed && value?.passed === true && !value?.stale;
    if (recovery.failed) {
      const diagnostics = this.pendingDiagnostics.get(exec.agent.id) ?? new Map();
      diagnostics.set(recovery.code, recoveryContext(recovery));
      while (diagnostics.size > 4) diagnostics.delete(diagnostics.keys().next().value);
      this.pendingDiagnostics.set(exec.agent.id, diagnostics);
      record.lastDiagnostic = { code: recovery.code, category: recovery.category, at: Date.now() };
    }
    if (!kind && !recovery.failed) {
      const commandTool = ['bash', 'project_exec', 'exec_command', 'terminal'].includes(exec.name);
      const jobTool = ['job_output', 'job_list', 'job_kill'].includes(exec.name), job = value?.job ?? value;
      const completed = !result.isError && !result.error && !value?.timedOut && !value?.aborted
        && (!commandTool || value?.exitCode === 0 && value?.signal == null && !value?.sandbox?.denied && !value?.sandbox?.runnerFailed)
        && (!jobTool || job?.status === 'completed' && job?.result?.exitCode === 0);
      const budget = this.budgets.get(exec.agent.id);
      if (completed && budget?.resolveOperation?.(operationScope)) { record.budget = budget; await this.save(); }
      return;
    }
    // A shell pipeline can hide the real check exit code. It cannot earn a pass.
    const managedCommand = exec.name === 'project_exec' || exec.managedProjectShell;
    const observedCommand = managedCommand ? normalizeVerificationCommand(command).command : command;
    if (kind && !structured && typeof command === 'string' && exitCode === 0 && verificationStatusMayBeMasked(observedCommand)) {
      const diagnostics = this.pendingDiagnostics.get(exec.agent.id) ?? new Map();
      diagnostics.set('VERIFICATION_STATUS_UNAVAILABLE', recoveryContext({ category: 'tool-error', code: 'VERIFICATION_STATUS_UNAVAILABLE' }));
      while (diagnostics.size > 4) diagnostics.delete(diagnostics.keys().next().value);
      this.pendingDiagnostics.set(exec.agent.id, diagnostics);
      record.lastDiagnostic = { code: 'VERIFICATION_STATUS_UNAVAILABLE', category: 'tool-error', at: Date.now() };
      // Execution still returned its actual result. Do not invent a verifier
      // exit code, pass a stage or charge an unknown result as a failed repair.
      return;
    }
    if (!kind) {
      const budget = this.budgets.get(exec.agent.id);
      budget.observe({ exitCode, text, isError: result.isError, recovery, operationScope }, this.settings(exec.agent.session).noProgressLimit);
      record.budget = budget; await this.save(); return;
    }
    let manifest;
    if (recovery.verification) try { manifest = await sourceManifest(record.root, { signal: exec.signal }); } catch (error) { record.checkpointError = error.code ?? 'CHECKPOINT_FAILED'; }
    if(exec.signal?.aborted)return;
    const proofHash = structured ? value?.stale === false && value?.sourceHash === manifest?.sha256 && (!automatic?.activeCallId||automatic.activeCallId!==exec.callId||automatic.operation?.sourceHash===value.sourceHash) ? manifest?.sha256 : undefined
      : this.budgets.get(exec.agent.id)?.automatic ? undefined : manifest?.sha256;
    if (structured && record.lastVerification && !proofHash) record.lastVerification.accepted = false;
    const budget = this.budgets.get(exec.agent.id), decision = budget.observe({ kind, exitCode, text, isError: result.isError, recovery, operationScope, manifestHash: proofHash }, this.settings(exec.agent.session).noProgressLimit);
    if (budget.automatic && !structured && recovery.verification && !recovery.failed) {
      const diagnostics = this.pendingDiagnostics.get(exec.agent.id) ?? new Map();
      if (diagnostics.size < 4 || diagnostics.has('VERIFICATION_SOURCE_UNBOUND')) diagnostics.set('VERIFICATION_SOURCE_UNBOUND', '[Harness: source binding unavailable] The foreground check returned its actual success, but shell execution has no trusted before/after source proof. Its output is retained and no stage was renewed. Use source-bound verify_project for canonical stage verification.');
      this.pendingDiagnostics.set(exec.agent.id, diagnostics);
    }
    if (budget.automatic && typeof exec.callId === 'string' && budget.automatic.activeCallId === exec.callId) {budget.automatic.lastAutomaticOutcome = { callId: exec.callId, verifiedProgress: decision.verifiedProgress === true, failed: recovery.failed, sourceHash: proofHash };budget.automatic.accountedCallId=exec.callId;}
    if (decision.improved && manifest && (!budget.automatic || proofHash)) {
      try {
        const saved = await saveCheckpoint(record.root, path.join(this.root, 'checkpoints', exec.agent.id, 'best'), manifest);
        record.checkpoints ??= {}; record.checkpoints[decision.key] = { path: saved, score: decision.score, at: Date.now(), files: Object.keys(manifest.files).length, sha256: manifest.sha256 };
      } catch (error) { record.checkpointError = error.code ?? 'CHECKPOINT_FAILED'; }
    }
    record.budget = budget; await this.save();
    await this.pruneCheckpoints(exec.agent.id);
  }
  async pruneCheckpoints(id) {
    const directory = path.join(this.root, 'checkpoints', id), record = this.data.sessions[id];
    const recovery = await this.checkpointRecovery(id);
    const keep = new Set([...Object.values(record.checkpoints ?? {}).map(c => c.path), record.beforeRestore, recovery.beforeRestore?.path].filter(Boolean));
    // Bound our own superseded cache generations; never touch project files.
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^(?:best|before-restore)\.[a-f0-9-]{36}$/u.test(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (!keep.has(candidate)) await fs.rm(candidate, { recursive: true, force: true });
    }
  }
  async review(id) {
    const agent = this.ctx.agents.get(id), owner = agent ? this.ownerAgent(agent) : undefined, record = this.data.sessions[owner?.id ?? id];
    if (!record) return undefined;
    const restoreRecovery = await this.checkpointRecovery(owner?.id ?? id); const manifest = restoreRecovery.pending ? null : await sourceManifest(record.root);
    return { root: record.root, legacy: Boolean(record.legacy), sourceHash: manifest?.sha256 ?? null, restoreRecovery, beforeRestore: record.beforeRestoreInfo ?? restoreRecovery.beforeRestore, budget: record.budget, checkpoints: record.checkpoints, ports: record.ports, databasePath: record.databasePath };
  }
  reconcileAutomatic(id){return reconcileAutomatic(this,id);}
  retainAutomaticProcess(value){return retainAutomaticProcess(this,value);}
  async runRecoveryVerification(id){
    const agent=this.ctx.agents.get(id),record=this.data.sessions[id],budget=this.budgets.get(id),a=budget?.automatic;
    if(!agent||agent.status!=='idle'||this.ownerAgent(agent)!==agent||a?.legacyRecovery?.verificationState!=='required'||this.automaticInFlight?.has(id)||this.automaticReviews.has(id)||!Array.isArray(agent.inbox?.nextTurn)||!Array.isArray(agent.inbox?.nextStep)||agent.inbox.nextTurn.length||agent.inbox.nextStep.length)return;
    if(!Number.isSafeInteger(a.nextCheckAt)||a.nextCheckAt>a.taskSteps){a.recovery={state:'blocked',code:'AUTOMATIC_LEGACY_CHECK_NOT_DUE',canContinue:false};return;}
    await this.checked(()=>this.locks.acquire(record.root,id));
    if(this.data.sessions[id]!==record||this.budgets.get(id)!==budget||agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length)return;
    this.running.set(id,record.root);
    const review=automaticReview(this,{agent,executionAgent:agent,signal:new AbortController().signal},record,budget,{...DEFAULTS,...this.settings(agent.session)},false);
    this.automaticReviews.set(id,review);
    try{await review;}finally{if(this.automaticReviews.get(id)===review)this.automaticReviews.delete(id);}
  }
  async automaticReconcile(id){
    const agent=this.ctx.agents.get(id),record=this.data.sessions[id];
    if(!agent||!record||this.ownerAgent(agent)!==agent||this.data.trash[id])throw new WorkbenchError('AUTOMATIC_OWNER_REQUIRED','A managed owner conversation is required.',409);
    const continued=await this.reconcileAutomatic(id);
    return {automatic:this.budgets.get(id)?.automatic,blocked:this.budgets.get(id)?.blocked??null,continued:continued===true};
  }
  async reportVerification(report) {
    const agent = this.ctx.agents.get(report.sessionId); if (!agent) throw new WorkbenchError('SESSION_NOT_LIVE', 'A live conversation is required to record verification.');
    if (!['test', 'build', 'browser', 'acceptance', 'all'].includes(report.kind) || !Number.isInteger(report.exitCode)) throw new WorkbenchError('INVALID_VERIFICATION', 'Invalid structured verification result.', 400);
    const owner = this.ownerAgent(agent), record = this.data.sessions[owner.id]; if (!record) throw new WorkbenchError('PROJECT_NOT_READY', 'Project isolation is not ready.');
    if (report.sourceHash && (await sourceManifest(record.root)).sha256 !== report.sourceHash) throw new WorkbenchError('STALE_VERIFICATION', 'The source changed during verification; stale evidence cannot pass a stage.');
    // The final SDK outcome is authoritative for the single repair budget.
    // This internal report only records source-checked evidence; an admission or
    // final policy failure must never be counted twice or earn a stage pass.
    record.lastVerification = { kind: report.kind, exitCode: report.exitCode, at: Date.now(), sourceHash: report.sourceHash, checksPassed: report.checksPassed, checksTotal: report.checksTotal, accepted: false }; await this.save();
  }
  async releaseIfIdle(id) {
    const automatic = this.budgets?.get(id)?.automatic;
    if (this.automaticInFlight?.has(id) || automatic?.uncertain && !automatic.terminalAcknowledged) return; // Preserve leases through a crash or unacknowledged SDK work.
    await this.drainToolResults(id);
    if (this.ctx.agents.get(id)?.status === 'running') return;
    const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
    if (activity.length) return;
    await this.locks.release(id); this.running.delete(id);
  }
  async reviewResume(id, strategy) {
    const record = this.data.sessions[id], agent = this.ctx.agents.get(id);
    if (!record || !agent || agent.status === 'running') throw new WorkbenchError('SESSION_BUSY', 'Open an idle managed conversation before resuming.');
    const budget = this.budgets.get(id), settings = { ...DEFAULTS, ...this.settings(agent.session) };
    prepareAutomaticRequest(record, budget, {}, settings.maxStageSteps);
    if (budget.automatic.uncertain || this.automaticInFlight?.has(id)) throw new WorkbenchError('AUTOMATIC_VERIFICATION_UNCERTAIN', 'A verification has no reconciled completion. Review cannot clear its unknown-operation fence.');
    budget.resume(strategy);
    if (settings.maxAutomaticChecks > 0) budget.automatic.nextCheckAt = budget.automatic.taskSteps;
    record.budget = budget; record.lastStep = null; await this.save();
    agent.followup(notice('The owner reviewed the paused run and chose this revised approach: ' + strategy + '. Continue the existing task in the isolated project and verify a small stage first.'));
  }
  restoreLocations(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new WorkbenchError('INVALID_SESSION', 'Invalid conversation.', 400); return { stateRoot: path.join(this.root, 'restores', id), checkpointRoot: path.join(this.root, 'checkpoints', id) }; }
  async checkpointRecovery(id) {
    if (!this.data.sessions[id]) throw new WorkbenchError('PROJECT_NOT_READY', 'Project is not registered.');
    return checkpointRecoveryStatus(this.restoreLocations(id).stateRoot);
  }
  async ensureRestoreRecovered(id, root) {
    const record = this.data.sessions[id]; if (!record) return;
    if (record.root && await fs.realpath(record.root) !== await fs.realpath(root)) throw new WorkbenchError('PROJECT_CHANGED', 'Project registration changed.');
    const status = await this.checkpointRecovery(id);
    if (status.pending && (await recoverCheckpointRestore(root, this.restoreLocations(id))).pending) throw new WorkbenchError('RESTORE_RECOVERY_REQUIRED', 'Recovery must complete before project work.');
  }
  async checkpointForRestore(id, key) {
    const record = this.data.sessions[id];
    const checkpoint = key === 'beforeRestore' ? (await this.checkpointRecovery(id)).beforeRestore ?? record?.beforeRestoreInfo
      : record?.checkpoints && Object.hasOwn(record.checkpoints, key) ? record.checkpoints[key] : undefined;
    if (!checkpoint || !within(path.join(this.root, 'checkpoints', id), checkpoint.path)) throw new WorkbenchError('CHECKPOINT_NOT_FOUND', 'Checkpoint not found.', 404);
    return checkpoint;
  }
  async previewCheckpointRestore(id, key, signal) {
    const checkpoint = await this.checkpointForRestore(id, key);
    return this.withFiles(id, async root => {
      const recovery = await this.checkpointRecovery(id);
      if (recovery.pending) return { recoveryRequired: true, recovery };
      return { ...await previewCheckpointRestore(root, checkpoint.path, { expectedHash: checkpoint.sha256, signal }), recovery };
    });
  }
  async recoverCheckpoint(id) {
    return this.withFiles(id, async root => { await this.ensureRestoreRecovered(id, root); return this.checkpointRecovery(id); }, true);
  }
  async restoreCheckpoint(id, key, signal, { expectedSourceHash } = {}) {
    const record = this.data.sessions[id], checkpoint = await this.checkpointForRestore(id, key);
    return this.withFiles(id, async root => {
      if (this.data.sessions[id] !== record) throw new WorkbenchError('PROJECT_CHANGED', 'Project registration changed.');
      return restoreCheckpointTransaction(root, checkpoint.path, { ...this.restoreLocations(id), expectedHash: checkpoint.sha256, expectedSourceHash, signal,
        onPrepared: async info => { record.beforeRestore = info.path; record.beforeRestoreInfo = info; await this.save(); } });
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
    this.execution.assertUnchanged();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new WorkbenchError('INVALID_SESSION', 'Invalid conversation.', 400);
    const live = this.ctx.sessions.get(id), stored = live ? undefined : await this.checked(() => this.ctx.sessionPersistence.stat(id));
    const header = live?.header ?? stored?.header; if (!header) throw new WorkbenchError('SESSION_NOT_FOUND', 'Conversation not found.', 404);
    return { root: this.data.sessions[id]?.root ?? (live ? this.ctx.workingDirectory.get(live) : header.cwd), live, header };
  }
  async withFiles(id, action, write = false) {
    const project = await this.checked(() => this.projectFor(id)), root = await this.checked(() => fs.realpath(project.root)), owner = '@files:' + crypto.randomUUID();
    if (write) {
      if (!project.live) throw new WorkbenchError('SESSION_NOT_LIVE', 'Open this conversation before editing its files.', 403);
      await this.checked(() => this.releaseIfIdle(id));
      if (project.live && this.ctx.sandboxPolicy.resolve({ session: project.live }).mode === 'read-only') throw new WorkbenchError('READ_ONLY', 'The selected conversation is read-only.', 403);
      await this.locks.acquire(root, owner);
    }
    try {
      this.execution.assertUnchanged();
      if (write) {
        if (this.ctx.sessions.get(id) !== project.live || await this.checked(() => fs.realpath(this.data.sessions[id]?.root ?? project.root)) !== root) throw new WorkbenchError('PROJECT_CHANGED', 'Project or session changed while acquiring its lease.');
        if (this.ctx.sandboxPolicy.resolve({ session: project.live }).mode === 'read-only') throw new WorkbenchError('READ_ONLY', 'The selected conversation is read-only.', 403);
        await this.checked(() => this.ensureRestoreRecovered(id, root));
      }
      return await this.checked(() => action(root, { mode: 'workspace-write', workspaceRoot: root, sessionId: id }));
    }
    finally { if (write) await this.locks.release(owner); }
  }
  async files(id, operation, args, signal) {
    return this.withFiles(id, async (root, policy) => {
      const relative = args.path === '' && operation === 'list' ? '' : relativeFile(args.path);
      const file = await this.checked(() => canonicalInside(root, relative, ['write', 'mkdir', 'upload'].includes(operation)));
      if (operation === 'list') {
        const entries = await fs.readdir(file, { withFileTypes: true }); return { path: relative, entries: entries.filter(e => !['.git', '.harness'].includes(e.name)).slice(0,1000).map(e => ({ name: e.name, directory: e.isDirectory(), symlink: e.isSymbolicLink() })) };
      }
      const target = await this.checked(() => this.ctx.fs.resolve(file, { signal }));
      if (!within(root, this.ctx.fs.processPath(target))) throw new WorkbenchError('OUTSIDE_PROJECT', 'Resolved path is outside the project.', 403);
      if (operation === 'stat') { const info = await this.ctx.fs.stat(target, signal); return { path: relative, version: info?.version, bytes: info?.size }; }
      if (operation === 'read') { const info = await this.ctx.fs.stat(target, signal); if (info?.size > 1024 * 1024) throw new WorkbenchError('TOO_LARGE', 'Use Download for files larger than 1 MiB.', 413); const bytes = await this.ctx.fs.readBytes(target, signal, 1024 * 1024); let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) throw Error('binary'); } catch { throw new WorkbenchError('BINARY_FILE', 'Binary files can be downloaded, renamed or deleted.', 415); } return { path: relative, version: info?.version, text }; }
      if (operation === 'write') {
        if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 1024 * 1024 || args.text.includes('\0')) throw new WorkbenchError('INVALID_TEXT', 'Text exceeds the editor limit.', 413);
        const expected = args.version ? { kind: 'replaceIfVersion', version: args.version } : { kind: 'createIfAbsent' };
        return this.checked(() => this.ctx.fs.writeText(target, args.text, expected, signal, policy));
      }
      if (operation === 'delete') {
        if (!args.version) throw new WorkbenchError('VERSION_REQUIRED', 'Read the current file before deleting it.', 400);
        return this.checked(() => this.ctx.fs.deleteFile(target, { version: args.version }, signal, policy));
      }
      if (operation === 'rename') {
        if (!args.version) throw new WorkbenchError('VERSION_REQUIRED', 'Read the current file before renaming it.', 400);
        const destination = await this.checked(() => canonicalInside(root, relativeFile(args.destination), true)), to = await this.checked(() => this.ctx.fs.resolve(destination, { signal }));
        return this.checked(() => this.ctx.fs.moveFile(target, to, { expectedSource: { version: args.version }, expectedDestination: { kind: 'createIfAbsent' } }, signal, policy));
      }
      if (operation === 'mkdir') { await this.checked(() => fs.mkdir(file, { mode: 0o755 })); return { created: true }; }
      if (operation === 'download') { const data = await this.ctx.fs.readBytes(target, signal, 10 * 1024 * 1024); return { bytes: data, name: path.basename(file) }; }
      if (operation === 'upload') {
        if (typeof args.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(args.base64)) throw new WorkbenchError('INVALID_UPLOAD', 'Expected base64 file content.', 400);
        const data = Buffer.from(args.base64, 'base64'); if (data.length > 4 * 1024 * 1024) throw new WorkbenchError('TOO_LARGE', 'Upload limit is 4 MiB.', 413);
        await this.checked(() => fs.writeFile(file, data, { flag: 'wx', mode: 0o644 })); return { uploaded: true };
      }
      throw new WorkbenchError('UNKNOWN_OPERATION', 'Unknown file operation.', 400);
    }, !['list', 'read', 'stat', 'download'].includes(operation));
  }
  async projectChanges(id, operation = 'list', args = {}, signal) {
    if (this.data.trash[id]) throw new WorkbenchError('SESSION_IN_TRASH', 'Restore the conversation before viewing its changes.', 403);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['path', 'revision', 'diffRevision'].includes(key))) throw new WorkbenchError('INVALID_CHANGES_REQUEST', 'Invalid change request.', 400);
    for (const key of ['revision', 'diffRevision']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(args[key]))) throw new WorkbenchError('INVALID_CHANGES_REQUEST', 'Invalid change revision.', 400);
    const project = await this.projectFor(id), record = this.data.sessions[id] ?? { root: project.root, sourceRoot: project.root, legacy: true };
    const input = { ...record, root: project.root }, options = { ...args, signal, running: this.ctx.agents.get(id)?.status === 'running' };
    if (operation === 'list') return this.changes.list(id, input, options);
    if (operation === 'diff') return this.changes.diff(id, input, options);
    throw new WorkbenchError('UNKNOWN_OPERATION', 'Unknown change operation.', 400);
  }
}

