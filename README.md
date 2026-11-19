# StrataDashSeek

Optional application builds and container UI: see [Applications](docs/applications.md). The Docker worker is disabled by default and requires an explicitly configured dedicated daemon.

Run DeepSeek Harness, Strata and a local model together on one stoppable Vast.ai instance. Wake it from a free Cloudflare Worker, connect privately through Tailscale and receive iOS Web Push when work finishes.

Start with the [installation and operation overview](docs/installation-overview.md)
to distinguish first installation, ordinary wake and optional Apps. The
[request budget](docs/request-budget.md) separates Worker traffic from direct
Vast billing reads and private monitoring. A [read-only disk review](docs/disk-plan-20261114.md)
identifies specific migration artifacts for review; it authorizes no deletion.
For isolated projects, [managed commands](docs/managed-commands.md) explains how
ordinary `bash` calls share the confined `project_exec` environment across chats.
The [signed startup gate](docs/startup-updates.md) activates verified source
before the first Harness request. Runtime upgrades and first installation remain
separate maintenance operations.

The Native right sidebar provides **Workspace files**, **Changes** and
**Applications and Docker**. Open the sidebar's guide to choose a tool, or use
Ctrl+Alt+P for files. Changes follow saved files while the model works, including
shell writes. The workbench's project, Docker and vault options use the existing
**Settings**. See the [workbench guide](docs/workspace-runtime.md) for tracking
limits, temporary process jobs and verification behavior.

```mermaid
flowchart LR
  Phone[iPhone / browser] -->|authenticated wake| Worker[Cloudflare Worker]
  Worker -->|start existing instance| API[Vast API]
  Phone -->|Tailscale HTTPS| Proxy[Private loopback proxy]
  subgraph Vast[Vast instance · persistent disk]
    Proxy --> Harness[DeepSeek Harness]
    Harness --> Adapter[Local model adapter]
    Adapter --> Strata[Strata + model]
    Harness --> Logs[Session logs]
    Logs --> Notify[Push watcher]
    Notify --> Apple[Apple Web Push]
    Lifecycle[Turn lifecycle + process guard] -->|idle 5 minutes| API
  end
  Apple --> Phone
```

The Worker hosts only the wake page and controller. Your projects, chat history and model requests do not pass through Cloudflare. The Vast token is held in Worker Secrets and in a root-only server file. Harness is bound to loopback and exposed only through Tailscale Serve, with its own browser authentication. No Funnel is enabled.

## Components

- `cloudflare/worker.mjs`: authenticated wake/status endpoints, signed Secure HttpOnly cookie, same-origin POST checks, optional private setup QR fragment. No KV, database or paid Worker services.
- `vast/supervisor.cjs`: parallel startup and restart of Harness, local model adapter, push service, watcher and idle guard. Harness/tools run as the unprivileged `harness` user.
- `vast/lifecycle.mjs`: tracks whole turns, including gaps between model calls and tool execution.
- `vast/idle-guard.py`: stops the existing instance after 300 idle seconds. Active turns, workspace processes, model activity, maintenance leases and stale lifecycle data prevent stopping.
- `mobile/`: iOS 16.4+ Home Screen PWA, one-time pairing and standard Service Worker push. Notifications contain only generic completion/error/attention text.

## Install on an existing Strata instance

Install Strata separately before using this package. `vast/start-strata.sh` serves Strata on `127.0.0.1:8080`, reusing the saved configuration on ordinary boots. Its provisioning fallback launches Qwen3.8 Flash Next IQ3_S, 128K, int8 KV, DFlash2 and CPU vision with 1536 MiB VRAM reserve. Model availability and installed Strata compatibility must be checked. The reference IQ3 weights need about 83.6 GB plus about 0.9 GB for vision; do not assume a disk can hold both complete IQ2 and IQ3 installations.

1. Copy this repository to `/data/harness/app`, then run `bash /data/harness/app/vast/install.sh` as root. The script verifies the official Node tarball checksum and pins Harness and Web Push versions.
2. Install Tailscale from its official Ubuntu repository. Start `tailscaled` with **both** `--state=/data/harness/root-secrets/tailscaled.state` and `--statedir=/data/harness/root-secrets/tailscale`, plus `--tun=userspace-networking --socket=/data/harness/tailscaled.sock`. Authenticate the server in your personal tailnet. Preserve its state and certificate directory across stops.
3. Copy `vast/config.example.json` to `/data/harness/config.json` and `vast/push-config.example.json` to `/data/harness/push-config.json`. Use the real Tailscale hostname and your Worker URL.
4. Copy `vast/provider.patch.example.yml` to `/data/harness/home/.dsh/profiles/web/cordis.patch.yml`. Create the parent directory if needed. The supervisor provides `STRATA_GATEWAY_KEY=local-strata`; this is a local adapter placeholder, not a Vast credential. The adapter binds only to loopback.
   Apply the HomeAI policy with `/data/harness/node/bin/node /data/harness/app/vast/prepare-homeai-profile.cjs` while Harness is stopped. It preserves the YAML expression tags and existing cloud entries, configures all four shipped agent presets, disables LLM titles and adds the whole-turn queue. The pinned runtime is Harness 0.2.2-rc.2 on Node 24.21.0. Do not copy Windows shell paths or the GameShift desktop application onto Linux.
