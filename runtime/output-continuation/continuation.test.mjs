import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as continuation from './index.mjs';
import { recordFileDelivery } from './file-delivery.mjs';
import * as fifo from '../../vast/turn-queue/plugin.mjs';

const sdk = process.env.EFFICIENCY_SDK_ROOT ?? '/data/harness/runtime/node_modules';
const load = name => import(pathToFileURL(path.join(sdk, '@deepseek-ai', name, 'lib/index.js')).href);
const [{ Context }, { default: Sessions }, { default: Agents }, { default: Projections }, { default: Llm, LlmAdapter },
  { default: SystemPrompt }, { default: Tools }, { default: AgentLoop }, { NativeToolExecutor }] = await Promise.all(
  ['cordis', 'dsh-session', 'dsh-agent', 'dsh-session-projection', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools',
    'dsh-agent-loop', 'dsh-tool-executor-native'].map(load));
const providers = ['native-length-fixture', 'basalt-length-fixture'];
const note = /\[Output limit recovery\]/u;
const input = { id: 'original', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Finish the inert task' }] };
const text = (value, index = 0) => ({ type: 'text-delta', index, text: value });
const finish = kind => ({ type: 'finish', reason: { kind } });
const call = (id, action, index = 0) => ({
  type: 'block-end', index, block: { type: 'tool-call', id, name: 'fixture_change', arguments: JSON.stringify({ action }) },
});
const terminal = (events, id) => events.filter(row => row.id === id && row.event.type === 'turn/end').map(row => row.event.data.reason.kind);
const matching = (events, id, type) => events.filter(row => row.id === id && row.event.type === type).map(row => row.event.data);
function hasRecovery(request) {
  return request.messages.some(message => message.role === 'system' && message.content.some(block => block.type === 'text' && note.test(block.text)));
}
async function active(fibers) {
  const end = performance.now() + 4000;
  while (fibers.some(fiber => fiber.state !== 2)) {
    await Promise.all(fibers.map(fiber => fiber.await()));
    assert(performance.now() < end, 'Pinned SDK services failed to activate');
    await new Promise(resolve => setImmediate(resolve));
  }
}
async function fixture(t, script, { queued = false, gate, fileRoot, fileAction, fileCwd } = {}) {
  const ctx = new Context(), events = [], requests = [], operations = [];
  let fixed = false;
  t.after(async () => {
    for (const agent of ctx.agents.list()) agent.cancel({ kind: 'user' });
    await ctx.fiber.dispose();
  });
  await active([Sessions, Agents, Projections, Llm, SystemPrompt, Tools].map(plugin => ctx.plugin(plugin, {})));
  // The same packaged terminal resolves the actual SDK from the profile anchor.
  ctx.provide('profileContext', { installAnchor: path.join(sdk, '@deepseek-ai/dsh/package.json') });
  await active([ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })]);
  ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  if (fileRoot) {
    const [{ LocalFileSystem }, toolFs] = await Promise.all([load('dsh-fs-local'), load('dsh-tool-fs')]);
    ctx.provide('workingDirectory', { ensure: async () => fileCwd ? fileCwd() : fileRoot });
    new LocalFileSystem(ctx, { cwd: fileRoot, diffBasisMaxBytes: 1024 * 1024 });
    await active([ctx.plugin(toolFs, { readImage: false })]);
    if (fileAction) await active([ctx.plugin(await load('dsh-tool-present'), {})]);
  }
  ctx.tools.register({
    name: 'fixture_change', description: 'Inert local workspace fixture',
    parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.status }] },
    async execute({ action }) {
      operations.push(action);
      await fileAction?.(action);
      if (action === 'fix') fixed = true;
      return { status: action === 'test' && !fixed ? 'test is red' : action === 'test' ? 'test is green' : 'committed' };
    },
  });
  class Inert extends LlmAdapter {
    async *stream(request) {
      requests.push(request);
      yield* script(request, requests.filter(row => row.sessionId === request.sessionId).length);
    }
  }
  ctx.llm.registerAdapter(providers, new Inert());
  ctx.on('session/event', (session, event) => events.push({ id: session.id, event: structuredClone(event) }), { global: true });
  const modules = [ctx.plugin(continuation, {})];
  if (queued) modules.push(ctx.plugin(fifo, { providers }));
  await active(modules);
  if (gate) ctx.on('agent/pre-step', gate, { prepend: true, global: true });
  async function create(id, provider = providers[0]) {
    return (await ctx.agents.create({ sessionId: id, meta: { cwd: fileRoot ?? process.cwd() }, agentOptions: { provider, model: 'inert' } })).agent;
  }
  return { ctx, events, requests, operations, create };
}

