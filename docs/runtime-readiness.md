# Runtime readiness

`GET /phone/health` returns an uncached version1 status object. A reachable
service returns HTTP200 while starting or failed too: its `phase` and readiness
flags carry that distinction. Reading status never wakes the GPU or Docker,
submits a model turn, or changes a rental.

`sourceReady` requires the protected root-owned signed update report.
`runtimeReady` additionally requires a fresh supervisor heartbeat for the same
commit and an authenticated functional response from `/api/workbench/health`
in that exact release. A PID, an open port or a login HTTP401 is insufficient.
`modelReady` comes independently from the model's read-only `/health` endpoint.
`ready` is the conjunction of all three. Model loading can therefore leave the
Native interface usable. Open its iframe only when source and runtime are ready.

The Native check uses the existing local launch record, reads at most64KiB,
checks its authority and retains its local authentication cookie only in memory.
The login and functional request share a1.5second deadline. Neither launch
tokens nor cookies enter the public response. Concurrent status readers share
one observation and a short cache. Root status inputs reject writable parents,
symlinks, hardlinks and untrusted file ownership. Model responses are bounded.

The supervisor persists a per-service restart budget and its remaining backoff
in protected private state. Delays grow from3to30seconds; after five automatic
restarts in five minutes, that service stops retrying and status reports
`SERVICE_RESTART_LIMIT`. Restarting the controller preserves the remaining
delay and budget for the same source generation. A reviewed new source
generation receives its own budget. Optional or externally managed services
that this controller does not launch do not hold readiness indefinitely.

This status describes the Harness workbench and its model. Application build,
browser tests, data migrations and Docker deployment readiness have their own
reports. The service lifecycle's `SERVICES_STARTED` observation is not evidence
that an application passed those checks. Signed source rollback requires its
own reviewed transition; this change does not implement automatic rollback.

Local checks include actual loopback HTTP requests, a deliberately unfinished
JSON response, stale/mismatched source reports and persisted crash budgets.
The explicit `mobile/runtime-readiness-native-check.cjs` gate runs the actual
pinned Native Host with the real workspace plugin and the same installed
worktree provider as production. Its source report is a synthetic fixture;
the privileged startup tests separately cover signature verification. The
fixture verifies anonymous401, authenticated functional200, exact release
identity and a usable runtime while its test model remains unloaded. It
performs no model generation. These checks do not represent live production
activation or a physical iOS migration.
