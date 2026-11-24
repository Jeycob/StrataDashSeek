# Run the Andorra idle supervisor

Install `idle-supervisor.mjs`, `idle-supervisor-host.py` and `idle-guard.mjs` together in the root-owned `/usr/local/libexec/homeai-basalt`. Install `native-idle-bridge.py` there as well, and a byte-identical regular copy of the active release's `idle-engine.py` for identity verification. Use root:root ownership, mode 0644 or 0755, and a root-controlled parent directory. Use the pinned Node 24 and Linux system Python 3.

Configure both admission services first. The Native bridge listens at `/run/basalt-lab-control/native-idle.sock` as root. The engine listens at `/run/basalt-pairing/idle-engine.sock` as `basaltlab` and serves port 8080 itself. The supervisor verifies both kernel peers, service paths, process start ticks and ownership of the listening ports. The engine script must resolve under `/workspace/homeai-basalt/releases/<40-hex-commit>/experiments/basalt-inkling/`. Keep the installed Native bridge and engine argument vectors documented by their launchers.

The root cold-boot service starts the following command after both admission services. Use a clean service environment and supervise this one process. The private journal lock permits a single active supervisor.

```sh
node /usr/local/libexec/homeai-basalt/idle-supervisor.mjs
```

The activation directory is `/etc/basalt-idle`, owned by root:root with mode 0700. Hold maintenance during deployment or qualification by creating `/etc/basalt-idle/maintenance`. After acceptance, the owner enables the policy by placing the exact decimal ID `62357205` (optionally with one trailing newline) in the root:root regular mode-0600 file `/etc/basalt-idle/enabled` and removing maintenance. A disabled policy makes no Vast API requests. To pause before another maintenance operation, restore the maintenance file and confirm the supervisor has reported `disabled` before working on the instance. An already submitted provider transition still needs reconciliation.

Every five seconds the supervisor samples both gates, model readiness and Basalt metrics. Five consecutive idle minutes for the same kernel boot, PID 1 start ticks, service incarnations and activity counters permit one freeze attempt. A durable intent precedes the Native freeze and engine drain. The supervisor compares both leases, identities, counters and workloads again, reads the exact Vast rental and requires it to be running, then persists the stop attempt before sending the single PUT. Provider access uses the instance's root-owned `/root/.vast_api_key` inside mode-0700 `/root`. The secret remains inside the short-lived privileged helper.

## Reconcile an interrupted stop

Preserve the root:root mode-0700 `/var/lib/basalt-idle` on the instance disk. Its private journal contains the lease, phase, instance identity and submission time. Do not copy it to public evidence. A crash before submission reopens the engine first and then Native. After a possible PUT, reconciliation only reads the fixed provider endpoint. A specific refusal plus a confirmed `running/running` state resumes both services and retires the attempt for the current container incarnation. A confirmed stopped intention keeps both fences closed. A new container incarnation reconciles and archives the old attempt before starting a new five-minute observation window.

For an ambiguous response followed by `running/running`, routine reconciliation keeps both fences closed because the provider may still apply a queued transition. After the owner confirms that the provider has cleared the transition, stop only the idle-supervisor daemon, keep the policy enabled, and run:

```sh
node /usr/local/libexec/homeai-basalt/idle-supervisor.mjs --resolve-running
```

This operation needs the same exclusive journal lock. It requires a fresh provider read showing `running/running`, reopens both gates and blocks another stop for this incarnation. Restart the supervisor after it prints `retired`. If a control peer, generation or provider response cannot be verified, keep the private journal and restore or inspect the relevant service before repeating reconciliation.
