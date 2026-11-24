# Basalt engine admission

Set `BASALT_IDLE_ENGINE=1` for `engine.sh serve` during an idle restart. The pinned v0.5.7 Python server serves the usual loopback port 8080 with the same model, vision, GPU and context arguments. Its HTTP request handler wraps every POST before it reads the body or queues the work. Each request increments the revision at entry and exit. Active includes callers waiting for a slot and streamed responses through the stock disconnect and completion handling. The native GET routes, including health, model discovery and Prometheus metrics, remain available during a drain.

The unprivileged server requires the existing 0700 service-owned `/run/basalt-pairing` directory. Its `idle-engine.sock` Unix socket is 0600. Each connection carries one newline-terminated JSON object of up to 1,024 bytes and one JSON reply. Linux peer credentials restrict commands and lease readback to UID 0. The control endpoint starts reporting a usable state only after this process has bound its HTTP listener.

| Command | Result |
| --- | --- |
| `{"op":"status"}` | `ok, epoch, revision, active, drained, lease`. The lease is null when admission is open. |
| `{"op":"drain","epoch":"…","revision":12,"lease":"…"}` | The current epoch, exact revision and zero active requests are checked under the admission lock. A successful reply reports a closed gate. A matching repeated request is safe. |
| `{"op":"reopen","epoch":"…","lease":"…"}` | The matching holder reopens admission after reconciliation. |

Use a fresh UUID as the lease and retain it in the supervisor's private record. On a daemon restart in the same boot, the private drain record keeps POST admission closed and the epoch changes. The supervisor must reconcile a previously submitted stop before reopening. The root supervisor also needs its own durable provider-attempt journal across full instance stops and starts.

For a whole-instance stop, sample the gate's epoch and revision throughout the five-minute window. Verify the control peer PID and UID, the process start time, and ownership of the HTTP listener against the supervised engine. Acquire its drain at the observed revision alongside the Native fence. Immediately before submitting a stop, read back the same process generation, lease, closed state, unchanged revision and zero active requests. Recheck Native work, model health, and engine running and waiting gauges. Missing or inconsistent observations leave the instance running.
