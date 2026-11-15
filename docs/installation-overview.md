# Installation and everyday operation

Use the existing installation when available. Ordinary start/wake must reuse
the persistent model, runtime, projects, databases and push identity.

| Task | Existing entry point | What it changes |
| --- | --- | --- |
| Open the existing server | Private phone launcher or authenticated wake page | Starts the configured existing instance on demand |
| Start services after boot | `vast/start.sh` and `vast/supervisor.cjs` | Reuses installed services; no ordinary-boot dependency installation |
| Update code before first requests | [Signed startup gate](startup-updates.md) | Verifies pinned signatures, dependencies and disk reserve before activating source |
| First Harness installation | `vast/install.sh`, then README configuration steps | Installs pinned runtime; requires an existing compatible Strata/model installation |
| Enable optional Apps | [Applications](applications.md) and [v2 workflows](applications-v2.md) | Explicit dedicated container worker, preview, checks, releases and rollback |
| Isolate projects and verify results | [Workspace runtime](workspace-runtime.md) | Native project roots, verification and per-project state |
| Tune context, scheduling and measure cost | [Efficiency](../efficiency/README.md) | Coordinated profile extension and separate billing collector |
| Understand requests and disk headroom | [Request budget](request-budget.md), [disk proposal](disk-plan-20261114.md) | Read-only measurements and a removal proposal requiring approval |

The signed code-update gate is implemented separately from the proposed
whole-stack installer. Enabling it is a one-time operator step with a pinned
public key; ordinary wakes reuse that setup. A failed signature, dependency or
disk check blocks activation. Resolve the cause instead of replaying installation
or pruning models and data automatically. A prepared GitHub release and the
currently installed server revision are separate facts.

For a fresh installation, finish these stages in order: verify the existing
model and disk headroom; install the pinned Harness/runtime; configure private
network and credentials; start core services; pair the phone; enable optional
Apps and development tools; then prove task execution, persistence and a cold
cycle before enabling automatic idle stop. The detailed existing README steps
remain the executable procedure. Do not replay a first-install procedure over
a configured live profile or replace credentials with example values.

Keep bootstrap provisioning separate from routine startup. A staged release
should verify its dependencies once, back up the current profile and activate
with no running or queued work. Profile HMR can apply the verified scheduler
without restarting the model. Coordinate service, vault and supervisor changes
with their owner. Preserve one scheduler and one billing collector.

Further simplification is the [whole-stack installation proposal](installation-design.md),
not an implemented one-command installer. One versioned manifest, resumable
steps and one acceptance screen are the intended direction. Do not advertise
empty-host recovery or automatic updates as proven merely because the current
configured instance passed its cold-cycle checks.
