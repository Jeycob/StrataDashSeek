'use strict';
const crypto = require('node:crypto');
const { createRuntimePlan } = require('./apps-project-runtime-policy.cjs');
const { createManagedContainer, matches } = require('./apps-container-create.cjs');
const { startManagedContainer } = require('./apps-managed-resources.cjs');
const HEX32 = /^[a-f0-9]{32}$/, TOKEN = /^[A-Za-z0-9_-]{43}$/;
const activeStates = new Set(['admitting', 'ready', 'running', 'stopping', 'reconciliation_required']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = (code, extra = {}) => Object.assign(Error(code), { code, status: 409, ...extra });
const pause = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
const serverName = (scope, generation) => scope + '.' + generation + '.editor.homeai.invalid';
function readyValue(runtime, stopToken) {
  return { version: 1, operationId: runtime.operationId, sessionId: runtime.sessionId, projectRoot: runtime.projectRoot, scopeId: runtime.scopeId, readOnly: runtime.readOnly, generation: runtime.generation, state: 'ready', containerIds: { ...runtime.containerIds }, expiresAt: runtime.expiresAt, hardDeadline: runtime.hardDeadline, transport: { host: '127.0.0.1', hostPort: runtime.guestPort, guestAddress: '10.0.2.15', guestPort: runtime.guestPort, bootPid: runtime.bootPid, serverName: serverName(runtime.scopeId, runtime.generation), mtls: true }, isolation: { enforced: true, sessionId: runtime.sessionId, projectRoot: runtime.projectRoot, readOnly: runtime.readOnly }, stopToken };
}
function active(manager) { return (manager.store?.jobs || []).some(job => activeStates.has(job.projectRuntime?.state)); }

// The model cannot supply paths, mounts, transport addresses, credentials or
// resource settings. Only Native's short-lived authority can mint a plan.
class ProjectRuntime {
  constructor(manager, dependencies = {}) {
    this.manager = manager;
    this.plan = dependencies.plan || createRuntimePlan;
    this.create = dependencies.create || createManagedContainer;
    this.start = dependencies.start || startManagedContainer;
    this.pause = dependencies.pause || pause;
    this.monitors = new Map(); this.stops = new Map();
  }
  save() { this.manager.save(); this.manager.heartbeat(); }
  port(scopeId) {
    const assignments = this.manager.store.projectRuntimePorts ??= {};
    if (Object.values(assignments).some(port => !Number.isInteger(port) || port < 19180 || port > 19243) || new Set(Object.values(assignments)).size !== Object.keys(assignments).length) throw failure('PROJECT_RUNTIME_PORT_REGISTRY_INVALID');
    if (assignments[scopeId] !== undefined) return assignments[scopeId];
    for (let port = 19180; port <= 19243; port++) if (!Object.values(assignments).includes(port)) { assignments[scopeId] = port; this.save(); return port; }
    throw failure('PROJECT_RUNTIME_PORT_POOL_FULL');
  }
  check(input, signal, deadline) {
    if (signal?.aborted || this.manager.serviceClosing || Date.now() >= deadline) throw failure('PROJECT_RUNTIME_ADMISSION_CANCELLED');
    // Re-read both protected Native authority and current source/VM identities.
    return this.plan(this.manager, input);
  }
  async handle(input, { signal } = {}) {
    if (input?.op === 'stop') return this.stop(input);
    if (input?.op === 'touch') return this.touch(input, { signal });
    const m = this.manager;
    m.requireEnabled();
    if (!m.cfg.projectRuntime?.enabled) throw failure('PROJECT_RUNTIME_ISOLATION_UNAVAILABLE');
    if (!input || !['editor', 'executor'].includes(input.kind)) throw failure('PROJECT_RUNTIME_REQUEST_INVALID');
    if (m.busy || active(m)) {
      // Other READY editors and running executors may coexist. Admission and
      // unresolved outcomes remain serialized with the existing Apps journal.
      if (m.busy || m.store.jobs.some(j => ['admitting', 'stopping', 'reconciliation_required'].includes(j.projectRuntime?.state))) throw failure('PROJECT_RUNTIME_BUSY');
    }
    if (m.store.jobs.some(j => j.projectRuntime?.sessionId === input.sessionId && j.projectRuntime?.generation === input.generation)) throw failure('PROJECT_RUNTIME_GENERATION_ALREADY_RECORDED');
    if (m.store.jobs.filter(j => activeStates.has(j.projectRuntime?.state)).length >= 64) throw failure('PROJECT_RUNTIME_ADMISSION_LIMIT');
    m.acceptActivity();
    const admissionId = crypto.randomBytes(16).toString('hex'), deadline = Date.now() + 90000;
    m.setBusy(admissionId);
    let job, stopToken;
    try {
      if (signal?.aborted) throw failure('PROJECT_RUNTIME_ADMISSION_CANCELLED');
      await m.ready();
      let plan = this.check(input, signal, deadline);
      const authority = m.archivedCleanup.authority(input.token), context = authority.runtimeContext;
      stopToken = crypto.randomBytes(32).toString('base64url');
      const runtime = { version: 1, operationId: admissionId, sessionId: input.sessionId, generation: input.generation, scopeId: plan.scopeId, projectRoot: context.projectRoot, readOnly: context.readOnly, kind: input.kind, state: 'admitting', stopTokenHash: hash(stopToken), bootPid: m.worker.pid(), containerIds: {} };
      job = { id: crypto.randomBytes(8).toString('hex'), projectId: plan.projectId, action: 'project-' + input.kind, status: 'running', startedAt: Date.now(), projectRuntime: runtime, creations: [] };
      m.store.jobs.push(job); this.save();
      if (input.kind === 'editor') {
        runtime.guestPort = this.port(plan.scopeId);
        if (typeof m.worker.prepareProjectRuntime !== 'function' || typeof m.worker.projectRuntimeHealth !== 'function') throw failure('PROJECT_RUNTIME_TRANSPORT_UNAVAILABLE');
        const transport = await m.worker.prepareProjectRuntime({ scopeId: plan.scopeId, generation: input.generation, guestRoot: plan.guestRoot, uid: m.cfg.projectRuntime.uid, gid: m.cfg.projectRuntime.gid });
        plan = this.check(input, signal, deadline);
        if (transport?.version !== 1 || transport.mtls !== true || transport.scopeId !== plan.scopeId || transport.generation !== input.generation || transport.serverName !== serverName(plan.scopeId, input.generation)) throw failure('PROJECT_RUNTIME_TRANSPORT_UNVERIFIED');
      }
      const kinds = input.kind === 'editor' ? ['editor', 'relay'] : ['executor'];
      for (const kind of kinds) {
        this.check(input, signal, deadline);
        const current = this.plan(m, input, { guestPort: runtime.guestPort, ...(kind === 'relay' ? { component: 'relay' } : {}) });
        const created = await this.create(m, job, current.body, { runtimeGrant: current.grant, slot: kind, createTimeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())), reconcileMs: 1000 });
        runtime.containerIds[kind] = created.Id; this.save();
        this.check(input, signal, deadline);
        await this.start(m, created.Id, { timeout: Math.max(1, Math.min(15000, deadline - Date.now())) });
        this.check(input, signal, deadline);
      }
      if (input.kind === 'editor') {
        let healthy = false;
        while (Date.now() < deadline) {
          this.check(input, signal, deadline);
          healthy = await m.worker.projectRuntimeHealth({ scopeId: runtime.scopeId, generation: runtime.generation, guestPort: runtime.guestPort, serverName: serverName(runtime.scopeId, runtime.generation), timeoutMs: 2000 });
          this.check(input, signal, deadline);
          if (healthy === true) break;
          await this.pause(250);
        }
        if (!healthy) throw failure('PROJECT_RUNTIME_HEALTH_UNVERIFIED');
        for (const record of job.creations) { const c = await this.owned(job, record); this.check(input, signal, deadline); if (!c.State.Running) throw failure('PROJECT_RUNTIME_EARLY_EXIT'); }
        runtime.state = 'ready'; runtime.expiresAt = Date.now() + 300000; runtime.hardDeadline = Date.now() + 1800000; job.status = 'passed'; job.endedAt = Date.now(); this.save(); this.monitorEditor(job);
        return readyValue(runtime, stopToken);
      }
      runtime.state = 'running'; runtime.expiresAt = Date.now() + 600000; this.save();
      this.monitor(job);
      return { version: 1, operationId: admissionId, jobId: job.id, state: 'running', sessionId: runtime.sessionId, generation: runtime.generation, stopToken };
    } catch (error) {
      if (job) {
        job.error = /^PROJECT_RUNTIME_[A-Z_]+$/.test(error.code || '') ? error.code : 'PROJECT_RUNTIME_ADMISSION_FAILED';
        const stopped = await this.stopOwned(job);
        if (!stopped) throw failure('PROJECT_RUNTIME_RECONCILIATION_REQUIRED', { operationId: admissionId, jobId: job.id });
        job.status = 'failed'; job.endedAt = Date.now(); this.save();
      }
      throw error;
    } finally { if (m.busy === admissionId) m.setBusy(null); }
  }
  async owned(job, record) {
    const c = await this.manager.engine.json('GET', '/containers/' + (record.containerId || record.name) + '/json', { timeout: 3000 });
    if (!matches(record, c) || record.containerId && c.Id !== record.containerId || c.Config?.Labels?.['io.stratadashseek.apps.resource-policy'] !== record.resourcePolicyHash) throw failure('PROJECT_RUNTIME_CONTAINER_IDENTITY_CHANGED');
    return c;
  }
  async stopOwned(job) {
    if (this.stops.has(job.id)) return this.stops.get(job.id);
    const task = this.stopOwnedOnce(job); this.stops.set(job.id, task);
    try { return await task; } finally { this.stops.delete(job.id); }
  }
  async stopOwnedOnce(job) {
    const m = this.manager, runtime = job.projectRuntime;
    runtime.state = 'stopping'; this.save(); let known = true;
    for (const record of job.creations) {
      if (['rejected', 'cleaned'].includes(record.state)) continue;
      // A late create/start can complete after a stop ACK. Preserve that fact;
      // inspecting an instant in time does not reconcile an in-flight request.
      const uncertain = record.state !== 'confirmed' || ['pending', 'unknown'].includes(record.resourceStart?.state);
      if (uncertain) known = false;
      try {
        let c = await this.owned(job, record);
        if (c.State.Running || uncertain) await m.engine.request('POST', '/containers/' + c.Id + '/stop?t=2', { timeout: 5000 });
        c = await this.owned(job, record);
        if (c.State.Running || c.State.Paused || c.State.Restarting || c.State.Dead) known = false;
        else record.runtimeStoppedAt = Date.now();
      } catch { known = false; }
    }
    runtime.state = known ? 'stopped' : 'reconciliation_required';
    if (!known) { job.status = 'recovery_required'; job.error = 'PROJECT_RUNTIME_RECONCILIATION_REQUIRED'; }
    this.save(); return known;
  }
  async stop(input) {
    if (!input || Object.keys(input).some(k => !['op', 'sessionId', 'generation', 'stopToken'].includes(k)) || !HEX32.test(input.generation || '') || !TOKEN.test(input.stopToken || '') || typeof input.sessionId !== 'string') throw failure('PROJECT_RUNTIME_STOP_AUTHORITY_REQUIRED');
    const jobs = this.manager.store.jobs.filter(job => job.projectRuntime?.sessionId === input.sessionId && job.projectRuntime?.generation === input.generation);
    if (jobs.length !== 1 || jobs[0].projectRuntime.stopTokenHash !== hash(input.stopToken)) throw failure('PROJECT_RUNTIME_STOP_AUTHORITY_REQUIRED');
    const job = jobs[0], runtime = job.projectRuntime;
    if (runtime.state === 'admitting') throw failure('PROJECT_RUNTIME_BUSY');
    if (runtime.state !== 'stopped' && !await this.stopOwned(job)) throw failure('PROJECT_RUNTIME_RECONCILIATION_REQUIRED', { operationId: runtime.operationId, jobId: job.id });
    if (job.status === 'running') { job.status = 'interrupted'; job.endedAt = Date.now(); this.save(); }
    return { version: 1, state: 'stopped', sessionId: runtime.sessionId, generation: runtime.generation, operationId: runtime.operationId };
  }
  async touch(input, { signal } = {}) {
    if (!input || Object.keys(input).some(k => !['op', 'sessionId', 'generation', 'stopToken', 'token'].includes(k)) || !HEX32.test(input.generation || '') || !TOKEN.test(input.stopToken || '')) throw failure('PROJECT_RUNTIME_STOP_AUTHORITY_REQUIRED');
    const jobs = this.manager.store.jobs.filter(job => job.projectRuntime?.sessionId === input.sessionId && job.projectRuntime?.generation === input.generation);
    if (jobs.length !== 1 || jobs[0].projectRuntime.stopTokenHash !== hash(input.stopToken)) throw failure('PROJECT_RUNTIME_STOP_AUTHORITY_REQUIRED');
    const runtime = jobs[0].projectRuntime;
    if (runtime.kind !== 'editor' || runtime.state !== 'ready' || runtime.expiresAt <= Date.now() || runtime.hardDeadline <= Date.now()) throw failure('PROJECT_RUNTIME_EDITOR_EXPIRED');
    const request = { op: 'ensure', kind: 'editor', sessionId: input.sessionId, generation: input.generation, token: input.token };
    const deadline = Date.now() + 15000, plan = this.check(request, signal, deadline);
    const context = this.manager.archivedCleanup.authority(input.token).runtimeContext;
    if (plan.scopeId !== runtime.scopeId || context.projectRoot !== runtime.projectRoot || context.readOnly !== runtime.readOnly || this.manager.worker.pid() !== runtime.bootPid) throw failure('PROJECT_RUNTIME_AUTHORITY_REQUIRED');
    for (const record of jobs[0].creations) {
      const c = await this.owned(jobs[0], record); this.check(request, signal, deadline);
      if (!c.State.Running) { await this.stopOwned(jobs[0]); throw failure('PROJECT_RUNTIME_EDITOR_EXPIRED'); }
    }
    if (runtime.state !== 'ready' || runtime.expiresAt <= Date.now() || runtime.hardDeadline <= Date.now()) throw failure('PROJECT_RUNTIME_EDITOR_EXPIRED');
    runtime.expiresAt = Math.min(Date.now() + 300000, runtime.hardDeadline); this.save();
    return readyValue(runtime, input.stopToken);
  }
  monitorEditor(job) {
    const task = (async () => {
      try {
        while (job.projectRuntime.state === 'ready') {
          if (Date.now() >= Math.min(job.projectRuntime.expiresAt, job.projectRuntime.hardDeadline)) { job.error = 'PROJECT_RUNTIME_EDITOR_EXPIRED'; await this.stopOwned(job); return; }
          for (const record of job.creations) { const c = await this.owned(job, record); if (job.projectRuntime.state !== 'ready') return; if (!c.State.Running) { job.error = 'PROJECT_RUNTIME_EARLY_EXIT'; await this.stopOwned(job); return; } }
          await this.pause(1000);
        }
      } catch { if (job.projectRuntime.state !== 'stopped') { job.error = 'PROJECT_RUNTIME_MONITOR_FAILED'; if (await this.stopOwned(job)) { job.status = 'failed'; job.endedAt = Date.now(); this.save(); } } }
    })();
    this.monitors.set(job.id, task); void task.finally(() => this.monitors.delete(job.id));
  }
  monitor(job) {
    const task = (async () => {
      try {
        while (job.projectRuntime.state === 'running') {
          const record = job.creations.find(r => r.slot === 'executor'), c = await this.owned(job, record);
          if (job.projectRuntime.state !== 'running') return;
          const output = await this.manager.engine.runtimeLogs(c.Id, job.projectId);
          if (job.projectRuntime.state !== 'running') return;
          this.manager.replaceJobLog(job, output);
          if (!c.State.Running) {
            if (!Number.isInteger(c.State.ExitCode) || c.State.ExitCode < 0 || c.State.ExitCode > 255 || c.State.Restarting || c.State.Paused || c.State.Dead) throw failure('PROJECT_RUNTIME_EXIT_UNVERIFIED');
            job.exitCode = c.State.ExitCode; job.status = c.State.ExitCode === 0 ? 'passed' : 'failed'; job.endedAt = Date.now(); job.projectRuntime.state = 'stopped'; this.save(); return;
          }
          if (Date.now() >= job.projectRuntime.expiresAt) { job.error = 'PROJECT_RUNTIME_LIFETIME_EXPIRED'; if (await this.stopOwned(job)) { job.status = 'failed'; job.endedAt = Date.now(); this.save(); } return; }
          await this.pause(1000);
        }
      } catch { if (job.projectRuntime.state !== 'stopped') { job.error = 'PROJECT_RUNTIME_MONITOR_FAILED'; if (await this.stopOwned(job)) { job.status = 'failed'; job.endedAt = Date.now(); this.save(); } } }
    })();
    this.monitors.set(job.id, task); void task.finally(() => this.monitors.delete(job.id));
  }
}
function install(AppsManager) {
  AppsManager.prototype.projectRuntime = function(input, options) { return (this.projectRuntimeController ??= new ProjectRuntime(this)).handle(input, options); };
}
module.exports = { ProjectRuntime, active, activeStates, serverName, install };