5. Copy `vast/guard.example.json` to `/data/harness/root-secrets/guard.json`, enter the existing instance ID and leave `enabled:false` during validation. This switch controls automatic idle stop; it does not disable the separate required signed startup update policy. Put your scoped Vast token in `/data/harness/root-secrets/vast-api.key`. Keep the directory mode 0700 and files 0600, root-owned.
6. For a migration, copy the existing VAPID keys and subscription store to `/data/harness/secrets/`; otherwise the push service generates new keys. Make this directory 0700 and its files 0600, owned by `harness`. Never regenerate VAPID keys on every boot.
7. **Install the signed startup gate before starting services.** Preserve `/root/onstart.sh`; for a first installation, add exactly one recognized launcher line, `nohup bash /data/harness/app/vast/start.sh > /data/harness/logs/supervisor.log 2>&1 < /dev/null &`, without executing it yet. Transfer only the operator's independently verified **public** signing keyring to `/root/operator-public-signers.gpg`, then run as root:

   ```sh
   /data/harness/node/bin/node /data/harness/app/vast/startup-install.cjs \
     /root/operator-public-signers.gpg FULL_PRIMARY_FINGERPRINT
   ```

   Replace the fingerprint placeholder with the full trusted primary fingerprint. Keep the private signing key on the operator's computer. The installer preserves other onstart commands and rewrites the recognized launcher to `/data/harness/bootstrap/start.sh` only after installing its public trust and required policy. Leave `/data/harness/root-secrets/startup-update.json` enabled; the startup update gate has no offline fallback. For an already configured instance, follow the [startup maintenance instructions](docs/startup-updates.md) rather than adding another launcher or replaying first installation.
8. Start the trusted bootstrap once with `nohup bash /data/harness/bootstrap/start.sh > /data/harness/root-secrets/runtime/logs/supervisor.log 2>&1 < /dev/null &`. The flock prevents duplicate supervisors. Confirm `runtime-status/startup-update.json` is `ready` with `signatureVerified:true` before using Harness. Existing installations need the explicit [protected runtime migration](docs/privileged-runtime-paths.md); normal source updates do not replace the stable bootstrap. No package installs or model downloads run on normal boots.
9. Set up private HTTPS: `tailscale --socket=/data/harness/tailscaled.sock serve --bg http://127.0.0.1:3081`.
10. Run `/data/harness/venv/bin/python /data/harness/app/vast/admin.py paircode` to obtain a private, single-use ten-minute code. Open `https://YOUR-HOST/phone/` from the iPhone with Tailscale enabled and enter the code. Add it to the Home Screen and enable notifications in the sidebar's bottom **More → Oznámení na iPhonu** menu. Browser authentication survives restarts for its cookie lifetime.
11. Verify a real task, push and a stop/start cycle, then set `enabled:true` in the root **idle guard** file. Do not leave an older controller with its own shorter idle timer active.

Supervisor paths are intentional and fixed to `/data/harness`; change them together if adapting the layout. Linux containers do not require systemd or a privileged TUN device.

## Deploy the wake Worker

Use current Node 24 and install the official `wrangler` CLI. Copy `cloudflare/wrangler.example.jsonc` to `cloudflare/wrangler.jsonc`; fill in the instance ID and private Harness URL. Register a workers.dev subdomain in your Cloudflare account if it has none. Authenticate Wrangler with Workers Scripts permissions and provide `CLOUDFLARE_ACCOUNT_ID` if account discovery is unavailable.

```sh
wrangler deploy --config cloudflare/wrangler.jsonc
wrangler secret put VAST_API_KEY --config cloudflare/wrangler.jsonc
wrangler secret put WAKE_ACCESS_KEY --config cloudflare/wrangler.jsonc
```

