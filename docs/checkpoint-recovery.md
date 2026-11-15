# Checkpoint inventory and transactional recovery

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
