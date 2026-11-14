# Application builds and containers

This optional service builds an existing workspace project, starts its immutable Docker image, records an HTTP readiness check, and can run the project's own tests against the deployed application. The phone UI adds **Account menu → Aplikace a kontejnery** with build/deploy/check actions, container status, start/stop controls and logs. **Account menu → Nastavení Harnessu → Nastavení aplikací a Dockeru** opens the private-preview settings. The normal Harness chat remains the coding and browser-testing interface.

The service is **disabled until a Docker worker is explicitly configured**. Shipping the UI does not create a VM, rent another instance, enable a host Docker socket or expose a daemon.

## Worker connection

Copy `vast/apps-config.example.json` to `/data/harness/apps-config.json`. A Docker daemon must be reachable through a dedicated local socket or a loopback-only connection (`127.0.0.1:19075` by default). Use a separate worker or an authenticated SSH tunnel for another machine. Do not publish an unauthenticated Docker API on an external address and do not connect the service to the Vast provider's host Docker daemon.

On the measured Vast container, user/mount namespaces are denied even for root, and `/dev/kvm`, `/dev/fuse` and the host Docker socket are absent. Rootless Docker therefore cannot simply be installed there. An explicitly approved QEMU/TCG test booted Alpine as the unprivileged `harness` user, built a real image, ran a real container, and returned its expected HTTP content through a loopback port. It used one emulated vCPU, 2 GiB RAM and under 1 GiB test data. The VM was powered off after the test. **This is a capability proof, not a persistent Docker deployment.**

`deployments/docker-vm-poc.cjs` downloads the official checksummed Alpine virtual ISO and extracts its boot files. Its run mode has a fifteen-minute hard timeout and no persistent guest disk. It is intentionally not a production VM installer. QEMU was separately installed from Ubuntu packages with the owner's explicit approval. Larger builds need a storage and performance plan; only about 6 GiB was free on that instance.

Set `publishAddress` for the Docker worker, `checkHost` for the address reachable from the Harness service, and `applicationHost` for the address reachable from your browser. Published ports come from a fixed pool, 18080–18087 by default. For a remote worker, these values may differ. A QEMU worker would need explicit forwarding of this port pool and its private Docker API port. Serve application previews on a different hostname from Harness, with no shared authentication cookies. Merely changing the port does not prevent cookies from being sent to an application on the Harness hostname. No application proxy or public port exposure is created by this feature.

After configuring the worker, enable the service and restart the **application service and phone/push service** at a maintenance boundary. A full supervisor restart would also restart Harness and Strata and is not needed for a static UI rollout. The supervisor now knows how to start `vast/apps-service.cjs` on ordinary future boots. Do not start a second supervisor.

## Managed VM and power policy

`deployments/prepare-docker-worker.cjs` prepares the explicitly approved persistent pilot: one emulated vCPU, 2 GiB RAM and one fully preallocated 3 GiB raw disk. It requires at least 5.5 GiB host free space before creation; the worker/build checks preserve a 2 GiB host reserve. It refuses to replace an existing worker directory. Boot artifacts reuse the checksummed Alpine ISO from the capability test. The VM runs as `harness`, without KVM or host Docker privileges. Enable `vm.enabled` in the private configuration only after this preparation.

Docker starts on demand for build/deploy/check, explicit start, or a preview request. Listing projects, logs and status does not wake the VM or renew the instance's idle timer. Remembered running application containers restart from their existing IDs after a VM wake; explicitly stopped containers remain stopped. Docker images, writable layers and package cache live on the 3 GiB disk. Initialized disks are never automatically reformatted. Offline package restoration uses a complete package cache; an explicit owner repair is available through `docker-worker-provision-check.cjs repair-cache` if this cache needs attention.

The VM may nap after ten minutes of inactivity while the rest of Harness is in use. Whole-instance sleep remains five minutes after the last actual work. Before the idle guard requests Vast stop, Apps enters a short drain, stops managed containers, terminates Docker, flushes the filesystem and powers off the guest. The guard then checks agent/model/workspace activity and a fresh sleep token again. New app work during this transition is rejected for retry and invalidates the pending stop. Failure to save the VM cancels automatic instance sleep. Structured guard records include UTC timestamps and the reason for stop/cancellation.

Active builds, deployments, tests, preview HTTP/WebSocket connections and an explicit awake lease protect work. The UI offers a fifteen-minute awake lease and early release; the API caps leases at sixty minutes. Status polling never extends it. Background app polling counts as preview traffic; an open WebSocket remains active until it closes. A merely running container with no requests does not keep the GPU instance awake.

## Private preview settings

The approved pilot exposes ports **18080–18087 only within the existing Tailscale network and its existing access rules**. No Funnel or public listener is created. Tailscale TCP forwards each approved port to a loopback preview proxy on 18180–18187. The proxy rejects the Harness DNS hostname before forwarding any headers; links use the separate Tailscale IP address, preventing Harness authentication cookies from reaching generated applications.

