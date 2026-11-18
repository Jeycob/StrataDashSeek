# Explicit owned overlay copy-up and residual grow budget

This is source preparation, not an actual grow/overlay qualification. Ordinary
`growOffline`/`runGrowth` and `assessCapacity` retain the full conservative
copy-up charge. No startup, Apps tool, CLI selector or service enables this path.

Root's explicit entry is:

```js
await require('./development/guest-disk-owned-copyup.cjs').growOfflineOwned({
  planFile: '/data/harness/root-secrets/runtime/state/NEW-PLAN.json',
  expectedPlanSha256: 'ACTUAL_RAW_PLAN_FILE_SHA256',
});
```

The file must contain exactly `{version:1,kind:'owned-overlay-copyup-grow-v1',
growth,cold,operationTimeoutMs}`. `growth` is the unchanged complete
`raw-ext4-grow-v1` plan, including full `copyUpBytes >= source.bytes`. `cold`
contains exactly `sourceCommit,epoch,manifestSha256,coldJournalFile,
coldJournalSha256,fsckQualifierSha256,toolTimeoutMs,raw`. `raw` has the original
D nine decimal-string metadata fields. Source/epoch/raw/manifest must join the
growth plan. No example receipt or actual runtime identity is supplied here.
The original raw JSON bytes are hashed; use the hash of the exact protected
file, rather than a different JSON serialization. Operation timeout is explicit,
1–600 seconds, and starts before parent plan/source qualification. It cannot
renew. Ordinary VM reconciliation retains its original fixed120 seconds.

The parent verifies the actual installed signed serving release and launches
one owned Node worker. FDs0..9 are explicitly replaced; FD3 is private IPC,
not an inherited Root lease/raw descriptor. Worker independently acquires the
fresh supervisor and Apps locks through the shared `createColdWorkerFile`
factory in `apps-vm-reconcile-linux.cjs`. It preserves the existing D cold issuer,
PID/mount/user namespace, complete proc visibility, all UID columns, task/FD
identity, global final census, loop identity, raw and source checks. Do not invoke
it beneath a caller's already-held new FD9 lease: the worker must independently
acquire the lock, and a competing held lease makes it HOLD. A previous
completion receipt is never accepted as current cold authority. The new release
must first have run in HOST mode and be stopped by its actual issuer; an older
source's stop journal is not relabelled. This API does not reconcile or authorize
VM controller state: legacy/pending controller records still require the separate
supported reconciliation before a future VM start.

Before write-open, `Available` must cover full C + host reserve + bounded work.
After the existing actual forced warning-free readonly fsck, a durable running
gate and `copyup_intent` precede any RW open. The worker hashes the complete
original RO data, opens the exact name RW without truncate/create/follow,
compares every byte via full SHA through that RW descriptor, fsyncs and checks
the original immutable identity. It closes the old RO only when the checked RW
becomes the factory's current descriptor. Later allocation/resize never reopens
RW. Fresh RO descriptors are only verification and are closed before the shared
cold FD census, so they cannot be mistaken for foreign raw users.

Write-open completion proves overlay data copy-up on the qualified Linux
semantics, not private extents. Therefore this entry additionally performs
`fallocate(fd3, FALLOC_FL_UNSHARE_RANGE, 0, sourceBytes)` through a signed small
Python stdlib/ctypes helper (`-I -S -B`, no bytecode writes). No util-linux `--unshare` flag is assumed. The
installed canonical `/usr/bin/python3`, helper and tools are Root-owned,
hash/metadata checked around actual owned child close. Missing Python, syscall,
unsupported filesystem/flag, timeout or unknown output HOLDS without fallback.
Root must qualify the actual installed64-bit Python/ctypes/libc closure and tiny
syscall/overlay behavior before any real raw invocation; this source has not run
them. No packages/compiler/download is introduced. The helper accepts only the
inherited regular FD3 and original exact size, never a path or arbitrary flag.

