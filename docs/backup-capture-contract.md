# Encrypted data snapshots and isolated restore

`development/backup-envelope.cjs` is an operator primitive, not a scheduler or
proof that a running system is idle. It uses the existing backup design's
streaming AES-256-GCM encryption, with a new RSA-OAEP-SHA256 envelope for each
random data key. The runtime receives only the laptop's RSA public key (minimum
3072 bits). Keep the private key separately protected on the recovery computer;
do not send it to the GPU runtime or commit either operational key.

`encryptSnapshot({source, sourceComplete, destination, recipientPublicKey,
assertFence, maxBytes, reserveBytes, timeoutMs, signal})` consumes a gzip tar
stream, capped at 2 GiB by default. The caller must register `sourceComplete`
before starting the capture and resolve it only when the owned producer exits
successfully. A completed pipe with a failed producer is not a backup.

The synchronous `assertFence()` must prove continuous writer exclusion, both
before capture and before publication, and return the same
`{version:1, kind:'cold-start', sourceCommit, fenceWitnessHash}`. An activity
sample is insufficient. The first supported integration is the root launcher's
cold boundary before `launchUi`: retain the existing kernel FD9 lease, keep
runtime admission closed, assert that no agent/editor/tool/Apps writer exists,
and do not launch any writer until the capture settles. The witness hash binds
that exact launch epoch and lease, not a caller-supplied arbitrary boolean.
The module cannot manufacture this proof and has no supervisor control API.

The cold hook uses the persistent, root-private directory
`root-secrets/runtime/backup-outbox`, with an explicit maximum of 256 MiB and a
2 GiB free-disk reserve. The operational configuration may select a smaller cap.
It refuses existing orphan files and retains an unacknowledged snapshot rather
than accumulating or deleting archives. A cold capture never relies on tmpfs
surviving an instance stop.
The capture creates no plaintext archive and never replaces an existing backup.
Only after stream completion, successful producer exit, unchanged fence and
fsync does it publish the completed file. The returned receipt contains its
ciphertext SHA-256, exact byte count, recipient fingerprint and capture witness.
The trusted hook must atomically persist this receipt and retain an unacknowledged
snapshot after a transfer failure. Source/private payloads are never logged.

Use explicit source mappings to these archive prefixes: `sessions/`,
`projects/`, `workbench/`, and `applications/`. Do not include credentials,
device registration/revocation state, vault or runtime machine identities.
Databases must already be closed or copied through a proven database snapshot
API under the same boundary. Links and special files are not supported: classify
them before capture and fail with an explicit coverage limitation instead of
silently skipping data or following a link outside the selected source.

`verifySnapshot({file, recipientPrivateKey})` authenticates every encrypted byte.
`restoreIsolated({file, recipientPrivateKey, destinationParent, python,
maxExtractedBytes})` first authenticates without writing plaintext, then performs
a second authenticated pass into a new private staging directory. The Python
3.12+ standard-library extractor rejects traversal, Windows aliases, duplicate
paths, links, devices, sparse members, forbidden security state and size/entry
overflows. The parent only publishes a randomly named `restored-*` directory
after complete extraction and successful second authentication. The API has no
live-install or overwrite destination; restored files are inert mode 0600.
Any later migration into a running system needs its own schema, current security
state and deliberate operator workflow. Old revocations or keys are never
restored over current state by this primitive.

Validation uses synthetic project and session data plus a closed SQLite database,
then opens and queries the restored database. Tampering, wrong keys, interrupted
producers, changed fences, capacity/size/deadline failures, preexisting archives
and hostile authenticated tar entries are negative cases. This does not prove
production backup coverage, the launcher fence, transfer acknowledgement,
retention, key custody or a working periodic schedule.

The implementation in `vast/cold-backup.cjs` runs after offline maintenance and
before Native starts. The existing FD9 lease and closed admission epoch remain
held throughout the producer lifetime. All untrusted writers must run under the
service UID whose absence is checked; another trusted root writer must not run
concurrently. Failure to observe that fence is fatal to startup. Ordinary backup
availability failures write `backup-status.json` and allow Native to start.
An unacknowledged archive or partial publication remains available for explicit
reconciliation. The hook is inactive until a root-owned `backup-config.json`
and `backup-recipient.pem` are enrolled in the private runtime state directory.

`development/backup-capture.py` streams only its fixed mappings and records
coverage inside the archive. Docker's raw disk and volumes are currently outside
that coverage, as are derived dependency directories and control security state.
This is a selected-data backup, not a claim that every application volume is
protected. The metadata-only `backup-census.py` does not establish a writer fence
or predict actual compressed size.

On the recovery computer, run `node development/backup-pull.cjs CONFIG.json`.
The private local configuration supplies the existing SSH host/port, pinned
known-hosts file, identity file, local private-key path and archive directory.
The client refuses unpinned hosts, checks exact ciphertext bytes and SHA-256,
authenticates the full GCM envelope, compares capture and recipient metadata,
and syncs the local file before acknowledging transfer. POSIX also syncs the
archive directory; standard Node does not offer equivalent directory sync on
Windows. A failed acknowledgement leaves the verified local archive for retry.
Wrong keys or incomplete transfers never clear the remote pending receipt.
Operational keys and archives belong outside the source checkout, under private
filesystem permissions; neither key is a release artifact.

A daily pull may collect a new cold-start snapshot. If the runtime remained warm
and no fresh snapshot exists, report `deferred/stale` and the last verified age;
do not report that the current day was backed up. A future warm-idle snapshot
needs a proven exclusion boundary for every live writer before it can replace
this cold-start limitation.
