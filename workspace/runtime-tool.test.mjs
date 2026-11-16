// Explicit integration tests: run with the pinned real Harness SDK, not a mock registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { registerRuntimeCapabilities } from './runtime-tool.mjs';
import { createRuntimeCapabilities, runtimeCapabilitiesFallback } from './runtime-capabilities.mjs';

const SDK = process.env.EFFICIENCY_SDK_ROOT ?? '/data/harness/runtime/node_modules';
const load = (name, file = 'index.js') => import(pathToFileURL(path.join(SDK, '@deepseek-ai', name, 'lib', file)).href);
const [{ Context }, { default: SystemPrompt, renderPrompt, renderContextSections }, { default: Tools }, { ToolExecutionPipeline, executeToolBatch }] = await Promise.all([
  load('cordis'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-tools', 'pipeline.js'),
]);
const NAME = 'runtime_capabilities', SECTION = 'workspace-runtime:deployment-capabilities';
const root = path.resolve('/runtime-tool-test/workspaces'), ownRoot = path.join(root, 'projects', 'own'), otherRoot = path.join(root, 'projects', 'other');
const ownId = 'a'.repeat(16), otherId = 'b'.repeat(16);

async function fixture(t, { snapshotOverride } = {}) {
  const ctx = new Context(); t.after(async () => { await ctx.fiber.dispose(); });
  new SystemPrompt(ctx, {}); new Tools(ctx);
  const owner = { id: 'owner', session: { id: 'owner', header: {} } }, child = { id: 'child', ownerId: 'owner', parent: owner, session: { id: 'child', header: {} } },
    other = { id: 'other', session: { id: 'other', header: {} } }, legacy = { id: 'legacy', session: { id: 'legacy', header: {} } }, missing = { id: 'missing', session: { id: 'missing', header: {} } };
  const agents = new Map([owner, child, other, legacy, missing].map(a => [a.id, a]));
  ctx.provide('agents', { get: id => agents.get(id) });
  const records = { owner: { root: ownRoot }, child: { root: otherRoot }, other: { root: otherRoot }, legacy: { root: ownRoot, legacy: true } };
  const manager = { data: { sessions: records }, ownerAgent: a => a && agents.get(a.ownerId ?? a.id) };
  let io = 0, appsReads = 0, clock = 10000;
  const fs = {
    realpath: async p => { io++; return p; }, stat: async () => { io++; return { isDirectory: () => true }; },
    lstat: async p => { io++; if (['Dockerfile', '.harness-app.json', '.dockerignore'].includes(path.basename(p))) return { isFile: () => true, isSymbolicLink: () => false }; throw Object.assign(Error('absent'), { code: 'ENOENT' }); },
    statfs: async () => { io++; return { bavail: 8n * 1024n ** 3n, bsize: 1n }; },
  };
  const capabilities = createRuntimeCapabilities({ workspaceRoot: root, capacityPath: root, fs, now: () => clock, readAppsState: async () => {
    appsReads++; return { enabled: true, available: false, worker: { phase: 'asleep' },
      projects: [{ id: ownId, path: path.relative(root, ownRoot), applicationUrl: 'https://secret-own.invalid', env: { secret: 'CANARY_SECRET' } }, { id: otherId, path: path.relative(root, otherRoot) }],
      jobs: [{ id: ownId, projectId: ownId, action: 'verify', status: 'passed', output: 'CANARY_LOG' }, { id: otherId, projectId: otherId, action: 'deploy', status: 'running' }], containers: [] };
  } });
  const snapshotRoots = [], wrapped = { snapshot: async p => { snapshotRoots.push(p); return snapshotOverride ? snapshotOverride(p) : capabilities.snapshot(p); }, renderContext: p => capabilities.renderContext(p) };
  registerRuntimeCapabilities(ctx, manager, wrapped);
  ctx.systemPrompt.section({ name: 'fixture:stable', order: 1, interpolate: false, text: 'Stable reusable system instruction.' });
  const pipeline = new ToolExecutionPipeline(ctx);
  ctx.tools.setExecutor({ describe: definitions => ({ schemas: definitions.map(({ name, description, parameters }) => ({ name, description, parameters })) }), execute: input => executeToolBatch(input, pipeline, () => 2) });
  const signal = () => AbortSignal.timeout(3000);
  async function call(agent = owner, args = {}, selectedSignal = signal()) {
    const toolSet = await ctx.tools.resolve({ agent, signal: selectedSignal, modelSelection: { provider: 'fixture', model: 'fixture' } });
    try { const batch = await ctx.tools.execute({ agent, signal: selectedSignal, toolSet, calls: [{ id: randomUUID(), name: NAME, arguments: JSON.stringify(args) }] }); return batch.results[0].result; }
    finally { toolSet.dispose(); }
  }
  async function assemble(agent = owner, { scopeOnly = false } = {}) {
    const selectedSignal = signal(), toolSet = await ctx.tools.resolve({ agent, signal: selectedSignal, modelSelection: { provider: 'fixture', model: 'fixture' } });
    try { return await ctx.systemPrompt.assemble({ ...(scopeOnly ? {} : { agent }), scope: agent, toolSet, signal: selectedSignal, modelSelection: { provider: 'fixture', model: 'fixture' } }); }
    finally { toolSet.dispose(); }
  }
  return { ctx, owner, child, other, legacy, missing, manager, capabilities, call, assemble, snapshotRoots, reads: () => ({ io, appsReads }), advance: ms => { clock += ms; } };
}

test('real SDK registers exactly one tool with strict no-arguments schema and admitted model schema', { timeout: 5000 }, async t => {
  const f = await fixture(t), definitions = f.ctx.tools.schemas(f.owner).filter(x => x.name === NAME);
  assert.equal(definitions.length, 1); assert.deepEqual(definitions[0].parameters, { type: 'object', properties: {}, additionalProperties: false });
  const assembly = await f.assemble(); assert.equal(assembly.tools.filter(x => x.name === NAME).length, 1);
  assert.match(definitions[0].description, /never wakes/i); assert.match(definitions[0].description, /never lower reserves/i);
  assert.deepEqual(f.reads(), { io: 0, appsReads: 0 });
});

test('real SDK rejects paths, project ids, primitives and arrays before any capability read', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const args of [{ path: otherRoot }, { projectId: otherId }, { force: true }, null, [], 'state', 7]) {
    const result = await f.call(f.owner, args); assert.equal(result.isError, true, JSON.stringify(result));
  }
  assert.deepEqual(f.snapshotRoots, []); assert.deepEqual(f.reads(), { io: 0, appsReads: 0 });
});

