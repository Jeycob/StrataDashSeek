import crypto from 'node:crypto';
import { changedApplicationCode } from './verification-guidance.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0;
export const AUTOMATIC_REVIEW_DEFAULTS = Object.freeze({ maxTaskSteps: 240, maxAutomaticChecks: 3 });
export const REPAIR_STEPS = 20;
export const VERIFICATION_TIMEOUT_MS = 120000;
export function automaticReviewView(value) {
  return value ? Object.fromEntries(['version','taskSteps','checks','nextCheckAt','phase','proofSerial','lastVerified','lastCheck','reason'].filter(key => value[key] !== undefined).map(key => [key,value[key]])) : undefined;
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
  return stop(budget, 'AUTOMATIC_VERIFICATION_UNCERTAIN', 'A verification has no acknowledged completion. Files and its work allowance are retained. Operator review is required before any further work.');
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
    if (fresh && ['TASK_BUDGET', 'AUTOMATIC_CHECK_LIMIT', 'AUTOMATIC_NO_PROGRESS', 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'AUTOMATIC_VERIFICATION_TIMEOUT', 'REPAIR_NO_PROGRESS', 'REPEATED_TOOL_ERROR'].includes(budget.blocked?.code)) budget.blocked = null;
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

export function recordVerifiedProgress(budget, { kind, manifestHash }) {
  const a = budget.automatic;
  if (!a) return true; // Legacy pure policy callers; managed runtime always enrolls.
  if (typeof manifestHash !== 'string' || !/^[a-f0-9]{64}$/i.test(manifestHash)) return false;
  const key = crypto.createHash('sha256').update(kind + ':' + manifestHash).digest('hex');
  if (Object.hasOwn(a.proofs, key) || Object.keys(a.proofs).length >= 256) return false;
  a.proofs[key] = true; a.proofSerial++;
  a.lastVerified = { kind, sourceHash: manifestHash, at: Date.now() };
  a.phase = 'working'; delete a.reason;
  a.nextCheckAt = a.taskSteps + a.interval;
  return true;
}

export function admitAutomaticStep(budget, settings) {
  const a = budget.automatic;
  if (budget.blocked) return false;
  if (a.taskSteps >= settings.maxTaskSteps) return stop(budget, 'TASK_BUDGET', 'The work allowance is exhausted. Files are retained. A new user request is required for another bounded task.');
  a.taskSteps++; budget.steps++;
  return true;
}

const diagnostics = (manager, id, text) => {
  const pending = manager.pendingDiagnostics.get(id) ?? new Map();
  pending.set('AUTOMATIC_REVIEW', text);
  while (pending.size > 4) pending.delete(pending.keys().next().value);
  manager.pendingDiagnostics.set(id, pending);
};

export async function automaticReview(manager, input, record, budget, settings, freshHuman) {
  const a = budget.automatic, id = input.agent.id;
  if (budget.blocked?.code === 'STAGE_BUDGET' && freshHuman && settings.maxAutomaticChecks > 0) { budget.blocked = null; a.nextCheckAt = a.taskSteps; }
  if (budget.blocked) return;
  if (a.phase === 'checking' || a.uncertain) { uncertain(budget); return; }
  if (a.taskSteps >= settings.maxTaskSteps) { admitAutomaticStep(budget, settings); return; }
  if (a.taskSteps < a.nextCheckAt) return; // Main interval or bounded repair window, never a stage pass.
  if (settings.maxAutomaticChecks === 0) { stop(budget, 'STAGE_BUDGET', 'The stage is ready for verification. Automatic checks are disabled in this workspace. Files are retained.'); return; }
  let mode, changes;
  try {
    mode = manager.ctx.sandboxPolicy.resolve({ session: (input.executionAgent ?? input.agent).session }).mode;
    if (mode !== 'read-only' && !record.legacy) changes = await manager.changes.list(id, record, { signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    stop(budget, 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'Verification permissions or project changes could not be established. Files are retained.'); return;
  }
  if (mode === 'read-only' || record.legacy || !changedApplicationCode(changes?.files)) {
    // Read-only analysis and prose are not application verification. Do not
    // install a contract, borrow owner write permission or fabricate a pass.
    a.phase = 'working'; a.nextCheckAt = Math.min(settings.maxTaskSteps, a.taskSteps + settings.maxStageSteps);
    diagnostics(manager, id, '[Harness: bounded analysis] No changed application code is available for automatic project verification, or this executing scope is read-only. Continue only within its existing permissions and total task allowance. Do not create a test contract or modify files merely to renew a stage.');
    return;
  }
  if (a.checks >= settings.maxAutomaticChecks) { stop(budget, 'AUTOMATIC_CHECK_LIMIT', 'Automatic verification attempts are exhausted. Files and verification results are retained; no additional work was started.'); return; }
  if (typeof manager.ctx.tools?.execute !== 'function') { stop(budget, 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'The verification executor is unavailable. Files are retained; no replacement executor was installed.'); return; }
  const callId = 'automatic-review-' + crypto.randomUUID();
  a.phase = 'checking'; a.checks++; a.activeCallId = callId; delete a.lastAutomaticOutcome; record.budget = budget; await manager.save();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(Object.assign(Error('Automatic verification deadline exceeded.'), { code: 'AUTOMATIC_VERIFICATION_TIMEOUT' })), VERIFICATION_TIMEOUT_MS); timer.unref?.();
  const verificationSignal = AbortSignal.any([...(input.signal ? [input.signal] : []), deadline.signal]);
  let executionSettled = false, execution, abort;
  try {
    input.signal?.throwIfAborted();
    // The normal SDK executor owns admission, sandbox, policy, final results
    // and the single result observer. Never call a verifier implementation or
    // budget.observe directly from this controller.
    execution = Promise.resolve(manager.ctx.tools.execute({ agent: input.executionAgent ?? input.agent, signal: verificationSignal,
      maxParallelToolCalls: 1, calls: [{ type: 'tool-call', id: callId, name: 'verify_project', arguments: '{"kind":"all"}' }] }));
    manager.automaticInFlight ??= new Map(); manager.automaticInFlight.set(id, execution);
    const drained = () => {
      executionSettled = true;
      if (manager.automaticInFlight.get(id) === execution) manager.automaticInFlight.delete(id);
      if (a.uncertain) { a.terminalAcknowledged = true; record.budget = budget; void Promise.resolve().then(() => manager.save()).catch(() => manager.ctx.logger?.warn('Verification terminal acknowledgement could not be saved.')); }
    };
    // Always observe late settlement, but never credit it as an automatic
    // continuation or clear the durable unknown fence after a timeout.
    execution.then(drained, drained);
    const interrupted = new Promise((resolve, reject) => {
      abort = () => reject(verificationSignal.reason ?? Error('Verification interrupted.'));
      if (verificationSignal.aborted) abort(); else verificationSignal.addEventListener('abort', abort, { once: true });
    });
    const batch = await Promise.race([execution, interrupted]);
    await manager.drainToolResults(id);
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
    a.lastCheck = { at: Date.now(), passed: report?.passed === true, stale: report?.stale === true,
      checks: Array.isArray(report?.checks) ? report.checks.slice(0,24).filter(check => check && typeof check.id === 'string').map(check => ({ id: check.id.slice(0,80), passed: check.passed === true })) : [] };
    const outcome = JSON.stringify({ passed: report?.passed, complete: report?.complete, stale: report?.stale,
      code: /^[A-Z0-9_]{1,80}$/.test(report?.code ?? '') ? report.code : undefined,
      reportPath: report?.reportPath, checks: Array.isArray(report?.checks) ? report.checks.slice(0,24).map(check => ({ id: check.id, kind: check.kind, passed: check.passed,
        checksPassed: check.checksPassed, checksTotal: check.checksTotal, diagnosticCode: check.diagnosticCode, logPath: check.logPath, artifactPaths: check.artifactPaths?.slice(0,4) })) : [] }).slice(0,6000);
    if (budget.blocked) { a.phase = 'stopped'; a.reason = budget.blocked.code; return; }
    if (a.lastAutomaticOutcome.verifiedProgress === true) {
      diagnostics(manager, id, '[Harness: verified progress] The automatic project check completed on the current source and recorded new evidence. Continue the existing task with a smaller verified milestone. A partial check is not full completion; inspect required kinds and real application behavior.\nActual verification summary: ' + outcome);
    } else {
      const repeatedPass = report?.passed === true && report?.stale === false && typeof report?.sourceHash === 'string' && budget.checks.all?.manifestHash === report.sourceHash;
      a.phase = repeatedPass ? 'working' : 'repairing'; a.nextCheckAt = Math.min(settings.maxTaskSteps, a.taskSteps + REPAIR_STEPS);
      diagnostics(manager, id, (repeatedPass
        ? '[Harness: repeated passing evidence] This current-source check passed, but repeats existing evidence and earns no stage or task-budget renewal. If the original request is satisfied, report the real result and finish. Otherwise implement only the next smaller remaining requirement; do not invent a repair for already passing behavior.'
        : '[Harness: bounded repair] Verification did not establish new progress. Read the reported owned log/report paths, repair the specific failure or missing contract, and run a relevant foreground verify_project check within the next ' + Math.min(REPAIR_STEPS, settings.maxTaskSteps - a.taskSteps) + ' steps. Preserve current files and report a concrete blocker only when it requires an owner decision.')
        + ' Do not repeat an unchanged passing check, weaken assertions, raise limits or expand scope.\nActual verification summary: ' + outcome);
    }
  } catch (error) {
    if (execution && !executionSettled) { uncertain(budget); return; }
    if (input.signal?.aborted) { a.phase = 'cancelled'; throw error; }
    stop(budget, deadline.signal.aborted ? 'AUTOMATIC_VERIFICATION_TIMEOUT' : 'AUTOMATIC_VERIFICATION_UNAVAILABLE', 'Verification could not finish within its permissions and time allowance. Files are retained. Inspect the executor diagnostic before continuing.');
    manager.ctx.logger?.warn('Automatic verification unavailable: ' + (/^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : 'EXECUTOR_FAILURE'));
  } finally { clearTimeout(timer); if (abort) verificationSignal.removeEventListener('abort', abort); if (executionSettled && !a.uncertain && a.activeCallId === callId) delete a.activeCallId; record.budget = budget; await manager.save(); }
}
