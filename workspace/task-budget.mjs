import { WorkbenchError } from './policy.mjs';

const human = message => message?.role === 'user' && message.source?.kind === 'user' && typeof message.id === 'string' && message.id.length > 0;
const reasons = {
  TASK_TIME_LIMIT: 'The time limit for this task was reached. Files and recorded checks are retained.',
  TASK_TOKEN_LIMIT: 'The reported token limit for this task was reached. Files and recorded checks are retained.',
  TASK_BUDGET_USAGE_UNAVAILABLE: 'The model did not report an exact token total, so the requested token limit cannot be enforced. Files and recorded checks are retained.',
  TASK_BUDGET_USAGE_INTERRUPTED: 'Token accounting was interrupted before its result was saved. Files and recorded checks are retained.',
};
export function taskLimit(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkbenchError('INVALID_TASK_LIMIT', 'Choose no limit, elapsed minutes, or reported tokens.', 400);
  const field = value.kind === 'elapsed' ? 'minutes' : value.kind === 'tokens' ? 'totalTokens' : null;
  const max = field === 'minutes' ? 1440 : 10000000;
  if (!field || Object.keys(value).sort().join(',') !== [field, 'kind'].sort().join(',') || !Number.isSafeInteger(value[field]) || value[field] < 1 || value[field] > max)
    throw new WorkbenchError('INVALID_TASK_LIMIT', 'Invalid task limit.', 400);
  return { kind: value.kind, [field]: value[field] };
}

