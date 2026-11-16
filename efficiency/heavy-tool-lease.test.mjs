import test from 'node:test';
import assert from 'node:assert/strict';
import { heavyTool, FairGate } from './gate.mjs';
import { bindHeavyToolLease, retainHeavyToolLease } from './heavy-tool-lease.mjs';

test('both command names admit builds, scripts, compounds and every explicit background job', () => {
  for (const name of ['bash', 'project_exec']) {
    for (const command of ['npm test', 'node build.mjs', 'python worker.py', 'while true; do :; done', 'cat input | node worker.mjs']) assert.equal(heavyTool({ name, arguments: { command } }), true, command);
    for (const command of ['pwd', 'ls -la', 'git diff --stat', 'rg hello src', 'cat README.md']) assert.equal(heavyTool({ name, arguments: { command } }), false, command);
    assert.equal(heavyTool({ name, arguments: { command: 'pwd', run_in_background: true } }), true);
  }
  for (const name of ['read', 'job_output', 'job_list', 'job_kill']) assert.equal(heavyTool({ name }), false);
});

test('lease waits for middleware and background holder, tolerates duplicate release and rejects duplicate binding', async () => {
  const gate = new FairGate(), execution = {}, permit = await gate.acquire({ rootId: 'A' }); let settled = 0;
  const releaseCall = bindHeavyToolLease(execution, permit, () => settled++), releaseJob = retainHeavyToolLease(execution);
  assert.throws(() => bindHeavyToolLease(execution, permit), /already bound/);
  releaseCall(); releaseCall(); assert.equal(gate.active.size, 1); assert.equal(settled, 0);
  releaseJob(); releaseJob(); assert.equal(gate.active.size, 0); assert.equal(settled, 1);
});
