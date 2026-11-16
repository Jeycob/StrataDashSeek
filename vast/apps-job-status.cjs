'use strict';
const ID = /^[a-f0-9]{16}$/;
const STATES = new Set(['queued', 'running', 'passed', 'failed', 'interrupted', 'recovery_required']);
const ACTIONS = new Set(['verify', 'build', 'deploy', 'check', 'compose', 'export', 'rollback', 'remote-verify', 'remote-preflight', 'resource-export', 'wake', 'sleep', 'worker-probe']);
function jobStatus(manager, id) {
  if (!ID.test(id || '')) throw Object.assign(Error('Unknown job'), { code: 'JOB_NOT_FOUND', status: 404 });
  const job = manager.store.jobs.find(j => j.id === id); if (!job) throw Object.assign(Error('Unknown job'), { code: 'JOB_NOT_FOUND', status: 404 });
  const state = STATES.has(job.status) ? job.status : 'unknown', recoveryRequired = job.status === 'recovery_required' || job.deploymentPhase === 'recovery_required';
  return { version: 1, observedAt: Date.now(), job: { id, action: ACTIONS.has(job.action) ? job.action : 'unknown', status: state, terminal: ['passed', 'failed', 'interrupted', 'recovery_required'].includes(state),
    passed: state === 'passed' && !recoveryRequired, recoveryRequired, startedAt: Number.isSafeInteger(job.startedAt) && job.startedAt >= 0 ? job.startedAt : null,
    endedAt: Number.isSafeInteger(job.endedAt) && job.endedAt >= 0 ? job.endedAt : null, ...(ID.test(job.releaseId || '') ? { releaseId: job.releaseId } : {}) } };
}
module.exports = { jobStatus };
