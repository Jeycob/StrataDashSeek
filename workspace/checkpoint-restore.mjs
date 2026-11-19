import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { canonicalInside, sourceManifest, saveCheckpoint, manifestDigest, hash, atomicJSON, syncDirectory, syncTreeDirectories, excludedSourcePath } from './storage.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import privateSource from './source-private.cjs';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const missing = e => e.code === 'ENOENT';
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
function relativeName(name) {
  if (typeof name !== 'string' || !name || name.length > 4096 || /[\\:\x00-\x1f]/u.test(name) || path.posix.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..')) fail('CHECKPOINT_INVALID', 'Invalid checkpoint path.');
  return name;
}
async function regularBytes(file, expected) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || stat.size !== expected.bytes) fail('CHECKPOINT_INVALID', 'Checkpoint size or file type does not match.');
    const buffer = Buffer.alloc(expected.bytes + 1); let size = 0;
    while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
    const bytes = buffer.subarray(0, size);
    if (size !== expected.bytes || hash(bytes) !== expected.sha256) fail('CHECKPOINT_INVALID', 'Checkpoint checksum does not match.');
    return bytes;
  } finally { await handle.close(); }
}
async function inspectCheckpoint(checkpoint, expectedHash, signal) {
  for (let cursor = path.resolve(checkpoint); cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) if ((await fs.lstat(cursor)).isSymbolicLink()) fail('CHECKPOINT_INVALID', 'Checkpoint ancestors must not contain links.');
  const stat = await fs.lstat(checkpoint);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CHECKPOINT_INVALID', 'Unsafe checkpoint directory.');
  const metadata = await canonicalInside(checkpoint, 'checkpoint-manifest.json');
  if ((await fs.stat(metadata)).size > 8 * 1024 ** 2) fail('CHECKPOINT_INVALID', 'Checkpoint metadata exceeds limit.');
  const manifest = JSON.parse(await fs.readFile(metadata, 'utf8'));
  if (!plain(manifest.files) || Object.keys(manifest.files).length > 5000 || manifest.version !== undefined && ![1, 2].includes(manifest.version)) fail('CHECKPOINT_INVALID', 'Unsupported checkpoint format.');
  if (manifest.version === 2 && (!plain(manifest.inventory) || typeof manifest.inventoryComplete !== 'boolean' || Object.keys(manifest.inventory).length > 50000)) fail('CHECKPOINT_INVALID', 'Invalid checkpoint inventory.');
  if (manifest.version === 2) for (const [name, entry] of Object.entries(manifest.inventory)) {
    relativeName(name);
    if (!plain(entry) || !['file', 'directory', 'other'].includes(entry.kind) || !['backed-up', 'directory', 'excluded'].includes(entry.state) || entry.state === 'excluded' && typeof entry.reason !== 'string') fail('CHECKPOINT_INVALID', 'Invalid inventory entry.');
  }
  if (expectedHash && manifestDigest(manifest) !== expectedHash) fail('CHECKPOINT_INVALID', 'Checkpoint manifest identity does not match.');
  const payloads = new Map(), names = new Set(); let bytes = 0, skippedPrivateFiles = 0;
  for (const [name, expected] of Object.entries(manifest.files)) {
    signal?.throwIfAborted(); relativeName(name);
    if (privateSource.isPrivateSourcePath(name)) { skippedPrivateFiles++; continue; }
    if (excludedSourcePath(name)) fail('CHECKPOINT_INVALID', 'Checkpoint includes a protected runtime path.');
    if (!plain(expected) || !/^[a-f0-9]{64}$/u.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > 1024 * 1024) fail('CHECKPOINT_INVALID', 'Invalid checkpoint content descriptor.');
    const folded = process.platform === 'win32' ? name.toLowerCase() : name;
    if (names.has(folded)) fail('CHECKPOINT_INVALID', 'Aliased checkpoint paths.'); names.add(folded);
    if (manifest.version === 2 && manifest.inventory[name]?.state !== 'backed-up') fail('CHECKPOINT_INVALID', 'Content does not match inventory.');
    if ((bytes += expected.bytes) > 32 * 1024 ** 2) fail('CHECKPOINT_INVALID', 'Checkpoint content exceeds limit.');
    payloads.set(name, await regularBytes(await canonicalInside(checkpoint, 'files/' + name), expected));
  }
  for (const name of payloads.keys()) for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) if (payloads.has(parent)) fail('CHECKPOINT_INVALID', 'Overlapping file paths.');
  return { manifest, payloads, bytes, skippedPrivateFiles };
}
const protectedByInventory = (inventory, name) => name.split('/').some((_, i, parts) => inventory[parts.slice(0, i + 1).join('/')]?.state === 'excluded');
function taskSelection(before, after, current) {
  if ([before, after].some(manifest => manifest.version !== 2 || manifest.inventoryComplete !== true)) fail('TASK_UNDO_INCOMPLETE', 'This task has no complete source inventory.');
  const state = (manifest, name) => manifest.files[name]?.sha256 ?? (!manifest.inventory[name] && !protectedByInventory(manifest.inventory, name) && manifest.inventoryComplete ? null : undefined);
  const selected = new Set(), changes = [], conflicts = [], alreadyReverted = [], unsupported = [];
  for (const name of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const old = state(before, name), next = state(after, name);
    if (old === next) continue;
    if (old === undefined || next === undefined) { unsupported.push(name); continue; }
    changes.push({ path: name, kind: old === null ? 'added' : next === null ? 'deleted' : 'modified' });
    const actual = state(current, name);
    if (actual === old) alreadyReverted.push(name);
    else if (actual !== next) conflicts.push(name);
    else selected.add(name);
  }
  return { selected, changes, conflicts, alreadyReverted, unsupported };
}
async function makePlan(root, checkpoint, { expectedHash, expectedSourceHash, signal, taskAfter, skipConflicts = false } = {}) {
  const checked = await inspectCheckpoint(checkpoint, expectedHash, signal), current = await sourceManifest(root, { signal });
  if (expectedSourceHash && expectedSourceHash !== current.sha256) fail('RESTORE_SOURCE_CHANGED', 'Source changed since the restore preview.');
  const task = taskAfter ? taskSelection(checked.manifest, (await inspectCheckpoint(taskAfter.path, taskAfter.sha256, signal)).manifest, current) : null;
  const operations = [], protectedFiles = []; let previousBytes = 0;
  for (const [name, bytes] of checked.payloads) {
    if (task && !task.selected.has(name)) continue;
    await canonicalInside(root, name, true);
    const prior = current.files[name], entry = current.inventory[name];
    if (entry && entry.state !== 'backed-up') { protectedFiles.push({ path: name, reason: entry.reason ?? 'not-a-backed-up-file' }); continue; }
    if (prior?.sha256 === hash(bytes)) continue;
    previousBytes += prior?.bytes ?? 0;
    operations.push({ path: name, kind: 'write', before: prior ?? null, after: { sha256: hash(bytes), bytes: bytes.length } });
  }
  const deletesKnown = checked.manifest.version === 2 && checked.manifest.inventoryComplete === true;
  if (deletesKnown) for (const [name, prior] of Object.entries(current.files)) {
    if (task && !task.selected.has(name)) continue;
    if (!Object.hasOwn(checked.manifest.inventory, name) && !protectedByInventory(checked.manifest.inventory, name)) { operations.push({ path: name, kind: 'delete', before: prior, after: null }); previousBytes += prior.bytes; }
  }
  const payloads = task ? new Map([...checked.payloads].filter(([name]) => operations.some(op => op.kind === 'write' && op.path === name))) : checked.payloads;
  return { ...checked, payloads, current, operations, previousBytes, deletesKnown, protectedFiles, task, skipConflicts };
}
const preview = plan => ({ version: 2, canRestore: plan.protectedFiles.length === 0 && (!plan.task?.conflicts.length || plan.skipConflicts), protectedFiles: plan.protectedFiles, legacyOverlayOnly: !plan.deletesKnown, inventoryComplete: plan.manifest.inventoryComplete === true,
  sourceHash: plan.current.sha256, writes: plan.operations.filter(o => o.kind === 'write').map(o => o.path), deletes: plan.operations.filter(o => o.kind === 'delete').map(o => o.path),
  savedPaths: [...plan.payloads.keys()], preservedPaths: Object.keys(plan.current.inventory).filter(name => !plan.operations.some(op => op.path === name)),
  newlyDeletedPaths: plan.operations.filter(o => o.kind === 'delete').map(o => o.path),
  preservedExclusions: Object.entries(plan.manifest.inventory ?? {}).filter(([, e]) => e.state === 'excluded').map(([p, e]) => ({ path: p, reason: e.reason })), skippedPrivateFiles: plan.skippedPrivateFiles,
  requiredStagingBytes: plan.bytes + plan.current.bytes + 8 * 1024 ** 2, beforeRestoreAvailable: true,
  ...(plan.task ? { taskUndo: { changes: plan.task.changes, conflicts: plan.task.conflicts, alreadyReverted: plan.task.alreadyReverted, unsupported: plan.task.unsupported } } : {}) });
