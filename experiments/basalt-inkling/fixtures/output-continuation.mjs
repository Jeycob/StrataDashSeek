// Owned child of launcher.test.cjs. Boot the separated SDK with the actual lab overlay.
import assert from 'node:assert/strict';
import { realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [runtime, releaseRuntime, overlay, proof] = process.argv.slice(2);
const sdk = createRequire(path.join(runtime, 'package.json'));
const load = name => import(pathToFileURL(sdk.resolve(name)).href);
const [{ runProfile }, { createLaunchEnvironmentSnapshot }] = await Promise.all([
  load('@deepseek-ai/dsh/profile-boot'), load('@deepseek-ai/dsh-launch-environment'),
]);
const { ctx, shutdown } = await runProfile({
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
  profile: 'web', patchFiles: [overlay], args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
});
let exitCode = 1;
try {
  assert.equal(await realpath(ctx.get('profileContext').installAnchor),
    await realpath(sdk.resolve('@deepseek-ai/dsh/package.json')));
  const client = ctx.clientModules.graph().entries.find(entry => entry.id === '@stratadashseek/output-continuation');
  assert.ok(client, 'The running web profile must register the recovery client');
  assert.equal(await realpath(ctx.clientModules.clientPath(client.id)),
    await realpath(path.join(releaseRuntime, 'output-continuation', 'client.js')));
  const response = await ctx.clientModules.fetchBundle(new Request(new URL(client.url, 'http://127.0.0.1/')));
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes(client.id));

  const sessionId = 'basalt-output-limit-fixture';
  const events = [];
  ctx.on('session/event', (session, event) => {
    if (session.id === sessionId) events.push(event);
  }, { global: true });
  const { agent } = await ctx.agents.create({
    sessionId, meta: { cwd: process.cwd(), isSeeded: true, agentPreset: 'standard' },
    seed: [], inheritedEventCount: 0, agentOptions: { provider: 'basalt-local', model: 'inkling-2-mini', reasoningEffort: 'low' },
  });
  agent.followup({ role: 'user', id: 'single-input', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Finish the synthetic lab fixture.' }] });
  await agent.whenIdle();
  const humanMessages = events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user');
  assert.deepEqual(humanMessages.map(e => e.data.id), ['single-input']);
  const queued = events.filter(e => e.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted);
  assert.equal(queued.some(message => message.source?.kind === 'homeai-output-continuation'), false);
  assert.equal(events.filter(e => e.type === 'turn/start').length, 1);
  assert.deepEqual(events.filter(e => e.type === 'turn/end').map(e => e.data.reason.kind), ['completed']);
  const output = events.filter(e => e.type === 'assistant/message')
    .flatMap(e => e.data.message.content).filter(block => block.type === 'text').map(block => block.text);
  assert.deepEqual(output, ['Partial fixture.', 'Finished fixture.']);
  await writeFile(proof, 'same-turn recovery and served web client\n', { flag: 'wx' });
  exitCode = 0;
} finally {
  await shutdown.shutdown(exitCode);
}
