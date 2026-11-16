'use strict';
const ID = /^[a-f0-9]{16}$/;
const STATES = new Set(['queued', 'running', 'passed', 'failed', 'interrupted', 'recovery_required']);
const ACTIONS = new Set(['verify', 'build', 'deploy', 'check', 'compose', 'export', 'rollback', 'remote-verify', 'remote-preflight', 'resource-export', 'wake', 'sleep', 'worker-probe', 'project-editor', 'project-executor']);
function workSettled(manager,job){
 return ['passed','failed'].includes(job.status)&&manager.busy!==job.id&&job.deploymentPhase!=='recovery_required'&&(!job.projectRuntime||job.projectRuntime.state==='stopped')&&!(job.creations||[]).some(c=>['pending','unknown','cleanup-pending'].includes(c.state)||['pending','unknown'].includes(c.resourceStart?.state))&&(!job.dataOperations||job.dataOperations.operations&&Object.values(job.dataOperations.operations).every(operation=>operation?.state==='complete'));
}
function jobStatus(manager, id) {
  if (!ID.test(id || '')) throw Object.assign(Error('Unknown job'), { code: 'JOB_NOT_FOUND', status: 404 });
  const job = manager.store.jobs.find(j => j.id === id); if (!job) throw Object.assign(Error('Unknown job'), { code: 'JOB_NOT_FOUND', status: 404 });
  const state = STATES.has(job.status) ? job.status : 'unknown', recoveryRequired = job.status === 'recovery_required' || job.deploymentPhase === 'recovery_required';
  return { version: 1, observedAt: Date.now(), job: { id, action: ACTIONS.has(job.action) ? job.action : 'unknown', status: state, terminal: ['passed', 'failed', 'interrupted', 'recovery_required'].includes(state),
    passed: state === 'passed' && !recoveryRequired, recoveryRequired, workSettled:workSettled(manager,job), startedAt: Number.isSafeInteger(job.startedAt) && job.startedAt >= 0 ? job.startedAt : null,
    endedAt: Number.isSafeInteger(job.endedAt) && job.endedAt >= 0 ? job.endedAt : null, ...(ID.test(job.releaseId || '') ? { releaseId: job.releaseId } : {}), ...(job.action === 'project-executor' && Number.isInteger(job.exitCode) && job.exitCode >= 0 && job.exitCode <= 255 ? { exitCode: job.exitCode } : {}) } };
}
module.exports = { jobStatus };
