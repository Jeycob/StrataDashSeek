'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');

const run = promisify(execFile);
const modelId = 'inkling-2-mini';
const providerId = 'basalt-local';
const baseURL = 'http://127.0.0.1:8080/v1';
const model = {
  id: modelId, object: 'model', owned_by: 'basalt', status: { value: 'loaded' },
  meta: { n_ctx: 131072 }, architecture: { input_modalities: ['text', 'image'] },
};

test('lab launchers reject unsupported actions before installation or GPU access', async () => {
  for (const name of ['engine.sh', 'harness.sh']) {
    const script = path.join(__dirname, name);
    await run('bash', ['-n', script]);
    await assert.rejects(run('bash', [script, 'unknown']), error => error.code === 1 && /Usage:/.test(error.stderr));
  }
});

// Emulate Basalt's OpenAI event stream; the SDK builds and decodes both requests.
function completion(response, index) {
  const toolCall = { index: 0, id: 'call_lab_1', type: 'function',
    function: { name: 'lookup_fixture', arguments: '{"key":"ink"}' } };
  const send = (delta, finish_reason) => {
    const chunk = { id: 'chatcmpl-lab-' + index, object: 'chat.completion.chunk', model: modelId,
      created: 1, choices: [{ index: 0, delta, finish_reason }] };
    response.write('data: ' + JSON.stringify(chunk) + '\n\n');
  };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const output = ['Read ink.', 'Partial fixture.', 'Finished fixture.'];
  send(index === 0 ? { role: 'assistant', tool_calls: [toolCall] } : { role: 'assistant', content: output[index - 1] }, null);
  send({}, index === 0 ? 'tool_calls' : index === 2 ? 'length' : 'stop');
  response.end('data: [DONE]\n\n');
}