Use a scoped Vast key and at least 32 random bytes encoded as hex for `WAKE_ACCESS_KEY`. Keep both out of Git. The optional setup link is `https://YOUR-WORKER/#setup=YOUR_WAKE_KEY`; its fragment is cleared immediately and the key is exchanged in a same-origin POST. Treat any setup QR/link as a private credential. Normal use stores a signed 30-day cookie. Rotating `WAKE_ACCESS_KEY` invalidates existing wake cookies.

The page polls Vast only while visible; checking status never starts the GPU. Waking is idempotent for an already-started instance. After waking, the page probes the private server and opens it automatically. Tailscale must be connected.

## Automatic clients and monitoring

`desktop/open-harness.cjs` reads a private JSON configuration with `wakeUrl`, `wakeKeyFile`, `sshKeyFile`, `knownHostsFile` and `timeoutSeconds`. It wakes the fixed instance, waits for readiness and obtains the latest official native login URL over SSH. Keep this configuration and its keys outside the repository. The desktop wrapper should capture the returned URL and open it without logging it.

The Home Screen app receives its own revocable v2 wake credential after Native pairing; the owner key and device signing key stay out of the browser. Configure `wakeUrl` and a service-owned, mode0600 `wakeDeviceAdminKeyFile` in the private push configuration. The [device migration procedure](docs/device-access-migration.md) requires a coordinated Worker/server/Service Worker cutover and rotation of the historically exported owner key before activation. Optional `tailscaleAutoLoginUsers` allows specified exact Tailscale identities to obtain the normal Native browser cookie. The phone bootstrap invokes a same-origin POST when unauthenticated. Trust this identity header only behind private Tailscale Serve, which strips client-supplied identity headers; both bridge and push listener must remain loopback-only and Funnel disabled. Empty/missing allowlists, missing identities and different users fail closed. Pairing remains the fallback for other clients.

The Service Worker caches only the static phone shell, including its startup script. On opening or returning to the app, it checks readiness and can wake an offline server before loading Harness. API data, authenticated history and login URLs are never cached. Use a same-origin `/phone/` notification target so notification clicks enter this offline-capable shell. Validate an actual cold launch after updating the installed app; do not interrupt active jobs to test it.

**More → Monitor serveru** displays GPU, RAM, CPU, disk, Strata rates and recent request metrics. The root collector uses monotonic elapsed time to integrate sampled GPU watts into Wh. The UI also shows kWh (1000 Wh = 1 kWh), labels the measurement as a GPU-only estimate and displays its start time. It excludes CPU and whole-server consumption and resets when the collector restarts. It does not represent Vast rental charges. Reading metrics does not extend the idle lease.

For Windows history migrations, `vast/session-migration.py` maps path separators and case correctly and encodes the header in its own Zstd frame. Verify imported sessions with the native persistence reader, not just JSON decoding. A log containing event types unsupported by the target Harness must remain backed up and requires a compatible runtime/plugin; do not silently discard unknown events.

## Sleep rules and maintenance

HomeAI parity adds one root-turn FIFO across tool gaps, inherited ownership for explicitly requested children and a lazy full-stream gate for auxiliary LLM requests. One tool runs at a time, with at most one child and depth one. Normal generation uses medium reasoning (4096 budget) and a 32768 output ceiling. All presets use compaction headroom 12288, summary limit 8192, retained tail 8192 and one overflow recovery; summary generation explicitly uses reasoning off. Ordinary transient failures retry at most twice. Explicit payload-size HTTP 413 failures stop without unnecessary context recovery. This preserves the failure in history; it does not mask it as a successful response.

The adapter waits up to 180 seconds for the local model to finish loading, and cancellation while waiting prevents inference dispatch. Health checks and model catalog requests do not wake the instance. Queue ownership improves scheduling and cache continuity; it does not guarantee faster individual tasks or correct generated code. Hardware-specific worker/cache counts remain selected for the actual cloud CPU/GPU.

The idle timer is independent of browser connectivity. Closing Safari does not cancel an agent. An active turn or a long build keeps the instance awake; after work finishes the 300-second countdown starts. A pending approval/question inside an open turn may keep it awake until answered or cancelled. Persistent preview servers also count as workspace jobs: stop them when finished.

Unknown model status or a missing/stale plugin heartbeat holds the instance awake. This protects work but can cost money after a service fault; inspect `/data/harness/state/idle-status.json` and the service logs. It is not a guaranteed spending cap. A root-only `state/maintenance.json` with `{"until":UNIX_SECONDS}` temporarily holds sleep for maintenance. Do not use a browser poll as an always-on lease.

