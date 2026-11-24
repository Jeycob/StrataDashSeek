import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import runtime from '../require.cjs';
import { bindFileRecoveryTarget, createFileRecovery, cutFileTool, fileRecoverySection, fileRecoveryTools,
  firstStepFileTools, guardFileRecovery, isCreateOnlyRecoveryWrite, observeFileRecovery } from './file-recovery.mjs';

export const name = 'homeai-output-continuation';
export const inject = ['agents', 'sessions', 'tools'];

const loopPackage = '@deepseek-ai/dsh-agent-loop';
const reviewedLoop = 'f09f60814d4e96a880f41b9fc3832f33c56a28f954f48810d8439ce83ad6ffa8';
const maxContinuations = 8;
const maxStalledContinuations = 2;
const maxToolIds = 4096;
const resumeSection = Object.freeze({
  name: 'homeai-output-continuation',
  order: 10000,
  interpolate: false,
  text: '[Output limit recovery] Resume the current task from the latest saved answer and committed workspace or tool results. Follow any newer user direction. Keep reasoning short and continue where the visible answer stopped without repeating it. If a needed tool call was cut off, construct a complete new call, never reuse partial arguments. Split long writes into small, complete tool calls. Do not repeat tool operations already attempted in this turn.',
});

function reviewedAgentLoop(ctx) {
  try {
    const anchor = ctx.get('profileContext')?.installAnchor;
    const entry = anchor ? createRequire(anchor).resolve(loopPackage) : runtime.resolveRuntime(loopPackage);
    return createHash('sha256').update(readFileSync(entry)).digest('hex') === reviewedLoop;
  } catch { return false; }
}

function remember(state, callId) {
  if (state.calls.has(callId)) return;
  if (state.calls.size < maxToolIds) state.calls.add(callId);
  else state.toolHistoryFull = true;
}