for (const provider of providers) test('length preserves the answer, usage, and same-turn completion for ' + provider, { timeout: 12000 }, async t => {
  const f = await fixture(t, function* (request, step) {
    if (step === 1) {
      yield text('Saved fragment');
      yield { type: 'tool-call-delta', index: 1, id: 'cut', name: 'fixture_change', argumentsDelta: '{"action":' };
      yield { type: 'usage', usage: { inputTokens: 17, outputTokens: 8192, totalTokens: 8209 } };
      yield finish('max-tokens');
      return;
    }
    assert(hasRecovery(request));
    assert(request.messages.some(message => message.role === 'assistant' && message.content.some(block => block.text === 'Saved fragment')));
    yield text('Completed suffix');
    yield finish('stop');
  });
  const agent = await f.create('resume', provider);
  agent.followup(input);
  await agent.whenIdle();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(terminal(f.events, agent.id), ['completed']);
  assert.deepEqual(f.operations, []);
  const messages = matching(f.events, agent.id, 'assistant/message');
  assert.deepEqual(messages.map(row => row.message.content.map(block => block.type)), [['text'], ['text']]);
  assert.equal(messages[0].usage.outputTokens, 8192);
  assert.equal(matching(f.events, agent.id, 'turn/start').length, 1);
  assert.deepEqual(matching(f.events, agent.id, 'user/message').filter(row => row.source.kind === 'user').map(row => row.id), ['original']);
  assert.equal(matching(f.events, agent.id, 'user/message').some(row => row.source.kind === 'homeai-output-continuation'), false);
});

test('recovery drops replayed call IDs but permits a fresh verification after a committed change', { timeout: 12000 }, async t => {
  const f = await fixture(t, function* (request, step) {
    if (step === 1) yield call('initial-test', 'test');
    if (step === 2) {
      assert(request.messages.some(message => message.role === 'tool' && message.content.some(block => block.text === 'test is red')));
      yield text('The test is red.');
      yield finish('max-tokens');
      return;
    }
    if (step === 3) {
      assert(hasRecovery(request));
      yield call('initial-test', 'test');
      yield call('fix', 'fix', 1);
    }
    if (step === 4) yield call('verify-new', 'test');
    if (step === 5) {
      assert(request.messages.some(message => message.role === 'tool' && message.content.some(block => block.text === 'test is green')));
      yield text('The corrected project passes the test.');
      yield finish('stop');
      return;
    }
    yield finish('tool-calls');
  });
  const agent = await f.create('verify');
  agent.followup(input);
  await agent.whenIdle();
  assert.deepEqual(f.operations, ['test', 'fix', 'test']);
  assert.deepEqual(terminal(f.events, agent.id), ['completed']);
});

test('thinking-only truncations are bounded and a thinking-only stop stays incomplete', { timeout: 12000 }, async t => {
  const f = await fixture(t, function* (request, step) {
    if (step > 1) assert(hasRecovery(request));
    yield { type: 'reasoning-delta', index: 0, text: 'Inert incomplete reasoning' };
    yield finish(request.sessionId === 'empty-stop' && step === 2 ? 'stop' : 'max-tokens');
  });
  const cut = await f.create('ceiling'), empty = await f.create('empty-stop');
  cut.followup(input);
  await cut.whenIdle();
  empty.followup(input);
  await empty.whenIdle();
  assert.deepEqual(f.requests.map(row => row.sessionId), ['ceiling', 'ceiling', 'ceiling', 'empty-stop', 'empty-stop']);
  assert.deepEqual(terminal(f.events, cut.id), ['max-tokens']);
  assert.deepEqual(terminal(f.events, empty.id), ['max-tokens']);
  assert.equal(matching(f.events, cut.id, 'assistant/message').length, 3);
});

