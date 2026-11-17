# Execution binding consumers — integration still required

This unit does not publish mode, activate isolation, change supervisor/Apps/VM,
or wire the workspace plugin. It must not be deployed alone: production
`root-runtime-admission` now requires an explicit8c mode publication and the
root-inherited `HARNESS_PROJECT_EXECUTION_LAUNCH_ID`. Missing or invalid binding
leaves its root tool slot closed. No browser/config value chooses a mode.

The mandatory plugin derives its source SHA from its own canonical immutable
`/data/harness/releases/<40hex>` path, installs the existing admission protocol,
binds the protected public projection and provides Cordis `projectExecutionMode`.
The permanent closed tool slot is installed before asynchronous path/binding
work, so a failed provider cannot expose native tools. Optional workspace or
mandatory provider unload never removes that root guard.

Consumers must declare `projectExecutionMode` in `inject`. The frozen service
is also an8c-compatible binding: `.snapshot` and `.assertUnchanged()` can be
passed directly to the manager/storage/capability consumers. Additional methods:

- `.assertTool(execution)` checks the binding and, in isolated mode, requires a
  live workspace consumer to recognize the actual admitted tool definition.
- `.registerWorkspace({handles,beforeHeavy})` registers one trusted in-process
  consumer and returns a disposer. Unload closes the slot; replacing the
  consumer does not authorize old captured tool sets. `handles` must compare
  actual SDK definition identities through the execution's original `toolSet`,
  not permit names or merely check that a project exists.
- `.beforeHeavy(execution)` checks before/after the isolated workspace's awaited
  receipt reconciliation. Host compatibility never calls that guest callback.

Proposed Root workspace callsite, **not applied**:

```js
export const inject = [...existingDependencies, 'projectExecutionMode'];
const mode = ctx.projectExecutionMode;
const manager = new WorkspaceManager(ctx, config, mode);
// Branch by mode.snapshot.mode, never Apps availability. Construct current
// host executors only in host-compat, guest executors only in isolated-guest.
// Install all scoped definitions before opening the isolated workspace slot.
ctx.effect(() => mode.registerWorkspace({
  handles: exec => managedShell.handles(exec) || projectFiles.handles(exec)
    || trustedDefinitions.has(ctx.tools.get(exec.name, exec.agent, exec.toolSet)),
  beforeHeavy: async exec => {
    await projectApps.beforeHeavy();
    await guestRunner.beforeHeavy(exec.signal);
  },
}));
```

`trustedDefinitions` must include only reviewed guest/scoped definitions whose
handlers are installed. Do not also register the same reconciliation callback
through the legacy `registerWorkspaceHeavyAdmission` API: that separate API is
retained for existing consumers and its closed slots remain required.
Efficiency performs reconciliation before and after FairGate, including when
scheduling is disabled; the existing retained background lease stays in use.

Quality uses the current host command only in host compatibility. Isolated mode
requires the prepared `workspace-runtime/verify-command` callback installed by
`installProjectVerification`. Its result must include `.result`; absence or
failure never selects the host executor. Started host handles are awaited to
quiescence before a changed binding can reject their result.

The following **trusted guest callback seams remain unimplemented** by this
unit. They are required before isolated T03/T06 can be claimed complete:

| Event | Input | Required result/owner |
| --- | --- | --- |
| `workspace-runtime/focus-context` | `{arguments,execution}` | `{value}` containing bounded guest-derived context and file hashes |
| `workspace-runtime/explain-rewrite` | `{arguments,execution}` | `{value:{recorded:true,...}}`; guest owner stores the exact-hash, one-use grant |
| `workspace-runtime/overwrite-admission` | `{execution}` | `{allowed:true}` or `{denial:{reason,info?}}`; guest owner enforces/consumes that grant |

Missing handlers fail closed before host shell or host project inspection.
Existing host T03/T06 behavior is preserved in `host-compat`. Every callback
must independently check the same binding after its own waits and immediately
before side effects; caller checks do not make an unbound executor safe.

Tests use the real pinned Cordis injection/ToolsService pipeline with explicit
synthetic bindings and inert executors. They establish source/lifecycle behavior,
not actual guest isolation, root publication, operational acceptance or a
rollback enforcement floor. Those remaining integration requirements stay open.
