# Owned Docker resource cleanup

Source-only change: integration, signing and deployment belong to HomeAI. This
feature does not activate Docker, restore applications, start a VM or contact
Vast. The owner UI uses `/api/workbench/docker-cleanup`; the accompanying
`archived-docker-cleanup-contract.json` describes the version 1 DTOs.

Automatic cleanup defaults to enabled and persists in the Apps state directory
as `archived-docker-cleanup.json`. The official SDK archive event schedules work
after the durable archive write. Startup and a 60-second interval catch missed
events. Disabled or sleeping workers are deferred without wake/ensure. Periodic
inventory and previews preserve the Apps idle deadline and yield to an existing
sleep drain; their exclusion lease does not count as user activity. Automatic cleanup only selects verified resources whose owners are archived and unpinned.
Manual owner Settings may also select verified unused resources of idle,
unarchived chats. `eligible` describes manual selection; `automaticEligible`
adds the archive restriction. Unknown historical objects are retained.

## Deletion prerequisites

- Full daemon container/image census, matching count and stable container list.
- Managed project marker, canonical directory, current session header and
  authoritative Apps creation/build records. Labels alone never establish ownership.
- No active session/activity, shared owner, published generation, retained
  rollback, resume reference, pending build/deployment or uncertain data operation.
- Containers must be stopped and stateless with no non-tmpfs mounts. Persistent
  data and volumes are never deleted. Foreign-tagged images and parent images
  with descendants are retained.
- A fresh, expiring content-bound plan and server-held reservation of selected
  sessions. The browser cannot supply ownership or automatic-run authority.

All registry mutations serialize behind the cleanup transaction, as do managed
Apps operations. Selected sessions cannot begin a new agent/tool step while
reserved; unrelated sessions may continue. The coordinator uses the pinned
`@deepseek-ai/dsh-workspace` **0.2.2-rc.2 private `enqueueOperation` method**. An
SDK upgrade requires requalification; a missing method refuses installation.
The qualification test exercises the real installed SDK queue and its recovery
after a rejected mutation. This is a deliberate private API dependency.

Container deletion uses immutable IDs with `force=false&v=false`. Images follow
containers, after a fresh graph, with `force=false&noprune=true`. No prune or
volume DELETE exists. Every destructive request has an atomic durable intent
written first. Unknown response outcomes are retained as
`reconciliation_required`; later reconciliation only inspects identity/absence,
never repeats DELETE. Until resolved, registry mutations, selected owner runs
and managed Apps mutations remain fenced. A still-present uncertain object
requires operator investigation; the code deliberately cannot guess whether a
request is still in flight.

Plans expire after five minutes; mutation/references changed since preview
require a new preview. Cleanup rechecks each individual object, including the
image graph after containers. Missing saved resume IDs or unreadable control
metadata conservatively retain resources. This can reclaim zero bytes. Reported
image sizes are estimates and do not predict filesystem space recovered.

Before the first DELETE, the same atomic journal write binds `planId`,
`planHash` and the canonical selection to one operation ID. Consumed-plan
receipts survive new previews, later operations, expiry and restart; they are
not evicted. An identical apply retry returns the recorded state without
issuing Docker requests, while another hash/selection under that plan receives
`409 CLEANUP_PLAN_CONSUMED`. Deferred/uncertain receipts retain their known
partial results; an apply retry never schedules the remainder.

After a lost apply response, use `GET ?planId=<original-plan-id>` to recover
and read-only reconcile that specific receipt. `GET ?operationId=<id>` also
resolves the exact historical operation. Supplying both requires them to agree.
The controller checks selectors under the same serialization as reconciliation;
unknown receipts return `404 CLEANUP_OPERATION_NOT_FOUND`, never the latest
operation. Clients must verify echoed `operation.id`, `planId`, `planHash` and
`selection`. Legacy receipts have null plan binding fields and cannot be
retrospectively associated with a preview.

## Verification and integration

Run the new collector/coordinator tests and the existing Apps context, disabled,
temporary-cleanup, create-journal, deployment-guard and service-owner tests with
Node 24 and `HOMEAI_RUNTIME` pointing to the pinned runtime. Run
`workspace/docker-cleanup-sdk.test.mjs` with that same installed SDK. Fixtures
use private temporary metadata and simulated Docker responses; they never run
real Docker deletes or contact production.

Before activation, integrate the matching Settings UI, run the full repository
checks, verify the authenticated owner route on desktop and iOS, and perform an
explicit disposable-daemon acceptance test. Keep production asleep during source
integration. This source handoff does not claim those deployment checks passed.
