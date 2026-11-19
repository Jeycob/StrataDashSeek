# Checkpoint inventory and transactional recovery

## Undo one request

**Run review → Undo a task** lists the last 20 recorded owner requests. Select
**Review task changes** to see the files that request modified, added or deleted.
This operation restores only its before/after difference; it does not reset the
whole worktree. It also does not change conversation history or run budgets.

A file changed again by a later request or manual edit is a conflict and is never
overwritten. The preview names those files and initially disables apply. Select
**Keep later edits and undo only the nonconflicting files** to apply the safe
subset; the result explicitly reports the files left alone. Files already reverted
are skipped. Any source edit after preview invalidates its hash and requires a
fresh preview. A changed file is handled as a whole file: this version does not
automatically merge separate edits within the same file.

Snapshots start before the first admitted model step for a genuine owner request
and close under the same writer lease after owned work is idle, or at the next
owner request boundary. Running children/jobs prevent a completed boundary or
undo. Internal continuation can extend the request only when its previous end
snapshot still matches, so intervening owner edits are not silently attributed
to that task. Snapshot failure leaves normal model work permitted and displays
undo as unavailable. Old requests without a captured baseline are not guessed.
The existing private-file exclusions, 1 MiB/file and 32 MiB/snapshot limits apply;
unsupported files are kept and identified in preview. These are managed writer
boundaries, not an attribution guarantee for an external OS process bypassing
the project lease.

The authenticated same-origin workbench POST operations are `task-undo-list`,
`task-undo-preview` and `task-undo-apply`. They accept a session and an opaque
server-issued `taskId`, never a root or checkpoint path. Apply requires the
preview's `expectedSourceHash`; `skipConflicts:true` authorizes preserving the
conflicts and undoing the safe subset, never force-overwriting conflicts.
The existing durable restore journal, safety checkpoint, rollback and explicit
recovery path also cover task undo. Its UI is a separate same-origin module at
`/api/workbench/task-undo-client` shared by Native and the phone workbench.

Local acceptance uses `workspace/task-undo-sdk.test.mjs` with the pinned SDK's
real request/agent/tool loop and an inert adapter, plus
`workspace/native-ui/task-undo.test.cjs` in Chromium. No external model is used.

## Whole-checkpoint recovery

Version 2 records a source inventory separately from `files`, the bounded backed-up
content. Each inventoried path is a backed-up file, a directory, or an exclusion
with a reason. Private/runtime/dependency directories are exclusion boundaries:
their contents are neither opened nor recursively catalogued. Large files,
symlinks, hard links, logs and special entries are explicitly preserved. No
secret content or secret hash is added to a checkpoint. Limits remain 1 MiB per
content file, 5,000 content files and 32 MiB content; inventory metadata is bounded.

An omitted content file is not a deletion. Restore deletion is permitted only
for a currently backed-up source file that is positively absent from a complete
v2 inventory, outside all exclusion boundaries. Unversioned/v1 checkpoints are
readable as overlays; unknown current paths are preserved. A current large or
otherwise unbacked-up destination blocks its overwrite rather than losing data
that cannot fit the safety checkpoint. Preview reports that as `canRestore:false`.

Before mutation, restore verifies every allowed checkpoint path, byte count and
checksum, inventories the current source and checks capacity. It stages new
content and a separate durable `before-restore.UUID` checkpoint. A durable journal
under the server-owned per-session restore store records the complete plan before
the first project mutation. Files and journal updates are fsynced; Linux directory
entries are synced too. Space for staging, the safety checkpoint and metadata is
required in addition to the normal 2 GiB reserve. This is not an in-place unchecked
copy loop or an atomic whole-directory replacement.

Cancellation/I/O failure attempts rollback under the same project lease. A process
crash leaves an explicit pending transaction. Recovery validates all rollback
payloads before writing anything and restores the pre-restore working state,
not a silently completed restore. It is idempotent across further crashes.
Unexpected source hashes produce `recovery-required` with conflicts; they are
not overwritten. A rollback failure never becomes a successful restore response.
Only `committed` means the requested restore completed. `rolled-back` means the
attempt failed and its previous working state has been recovered.

`review()` and recovery status only read metadata. A new managed pre-step or file
mutation recovers a pending transaction under a writer lease before new work.
Explicit recover and restore reacquire authorization, live session/root identity,
write policy and lease. Preview is read-only and supplies `sourceHash`; the
authenticated workbench API requires `expectedSourceHash` to reject a missing
or stale preview. `key:'beforeRestore'`
addresses the retained safety checkpoint without accepting a client filesystem
path. UI routes must preserve owner authentication, same-Origin and session checks.

Backend methods: `previewCheckpointRestore(id,key,signal)`,
`checkpointRecovery(id)`, `recoverCheckpoint(id)`, and
`restoreCheckpoint(id,key,signal,{expectedSourceHash})`. Preview distinguishes saved,
excluded, preserved and newly deleted paths, legacy ambiguity and capacity.
Status exposes transaction state, pending/conflicts and the retained beforeRestore
reference. The frontend must not label pending/recovery-required/rolled-back as a
successful restore. The workbench route exposes all four operations through
its existing authenticated, bounded, same-origin POST handler. A restore
without a valid preview hash returns `RESTORE_PREVIEW_REQUIRED` (HTTP409).

Linux uses the installed `flock` utility on a descriptor inherited from Node;
the parent retains that same open-file description after the helper exits.
The kernel releases the lock when its last inherited descriptor closes.
Verification passes the descriptor to its owned checker too, so a surviving
checker retains exclusion after its controller crashes until that checker exits.
The persistent `.oslock` inode is never unlinked; regular inode, no-follow, ownership, write-mode
and hard-link checks precede its truncation. Separate complete owner metadata
uses PID plus process-start and boot identity. Unknown identity fails closed.

Legacy lock files are reserved for compatibility, but upgrading requires old
writers to be stopped. No protocol can make arbitrary old read/unlink writers
race-safe retroactively. An empty/malformed legacy lock cannot prove a dead owner:
it requires operator review, never an age-based deletion. A new empty `.oslock`
is safe because the kernel proves exclusion. A dead legacy owner with verified
PID/start/boot mismatch may be reclaimed only while holding the new OS guard.
Portable Windows tests cover live exclusion and failure paths; stale takeover
there is deliberately refused rather than advertised as Linux-equivalent.

Run the ordinary portable tests plus the explicit Linux gates with Linux Node:

```sh
node --test workspace/checkpoint-restore.test.mjs workspace/process-lock.test.mjs
node --test workspace/process-lock-linux-check.mjs workspace/checkpoint-restore-linux-check.mjs
```

The explicit gates use private `/tmp` fixtures and real process exits at staging,
journal, rename and rollback boundaries. They do not restore a production project,
start an LLM or exercise a remote server.