// One optional user request, not a session-wide allowance. Public session
// events bind the next human input; public normalized SDK usage is the meter.
export function createTaskBudgets(ctx, manager, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const timers = new Map(), bindings = new WeakMap(), turns = new WeakMap(), jobs = new Map(), liveUsage = new WeakMap();
  let disposed = false;
  const rows = () => manager.data.taskBudgets ??= {};
  const ownerOf = agent => manager.ownerAgent(agent);
  const cancelTimer = task => { const timer = timers.get(task); if (timer) clearTimer(timer); timers.delete(task); };
  const persist = () => manager.save();
  const retainSave = () => { void persist().catch(() => ctx.logger?.warn('Task budget persistence is unconfirmed.')); };
  const current = (id, task) => rows()[id]?.current === task;
  const tracked = (id, task) => current(id, task) || rows()[id]?.background?.includes(task);
  const hasWork = task => [...jobs.values()].some(job => job.task === task && !job.deliveredPreview) || ctx.agents.list().some(agent => bindings.get(agent)?.task === task && turns.get(agent.session) === bindings.get(agent).turn);
  const taskView = task => task ? { turn: task.turn, limit: task.limit, state: task.state, startedAt: task.startedAt, timeBasis: task.timeBasis ?? 'first-step', deadlineAt: task.deadlineAt ?? null,
    usedTokens: task.usedTokens, usageAvailable: task.usageAvailable, reason: task.reason ?? null } : null;
  function releaseFinished(id, task) {
    if (hasWork(task)) return;
    cancelTimer(task);
    const row = rows()[id];
    if (row?.background?.includes(task)) { row.background = row.background.filter(value => value !== task); retainSave(); }
  }
  function stop(id, task, code) {
    if (!tracked(id, task) || task.state === 'stopped') return;
    task.state = 'stopped'; task.reason = { code, message: reasons[code], at: now() }; delete task.pendingUsage;
    if (!current(id, task)) rows()[id].previousStop = taskView(task);
    cancelTimer(task); retainSave();
    // Only agents still executing a step belonging to this exact request.
    for (const agent of ctx.agents.list()) {
      const binding = bindings.get(agent);
      if (binding?.task === task && turns.get(agent.session) === binding.turn) agent.cancel({ kind: 'user' }, { keepInbox: true });
    }
    // Registered IDs remain bound to their original intent, even if another
    // human request is now running. A handed-off preview stays accessible.
    for (const [jobId, job] of jobs) if (job.task === task && !(job.deliveredPreview && !current(id, task))) {
      // Managed project producers collect their own terminal result. Other SDK
      // producer kinds keep the SDK's notification policy; cancellation alone
      // is not a promise that an arbitrary late settlement will be quiet.
      ctx.emit('workspace/task-budget-stop', jobId, job.owner);
      try { ctx.jobs.kill(jobId, job.owner, code); } catch { /* Registry settlement may have won. */ }
    }
  }
  function schedule(id, task) {
    cancelTimer(task);
    if (disposed || task.state === 'stopped' || task.limit.kind !== 'elapsed') return;
    const timer = setTimer(() => stop(id, task, 'TASK_TIME_LIMIT'), Math.max(0, task.deadlineAt - now()));
    timer?.unref?.(); timers.set(task, timer);
  }
  function view(id) {
    const row = rows()[id], task = row?.current;
    return { version: 1, sessionId: id, nextTaskLimit: row?.next?.limit ?? null,
      current: taskView(task), previousStop: row?.previousStop ?? null };
  }
  async function agentFor(id) {
    await manager.projectFor(id);
    let agent = ctx.agents.get(id);
    if (!agent && ctx.sessionController) { const result = await ctx.sessionController.resolveAgent(id); if (result.error) throw result.error; agent = result.agent; }
    if (!agent || ownerOf(agent) !== agent) throw new WorkbenchError('SESSION_NOT_EDITABLE', 'Choose an ordinary conversation.', 409);
    return agent;
  }
  async function configure(id, value) {
    const limit = taskLimit(value), agent = await agentFor(id);
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new WorkbenchError('TASK_ALREADY_RUNNING', 'Set the next task limit before sending its request.', 409);
    return agent.runMaintenance(() => manager.inOrder(async () => {
      const row = rows()[id] ??= {}, previous = row.next;
      row.next = limit ? { limit, afterSeq: agent.session.seq, at: now() } : null;
      try { await persist(); } catch (error) { row.next = previous; throw error; }
      return view(id);
    }));
  }
  async function beforeStep(input) {
    const owner = ownerOf(input.agent), id = owner?.id, row = rows()[id];
    if (!row) return;
    const message = input.messages?.findLast(human);
    if (input.agent === owner && message && row.current?.messageId !== message.id) {
      const previous = row.current;
      if (previous) {
        if (previous.state === 'stopped') row.previousStop = taskView(previous);
        if (hasWork(previous)) (row.background ??= []).push(previous);
        else cancelTimer(previous);
      }
      row.current = null;
      if (row.next) {
        // The saved sequence survives reload. Internal notices and preexisting
        // human context cannot consume an armed allowance for another input.
        await ctx.sessions.flush(owner.session);
        const saved = await ctx.sessionQuery.readSession(id);
        const first = saved.events.filter(event => event.seq >= row.next.afterSeq)
          .flatMap(event => (event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : event.type === 'user/message' ? [event.data] : []).map(message => ({ message, time: event.time }))).find(receipt => human(receipt.message));
        if (first?.message.id === message.id) {
          const accepted = Number.isSafeInteger(first.time) && first.time >= 0;
          const startedAt = accepted ? first.time : now(), limit = row.next.limit;
          row.current = { messageId: message.id, turn: input.turn, limit, state: 'active', startedAt, timeBasis: accepted ? 'accepted' : 'first-step',
            ...(limit.kind === 'elapsed' ? { deadlineAt: startedAt + limit.minutes * 60000 } : {}), usedTokens: 0, usageAvailable: true };
          row.next = null;
        } else if (first) row.next = null; // A removed/cancelled first input cannot transfer its limit.
      }
      await persist();
    }
    const task = row.current; if (!task) { bindings.delete(input.agent); return; }
    bindings.set(input.agent, { task, turn: input.turn });
    if (task.pendingUsage && !liveUsage.has(task)) stop(id, task, 'TASK_BUDGET_USAGE_INTERRUPTED');
    if (task.limit.kind === 'elapsed' && now() >= task.deadlineAt) stop(id, task, 'TASK_TIME_LIMIT');
    if (task.state === 'stopped') throw new WorkbenchError(task.reason.code, task.reason.message);
    task.state = 'active'; schedule(id, task);
  }
  ctx.tools.guard(exec => {
    const task = bindings.get(exec.agent)?.task;
    if (task?.state === 'stopped') return { reason: task.reason.message, info: { code: task.reason.code } };
  });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') turns.set(session, event.data.turn);
    if (event.type !== 'turn/end') return;
    const agent = ctx.agents.get(session.id), binding = agent && bindings.get(agent), owner = agent && ownerOf(agent);
    if (turns.get(session) === event.data.turn) turns.delete(session);
    if (!binding || binding.turn !== event.data.turn || !owner || !tracked(owner.id, binding.task)) return;
    const task = binding.task;
    if (agent === owner && task.state !== 'stopped') { task.state = 'idle'; retainSave(); }
    releaseFinished(owner.id, task);
  }, { global: true });
  ctx.jobs.events.subscribe({ owners: 'scope' }, event => {
    if (event.type === 'registered') {
      const agent = ctx.agents.get(event.job.owner), binding = agent && bindings.get(agent);
      if (binding && turns.get(agent.session) === binding.turn && binding.task.state !== 'stopped') jobs.set(event.job.id, { task: binding.task, owner: agent.id, root: ownerOf(agent).id });
    } else if (event.type === 'settled' || event.type === 'removed') {
      const job = jobs.get(event.job.id); jobs.delete(event.job.id);
      if (job) releaseFinished(job.root, job.task);
    }
  });
  ctx.on('workspace/project-preview-delivered', (jobId, owner) => {
    const job = jobs.get(jobId);
    if (job?.owner === owner) job.deliveredPreview = true;
  }, { global: true });
  ctx.on('llm/stream', function(options, next) {
    const agent = options.sessionId && ctx.agents.get(String(options.sessionId)), owner = agent && ownerOf(agent), binding = agent && bindings.get(agent), task = binding?.task;
    if (!task || !owner || !tracked(owner.id, task) || task.limit.kind !== 'tokens' || turns.get(agent.session) !== binding.turn) return next();
    return (async function*() {
      if (task.state === 'stopped') throw new WorkbenchError(task.reason.code, task.reason.message);
      task.pendingUsage = (task.pendingUsage ?? 0) + 1; liveUsage.set(task, (liveUsage.get(task) ?? 0) + 1); let usage, dispatched = false;
      try { await persist(); dispatched = true; for await (const chunk of await next()) { if (chunk.type === 'usage') usage = chunk.usage; yield chunk; } }
      finally {
        const pending = (liveUsage.get(task) ?? 1) - 1;
        if (pending) { liveUsage.set(task, pending); task.pendingUsage = pending; }
        else { liveUsage.delete(task); delete task.pendingUsage; }
        if (tracked(owner.id, task)) {
          if (Number.isSafeInteger(usage?.totalTokens) && usage.totalTokens >= 0) {
            task.usedTokens += usage.totalTokens;
            if (task.usedTokens >= task.limit.totalTokens) stop(owner.id, task, 'TASK_TOKEN_LIMIT');
          } else if (dispatched && !options.signal?.aborted) { task.usageAvailable = false; stop(owner.id, task, 'TASK_BUDGET_USAGE_UNAVAILABLE'); }
          await persist();
        }
      }
    })();
  }, { global: true });
  function dispose() { disposed = true; for (const task of timers.keys()) cancelTimer(task); jobs.clear(); }
  ctx.effect(() => dispose, 'optional task budget timers');
  return { configure, beforeStep, async inspect(id) { await manager.projectFor(id); return view(id); }, dispose };
}
