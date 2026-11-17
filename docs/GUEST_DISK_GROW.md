# Explicit offline guest raw/ext4 growth — source preparation

This is an operator-only source primitive. It does not enable Apps, start a
guest, change the default pilot, choose a target, or install a startup hook.
The original3GiB profile and all existing VM/bootstrap files are unchanged.
No existing runtime disk has been resized, copied, formatted, exported or
deleted by this work. T10 remains deferred; no backup workflow is introduced.

**Production remains blocked.** The installed signed runtime must first expose
the reviewed `CAPACITY_MIGRATION_CONTRACT = 'raw-ext4-grow-v1'` from
`vast/apps-worker-profile.cjs`, with all fresh start gates described below.
`growOffline` verifies the actual installed release's root attestation/digest
before accepting this handshake. An operator boolean or plan capability field
cannot replace it. This source commit deliberately does not install that glue.

## Interfaces and pinned plan

`development/guest-disk-grow.cjs` exports:

```js
validatePlan(value)
assessCapacity(plan, observation)
growOffline(rootOwnedPlanFile, {expectedPlanSha256})
// expectedPlanSha256 = SHA256 of the module's canonical(plan) JSON.
```

There is no default CLI action. The lower-level `runGrowth(plan, ops)` seam is
for deterministic synthetic tests; production uses the Linux operations factory.
All paths must be canonical absolute POSIX paths, without whitespace or links.
Plan files and private/public control ancestors are root-owned; raw and worker
directory remain owned by the declared service UID/GID. Existing lock files are
opened and flocked without truncating/replacing their owner records.

The exact version1 plan schema is validated by `validatePlan`, including:

| Field | Required explicit meaning |
|---|---|
| `kind`, `migrationId` | `raw-ext4-grow-v1`, new32hex identity |
| `installationRoot`, `workerRoot`, `appsStateDir` | Existing installation; exactly its `/docker-worker` and `/state/applications` |
| `serviceUid`, `serviceGid` | Existing unprivileged identity1000–65534; never a fixture identity guessed for production |
| `coldFence` | Exact closed admission `epoch` and40hex `sourceCommit` |
| `source.volumeId`, `manifestSha256` | Existing32hex volume identity and hash of exact current manifest bytes |
| `source.dev/ino/uid/gid/bytes/allocatedBytes` | Exact observed raw identity, logical length and `st_blocks*512`; sparse source is unsupported |
| `source.fs` | UUID32hex, blockSize4096, exact block/free-block and inode/free-inode counts |
| `targetBytes` | Explicit larger block-aligned size; no shrink/default/derived G |
| `capacity.reserveBytes` | At least2GiB host reserve, preserved before and after |
| `guestReserveBytes`, `guestReserveInodes` | At least512MiB and16384inodes |
| `guestNewBytes`, `guestNewInodes` | Explicit additional guest workload; unknown is rejected |
| `additionalHostBytes` | Explicit remaining toolchain/archive/staging/artifact allocation, excluding data already inside the enlarged raw; unknown T is rejected |
| `workBytes`, `metadataGrowthBytes` | Explicit bounded work and ext4 metadata-growth budgets; neither is inferred |
| `copyUpBytes` | Explicit budget. On overlay it must cover at least the entire old raw; the helper never assumes an existing upper-layer extent |
| `capacity.evidenceSha256` |64hex identity of the operator's concrete capacity evidence |
| `toolTimeoutMs` |1000–120000ms per owned tool, with bounded1MiB combined output |

Missing/null/noninteger inputs, unknown backing type or a source geometry change
refuse work. A numeric zero is an operator assertion of known zero need, not an
automatic replacement for unknown data. The capacity evidence and approval must
therefore be reviewed before invoking the helper.

The supported production backing classifications are ext4/direct and overlay.
Other filesystems remain unknown. Overlay requires full-old-raw copy-up budget
even when the raw reports full allocation. A new writable descriptor must retain
the planned identity; an inode change during copy-up is held for recovery rather
than silently accepted. There is no claimed overlay upper-extent detection.