export async function previewCheckpointRestore(root, checkpoint, options = {}) { return preview(await makePlan(await fs.realpath(root), checkpoint, options)); }

async function journalAt(stateRoot) {
  const file = path.join(stateRoot, 'transaction.json');
  try { if ((await fs.lstat(file)).isSymbolicLink() || (await fs.stat(file)).size > 8 * 1024 ** 2) fail('RESTORE_RECOVERY_REQUIRED', 'Unsafe restore journal.'); return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (missing(e)) return null; throw e; }
}
const validEnvelope = journal => journal?.version === 1 && typeof journal.id === 'string' && /^[a-f0-9-]{36}$/u.test(journal.id)
  && ['prepared', 'committing', 'rolling-back', 'recovery-required', 'committed', 'rolled-back'].includes(journal.status)
  && plain(journal.beforeRestore) && typeof journal.beforeRestore.path === 'string' && /^[a-f0-9]{64}$/u.test(journal.beforeRestore.sha256);
async function markRecoveryFailure(stateRoot, failure) {
  try { const journal = await journalAt(stateRoot); if (journal) await atomicJSON(path.join(stateRoot, 'transaction.json'), { ...journal, status: 'recovery-required', error: failure.code ?? 'RECOVERY_FAILED' }, { durable: true }); } catch { /* Keep the original recovery failure authoritative. */ }
}
async function cleanAbandonedStaging(stateRoot, keep) {
  let removed = 0;
  for (const entry of await fs.readdir(stateRoot, { withFileTypes: true })) {
    if (removed >= 16) break;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9-]{36}$/u.test(entry.name)) continue;
    const candidate = path.join(stateRoot, entry.name); if (candidate === keep) continue;
    await fs.rm(candidate, { recursive: true }); removed++;
  }
}
export async function checkpointRecoveryStatus(stateRoot) {
  const journal = await journalAt(stateRoot);
  if (journal && !validEnvelope(journal)) return { status: 'recovery-required', pending: true, beforeRestore: null, conflicts: [], error: 'INVALID_RESTORE_JOURNAL' };
  return journal ? { transactionId: journal.id, status: journal.status, pending: !['committed', 'rolled-back'].includes(journal.status), beforeRestore: journal.beforeRestore, conflicts: journal.conflicts ?? [], error: journal.error ?? null } : { status: 'none', pending: false, beforeRestore: null };
}
async function writePayload(file, bytes, nonce, onSynced) {
  await fs.mkdir(path.dirname(file), { recursive: true }); const temp = file + '.restore-' + nonce;
  let handle;
  try { handle = await fs.open(temp, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await onSynced?.(); await handle.close(); handle = null; await fs.rename(temp, file); await syncDirectory(path.dirname(file)); }
  finally { await handle?.close(); await fs.unlink(temp).catch(e => { if (!missing(e)) throw e; }); }
}
async function currentHash(root, name) {
  const file = await canonicalInside(root, name, true);
  try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) return 'protected'; return hash(await fs.readFile(file)); }
  catch (e) { if (missing(e)) return null; throw e; }
}
async function validateJournal(root, stateRoot, checkpointRoot, journal) {
  if (!validEnvelope(journal) || journal.root !== root || !Array.isArray(journal.operations) || journal.operations.length > 5000 || journal.directory !== path.join(stateRoot, journal.id)) fail('RESTORE_RECOVERY_REQUIRED', 'Invalid restore recovery journal.');
  if (journal.checkpointRoot !== checkpointRoot || path.dirname(journal.beforeRestore.path) !== checkpointRoot || !/^before-restore\.[a-f0-9-]{36}$/u.test(path.basename(journal.beforeRestore.path))) fail('RESTORE_RECOVERY_REQUIRED', 'Recovery checkpoint is outside its retained store.');
  const staging = await fs.lstat(journal.directory); if (!staging.isDirectory() || staging.isSymbolicLink()) fail('RESTORE_RECOVERY_REQUIRED', 'Unsafe restore staging directory.');
  const seen = new Set();
  if (!Array.isArray(journal.createdDirectories) || journal.createdDirectories.length > 50000) fail('RESTORE_RECOVERY_REQUIRED', 'Invalid recovery directory inventory.');
  for (const name of journal.createdDirectories) { relativeName(name); if (excludedSourcePath(name)) fail('RESTORE_RECOVERY_REQUIRED', 'Unsafe recovery directory.'); }
  for (const op of journal.operations) {
    relativeName(op.path); if (seen.has(op.path) || excludedSourcePath(op.path) || !['write', 'delete'].includes(op.kind)) fail('RESTORE_RECOVERY_REQUIRED', 'Unsafe recovery operation.'); seen.add(op.path);
    for (const descriptor of [op.before, op.after].filter(Boolean)) if (!/^[a-f0-9]{64}$/u.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || descriptor.bytes > 1024 * 1024) fail('RESTORE_RECOVERY_REQUIRED', 'Invalid recovery content descriptor.');
    if (op.kind === 'delete' && (!op.before || op.after) || op.kind === 'write' && !op.after) fail('RESTORE_RECOVERY_REQUIRED', 'Invalid recovery operation.');
  }
  // Verify EVERY rollback payload before changing even the first project file.
  await inspectCheckpoint(journal.beforeRestore.path, journal.beforeRestore.sha256);
  for (const op of journal.operations) if (op.before) await regularBytes(await canonicalInside(journal.beforeRestore.path, 'files/' + op.path), op.before);
}
async function rollback(root, stateRoot, checkpointRoot, onPhase) {
  const journal = await journalAt(stateRoot);
  if (journal && !validEnvelope(journal)) fail('RESTORE_RECOVERY_REQUIRED', 'Invalid restore journal requires review.');
  if (!journal || ['committed', 'rolled-back'].includes(journal.status)) return checkpointRecoveryStatus(stateRoot);
  await validateJournal(root, stateRoot, checkpointRoot, journal);
  const conflicts = [];
  for (const op of journal.operations) {
    const actual = await currentHash(root, op.path);
    if (actual !== (op.before?.sha256 ?? null) && actual !== (op.after?.sha256 ?? null)) conflicts.push(op.path);
  }
  if (conflicts.length) { await atomicJSON(path.join(stateRoot, 'transaction.json'), { ...journal, status: 'recovery-required', conflicts }, { durable: true }); fail('RESTORE_RECOVERY_REQUIRED', 'Source changed outside the restore; recovery requires review.'); }
  await atomicJSON(path.join(stateRoot, 'transaction.json'), { ...journal, status: 'rolling-back' }, { durable: true });
  for (const op of [...journal.operations].reverse()) {
    const file = await canonicalInside(root, op.path, true);
    const temp = file + '.restore-' + journal.id;
    try { const stat = await fs.lstat(temp); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('RESTORE_RECOVERY_REQUIRED', 'Unsafe restore temporary file.'); await fs.unlink(temp); }
    catch (e) { if (!missing(e)) throw e; }
    const observed = await currentHash(root, op.path);
    if (observed === (op.before?.sha256 ?? null)) continue;
    if (observed !== (op.after?.sha256 ?? null)) {
      await atomicJSON(path.join(stateRoot, 'transaction.json'), { ...journal, status: 'recovery-required', conflicts: [op.path] }, { durable: true });
      fail('RESTORE_RECOVERY_REQUIRED', 'Source changed during rollback; retained recovery requires review.');
    }
    if (op.before) await writePayload(file, await regularBytes(await canonicalInside(journal.beforeRestore.path, 'files/' + op.path), op.before), journal.id, () => onPhase?.('rollback-temp-synced', op.path));
    else { await fs.unlink(file).catch(e => { if (!missing(e)) throw e; }); await syncDirectory(path.dirname(file)); }
    await onPhase?.('rollback-file', op.path);
  }
  for (const relative of [...(journal.createdDirectories ?? [])].reverse()) await fs.rmdir(await canonicalInside(root, relative, true)).catch(e => { if (!['ENOENT', 'ENOTEMPTY'].includes(e.code)) throw e; });
  await atomicJSON(path.join(stateRoot, 'transaction.json'), { ...journal, status: 'rolled-back' }, { durable: true });
  return checkpointRecoveryStatus(stateRoot);
}
export async function recoverCheckpointRestore(root, { stateRoot, checkpointRoot, onPhase } = {}) {
  root = await fs.realpath(root); stateRoot = path.resolve(stateRoot); checkpointRoot = path.resolve(checkpointRoot);
  const lock = await acquireProcessLock(path.join(stateRoot, 'restore.lock'), { timeoutMs: 0 });
  try { return await rollback(root, stateRoot, checkpointRoot, onPhase); }
  catch (error) { await markRecoveryFailure(stateRoot, error); throw error; }
  finally { await lock.release(); }
}
export async function restoreCheckpointTransaction(root, checkpoint, { stateRoot, checkpointRoot, expectedHash, expectedSourceHash, signal, onPrepared, onPhase, statfs = fs.statfs, minFreeBytes = 2 * 1024 ** 3, taskAfter, skipConflicts = false } = {}) {
  if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) fail('INVALID_RESTORE_LIMIT', 'Invalid restore reserve.');
  root = await fs.realpath(root); stateRoot = path.resolve(stateRoot); checkpointRoot = path.resolve(checkpointRoot);
  const lock = await acquireProcessLock(path.join(stateRoot, 'restore.lock'), { timeoutMs: 0, signal });
  let journal, stagedDirectory, backupPath;
  try {
    await rollback(root, stateRoot, checkpointRoot, onPhase);
    await cleanAbandonedStaging(stateRoot, (await journalAt(stateRoot))?.directory);
    const plan = await makePlan(root, checkpoint, { expectedHash, expectedSourceHash, signal, taskAfter, skipConflicts }); await onPhase?.('validated'); signal?.throwIfAborted();
    if (plan.task?.conflicts.length && !skipConflicts) fail('TASK_UNDO_CONFLICT', 'Later edits are preserved. Review conflicts before undoing only the safe changes.');
    if (plan.protectedFiles.length) fail('RESTORE_PROTECTED_SOURCE', 'Restore would overwrite source not included in its safety backup.');
    const space = await statfs(root), required = preview(plan).requiredStagingBytes;
    const available = Number(space.bavail) * Number(space.bsize);
    if (!Number.isFinite(available) || available < minFreeBytes + required) fail('CHECKPOINT_DISK_RESERVE', 'Insufficient disk for restore staging and safety reserve.');
    const id = crypto.randomUUID(), directory = path.join(stateRoot, id); stagedDirectory = directory; await fs.mkdir(directory, { mode: 0o700 });
    for (const [name, bytes] of plan.payloads) { signal?.throwIfAborted(); const target = path.join(directory, 'files', name); await fs.mkdir(path.dirname(target), { recursive: true }); const handle = await fs.open(target, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await onPhase?.('staged-file', name); }
    await syncTreeDirectories(directory); await syncDirectory(stateRoot);
    await onPhase?.('staged'); signal?.throwIfAborted();
    const before = await saveCheckpoint(root, path.join(checkpointRoot, 'before-restore'), plan.current, { signal, minFreeBytes });
    backupPath = before;
    await onPhase?.('backup-created'); signal?.throwIfAborted();
    const createdDirectories = [];
    for (const op of plan.operations) for (let parent = path.posix.dirname(op.path); parent !== '.'; parent = path.posix.dirname(parent)) if (!plan.current.inventory[parent] && !createdDirectories.includes(parent)) createdDirectories.unshift(parent);
    createdDirectories.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    journal = { version: 1, id, root, directory, checkpointRoot, status: 'prepared', operations: plan.operations, createdDirectories,
      beforeRestore: { path: before, sha256: plan.current.sha256, version: 2 } };
    await atomicJSON(path.join(stateRoot, 'transaction.json'), journal, { durable: true }); await onPrepared?.(journal.beforeRestore); await onPhase?.('prepared'); signal?.throwIfAborted();
    for (const op of journal.operations) if (await currentHash(root, op.path) !== (op.before?.sha256 ?? null)) fail('RESTORE_SOURCE_CHANGED', 'Source changed after restore preview.');
    journal.status = 'committing'; await atomicJSON(path.join(stateRoot, 'transaction.json'), journal, { durable: true }); await onPhase?.('committing');
    for (const op of journal.operations) {
      signal?.throwIfAborted(); const file = await canonicalInside(root, op.path, true);
      if (await currentHash(root, op.path) !== (op.before?.sha256 ?? null)) fail('RESTORE_SOURCE_CHANGED', 'Source changed during restore.');
      if (op.kind === 'write') await writePayload(file, await regularBytes(await canonicalInside(directory, 'files/' + op.path), op.after), id, () => onPhase?.('write-temp-synced', op.path));
      else { await fs.unlink(file); await syncDirectory(path.dirname(file)); }
      await onPhase?.('committed-file', op.path);
    }
    signal?.throwIfAborted(); await onPhase?.('before-complete'); signal?.throwIfAborted(); journal.status = 'committed'; await atomicJSON(path.join(stateRoot, 'transaction.json'), journal, { durable: true });
    return { restored: true, files: plan.payloads.size, deletedFiles: plan.operations.filter(o => o.kind === 'delete').length, skippedPrivateFiles: plan.skippedPrivateFiles, previousVersionRetained: true, beforeRestore: journal.beforeRestore, recovery: await checkpointRecoveryStatus(stateRoot), legacyOverlayOnly: !plan.deletesKnown,
      ...(plan.task ? { preservedConflicts: plan.task.conflicts, unsupported: plan.task.unsupported } : {}) };
  } catch (error) {
    if (journal) try { await rollback(root, stateRoot, checkpointRoot, onPhase); } catch (recoveryError) { await markRecoveryFailure(stateRoot, recoveryError); throw Object.assign(new Error('Restore did not complete; retained recovery requires review.'), { code: 'RESTORE_RECOVERY_REQUIRED', cause: error, recoveryError }); }
    else {
      if (stagedDirectory && path.dirname(stagedDirectory) === stateRoot) await fs.rm(stagedDirectory, { recursive: true, force: true });
      if (backupPath && path.dirname(backupPath) === checkpointRoot && /^before-restore\.[a-f0-9-]{36}$/u.test(path.basename(backupPath))) await fs.rm(backupPath, { recursive: true, force: true });
    }
    throw error;
  } finally { await lock.release(); }
}
