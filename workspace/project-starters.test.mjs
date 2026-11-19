import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectStarters } from './project-starters.mjs';
import { registerProjectTool } from './project-tool.mjs';
import { hostExecutionBinding } from './fixtures/execution-binding.mjs';

const signal = new AbortController().signal;
const converter = 'Vytvoř převodník teplot mezi °C a °F.';
const report = 'Create a CSV expense report CLI using amount_czk and posted rows.';
const user = text => [{ id: 'human-1', source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text }] }];
const apply = { command: 'homeai-starter', description: 'Apply matching starter' };

async function fixture(t, enabled = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-starters-test-'));
  t.after(async () => {
    const real = await fs.realpath(directory);
    assert.equal(path.dirname(real), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(real).startsWith('homeai-starters-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  const agent = { id: 'owner' }, project = { root: directory, independentRepository: true };
  const execution = hostExecutionBinding(), received = [];
  const manager = {
    execution, data: { sessions: { owner: project } },
    ownerAgent: actual => actual?.id === 'child' ? agent : actual,
    independentRecord: record => record?.independentRepository === true,
  };
  manager.projectStarters = createProjectStarters(manager, enabled);
  let definition;
  const ctx = { tools: { register(tool) { definition = tool; return () => {}; } } };
  registerProjectTool(ctx, manager, async args => {
    received.push(args);
    const [, program, payload] = args.command.match(/^node -e "([^"]+)" (\S+)$/u);
    assert.match(payload, /^[A-Za-z0-9+/]+=*$/u);
    assert.ok(args.command.length < 65536);
    const child = spawnSync(process.execPath,
      ['-e', program, payload],
      { cwd: directory, encoding: 'utf8' });
    assert.ifError(child.error);
    return { cwd: directory, result: { exitCode: child.status, stdout: { text: child.stdout },
      stderr: { text: child.stderr }, timedOut: false } };
  });
  const offer = (text, options) => manager.projectStarters.offer({ agent, turn: 1, messages: user(text), signal, ...options });
  const call = (args = apply, owner = agent) => definition.execute(args, { agent: owner, signal });
  return { directory, agent, manager, offer, call, received };
}

test('plain first prompt discovers and applies the converter through the normal project_exec registration', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.directory, '.git'));
  const hint = await f.offer(converter);
  assert.match(hint, /temperature converter.*project_exec/u);
  assert.doesNotMatch(hint, /<html|<script|base64/u);
  assert.deepEqual(await fs.readdir(f.directory), ['.git']);
  assert.equal(await f.offer(converter), undefined);
  const result = await f.call();
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Starter files: index\.html/u);
  assert.match(await fs.readFile(path.join(f.directory, 'index.html'), 'utf8'), /°C → °F/u);
  await assert.rejects(f.call(), /requires an active offer/u);
});

test('CSV task gets the repaired reporting starter and the copied CLI computes the expected report', async t => {
  const f = await fixture(t);
  assert.match(await f.offer(report), /expense CSV command-line report/u);
  assert.equal((await f.call()).exitCode, 0);
  execFileSync(process.execPath, ['src/report-cli.mjs', 'data/expenses.csv', 'report.json'], { cwd: f.directory });
  const result = JSON.parse(await fs.readFile(path.join(f.directory, 'report.json'), 'utf8'));
  assert.equal(result.postedCount, 7);
  assert.equal(result.totalCzk, '1460.50');
});

test('irrelevant tasks, later turns, child agents, internal notices and disabled discovery add nothing', async t => {
  const f = await fixture(t);
  for (const [text, options] of [
    ['Vytvoř webové počítadlo.', {}],
    ['Vytvoř dashboard z výdajového CSV.', {}],
    ['Vytvoř převodník teplot od nuly bez šablony.', {}],
    [converter, { turn: 2 }],
    [converter, { agent: { id: 'child' } }],
    [converter, { messages: user(converter).map(message => ({ ...message, source: { kind: 'tool' } })) }],
  ]) assert.equal(await f.offer(text, options), undefined);
  await assert.rejects(f.call(), /requires an active offer/u);
  assert.deepEqual(f.received, []);
  assert.deepEqual(await fs.readdir(f.directory), []);
  const disabled = await fixture(t, false);
  assert.equal(await disabled.offer(converter), undefined);
});

test('owner binding and empty-project recheck protect pre-existing and newly written files', async t => {
  const f = await fixture(t);
  assert.ok(await f.offer(converter));
  await assert.rejects(f.call(apply, { id: 'child' }), /requires an active offer/u);
  await assert.rejects(f.call({ ...apply, workdir: '..' }), /requires an active offer/u);
  await assert.rejects(f.call({ ...apply, run_in_background: true }), /requires an active offer/u);
  const index = path.join(f.directory, 'index.html');
  await fs.writeFile(index, 'existing file');
  assert.notEqual((await f.call()).exitCode, 0);
  assert.equal(await fs.readFile(index, 'utf8'), 'existing file');
  f.manager.projectStarters.clear(f.agent.id);
  assert.equal(await f.offer(converter), undefined);
  assert.deepEqual(await fs.readdir(f.directory), ['index.html']);
});
