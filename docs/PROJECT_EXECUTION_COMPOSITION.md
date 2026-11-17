# Explicit manager composition

This source unit does not publish policy or wire production plugins. Its base is
`d9b842a595d357b14fa2c65d97be243032b06dda`; Apps/VM/quality/efficiency and Native
entrypoints remain for Root integration. Do not deploy a partial composition:
missing bindings deliberately block construction.

## Trusted constructor arguments

`workspace/execution-mode.mjs` exports `bindProjectExecution(binding)`. It accepts
the real root contract's frozen `{snapshot, assertUnchanged}` service shape,
including additional trusted service methods. It validates the projection and
captures its identity. It does not read a mode string from settings/config,
environment, model arguments or browser data, and has no default mode.

Production callsites must supply the service provided by the trusted root
runtime admission plugin, after its source/launch binding:

```js
const manager = new WorkspaceManager(ctx, config, ctx.projectExecutionMode);
await manager.initialize();
const capabilities = createRuntimeCapabilities(options, ctx.projectExecutionMode);
// Manager itself passes the same checked binding into:
const changes = new LiveChanges(changeOptions, manager.execution);
```

Only `workspace/plugin.mjs` still needs the first two production callsite edits;
Root owns that integration. The module's `inject` list must declare the actual
service. No device/admission key or stable-bootstrap migration is performed by
these constructors. The mode remains fixed until a new supervisor/service.

Tests use explicit host/isolated fixture bindings from
`workspace/fixtures/execution-binding.mjs`; production must never import it.
All manager/changes/capability fixture callers in this unit now pass a binding.
Absence or malformed binding rejects before filesystem initialization.

## Preserved host behavior

Host composition retains the6b fresh-directory, Native worktree, continue and
legacy enrollment paths, project grants, model defaults and lazy Git comparison
semantics. Existing host capability DTO remains version1 with its current argv
recipes and documentation. Apps availability cannot change composition.
Bound identity is rechecked around asynchronous admission/persistence/lease
waits; a changed launch blocks new effects in either composition.

## Isolated behavior

New independently enrolled projects use the existing reviewed repository helper:
owned Git objects, an initial commit, no borrowed source worktree/alternates or
uncommitted source data. Private Git comparison bytes are captured before the
registry, writable grant or working directory is published. New continue-mode
records retain the selected directory without writing a project marker there;
they do not gain command eligibility.

Existing host/legacy/native-worktree records are retained unchanged. They are
not copied, relabeled or granted access by isolated enrollment. Command
admission requires `independentRepository===true`; unrecognized host shell
aliases remain refused. `assertIndependentProject(record, ownerId)` performs
fresh canonical root, overlap and independent Git metadata checks for existing
enrollment. Final guest execution still needs the Root-owned mode-aware
workspace composition, fresh runtime authority and the guest runner; this unit
does not install those tool shadows or claim guest readiness.

Isolated capability DTO is version2, with typed project_apps/verification/job
recipes and no host CLI authority. Host and isolated caches cannot survive a
changed bound source/launch/policy projection.

## Baseline lifetime and retention

Isolated Git history uses `private-objects-v1`: bounded initial blob reads,
identity checks and private retained content. Later comparisons and restarts do
not execute Git in the published project. Missing, forged or historical
nonprivate Git baselines are unavailable; there is no lazy shared-Git fallback.
A private marker remains private even when explicitly reopened under host mode.

A failed initial capture is reported without deleting the newly created project.
After publication it cannot be retried by reading its now-exposed Git state.
Existing files, repositories, retained objects and baseline directories are not
deleted or migrated by this unit. Dispose cancels the in-memory tracker and
drops its cache. Policy activation still requires settled work and a new
supervisor; changing JSON while work runs is not a migration mechanism.

## Validation limits

Both-mode source fixtures cover actual temporary Git worktrees, independent
enrollment, publication ordering, legacy retention, stale queue/lease/metadata
waits and readonly child authority. The storage race fixture checks actual
opened descriptors, including matching outside bytes that would pass a hash
check. These are local synthetic fixtures, not a managed guest acceptance run.

Production plugin/service wiring, strict guest file/shell registration, quality
and heavy-admission composition, Apps resource/HTTP/log glue, actual artifacts
and the rollback enforcement floor remain separate requirements. No policy,
live config, VM/container, generated Native bundle or CI inventory was changed.
