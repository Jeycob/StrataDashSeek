import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installDockerResourceRoutes } from './docker-resources.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-owner-api-')), project = path.join(root, 'a'); await fs.mkdir(project); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const routes = new Map(), calls = [], reservations = [], manager = { projectsRoot: root, data: { sessions: { one: { root: project } }, trash: {} } }, cfg = { workspaceRoot: root };
  const ctx = { effect: fn => fn(), connection: { fetch: { register: value => { routes.set(value.path, value.fetch); return () => {}; } } } };
  let rpc = async () => ({ version: 1, items: [], operation: null }), journal = { resources: { plans: {} } };
  installDockerResourceRoutes(ctx, manager, cfg, { gated: async (fn, reserve = []) => { reservations.push(reserve); return fn('authority-fixture'); }, readJournal: async () => journal, callApps: async (route, input) => { calls.push({ route, input }); return rpc(input); }, streamArchive: async (_cfg, input) => { calls.push({ stream: input }); return new Response('synthetic archive'); } });
  const request = async (method, query = '', body, headers = {}) => routes.get('/api/workbench/docker-resources')(new Request('https://owner.test/api/workbench/docker-resources' + query, { method, headers: { Host: 'owner.test', ...(method === 'POST' ? { Origin: 'https://owner.test', 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { root, manager, routes, calls, reservations, request, setRpc: fn => { rpc = fn; }, setJournal: v => { journal = v; } };
}
test('owner route derives project authority, refuses forged fields, context switches and cross-origin reads/writes', async t => {
  const f = await fixture(t); assert.equal((await f.request('GET', '?sessionId=one')).status, 200); assert.equal(f.calls[0].input.token, 'authority-fixture'); assert.match(f.calls[0].input.projectId, /^[a-f0-9]{16}$/);
  for (const [method, query, body, headers] of [ ['GET', '?sessionId=one&projectId=fake'], ['POST', '?sessionId=one', { sessionId: 'other' }], ['POST', '', { sessionId: 'one' }, { Origin: 'https://editor.test' }], ['GET', '?sessionId=one', null, { Origin: 'https://editor.test' }], ['GET', '?sessionId=one', null, { 'Sec-Fetch-Site': 'same-site' }] ]) assert.ok((await f.request(method, query, body, headers)).status >= 400);
  assert.equal(f.calls.length, 1);
});
test('global scope is explicit and apply reserves persisted owners before forwarding the original request', async t => {
  const f = await fixture(t); assert.equal((await f.request('GET')).status, 400);
  assert.equal((await f.request('POST', '?scope=global', { phase: 'preview' })).status, 400);
  f.setJournal({ resources: { plans: { plan: { ownerSessionIds: ['one'] } } } });
  assert.equal((await f.request('POST', '?sessionId=one', { phase: 'apply', planId: 'plan', planHash: 'hash', operationId: 'a'.repeat(32), kind: 'image', id: 'immutable', action: 'export' })).status, 200);
  assert.deepEqual(f.reservations.at(-1), ['one']); assert.equal(f.calls.at(-1).input.planHash, 'hash'); assert.equal(f.calls.at(-1).input.action, 'export');
});
test('download is bound again to the selected session, and response links contain no auth tokens', async t => {
  const f = await fixture(t), operationId = 'a'.repeat(32);
  f.setRpc(async () => ({ operation: { operationId, state: 'completed', export: { bytes: 17 } } }));
  const value = await (await f.request('GET', '?sessionId=one&operationId=' + operationId)).json(); assert.match(value.operation.export.downloadUrl, /sessionId=one/); assert.doesNotMatch(JSON.stringify(value), /authority-fixture/);
  const download = f.routes.get('/api/workbench/docker-resources/download');
  assert.equal((await download(new Request('https://owner.test' + value.operation.export.downloadUrl))).status, 200);
  assert.equal(f.calls.at(-1).stream.sessionId, 'one');
  assert.equal((await download(new Request('https://owner.test/api/workbench/docker-resources/download?sessionId=other&operationId=' + operationId))).status, 404);
});
