import { WorkbenchError } from './policy.mjs';

const operations = new Set(['checkpoint-preview', 'checkpoint-recovery', 'checkpoint-recover', 'checkpoint-restore']);

// Called only behind the existing authenticated, same-origin workbench route.
// Never accept a client-supplied root or checkpoint filename.
export async function checkpointOperation(manager, data, signal) {
  if (!operations.has(data.op)) return null;
  if (typeof data.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(data.sessionId)) throw new WorkbenchError('INVALID_SESSION', 'Invalid conversation.', 400);
  signal?.throwIfAborted();
  if (data.op === 'checkpoint-recovery') return { value: await manager.checkpointRecovery(data.sessionId) };
  if (data.op === 'checkpoint-recover') return { value: await manager.recoverCheckpoint(data.sessionId) };
  if (typeof data.key !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(data.key)) throw new WorkbenchError('CHECKPOINT_NOT_FOUND', 'Checkpoint not found.', 404);
  if (data.op === 'checkpoint-preview') return { value: await manager.previewCheckpointRestore(data.sessionId, data.key, signal) };
  if (typeof data.expectedSourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(data.expectedSourceHash)) throw new WorkbenchError('RESTORE_PREVIEW_REQUIRED', 'Preview the current source before applying a restore.', 409);
  return { value: await manager.restoreCheckpoint(data.sessionId, data.key, signal, { expectedSourceHash: data.expectedSourceHash }) };
}