The Harness settings include an on/off switch, the fixed port range and the audience. The unprivileged Apps service submits only `{id, enabled}` to a bounded request file. The root idle guard's `preview_settings.py` reconciler can run only fixed Tailscale commands for those eight ports; browser input cannot choose commands, recipients, ports or ACLs. Turning previews off preserves the main Harness route and local build/test capability. The setting survives instance restarts. Owner confirmation for this exposure was obtained separately from the VM installation approval.

For bookmarks that should wake a sleeping Vast instance, use the existing wake portal with `?appPort=18080`. The portal validates the fixed private address and port pool, wakes the configured instance, then opens the preview; the preview proxy demand-starts Docker. A direct application IP bookmark cannot wake a stopped Vast host. The local phone shell keeps the wake bootstrap cached offline and refreshes UI code when the server is available.

The application service listens only on loopback port 3093 and creates a private key under `/data/harness/secrets`. Browser calls pass through the existing Harness cookie and Origin checks; the key never goes to the browser. Read-only container enumeration is restricted to the service's labels. The service never offers arbitrary Docker commands, privileged containers, host binds, GPU access or host networking.

## Project contract

Put a `Dockerfile` and `.harness-app.json` in a project directory **beneath** `/data/harness/workspaces`:

```json
{
  "version": 1,
  "name": "My application",
  "dockerfile": "Dockerfile",
  "port": 3000,
  "healthPath": "/health",
  "memoryMiB": 512,
  "cpus": 1,
  "testCommand": ["node", "scripts/deployed-smoke.mjs"]
}
```

The Dockerfile defines the complete build, including compilation of an existing source tree. The application must listen on `0.0.0.0` inside its container. Bake any runtime/test files into the image; no host source directory is mounted. Prefer a non-root image user and pin the base image digest for reproducible comparisons. The included `examples/docker-demo` is a minimal example.

The build creates a separate source snapshot (128 MiB and 12,000 files by default), excludes common credential files, VCS metadata and dependency caches, and rejects symlinks. Additional secrets under arbitrary names are still the project owner's responsibility. This version does not implement the Docker CLI's full client-side `.dockerignore` filtering; do not rely on that file alone to exclude private material from the uploaded archive. The snapshot hash, image ID and build log are recorded; deployment uses that immutable image and its captured manifest even if working files subsequently change.

Project image tags and stopped application containers are retained. There is no global prune or automatic data deletion. The current version provides ephemeral preview containers, not managed databases or persistent application volumes. Copy required data out before removing containers using your worker administration tools. Monitor the worker disk and clean up only its dedicated test resources.

The default application cap is 512 MiB/one CPU; manifests may request 64–2048 MiB and 0.1–2 CPUs. These are requests to Docker, whose kernel must support the relevant cgroups. In the capability test Docker warned that swap limits were unavailable; the outer VM's 2 GiB bound still applied. Do not treat these requests as measurements of successful kernel enforcement.

## Agent interface

The agent can use its existing terminal tool without installing a Docker CLI on the Harness server:

```sh
node /data/harness/app/vast/apps-cli.cjs register default-workspace/my-project
node /data/harness/app/vast/apps-cli.cjs build PROJECT_ID
node /data/harness/app/vast/apps-cli.cjs state
node /data/harness/app/vast/apps-cli.cjs job-log JOB_ID
node /data/harness/app/vast/apps-cli.cjs deploy PROJECT_ID
node /data/harness/app/vast/apps-cli.cjs check PROJECT_ID
```

Build, deploy and check return a job ID. Poll the job state to completion; accepting a job is not passing it. A candidate deployment must pass HTTP readiness before the previous deployment is stopped. A failed candidate leaves the previous container alone. The old container is retained. Long builds/tests hold the idle guard through an immediate activity record and periodic heartbeat; reading the panel does not count as application activity.

Without `testCommand`, check reports **HTTP only**, never a complete application test. With it, a separate bounded test container starts from the exact deployed image, shares only the deployed application's network namespace, and receives `BASE_URL=http://127.0.0.1:PORT`. Its exit code and logs are recorded. The test container is stopped/removed after completion or the sixty-second timeout, leaving the application running. Use actual assertions and then test the UI with the available browser tools. No screenshot is invented and no HTTP result certifies visual quality.

## Validation

```sh
node --test vast/apps.test.cjs mobile/notifications.test.cjs
python3 vast/test-idle-guard.py
```

The automated tests use fixture Docker responses; they do not replace a real worker test. On 2026-11-14, `deployments/apps-real-worker-check.cjs` also exercised this exact manager against real Docker 29.9.3 in the bounded QEMU VM on Vast instance 60637500. The included BusyBox example built in 12.287 seconds, deployed with HTTP readiness in 5.058 seconds, and passed its separate test container in 3.659 seconds. Its content was checked independently through the forwarded application port, and stopping the application was confirmed. The test command exited zero. These are small capability-test timings, not a benchmark of a full application build.

The broad Node verification passed 61 tests, and the idle-guard suite passed 20 tests. Desktop/mobile UI checks used explicitly labelled sample data and checked the API action payload; they were not a live UI-to-Docker deployment. Full persistent worker rollout and end-to-end UI-to-Docker validation must be recorded separately before claiming production deployment. After the test, Vast reported instance 60637500 as stopped; it was not restarted for additional inspection.