test('real SDK executes read-only success, validates output, renders actual snapshot and isolates child to owner', { timeout: 5000 }, async t => {
  const f = await fixture(t), result = await f.call(f.child);
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.value.version, 2);
  assert.equal(result.value.apps.state, 'asleep'); assert.equal(result.value.apps.project.id, ownId);
  assert.deepEqual(f.snapshotRoots, [ownRoot]); assert.equal(result.value.apps.jobs.length, 1);
  assert.ok(result.value.existingFiles.includes('Dockerfile')); assert.equal(result.value.capacity.canVerify, true);
  const text = result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
  assert.deepEqual(JSON.parse(text), result.value); assert.doesNotMatch(text, /CANARY|secret-own\.invalid/);
  assert.equal(text.includes(otherId), false); assert.equal(f.reads().appsReads, 1);
  const reads = f.reads(); assert.equal((await f.call(f.owner)).isError, false); assert.deepEqual(f.reads(), reads);
});

test('real SDK admission denies legacy and unmanaged agents; a separate managed owner receives only its project', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const agent of [f.legacy, f.missing]) {
    const a = await f.assemble(agent); assert.equal(a.tools.some(x => x.name === NAME), false);
    assert.equal(renderContextSections(a).some(x => x.name === SECTION), false);
    const result = await f.call(agent); assert.equal(result.isError, true);
  }
  assert.deepEqual(f.snapshotRoots, []);
  const other = await f.call(f.other); assert.equal(other.isError, false); assert.equal(other.value.apps.project.id, otherId);
  assert.deepEqual(f.snapshotRoots, [otherRoot]); assert.equal(other.value.apps.jobs[0].projectId, undefined);
  assert.equal(JSON.stringify(other.value).includes(ownId), false);
});

test('real SDK context survives assembly, refreshes through tool only and never changes reusable renderPrompt prefix', { timeout: 5000 }, async t => {
  const f = await fixture(t), before = await f.assemble();
  const contextBefore = renderContextSections(before).find(x => x.name === SECTION); assert.equal(contextBefore.text, runtimeCapabilitiesFallback);
  assert.deepEqual(f.reads(), { io: 0, appsReads: 0 });
  assert.equal((await f.call(f.child)).isError, false); const afterRead = f.reads();
  const after = await f.assemble(f.child), repeated = await f.assemble(f.owner, { scopeOnly: true });
  assert.equal(renderPrompt(before), renderPrompt(after)); assert.equal(renderPrompt(after), renderPrompt(repeated));
  assert.ok(renderPrompt(after).endsWith('Stable reusable system instruction.'));
  assert.doesNotMatch(renderPrompt(after), /capability snapshot|"state":"asleep"/);
  assert.deepEqual(before.tools.map(x => x.name), after.tools.map(x => x.name));
  const contexts = renderContextSections(after); assert.equal(contexts.filter(x => x.name === SECTION).length, 1);
  assert.match(contexts.find(x => x.name === SECTION).text, /"state":"asleep"/);
  assert.match(renderContextSections(repeated).find(x => x.name === SECTION).text, /"id":"aaaaaaaaaaaaaaaa"/);
  assert.deepEqual(f.reads(), afterRead);
  f.advance(5000); const stale = await f.assemble();
  assert.equal(renderContextSections(stale).find(x => x.name === SECTION).text, runtimeCapabilitiesFallback);
  assert.deepEqual(f.reads(), afterRead); assert.equal(renderPrompt(stale), renderPrompt(before));
});

test('real SDK enforces output schema instead of accepting malformed successful capability output', { timeout: 5000 }, async t => {
  const f = await fixture(t, { snapshotOverride: async () => ({ version: 'invalid', timestamp: 0 }) });
  const result = await f.call(); assert.equal(result.isError, true); assert.deepEqual(f.snapshotRoots, [ownRoot]);
});

test('real SDK rejects stale admitted access after managed project removal without reading another project', { timeout: 5000 }, async t => {
  const f = await fixture(t), signal = AbortSignal.timeout(3000), toolSet = await f.ctx.tools.resolve({ agent: f.child, signal });
  try {
    delete f.manager.data.sessions.owner;
    const batch = await f.ctx.tools.execute({ agent: f.child, signal, toolSet, calls: [{ id: randomUUID(), name: NAME, arguments: '{}' }] });
    assert.equal(batch.results[0].result.isError, true); assert.deepEqual(f.snapshotRoots, []);
  } finally { toolSet.dispose(); }
});
