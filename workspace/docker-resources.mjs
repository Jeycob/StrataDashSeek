import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { sameRequestOrigin, boundedJSON } from './http.mjs';
const fail = (code, status = 409) => Object.assign(Error(code), { code, status });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function selectedContext(manager, cfg, input) {
  if (input.projectId !== undefined || input.root !== undefined || input.token !== undefined || input._contextProjectId !== undefined) throw fail('RESOURCE_CLIENT_AUTHORITY_REFUSED', 400);
  if (input.scope === 'global' && input.sessionId === undefined) return { scope: 'global' };
  if (input.scope !== undefined && input.scope !== 'project' || typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)) throw fail('RESOURCE_CONTEXT_REQUIRED', 400);
  const record = manager.data.sessions[input.sessionId];
  if (!record || record.legacy || manager.data.trash?.[input.sessionId]) throw fail('RESOURCE_CONTEXT_UNAVAILABLE', 404);
  const root = await fs.realpath(record.root), base = await fs.realpath(cfg.workspaceRoot ?? path.dirname(manager.projectsRoot));
  if (root !== record.root || root === base || !root.startsWith(base + path.sep)) throw fail('RESOURCE_CONTEXT_MISMATCH', 403);
  return { scope: 'project', sessionId: input.sessionId, projectId: crypto.createHash('sha256').update(root).digest('hex').slice(0, 16) };
}
function browserFence(request) {
  const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
  if (origin && !sameRequestOrigin(request) || ['cross-site', 'same-site'].includes(site)) throw fail('ORIGIN_REFUSED', 403);
}
async function openArchive(cfg, input, signal) {
  const key = (await fs.readFile(cfg.keyFile ?? '/data/harness/secrets/apps-internal.key', 'utf8')).trim(), parameters = new URLSearchParams(Object.entries(input).filter(([k, v]) => k !== 'token' && v !== undefined));
  return new Promise((resolve, reject) => {
    let timer;
    const request = http.get({ hostname: '127.0.0.1', port: cfg.port ?? 3093, path: '/resource-export-download?' + parameters, signal, headers: { 'X-Harness-Apps-Key': key, 'X-Harness-Resource-Authority': input.token } }, upstream => {
      const length = Number(upstream.headers['content-length']);
      if (upstream.statusCode !== 200 || !Number.isSafeInteger(length) || length < 1 || length > (cfg.resourceExportMaxBytes ?? 512 * 1024 ** 2)) { upstream.destroy(); reject(fail('RESOURCE_EXPORT_UNAVAILABLE', upstream.statusCode === 410 ? 410 : 502)); return; }
      const disposition = upstream.headers['content-disposition'];
      if (typeof disposition !== 'string' || !/^attachment; filename="(?:image|container)-[a-f0-9]{16}\.tar"$/.test(disposition)) { upstream.destroy(); reject(fail('RESOURCE_EXPORT_INVALID', 502)); return; }
      upstream.once('close', () => clearTimeout(timer));
      let bytes = 0; const bounded = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; done(bytes > length ? fail('RESOURCE_EXPORT_SIZE_LIMIT', 502) : null, chunk); }, final(done) { done(bytes === length ? null : fail('RESOURCE_EXPORT_TRUNCATED', 502)); } });
      upstream.on('error', error => bounded.destroy(error)); bounded.once('close', () => { upstream.destroy(); clearTimeout(timer); }); upstream.pipe(bounded);
      resolve(new Response(Readable.toWeb(bounded), { headers: { 'Content-Type': 'application/x-tar', 'Content-Length': String(length), 'Content-Disposition': disposition, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }));
    });
    timer = setTimeout(() => request.destroy(fail('RESOURCE_EXPORT_TIMEOUT')), 120000); timer.unref?.(); request.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

// Called by the existing cleanup installer, using its exact manager queue,
// registryBarrier, authority-file lifetime and session reservation guard.
export function installDockerResourceRoutes(ctx, manager, cfg, { gated, readJournal, callApps, streamArchive = openArchive }) {
  const rpc = input => callApps('/resources', input, { ...cfg, timeoutMs: 180000 });
  const route = { path: '/api/workbench/docker-resources', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async request => {
    try {
      browserFence(request);
      const query = Object.fromEntries(new URL(request.url).searchParams), body = request.method === 'POST' ? await boundedJSON(request, 16384) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('RESOURCE_REQUEST_INVALID', 400);
      if (query.sessionId !== undefined && body.sessionId !== undefined && query.sessionId !== body.sessionId || query.scope !== undefined && body.scope !== undefined && query.scope !== body.scope) throw fail('RESOURCE_CONTEXT_MISMATCH', 403);
      const input = { ...query, ...body };
      if (request.method === 'POST' && !sameRequestOrigin(request)) throw fail('ORIGIN_REFUSED', 403);
      if (request.method === 'POST' && input.scope === 'global' && input.confirmGlobal !== true) throw fail('GLOBAL_CONFIRMATION_REQUIRED', 400);
      let reserve = [];
      if (request.method === 'POST' && input.phase === 'apply') {
        const journal = await readJournal(), plan = journal.resources?.plans?.[input.planId], receipt = journal.resources?.requests?.[input.operationId];
        if (!plan && !receipt) throw fail('RESOURCE_PLAN_STALE'); reserve = plan?.ownerSessionIds ?? receipt?.ownerSessionIds ?? [];
      }
      const value = await gated(async token => {
        const selected = await selectedContext(manager, cfg, input);
        const fields = Object.fromEntries(['kind', 'q', 'state', 'limit', 'cursor', 'phase', 'id', 'action', 'inventoryId', 'operationId', 'planId', 'planHash'].filter(k => input[k] !== undefined).map(k => [k, input[k]]));
        return rpc({ ...fields, ...selected, token, op: request.method === 'GET' ? 'inventory' : 'action' });
      }, reserve);
      if (value.operation?.export && value.operation.state === 'completed') {
        const params = new URLSearchParams({ operationId: value.operation.operationId, ...(input.scope === 'global' ? { scope: 'global' } : { sessionId: input.sessionId }) });
        value.operation.export.downloadUrl = '/api/workbench/docker-resources/download?' + params;
      }
      return response(value);
    } catch (e) { return response({ code: e.code ?? 'RESOURCE_UNAVAILABLE', error: e.code ?? 'Resource operation unavailable' }, e.status ?? 503); }
  } };
  ctx.effect(() => ctx.connection.fetch.register(route));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workbench/docker-resources/download', methods: ['GET'], fetch: async request => {
    try {
      browserFence(request); const input = Object.fromEntries(new URL(request.url).searchParams);
      if (!/^[a-f0-9]{32}$/.test(input.operationId ?? '')) throw fail('RESOURCE_REQUEST_INVALID', 400);
      return await gated(async token => { const selected = await selectedContext(manager, cfg, input); return streamArchive(cfg, { ...selected, operationId: input.operationId, token }, request.signal); });
    } catch (e) { return response({ code: e.code ?? 'RESOURCE_EXPORT_UNAVAILABLE' }, e.status ?? 503); }
  } }));
  return route;
}
export { selectedContext, browserFence };
