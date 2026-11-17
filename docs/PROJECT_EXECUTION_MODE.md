# Explicit project execution mode — standalone source contract

This module is not wired into startup, plugins, tools, Apps or Native UI. It
does not activate isolation or publish anything when imported. Existing tools,
Files, Changes and the default worker profile are unchanged.

`vast/project-execution-mode.cjs` fixes both production paths:

- Persistent private policy:
  `/data/harness/root-secrets/runtime/state/project-execution-policy.json`
- Per-supervisor public projection:
  `/data/harness/runtime-status/project-execution.json`

The policy has exactly `version:1`, `contract:"project-execution-v1"`,
`mode:"host-compat"|"isolated-guest"`, a UUID `policyEpoch`, and a40hex
`activationSourceCommit`. Provision an explicit root-owned policy before any
future contract-aware startup integration is deployed. Missing/invalid policy
blocks startup; neither AppsOFF nor a missing file implies host compatibility.
The module deliberately provides no persistent policy writer or default.

Files must be canonical JSON (`canonical(value)`), bounded4096bytes, regular,
single-link, root-owned and not writable outside root. All ancestors must be
real canonical root-owned directories not writable outside root. Readers use
bounded descriptor reads and check replacement/change during the read.

`createExecutionModeContract()` returns:

- `readPolicy()`: Linux-root-only protected policy read.
- `publishForSupervisor({sourceCommit})`: Linux-root-only publication. It checks
  the actual fixed installation's current release and existing root attestation,
  reads the explicit policy, creates a fresh UUID `launchId`, and uses the
  existing protected atomic/fsync primitive for the public projection. Policy,
  source and publication are checked again before success. Call exactly once
  before launching a supervisor's services; it is not a runtime refresh timer.
- `bindForService({sourceCommit,launchId})`: binds a frozen public snapshot to
  the service's signed release identity and root-inherited launch identity.
  `assertUnchanged()` re-reads protected public state and refuses changed,
  missing or invalid publication. It never adopts another mode or launch.

The projection adds `policySha256`, current `sourceCommit` and `launchId`.
`policyEpoch` and `activationSourceCommit` persist across routine restarts and
signed source updates; the latter records activation provenance and is not
required to equal today's serving commit. Only an explicitly authorized policy
change gets a new policy epoch. The supervisor creates a new launch identity;
its automatic child-service restarts inherit the same one. Neither identity is
the admission broker's recovery/dispatch epoch. No time expiry or availability
probe selects mode. Synthetic dependency injection is for trusted tests only.

## Proposed integration — not applied

In the signed root `vast/supervisor.cjs`, immediately after
`const sourceStatus=runtime.adoptSignedStatus(R)`, require this module and call
`publishForSupervisor({sourceCommit:sourceStatus.appliedCommit})`. Add the
returned `launchId` to the root-created child environment. This precedes Apps
and Native service launch. Services bind using their own release identity and
that inherited launch ID; check the binding at asynchronous operation admission
and before execution after a queue wait. A process must stop admitting work if
the projection changes, rather than hot-switching installers.

No `runtime-paths.cjs` change is needed: the module calls its existing `atomic`
with the fixed public path and canonical bytes. Do not broaden `publish()`'s
status whitelist or copy this feature into stable bootstrap. No device-key or
admission-key migration, grant-schema change or historical enrollment is needed.

The root hook must not wait for admission to open, Native/guest readiness, or
an Apps state RPC. Native infrastructure health is needed before the launcher
opens admission. Initial healthy adoption can change admission epoch after the
supervisor starts, so binding this publication to that earlier epoch would make
it stale. Do not reset accepted-work state to issue a mode projection.

Future `host-compat` wiring must retain current behavior as an explicit dormant
mode and report isolation as unaccepted. Future `isolated-guest` wiring must
install guest shell/file/verification guards before tool snapshots for all
agents, including children and legacy sessions. Guest unavailability, AppsOFF,
missing handlers, or failed proof must block rather than call a host backend.
This module does not install or verify those execution guards.

## Limits and lifecycle requirements

Policy changes need closed admission, settled foreground/background work and
a new supervisor; changing JSON alone does not revoke running work. Publication
failure prevents startup and may leave a previous or partially completed public
generation for inspection; callers must not start services after failure.
Missing persistent policy prevents the next publication even if an old public
projection remains. Unprivileged consumers do not read private policy directly.

**Isolated activation and the rollback enforcement floor are not solved or
accepted here.** A prior signed, mode-unaware supervisor can ignore this policy.
Review and establish a mode-aware last-good release before any isolated
activation, and resolve all permitted rollback targets. This module neither
changes recovery eligibility nor prevents a root operator from editing policy.
It provides no isolation acceptance evidence. Its focused tests use in-memory
files and injected source proofs; they do not establish Linux filesystem,
startup ordering, execution isolation or operational acceptance.
