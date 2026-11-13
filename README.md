# Harness Cloud Sleep

Run DeepSeek Harness, Strata and a local model together on one stoppable Vast.ai instance. Wake it from a free Cloudflare Worker, connect privately through Tailscale and receive iOS Web Push when work finishes.

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

This package does **not** download model weights or install Strata. First provide a tested `/data/start-strata.sh` that serves Strata on `127.0.0.1:8080`. Model files must already fit the persistent disk and available RAM/VRAM. The deployed reference uses a Qwen3.8 Flash Next IQ2_XS build; exact model availability and Strata compatibility are separate from this controller.

1. Copy this repository to `/data/harness/app`, then run `bash /data/harness/app/vast/install.sh` as root. The script verifies the official Node tarball checksum and pins Harness and Web Push versions.
2. Install Tailscale from its official Ubuntu repository. Start `tailscaled` with **both** `--state=/data/harness/root-secrets/tailscaled.state` and `--statedir=/data/harness/root-secrets/tailscale`, plus `--tun=userspace-networking --socket=/data/harness/tailscaled.sock`. Authenticate the server in your personal tailnet. Preserve its state and certificate directory across stops.
3. Copy `vast/config.example.json` to `/data/harness/config.json` and `vast/push-config.example.json` to `/data/harness/push-config.json`. Use the real Tailscale hostname and your Worker URL.
4. Copy `vast/provider.patch.example.yml` to `/data/harness/home/.dsh/profiles/web/cordis.patch.yml`. Create the parent directory if needed. The supervisor provides `STRATA_GATEWAY_KEY=local-strata`; this is a local adapter placeholder, not a Vast credential. The adapter binds only to loopback.
5. Copy `vast/guard.example.json` to `/data/harness/root-secrets/guard.json`, enter the existing instance ID and leave `enabled:false` during validation. Put your scoped Vast token in `/data/harness/root-secrets/vast-api.key`. Keep the directory mode 0700 and files 0600, root-owned.
6. For a migration, copy the existing VAPID keys and subscription store to `/data/harness/secrets/`; otherwise the push service generates new keys. Make this directory 0700 and its files 0600, owned by `harness`. Never regenerate VAPID keys on every boot.
7. Preserve the existing `/root/onstart.sh` and append `nohup bash /data/harness/app/vast/start.sh > /data/harness/logs/supervisor.log 2>&1 < /dev/null &`. Start it once manually. The flock prevents duplicate supervisors. No package installs or model downloads run on normal boots.
8. Set up private HTTPS: `tailscale --socket=/data/harness/tailscaled.sock serve --bg http://127.0.0.1:3081`.
9. Run `python /data/harness/app/vast/admin.py paircode` using the virtual environment to obtain a private, single-use ten-minute code. Open `https://YOUR-HOST/phone/` from the iPhone with Tailscale enabled and enter the code. Add it to the Home Screen and enable notifications in the sidebar's bottom **More → Oznámení na iPhonu** menu. Browser authentication survives restarts for its cookie lifetime.
10. Verify a real task, push and a stop/start cycle, then set `enabled:true` in the root guard file. Do not leave an older controller with its own shorter idle timer active.

Supervisor paths are intentional and fixed to `/data/harness`; change them together if adapting the layout. Linux containers do not require systemd or a privileged TUN device.

## Deploy the wake Worker

Use current Node 24 and install the official `wrangler` CLI. Copy `cloudflare/wrangler.example.jsonc` to `cloudflare/wrangler.jsonc`; fill in the instance ID and private Harness URL. Register a workers.dev subdomain in your Cloudflare account if it has none. Authenticate Wrangler with Workers Scripts permissions and provide `CLOUDFLARE_ACCOUNT_ID` if account discovery is unavailable.

```sh
wrangler deploy --config cloudflare/wrangler.jsonc
wrangler secret put VAST_API_KEY --config cloudflare/wrangler.jsonc
wrangler secret put WAKE_ACCESS_KEY --config cloudflare/wrangler.jsonc
```

Use a scoped Vast key and at least 32 random bytes encoded as hex for `WAKE_ACCESS_KEY`. Keep both out of Git. The optional setup link is `https://YOUR-WORKER/#setup=YOUR_WAKE_KEY`; its fragment is cleared immediately and the key is exchanged in a same-origin POST. Treat any setup QR/link as a private credential. Normal use stores a signed 30-day cookie. Rotating `WAKE_ACCESS_KEY` invalidates existing wake cookies.

The page polls Vast only while visible; checking status never starts the GPU. Waking is idempotent for an already-started instance. Opening the private Harness remains a user navigation so the page does not require browser private-network permissions.

## Sleep rules and maintenance

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