After actual unshare, full RW and fresh named-RO SHA must still equal the original;
fsync and current cold/namespace/source checks run again. Only allocation and
mtime/ctime may transition through the owned syscall; original dev/ino, owner,
mode, single link and size stay fixed. Timestamps are recorded, never reset.
Reconciliation's ordinary metadata equality remains strict. Overlay identity
changes, volatile mounts, ambiguous mount views or changed visible mount/kernel
identity HOLD. `st_blocks` is checked for backing sufficiency, never treated as
upper-layer provenance.

Only a factory-private live operations identity selects the residual calculation.
JSON booleans, audit records and caller-built operations cannot mint it. After
materialization the required fresh Available is delta + still-needed T + reserve
+ remaining work, retaining guest-byte/inode and final metadata-growth checks.
Do not charge T again if already installed in that actual sample. If C/unshare
really spends the3GiB and the remainder does not fit, stop before allocation,
length, resize or manifest publication. Original-size logical data is preserved;
the incomplete journal/running recovery gate remains truthful and blocked.
There is no reset, rollback, partial replay or automatically reusable credit.

The original allocate/extend/resize/seal/final forced fsck and exact capacity
consumer approval sequence continues on the same RW FD. Both witnesses and the
small copy-up audit must fit the existing16KiB journal cap. No new consumer
approval field, key, bootstrap12 or protocol migration exists. The parent waits
for actual worker `close`, then observes its group absent within the original
deadline. It never signals a reaped/exited leader. Unobservable/residual group
or any late/ambiguous result is HOLD, not settlement. Linux uninterruptible I/O
can delay actual close despite SIGKILL; the API does not claim a kill ACK is a
wall-clock settlement guarantee. Failed/unfinished durable records require a
separate reviewed Root recovery, not rerunning this call.

The controlled tests exercise actual core/adapter function bodies with memory
FD tables, owned ChildProcess emitters and virtual3GiB hash ranges. They prove
ordering/identity/budget refusal; they do not prove physical copy-up, physical
fsync, actual Python/kernel compatibility or Vast fit. Actual SHA short-read
logic is separately exercised over in-memory bytes.

`guest-disk-owned-overlay-check.cjs` is a default-disabled manual SOURCE fixture,
explicitly outside required CI. Root may later review/bind a copy and invoke it
under a fresh private mount namespace (for example `unshare --mount
--propagation private` plus an outer owned timeout), with a fresh empty canonical
Root0700 `/var/lib/homeai-copyup-fixture-<12ALNUM>`. It creates only a new run child,
two16MiB synthetic samples and one owned overlay, retains evidence/files and
unmounts only its own mount. It tests lower-only versus already-upper data,
actual unshare and same-RW append only when visible identity stays stable; a
lower case with changed identity records that production must HOLD. This is a
primitive fixture, not a substitute for the actual cold factory, ext4 data
preservation or current capacity witness. No actual raw/user project is accepted.

Primary source basis:

- [Linux v6.12 overlay file operations](https://github.com/torvalds/linux/blob/v6.12/fs/overlayfs/file.c): write-open completes copy-up before returning; same RW is retained.
- [Overlay documentation](https://www.kernel.org/doc/html/v6.12/filesystems/overlayfs.html): metadata-only copy-up, possible identity change and volatile sync limitations.
- [Copy-up implementation](https://github.com/torvalds/linux/blob/v6.12/fs/overlayfs/copy_up.c): cloning/sparse data distinguish upper data from private extents.
- [Linux UAPI](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/falloc.h) and [fallocate(2)](https://man7.org/linux/man-pages/man2/fallocate.2.html): UNSHARE_RANGE0x40, no data overwrite and supported-filesystem requirement.
- [XFS implementation](https://github.com/torvalds/linux/blob/v6.12/fs/xfs/xfs_file.c): `file_modified` precedes unshare, hence the explicit observed mtime/ctime transition.
