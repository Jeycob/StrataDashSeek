import crypto from 'node:crypto';
import { changedApplicationCode } from './verification-guidance.mjs';
import {acknowledgeAutomatic,recoveryState} from './automatic-recovery.mjs';
import {watchAutomaticCancellation,releaseAutomaticCancellation} from './automatic-cancellation.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0;
export const AUTOMATIC_REVIEW_DEFAULTS = Object.freeze({ maxTaskSteps: 240, maxAutomaticChecks: 3 });
export const REPAIR_STEPS = 20;
export const AUTONOMOUS_REPAIR_STEPS = 120;
export const VERIFICATION_TIMEOUT_MS = 120000;
export function automaticReviewView(value) {
  return value ? {...Object.fromEntries(['version','taskSteps','checks','nextCheckAt','phase','proofSerial','lastVerified','lastCheck','reason','recovery'].filter(key => value[key] !== undefined).map(key => [key,value[key]])),terminalAcknowledged:value.terminalAcknowledged===true} : null;
}
const stop = (budget, code, message) => {
  budget.blocked = { code, message };
  budget.automatic.phase = 'stopped';
  budget.automatic.reason = code;
  return false;
};
const uncertain = budget => {
  budget.automatic.uncertain = true;
  budget.automatic.terminalAcknowledged ??= false;
  recoveryState(budget.automatic,'pending','AUTOMATIC_TERMINAL_PENDING');
  return stop(budget, 'AUTOMATIC_VERIFICATION_UNCERTAIN', 'Verification completion is being reconciled against its owned terminal evidence. Files and accounting are retained.');
};

// Only the server's actual human-message identity can begin a new allowance.
// Passes, manual resume, subagents and internal followups never renew it.
export function prepareAutomaticRequest(record, budget, { turn, messages, owner = true }, interval) {
  // A new message is not acknowledgement of an old in-flight operation. Do
  // this before considering a new allowance or replacing any saved counters.
  if (budget.automatic && (budget.automatic.phase === 'checking' || budget.automatic.activeCallId || budget.automatic.uncertain || budget.blocked?.code === 'AUTOMATIC_VERIFICATION_UNCERTAIN')) {
    uncertain(budget); return false;
  }
  const previous = record.automaticRequest ?? record.budgetRequest;
  const human = owner && Array.isArray(messages) ? messages.findLast(m => m?.role === 'user' && m?.source?.kind === 'user') : null;
  const valid = human && typeof human.id === 'string' && human.id.trim() && Number.isSafeInteger(turn) && turn > 0;
  const fresh = Boolean(valid && previous && Number.isSafeInteger(previous.turn) && turn > previous.turn && human.id !== previous.messageId);
  if (!budget.automatic || fresh) {
    budget.automatic = { version: 1, taskSteps: fresh ? 0 : budget.steps, checks: 0, nextCheckAt: interval,
      phase: 'working', proofSerial: 0, proofs: {}, admitted: {}, interval };
    // A genuine new owner request starts a new repair attempt. Retain the
    // measured checks as its baseline, but not the exhausted failure streak.
    if (fresh) { budget.stalled = 0; budget.errors = {}; }
    if (fresh && ['TASK_BUDGET', 'AUTOMATIC_CHECK_LIMIT', 'AUTOMATIC_NO_PROGRESS', 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'AUTOMATIC_VERIFICATION_TIMEOUT', 'REPAIR_NO_PROGRESS', 'REPEATED_TOOL_ERROR', 'AUTONOMOUS_REPAIR_EXHAUSTED'].includes(budget.blocked?.code)) budget.blocked = null;
  }
  const a = budget.automatic;
  if (a.version !== 1 || !['taskSteps','checks','nextCheckAt','proofSerial'].every(k => integer(a[k])) || !a.proofs || typeof a.proofs !== 'object' || Array.isArray(a.proofs) || !a.admitted || typeof a.admitted !== 'object' || Array.isArray(a.admitted)) {
    throw Object.assign(Error('Automatic work accounting is unavailable; no work was started.'), { code: 'AUTOMATIC_STATE_INVALID' });
  }
  if (a.interval !== interval) a.nextCheckAt = Math.min(a.nextCheckAt, a.taskSteps + Math.max(0, interval - budget.steps));
  a.interval = interval;
  if (valid && (!previous || turn > previous.turn)) record.automaticRequest = { turn, messageId: human.id };
  return fresh;
}

