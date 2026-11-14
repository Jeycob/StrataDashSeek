# Application releases, Compose and external credentials

This extends [the Docker worker](applications.md). Use Node 24. Install the pinned YAML dependency with `npm ci --prefix /data/harness/app/vast --ignore-scripts`. The managed Docker CLI, Buildx and Compose plugins are opt-in (`cliEnabled`) and communicate only with the existing worker's loopback API or a pinned SSH tunnel. The installer does not install or start a host Docker daemon.

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

The pipeline snapshots source, builds an immutable image, starts a candidate, runs application and browser checks, and verifies the editable source has not changed before promotion. Failure retains the old single-container deployment. Reports and screenshots are stored with the release. Rollback redeploys a retained immutable image and runs checks again; it does not edit the current workspace. Release history omits unfinished report files and lists summaries separately from full reports.

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

Compose runs through the official CLI with a normalized policy: up to eight services, one gateway-published web port, an isolated default network, owned named volumes, dropped capabilities and bounded CPU/RAM. The pilot's total application memory budget is 1536 MiB. Host bind mounts, host networking, privileged mode, inherited host environment, arbitrary external resources and unsupported Compose options are rejected. Source port mappings are replaced by the private gateway assignment. This is a documented Compose subset, not every option supported by Docker.

Persistent volumes have stable project names and are never removed by deployment cleanup. The old stack is stopped before the candidate opens those volumes. On failure, candidate resources are removed without `--volumes`, and the previous containers are restarted. A change to a persistent service's image is refused until its data has been backed up and migrated separately. Application rollback cannot undo application-driven database migrations or other data changes; plan compatible schema changes separately.

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

Single-container runtime values are supplied to Docker's runtime environment; they are visible to authorized Docker administrators, and never become build arguments or exported source. Build values use `buildx --secret` environment-backed mounts. Consume them in a Dockerfile with `RUN --mount=type=secret,id=NPM_AUTH ...`. Do not copy them into a layer. CLI output is buffered and redacted before logging, including common encoded representations.

Compose environment references use `${HARNESS_SECRET:DATABASE_URL}` and the project's runtime name mapping. Compose file secrets use a declared name with `x-harness-secret` and the matching runtime/build mapping. File materialization is private and RAM-backed on Linux and is removed even on failure. Configurations containing resolved values are never stored in release metadata or exports.

`vault-migrate.cjs inventory|migrate PLAN MACHINE_IDENTITY_FILE` accepts only explicit source files beneath allowed roots, supports text/JSON/dotenv, checks every destination by read-back, refuses conflicting existing values and preserves source files. Reports contain names and status, not values or password hashes. Use operator-owned plans and an independently verified backup. The separate root `hydrate` mode materializes approved operational files in `/dev/shm/harness-vault` with specified owners; the directory is traversable while each file remains mode 0600. Configure guard `vastApiKeyFile` for the shared in-memory Vast key. The billing sampler supports the same path and is enabled separately through `config.json.efficiencyBillingEnabled`.

If `/data/harness/root-secrets/vault-runtime.json` exists, the supervisor hydrates it from the root-only `vault-machine.json` before launching consumers. This is opt-in: do not activate until imports, ownership, consumer paths, recovery and a cold start have been verified. An unavailable vault prevents credential-dependent startup. A bootstrap failure is logged without secret values and terminates children started by that supervisor.

## Export and remote targets

A successful release can be exported as `.tar.gz` with source, Docker/Compose configuration, required credential **names**, report and browser evidence. The job contains an archive checksum and an owner-authenticated download link. Database contents, actual vault values, machine identities, `.env` files and SSH private keys are excluded. Recreating an image still requires the referenced dependencies/base images unless separately retained in a registry.

Remote targets are optional and owner-configured. The first implementation supports Linux Docker hosts on Tailscale, an SSH user authorized for `/var/run/docker.sock`, a pinned public host key, and a private SSH key referenced from the vault. Keys and known-host data are temporarily materialized in RAM. The SSH transport forwards only the Docker API and the eight application ports; no public unauthenticated Docker socket is created. Applications bind to the chosen target's Tailscale address. The same candidate tests and browser checks run before remote promotion. Target port authorization/firewall rules must already permit access; the Harness does not change remote ACLs or rent hosts.

Use `remote-preflight PROJECT_ID TARGET_ID` before `remote-verify PROJECT_ID TARGET_ID`. Remote deployments retain independent state and reports; the UI shows their last verified container snapshot without repeatedly connecting to remote machines. The user selected preparation **without a live remote target**, so live remote deployment remains intentionally untested.

## Validation status of this change

Local regression tests cover candidate rejection, stale source, secrets, migration scope, export streaming and existing power/authentication controls. The generated three-service configuration was accepted by the actual Docker Compose 5.1.4 CLI. Linux Docker/Buildx/Compose binaries were executed successfully in the existing Ubuntu environment. Real Infisical login, cross-project denial, four imported operational records and both reader identities were verified; source copies remain until live comparison and cutover.

The original Vast instance is stopped and returns `CAPACITY_UNAVAILABLE` on wake. Nothing in this v2 change has been deployed there yet. Existing whole-instance cold-wake persistence, real Compose lifecycle/BuildKit on the QEMU worker, exhaustive server credential inventory and runtime cutover must be verified when that same instance becomes available. No new paid instance, disk enlargement or replacement model was created.
