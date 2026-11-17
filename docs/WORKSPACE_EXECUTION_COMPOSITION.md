# Workspace execution composition

This source unit binds workspace composition to the root `projectExecutionMode`
service. It does not publish a policy, activate isolated mode, establish an
isolation/rollback enforcement floor, provision a guest, or accept isolation.
Root remains the deployment operator. No live backend, model, VM, Docker, editor
transport or browser acceptance was performed for this unit.

## Production call sites

`workspace/plugin.mjs` retains `sessionController` and declares `sessionQuery`
and `projectExecutionMode`. It passes the **same execution service** to
`WorkspaceManager`, runtime capabilities, the fifth argument of
`installDockerCleanup`, and `composeProjectExecution`. The authority installer
must accept that fifth binding; this unit does not modify authority code.

`composeProjectExecution(ctx, manager, {appsConfig, callApps, capabilities})`
constructs the production graph. Its fourth argument is a direct trusted test
factory seam; no plugin config or HTTP field selects factories or mode.

* `host-compat`: the existing host command runner, project tool, native legacy
  tools, Files/Changes routes, doctor and cache lifecycle remain in place.
  Guest runners, receipts, project Apps tools, editor sessions/adapters, origins
  and certificate stores are not constructed. There is no editor route in this
  branch, matching the 6b source behavior.
* `isolated-guest`: create the guest runner/receipts/file executor and the three
  guest context callbacks; install actual scoped bash, file, helper and job
  definitions for every existing/seeded scope **before** registering the root
  workspace consumer. On `agent/created`, install synchronously before model
  restoration/default/enrollment awaits, including children. Dispose closes the
  root registration first. Captured native definitions, removed guest
  definitions, unknown shell aliases and refreshed foreign definitions fail
  admission. Nothing switches execution mode based on availability.

The root consumer's `handles(execution)` compares the actual admitted definition
using `ctx.tools.get(name, agent, execution.toolSet)` and private definition
sets. Tool names alone grant no authority. Only the explicitly constructed
project/file/context/verification/job/Apps/capability definitions are admitted.
Other SDK model tools remain closed in isolated mode until their actual
definitions and mode-aware effects receive explicit integration review.

`composition.managerExecution(execution)` supplies a private manager-policy view
of `/workspace/...` targets for admitted guest shadows. It maps those paths to
the same manager project root for the existing target guard and operation
accounting; SDK arguments and the guest request are unchanged. The runner also
maps `/workspace` working directories, with the existing traversal check.

## Context, rewrites and process lifetime

The `workspace-runtime/focus-context`, `explain-rewrite`,
`overwrite-admission` and `verify-command` callbacks are implemented. Metadata
inspection runs serialized bounded code inside the guest through the same
command runner. Focus hydrates only the owner's canonical human requests using
`sessionQuery`, preserves the original/latest objective, and returns bounded
excerpts, current hashes, change summary and source identity. A child does not
substitute its own assignment for the owner's objective.

After a working milestone, large write/edit/patch operations require a current
hash and one-use rewrite explanation. The existing line/byte rewrite rule is
used. Admission records a private proof bound to the exact SDK execution,
arguments, owner, project and file hash. The body consumes that proof once; it
performs admission itself if efficiency middleware is absent. The serialized
file worker rechecks the before-hash and existing file identity before mutation.
Paths and request/command/result sizes are bounded. Missing image and
`str_replace_editor` semantics fail explicitly; patches retain the documented
single-file literal-hunk subset.

`createProjectProcessStarter` now accepts a trusted `execute` function and
`assertActive` check. Host default execution is unchanged. Guest background jobs
use the guest function, not `ctx.shell.execute`. Actual process settlement and
generation-bound stop confirmation retain the SDK heavy lease. Cleanup of an
already-owned exact capability remains possible after revocation. New receipt
publication checks the bound launch; only an identical launch may reload its
provider while preserving the existing queue and live claims.

Verification uses the current quality implementation and only the guest
`verify-command` route in isolated mode. Real nonzero exit codes, timeout,
incomplete results and source changes prevent a passing result. Actual
efficiency reconciliation still runs before and after its FairGate, including
`schedule:false`.

## Availability and remaining integration

Apps/VM OFF keeps the plugin loadable and the mode isolated. New guest work
returns unavailable without running native/host tools. Editor sessions expose
the prepared `/api/workbench/editor` open/close API; the OFF path needs no
origins, provisioned certificates or adapter. An active adapter is constructed
only when explicit Apps/VM/project-runtime configuration and editor browser
configuration are enabled. Binding changes after asynchronous admission or
identity waits prevent a bridge/grant and preserve exact cancellation cleanup.

The signed startup/public projection, manager/storage/Changes/capabilities,
authority installer, Apps/VM runtime, immutable guest toolchain, egress/editor
proofs and UI are separate Root-owned integration units. This branch does not
modify them. Apps configuration is read at workspace startup as before; an
operator configuration change requires the corresponding service reload. The
toolchain lazy dependency addition in Root commit `39a7c03` is not copied here.

Checks use the pinned real Cordis/ToolsService/scopes/jobs and actual efficiency
middleware with synthetic executors and explicit bindings. They cover both
modes, captured tool sets, seeded/legacy/child scopes, unload, AppsOFF zero host
fallback, owner history, hash grants, stale waits, scheduler queues, real job
ownership/lease settlement and serialized workers on temporary test files.
Linux-only shell/ripgrep/symlink/permission fixtures skip on Windows. These
checks are source/functional evidence, not real guest or independent security
acceptance. Native UI generation and full CI are intentionally left to Root.
