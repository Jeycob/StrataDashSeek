# Request budget and measurement

Reviewed 2026-11-15. The Worker changes are merged into `main` and deployed to
the existing Worker. The running private server also serves the signed monitor,
phone bootstrap and Service Worker sources; all three actual HTTP responses
were compared with the active signed release. Existing open browsers must load
the updated files. The earlier pending-server status in
`deployments/release-polling-20261114/status.json` describes that dated release;
see [current runtime evidence](../deployments/startup-runtime-live-20261115/status.json).

## What the graph proves

The supplied 24-hour Worker graph totals approximately1590 invocations across
the displayed versions. It does not identify paths, authenticated callers or
Vast subrequests. The repeated roughly one-per-minute activity cannot be
attributed retrospectively: the inspected deployment configuration has no Cron
triggers and observability is disabled. Do not attribute it to billing: the
collector calls Vast directly and does not invoke the Worker.

Cloudflare documents100000 incoming requests/day for Workers Free, resetting at
midnight UTC, and50 subrequests per invocation.1590 is1.59% of that daily quota;
this screenshot does not demonstrate a quota failure. The quotas apply to the
account, so other Workers also matter. See [official limits](https://developers.cloudflare.com/workers/platform/limits/)
and [metrics definitions](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).

The [official Vast API schema](https://github.com/vast-ai/docs/blob/main/api-reference/openapi.yaml)
documents429 for instance reads and state changes, with examples of threshold2.0
and1.0 respectively. It does not establish the unit, burst policy or a universal
account quota in these entries. These numbers are not treated as a guaranteed
requests-per-second allowance. Respect actual429 and Retry-After; do not retry
through another key or endpoint.

## Sources and policy

| Source | Before | Prepared behavior |
| --- | --- | --- |
| Wake portal | Status delay grows to5s; capacity retry15s;6-minute bound | Status2s then grows to15s, jitter; same6-minute bound; hidden tab pauses; honors Retry-After |
| Private mobile bootstrap | Wake plus local health; capacity15s | One in-flight preparation; health delay grows from0.8s to5s with jitter;6-minute bound; hidden client stops; capacity wake retry15s; Worker deduplicates |
| Desktop opener | Status every2s for at most240s | Unchanged client; Worker shares reads while preserving SSH metadata |
| Visible monitor | Every3s even when idle/unavailable | Busy3s, idle15s, failures15/30/60s, jitter; closed/hidden means no requests |
| Billing collector | Direct Vast read every60s while server runs | Unchanged; up to1440 reads/day at continuous uptime |
| Idle guard | One direct stop transition when idle | Unchanged; monitor/status reads never count as activity |
| Benchmark expiry | Scheduled only with explicit fixed configuration | Unchanged; no Cron trigger was found in the inspected production config |

One open idle monitor falls from1200 to at most240 requests/hour, an80% reduction.
An active visible monitor retains the3-second sampling cadence. These requests
go to the private server, not through the wake Worker or Vast API.

For a six-minute portal wait without network latency, jitter or capacity writes,
the old delay schedule allows approximately77 status calls including its initial
authentication check; the new schedule allows approximately28. This is a
calculated scenario, not a measured production reduction. Capacity retries add
requests, and each browser still counts as a separate incoming Worker caller.

The Worker shares in-flight reads and retains state for5s when running or15s
otherwise. An explicit wake rechecks state if the retained read is older than2s;
successful or capacity-queued wake results are shared for15s. Writes invalidate
retained state. Provider failures start a cooldown; a provider Retry-After is
preserved. Authenticated conditional status requests may receive304. They still
count as Worker invocations:304 saves response bytes, not invocation quota.

All sharing is best-effort inside one Worker isolate and environment object.
Different isolates/regions, direct Vast callers and restarts do not share a
lock or quota. This is not an account-wide rate limiter. No paid state service
or credential-bearing shared HTTP cache is introduced. Authentication runs
before cache lookup and before304; status and metrics never issue PUT.

## Evidence and follow-up

Deterministic provider tests:100 overlapping status calls produce one upstream
GET;100 rapid repeat capacity wakes reuse one transition; a75-second provider
cooldown blocks repeated reads and wake attempts. Real Chromium tests verify
conditional status, one wake after visibility resumes, idle/busy monitor timing
and no polling while hidden or closed.

The bounded live check observed two status requests, one upstream GET, one
cache hit, zero state-changing writes and a conditional304. A separate explicit
wake of the configured original instance returned202/CAPACITY_UNAVAILABLE with
Retry-After15. Unauthorized and foreign-origin requests were denied. Cloudflare
compression changes the response validator to a weak ETag; the Worker accepts
weak and list-form If-None-Match validators. These observations prove this
bounded scenario, not a daily or globally shared reduction.

For follow-up, use the existing authenticated session to read
`/api/request-metrics` once before and after a bounded scenario. Counters separate
incoming status/wake requests, upstream reads/writes, cache hits and joins.
They are explicitly scoped to the current isolate and can reset or land on a
different isolate; they are not durable account totals. The endpoint performs
no provider call. Do not put a credential in a query string or start polling
this diagnostic endpoint. `/api/status` also reports its source in
`X-Harness-Status-Source` (`provider` or `cache`). For historical path attribution,
enable a bounded, approved aggregate observation window rather than inferring
the source from this graph.