export function recordVerifiedProgress(budget, { kind, manifestHash, verifiedKinds }) {
  const a = budget.automatic;
  if (!a) return true; // Legacy pure policy callers; managed runtime always enrolls.
  if (typeof manifestHash !== 'string' || !/^[a-f0-9]{64}$/i.test(manifestHash)) return false;
  const key = crypto.createHash('sha256').update(kind + ':' + manifestHash).digest('hex');
  if (Object.hasOwn(a.proofs, key) || Object.keys(a.proofs).length >= 256) return false;
  a.proofs[key] = true; a.proofSerial++;
  a.lastVerified = { kind, sourceHash: manifestHash, at: Date.now() };
  delete a.repairEvidenceUsed;
  delete a.repairEvidenceReview;
  if (a.repairAllowance && (kind === a.repairAllowance.kind || kind === 'all' && verifiedKinds?.includes(a.repairAllowance.kind))) delete a.repairAllowance;
  a.phase = 'working'; delete a.reason;
  a.nextCheckAt = a.taskSteps + a.interval;
  return true;
}

export function admitAutomaticStep(budget, settings) {
  const a = budget.automatic;
  if (budget.blocked) return false;
  if (a.repairAllowance && a.taskSteps >= a.repairAllowance.deadline) return stop(budget,'AUTONOMOUS_REPAIR_EXHAUSTED','The 120-step autonomous repair allowance ended without new verified success for the failing check. Files and failed results are retained.');
  if (!Number.isSafeInteger(a.taskSteps+1)||!Number.isSafeInteger(budget.steps+1)) return stop(budget,'AUTOMATIC_STATE_INVALID','Step accounting cannot be represented safely. Files are retained.');
  a.taskSteps++; budget.steps++;
  return true;
}

export function recordRepairWarning(budget, kind) {
  const a = budget.automatic;
  if (!a) return false;
  if (!a.repairAllowance) {
    const deadline = a.taskSteps + AUTONOMOUS_REPAIR_STEPS;
    if (!Number.isSafeInteger(deadline)) { stop(budget,'AUTOMATIC_STATE_INVALID','Repair accounting cannot be represented safely.'); return false; }
    a.repairAllowance = { kind, deadline };
  }
  const allowance = a.repairAllowance;
  if (allowance.lastWarning === undefined || a.taskSteps >= allowance.lastWarning + REPAIR_STEPS) { allowance.lastWarning = a.taskSteps; return true; }
  return false;
}

export function measuredRepairEvidence(report, kind, sourceHash) {
  const checks = report?.checks;
  return typeof sourceHash === 'string' && report?.sourceHash === sourceHash && report.stale === false
    && typeof report.passed === 'boolean' && Array.isArray(checks) && checks.length > 0
    && checks.every(check => (kind === 'all' ? ['test','build','browser','acceptance'].includes(check?.kind) : check?.kind === kind) && check.countsMeasured === true
      && Number.isSafeInteger(check.checksPassed) && Number.isSafeInteger(check.checksTotal)
      && check.checksPassed >= 0 && check.checksTotal > 0 && check.checksTotal <= 1000000 && check.checksPassed <= check.checksTotal)
    && checks.reduce((total,check)=>total+check.checksTotal,0) <= 1000000
    && (report.passed ? checks.every(check => check.passed === true && check.checksPassed === check.checksTotal)
      : checks.some(check => check.passed === false && check.checksPassed < check.checksTotal));
}

const diagnostics = (manager, id, text) => {
  const pending = manager.pendingDiagnostics.get(id) ?? new Map();
  pending.set('AUTOMATIC_REVIEW', text);
  while (pending.size > 4) pending.delete(pending.keys().next().value);
  manager.pendingDiagnostics.set(id, pending);
};

