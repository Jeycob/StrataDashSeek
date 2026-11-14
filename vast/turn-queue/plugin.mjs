import fs from 'node:fs';
import path from 'node:path';
import { TurnQueue } from './queue.mjs';

export const name = 'local-turn-queue';
export const inject = ['agents', 'sessions', 'llm'];

export function persistStatus(file, state, io = fs) {
  const temp = file + '.' + process.pid + '.tmp';
  const json = JSON.stringify(state, null, 2);
  io.writeFileSync(temp, json, 'utf8');
  try { io.renameSync(temp, file); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(error.code)) throw error;
    // Windows readers can allow writes but deny replacing an open file.
    // Status is non-authoritative diagnostics: a direct write is preferable to
    // retaining a stale owner forever. This never changes the scheduling lock.
    io.writeFileSync(file, json, 'utf8');
    try { io.unlinkSync(temp); } catch { /* Harmless diagnostic temp file. */ }
  }
}

export function rootOf(agent, agents) {
  let current = agent, rootId = agent.id;
  const visited = new Set([rootId]);
  while (current?.session?.header?.origin === 'subagent') {
    const parentId = current.session.header.parentSession;
    if (!parentId || visited.has(parentId)) break;
    rootId = parentId;
    visited.add(parentId);
    current = agents.get(parentId);
  }
  return rootId;
}

export function apply(ctx, config = {}) {
  const providers = new Set(config.providers ?? ['strata1']);
  const statusPath = config.statusPath;
  if (statusPath) fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const queue = new TurnQueue((event, state, ticket) => {
    if (statusPath) {
      persistStatus(statusPath, { ...state, implementation: '1.1.2', moduleUrl: import.meta.url });
    }
    // Event-scoped logger access may be unavailable in a lazily consumed stream.
    // Persist diagnostics first; logging must not leave a stale queue snapshot.
    try { ctx.logger.info(JSON.stringify({ event: 'local-turn-queue-' + event, ...ticket,
      owner: state.owner, waiting: state.waiting.length })); } catch { /* Diagnostic only. */ }
  });
  const streams = new TurnQueue();
  let streamSequence = 0;
  // Prepend is essential: automatic compaction is another pre-step listener and
  // must not run its own model request before this root turn owns the model.
  ctx.on('agent/pre-step', async ({ agent, turn, signal, modelSelection }, next) => {
    if (!providers.has(modelSelection.provider)) return next();
    await queue.enter({ rootId: rootOf(agent, ctx.agents), sessionId: agent.session.id,
      turn, signal });
    signal.throwIfAborted();
    return next();
  }, { prepend: true, global: true });
  ctx.on('agent/request', async (_input, next) => {
    const request = await next();
    if (!providers.has(request.provider)) return request;
    // Resumed sessions can carry a saved 65536-token output override. Keep the
    // focused ceiling without changing their selected model or reasoning effort.
    return { ...request, maxTokens: Math.min(request.maxTokens ?? 32768, config.maxTokens ?? 32768) };
  }, { global: true });
  // Cover all calls through the supported LLM seam, including manual compact,
  // maintenance and auxiliary callers that are outside the agent step loop.
  // Acquisition is lazy so constructing an unused iterator cannot seize a slot.
  ctx.on('llm/stream', function (options, next) {
    if (!providers.has(options.provider)) return next();
    // Compaction's own short output cap must not be consumed entirely by the
    // provider's default reasoning budget. Re-enter the public streaming API
    // with explicit controls; the normalized request takes the ordinary gate.
    // This applies only to unprepared compaction calls, never agent-loop calls
    // whose selected model/effort are already snapshotted in durable headers.
    const summaryLimit = config.compactionMaxTokens ?? 8192;
    if (options.purpose === 'compaction' &&
        (options.reasoningEffort !== 'off' || (options.maxTokens ?? 0) < summaryLimit)) {
      const instruction = { role: 'user', content: [{ type: 'text', text:
        'Checkpoint budget: write a factual handoff in at most 1000 words. Preserve the concrete user goal, constraints, exact paths, completed changes, unresolved errors and next actions. Do not restate tool catalogs or environment boilerplate. Do not invent missing facts. Stop after the next actions.' }] };
      return this.stream({ ...options, reasoningEffort: 'off',
        messages: [...(options.messages ?? []), instruction],
        maxTokens: Math.max(options.maxTokens ?? 0, summaryLimit) });
    }
    let agent = options.sessionId === undefined ? undefined : ctx.agents.get(String(options.sessionId));
    if (!agent) {
      try {
        const candidate = ctx.agents.currentInitiator?.();
        if (candidate && ctx.agents.get(candidate.id) === candidate) agent = candidate;
      } catch { /* A disposed initiator is not an active turn owner. */ }
    }
    const key = '@llm:' + process.pid + ':' + (++streamSequence);
    const rootId = agent ? rootOf(agent, ctx.agents) : options.sessionId === undefined ? key : String(options.sessionId);
    return (async function* () {
      let ownsTurn = false, ownsStream = false;
      try {
        await queue.enter({ rootId, sessionId: key, turn: 0, signal: options.signal });
        ownsTurn = true;
        await streams.enter({ rootId: key, sessionId: key, turn: 0, signal: options.signal });
        ownsStream = true;
        if (options.signal?.aborted) throw options.signal.reason;
        yield* await next();
      } finally {
        if (ownsStream) streams.end(key, 0);
        if (ownsTurn) queue.end(key, 0);
      }
    })();
  }, { prepend: true, global: true });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') queue.end(session.id, event.data.turn);
  });
  ctx.on('agent/disposed', ({ agent }) => queue.end(agent.id));
  ctx.on('session/disposed', session => queue.end(session.id));
  ctx.effect(() => () => { streams.close(); queue.close(); }, 'local-turn-queue.dispose');
  queue.changed('ready');
}