test('productive steps reset the stall counter and the entire turn still has a ceiling', { timeout: 12000 }, async t => {
  const f = await fixture(t, function* (_request, step) {
    // One stalled recovery before each tool step must be cleared by that
    // step. Otherwise the second cycle would reach the consecutive cap.
    if (step % 3 === 0) {
      yield call('progress-' + step, 'fix');
      yield finish('tool-calls');
    } else {
      yield { type: 'reasoning-delta', index: 0, text: 'Inert cap' };
      yield finish('max-tokens');
    }
  });
  const agent = await f.create('long');
  agent.followup(input);
  await agent.whenIdle();
  assert.equal(f.requests.length, 13);
  assert.deepEqual(f.operations, ['fix', 'fix', 'fix', 'fix']);
  assert.deepEqual(terminal(f.events, agent.id), ['max-tokens']);
});

test('the normal pre-step gate can refuse recovery before another model request', { timeout: 12000 }, async t => {
  let steps = 0;
  const f = await fixture(t, function* () { yield text('Saved before budget gate'); yield finish('max-tokens'); }, {
    gate: async (_input, next) => ++steps > 1 ? { kind: 'reject' } : next(),
  });
  const agent = await f.create('budget');
  agent.followup(input);
  await agent.whenIdle();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(terminal(f.events, agent.id), ['blocked']);
  assert.equal(matching(f.events, agent.id, 'assistant/message')[0].message.content[0].text, 'Saved before budget gate');
});

test('Stop cancels recovery while FIFO retains ownership until the original turn ends', { timeout: 12000 }, async t => {
  const first = Promise.withResolvers(), allowCut = Promise.withResolvers(), recovering = Promise.withResolvers();
  const f = await fixture(t, async function* (request, step) {
    if (request.sessionId === 'queued') { yield text('FIFO successor'); yield finish('stop'); return; }
    if (step === 1) {
      first.resolve();
      await allowCut.promise;
      yield text('Saved before Stop');
      yield finish('max-tokens');
      return;
    }
    recovering.resolve();
    if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
  }, { queued: true });
  const owner = await f.create('owner'), successor = await f.create('queued', providers[1]);
  owner.followup(input);
  await first.promise;
  successor.followup({ ...input, id: 'queued-input' });
  allowCut.resolve();
  await recovering.promise;
  assert.deepEqual(f.requests.map(row => row.sessionId), ['owner', 'owner']);
  owner.cancel({ kind: 'user' });
  await Promise.all([owner.whenIdle(), successor.whenIdle()]);
  assert.deepEqual(f.requests.map(row => row.sessionId), ['owner', 'owner', 'queued']);
  assert.deepEqual(terminal(f.events, owner.id), ['aborted']);
  assert.deepEqual(terminal(f.events, successor.id), ['completed']);
});

