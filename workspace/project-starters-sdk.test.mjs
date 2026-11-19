import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { hostExecutionBinding } from './fixtures/execution-binding.mjs';
import { createProjectStarters, installProjectStarterDiscovery } from './project-starters.mjs';
import { registerProjectTool } from './project-tool.mjs';

const sdk = process.env.EFFICIENCY_SDK_ROOT ?? '/data/harness/runtime/node_modules';
const load = name => import(pathToFileURL(path.join(sdk, '@deepseek-ai', name, 'lib/index.js')).href);
const [{ Context }, { default: Sessions }, { default: Agents }, { default: Projections },
  { default: Llm, LlmAdapter, createUserMessage }, { default: SystemPrompt }, { default: Tools },
  { default: AgentLoop }, { NativeToolExecutor }] = await Promise.all([
  'cordis', 'dsh-session', 'dsh-agent', 'dsh-session-projection', 'dsh-llm',
  'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop', 'dsh-tool-executor-native',
].map(load));

test('ordinary pinned SDK user ingress offers and applies the starter in one turn, with unrelated context unchanged',
  { timeout: 15000 }, async t => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-starter-sdk-test-'));
    const ctx = new Context();
    t.after(async () => {
      await ctx.fiber.dispose();
      const real = await fs.realpath(tmp);
      assert.equal(path.dirname(real), await fs.realpath(os.tmpdir()));
      assert.ok(path.basename(real).startsWith('homeai-starter-sdk-test-'));
      await fs.rm(real, { recursive: true, force: true });
    });
    const plugins = [Sessions, Agents, Projections, Llm, SystemPrompt, Tools].map(plugin => ctx.plugin(plugin, {}));
    const loop = ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    await ctx.plugin({ name: 'starter-sdk-ready', inject: ['sessions', 'agents', 'sessionProjections', 'llm',
      'tools', 'systemPrompt', 'agentLoop'], apply() {} }).await();
    const until = Date.now() + 3000;
    while ([...plugins, loop].some(plugin => plugin.state !== 2)) {
      assert.ok(Date.now() < until);
      await Promise.all([...plugins, loop].map(plugin => plugin.await()));
      await new Promise(resolve => setImmediate(resolve));
    }
    ctx.tools.setExecutor(new NativeToolExecutor(ctx));
    const manager = { execution: hostExecutionBinding(), data: { sessions: {} }, ownerAgent: agent => agent,
      independentRecord: project => project?.independentRepository === true };
    manager.projectStarters = createProjectStarters(manager);
    installProjectStarterDiscovery(ctx, manager.projectStarters);
    const writes = [];
    registerProjectTool(ctx, manager, async (args, execution) => {
      const root = manager.data.sessions[execution.agent.id].root;
      const [, program, payload] = args.command.match(/^node -e "([^"]+)" (\S+)$/u);
      const child = spawnSync(process.execPath, ['-e', program, payload], { cwd: root, encoding: 'utf8' });
      assert.ifError(child.error);
      writes.push({ id: execution.agent.id, exitCode: child.status });
      return { cwd: root, result: { exitCode: child.status, stdout: { text: child.stdout },
        stderr: { text: child.stderr }, timedOut: false } };
    });
    const requests = [];
    class ScriptedModel extends LlmAdapter {
      async *stream(request) {
        const content = JSON.stringify(request.messages);
        const offer = content.includes('For this task HomeAI has');
        requests.push({ offer, content, tools: request.tools?.map(tool => tool.name) });
        if (offer && !writes.length) {
          yield { type: 'tool-call-delta', index: 0, id: 'fixture-starter-call', name: 'project_exec',
            argumentsDelta: JSON.stringify({ command: 'homeai-starter', description: 'Apply the offered starter' }) };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'text-delta', index: 0, text: 'Fixture finished.' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }
    ctx.llm.registerAdapter(['starter-fixture'], new ScriptedModel());
    async function submit(id, prompt) {
      const root = path.join(tmp, id);
      await fs.mkdir(root);
      const { agent } = await ctx.agents.create({ sessionId: id, meta: { cwd: root },
        agentOptions: { provider: 'starter-fixture', model: 'synthetic' } });
      manager.data.sessions[agent.id] = { root, independentRepository: true };
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
      await agent.whenIdle();
      return root;
    }
    const app = await submit('starter-owner', 'Vytvoř převodník teplot mezi °C a °F.');
    const sameSchemas = requests[0]?.tools;
    assert.ok(sameSchemas?.includes('project_exec'), 'the existing tool must be admitted before model assembly');
    assert.equal(requests[0].offer, true);
    assert.doesNotMatch(requests[0].content, /<html|<script/u);
    assert.deepEqual(writes, [{ id: 'starter-owner', exitCode: 0 }]);
    assert.match(await fs.readFile(path.join(app, 'index.html'), 'utf8'), /°C → °F/u);
    const before = requests.length;
    const unrelated = await submit('unrelated-owner', 'Vytvoř jednoduché webové počítadlo.');
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).offer, false);
    assert.deepEqual(requests.at(-1).tools, sameSchemas);
    assert.deepEqual(await fs.readdir(unrelated), []);
    assert.equal(writes.length, 1);
  });
