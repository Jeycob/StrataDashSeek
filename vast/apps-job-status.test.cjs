'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { jobStatus } = require('./apps-job-status.cjs');
const id = 'a'.repeat(16);
test('structured status reads the existing job registry without waking Docker or exposing private payloads', () => {
  const manager = { store: { jobs: [{ id, action: 'verify', status: 'running', startedAt: 5, error: 'SECRET', output: 'SECRET', token: 'SECRET', containerId: 'PRIVATE' }] }, engine: new Proxy({}, { get() { throw Error('No Docker calls'); } }) };
  assert.equal(jobStatus(manager, id).job.terminal, false); assert.equal(jobStatus(manager, id).job.passed, false); assert.doesNotMatch(JSON.stringify(jobStatus(manager, id)), /SECRET|PRIVATE/);
  for (const status of ['passed', 'failed', 'interrupted', 'recovery_required']) { manager.store.jobs[0].status = status; const result = jobStatus(manager, id).job; assert.equal(result.terminal, true); assert.equal(result.passed, status === 'passed'); }
  manager.store.jobs[0].status = 'passed'; manager.store.jobs[0].deploymentPhase = 'recovery_required'; assert.equal(jobStatus(manager, id).job.passed, false);
  assert.throws(() => jobStatus(manager, 'b'.repeat(16)), { code: 'JOB_NOT_FOUND' });
});
