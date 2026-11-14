import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

export const name = 'homeai-completion-guard';

// Only unmistakable short progress announcements qualify. A normal answer,
// explanation, blocker or request for permission must remain a valid ending.
export function isProgressOnly(text) {
  const value = text.trim();
  if (!value || value.length > 240 || value.split(/\s+/u).length > 36 || /[?？`]/u.test(value)) return false;
  if (/\b(?:done|complete[ds]?|finished|implemented|passed|blocked|cannot|can't|unable|please|your|permission|approval)\b|hotovo|dokončen|dokončil|nemohu|nelze|potřebuji|povolení|souhlas/iu.test(value)) return false;
  return /^(?:now|next)[,:]?\s+(?:the\s+)?(?:stylesheet|styles?|css|tests?|backend|frontend|implementation|validation|build|screenshots?)[.!…]?$/iu.test(value)
    || /^(?:i(?:['’]ll| will)|let me)\s+(?:(?:now|next|also)\s+)?(?:add|write|create|implement|fix|update|run|check|test|verify|build|continue|finish)\b[^\n]*[.!…]?$/iu.test(value)
    || /^(?:teď|nyní|dále)\s+(?:(?:ještě|tedy)\s+)?(?:doplním|vytvořím|napíšu|opravím|upravím|spustím|ověřím|otestuji|přidám|pokračuji)\b[^\n]*[.!…]?$/iu.test(value);
}

export function shouldContinue(state, { turn, signal, inbox, providers, maxContinuations }) {
  if (!state || state.turn !== turn || signal?.aborted || inbox?.nextStep?.length || inbox?.nextTurn?.length) return false;
  if (!state.tools || state.lastToolFailed || state.hitTokenLimit || state.continuations >= maxContinuations) return false;
  const message = state.message;
  if (!providers.has(message?.source?.provider) || message.source?.replayState?.response?.stopReason !== 'stop') return false;
  if (!message.content?.length || message.content.some(x => !['text', 'thinking'].includes(x.type))) return false;
  return isProgressOnly(message.content.filter(x => x.type === 'text').map(x => x.text).join('\n'));
}

export function apply(ctx, config = {}) {
  const providers = new Set(config.providers ?? ['strata-vast']);
  const maxContinuations = Number.isInteger(config.maxContinuations) ? Math.min(2, Math.max(0, config.maxContinuations)) : 2;
  const states = new WeakMap();
  function status(value) {
    if (!config.statusPath) return;
    // Diagnostics must never break a turn or write conversation content.
    try { fs.writeFileSync(config.statusPath, JSON.stringify({ at: Date.now(), ...value }), { mode: 0o600 }); } catch {}
  }
  status({ loaded: true, maxContinuations });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') { states.delete(session); return; }
    const turn = event.data?.turn;
    if (!Number.isInteger(turn)) return;
    let state = states.get(session);
    if (!state || state.turn !== turn) {
      state = { turn, tools: 0, lastToolFailed: false, continuations: 0 };
      states.set(session, state);
    }
    if (event.type === 'assistant/message') {
      state.message = event.data.message;
      if (['length', 'max-tokens'].includes(state.message?.source?.replayState?.response?.stopReason)) state.hitTokenLimit = true;
    }
    if (event.type === 'tool/result') {
      state.tools++;
      state.lastToolFailed = event.data.message?.isError !== false;
    }
  });
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    const state = states.get(agent.session);
    if (!shouldContinue(state, { turn, signal, inbox: agent.inbox, providers, maxContinuations })) return;
    const attempt = state.continuations + 1;
    // Supported steering keeps the same turn, FIFO ownership and cancellation.
    // Never edit the session log or launch an independent follow-up task.
    agent.steer({ id: randomUUID(), role: 'user', source: { kind: 'homeai-completion-guard' }, content: [{ type: 'text', text:
      `[Completion check ${attempt}/${maxContinuations}] Your last response only announced the next action and then stopped. Continue the existing user request using the available tools and finish the work you just announced. Respect the original scope and permissions; do not start unrelated work. If a real blocker or user decision prevents progress, explain it and stop. After the requested work and proportionate checks are complete, give a factual final result instead of another promise.` }] });
    state.continuations = attempt;
    status({ loaded: true, sessionId: agent.session.id, turn, continuations: attempt, maxContinuations });
  }, { global: true });
}