Stopping preserves the disk, not live processes or model cache. GPU availability on a stopped Vast rental is not reserved. A host failure, lease expiry or instance destruction can lose access to the disk; back up projects separately. This implementation never destroys or replaces the instance automatically.

## iOS and migration

Web Push works through Apple even when Safari is closed. Tailscale is still required to open the private Harness. The phone must keep the Home Screen app and notification permission. Provider acceptance is not proof of delivery: test on a locked phone.

Push subscriptions belong to a web origin. Copying keys keeps old installations deliverable, but changing from a PC hostname to a Vast hostname creates a new browser origin. Pair/add the new origin once. After confirming its notifications, retire the imported subscription using `retiredAt` in the private subscription store, retain a backup and restart the notifier when idle; publishing skips retired entries. Do not commit that store. Existing Windows session headers also require Linux cwd mapping and the official project-directory encoding; copying the old directory names unchanged is insufficient. The deployment keeps the original PC history as a rollback copy.

## Validation

```sh
node --test cloudflare/worker.test.mjs vast/lifecycle.test.mjs
node --test mobile/notifications.test.cjs
/data/harness/venv/bin/python vast/test-idle-guard.py
/data/harness/venv/bin/python /data/harness/app/vast/admin.py state
```

The tests cover authentication/CSRF, signed cookies, fixed instance selection, idempotent waking, concurrent turns, tool gaps, builds, unknown model state, stale heartbeats and maintenance. Live deployment measurements are recorded separately; unit tests alone do not establish iPhone delivery or cold-start speed.

## Cost model

The Worker should fit the Cloudflare Free request/CPU limits for personal use; no paid plan is selected. Vast compute is charged while running and disk storage continues while stopped. Add bandwidth, taxes and any provider pricing changes. Use your contract's current rates rather than treating this repository as a price guarantee.

