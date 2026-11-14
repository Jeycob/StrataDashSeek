import path from 'node:path';
import crypto from 'node:crypto';
import { classifyToolOutcome } from './tool-recovery.mjs';

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
export function validationKind(command) {
  if (typeof command !== 'string') return null;
  if (/\b(?:pytest|cargo\s+test|go\s+test|dotnet\s+test|node\s+--test|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|check|typecheck)|playwright\s+test)\b/iu.test(command)) return 'test';
  if (/\b(?:dotnet\s+build|cargo\s+(?:build|check)|go\s+build|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:build|lint)|tsc\b|eslint\b)/iu.test(command)) return 'build';
  return null;
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
  observe({ kind, exitCode, text, isError, manifestHash, timedOut, aborted, recovery }, limit = 3) {
    if (this.blocked) return { improved: false };
    const classification = recovery ?? classifyToolOutcome({ kind, exitCode, text, isError, timedOut, aborted });
    const failed = classification.failed;
    if (classification.category === 'cancelled') return { improved: false, key: 'cancelled', category: classification.category };
    if (!kind && !failed) return { improved: false };
    // Setup/usage failures are not failed verification or attempted repairs.
    // Still stop a genuinely repeated tool error, without combining unrelated errors.
    if (!kind || !classification.verification) {
      const fingerprint = classification.category + ':' + errorFingerprint(text);
      this.errors[fingerprint] = (this.errors[fingerprint] ?? 0) + 1;
      if (this.errors[fingerprint] >= limit) this.blocked = { code: 'REPEATED_TOOL_ERROR', message: 'The same tool error repeated without resolution. Review the error and choose a different approach.' };
      return { improved: false, key: 'tool-error', category: classification.category, blocked: this.blocked };
    }
    const key = kind ?? 'tool-error', previous = this.checks[key], score = failed ? checkScore(exitCode === 0 ? 1 : exitCode, text) : 0;
    const fingerprint = failed ? errorFingerprint(text) : null;
    if (fingerprint) this.errors[fingerprint] = (this.errors[fingerprint] ?? 0) + 1;
    const improved = !previous || score < previous.bestScore;
    this.checks[key] = { bestScore: improved ? score : previous.bestScore, lastScore: score, fingerprint, manifestHash };
    if (!failed) { this.steps = 0; this.stalled = 0; this.errors = {}; this.stage++; }
    else if (improved && previous) this.stalled = 0;
    else this.stalled++;
    if (failed && (this.stalled >= limit || this.errors[fingerprint] >= limit)) this.blocked = { code: 'REPAIR_NO_PROGRESS', message: 'Repeated repairs did not improve verification. Review the checkpoint and choose a different approach.' };
    return { improved, score, key, blocked: this.blocked };
  }
  resume(strategy) {
    if (typeof strategy !== 'string' || strategy.trim().length < 15 || strategy.length > 2000) throw new WorkbenchError('STRATEGY_REQUIRED', 'Describe a different approach before resuming.', 400);
    this.blocked = null; this.steps = 0; this.stalled = 0; this.errors = {}; this.stage++;
  }
}
