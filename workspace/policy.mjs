import path from 'node:path';
import crypto from 'node:crypto';
import { classifyToolOutcome } from './tool-recovery.mjs';
import { shellVerificationKind } from './shell-status.mjs';

export class WorkbenchError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
export function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) throw new WorkbenchError('INVALID_PATH', 'Use a relative project path.', 400);
  const parts = value.split('/');
  if (parts.some(x => !x || x === '..' || x === '.' || ['.git', '.harness'].includes(x))) throw new WorkbenchError('INVALID_PATH', 'This path is not editable.', 400);
  return value;
}
export const DEFAULTS = Object.freeze({ provider: 'strata-vast', model: 'strata', reasoningEffort: 'medium', maxTokens: 32768, thinkingBudget: 4096, temperature: 1, topP: .95, projectMode: 'auto', noProgressLimit: 3, maxStageSteps: 60, language: 'en', environment: 'web' });
export function validateSettings(input, availableModels) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkbenchError('INVALID_SETTINGS', 'Expected settings.', 400);
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, key) && key !== 'baseCommit') throw new WorkbenchError('INVALID_SETTINGS', 'Unknown setting: ' + key, 400);
  const result = { ...DEFAULTS, ...input };
  for (const key of ['provider', 'model']) if (typeof result[key] !== 'string' || !/^[\w./:-]{1,128}$/u.test(result[key])) throw new WorkbenchError('INVALID_SETTINGS', 'Invalid ' + key, 400);
  for (const [key, choices] of Object.entries({ reasoningEffort: ['off', 'low', 'medium', 'high'], projectMode: ['auto', 'fresh', 'worktree', 'continue'], language: ['en', 'cs'], environment: ['web', 'dotnet', 'general'] })) if (!choices.includes(result[key])) throw new WorkbenchError('INVALID_SETTINGS', 'Invalid ' + key, 400);
  for (const [key, min, max] of [['maxTokens', 256, 32768], ['thinkingBudget', 128, 8192], ['noProgressLimit', 1, 3], ['maxStageSteps', 10, 100]]) if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new WorkbenchError('INVALID_SETTINGS', 'Invalid ' + key, 400);
  for (const [key, min, max] of [['temperature', 0, 2], ['topP', .01, 1]]) if (!Number.isFinite(result[key]) || result[key] < min || result[key] > max) throw new WorkbenchError('INVALID_SETTINGS', 'Invalid ' + key, 400);
  if (result.baseCommit !== undefined && !/^[a-f0-9]{40,64}$/iu.test(result.baseCommit)) throw new WorkbenchError('INVALID_COMMIT', 'Use a resolved full local commit id.', 400);
  if (availableModels && !availableModels.some(x => x.provider === result.provider && (x.model ?? x.id) === result.model)) throw new WorkbenchError('MODEL_UNAVAILABLE', 'The selected model is unavailable.', 400);
  return result;
}
export function errorFingerprint(text) {
  return crypto.createHash('sha256').update(String(text).replace(/\u001b\[[0-9;]*m/gu, '').replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|secs?)\b/giu, '<time>').replace(/(?:[A-Z]:)?[/\\][^\s:"']+/gu, '<path>').replace(/\b(?:call|job|request)-[\w-]+/gu, '<id>').trim().slice(-8000)).digest('hex');
}
const operationMetadata = new Set(['description', 'timeout', 'timeoutms', 'callid', 'requestid']);
function stableOperationArguments(value, top = false) {
  if (Array.isArray(value)) return value.map(item => stableOperationArguments(item));
  if (!value || typeof value !== 'object') return value;
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (top && operationMetadata.has(key.replaceAll('_', '').toLowerCase())) continue;
    result[key] = stableOperationArguments(value[key]);
  }
  return result;
}
// Lexical identity only: this does not read the target, follow symlinks, or
// replace the executor's confinement/permission checks.
export function operationFingerprint(exec, projectRoot) {
  const name = typeof exec?.name === 'string' ? exec.name : '', args = exec?.arguments ?? {};
  const root = typeof projectRoot === 'string' && projectRoot ? projectRoot : process.cwd();
  const paths = /^[A-Za-z]:[\\/]|^\\\\/u.test(root) ? path.win32 : path.posix;
  const canonical = value => {
    const resolved = paths.resolve(root, typeof value === 'string' && value ? value : '.');
    return paths === path.win32 ? resolved.replaceAll('\\', '/').replace(/^[A-Z]:/u, drive => drive.toLowerCase()) : resolved;
  };
  let identity;
  if (['bash', 'project_exec'].includes(name)) {
    identity = ['managed-command', typeof args.command === 'string' ? args.command : null, canonical(args.cwd ?? args.workdir)];
  } else if (['read', 'write', 'edit', 'read_file', 'write_file', 'edit_file'].includes(name)) {
    const target = args.file_path ?? args.path;
    identity = [name, 'file', typeof target === 'string' && target ? canonical(target) : null];
  } else identity = [name, stableOperationArguments(args, true)];
  return 'op1:' + crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
function operationErrorPrefix(scope) {
  // Hash even caller-supplied scopes so persisted counters never contain raw
  // commands, paths, credentials, or argument objects.
  return typeof scope === 'string' && scope ? 'operation:' + crypto.createHash('sha256').update(scope).digest('hex') + ':' : null;
}
export function validationKind(command) {
  return shellVerificationKind(command);
}
export function checkScore(exitCode, text) {
  if (exitCode === 0) return 0;
  const matches = [...String(text).matchAll(/(?:\b(\d+)\s+(?:failed|failures?|errors?)\b|\bfail\s+(\d+)\b|\berrors?\s*:\s*(\d+))/giu)];
  return matches.length ? Math.max(1, ...matches.map(x => Number(x[1] ?? x[2] ?? x[3]))) : 1e9;
}
export const REPAIR_POLICY_VERSION = 3;
export class RepairBudget {
  constructor(saved = {}) { Object.assign(this, { stage: 1, steps: 0, stalled: 0, errors: {}, checks: {}, blocked: null }, saved); }
  step(limit) { if (this.blocked) return false; if (++this.steps > limit) this.blocked = { code: 'STAGE_BUDGET', message: 'A verified stage is required before continuing.' }; return !this.blocked; }
  // The result observer calls this only for an authoritative completed success.
  // Clearing counters is not verification and never resumes a blocked run.
  resolveOperation(scope) {
    const prefix = operationErrorPrefix(scope);
    if (this.blocked || !prefix) return 0;
    let removed = 0;
    for (const key of Object.keys(this.errors)) if (key.startsWith(prefix)) { delete this.errors[key]; removed++; }
    return removed;
  }
  observe({ kind, exitCode, text, isError, manifestHash, timedOut, aborted, recovery, operationScope }, limit = 3) {
    if (this.blocked) return { improved: false };
    const classification = recovery ?? classifyToolOutcome({ kind, exitCode, text, isError, timedOut, aborted });
    const failed = classification.failed;
    if (classification.category === 'cancelled') return { improved: false, key: 'cancelled', category: classification.category };
    if (!kind && !failed) return { improved: false };
    // Setup/usage failures are not failed verification or attempted repairs.
    // Still stop a genuinely repeated tool error, without combining unrelated errors.
    if (!kind || !classification.verification) {
      const fingerprint = (operationErrorPrefix(operationScope) ?? '') + classification.category + ':' + errorFingerprint(text);
      this.errors[fingerprint] = (this.errors[fingerprint] ?? 0) + 1;
      if (this.errors[fingerprint] >= limit) this.blocked = { code: 'REPEATED_TOOL_ERROR', message: 'The same tool error repeated without resolution. Review the error and choose a different approach.' };
      return { improved: false, key: 'tool-error', category: classification.category, blocked: this.blocked };
    }
    const key = kind ?? 'tool-error', previous = this.checks[key], score = failed ? Number.isSafeInteger(classification.evidence?.failed) && classification.evidence.failed > 0 ? classification.evidence.failed : checkScore(exitCode === 0 ? 1 : exitCode, text) : 0;
    // A prior pass ends its repair series. A later failure must establish a
    // new baseline: no positive failure count can improve on historical zero.
    // This also repairs persisted zero minima without clearing any stop budget.
    const comparison = failed && previous?.bestScore === 0
      ? Number.isFinite(previous.lastScore) && previous.lastScore > 0 ? { ...previous, bestScore: previous.lastScore } : undefined
      : previous;
    const fingerprint = failed ? errorFingerprint(text) : null;
    if (fingerprint) this.errors[fingerprint] = (this.errors[fingerprint] ?? 0) + 1;
    const improved = !comparison || score < comparison.bestScore;
    this.checks[key] = { bestScore: improved ? score : comparison.bestScore, lastScore: score, fingerprint, manifestHash };
    if (!failed) { this.steps = 0; this.stalled = 0; this.errors = {}; this.stage++; }
    else if (improved && comparison) this.stalled = 0;
    else this.stalled++;
    if (failed && (this.stalled >= limit || this.errors[fingerprint] >= limit)) this.blocked = { code: 'REPAIR_NO_PROGRESS', message: 'Repeated repairs did not improve verification. Review the checkpoint and choose a different approach.' };
    return { improved, score, key, blocked: this.blocked };
  }
  resume(strategy) {
    if (typeof strategy !== 'string' || strategy.trim().length < 15 || strategy.length > 2000) throw new WorkbenchError('STRATEGY_REQUIRED', 'Describe a different approach before resuming.', 400);
    this.blocked = null; this.steps = 0; this.stalled = 0; this.errors = {}; this.stage++;
  }
}
