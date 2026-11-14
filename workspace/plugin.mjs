import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceManager } from './manager.mjs';
import { WorkbenchError, DEFAULTS } from './policy.mjs';
import { registerProjectTool } from './project-tool.mjs';
import { sameRequestOrigin, boundedJSON } from './http.mjs';
import { createRequire } from 'node:module';
const { doctor } = createRequire(import.meta.url)('../development/doctor.cjs');

export const name = 'workspace-runtime';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'workingDirectory', 'sandboxPolicy', 'fs', 'llm', 'tools', 'connection', 'shellEnv', 'shell', 'worktrees'];
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export async function apply(ctx, config = {}) {
  const manager = new WorkspaceManager(ctx, config); await manager.initialize();
  // Local, bounded checks only: never install or download during a cold start.
  const environmentReport = config.environmentReport ?? '/data/harness/state/development.json';
  const preflight = doctor({ output: environmentReport, directory: path.join(path.dirname(environmentReport), 'development') }).catch(error => ({ browser: { ok: false, error: error.message }, dotnet: { available: false } }));
  manager.environmentReady = preflight;
  registerProjectTool(ctx, manager);
  ctx.on('agent/created', async ({ agent, source, signal }) => { await manager.applyDefaults(agent, source); if (source === 'startup' && !agent.session.header.isSeeded) await manager.ensureProject(agent, signal); }, { global: true });
  ctx.on('agent/pre-step', async (input, next) => {
    await manager.preStep(input); manager.frozenSettings.set(input.agent.id, { ...manager.settings(manager.ownerAgent(input.agent).session) });
    const decision = await next(), id = manager.ownerAgent(input.agent).id, message = manager.pendingNotices.get(id);
    if (decision.kind === 'enter' && message) { manager.pendingNotices.delete(id); return { ...decision, messages: [...decision.messages, message] }; }
    return decision;
  }, { prepend: true, global: true });
  ctx.tools.guard(exec => manager.toolGuard({ ...exec, agent: manager.ownerAgent(exec.agent) }));
  ctx.on('tools/post-execute', async (exec, result, next) => { if (exec.name !== 'verify_project') await manager.toolResult({ ...exec, agent: manager.ownerAgent(exec.agent) }, result); return next(); }, { global: true });
  ctx.on('workspace-runtime/verification', async report => { await manager.reportVerification(report); });
  ctx.on('workspace-runtime/review', async ({ sessionId }, next) => (await manager.review(sessionId)) ?? next());
  ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') setTimeout(() => void manager.releaseIfIdle(session.id).catch(() => {}), 0); });
  ctx.on('agent/disposed', ({ agent }) => { manager.grants.get(agent.id)?.(); manager.grants.delete(agent.id); manager.frozenSettings.delete(agent.id); void manager.releaseIfIdle(agent.id).catch(() => {}); });
  const timer = setInterval(() => { for (const id of manager.running.keys()) void manager.releaseIfIdle(id).catch(() => {}); }, 10000); timer.unref();
  ctx.effect(() => () => clearInterval(timer));
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
    return { defaults: DEFAULTS, workspaces, projects, trash: manager.data.trash, running: ctx.agents.list().filter(a => a.status === 'running').map(a => a.id), environment: await fs.readFile(config.environmentReport ?? '/data/harness/state/development.json', 'utf8').then(JSON.parse).catch(() => null) };
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workbench', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async request => {
    try {
      if (request.method === 'GET') return reply(await state());
      if (!sameRequestOrigin(request)) return reply({ code: 'ORIGIN_REFUSED', error: 'Same-origin request required.' }, 403);
      const data = await boundedJSON(request), id = data.sessionId;
      if (id !== undefined && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id))) throw new WorkbenchError('INVALID_SESSION', 'Invalid conversation.', 400);
      if (data.op === 'settings') return reply(await manager.updateSettings(data.workspaceId, data.settings));
      if (data.op === 'file') return reply(await manager.files(id, data.operation, data.args ?? {}, request.signal));
      if (data.op === 'trash') return reply(await manager.inOrder(() => manager.trashSession(id)));
      if (data.op === 'restore') return reply(await manager.inOrder(() => manager.restoreSession(id)));
      if (data.op === 'resume') { await manager.reviewResume(id, data.strategy); return reply({ resumed: true }); }
      if (data.op === 'checkpoint-restore') return reply(await manager.restoreCheckpoint(id, data.key, request.signal));
      throw new WorkbenchError('UNKNOWN_OPERATION', 'Unknown operation.', 400);
    } catch (error) { return reply({ code: error.code ?? 'WORKBENCH_FAILED', error: error.message }, error.status ?? (String(error.code).includes('STALE') ? 409 : 400)); }
  } }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workbench/download', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try { const q = new URL(request.url).searchParams, value = await manager.files(q.get('sessionId'), 'download', { path: q.get('path') }, request.signal); return new Response(value.bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(value.name), 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff' } }); }
    catch (error) { return reply({ error: error.message }, error.status ?? 400); }
  } }));
  // Kept as a separate static contribution for a native client in addition to /phone/.
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workbench/client', methods: ['GET'], requestBody: 'buffered', fetch: async () => new Response(await fs.readFile(path.join(root, 'workspace/client.js')), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } }) }));
  await fs.writeFile(path.join(manager.root, 'loaded.json'), JSON.stringify({ at: Date.now(), pid: process.pid, loaded: true, installedAt: manager.data.installedAt }), { mode: 0o600 });
}