## Continuous cold boundary and capacity

The Linux owner holds the existing supervisor kernel flock and Apps
`apps-service.lock.oslock`, with their original inode/ownership preserved.
Before each stage it rechecks the pinned plan, exact Apps configuration hash,
Apps/VM both explicitly OFF, and the unchanged root-private closed admission
record. No historical accepted-work counter is cleared. All service-UID
processes must be absent; QEMU/controller/raw-FD use and raw loop/mount
associations are refused. Inaccessible process/mount observations fail closed.
The operator must have drained work before entering this stopped boundary.

The host budget is:

```text
2GiB-or-higher reserve + physical growth delta + copy-up budget
  + workBytes + additionalHostBytes
```

It also requires known host free inodes and checks guest projected free space
against the new-data reserve and explicit metadata-growth budget. Host/raw/guest
figures are different views; guest contents are not added to host usage twice.
Checks after allocation and before/after final proof preserve the host reserve
and remaining artifact/work budgets.

The supplied actual production metadata at00:52:32Z has only4104free guest
blocks =16809984B, despite3GiB named capacity. A half-GiB raw increase therefore
leaves only that16.8MB above the512MiB guest reserve, before new metadata/data.
This helper does not make that target adequate. The source has no current
approved G/T/image footprint and no live migration authorization.

## Side effects and durable recovery

1. Verify root plan, actual supported signed runtime, cold boundary and identity.
   Read any existing journal/guard; an ambiguous prior attempt is never replayed.
2. Persist/fsync the private prepared journal and public root-owned pending gate
   before the first writable raw open. A failure at this point does not touch raw.
3. Run `e2fsck -f -n` and require exit0 plus an output hash. Clean bit alone is
   insufficient. Repair-needed/timeout/clipped output refuses continuation.
4. Persist allocation intent, preallocate the added range with keep-size,
   fsync and prove physical coverage. Persist length intent, extend only to the
   pinned larger target, and fsync. No sparse-size claim authorizes allocation.
5. Persist resize intent, run `resize2fs` with the exact larger block count.
   Both ext4 tools run as the service UID, no supplementary privileges, no new
   privileges and empty capability bounds, using only the inherited raw FD.
6. `resize2fs` may punch zeroed metadata blocks in regular files. Persist a
   separate physical-finalization intent and re-establish allocation over the
   complete target with keep-size. Account for the actual shortfall first.
7. Run the second real read-only fsck; require exit0/output hash, same UUID and
   raw identity, exact target block count, actual free blocks/inodes, physically
   covered raw length and retained host reserve. Store this proof privately.
8. Only then publish/fsync the canonical version2 manifest, preserving volumeId,
   CPU, RAM and unrelated fields. Persist complete journal and finally approved
   guard, bound to plan hash, manifest hash, raw identity, UUID and target.

Mutating intents precede their side effects. Timeouts kill only the owned child
and wait for its real close; a kill request does not count as settlement.
Kernel-level stalls cannot be converted into a bounded successful result.
Failure/uncertainty retains `recovery_required`/pending and leaves Apps OFF.
No automatic retry, shrink, format, pointer fallback or journal deletion exists.
An already-complete exact repeat is read-only and does not rerun tools. A
complete journal with a missing/pending final guard still requires operator
reconciliation; the helper does not replay publication.

The helper does not promise rollback to an old raw length after filesystem growth.
Retained journals and observations explain the state; they are not a backup.

## Minimal runtime glue required from the release owner — NOT APPLIED

The new read-only `vast/apps-worker-growth-policy.cjs` already returns
`{allowed,phase,reasonCode?,diskBytes?,manifestSha256?}`. Unknown/malformed,
unreadable, linked, writable or non-root-owned guard state blocks. Missing guard
permits only the exact existing version1/3GiB default. Approved version2 requires
all plan/manifest/volume/raw identity bindings. Guard path must be fixed to
`/data/harness/runtime-status/worker-capacity.json`, not a caller-selectable
configuration escape.