test('actual web profile binds only verified Inkling and round-trips a streamed tool call', async t => {
  const lab = await fs.mkdtemp(path.join(os.tmpdir(), 'basalt-harness-'));
  t.after(() => fs.rm(lab, { recursive: true, force: true }));
  const runtime = path.join(lab, 'runtime');
  const sourceRuntime = path.resolve(__dirname, '../../runtime');
  // Exercise the minimal release archive layout, with the SDK installed separately.
  const release = path.join(lab, 'extracted lab release');
  const releaseRuntime = path.join(release, 'runtime');
  const launchers = path.join(release, 'experiments', 'basalt-inkling');
  await fs.mkdir(releaseRuntime, { recursive: true });
  await fs.mkdir(launchers, { recursive: true });
  for (const file of ['harness.sh', 'profile.mjs']) {
    await fs.copyFile(path.join(__dirname, file), path.join(launchers, file));
  }
  await fs.copyFile(path.join(sourceRuntime, 'require.cjs'), path.join(releaseRuntime, 'require.cjs'));
  await fs.cp(path.join(sourceRuntime, 'output-continuation'),
    path.join(releaseRuntime, 'output-continuation'), { recursive: true });
  await fs.mkdir(runtime);
  for (const manifest of ['package.json', 'package-lock.json']) {
    await fs.copyFile(path.join(sourceRuntime, manifest), path.join(runtime, manifest));
    await fs.copyFile(path.join(sourceRuntime, manifest), path.join(releaseRuntime, manifest));
  }
  await fs.symlink(path.join(sourceRuntime, 'node_modules'), path.join(runtime, 'node_modules'), 'dir');
  const sdk = createRequire(path.join(sourceRuntime, 'package.json'));
  const load = name => import(pathToFileURL(sdk.resolve('@deepseek-ai/' + name)).href);
  const env = {
    PATH: process.env.PATH, HOME: path.join(lab, 'ordinary-home'), BASALT_LAB_HOME: lab,
    // A caller's route and credentials must not make another provider available.
    OPENAI_BASE_URL: 'http://127.0.0.1:1', OPENAI_API_KEY: 'synthetic-unrelated-key',
    DEEPSEEK_API_KEY: 'synthetic-unrelated-key', BASALT_LOOPBACK_KEY: 'synthetic-unrelated-key',
  };
  const dump = () => run('bash', [path.join(launchers, 'harness.sh'), 'config'], {
    env, timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  });
  let listing = [model];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: listing }));
    } else if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ body: JSON.parse(Buffer.concat(chunks)), authorization: req.headers.authorization });
      completion(res, requests.length - 1);
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(8080, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));

  const { stdout } = await dump();
  const document = sdk('yaml').parseDocument(stdout);
  assert.deepEqual(document.errors, []);
  const entries = document.toJS();
  const row = id => {
    const matches = entries.filter(entry => entry.id === id);
    assert.equal(matches.length, 1, id);
    return matches[0];
  };
  for (const id of ['llm-deepseek', 'llm-deepseek-account', 'web-search-deepseek', 'web-deepseek-api', 'session-title-llm']) {
    assert.equal(row(id).disabled, true, id);
  }
  const defaults = row('agent-default-model').config;
  assert.equal(defaults.provider, providerId);
  assert.equal(defaults.model, modelId);
  const adapter = row('llm-pi-ai');
  assert.equal(adapter.name, '@deepseek-ai/dsh-llm-pi-ai');
  assert.notEqual(adapter.disabled, true);
  assert.deepEqual(Object.keys(adapter.config.providers), [providerId]);
  const route = adapter.config.providers[providerId];
  assert.equal(route.baseURL, baseURL);
  assert.equal(route.apiKeyEnv, 'BASALT_LOOPBACK_KEY');
  assert.equal(row('workspace-controller').config.documentsDirectory, path.join(lab, 'projects'));
  const continuation = row('homeai-output-continuation');
  assert.equal(continuation.name, pathToFileURL(path.join(releaseRuntime, 'output-continuation', 'index.mjs')).href);
  assert.notEqual(continuation.disabled, true);

  // Capture the final web exec without opening a server or running an agent.
  // Delegate the Node version check and profile generation to the real binary.
  const shim = path.join(lab, 'bin');
  await fs.mkdir(shim);
  await fs.writeFile(path.join(shim, 'node'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[1] === 'web') {
  const { HOME, DSH_HOME, BASALT_LOOPBACK_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, OPENAI_BASE_URL } = process.env;
  console.log(JSON.stringify({ args, HOME, DSH_HOME, BASALT_LOOPBACK_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, OPENAI_BASE_URL }));
} else {
  process.exit(require('node:child_process').spawnSync(process.execPath, args, { stdio: 'inherit' }).status ?? 1);
}
`, { mode: 0o700 });
  const start = await run('bash', [path.join(launchers, 'harness.sh')], {
    env: { ...env, PATH: shim + path.delimiter + env.PATH }, timeout: 15000,
  });
  const handoff = JSON.parse(start.stdout);
  assert.deepEqual(handoff, {
    args: [path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', path.join(lab, 'basalt.patch.yml'),
      '--no-open', '--host', '127.0.0.1', '--port', '8787', '--public-url', 'http://127.0.0.1:8787/'],
    HOME: path.join(lab, 'home'), DSH_HOME: path.join(lab, 'home/.dsh'), BASALT_LOOPBACK_KEY: 'local-only',
  });

  // Mount the provider portion of the dumped web profile on the actual SDK registry.
  const [{ Context }, llm, pi, launch] = await Promise.all([
    load('cordis'), load('dsh-llm'), load('dsh-llm-pi-ai'), load('dsh-launch-environment'),
  ]);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  new llm.default(ctx);
  ctx.provide('launchEnvironment', launch.createLaunchEnvironmentSnapshot([
    { source: 'process', values: { BASALT_LOOPBACK_KEY: handoff.BASALT_LOOPBACK_KEY } },
  ]));
  pi.apply(ctx, pi.Config(adapter.config));
  assert.deepEqual(ctx.llm.listProviders().map(row => row.id), [providerId]);
  assert.deepEqual((await ctx.llm.listModels(providerId)).map(row => row.id), [modelId]);
  const info = await ctx.llm.resolveModelInfo(providerId, modelId);
  assert.deepEqual(info.inputModalities, ['text', 'image']);
  assert.equal(info.context.contextWindow, model.meta.n_ctx);
  assert.equal(info.defaultMaxTokens, 8192);

  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Read the ink fixture.' }] }];
  const tool = { name: 'lookup_fixture', description: 'Read a synthetic value.',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } };
  const stream = () => Array.fromAsync(ctx.llm.stream({
    ...defaults, messages, tools: [tool], maxTokens: info.defaultMaxTokens, signal: AbortSignal.timeout(5000),
  }));
  const first = await stream();
  assert.deepEqual(first.at(-1).reason, { kind: 'tool-calls' });
  const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block;
  assert.equal(call.name, tool.name);
  assert.deepEqual(JSON.parse(call.arguments), { key: 'ink' });
  messages.push(llm.createAssistantMessage({ source: defaults, content: [call] }),
    llm.createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'fixture result' }], isError: false }));
  const second = await stream();
  assert.equal(second.at(-1).reason.kind, 'stop');
  assert(second.some(chunk => chunk.type === 'block-end' && chunk.block.text === 'Read ink.'));
  assert.equal(requests.length, 2);
  for (const { body, authorization } of requests) {
    assert.equal(authorization, 'Bearer local-only');
    assert.equal(body.model, modelId);
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.thinking_budget_tokens, 1024);
    assert.deepEqual(body.tools.map(tool => tool.function.name), [tool.name]);
  }
  const result = requests[1].body.messages.find(message => message.role === 'tool');
  assert.equal(result.tool_call_id, call.id);
  assert.equal(result.content, 'fixture result');

  // A previous good dump must not let a later bad server silently through.
  for (const badListing of [[], [{ ...model, id: 'other' }], [{ ...model, status: { value: 'loading' } }],
    [{ ...model, owned_by: 'other' }], [{ ...model, architecture: { input_modalities: ['text'] } }]]) {
    listing = badListing;
    await assert.rejects(dump(), error => error.code === 1 && error.stdout === '' && /Basalt|Inkling|inkling/.test(error.stderr));
  }
  assert.equal(requests.length, 2, 'No inference request during discovery');
  listing = [model];
  const proof = path.join(lab, 'output-continuation.proof');
  await run(process.execPath, [path.join(__dirname, 'fixtures/output-continuation.mjs'), runtime, releaseRuntime,
    path.join(lab, 'basalt.patch.yml'), proof], {
    cwd: path.join(lab, 'projects/deepseek-harness/default-workspace'), timeout: 35_000,
    env: { PATH: process.env.PATH, HOME: handoff.HOME, DSH_HOME: handoff.DSH_HOME,
      BASALT_LOOPBACK_KEY: 'local-only', DSH_TELEMETRY_DISABLED: '1' },
  });
  assert.equal(await fs.readFile(proof, 'utf8'), 'same-turn recovery and served web client\n');
  assert.deepEqual(requests.slice(2).map(row => row.body.model), [modelId, modelId]);
  const fileRecovery = path.join(releaseRuntime, 'output-continuation', 'file-recovery.mjs');
  await fs.rename(fileRecovery, fileRecovery + '.missing');
  await assert.rejects(dump(), error => error.code === 1 && /must include runtime\/output-continuation/.test(error.stderr));
});