test('cut-off content-first write recovers to real working HTML without overwrites or duplicate edits', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-output-file-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'kept.html'), '<p>Keep this existing file</p>');
  const anchor = '<!-- script anchor -->';
  const seed = '<!doctype html><html lang="en"><title>Counter</title><main><button>Increment</button><output>0</output></main>' + anchor + '</html>';
  const script = '<script>let count=0;document.querySelector("button").onclick=()=>{document.querySelector("output").textContent=++count;};</script>';
  const fileCall = (id, name, args, index = 0) => ({
    type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) },
  });
  const patch = { file_path: 'index.html', old_string: anchor, new_string: anchor + script };
  let gates = 0;
  const f = await fixture(t, async function* (request, step) {
    if (step === 1) {
      const write = request.tools.find(tool => tool.name === 'write');
      assert.match(write.description, /Send file_path first.*small complete usable file.*extend it with edit/u);
      assert.equal(write.parameters.properties.content.maxLength, undefined);
      assert(!request.messages.some(message => message.role === 'system' && message.content.some(block =>
        block.type === 'text' && block.text.includes('[File write recovery]'))));
      yield { type: 'tool-call-delta', index: 0, id: 'cut-content', name: 'write', argumentsDelta: '{"content":"<!doctype html>' + 'x'.repeat(16000) };
      yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 8192, totalTokens: 8692 } };
      yield finish('max-tokens');
      return;
    }
    assert(request.messages.some(message => message.role === 'system' && message.content.some(block =>
      block.type === 'text' && block.text.includes('[File write recovery]'))), 'plan must remain through all subsequent steps');
    const write = request.tools.find(tool => tool.name === 'write').parameters;
    assert.equal(Object.keys(write.properties)[0], 'file_path');
    assert.equal(write.properties.content.maxLength, 768);
    if (step === 2) { yield finish('stop'); return; }
    if (step === 3) yield fileCall('too-large', 'write', { file_path: 'oversized.html', content: 'x'.repeat(769) });
    if (step === 4) yield fileCall('collision', 'write', { file_path: 'kept.html', content: '<p>Overwrite attempt</p>' });
    if (step === 5) yield fileCall('seed', 'write', { file_path: 'index.html', content: seed });
    if (step === 6) {
      assert.equal(await fs.readFile(path.join(directory, 'index.html'), 'utf8'), seed);
      yield fileCall('insert-handler', 'edit', patch);
    }
    if (step === 7) {
      assert((await fs.readFile(path.join(directory, 'index.html'), 'utf8')).includes(script));
      await fs.symlink('index.html', path.join(directory, 'linked.html'));
      yield fileCall('duplicate-handler', 'edit', patch);
      yield fileCall('absolute-handler', 'edit', { ...patch, file_path: path.join(directory, 'index.html') }, 1);
      yield fileCall('guest-alias-handler', 'edit', { ...patch, file_path: '/workspace/index.html' }, 2);
      yield fileCall('symlink-handler', 'edit', { ...patch, file_path: 'linked.html' }, 3);
    }
    if (step === 8) yield fileCall('set-title', 'edit', { file_path: 'index.html', old_string: '<title>Counter</title>', new_string: '<title>Working counter</title>' });
    if (step === 9) { yield text('Saved the working counter in index.html.'); yield finish('stop'); return; }
    assert(step <= 9, 'unexpected request past the expected turn');
    yield finish('tool-calls');
  }, { fileRoot: directory, gate: async (_input, next) => { gates++; return next(); } });
  const agent = await f.create('working-file', providers[1]);
  agent.followup(input);
  await agent.whenIdle();
  assert.equal(f.requests.length, 9);
  assert(gates >= 9, 'each recovery and edit passed through the ordinary pre-step gate');
  assert.deepEqual(terminal(f.events, agent.id), ['completed']);
  assert.equal(matching(f.events, agent.id, 'turn/start').length, 1);
  assert.deepEqual(matching(f.events, agent.id, 'user/message').filter(row => row.source.kind === 'user').map(row => row.id), ['original']);
  assert.equal(await fs.readFile(path.join(directory, 'kept.html'), 'utf8'), '<p>Keep this existing file</p>');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['index.html', 'kept.html', 'linked.html']);
  const toolResults = matching(f.events, agent.id, 'tool/result').map(row => row.message.isError);
  assert.deepEqual(toolResults, [true, true, false, false, true, true, true, true, false]);
  const html = path.join(directory, 'index.html');
  assert.equal((await fs.readFile(html, 'utf8')).split(script).length, 2, 'the edit was applied once');
  const { chromium } = createRequire(import.meta.url)(process.env.HARNESS_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(html).href);
    assert.equal(await page.title(), 'Working counter');
    await page.getByRole('button', { name: 'Increment' }).click();
    await page.getByRole('button', { name: 'Increment' }).click();
    assert.equal(await page.locator('output').innerText(), '2');
  } finally { await browser.close(); }
});