The two existing files need these exact, small callsite changes after review:

1. `apps-worker-profile.cjs`: leave `PILOT_WORKER_PROFILE` unchanged. Separate
   structural manifest validation (fixed1vCPU/2048MiB, v1 exactly3GiB, v2 explicit
   grown-disk profile) from start authorization. `validatePilot` may accept v2
   only with a fresh `capacity.allowed`, matching `capacity.diskBytes` and
   resident manifest hash. `workerProfile` must render structurally valid but
   blocked v2 metadata/status instead of throwing and hiding the reason.
2. `apps-vm.cjs` constructor: hash/store original manifest bytes, parse and
   validate structure only. This preserves read-only diagnostics while blocked.
3. Add `capacityStatus()` using `inspectWorkerCapacity` and a private
   `requireCapacity()` using the fresh approved result; require that returned
   manifest hash equals the constructor's stored manifest hash. Never silently
   adopt a changed manifest in an already-created controller.
4. `ensure()`: call `requireCapacity()` before touching/queuing/resuming work.
   `start()`: call it again before adopting an existing ready VM and immediately
   before the actual QEMU spawn. This re-reads changes made after construction.
5. `status()`: call `capacityStatus()` and expose only its bounded status; pass
   it to `workerProfile`. A pending gate must remain explainable as blocked.
6. Only after all these sites and their tests are installed in the protected
   signed runtime, export `CAPACITY_MIGRATION_CONTRACT='raw-ext4-grow-v1'` from
   the profile module. Exporting the constant alone is not a supported consumer.

Existing entrypoints/profile/bootstrap were deliberately not edited by B.
The root must test pending-after-construction then `ensure` refusal, pending
direct `start` refusal/no spawn, changed manifest refusal, approved exact v2,
unknown guard and legacy3GiB absence. CPU/RAM/driver defaults remain unchanged.

CI integration is also deliberately separate: add
`development/guest-disk-grow-linux-check.cjs` to `linuxChecks` in
`development/ci/inventory.mjs`, and ensure disposable Linux-root CI has the
existing e2fsprogs/util-linux tools. Do not run this fixture on a runtime host.
Without classification the new checker correctly remains unclassified.

## Local evidence and its limits

- Pure tests cover missing/unknown budgets, physical/overlay reserve, exact
  identity, cold/consumer refusal before writes, every pending journal, durable
  intent ordering, failure after side effect, actual fsck-proof requirement,
  post-growth capacity, physical resealing and fresh guard bindings.
- Linux fixture has test-only `mke2fs`, exclusively for a new random
  `/tmp/homeai-grow-fixture-<16hex>` image with one fixed synthetic witness.
  Production modules contain no formatter. No mount, QEMU, install or user-data
  input is used. Source+target and retained fixture images are bounded128MiB;
  free-space preflight is at least1GiB. Nothing is automatically removed.
- Default fixture is32→64MiB; explicit test-only smaller cases are available
  to keep retained total within128MiB. Fixture policy cannot be selected through
  `growOffline`/production factory and cannot accept the real3GiB raw.
- A first formatter-created sparse fixture was refused. A later8→16MiB case
  caught a4096B hole created by resize metadata zeroing, retained recovery state
  and did not publish a manifest; this motivated the physical-finalization step.
  The guard was not weakened. Successful fixtures preserve UUID, actual witness
  contents, inode, physical allocation and two real fsck passes.
- Positive completion is followed by a deliberate pending-guard negative check;
  retained successful fixture control files therefore finish with a running
  gate to demonstrate fail-closed repeat behavior. They are not runtime inputs.
- No production capacity,3GiB migration, power-loss recovery, provider storage
  attachment, price, actual immutable runtime image/toolchain or guest readiness
  is established. No larger G or removal/cleanup decision is authorized here.
