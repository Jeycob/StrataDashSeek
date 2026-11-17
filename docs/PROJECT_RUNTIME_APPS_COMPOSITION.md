# Apps execution composition

This source unit builds on `f2ab363854ecf868b56a1a779fec9dabe6b825fd`.
It integrates the prepared N03/N04 resource, log and typed project-runtime
modules with the current Apps controller and VM. It does not publish execution
policy, start a worker or establish deployment acceptance.

## Trusted bindings and production callsites

```js
new AppsManager(config, engine, worker, executionBinding);
new DockerVM(config, engine, executionBinding);
createAppsService(config); // Real entrypoint binds independently before construction.
installDockerCleanup(ctx, manager, appsConfig, callApps, manager.execution);
```

The first two constructors require a trusted binding as a separate argument.
Missing/malformed bindings fail before controller state initialization. Tests
use the explicit helpers in `vast/fixtures/execution-binding.cjs`; production
must never import these fixtures. `bindAppsExecution` accepts the root service
shape `{snapshot, assertUnchanged}`, validates it, captures its identity and
does not reject additional trusted service methods.

The real Apps entrypoint calls `bindAppsProcess`. It derives its source SHA
from its own canonical protected `/data/harness/releases/<sha>/vast` directory,
rejects a symlink/alternate path, and binds the protected public projection to
that SHA and inherited `HARNESS_PROJECT_EXECUTION_LAUNCH_ID`. The trusted root
supervisor must verify the signed release before publishing that projection
and launching Apps. Apps does not read the root-private policy, and neither
Apps config, browser/model input nor `enabled`/`available` can select a mode.

`createAppsService(config, injectedManager, {executionMode, admission})` supports
explicit trusted synthetic composition. It uses an injected manager's checked
binding when no third-argument binding is given. There is no implicit host
default for either production or fixtures.

Root must wire `workspace/plugin.mjs` to its trusted `ctx.projectExecutionMode`
service for the manager/capability constructors described in
`PROJECT_EXECUTION_COMPOSITION.md`. The existing four-argument
`installDockerCleanup` call then uses `manager.execution`; the optional fifth
argument is for explicit trusted composition. The supervisor launch must
inherit the root launch ID into the Apps process. The operator-only helpers
`deployments/apps-real-worker-check.cjs` and
`deployments/docker-worker-provision-check.cjs` still need explicit trusted
bindings before use; they deliberately fail construction without one.

## Mode behavior and asynchronous boundaries

Host composition retains generic Apps registration, builds, deployments,
resources, cleanup, worker power and controller availability semantics. It
does not export project directories or create project-runtime authority.
`ensure`, `execute`, `touch`, descriptor exports, guest forwarding, preparation
and runtime grants require the independently bound isolated composition.

New effects recheck the captured binding at controller queues, worker/engine
admission, descriptor/export preparation, resource locks and census results,
managed-create policy observations, durable start intent and archive capacity
waits. Workspace runtime authority rechecks after registry/manager waits and
filesystem observations before publishing its short-lived token. Existing
host/legacy/native-worktree/shared-Git records cannot obtain that authority.

Closing new-work admission still permits exact owned settlement. An
authenticated `/project-runtime` stop exception accepts only the four fields
`op`, `sessionId`, `generation`, `stopToken` in their validated formats. The
runtime then checks the retained capability and container/journal identities;
it cannot wake, create or renew work. Wrong capabilities, extra fields and
new operations remain refused. Stop intent tombstones remain durable even
when admission is delayed, and uncertain create/start results retain a
reconciliation fence. Background monitors can finish logs and stop their own
retained containers after admission closes. Resource deletion has no broad
equivalent bypass.

## VM and resource compatibility

The current VM's fresh capacity checks remain at ensure/start/pre-spawn/status,
including resident manifest SHA changes, v1/v2 storage profiles and growth,
storage-scoped freshness and the heartbeat's explicit `enabled` field. The
guest's cgroup-v2 bootstrap proof is versioned separately. Host worker
management remains available without project exports. Owned shutdown still
requires the existing VM and container identities; ephemeral project roles
are not added to saved resume containers.

N03/N04 reuse the existing version-1 inventory contract: protected reasons,
freshness, bounded pagination and typed resource references. Existing Apps
`state.enabled`/`available` remain availability, not mode authorization. No
additional UI-facing mode DTO is introduced. Executor job output adds bounded
separate stdout/stderr through the existing job/log routes.

Descriptor-bound exports, mTLS identities, fixed forwarding and egress
preparation use the prepared project modules. Toolchain-enabled exports also
need the separately reviewed pinned toolchain validator/build/lock/unpack
source group restored by Root as `39a7c03`; that group is intentionally not
copied into this bounded Apps unit. Guest artifacts, runtime configuration,
root plugin integration and the stable rollback/recovery floor remain Root
requirements before any activation.

## Verification limits

The unit's local Linux Node24 fixtures use synthetic engines, temporary
SQLite/Git state and loopback HTTP servers. They exercise both modes, stale
bindings, exact stop settlement and the existing VM/capacity/profile/disabled/
telemetry regressions. These results do not demonstrate real QEMU, Docker,
guest kernel, editor transport, egress, storage allocation or deployment
acceptance. No real VM/container, live service, policy/config, Native bundle,
CI inventory or backup/T10 data is changed by this unit.