test('actual SDK present confirms an alternative write only when a new or changed file was delivered', {
  timeout: 45000, skip: process.platform !== 'linux',
}, async t => {
  const original = '<p>old</p>', updated = '<p>new</p>';
  for (const [label, steps, expected] of [
    ['new file after three writes', ['seed', 'append', 'close', 'present-new'], 'completed'],
    ['changed file with the same size', ['change', 'present-old'], 'completed'],
    ['ordinary successful tool', ['noop'], 'max-tokens'],
    ['new file without presentation', ['seed'], 'max-tokens'],
    ['empty presentation', ['seed', 'present-empty'], 'max-tokens'],
    ['old file with only a metadata change', ['touch', 'present-old'], 'max-tokens'],
    ['unchanged file presented before a later mutation', ['present-old', 'change'], 'max-tokens'],
    ['presentation before a mutation in the same assistant batch', ['present-then-change'], 'max-tokens'],
    ['mutation before presentation in the same assistant batch', ['change-then-present'], 'completed'],
    ['changed private key', ['key', 'present-key'], 'max-tokens'],
    ['symlinked project path', ['seed', 'present-linked'], 'max-tokens'],
    ['cwd changed after delivery', ['seed', 'present-new', 'relocate'], 'max-tokens'],
    ['presented artifact removed before the final answer', ['seed', 'present-new', 'remove'], 'max-tokens'],
    ['Stop during terminal delivery verification', ['seed', 'present-new'], 'aborted'],
  ]) await t.test(label, async child => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-native-present-')));
    child.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'out'));
    await fs.mkdir(path.join(root, 'other'));
    await fs.symlink('out', path.join(root, 'linked'));
    const fresh = path.join(root, 'out', 'index.html'), existing = path.join(root, 'existing.html');
    const secret = path.join(root, 'private.key');
    await fs.writeFile(existing, original);
    await fs.writeFile(secret, 'SYNTHETIC-ORIGINAL');
    let cwd = root, agent, stopDuringVerification = false;
    const actions = {
      seed: () => fs.writeFile(fresh, '<!doctype html><html><body>'),
      append: () => fs.appendFile(fresh, updated),
      close: () => fs.appendFile(fresh, '</body></html>'),
      change: () => fs.writeFile(existing, updated),
      touch: () => fs.utimes(existing, new Date(1000), new Date(1000)),
      remove: () => fs.unlink(fresh),
      key: () => fs.writeFile(secret, 'SYNTHETIC-CHANGED'),
      relocate: () => { cwd = path.join(root, 'other'); },
    };
    const paths = { 'present-new': 'out/index.html', 'present-old': 'existing.html', 'present-key': 'private.key', 'present-linked': 'linked/index.html' };
    const present = (action, index = 0) => {
      const files = action === 'present-empty' ? [] : [{ path: paths[action] }];
      return { type: 'block-end', index, block: { type: 'tool-call', id: action, name: 'present', arguments: JSON.stringify({ files }) } };
    };
    const f = await fixture(child, function* (_request, step) {
      if (step === 1) {
        yield { type: 'tool-call-delta', index: 0, id: 'cut-write', name: 'write', argumentsDelta: '{"content":"' };
        yield finish('max-tokens');
        return;
      }
      const action = steps[step - 2];
      if (!action) {
        if (expected === 'aborted') stopDuringVerification = true;
        if (expected === 'max-tokens') yield text('I have finished.');
        yield finish('stop');
        return;
      }
      if (action === 'present-then-change') {
        yield present('present-old');
        yield call('change', 'change', 1);
      } else if (action === 'change-then-present') {
        yield call('change', 'change');
        yield present('present-old', 1);
      } else if (action.startsWith('present-')) {
        yield present(action);
      } else yield call(action, action);
      yield finish('tool-calls');
    }, { fileRoot: root, fileAction: action => actions[action]?.(), fileCwd: () => {
      if (stopDuringVerification) agent.cancel({ kind: 'user' });
      return cwd;
    } });
    agent = await f.create('delivery', providers[1]);
    agent.followup(input);
    await agent.whenIdle();
    assert.deepEqual(terminal(f.events, agent.id), [expected]);
    assert.equal(matching(f.events, agent.id, 'turn/start').length, 1);
    const deliveries = matching(f.events, agent.id, 'deliverables/presented');
    const presented = steps.find(step => Object.hasOwn(paths, step)) ??
      (steps.some(step => step.endsWith('-then-present') || step.endsWith('-then-change')) ? 'present-old' : null);
    assert.equal(deliveries.length, presented ? 1 : 0);
    if (presented) assert.equal(deliveries[0].files[0].path, await fs.realpath(path.join(root, paths[presented])).catch(() => fresh));
    if (expected === 'completed') assert.match(await fs.readFile(deliveries[0].files[0].path, 'utf8'), /<p>new<\/p>/u);
  });
});

test('presenting identical bytes again updates the retained version without counting progress twice', () => {
  const file = '/project/index.html';
  const first = { version: 'first', hash: 'same-bytes' };
  const second = { version: 'second', hash: first.hash };
  const delivery = { pending: new Map(), verified: new Map(), credited: new Set() };
  const record = (callId, proof) => {
    delivery.pending.set(callId, new Map([[file, proof]]));
    return recordFileDelivery(delivery, { callId, files: [{ path: file }] });
  };
  assert.equal(record('first', first), true);
  assert.equal(record('second', second), false);
  assert.equal(delivery.verified.get(file), second);
  assert.equal(delivery.credited.size, 1);
});