Official references: [Harness source](https://github.com/deepseek-ai/deepseek-harness), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Vast instance FAQ](https://github.com/vast-ai/docs/blob/main/guides/reference/faq/instances.mdx).


## Recorded deployment

The dated `deployments/2026-11-14-budget-result.json` records the verified A4000/EPYC migration under a 2,000 CZK monthly target. At the recorded contract rates, 12 active hours/day plus 96 GB storage cost USD 47.36 per 30 days before transfers and tax. The old instance and disk were deleted after explicit approval and verification of the final encrypted local backup; their USD 10.24/month storage charge no longer continues. The model and HomeAI policy are unchanged. Automatic stop/wake, identity login and all 65 checks passed; one CSV comparison completed in 217 seconds versus the previous 334 seconds. These measurements are observations, not performance or availability guarantees.

`deployments/2026-11-14-homeai-iq3/` contains sanitized settings actually captured from the deployed stack, a checksum manifest and verification results. Take a new sanitized snapshot and push it before changing production configurations or versions. Private backups stay outside Git. Hardware search results are observations, not proof of inference speed; benchmark the same model and tasks before promoting another host.

Monitor telemetry normalizes CPU to the container quota and uses cgroup I/O counters rather than other tenants' host activity. It also exposes elapsed generation time, output budget and whole-turn queue ages. Energy remains an estimate for the GPU only, measured since the telemetry process started.

### Progress-only completion guard

`vast/completion-guard.mjs` uses the supported `agent/turn-stopping` hook. A short progress announcement such as “Now the stylesheet.” after a successful tool can otherwise close a partially completed task with a normal model `stop`. It also recognizes a short probe result followed by a final action promise, such as “WebGL works. I'll now write the game.” This prevents a successful environment probe from being treated as the end of the requested implementation. The added prefaced-response case excludes quotations, delivery statements and conditional offers. For `strata-vast` only, the guard steers the same turn at most twice. Cancellation, queued user input, tool errors, token-limit stops, ordinary final answers and explicit blockers remain authoritative. This is a narrow heuristic, not a general verifier that all user requirements are complete.

The guard accepts the pinned SDK's `reasoning` blocks alongside visible text and classifies only that visible text. This also applies to explicit recovery of an already ended turn. Reasoning alone, malformed blocks, tool calls and attachments do not qualify. The SDK fixtures generate reasoning through actual `reasoning-delta` assembly, covering both same-turn continuation and recovery with preserved counters.

`vast/install-completion-guard.cjs` privately backs up the current profile and adds only the new plugin; profile HMR loads it without restarting active agents. `prepare-homeai-profile.cjs` also includes it for future installations. Portable regressions cover the classifier, cancellation and continuation limits. `vast/completion-guard-sdk.test.mjs` checks the real pinned AgentLoop and tool executor with an inert adapter: tool → probe report and action promise → same-turn steering → tool → final answer. The optional Linux `vast/completion-guard-smoke.cjs` exercises an isolated real Harness with a loopback fake model. Neither fixture uses GPU or cloud model calls; the Linux fixture's fixed loopback ports must be unused.

For a progress-only turn that already ended before the guard was installed, `vast/continue-incomplete.mjs` provides explicit owner continuation through the authenticated native connection: POST `/api/homeai/continue-incomplete` with `{sessionId, requestId, expectedTurnEndSeq}`. Use one fixed request ID for retries. This is an operator recovery API; it does not add a new user approval requirement. It accepts only an idle owner session with empty input, a successful last tool and a matching completed progress-only response. Active jobs, terminals, children, blocked or uncertain work, and changed original-task identity prevent admission. It reads the existing workspace manager and corroborates its task identity against the private registry; it never creates a second manager or resets counters. The next admitted step advances six existing steps to seven and preserves the original task and history.

Load this standalone component by profile HMR with its two source dependencies, `vast/completion-guard.mjs` and `workspace/http.mjs`. Trusted configuration accepts absolute `registryPath` and `journalRoot`, defaulting to `/data/harness/state/workbench/registry.json` and `/data/harness/state/incomplete-continuations`. A durable exclusive journal binds each session/terminal event to one request before one real SDK followup. Repeated requests only reconcile actual history/inbox evidence; an unknown acknowledgement never causes a resend. Recovery is bounded to 12 seconds plus up to one second of cleanup. Failed queue withdrawal cannot admit its internal message into budgeting or inference; after component reload, pending messages from the previous instance also fail closed. New genuine human input takes priority and retains the ordinary admission rules. A queued receipt proves insertion, not completion of the requested application.

`vast/continue-incomplete-sdk.test.mjs` uses the actual pinned SDK with an inert model and production budgeting functions. Its regressions cover unchanged original history/counters, one dispatch, cancellation, failed withdrawal, new human input, hung persistence, and a late accepted-journal rename across timeout and component reload. Run with `EFFICIENCY_SDK_ROOT` pointing at the pinned runtime's `node_modules`: `node --test vast/continue-incomplete-sdk.test.mjs`. These local tests make no model or network calls.

The dated benchmark in benchmarks/disposable-20261114 records three passing CSV runs (75–112 seconds, versus one 334-second reference), smaller tasks, the failed initial game and the bounded repair attempt. It is historical evidence with fixed deadlines, not an unattended installer. Its report includes all-in trial cost estimates and deletion confirmation. Offer RAM and instance-detail host RAM used different scales in this measurement; do not multiply the reported offer RAM by gpu_frac again. Validate the actual allocation.



### Isolated projects and runtime verification

The [project workbench](docs/workspace-runtime.md) adds automatic native Git
worktrees/fresh projects, per-project ports/database paths, conflict leases,
Workspace files operations, workspace model defaults, reversible conversation
Trash and enforced repair/stage limits. Open More → Projects and files or
Ctrl+Alt+P. The custom panel/shell support EN/CZ. Browser and optional .NET
runtimes are prepared once and checked locally at startup.

Recorded validation: 13 real native integration checks, 119 Linux Node regressions plus six additional capacity/wake/maintenance regressions,
32 Python regressions, real Chromium screenshots/console/WebGL and a .NET
compile/run. Six real model probes verified Off versus Low/Medium wire settings
and actual reasoning blocks; all six small code-analysis answers were correct.
Cache warmth differed, so these are functional probes rather than a model
quality ranking. See deployments/workspace-20261114/ for sanitized evidence.

Whole-stack installation simplification is [design only](docs/installation-design.md).

Cold-cycle history: an earlier automatic stop was followed by unavailable GPU
capacity. After capacity recovered, HomeAI reported the completed Apps v2
milestone passing a41.7-second worker sleep and154.4-second wake, preserving
the Compose database and containers. A later wake again encountered capacity
unavailability. The deployed Worker correctly reports HTTP202 for that state,
retries only the original instance and preserves authenticated conditional
status reads. The three earlier pending bootstrap files were verified deployed.
See the [dated integration evidence](deployments/release-polling-20261114/status.json)
and [general tool verification](deployments/general-tool-recovery-20261115/public-summary.json).
For a server's active revision, inspect `state.update.appliedCommit` in the
owner-only Workbench API and its service health. Test evidence and a published
Git commit do not establish activation on a particular server. Cold-cycle
success does not guarantee that the provider can reallocate the GPU on every wake.
