# Deployment transaction foundations

The candidate wires these modules through `apps-deployment-orchestrator.cjs`
after the workflow installer. `verify`, `deploy` and `check` all use isolated
candidate tests and a fresh final container. Compose uses normalized build
configuration and owned per-generation API resources; it never calls the old
stable-volume `compose up` path. Real Docker/capability and production workload
acceptance remain required; controlled Docker fixtures are not that proof.

`apps-deployment-state.cjs` stores immutable project/release/source/data identities
and append-only phase events in a private SQLite WAL database with FULL sync.
Phases are planned, prepared, verifying, promotable, promoting, active, failed,
and recovery_required. Enter promoting durably before stopping any old writer.
After promoting, an uncertain result requires recovery; it cannot be called a
failed deployment with an assumed successful rollback. Active and recovered
outcomes require observation hashes; the orchestrator must derive them from
actual Docker identities and the published project pointer. Unknown evidence
must hold deployment. Hashes alone are not an external proof of application
correctness.

`apps-service-owner.cjs` takes the existing Linux kernel process lock before
constructing AppsManager, so a second controller cannot rewrite job state first.
The production entry point uses this wrapper. The lock is retained until exit
during termination, and an explicit close refuses active work. Portable mode is
the existing conservative lock implementation, not Linux crash-recovery proof.

`apps-sqlite-snapshot.cjs` is a restricted-container helper. It must never open
tenant database paths in the root Harness process. Mount only a specific source
volume read-only and a fresh destination generation. Use a trusted immutable
Node 24 helper image, no network, a read-only root filesystem, explicit resource
limits and a hard outer container deadline. Only a flat, declared SQLite file
and its WAL/SHM/journal are supported; uploads, other files, links and special
files are refused. Online backup includes committed WAL pages. The published
copy is validated and fsynced, with exclusive publication and preserved owner
and mode. Source content is not changed. A schema fingerprint mismatch refuses
an update unless the frozen additive SQL migration is explicitly declared.
Migration statements run on the helper-owned copy before ownership transfer;
existing table values must be unchanged. Existing-table DML, destructive schema
changes, attachments, triggers and arbitrary transactions are rejected. The
same SQL hash/version transition runs on shadow and latest final copies.
PostgreSQL/MySQL and mixed upload/database volumes require another verified
data adapter and are refused before stopping production.

The integration must first clone active data to an isolated test generation.
Candidate and final generations are distinct even on the first deployment.
After tests, stop the old writer only for the bounded final copy from current
production into a separate final generation. Do not promote the test database.
This preserves production writes committed after the first snapshot. Rollback
must similarly test old code against a clone of current data, preserving newer
orders; selecting a historical database is not a safe rollback. Failed or
ambiguous generations remain available for review and are not pruned.

`apps-deployment-capacity.cjs` requires host and guest bytes and inodes, measured
per-container image footprints, simultaneous old/new/test memory, source copies,
data generations and reserves. Existing memory includes ALL other running
containers in the guest, not just the previous release of this project.
The host budget conservatively includes projected guest disk growth because
the VM disk file may be sparse. Identical images still require separate full VFS
copies. `apps-worker-footprint.cjs` uses a bounded, fixed diagnostic in the
already verified guest, only for the immutable image's Docker-reported VFS
SourceDir. Unknown data refuses admission. The orchestrator must call admission
before candidate/test creation and remeasure before promotion; these helpers do
not silently prune data, wake a worker or enlarge the approved pilot.

SQLite admission additionally measures the operator-pinned helper image and
reserves four retained helper VFS copies, their inodes and 128 MiB helper RAM
before the first data inspection. Helpers have no network, no app image code,
read-only rootfs and source mount, and only CHOWN/DAC_READ_SEARCH capabilities.
The final-copy operation is durable and single-use. Even a completed final copy
cannot be replayed after a writer resumes; a new attempt needs a new release and
both new generations. Unknown jobs/journals prevent VM restoration and any new
deployment. Only currently published generations may resume or start.

The manifest declares `dataPolicy:{"kind":"stateless"}` or a SQLite policy with
`kind`, logical `volume`, flat `database`, `mountPath`, optional `maxBytes`
(4 KiB–256 MiB), and optional `migration:{file,fromVersion,toVersion}`. SQL files
are frozen with source and limited to 16 KiB. First initialization may copy the
image data directory into a fresh shadow volume to obtain its UID/mode; a
separate pre-test baseline supplies final data. Every helper, update and final
mount uses `NoCopy:true`. Reports show `publishing` until the pointer and journal
are active; uncertain outcomes remain `recovery_required` with retained data.

Local validation includes a real WAL database, isolated test mutations, later
production writes, schema/size/link refusal, a dropped-privilege read-only WAL
copy, FIFO refusal, actual filesystem counts, competing controller processes,
SIGKILL and dead-owner recovery. This is not a Docker engine integration test,
an application cutover test or a power-loss test.

Primary implementation references: [Node SQLite backup API](https://github.com/nodejs/node/blob/v24.x/doc/api/sqlite.md#sqlitebackupsourceDb-path-options)
and [Docker VFS metadata and full copy implementation](https://github.com/moby/moby/blob/master/daemon/graphdriver/vfs/driver.go).
