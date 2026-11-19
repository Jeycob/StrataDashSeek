import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sourceManifest, saveCheckpoint } from './storage.mjs';
import { previewCheckpointRestore, restoreCheckpointTransaction } from './checkpoint-restore.mjs';
import { WorkbenchError } from './policy.mjs';

const MAX_TASKS = 20;
const fail = (code, message, status = 409) => { throw new WorkbenchError(code, message, status); };
// The snapshots belong to real owner requests, never a client-provided path.
// Capture only at the existing writer-lease boundaries. A failed capture makes
// undo unavailable; it does not stop otherwise permitted application work.
export function createTaskUndo(manager) {
  const queues = new Map();
  const serial = (id, action) => {
    const next = (queues.get(id) ?? Promise.resolve()).then(action);
    queues.set(id, next.catch(() => {})); return next;
  };
  const store = record => record.taskUndo ??= { version: 1, tasks: [] };
  function busy(id, ownerMayRun = false) {
    const jobs = manager.ctx.jobs ?? manager.ctx.get?.('jobs');
    if (typeof jobs?.list !== 'function' || typeof manager.ctx.agents.list !== 'function') fail('TASK_UNDO_ACTIVITY_UNKNOWN', 'Project activity cannot be verified.');
    const owners = manager.ctx.agents.list().filter(agent => {
      try { return manager.ownerAgent(agent).id === id; }
      catch { return agent.session?.header?.cwd === manager.data.sessions[id]?.root; }
    });
    if (owners.some(agent => agent.status === 'running' && (!ownerMayRun || agent.id !== id))) return true;
    for (const owner of new Set([id, ...owners.map(agent => agent.id)])) {
      const rows = jobs.list(owner);
      if (!Array.isArray(rows)) fail('TASK_UNDO_ACTIVITY_UNKNOWN', 'Project activity cannot be verified.');
      if (rows.some(job => job.owner === owner && !['completed', 'failed', 'killed'].includes(job.status))) return true;
    }
    return false;
  }
  const publicTask = task => ({ id: task.id, turn: task.turn, status: task.status, startedAt: task.startedAt, ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}), ...(task.error ? { error: task.error } : {}) });
  const checkpoint = (id, value, phase) => {
    const base = manager.restoreLocations(id).checkpointRoot;
    if (!value || path.dirname(value.path ?? '') !== base || !new RegExp('^task-' + phase + '\\.[a-f0-9-]{36}$', 'u').test(path.basename(value.path)) || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? '')) fail('TASK_UNDO_UNAVAILABLE', 'The retained task snapshot is unavailable.');
    return value;
  };
  async function capture(id, record, phase, signal) {
    manager.execution.assertUnchanged();
    const manifest = await sourceManifest(record.root, { signal });
    if (!manifest.inventoryComplete) fail('TASK_UNDO_INCOMPLETE', 'The task source inventory exceeds the checkpoint limit.');
    const target = await saveCheckpoint(record.root, path.join(manager.restoreLocations(id).checkpointRoot, 'task-' + phase), manifest, { signal });
    try {
      if ((await sourceManifest(record.root, { signal })).sha256 !== manifest.sha256 || manager.data.sessions[id] !== record) fail('TASK_UNDO_SOURCE_CHANGED', 'Source changed while recording the task boundary.');
      manager.execution.assertUnchanged(); return { path: target, sha256: manifest.sha256 };
    } catch (error) { await retire(id, { path: target, sha256: manifest.sha256 }, phase); throw error; }
  }
  async function unavailable(task, error) {
    task.status = 'unavailable'; task.error = /^[A-Z0-9_]{1,80}$/u.test(error.code ?? '') ? error.code : 'TASK_UNDO_CAPTURE_FAILED';
    await manager.save().catch(() => {});
  }
  async function retire(id, value, phase) {
    if (!value) return;
    try {
      const saved = checkpoint(id, value, phase), stat = await fs.lstat(saved.path);
      if (stat.isDirectory() && !stat.isSymbolicLink() && await fs.realpath(saved.path) === saved.path) await fs.rm(saved.path, { recursive: true, force: true });
    } catch { manager.ctx.logger?.warn('Unreferenced task snapshot cleanup deferred.'); }
  }
  async function begin(input) {
    const owner = manager.ownerAgent(input.agent);
    if (owner.id !== input.agent.id) return;
    return serial(owner.id, async () => {
      const record = manager.data.sessions[owner.id];
      if (!record || record.legacy || !manager.running.has(owner.id)) return;
      const history = store(record), human = input.messages?.findLast(message => message?.role === 'user' && message.source?.kind === 'user');
      if (!human || typeof human.id !== 'string' || !human.id || !Number.isSafeInteger(input.turn) || input.turn < 1) {
        // Internal continuation may extend the same task only if no intervening
        // owner/editor change appeared after its last completed boundary.
        const last = history.tasks.at(-1);
        if (last?.status === 'ready') {
          try { if ((await sourceManifest(record.root, { signal: input.signal })).sha256 === last.after.sha256) { last.status = 'active'; await manager.save(); } }
          catch (error) { await unavailable(last, error); }
        }
        return;
      }
      const id = crypto.createHash('sha256').update(human.id).digest('hex').slice(0, 32);
      if (history.tasks.some(task => task.id === id)) return;
      const previous = history.tasks.at(-1);
      if (previous?.status === 'active') {
        try { if (busy(owner.id, true)) fail('TASK_UNDO_ACTIVE_WORK', 'A previous job or child is still modifying the project.'); previous.after = await capture(owner.id, record, 'after', input.signal); previous.status = 'ready'; previous.finishedAt = Date.now(); await manager.save(); }
        catch (error) { await unavailable(previous, error); }
      }
      const task = { id, turn: input.turn, status: 'active', startedAt: Date.now() }; history.tasks.push(task);
      try {
        if (busy(owner.id, true)) fail('TASK_UNDO_ACTIVE_WORK', 'A previous job or child is still modifying the project.');
        task.before = await capture(owner.id, record, 'before', input.signal);
        await manager.save();
      } catch (error) { await unavailable(task, error); }
      // Failed captures are bounded too. Delete only after durable unreferencing.
      while (history.tasks.length > MAX_TASKS) {
        const old = history.tasks.shift();
        await manager.save().then(async () => { for (const phase of ['before', 'after']) await retire(owner.id, old[phase], phase); }).catch(() => { manager.ctx.logger?.warn('Task snapshot retention deferred.'); });
      }
    });
  }
  async function finish(id) {
    return serial(id, async () => {
      const record = manager.data.sessions[id], task = record?.taskUndo?.tasks.at(-1);
      if (task?.status !== 'active' || !task.before || !manager.running.has(id)) return;
      try {
        if (busy(id)) return false;
        const after = await capture(id, record, 'after');
        if (busy(id)) { await retire(id, after, 'after'); return false; }
        const old = task.after;
        task.after = after; task.status = 'ready'; task.finishedAt = Date.now(); await manager.save();
        await retire(id, old, 'after');
      } catch (error) { await unavailable(task, error); }
    });
  }
  async function operate(data, signal) {
    const id = data.sessionId;
    if (manager.data.trash?.[id]) fail('SESSION_IN_TRASH', 'Restore the conversation before viewing task changes.', 403);
    if (data.op === 'task-undo-apply' && busy(id)) fail('SESSION_BUSY', 'Finish the current project work before undoing a task.');
    return manager.withFiles(id, async root => {
      if (data.op === 'task-undo-apply' && busy(id)) fail('SESSION_BUSY', 'Project work resumed before undo.');
      const record = manager.data.sessions[id];
      if (!record || record.root !== root) fail('PROJECT_CHANGED', 'Project identity changed.');
      if (data.op === 'task-undo-list') return { version: 1, tasks: (record.taskUndo?.tasks ?? []).map(publicTask).reverse() };
      const task = record.taskUndo?.tasks.find(value => value.id === data.taskId);
      if (!task || task.status !== 'ready') fail('TASK_UNDO_UNAVAILABLE', 'This task has no completed before/after snapshot.');
      const before = checkpoint(id, task.before, 'before'), after = checkpoint(id, task.after, 'after');
      const options = { expectedHash: before.sha256, taskAfter: after, signal };
      const recovery = await manager.checkpointRecovery(id);
      if (recovery.pending) fail('RESTORE_RECOVERY_REQUIRED', 'Recover the interrupted restore first.');
      if (data.op === 'task-undo-preview') return { ...await previewCheckpointRestore(root, before.path, options), task: publicTask(task) };
      if (!/^[a-f0-9]{64}$/u.test(data.expectedSourceHash ?? '')) fail('RESTORE_PREVIEW_REQUIRED', 'Preview task changes before undoing them.');
      if (data.skipConflicts !== undefined && typeof data.skipConflicts !== 'boolean') fail('TASK_UNDO_INVALID', 'Invalid conflict choice.', 400);
      return restoreCheckpointTransaction(root, before.path, { ...options, ...manager.restoreLocations(id), expectedSourceHash: data.expectedSourceHash, skipConflicts: data.skipConflicts === true,
        onPrepared: async info => { record.beforeRestore = info.path; record.beforeRestoreInfo = info; await manager.save(); } });
    }, data.op === 'task-undo-apply');
  }
  return { begin, finish, operate };
}

const operations = new Set(['task-undo-list', 'task-undo-preview', 'task-undo-apply']);
export async function taskUndoOperation(manager, data, signal) {
  if (!operations.has(data.op)) return null;
  if (typeof data.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(data.sessionId)) fail('INVALID_SESSION', 'Invalid conversation.', 400);
  if (data.op !== 'task-undo-list' && !/^[a-f0-9]{32}$/u.test(data.taskId ?? '')) fail('TASK_UNDO_INVALID', 'Invalid task identity.', 400);
  if (Object.keys(data).some(key => !['op', 'sessionId', 'taskId', 'expectedSourceHash', 'skipConflicts'].includes(key))) fail('TASK_UNDO_INVALID', 'Only task identity and preview choices are accepted.', 400);
  signal?.throwIfAborted(); return { value: await manager.taskUndo.operate(data, signal) };
}