export async function automaticReview(manager, input, record, budget, settings, freshHuman) {
  const a = budget.automatic, id = input.agent.id;
  const evidenceReview = a.repairEvidenceReview;
  if (budget.blocked?.code === 'REPAIR_NO_PROGRESS' && !a.activeCallId && !a.uncertain) {
    budget.blocked=null;a.phase='repairing';delete a.reason;
    if(recordRepairWarning(budget,'all'))diagnostics(manager,id,'[Harness: change repair strategy] The previous failed attempts are retained. Use a different approach to the failing verification and continue the original task within its 120-step repair allowance. No owner approval is required.');
  }
  const allowance = a.repairAllowance, finalRepair = allowance && a.taskSteps >= allowance.deadline;
  if (['STAGE_BUDGET','TASK_BUDGET','AUTOMATIC_CHECK_LIMIT'].includes(budget.blocked?.code)&&!a.activeCallId&&!a.uncertain) { budget.blocked = null; a.nextCheckAt = a.taskSteps; }
  if (budget.blocked) return;
  if (a.phase === 'checking' || a.uncertain) { uncertain(budget); return; }
  if (!evidenceReview && !finalRepair && a.taskSteps < a.nextCheckAt) return; // Main interval or bounded repair window, never a stage pass.
  let mode, changes;
  try {
    mode = manager.ctx.sandboxPolicy.resolve({ session: (input.executionAgent ?? input.agent).session }).mode;
    if (mode !== 'read-only' && !record.legacy) changes = await manager.changes.list(id, record, { signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    stop(budget, 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'Verification permissions or project changes could not be established. Files are retained.'); return;
  }
  if (mode === 'read-only' || record.legacy || !changedApplicationCode(changes?.files)) {
    if (evidenceReview || finalRepair) { stop(budget, 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'The required repair check could not run against writable current project sources. Files and failed results are retained.'); return; }
    // Read-only analysis and prose are not application verification. Do not
    // install a contract, borrow owner write permission or fabricate a pass.
    a.phase = 'working'; a.nextCheckAt = a.taskSteps + settings.maxStageSteps;
    diagnostics(manager, id, '[Harness: bounded analysis] No changed application code is available for automatic project verification, or this executing scope is read-only. Continue only within its existing permissions and total task allowance. Do not create a test contract or modify files merely to renew a stage.');
    return;
  }
  if (typeof manager.ctx.tools?.execute !== 'function') { stop(budget, 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'The verification executor is unavailable. Files are retained; no replacement executor was installed.'); return; }
  // Source I/O is preparation, not an admitted verification. It may reject or
  // outlive a task/project replacement without creating an in-flight fence.
  const root=record.root,request=record.automaticRequest??record.budgetRequest;
  const task=request?{turn:request.turn,messageId:request.messageId}:undefined;
  const current=()=>manager.data.sessions[id]===record&&manager.budgets.get(id)===budget&&budget.automatic===a
    &&record.root===root&&!manager.data.trash[id]
    &&(record.automaticRequest??record.budgetRequest)?.turn===task?.turn
    &&(record.automaticRequest??record.budgetRequest)?.messageId===task?.messageId
    &&(!manager.ctx.agents||manager.ctx.agents.get(id)===input.agent);
  const changed=()=>Object.assign(Error('The automatic verification target changed before dispatch. No verification was started.'),{code:'AUTOMATIC_SOURCE_BINDING_CHANGED'});
  let sourceHash;
  try{
    const binding=await manager.review(id);
    input.signal?.throwIfAborted();manager.execution.assertUnchanged();
    if(!current())throw changed();
    if(binding?.root!==root||typeof binding.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(binding.sourceHash))throw Object.assign(Error('The project source binding is unavailable.'),{code:'AUTOMATIC_SOURCE_BINDING_INVALID'});
    sourceHash=binding.sourceHash;
  }catch(error){
    if(input.signal?.aborted)throw error;
    if(!current())throw changed();
    if(!budget.blocked)stop(budget,'AUTOMATIC_VERIFICATION_UNAVAILABLE','The project source binding could not be established before dispatch. No verification was started; files and accounting are retained.');
    const code=/^[A-Z0-9_]{1,80}$/.test(error.code??'')?error.code:'SOURCE_BINDING_UNAVAILABLE';
    diagnostics(manager,id,'[Harness: verification not started] Source binding failed before dispatch: '+code+'. No check was charged and no active operation or passing result was created.');
    return;
  }
  if(budget.blocked||!evidenceReview&&!finalRepair&&a.taskSteps<a.nextCheckAt)return;
  if (finalRepair) {
    if (allowance.finalCheckStarted || allowance.lastFailureHash === sourceHash) { stop(budget,'AUTONOMOUS_REPAIR_EXHAUSTED','The 120-step autonomous repair allowance ended with the failing check still unverified. Files and failed results are retained.'); return; }
    allowance.finalCheckStarted = true;
  }
  const callId = 'automatic-review-' + crypto.randomUUID();
  a.phase = 'checking'; a.checks++; a.activeCallId = callId; delete a.lastAutomaticOutcome;delete a.receipt;
  if(a.continuation){a.previousContinuation={callId:a.continuation.callId,messageId:a.continuation.message?.id,state:a.continuation.state};delete a.continuation;}a.continuationNeeded=false;
  const startedAt=Date.now();
  a.terminalAcknowledged=false;a.operation={callId,ownerId:id,root,sourceHash,task,verificationKind:finalRepair?allowance.kind:evidenceReview?.kind??'all',repairFinal:Boolean(finalRepair),startedAt,deadlineAt:startedAt+VERIFICATION_TIMEOUT_MS};
  const operation=a.operation;
  watchAutomaticCancellation(manager,id,record,budget,operation,input.signal);
  if(a.legacyRecovery?.verificationState==='required'){a.legacyRecovery.verificationState='started';a.legacyRecovery.verificationCallId=callId;a.continuationNeeded=true;}
  recoveryState(a,'pending','AUTOMATIC_VERIFICATION_RUNNING');record.budget = budget;
  const deadline = new AbortController();
  const verificationSignal = AbortSignal.any([...(input.signal ? [input.signal] : []), deadline.signal]);
  let executionSettled = false, execution, abort,timer,dispatchStarted=false;
  try {
    await manager.save();
    const remaining=operation.deadlineAt-Date.now();
    const expired=()=>deadline.abort(Object.assign(Error('Automatic verification deadline exceeded.'),{code:'AUTOMATIC_VERIFICATION_TIMEOUT'}));
    if(remaining<=0)expired();else{timer=setTimeout(expired,remaining);timer.unref?.();}
    verificationSignal.throwIfAborted();
    // The normal SDK executor owns admission, sandbox, policy, final results
    // and the single result observer. Never call a verifier implementation or
    // budget.observe directly from this controller.
    dispatchStarted=true;
    execution = Promise.resolve(manager.ctx.tools.execute({ agent: input.executionAgent ?? input.agent, signal: verificationSignal,
      maxParallelToolCalls: 1, calls: [{ type: 'tool-call', id: callId, name: 'verify_project', arguments: JSON.stringify({kind:operation.verificationKind}) }] }));
    manager.automaticInFlight ??= new Map(); manager.automaticInFlight.set(id, execution);
    const drained = () => {
      executionSettled = true;
      if (manager.automaticInFlight.get(id) === execution) manager.automaticInFlight.delete(id);
      acknowledgeAutomatic(manager,id,callId);
    };
    // A late batch drain triggers receipt reconciliation; it never fabricates
    // a passing report or submits another prompt.
    execution.then(drained, drained);
    const interrupted = new Promise((resolve, reject) => {
      abort = () => reject(verificationSignal.reason ?? Error('Verification interrupted.'));
      if (verificationSignal.aborted) abort(); else verificationSignal.addEventListener('abort', abort, { once: true });
    });
    const batch = await Promise.race([execution, interrupted]);
    await manager.drainToolResults(id);
    if(a.operation.rangeRequired&&(!a.operation.rangeQualified||!a.operation.rangeSettled)){uncertain(budget);return;}
    input.signal?.throwIfAborted();
    deadline.signal.throwIfAborted();
    for (const context of batch.additionalContexts ?? []) input.agent.inject?.(context);
    const settled = batch.results?.find(r => r.callId === callId)?.result;
    if (!settled || settled.isError || settled.error) {
      stop(budget, 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'Verification could not be admitted or completed. Inspect the concrete diagnostic; files are retained.');
      return;
    }
    if (a.lastAutomaticOutcome?.callId !== callId) {
      stop(budget, 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'The final verification outcome was not observed. Files are retained; no progress was inferred from another operation.'); return;
    }
    const report = settled.value;
    a.recoveryFailures=0;
    a.lastCheck = { at: Date.now(), passed: report?.passed === true, stale: report?.stale === true,
      checks: Array.isArray(report?.checks) ? report.checks.slice(0,24).filter(check => check && typeof check.id === 'string').map(check => ({ id: check.id.slice(0,80), passed: check.passed === true })) : [] };
    const outcome = JSON.stringify({ passed: report?.passed, complete: report?.complete, stale: report?.stale,
      code: /^[A-Z0-9_]{1,80}$/.test(report?.code ?? '') ? report.code : undefined,
      reportPath: report?.reportPath, checks: Array.isArray(report?.checks) ? report.checks.slice(0,24).map(check => ({ id: check.id, kind: check.kind, passed: check.passed,
        checksPassed: check.checksPassed, checksTotal: check.checksTotal, diagnosticCode: check.diagnosticCode, logPath: check.logPath, artifactPaths: check.artifactPaths?.slice(0,4) })) : [] }).slice(0,6000);
    if (budget.blocked) { a.phase = 'stopped'; a.reason = budget.blocked.code; return; }
    const completeCheck = operation.verificationKind === 'all' && report?.passed === true && report?.complete === true && report?.stale === false
      && a.lastAutomaticOutcome.failed === false && typeof report.sourceHash === 'string' && a.lastAutomaticOutcome.sourceHash === report.sourceHash;
    if (a.lastAutomaticOutcome.verifiedProgress === true) {
      diagnostics(manager, id, '[Harness: verified progress] ' + (completeCheck
        ? 'All required project checks passed on the current source and the full verification was accepted. Deliver any remaining requested artifact or preview, then finish the task with a final answer describing the result and how to access it. Change application behavior only if an original requirement remains unmet; a passing contract does not replace the requested deliverable. Do not expand scope, weaken assertions or repeat unchanged passing checks.'
        : 'The current-source check recorded new passing evidence, but it is only a partial verification. Implement or verify the next unmet original requirement, preserving assertions and scope. Inspect required kinds and real application behavior; do not claim full completion from this result.')
        + '\nActual verification summary: ' + outcome);
    } else {
      const repeatedPass = report?.passed === true && report?.stale === false && typeof report?.sourceHash === 'string' && budget.checks.all?.manifestHash === report.sourceHash;
      a.phase = repeatedPass ? 'working' : 'repairing'; a.nextCheckAt = a.taskSteps + REPAIR_STEPS;
      diagnostics(manager, id, (repeatedPass
        ? '[Harness: repeated passing evidence] This current-source check passed, but repeats existing evidence and earns no stage or task-budget renewal. ' + (completeCheck
          ? 'Full verification is still passing. Deliver any remaining requested artifact or preview, then finish with a final answer if the original requirements are satisfied. Change application behavior only for an unmet original requirement; do not invent a repair for already passing behavior.'
          : 'This is only partial verification. Implement or verify the next unmet original requirement; do not claim full completion or invent a repair for already passing behavior.')
        : '[Harness: bounded repair] Verification did not establish new progress. Read the reported owned log/report paths, repair the specific failure or missing contract, and run a relevant foreground verify_project check within the next ' + REPAIR_STEPS + ' steps. Preserve current files and report a concrete blocker only when it requires an owner decision.')
        + ' Do not repeat an unchanged passing check, weaken assertions, raise limits or expand scope.\nActual verification summary: ' + outcome);
    }
  } catch (error) {
    if (dispatchStarted && (!executionSettled||deadline.signal.aborted)) { uncertain(budget); return; }
    if (input.signal?.aborted) { a.phase = 'cancelled'; throw error; }
    stop(budget, deadline.signal.aborted ? 'AUTOMATIC_VERIFICATION_TIMEOUT' : 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'Verification could not finish within its permissions and time allowance. Files are retained. Inspect the executor diagnostic before continuing.');
    manager.ctx.logger?.warn('Automatic verification unavailable: ' + (/^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : 'EXECUTOR_FAILURE'));
  } finally {
    clearTimeout(timer);if(abort)verificationSignal.removeEventListener('abort',abort);
    if(!dispatchStarted&&a.activeCallId===callId){
      a.checks--;delete a.activeCallId;operation.admissionOutcome='NOT_DISPATCHED';a.continuationNeeded=false;
      if(a.legacyRecovery?.verificationCallId===callId)a.legacyRecovery.verificationState='not-dispatched';
      releaseAutomaticCancellation(manager,id,operation);
      recoveryState(a,budget.blocked?'blocked':'recovered',operation.cancelledByCaller?'AUTOMATIC_CANCELLED':budget.blocked?.code??'AUTOMATIC_NOT_DISPATCHED',false);
    }else if(executionSettled&&!a.uncertain&&a.activeCallId===callId){
      a.reconciledCallId=callId;delete a.activeCallId;
      if(manager.automaticProcesses?.get(id)?.callId===callId&&operation.rangeSettled)manager.automaticProcesses.delete(id);
      if(a.legacyRecovery?.verificationCallId===callId)a.legacyRecovery.verificationState='settled';
      recoveryState(a,budget.blocked?'blocked':'recovered',budget.blocked?.code??'AUTOMATIC_RESULT_RECONCILED',!budget.blocked);
      if(operation.cancelledByCaller){a.phase='cancelled';a.continuationNeeded=false;recoveryState(a,'recovered','AUTOMATIC_CANCELLED',false);}
      if(!a.continuationNeeded||budget.blocked)releaseAutomaticCancellation(manager,id,operation);
    }
    record.budget=budget;await manager.save();
    if(a.uncertain)void manager.reconcileAutomatic(id).catch(()=>manager.ctx.logger?.warn('Automatic owned cleanup remains unconfirmed.'));
  }
}
