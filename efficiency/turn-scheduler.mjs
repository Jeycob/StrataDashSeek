import {TurnQueue} from '../vast/turn-queue/queue.mjs';

const continuationHandoffMs = 30_000;

export function createTurnScheduler(agents, onChange) {
  const turns = new Map();
  const pending = new Map();
  const continuations = new Map();
  const queue = new TurnQueue((_event, state) => onChange(project(state)));

  function project(state) {
    // A family owns one slot even when its child turns and streams overlap.
    function families(tickets) {
      const seen = new Set();
      return tickets.filter(ticket => {
        if (seen.has(ticket.rootId)) return false;
        seen.add(ticket.rootId);
        return true;
      }).map(ticket => ({
        rootId: ticket.rootId.sessionId, sessionId: ticket.rootId.sessionId,
        queuedAt: ticket.rootId.queuedAt, admittedAt: ticket.rootId.admittedAt ?? null,
      }));
    }
    const owner = state.owner;
    if (owner && owner.admittedAt === undefined) {
      owner.admittedAt = state.active.find(ticket => ticket.rootId === owner)?.admittedAt ?? undefined;
    }
    return {
      closed: state.closed, capacity: 1, owner: owner?.sessionId ?? null,
      active: families(state.active), waiting: families(state.waiting),
    };
  }

  function ancestorTurn(session) {
    const seen = new Set();
    while (session?.header?.origin === 'subagent') {
      const parentId = session.header.parentSession;
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      const parent = turns.get(parentId);
      if (parent) return parent;
      session = agents.get(parentId)?.session;
    }
  }

  function end(sessionId, turn) {
    const entry = turns.get(sessionId);
    if (!entry || (turn !== undefined && entry.turn !== turn)) return;
    turns.delete(sessionId);
    const continuation = continuations.get(sessionId);
    if (continuation?.family === entry.family && !continuation.timer) {
      continuation.timer = setTimeout(continuation.release, continuationHandoffMs);
      continuation.timer.unref?.();
    }
    release(entry);
  }

  function reserveEntry(sessionId, family, ticketId, ticketTurn) {
    const abort = new AbortController();
    const ready = queue.enter({rootId: family, sessionId: ticketId, turn: ticketTurn, signal: abort.signal});
    // A turn may fail during setup or be cancelled before its first pre-step.
    void ready.catch(() => {});
    return {sessionId, family, ticketId, ticketTurn, abort, ready};
  }

  function release(entry) {
    queue.end(entry.ticketId, entry.ticketTurn);
  }

  function takePending(sessionId, messageId) {
    const messages = pending.get(sessionId);
    const entry = messages?.get(messageId);
    if (!entry) return;
    messages.delete(messageId);
    if (messages.size === 0) pending.delete(sessionId);
    return entry;
  }

  function reserveInbox(session, messageId) {
    if (!session?.id || session.header?.origin === 'subagent' || typeof messageId !== 'string' || !messageId) return;
    const continuation = continuations.get(session.id);
    if (continuation?.nextMessageId === messageId) return;
    // A newly accepted independent request takes its own place. A verification
    // continuation cannot dispatch while that request is in the SDK inbox.
    continuation?.release();
    // Native reports an agent under manual maintenance as idle. Its next turn
    // cannot start until maintenance (which can itself need the model) ends.
    // Reserve early only behind a turn whose local ownership we already track.
    if (!turns.has(session.id)) return;
    const messages = pending.get(session.id) ?? new Map();
    if (messages.has(messageId)) return;
    const family = {sessionId: session.id, messageId, queuedAt: Date.now()};
    const ticketId = '@efficiency-inbox:' + JSON.stringify([session.id, messageId]);
    messages.set(messageId, reserveEntry(session.id, family, ticketId, 0));
    pending.set(session.id, messages);
  }

  function discardInbox(sessionId, messageId) {
    const continuation = continuations.get(sessionId);
    if (continuation?.nextMessageId === messageId) continuation.release();
    const entry = takePending(sessionId, messageId);
    if (entry) release(entry);
  }

  function finishSession(sessionId) {
    end(sessionId);
    const messages = pending.get(sessionId);
    if (!messages) return;
    pending.delete(sessionId);
    for (const entry of messages.values()) release(entry);
  }

  function start(session, turn, local, messageId) {
    if (!session?.id || !Number.isSafeInteger(turn)) return;
    const current = turns.get(session.id);
    if (current?.turn === turn) return current;
    if (current && current.turn > turn) return;
    const parent = ancestorTurn(session);
    const reserved = takePending(session.id, messageId);
    const continuation = continuations.get(session.id);
    const continuing = Boolean(local && messageId && continuation?.nextMessageId === messageId);
    if (!continuing) continuation?.release();
    if (!local && !parent) {
      if (reserved) release(reserved);
      return;
    }
    if (current) end(session.id, current.turn);
    const family = continuing ? continuation.family : parent?.family ?? {sessionId: session.id, messageId, queuedAt: Date.now()};
    const entry = reserved ?? reserveEntry(session.id, family, session.id, turn);
    entry.turn = turn;
    turns.set(session.id, entry);
    if (continuing) continuation.release();
    return entry;
  }

  function continuationLease({sessionId, turn, messageId}) {
    const entry = turns.get(sessionId);
    if (!entry || !Number.isSafeInteger(turn) || !messageId || entry.family.messageId !== messageId ||
        entry.family.sessionId !== sessionId || queue.snapshot().owner !== entry.family || continuations.has(sessionId)) return;
    const family = entry.family;
    const held = reserveEntry(sessionId, family, '@efficiency-continuation:' + sessionId, 0);
    const continuation = {family, nextMessageId: null, timer: null, release: () => {
      if (continuations.get(sessionId) !== continuation) return;
      continuations.delete(sessionId);
      clearTimeout(continuation.timer);
      release(held);
    }};
    continuations.set(sessionId, continuation);
    return {
      bind(nextMessageId) {
        if (continuations.get(sessionId) !== continuation || typeof nextMessageId !== 'string' || !nextMessageId ||
            (continuation.nextMessageId && continuation.nextMessageId !== nextMessageId)) return false;
        continuation.nextMessageId = nextMessageId;
        return true;
      },
      release: continuation.release,
    };
  }

  async function join(entry, signal) {
    if (!entry) return;
    const cancel = () => entry.abort.abort(signal.reason);
    if (signal?.aborted) cancel();
    signal?.addEventListener('abort', cancel, {once: true});
    try {
      await entry.ready;
      signal?.throwIfAborted();
      if (turns.get(entry.sessionId) !== entry) throw Error('Model turn has ended');
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  async function holdStream(session, fallbackId, requestId, signal) {
    signal?.throwIfAborted();
    const entry = turns.get(session?.id) ?? ancestorTurn(session);
    // An idle agent may need local inference to finish Native maintenance
    // before it can open a continuation turn. That request takes its own FIFO
    // position; it must neither block on nor inherit the stale handoff hold.
    if (!entry) continuations.get(session?.id)?.release();
    await join(entry, signal);
    const assertLive = () => {
      signal?.throwIfAborted();
      if (entry && turns.get(entry.sessionId) !== entry) throw Error('Model turn has ended');
    };
    assertLive();
    const family = entry?.family ?? {sessionId: fallbackId, queuedAt: Date.now()};
    const streamId = '@efficiency-stream:' + requestId;
    const release = () => queue.end(streamId, 0);
    try {
      await queue.enter({rootId: family, sessionId: streamId, turn: 0, signal});
      assertLive();
      return {assertLive, release};
    } catch (error) {
      release();
      throw error;
    }
  }

  return {
    start, end, reserveInbox, discardInbox, finishSession, continuationLease, join, holdStream,
    disposeSession(sessionId) {
      continuations.get(sessionId)?.release();
      finishSession(sessionId);
    },
    snapshot: () => project(queue.snapshot()),
    close() {
      turns.clear();
      pending.clear();
      for (const continuation of continuations.values()) clearTimeout(continuation.timer);
      continuations.clear();
      queue.close();
    },
  };
}
