import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WorkspaceManager } from './manager.mjs';
import { WorkbenchError, DEFAULTS } from './policy.mjs';
import { createProjectCommandRunner, registerProjectTool } from './project-tool.mjs';
import { createManagedShell } from './managed-shell.mjs';
import { sameRequestOrigin, boundedJSON } from './http.mjs';
import { createRequire } from 'node:module';
import { createRuntimeCapabilities } from './runtime-capabilities.mjs';
import { registerRuntimeCapabilities } from './runtime-tool.mjs';
import { cleanupIdleProjectCaches } from './cache-cleanup.mjs';
import { checkpointOperation } from './checkpoint-api.mjs';
const { doctor } = createRequire(import.meta.url)('../development/doctor.cjs');

export const name = 'workspace-runtime';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'workingDirectory', 'sandboxPolicy', 'fs', 'llm', 'tools', 'connection', 'shellEnv', 'shell', 'worktrees', 'systemPrompt'];
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export async function apply(ctx, config = {}) {
  const manager = new WorkspaceManager(ctx, config); await manager.initialize();
  const appsConfig = await fs.readFile(config.appsConfigFile ?? '/data/harness/apps-config.json', 'utf8').then(JSON.parse).catch(() => null);
  const { callApps } = createRequire(import.meta.url)('../vast/apps-cli.cjs');
  const capabilities = createRuntimeCapabilities({ workspaceRoot: config.appsWorkspaceRoot ?? appsConfig?.workspaceRoot ?? path.dirname(manager.projectsRoot), capacityPath: appsConfig?.stateDir ?? '/data/harness/state/applications', minFreeBytes: appsConfig?.minFreeBytes ?? 2 * 1024 ** 3,
    ...(appsConfig ? { readAppsState: ({ signal }) => callApps('/state', undefined, { ...appsConfig, signal, timeoutMs: 1500 }) } : {}) });
  registerRuntimeCapabilities(ctx, manager, capabilities);
  let lastCacheCleanup = 0, cacheCleanupPending;
  const cleanupCaches = () => {
    if (cacheCleanupPending || Date.now() - lastCacheCleanup < 60000) return cacheCleanupPending;
    lastCacheCleanup = Date.now();
    cacheCleanupPending = manager.inOrder(async () => {
      for (const id of manager.running.keys()) await manager.releaseIfIdle(id);
      const report = await cleanupIdleProjectCaches(manager, { minFreeBytes: (appsConfig?.minFreeBytes ?? 2 * 1024 ** 3) + 768 * 1024 ** 2 });
      await fs.writeFile(path.join(manager.root, 'cache-cleanup.json'), JSON.stringify({ ...report, at: Date.now() }), { mode: 0o600 });
    }).catch(() => { ctx.logger?.warn('Automatic package-cache cleanup deferred; project data retained.'); }).finally(() => { cacheCleanupPending = undefined; });
    return cacheCleanupPending;
  };
  ctx.effect(() => () => manager.changes.dispose());
  // Local, bounded checks only: never install or download during a cold start.
  const environmentReport = config.environmentReport ?? '/data/harness/state/development.json';
  const preflight = doctor({ output: environmentReport, directory: path.join(path.dirname(environmentReport), 'development') }).catch(error => ({ browser: { ok: false, error: error.message }, dotnet: { available: false } }));
  manager.environmentReady = preflight;
  const runProjectCommand = createProjectCommandRunner(ctx, manager);
  registerProjectTool(ctx, manager, runProjectCommand);
  const managedShell = createManagedShell(ctx, manager, runProjectCommand);
  // SDK tool admission precedes pre-step. Register at creation and enrollment,
  // including seeded future projects, before the first tool-set snapshot.
  for (const agent of ctx.agents.list()) managedShell.install(agent);
  ctx.effect(() => () => managedShell.dispose());
  ctx.on('agent/created', async ({ agent, source, signal }) => { await manager.applyDefaults(agent, source); if (source === 'startup' && !agent.session.header.isSeeded) await manager.ensureProject(agent, signal); managedShell.install(agent); }, { global: true });
  ctx.on('agent/pre-step', async (input, next) => {
    await manager.preStep(input); manager.frozenSettings.set(input.agent.id, { ...manager.settings(manager.ownerAgent(input.agent).session) });
    const decision = await next(), id = manager.ownerAgent(input.agent).id, message = manager.pendingNotices.get(id), diagnostics = manager.pendingDiagnostics.get(id);
    if (decision.kind === 'enter' && (message || diagnostics?.size)) {
      manager.pendingNotices.delete(id); manager.pendingDiagnostics.delete(id);
      const messages = message ? [message] : [];
      if (diagnostics?.size) messages.push({ id: crypto.randomUUID(), role: 'user', source: { kind: 'workspace-runtime' }, content: [{ type: 'text', text: [...diagnostics.values()].join('\n\n') }] });
      return { ...decision, messages: [...decision.messages, ...messages] };
    }
    return decision;
  }, { prepend: true, global: true });
  ctx.tools.guard(exec => manager.toolGuard({ ...exec, agent: manager.ownerAgent(exec.agent), managedProjectShell: managedShell.handles(exec) }));
  ctx.on('tools/result', (exec, result) => {
    manager.observeToolResult({ ...exec, agent: manager.ownerAgent(exec.agent), managedProjectShell: managedShell.handles(exec) }, result);
  }, { global: true });
  ctx.on('workspace-runtime/verification', async report => { await manager.reportVerification(report); });
  ctx.on('workspace-runtime/review', async ({ sessionId }, next) => (await manager.review(sessionId)) ?? next());
  ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') setTimeout(() => void manager.releaseIfIdle(session.id).then(cleanupCaches).catch(() => {}), 0); });
  ctx.on('agent/disposed', ({ agent }) => { managedShell.remove(agent); manager.grants.get(agent.id)?.(); manager.grants.delete(agent.id); manager.frozenSettings.delete(agent.id); manager.pendingDiagnostics.delete(agent.id); void manager.releaseIfIdle(agent.id).catch(() => {}); });
  const timer = setInterval(() => { for (const id of manager.running.keys()) void manager.releaseIfIdle(id).catch(() => {}); }, 10000); timer.unref();
  ctx.effect(() => () => clearInterval(timer));
  const cleanupTimer = setInterval(() => void cleanupCaches(), 60000); cleanupTimer.unref();
  const initialCleanup = setTimeout(() => void cleanupCaches(), 2000); initialCleanup.unref();
  ctx.effect(() => () => { clearInterval(cleanupTimer); clearTimeout(initialCleanup); });
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    headers = next();
    if (request.provider !== 'strata-vast' || request.purpose === 'compaction') return headers;
    const url = new URL(request.baseURL); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return headers;
    const settings = manager.frozenSettings.get(String(request.sessionId)); if (!settings) return headers;
    headers.set('x-harness-session', String(request.sessionId));
    headers.set('x-harness-generation', Buffer.from(JSON.stringify({ topP: settings.topP, temperature: settings.temperature, maxTokens: settings.maxTokens, thinkingBudget: settings.thinkingBudget, effort: settings.reasoningEffort })).toString('base64url'));
    return headers;
  }, { global: true });
  ctx.shellEnv.register({ name: 'isolated-project', variables: Object.fromEntries(['DSH_PROJECT_ROOT', 'DSH_APP_PORT', 'DSH_API_PORT', 'DSH_TEST_PORT', 'DSH_DATABASE_URL'].map(k => [k, { description: 'Assigned isolated project runtime value.' }])), resolve: execution => {
    const agent = manager.ownerAgent(execution.agent), record = manager.data.sessions[agent?.id];
    return record?.ports ? { DSH_PROJECT_ROOT: record.root, DSH_APP_PORT: String(record.ports[0]), DSH_API_PORT: String(record.ports[1]), DSH_TEST_PORT: String(record.ports[2]), DSH_DATABASE_URL: 'file:' + record.databasePath } : {};
  } });
  async function state() {
    const workspaces = ctx.workspaceRegistry.list().map(w => ({ id: w.id, title: w.title, path: w.path, sessionIds: w.sessionIds, settings: manager.data.workspaces[w.id]?.settings }));
    const projects = Object.fromEntries(Object.entries(manager.data.sessions).map(([id, p]) => [id, { root: p.root, ports: p.ports, databasePath: p.databasePath, baseCommit: p.baseCommit, nativeWorktree: p.nativeWorktree, legacy: p.legacy, budget: p.budget, checkpoints: Object.fromEntries(Object.entries(p.checkpoints ?? {}).map(([k, c]) => [k, { score: c.score, at: c.at, files: c.files }])), checkpointError: p.checkpointError }]));
    const update = await fs.readFile(!config.updateReport || config.updateReport === '/data/harness/state/startup-update.json' ? '/data/harness/runtime-status/startup-update.json' : config.updateReport, 'utf8').then(JSON.parse).then(value => Object.fromEntries(['version','enabled','phase','checkedAt','appliedCommit','targetCommit','error','signatureVerified','bootstrapUpgradeRequired'].map(key => [key,value[key]]))).catch(() => null);
    return { defaults: DEFAULTS, repairPolicyVersion: manager.repairPolicyVersion, managedShellVersion: 1, projectBackgroundVersion: 1, changesVersion: 1, update, workspaces, projects, trash: manager.data.trash, running: ctx.agents.list().filter(a => a.status === 'running').map(a => a.id), environment: await fs.readFile(config.environmentReport ?? '/data/harness/state/development.json', 'utf8').then(JSON.parse).catch(() => null) };
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workbench', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async request => {
    try {
      if (request.method === 'GET') return reply(await state());
      if (!sameRequestOrigin(request)) return reply({ code: 'ORIGIN_REFUSED', error: 'Same-origin request required.' }, 403);
      const data = await boundedJSON(request), id = data.sessionId;
      if (id !== undefined && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id))) throw new WorkbenchError('INVALID_SESSION', 'Invalid conversation.', 400);
      if (data.op === 'settings') return reply(await manager.updateSettings(data.workspaceId, data.settings));
      if (data.op === 'file') return reply(await manager.files(id, data.operation, data.args ?? {}, request.signal));
      if (data.op === 'changes') return reply(await manager.projectChanges(id, data.operation ?? 'list', data.args ?? {}, request.signal));
      if (data.op === 'trash') return reply(await manager.inOrder(() => manager.trashSession(id)));
      if (data.op === 'restore') return reply(await manager.inOrder(() => manager.restoreSession(id)));
      if (data.op === 'resume') { await manager.reviewResume(id, data.strategy); return reply({ resumed: true }); }
      const checkpoint = await checkpointOperation(manager, data, request.signal);
      if (checkpoint) return reply(checkpoint.value);
      throw new WorkbenchError('UNKNOWN_OPERATION', 'Unknown operation.', 400);
    } catch (error) { return reply({ code: error.code ?? 'WORKBENCH_FAILED', error: error.message }, error.status ?? (String(error.code).includes('STALE') ? 409 : 400)); }
  } }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workbench/download', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try { const q = new URL(request.url).searchParams, value = await manager.files(q.get('sessionId'), 'download', { path: q.get('path') }, request.signal); return new Response(value.bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(value.name), 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff' } }); }
    catch (error) { return reply({ error: error.message }, error.status ?? 400); }
  } }));
  // Kept as a separate static contribution for a native client in addition to /phone/.
  const sourceCommit = path.basename(await fs.realpath(root));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workbench/health', methods: ['GET'], requestBody: 'buffered', fetch: async () => reply({ version: 1, workspaceReady: true, sourceCommit: /^[a-f0-9]{40}$/u.test(sourceCommit) ? sourceCommit : null }) }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workbench/client', methods: ['GET'], requestBody: 'buffered', fetch: async () => new Response(await fs.readFile(path.join(root, 'workspace/client.js')), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } }) }));
  await fs.writeFile(path.join(manager.root, 'loaded.json'), JSON.stringify({ at: Date.now(), pid: process.pid, loaded: true, installedAt: manager.data.installedAt }), { mode: 0o600 });
}
