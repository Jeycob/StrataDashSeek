# Application releases, Compose and external credentials

This extends [the Docker worker](applications.md). Use Node 24. Install the pinned YAML dependency with `npm ci --prefix /data/harness/app/vast --ignore-scripts`. The managed Docker CLI, Buildx and Compose plugins are opt-in (`cliEnabled`) and communicate only with the existing worker's loopback API or a pinned SSH tunnel. The installer does not install or start a host Docker daemon.

The managed VM applies its control firewall before it can report Ready, including when recovering an already running VM. Container bridges cannot reach the Docker TCP API. Container and builder requests to QEMU's host-alias subnet are rejected, including pre-existing application connections; only reply traffic for trusted inbound control/previews and the fixed DNS/DHCP paths are allowed. IPv6 is disabled inside this IPv4 worker. The rules use Docker's documented [DOCKER-USER chain](https://docs.docker.com/engine/network/firewall-iptables/), without changing the Vast host or Tailscale firewall. A real isolated Linux network test verified control access, denial paths, established-connection rejection, previews, DNS/DHCP and idempotence. The later QEMU/Docker fixture results and their limits are recorded in the validation history below; they do not establish successful verification of the current shop. Host-side project commands retain the [shared-OS-account security limit](workspace-runtime.md#independent-work).

## Packaging and verification

In **Applications and containers**, enter a workspace-relative project folder and choose **Prepare Docker**. The generator handles npm Node servers, static Vite frontends, Python entrypoints (including declared Uvicorn/FastAPI and Gunicorn/Flask), and .NET 8–10 projects. It preserves existing deployment files. Review warnings, custom output folders, ports and base image digests before using the result.

The equivalent CLI is `/data/harness/node/bin/node /data/harness/app/vast/apps-cli.cjs` followed by:

```text
scaffold-plan my-project
scaffold my-project
register my-project
verify PROJECT_ID
state
job-log JOB_ID
releases PROJECT_ID
rollback PROJECT_ID RELEASE_ID
export PROJECT_ID
```

`verify` requires a real application `testCommand` in `.harness-app.json`, expressed as an argv array and included in the built image. Tests run in a bounded separate container against the candidate's network. The manifest may also declare `browserPlan`, a project-relative plan using the existing [real browser driver](qwen-quality.md). Plans must positively assert the application's acceptance flows; provide desktop and mobile coverage as appropriate. Deployment plans are limited to 16 screenshots, 500 total viewport-steps and 1920×1080 per viewport, with a 120-second browser deadline. If no plan is supplied, the report explicitly says `render-smoke`; that check does not prove business correctness.

The pipeline snapshots source, builds an immutable image, starts a candidate, runs application and browser checks, and verifies the editable source has not changed before promotion. Failures before promotion retain production unchanged. Once old-writer stop intent is durable, an uncertain outcome is recovery_required and is never treated as a successful rollback. Reports and screenshots are stored with the release. Rollback redeploys a retained immutable image and runs checks again; it does not edit or require a valid current workspace. Release history omits unfinished report files and lists summaries separately from full reports. Export downloads hold an activity lease until the connection closes, with a bounded idle timeout.

Source identity version 2 binds relative names, modes, lengths and contents. Symlinks, credentials, dependency caches and generated verification directories are excluded from build snapshots. At least the configured host reserve plus 512 MiB must be free before release verification. Retained releases consume storage; the pilot does not silently buy storage or delete historical data.

## Compose stacks

For an existing Compose application, add `composeFile` and `entryService` to the manifest. `port` is the selected web service's internal port. A standalone Dockerfile is not required for image-only stacks.

```json
{
  "version": 1,
  "name": "Store",
  "composeFile": "compose.yaml",
  "entryService": "web",
  "port": 8080,
  "testCommand": ["node", "tests/deployed.cjs"],
  "browserPlan": "browser-checks.json"
}
```

Compose uses the official CLI for configuration/build/pull and owned Docker API candidate/final stacks with a normalized policy: up to eight services, one gateway-published web port, an isolated default network, owned named volumes, dropped capabilities and bounded CPU/RAM. The pilot's total application memory budget is 1536 MiB. Host bind mounts, host networking, privileged mode, inherited host environment, arbitrary external resources and unsupported Compose options are rejected. Source port mappings are replaced by the private gateway assignment. This is a documented Compose subset, not every option supported by Docker.

Persistent SQLite data uses distinct shadow and final generation volumes. Declare `dataPolicy` in `.harness-app.json`: `kind: "sqlite"`, a logical `volume`, flat `database` filename, `mountPath` (for example `/app/data`), optional `maxBytes` (4 KiB–256 MiB), and optional `migration` with a relative SQL file plus increasing `fromVersion`/`toVersion`. SQL files are frozen with source and limited to 16 KiB; additive changes preserve existing values. Only the pre-test initial baseline or a fresh final copy of the latest stopped production data is published. Candidate test writes never become customer data. Old code rollback is tested against current compatible data. PostgreSQL/MySQL, destructive migrations and mixed upload/database volumes require another verified adapter and are refused before stopping production. Stateless apps have read-only root filesystems and disposable `/tmp`.

The helper image is an operator-pinned immutable Node image with label `io.stratadashseek.apps.data-helper=sqlite-v1`; it must differ from every app image. Helper mounts disable image copy. Capacity admission includes four retained helper VFS layers, actual inode counts and 128 MiB RAM in addition to old/candidate/independent tests/final data. The finalization API is single-use, including after successful completion. Unknown journals hold new work and VM restoration; historical/test/helper generations cannot be started from the container panel. Reports remain `publishing` until the durable project pointer and transaction are active. `recovery_required` preserves files and volumes for inspection and does not automatically retry.

## Infisical

The selected provider is Infisical Cloud Free. [Current pricing](https://infisical.com/pricing) lists five human/machine identities, unlimited projects and three environments. The basic Viewer role was verified in the actual account. Advanced roles, audit/history and automatic rotation have paid-tier limits. Bitwarden Secrets Manager Free is another zero-subscription option, with a three-project limit. A GitHub PAT authenticates GitHub requests; Actions secrets cannot be read back as general runtime secret values, so neither replaces this vault.

Connect the **Application** machine identity in Harness settings. The region, Client ID and an authentication check are shown; the Client Secret is never returned by state APIs. An optional saved expiry date is displayed. Keep operational and application identities separate, with organization **No Access** and project **Viewer**. Migration uses a temporary project writer, whose memberships are removed after transfer. One limited bootstrap identity must remain available to each runtime; secret values must still be used in memory by their consumers.

Per-project settings contain only an Infisical project ID, environment, folder and name mappings:

```json
{
  "scope": {"projectId": "YOUR_PROJECT_ID", "environment": "prod", "secretPath": "/store"},
  "runtime": {"DATABASE_URL": "STORE_DATABASE_URL"},
  "build": {"NPM_AUTH": "PRIVATE_NPM_AUTH"}
}
```

Single-container runtime values are supplied to Docker's runtime environment; they are visible to authorized Docker administrators, and never become build arguments or exported source. Build values use `buildx --secret` environment-backed mounts. Consume them in a Dockerfile with `RUN --mount=type=secret,id=NPM_AUTH ...`. Do not copy them into a layer. CLI output is buffered and redacted before logging, including common encoded representations. Compose values escape dollar signs before CLI interpolation; arbitrary host-variable interpolation is rejected.

The QEMU worker must prove control-plane isolation before project credentials can be resolved. Guest rules reject application and builder access to QEMU's host alias/control subnet, preserve DNS/DHCP and replies to preview traffic, and block guest Docker TCP access from application bridges. IPv6 is disabled inside this pilot worker. Startup requires a fresh serial bootstrap acknowledgement and successful exit before querying Docker or restoring containers; an already-reachable API alone is insufficient. These rules do not isolate hostile workloads from every other network service: run only projects trusted by the owner.

Compose environment references use `${HARNESS_SECRET:DATABASE_URL}` and the project's runtime name mapping. Compose **build** file secrets use a declared name with `x-harness-secret` and the matching build mapping. Build file materialization is private and RAM-backed on Linux and is removed even on failure. Runtime `services.*.secrets` file mounts are rejected: Compose would interpret their source path on the Docker host inside QEMU or the remote machine, where the client-side file does not exist. Use runtime environment references instead. Configurations containing resolved values are never stored in release metadata or exports.

`vault-migrate.cjs inventory|migrate PLAN MACHINE_IDENTITY_FILE` accepts only explicit source files beneath allowed roots, supports text/JSON/dotenv, checks every destination by read-back, refuses conflicting existing values and preserves source files. Reports contain names and status, not values or password hashes. Use operator-owned plans and an independently verified backup. The separate root `hydrate` mode materializes approved operational files in `/dev/shm/harness-vault` with specified owners; the directory is traversable while each file remains mode 0600. Configure guard `vastApiKeyFile` for the shared in-memory Vast key. The billing sampler supports the same path and is enabled separately through `config.json.efficiencyBillingEnabled`.

If `/data/harness/root-secrets/vault-runtime.json` exists, the supervisor hydrates it from the root-only `vault-machine.json` before launching consumers. This is opt-in: do not activate until imports, ownership, consumer paths, recovery and a cold start have been verified. An unavailable vault prevents credential-dependent startup. A bootstrap failure is logged without secret values and terminates children started by that supervisor.

## Export and remote targets

A successful release can be exported as `.tar.gz` with source, Docker/Compose configuration, required credential **names**, report and browser evidence. The job contains an archive checksum and an owner-authenticated download link. Database contents, actual vault values, machine identities, `.env` files and SSH private keys are excluded. Recreating an image still requires the referenced dependencies/base images unless separately retained in a registry.

Remote targets are optional and owner-configured. The first implementation supports Linux Docker hosts on Tailscale, an SSH user authorized for `/var/run/docker.sock`, a pinned public host key, and a private SSH key referenced from the vault. Keys and known-host data are temporarily materialized in RAM. The SSH transport forwards only the Docker API and the eight application ports; no public unauthenticated Docker socket is created. Applications bind to the chosen target's Tailscale address. The same candidate tests and browser checks run before remote promotion. Target port authorization/firewall rules must already permit access; the Harness does not change remote ACLs or rent hosts.

Use `remote-preflight PROJECT_ID TARGET_ID` before `remote-verify PROJECT_ID TARGET_ID`. Remote deployments retain independent state and reports; the UI shows their last verified container snapshot without repeatedly connecting to remote machines. The user selected preparation **without a live remote target**, so live remote deployment remains intentionally untested.

## Validation status of this change

The integrated local regression suite passed 180 checks, with no failures or skipped tests. All 32 Linux Python checks passed. The actual browser adapter passed 12 assertions and produced two screenshots in Chromium; both deliberately overflowing viewport checks failed as expected. The generated three-service configuration was accepted by the actual Docker Compose 5.1.4 CLI, including literal dollar values. `deployments/test-worker-network.py` applied the generated firewall in temporary Linux network namespaces and verified application/Compose bridge denial, pre-existing connection denial, trusted control access, previews, DNS/DHCP and idempotence without changing host rules.

The same original Vast instance became available and the v2 service was deployed with backups, without restarting the model or main Harness. Real BuildKit secret mounts, runtime Infisical references containing dollar signs and Unicode, application tests, desktop/mobile Chromium checks, single-container rollback despite a broken working manifest, authenticated export and a web/backend/Redis Compose stack passed. Compose rollback preserved a database marker. Live testing also found and fixed the Buildx cache ownership, partial-stop recovery, stop deadlines and preview-port collision issues. The multi-container worker sleep/cold-wake retest passed: clean sleep took 41.7 seconds and wake 154.4 seconds, with the same running containers, preserved Redis data and fresh control-isolation proof. This small pilot validates the declared fixture, not a production shop or arbitrary database migrations.

Whole-instance restoration preserved Native projects, session history, the active Apple registration and the original Docker container/image/writable marker. Six operational vault records were verified against live sources; five static runtime files now resolve to private RAM materialized from the Operations reader. The mutable Native credential store has a verified vault recovery snapshot and retains its local cache. Runtime machine identities remain separate and the temporary writer's project memberships were removed and denied through the API. Root-only original backups remain for recovery. After the original instance woke on 2026-11-15, standard supervisor startup restored all five RAM files from Infisical and all eleven services became available, preserving 56 chats. This cycle required operator recovery of a Python bytecode file added to the signed release; the integrity gate correctly blocked the initial startup. Managed services now prevent those bytecode writes. A further unattended whole-instance cold cycle with this fix remains unverified. No new paid instance, disk enlargement or replacement model was created. See [runtime evidence](../deployments/startup-runtime-live-20261115/status.json).

## Runtime awareness and automatic storage cleanup

In every isolated project, `runtime_capabilities` reads deployment file metadata,
the current project's registered Apps state and jobs, and actual host capacity.
It never starts Docker, executes commands or changes files. The context reminder
survives compaction; call the tool again before deployment because disk space
and worker state change. Existing deployment files are reviewed and reused.
`verify` performs build, candidate application tests and browser checks and wakes
the managed QEMU worker when needed. A sleeping worker is an available capability,
not a missing Docker installation. Wait for existing queued/running operations
instead of repeating wake/build. Host capacity is checked before waking the VM.

For a user preview, use `verify`, which can reuse image cache and requires the
application and browser checks. Granular `build`, `deploy` and `check` operations
are maintenance actions. Capability recipes offer standalone deploy only when
the project has a selected image, and check only when it has a deployment.
An image left by a failed release is not automatically a selected deployment.

Before a capacity rejection, Apps automatically removes recognized terminal-job
build copies, partial failed exports and failed-release source copies. It keeps
release reports, browser evidence, successful releases and rollback sources.
Active jobs and downloads are protected. It never prunes Docker images, containers,
volumes, databases, model weights or credentials. If space still falls short, the
error gives free, required and missing bytes; the safety reserve remains enforced.

The workspace runtime also reclaims only npm's downloadable `_cacache` from idle
managed projects when host space is low. It obtains an exclusive project lease,
rechecks foreground and background activity and respects read-only sessions.
Sources, lockfiles, installed `node_modules`, test evidence and secrets remain.
The next dependency installation may download packages again. Cleanup records
contain aggregate counts and byte totals, not file contents or secret values.

Step limits apply to the current human request. Once server-owned message and
turn identities have been observed, a later human request starts a fresh step
counter. Internal continuations, provider retries and subagents cannot renew it.
Existing blocked runs still require the owner's Run review strategy; failures,
stalled repairs, verification results and required checks are retained. A queued
Apps operation never counts as successful verification.

The managed Docker VM has a separate disk and inode budget. Its free bytes,
free inodes and measurement time are recorded. Before building and again before
starting a candidate, Harness checks at least 512 MiB and 16,384 free inodes.
A low managed-worker reserve triggers only Docker's unused **build cache** cleanup,
under the current Apps job lock and verified worker isolation, followed by a fresh
measurement. It never calls system/image/container/volume prune. Insufficient
capacity after cleanup remains a failure and the previous deployment is retained.
See [Docker builder prune](https://docs.docker.com/reference/cli/docker/builder/prune/).
Host free-space success alone does not establish guest capacity. Build logs now
identify the worker startup and image-building phases explicitly.

### Capacity profile of the current Vast pilot

The currently approved worker is QEMU/TCG with 1 vCPU, 2 GiB RAM and a fixed
3 GiB persistent disk. Its Docker daemon uses `vfs`. Check the current worker
configuration before applying these pilot limits to another backend. Docker's
[VFS documentation](https://docs.docker.com/engine/storage/drivers/vfs-driver/)
explains that creating another layer copies its parent directory. Temporary build
usage can therefore greatly exceed the final image size. More stages and many
small COPY/RUN layers can increase the peak even when the runtime image shrinks.

Account for the build's peak working set, minimize unnecessary layers and remove
package download caches within the same RUN step that creates them. Do not infer
that a smaller final image fits this pilot. Host capacity, guest capacity and a
completed image build are three different facts. If unused-cache cleanup still
cannot fit the build, preserve the failed report and describe the capacity blocker;
do not retry unchanged, weaken tests, remove retained images/data, change storage
drivers or enlarge/rent infrastructure automatically. A storage/backend change
must preserve existing application data and be planned separately. Successful
native Node/Python tests do not imply that a Docker image already exists.

`runtime_capabilities.apps.workerProfile` reports the approved CPU, RAM, disk,
acceleration and configured storage driver. The observed driver is populated
only by a verified worker boot. Its timestamp and `observedInRunningBoot` flag
distinguish that observation from configuration and from a sleeping worker.
Neither these limits nor free-space samples predict peak build usage.

An operator can explicitly submit an empty object to the authenticated, private
Apps `POST /worker-probe` endpoint for a bounded OverlayFS capability diagnostic.
It owns the Apps job lock, wakes the existing worker if needed, checks its
identity and creates only its own small scratch fixture outside Docker's data
directory. It tests mounting, copy-up and deletion, then verifies unmount and
cleanup. A missing result, timeout, nonzero successful-result exit, or cleanup
failure cannot pass. The endpoint accepts no commands, paths or options and is
not exposed as a model tool. Reading state never runs this diagnostic.

This diagnostic does not select OverlayFS, install a builder, change Docker's
storage configuration or migrate retained application data. A positive result
establishes only the tested guest-kernel capability, not sufficient disk space
or a successful Docker deployment. Local regression fixtures do not substitute
for executing the diagnostic on the actual worker.

### Slow container creation and uncertain responses

Filesystem copying in a VFS worker can outlast a short API request even when
there is enough disk space. Container create and delete use bounded 120-second
deadlines, start uses 90 seconds, and stop allows its configured grace period
plus time for the daemon to finish. Read requests retain short deadlines.
Application and separate test containers follow the same creation path.

Before create, Harness durably records a unique job/name/nonce and immutable
image reference, without environment values. If the response is lost, it
inspects that original name for up to 30 further seconds and never sends a
second POST. Only the exact nonce-bound, never-started container can be adopted.
An unknown result remains unresolved, including across service restarts and
ordinary history trimming. A later operation must reconcile it first; absence
alone does not prove the original request had no effect. Recovery can delete
only that failed operation's matching, unreferenced, never-started container,
without force, volume removal or image removal. Started or changed containers
require inspection and are retained. A timeout is never successful deployment.

Pre-journal candidate timeouts are reconciled only after a verified fresh worker
boot, against the retained failed release's immutable image, unique job name,
creation time, ownership and absence of mounts or project references. Cleanup
requires a never-started, unprivileged container. Without that proof the old
resource remains and another create is refused. Historical failure reports and
their outcome stay available; unresolved records are retained beyond the normal
hundred-job history limit.

Before/after free-space differences measure net retained usage. They do not
measure the maximum temporary build usage, which remains unknown unless it was
observed separately.

On 2026-11-15 the actual managed guest kernel `6.18.60-0-virt` passed all twelve
diagnostic checks, including verified unmount and scratch cleanup. Docker still
reported VFS. Automatic unused-cache cleanup increased guest free space from
252,125,184 to 1,039,491,072 bytes. All five project image/container/release
references were unchanged and all seven previously remembered managed
containers remained present. The measured 170.9 seconds includes cold worker
startup and cache cleanup, not just the small filesystem test. This does not
establish that the shop's build fits or authorize a storage migration.
