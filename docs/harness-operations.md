# Operate a cloud HomeAI instance

HomeAI runs Harness, the model adapter, Strata and project tools together on a Vast instance. Its persistent disk holds the model, chat history, project files and service identities. The phone reaches Harness through private Tailscale HTTPS. The separate Cloudflare Worker can wake the rental while the host is offline.

For an **existing installation**, start with [phone access](#pair-a-phone), [idle and maintenance](#idle-and-maintenance) or [local checks](#run-the-local-checks). For a **new installation**, complete the setup below on a host with a working Strata installation.

## Install the harness

1. **Check the model and storage.** [start-strata.sh](../vast/start-strata.sh) reuses the saved launch configuration on ordinary boots and serves the model on `127.0.0.1:8080`. Its provisioning fallback requests IQ3_S with 131072 context tokens, one slot, int8 KV, DFlash2, CPU vision and 1536 MiB of VRAM reserve. Allow about 83.6 GB for the reference weights, plus about 0.9 GB for vision, project data and free operating space. Verify the available disk before keeping another full model alongside it.
2. Copy the repository to `/data/harness/app` on the host and run `bash /data/harness/app/vast/install.sh` as root. The installer checks the Node tarball checksum, installs the pinned runtime and prepares the service user and directories. This release pins Node 24.21.0 and Harness 0.2.2-rc.2.
3. **Connect the host to your tailnet.** The installer uses the official Ubuntu Tailscale package. Start `tailscaled` with `--state=/data/harness/root-secrets/tailscaled.state`, `--statedir=/data/harness/root-secrets/tailscale`, `--tun=userspace-networking` and `--socket=/data/harness/tailscaled.sock`. Authenticate it to the intended tailnet and keep these paths on persistent storage.
4. Install [config.example.json](../vast/config.example.json) as `/data/harness/config.json` and [push-config.example.json](../vast/push-config.example.json) as `/data/harness/push-config.json`. Set the Tailscale hostname, Worker URL and paths for this instance. On a migration, keep the existing VAPID keys and subscription store under `/data/harness/secrets/`. For a fresh identity, the notification service can generate keys. The `harness` user owns this directory with mode 0700 and its secret files with mode 0600.
5. **Configure the model provider.** Create `/data/harness/home/.dsh/profiles/web/` if needed and install [provider.patch.example.yml](../vast/provider.patch.example.yml) as `cordis.patch.yml` for a new profile. While Harness is stopped, run `/data/harness/node/bin/node /data/harness/app/vast/prepare-homeai-profile.cjs`. It preserves existing cloud provider entries and YAML expression tags, configures the four shipped presets, disables model-generated titles and sets up whole-turn scheduling. The supervisor supplies `STRATA_GATEWAY_KEY=local-strata` to the loopback adapter.
6. Copy [guard.example.json](../vast/guard.example.json) to `/data/harness/root-secrets/guard.json`. Set the **existing instance ID**, keeping `enabled: false` for initial validation. Store the scoped Vast key in `/data/harness/root-secrets/vast-api.key`. Use root ownership, directory mode 0700 and file mode 0600. The guard switch controls idle shutdown. Startup signature verification is configured separately.
7. **Install the signed startup gate.** Preserve the contents of `/root/onstart.sh`. A first installation needs exactly one recognized launcher line for the installer to replace. Stage the following line in that file without running it:

   ```sh
   nohup bash /data/harness/app/vast/start.sh > /data/harness/logs/supervisor.log 2>&1 < /dev/null &
   ```

   Place the operator's independently verified **public** keyring at `/root/operator-public-signers.gpg`. Supply its full primary fingerprint and run the installer as root:

   ```sh
   /data/harness/node/bin/node /data/harness/app/vast/startup-install.cjs \
     /root/operator-public-signers.gpg FULL_PRIMARY_FINGERPRINT
   ```

   The installer switches the launcher to the protected bootstrap and preserves other onstart commands. Keep the private signing key off the target and keep `root-secrets/startup-update.json` enabled. Existing installations use the [signed startup maintenance](startup-updates.md) and [protected runtime migration](privileged-runtime-paths.md) procedures.
8. Start the installed bootstrap once and configure private HTTPS:

   ```sh
   nohup bash /data/harness/bootstrap/start.sh > /data/harness/root-secrets/runtime/logs/supervisor.log 2>&1 < /dev/null &
   tailscale --socket=/data/harness/tailscaled.sock serve --bg http://127.0.0.1:3081
   ```

   Check `/data/harness/runtime-status/startup-update.json` for `ready` and `signatureVerified: true`. The startup lock serializes supervisors. Ordinary boots reuse the installed packages, model and saved profile. Keep the private bridge and listeners bound to loopback and use Tailscale Serve with Funnel disabled.
9. Finish the Worker and phone setup below. Verify a real task, push delivery and a stop/start cycle with preserved state. Then enable automatic sleep in the root **idle guard** configuration. Retire any other controller with a competing idle timer.

## Deploy the wake Worker

Use Node 24 and the official `wrangler` CLI. For a new installation, copy [wrangler.example.jsonc](../cloudflare/wrangler.example.jsonc) to a private `cloudflare/wrangler.jsonc`. Set `INSTANCE_ID` and `HARNESS_URL` to the existing rental and its private `https://YOUR-HOST/phone/` address. Register a workers.dev subdomain if needed. Authenticate Wrangler for Workers Scripts and set `CLOUDFLARE_ACCOUNT_ID` if account discovery is unavailable.

Run from the repository root. Use Wrangler's prompts for secret values:

```sh
wrangler deploy --config cloudflare/wrangler.jsonc
wrangler secret put VAST_API_KEY --config cloudflare/wrangler.jsonc
wrangler secret put WAKE_ACCESS_KEY --config cloudflare/wrangler.jsonc
wrangler secret put DEVICE_SIGNING_KEY --config cloudflare/wrangler.jsonc
wrangler secret put DEVICE_ADMIN_KEY --config cloudflare/wrangler.jsonc
```

Use an instance-scoped Vast credential and independent random secrets. Generate at least 32 random bytes encoded as hex for the owner wake key. Device access uses the SQLite-backed `DEVICE_REGISTRY` Durable Object binding shown in the example. For an existing Worker, preserve its bindings and follow [device access migration](device-access-migration.md) for account limits, credential rotation and release order. Put the matching device admin key in the Harness service's private `wakeDeviceAdminKeyFile`.

The owner setup URL has the form `https://YOUR-WORKER/#setup=YOUR_WAKE_KEY`. Treat the link or QR code as a credential. The page clears the fragment, exchanges the key in a same-origin POST and sets a signed 30-day cookie. Rotating the owner key invalidates existing wake cookies. Device enrollment gives each paired phone its own revocable credential.

The wake page polls status while visible. A status read leaves the rental state alone. An authenticated wake targets the configured instance, including when it already runs. If Vast has assigned the GPU elsewhere, the private Harness will remain unavailable until capacity returns.

## Pair a phone

1. Enable Tailscale on the phone. On the running server, run `/data/harness/venv/bin/python /data/harness/app/vast/admin.py paircode` to issue a single-use code valid for ten minutes.
2. Open `https://YOUR-HOST/phone/` and pair the browser. For Web Push on iOS 16.4 or later, add the app to the Home Screen, open it there and enable notifications from **More → Oznámení na iPhonu**. Test actual delivery on a locked phone.
3. Open an existing chat and check its history. The phone shell can display Harness as soon as signed source and Native runtime are ready, while showing the model's separate loading state. See the [readiness flags](runtime-readiness.md).

The Service Worker caches the static phone shell for opening the app or resuming from the background. Authenticated history, API responses and login URLs stay out of the offline cache. Use the same-origin `/phone/` as the notification target. Optional `tailscaleAutoLoginUsers` entries must be exact user identities behind private Tailscale Serve. Other devices can pair by code.

**Desktop launcher.** [open-harness.cjs](../desktop/open-harness.cjs) takes a private JSON file with `wakeUrl`, **`keyFile`** for the owner wake key, `sshKeyFile` and `knownHostsFile`. Set `timeoutSeconds` to override the default 240 seconds and `sshExecutable` if needed. It wakes the configured instance, waits for full health, then reads the latest Native login URL over SSH. Open the returned URL without logging it. Keep the JSON and keys outside the repository.

**Moving devices or history.** Preserve VAPID keys and subscriptions. A changed public hostname creates a new browser origin, so pair and subscribe once on the new origin. After confirming delivery, mark the previous subscription with `retiredAt` in the private store and restart the notifier when idle. For a Windows-to-Linux history migration use [session-migration.py](../vast/session-migration.py) for path case, separators, project-directory encoding and the Zstd header frame. Check imported sessions with the Native persistence reader. Preserve the original archive when an event requires a different runtime or plugin.

## Idle and maintenance

Closing Safari leaves the running task active. By default the guard starts its five-minute countdown when observed work finishes. It checks live agent turns, model activity and its queue, workspace processes, Apps builds and tests, and maintenance holds. An unanswered approval can keep an open turn active. With `ignoreDetachedPreviews` enabled, recognized detached preview servers may sleep. Other workspace processes can continue to hold the rental. Browsing telemetry or reading the phone screen alone does not renew the timer.

Read `/data/harness/runtime-status/idle-status.json` for the current reason, `idleSeconds` and `idleTimeoutSeconds`. Inspect protected service logs in `/data/harness/root-secrets/runtime/logs/` if the model status is unknown or a lifecycle heartbeat is stale. The guard holds the rental in either case. A maintenance lease uses `/data/harness/state/maintenance.json` with `{"until": UNIX_SECONDS}`, where the number is the expiry time in seconds. The privileged reader consumes this as service-readable input. See the [runtime path ownership table](privileged-runtime-paths.md).

Stopping the instance preserves its disk and releases the live processes, model cache and GPU allocation. Subsequent GPU availability depends on the host. Keep a separate backup of project state. A source update, automatic stop and ordinary wake all target the existing rental.

**Monitoring and cost.** Open **More → Monitor serveru** for GPU, CPU, memory, disk and model rates. CPU is normalized to the container quota and I/O uses cgroup counters. GPU Wh and kWh are estimates integrated from sampled GPU power since the collector started. For cost, use the actual Vast contract: compute while running, storage while stopped, plus billed transfers and applicable taxes. The [request budget](request-budget.md) explains monitoring and billing traffic.

## Task budgets and recovery

**Set a limit for one request.** Expand **Task budget** next to the composer before sending. Elapsed time starts with the SDK acceptance receipt, or with the first runtime step if its timestamp is missing. Reported token usage is checked after each model response and can overshoot the limit. If exact usage becomes unavailable, a token-limited task stops with its recorded reason. Delivered previews leave the finished task's timer inactive.

When a limit is reached, the task keeps its files and checks. Internal continuations retain the allowance. Unfinished background work retains its original deadline and appears as **Earlier task** if a new request is already active. Its settlement leaves the newer request and allowance intact. An accepted human follow-up stays in the SDK inbox. Managed project/Bash jobs collect terminal results quietly. Other SDK producers such as terminal or workflow jobs can still emit their normal completion notifications after cancellation.

**Local model scheduling.** The HomeAI profile serializes local root tasks across tool gaps, inherits ownership for explicitly requested children and gates auxiliary model streams. It allows one tool at a time, at most one child and depth one. The shipped profile uses medium reasoning (4096), an output limit of 32768, compaction headroom 12288, summary and retained tail limits of 8192, and one overflow recovery. Summary generation turns reasoning off. Ordinary transient failures retry at most twice. An explicit HTTP 413 payload-size error is retained in history. The adapter's model-readiness wait accepts cancellation before inference. For scheduling and cache measurements see the [efficiency guide](../efficiency/README.md).

**Incomplete final answer.** The [completion guard](../vast/completion-guard.mjs) uses the SDK's `agent/turn-stopping` hook for `strata-vast`. A successful tool followed only by a short progress statement or a probe result plus a promise can steer the same turn up to twice. It classifies visible text even when reasoning blocks accompany it. Cancellation, new human input, tool errors, token-limit stops and explicit blockers keep their usual handling. [install-completion-guard.cjs](../vast/install-completion-guard.cjs) backs up the current profile before adding the plugin through HMR. New profiles pick it up through the profile preparer.

For an already ended progress-only turn, an authenticated owner can POST `{sessionId, requestId, expectedTurnEndSeq}` to `/api/homeai/continue-incomplete`. Reuse the **same request ID** on a retry. [continue-incomplete.mjs](../vast/continue-incomplete.mjs) checks the idle owner session, empty inbox, last successful tool, completed response and original task identity before continuing. Active jobs, terminals or children prevent admission. It preserves history, counters and the current workspace manager. A journal binds one session/terminal event to a single SDK follow-up. An ambiguous acknowledgement is reconciled with stored history or inbox evidence and cannot trigger a second dispatch.

The standalone component needs `vast/completion-guard.mjs` and `workspace/http.mjs` when loaded through profile HMR. Its trusted `registryPath` defaults to `/data/harness/state/workbench/registry.json`, and `journalRoot` defaults to `/data/harness/state/incomplete-continuations`. Recovery allows 12 seconds and up to one additional second for cleanup. A queue receipt confirms insertion. Check the original task's result separately.

## Run the local checks

From the repository root, with Node 24 and Linux Python 3 available, these unit tests use fixtures and require no provider credentials or paid model. For a new local checkout, install the pinned runtime dependencies once with `npm ci --prefix runtime`. To reuse an existing installation, set `HOMEAI_RUNTIME` to the absolute directory containing its installed `package.json` and `node_modules`. The notifications test imports the pinned `web-push` dependency.

```sh
node --test cloudflare/worker.test.mjs vast/lifecycle.test.mjs
node --test mobile/notifications.test.cjs
python3 -B vast/test-idle-guard.py
```

With `EFFICIENCY_SDK_ROOT` pointing to the pinned runtime's `node_modules`, run the completion and continuation tests against an inert model:

```sh
node --test vast/completion-guard-sdk.test.mjs vast/continue-incomplete-sdk.test.mjs
```

The optional [Linux smoke test](../vast/completion-guard-smoke.cjs) exercises an isolated Harness with a loopback model and needs its fixed loopback ports free. On a configured live host, `/data/harness/venv/bin/python /data/harness/app/vast/admin.py state` checks the local notification service. Use a real phone for cold wake, push delivery and return-to-chat checks. Inspect the owner's Workbench API field `state.update.appliedCommit` and service health to identify the revision actually running.

## Recorded deployments

These are dated observations. Check live capacity, configuration and pricing independently.

- The [budget migration result](../deployments/2026-11-14-budget-result.json) records the A4000/EPYC contract at USD 47.36 for 12 hours/day over 30 days including 96 GB storage, before tax and transfers. The previous rental was retired after its backup was verified. The report includes 65 checks and one CSV run of 217 seconds against the earlier 334-second reference.
- The [sanitized installed configuration](../deployments/2026-11-14-homeai-iq3/) and the [workspace validation](../deployments/workspace-20261114/) capture model settings, checksums, Native integration, Chromium/WebGL, .NET and model reasoning probes. Keep secrets and private backups outside Git when recording a new deployment.
- The [disposable benchmark report](../benchmarks/disposable-20261114/report.txt) includes three CSV runs at 75–112 seconds, smaller cases, the failed initial game and the bounded repair. Offer RAM and host RAM were reported on different scales. Validate the actual allocation and benchmark the same tasks before promoting a new host.
- The [cold-cycle record](../deployments/release-polling-20261114/status.json) and [tool verification](../deployments/general-tool-recovery-20261115/public-summary.json) capture provider-capacity waits and an Apps v2 guest sleep/wake with preserved Compose data. These records distinguish provider capacity, guest restart and application readiness.
