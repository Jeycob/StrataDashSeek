# Explicit cold legacy VM reconciliation

This is a source-only recovery API for the existing pilot installation. It does
not enable Apps, launch a VM, repair/grow a filesystem, select execution mode,
adopt a PID, reset saved containers, or migrate bootstrap/protocol/key formats.
Only Root calls `reconcileOffline({planFile, expectedPlanSha256})` from
`development/apps-vm-reconcile-linux.cjs`. Importing either new module has no
effects; there is no CLI, HTTP route, startup hook, environment enable flag, or
default plan.

## Composition and real authority

The new signed release must first be the current release and must already
contain the consumer's `RECONCILIATION_CONTRACT` plus the reviewed
`development/guest-disk-fsck.cjs` dependency. Its normal HOST launch can remain
VM-quarantined. Then perform the separately reviewed whole-tree stop for that
same release. The API does not relabel an old release's stop journal or accept a
caller-written `issuerClosed:true` as authority. The existing actual whole-stop
journal must be pinned, phase `whole-tree-offline`, real issuer closure true,
source/epoch matched, with the original root/UI/actor births and lease inode.
The future Root stop helper must also capture `pidNamespace` from the actual
captured issuer's `/proc/PID/ns/pid` before stopping it. API execution must match
that namespace and `/proc/1/ns/pid`, plus the current mount/user namespaces of
PID1. Procfs must be a complete root mount without nonzero hidepid, subset-pid,
or partial PID/self overmounts; old journals without this observation remain
unsupported. This is an extra read-only cold-journal field, not a bootstrap or
admission-format change.

The API independently opens the supervisor lease file and Apps OS lock, acquires
both using newly opened file descriptions, and retains them through publication.
This is the same supervisor-lock inode used by FD9. An inherited old FD9 lock,
even if held by the caller, makes the new independent acquisition fail; it is
never reused as a cold qualification. Do not invoke the API while an external
operator shell already holds that lock. Helper stdio explicitly clears FD4..9;
only the required new lock or read-only raw descriptor is passed as FD3.

Direct checks require immutable disabled Apps configuration and execution policy, unchanged actual
closed admission for the captured epoch/source, absent old actor generations,
all four UID columns free of UID1001, no QEMU, and complete bounded PID/task/FD,
maps, mount and loop observations. Changed/disappeared/inaccessible/truncated
census data is HOLD. A stable empty process list is not fabricated from a PID
file. Every task FD table is inspected, including unshared tables. The only raw
FD exemption is the API's own retained descriptor in its own Node process;
process mappings are still checked by device/inode without a pathname exemption.
Directory enumeration excludes only its positively identified own enumerator FD
in the actual enumerated task table. Its appearance and disappearance across
closing the owned Dir prove that narrow shared-table witness; a foreign retained
directory or same-number raw FD is refused. Retained birth/task/FD-device-inode
signatures and relevant QEMU/raw-map/mount projections are rechecked over the
whole census after the last PID and loop observations. Ordinary scheduling or
unrelated JIT/heap maps need not be frozen byte for byte.

Configured loop associations are cross-checked against bounded read-only
`losetup --json --list --output NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN`, requiring
the exact sysfs configured-loop set and kernel backing device/inode. A path
stat of a replaced alias is not an absence proof. Unsupported tools, malformed
fields, unsafe integer identities or missing association evidence are HOLD.
Control tools and the fsck tool have protected canonical paths and stable
metadata/content. Actual Linux compatibility of this source remains a separate
Root qualification; controlled Windows tests do not establish it.

The raw is opened read-only/no-follow/no-atime and matches the entire supplied
nanosecond identity and current manifest SHA throughout. No raw byte is written.
Fsck is actual `e2fsck -f -n` under UID/GID1001 and no capabilities; the retained
original ChildProcess must close. B's reviewed `forced-ext4-readonly-v1`
qualifier must accept all five passes and the warning-free summary against the
actual held raw superblock. Exit zero or the clean bit alone is insufficient.
Before/after raw and tool checks are mandatory. The API has a first absolute
120s action deadline, fsck at most60s and bounded helpers. A helper that has not
actually closed cannot yield qualification or release the retained locks.

## Plan and effects

Root creates a protected direct child JSON file under
`/data/harness/root-secrets/runtime/state` and supplies its exact raw SHA. Required
fields are `version:1`, `kind:'apps-vm-cold-reconcile-v1'`, a fresh 32-hex
`reconciliationId`, current `sourceCommit`, actual closed `epoch`,
`coldJournalFile`/`coldJournalSha256`, `legacySha256`, `manifestSha256`, exact
current `fsckQualifierSha256`, `toolTimeoutMs` (1000..60000), and `raw` string
metadata `dev,ino,uid,gid,mode,nlink,size,mtimeNs,ctimeNs`. Raw owner/group are1001,
link count1, regular/non-writable by group or others, size at least3GiB. Actual
values, plan, UUID and approvals are not generated by this source. It refuses
any existing `qemu.pid`, including stale or linked metadata, rather than deleting
or interpreting it as ownership.

Only after qualification does it retain the exact original `vm.json` bytes in
root-private `apps-vm-legacy-ID.json`, with original metadata in the journal,
and durably create `apps-vm-reconcile-ID.json`. JSON is bounded, strict UTF-8,
duplicate keys rejected, initial BOM rejected. It replaces only the top-level
`workerProcess` value (or adds that property); all other original bytes,
including whitespace, future fields, Unicode and large numeric literals, remain
unchanged. Original `initialized`, container and resume information is preserved.

Before changing service state, it publishes a root-owned public gate
`runtime-status/apps-vm-reconciliation.json` with phase `pending`. It then writes
an exclusive owned temporary, sets UID/GID1001 mode0600, fsyncs, performs a final
synchronous complete cold/source/raw/manifest/original-state check immediately
before rename, atomically replaces `vm.json`, fsyncs the parent and verifies exact
readback. The only new state value is the existing
`workerProcess:{version:1,state:'absent'}`. After a final durable journal, complete
gate publication repeats the cold guard. No signed/replayable absence token or
new private key is introduced.

The gate is only a denial interlock. Missing gate preserves original behavior;
pending, malformed, unsafe or recovery-required gate yields UNKNOWN. Complete
gate cannot make legacy/starting state or a PID absent and cannot hide an actual
retained OWNED child. Normal own-ChildProcess start/exit/close handling remains
the source of ownership and normal future absence. Completion proves only this
cold publication, not perpetual absence. Recalling a completed ID observes
history only and never republishes old absence after a later start. An unfinished
journal, partial backup or any ambiguous write is not retried automatically;
retain the files and reconcile them read-only. Failure after publication keeps
the pending/recovery-required denial. No automatic rollback, cleanup or delete
exists.

This is a bounded observational check under the existing single Root operator
and trusted lock protocol, not a kernel-atomic exclusion of arbitrary Root code.
Root keeps other cold operators stopped. Actual current cold proof and Linux
tool/namespace visibility must succeed; caller assertions cannot replace them.
The old bootstrap12/HOST policy and normal recovery history are untouched.
