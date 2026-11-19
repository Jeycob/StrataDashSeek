import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {installProjectMemory} from './project-memory.mjs';

const sdk = process.env.EFFICIENCY_SDK_ROOT ?? '/data/harness/runtime/node_modules';
const load = name => import(pathToFileURL(path.join(sdk, '@deepseek-ai', name, 'lib/index.js')));
const [{Context}, {default: SystemPrompt, renderPrompt, renderContextSections}, {workspaceRecord}] =
  await Promise.all([load('cordis'), load('dsh-system-prompt'), load('dsh-workspace')]);
const endpoint = '/api/workbench/project-memory';
const stablePrompt = 'Existing prompt.';
const tempRoot = async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-memory-')));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
};

function fixture(t, root) {
  const ctx = new Context();
  new SystemPrompt(ctx, {includeHarnessIdentity: false});
  ctx.systemPrompt.section({name: 'existing', order: 1, text: stablePrompt});
  const agents = new Map();
  for (const id of ['a-1', 'a-2', 'b-1', 'unassigned'])
    agents.set(id, {id, session: {id, header: {cwd: root}}});
  // A shared cwd is intentional. Only SDK membership may select memory.
  const at = '2026-11-19T20:00:00.000Z';
  const workspaces = [{id: 'project-a', sessionIds: ['a-1', 'a-2']}, {id: 'project-b', sessionIds: ['b-1']}]
    .map(({id, sessionIds}) => ({id, ...workspaceRecord.parse({sessionIds, path: root, title: id, createdAt: at, updatedAt: at})}));
  const archivedSessionIds = [];
  ctx.provide('agents', {get: id => agents.get(id)});
  ctx.provide('workspaceRegistry', {list: () => workspaces, get: id => workspaces.find(workspace => workspace.id === id), archivedSessionIds});
  let route;
  ctx.provide('connection', {fetch: {register(value) {route = value; return () => {};}}});
  installProjectMemory(ctx, {root, execution: {assertUnchanged() {}}});
  t.after(() => ctx.fiber.dispose());
  return {
    agents, workspaces, archivedSessionIds,
    async post(body, origin = 'https://owner.test') {
      assert.equal(route.path, endpoint);
      assert.deepEqual(route.methods, ['POST']);
      const response = await route.fetch(new Request('http://internal.test' + endpoint, {
        method: 'POST', headers: {host: 'owner.test', origin}, body: JSON.stringify(body),
      }));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return {status: response.status, value: await response.json()};
    },
    async prompt(id, {scopeOnly = false} = {}) {
      const agent = agents.get(id);
      const assembly = await ctx.systemPrompt.assemble({...(scopeOnly ? {} : {agent}), scope: agent, signal: AbortSignal.timeout(3000)});
      return {system: renderPrompt(assembly), context: renderContextSections(assembly)};
    },
    path: root,
  };
}
const list = workspaceId => ({operation: 'list', workspaceId});

test('confirmed workspace decisions survive reload, appear only in member prompts, and follow edit and deletion', async t => {
  const root = await tempRoot(t), a = fixture(t, root);
  const empty = await a.prompt('a-1');
  assert.equal(empty.system, stablePrompt);
  assert.deepEqual(empty.context, []);
  const add = await a.post({operation: 'add', workspaceId: 'project-a', revision: null, text: 'Use české popisky {{literal}}.'});
  assert.equal(add.status, 200);
  const {id} = add.value.entries[0];
  assert.match((await a.prompt('a-1')).system, /české popisky \{\{literal\}\}/);
  assert.match((await a.prompt('a-2', {scopeOnly: true})).system, /české popisky/);
  assert.deepEqual(await a.prompt('b-1'), empty);
  assert.deepEqual(await a.prompt('unassigned'), empty);
  assert.deepEqual((await a.prompt('a-2')).context, []);

  const b = fixture(t, root);
  assert.deepEqual((await b.post(list('project-a'))).value, add.value);
  const edit = await b.post({operation: 'update', workspaceId: 'project-a', id, revision: add.value.revision, text: 'Prefer plain labels.'});
  assert.equal(edit.status, 200);
  assert.match((await b.prompt('a-2')).system, /Prefer plain labels/);
  assert.doesNotMatch((await b.prompt('a-2')).system, /české popisky/);

  b.workspaces[0].sessionIds = ['a-1'];
  b.workspaces[1].sessionIds.push('a-2');
  assert.deepEqual(await b.prompt('a-2'), empty);
  b.archivedSessionIds.push('a-1');
  assert.deepEqual(await b.prompt('a-1'), empty);
  b.archivedSessionIds.pop();
  const removed = await b.post({operation: 'delete', workspaceId: 'project-a', id, revision: edit.value.revision});
  assert.equal(removed.status, 200);
  assert.deepEqual(await b.prompt('a-1'), empty);
  assert.deepEqual((await fixture(t, root).post(list('project-a'))).value.entries, []);
});

test('origin, exact workspace, payload limits and revision conflicts are enforced before writes', async t => {
  const f = fixture(t, await tempRoot(t));
  const add = {operation: 'add', workspaceId: 'project-a', revision: null, text: 'First decision'};
  assert.equal((await f.post(add, 'https://other.test')).status, 403);
  assert.equal((await f.post({...add, workspaceId: 'absent'})).status, 404);
  assert.equal((await f.post({...add, sessionId: 'a-1'})).status, 400);
  for (const text of ['a\nb', 'č'.repeat(81), ' ']) assert.equal((await f.post({...add, text})).status, 400);
  assert.equal((await f.post({...add, text: 'a'.repeat(4096)})).status, 413);
  assert.deepEqual((await f.post(list('project-a'))).value.entries, []);
  const [accepted, stale] = await Promise.all([f.post(add), f.post(add)]);
  assert.equal(accepted.status, 200);
  assert.equal(stale.status, 409);
  assert.equal(stale.value.code, 'PROJECT_MEMORY_STALE');
  const foreignEdit = {operation: 'update', workspaceId: 'project-b', revision: null, id: accepted.value.entries[0].id, text: 'Do not copy'};
  assert.equal((await f.post(foreignEdit)).status, 404);

  let snapshot = accepted.value;
  for (let n = 1; n < 5; n++) {
    const response = await f.post({...add, revision: snapshot.revision, text: String(n).repeat(160)});
    assert.equal(response.status, 200);
    snapshot = response.value;
  }
  assert.equal((await f.post({...add, revision: snapshot.revision})).value.code, 'PROJECT_MEMORY_FULL');
  assert(Buffer.byteLength((await f.prompt('a-1')).system) <= Buffer.byteLength(stablePrompt) + 910);
  f.workspaces[1].sessionIds.push('a-1');
  assert.equal((await f.prompt('a-1')).system, stablePrompt);
});