// rc.2 settles partial assistant output (including usage), strips all calls
// from a max-token attempt and returns before executing any of them. At this
// exact boundary null asks the stock turn loop for another ordinary step.
// The stock loop owns accounting, tool admission, scheduling and cancellation.
export function apply(ctx) {
  if (!reviewedAgentLoop(ctx)) {
    ctx.logger.warn('Output-limit continuation unavailable for this Native SDK build.');
    return;
  }
  const attached = new Map();
  const sessions = new WeakMap();

  function attach(agent) {
    if (attached.has(agent) || typeof agent.step !== 'function' || typeof agent.buildRequest !== 'function') return;
    const original = agent.step;
    const own = Object.getOwnPropertyDescriptor(agent, 'step');
    // A hot attachment has no observations for the already running turn.
    const skipTurn = agent.phase?.kind === 'running' ? agent.phase.turn : undefined;
    const entry = { state: null, detach };
    async function continuationStep(decision) {
      const phase = this.phase;
      if (phase?.kind !== 'running' || phase.turn === skipTurn) return original.call(this, decision);
      const { turn, abort: { signal } } = phase;
      const firstStep = entry.state?.turn !== turn;
      if (firstStep) {
        entry.state = { turn, attempts: 0, stalled: 0, pending: false, inStep: false, calls: new Set(), toolHistoryFull: false };
      }
      const state = entry.state;
      // Keep the recovery section on the SDK's durable system-prompt surface,
      // even for complete preset prompts. The SDK logs and replays it normally.
      const recoverySections = state.file ? [fileRecoverySection(state.file)] : state.pending ? [resumeSection] : [];
      const tools = state.file ? fileRecoveryTools(decision.assembly.tools, state.file) :
        firstStep ? firstStepFileTools(decision.assembly.tools) : decision.assembly.tools;
      const next = recoverySections.length || tools !== decision.assembly.tools ? {
        ...decision,
        assembly: { ...decision.assembly, sections: [...decision.assembly.sections, ...recoverySections],
          tools },
      } : decision;
      state.recovering = state.pending;
      state.pending = false;
      state.inStep = true;
      state.output = null;
      state.fileToolCut = false;
      state.toolConcluded = false;
      let outcome;
      try { outcome = await original.call(this, next); }
      finally { state.inStep = false; }
      // Some providers terminate with reasoning or no answer at all after a
      // cut. A clean finish chunk alone is insufficient to clear that cut.
      if (outcome?.kind === 'completed') {
        if (state.file && !state.file.confirmed) {
          outcome = { kind: 'max-tokens' };
          // A genuine explanation of a blocker is terminal. An empty stop can
          // spend the same remaining recovery allowance as another length cut.
          if (state.output || state.toolConcluded) return outcome;
        } else if (state.attempts && (!state.output || state.output === state.priorCut) && !state.toolConcluded) {
          return { kind: 'max-tokens' };
        }
      }
      if (outcome?.kind !== 'max-tokens' || signal.aborted || attached.get(agent) !== entry) return outcome;
      if (state.fileToolCut) {
        if (!state.file) state.file = createFileRecovery();
        else state.file.repeatedCut = true;
      }
      if (!state.file && state.output && state.output !== state.priorCut) {
        state.stalled = 0;
        state.priorCut = state.output;
      } else if (state.recovering) state.stalled++;
      if (state.attempts >= maxContinuations || state.stalled >= maxStalledContinuations || state.toolHistoryFull) return outcome;
      state.attempts++;
      state.pending = true;
      return null;
    }
    function detach() {
      if (agent.step === continuationStep) {
        if (own) Object.defineProperty(agent, 'step', own);
        else delete agent.step;
      }
      attached.delete(agent);
      sessions.delete(agent.session);
    }
    Object.defineProperty(agent, 'step', { value: continuationStep, configurable: true, writable: true });
    attached.set(agent, entry);
    sessions.set(agent.session, entry);
  }

  for (const agent of ctx.agents.list()) attach(agent);
  ctx.on('agent/created', ({ agent }) => attach(agent), { global: true });
  ctx.on('agent/disposed', ({ agent }) => attached.get(agent)?.detach(), { global: true });
  ctx.on('session/event', (session, event) => {
    const entry = sessions.get(session), state = entry?.state;
    if (!state || state.turn !== event.data?.turn) return;
    if (event.type === 'turn/end') entry.state = null;
    if (event.type === 'assistant/message' && state.inStep) {
      state.fileToolCut = cutFileTool(event.data.stream);
      const visible = event.data.message.content.flatMap(block => {
        if (block.type === 'text' && block.text.trim()) return [block.text.trim()];
        return block.type === 'image' || block.type === 'file' ? [block.type] : [];
      });
      if (visible.length) state.output = createHash('sha256').update(JSON.stringify(visible)).digest('hex');
    }
  }, { global: true });
  ctx.on('tools/result', (exec, result) => {
    const state = attached.get(exec.agent)?.state;
    if (!state?.inStep) return;
    remember(state, exec.callId);
    if (state.file ? observeFileRecovery(state.file, exec, result) : result.isError === false) state.stalled = 0;
    if (result.concludesTurn === true) state.toolConcluded = true;
  }, { global: true });
  ctx.tools.guard(exec => {
    const state = attached.get(exec.agent)?.state;
    if (!state?.inStep) return;
    if (state.recovering) {
      // A new call can legitimately verify a changed workspace.
      if (state.calls.has(exec.callId)) return 'This tool call was already attempted. Use its recorded result.';
      if (state.toolHistoryFull || state.calls.size >= maxToolIds) {
        return 'Output-limit recovery has reached its tool tracking limit. Report the remaining work.';
      }
      remember(state, exec.callId);
    }
    if (state.file) return guardFileRecovery(state.file, exec);
  });
  ctx.on('fs/write-intent', async (target, exec, next) => {
    const intent = await next();
    bindFileRecoveryTarget(exec, target.targetKey);
    return isCreateOnlyRecoveryWrite(exec) ? { kind: 'createIfAbsent' } : intent;
  }, { prepend: true, global: true });
  ctx.on('fs/edit-intent', async (target, exec, next) => {
    const intent = await next();
    bindFileRecoveryTarget(exec, target.targetKey);
    return intent;
  }, { prepend: true, global: true });
  ctx.effect(() => () => { for (const entry of attached.values()) entry.detach(); });
}
