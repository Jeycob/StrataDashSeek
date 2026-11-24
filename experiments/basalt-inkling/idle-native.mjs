// Optional process-local Cordis service. It is deliberately absent from the default lab profile.
import { randomUUID } from 'node:crypto';
import { attachBridge } from './idle-native-control.mjs';

export const name = 'basalt-idle-activity';
export const inject = ['agents', 'jobs', 'tools', 'sessionController', 'sessionQuery', 'sessionProjections', 'sessionPersistence', 'terminals', 'typertGateway'];
const jobStates = new Set(['running', 'stopping', 'completed', 'killed', 'failed']);

export function observeNative(ctx) {
  const epoch = randomUUID();
  let revision = 0;
  let executing = 0;
  const cold = new Map();
  const changed = () => { revision++; };
  const global = { global: true };
  ctx.on('session/event', changed, global);
  ctx.on('agent/created', changed, global);
  ctx.on('agent/disposed', changed, global);
  ctx.on('agent/status', changed, global);
  ctx.jobs.events.subscribe({ owners: 'all' }, changed);
  ctx.on('tools/execute', async (_exec, next) => {
    executing++;
    changed();
    try { return await next(); }
    finally { executing--; changed(); }
  }, { ...global, prepend: true });

  async function coldInbox(header, cursor) {
    const cached = cold.get(header.id);
    if (cached?.cursor === cursor && cached.createdAt === header.createdAt) return cached.pending;
    const snapshot = await ctx.sessionQuery.readSession(header.id);
    if (snapshot.header.id !== header.id || snapshot.header.createdAt !== header.createdAt ||
        (snapshot.events.at(-1)?.seq ?? -1) !== cursor) throw Error('Cold history changed');
    const { checkpoint } = ctx.sessionProjections.restore({}, snapshot.events, 0, snapshot.header, snapshot.inheritedEventCount);
    const inbox = checkpoint.inbox;
    if (inbox?.ver !== 1 || inbox.seq !== cursor || !Array.isArray(inbox.val?.['next-turn']) || !Array.isArray(inbox.val?.['next-step'])) {
      throw Error('Incomplete Native inbox projection');
    }
    const pending = inbox.val['next-turn'].length + inbox.val['next-step'].length;
    cold.set(header.id, { cursor, createdAt: header.createdAt, pending });
    return pending;
  }

  async function read(signal) {
    signal.throwIfAborted();
    const start = revision;
    const corpus = await ctx.sessionQuery.listSessions(signal);
    if (!Array.isArray(corpus)) throw Error('Native session corpus unavailable');
    const owners = new Set();
    let turns = 0, queued = 0, terminals = 0;
    for (const row of corpus) {
      const id = row.header?.id;
      if (!id || owners.has(id) || row.formatStatus === 'migration-required') throw Error('Unverified Native session');
      owners.add(id);
      // state() is passive in rc.2. No follow(), prompt(), resume() or activating open().
      const state = await ctx.sessionController.state({ sessionId: id }, signal);
      if (typeof state?.running !== 'boolean' || typeof state.active !== 'boolean' || !Number.isSafeInteger(state.cursor) ||
          state.cursor < -1 || !Array.isArray(state.pendingInput) ||
          (state.active ? !Array.isArray(state.queue) : state.queue !== null)) {
        throw Error('Incomplete passive session state');
      }
      if (state.running) turns++;
      if (state.active) cold.delete(id);
      queued += (state.active ? state.queue.length : await coldInbox(row.header, state.cursor)) + state.pendingInput.length;
    }
    for (const id of cold.keys()) if (!owners.has(id)) cold.delete(id);
    for (const agent of ctx.agents.list()) {
      if (!owners.has(agent.id) || !['running', 'idle'].includes(agent.status) ||
          typeof agent.phase?.kind !== 'string' || !Array.isArray(agent.inbox?.nextStep) || !Array.isArray(agent.inbox?.nextTurn)) {
        throw Error('Unverified live agent');
      }
      // An SDK between-turn maintenance task can keep the public status idle.
      if (agent.phase.kind !== 'idle' || agent.status === 'running') turns++;
      queued += agent.inbox.nextTurn.length + agent.inbox.nextStep.length;
      const hasTerminal = ctx.terminals.hasOwnerActivity(agent);
      if (typeof hasTerminal !== 'boolean') throw Error('Unverified terminal owner');
      if (hasTerminal) terminals++;
    }
    // list() alone sees unowned jobs only. Each owner-specific list also includes them.
    const activeJobs = new Set();
    for (const owner of [undefined, ...owners]) {
      const rows = ctx.jobs.list(owner);
      if (!Array.isArray(rows)) throw Error('Native job roster unavailable');
      for (const job of rows) {
        if (!job?.id || !jobStates.has(job.status)) throw Error('Unverified Native job');
        if (job.status === 'running' || job.status === 'stopping') activeJobs.add(job.id);
      }
    }
    signal.throwIfAborted();
    if (start !== revision) throw Error('Native changed during snapshot');
    return { epoch, revision, busy: Boolean(turns || queued || executing || terminals || activeJobs.size) };
  }
  return { read, epoch, revision: () => revision, flush: () => ctx.sessionPersistence.flush() };
}

export function apply(ctx) {
  const activity = observeNative(ctx);
  ctx.provide('basaltIdleActivity', activity);
  if (process.env.BASALT_IDLE_BRIDGE === '1') attachBridge(ctx, activity);
}
