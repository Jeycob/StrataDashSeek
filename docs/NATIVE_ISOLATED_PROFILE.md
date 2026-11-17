# Isolated native instruction and skill discovery

This source unit closes a concrete path outside `tools/execute`: the pinned SDK's
`dsh-agent-instructions` resolves and streams AGENTS/CLAUDE files, and
`dsh-skill-filesystem` follows skill links. Their automatic pre-step work can read
a host target from a guest-created project link before a model tool executes.
The native local filesystem's realpath identity is not a containment boundary.

The isolated branch now uses a root-prepared complete native composition.
`vast/native-isolated-profile.cjs` exposes a pure
`projectNativeReaders({baselineEntries, entries, binding})` and the production
`prepareNativeIsolatedLaunch({binding, gid})`. The latter runs in the existing
signed root supervisor, before any unprivileged service starts. It requires the
same validated execution snapshot, hashes the reviewed SDK base/web/preset and
reader artifacts, composes the existing profile and home overlays with the
SDK's public `composeEntries`, and rejects unknown bundles, plugin identities,
expressions, duplicate rows, incomplete presets and unresolved patches. It
preserves the four entire preset arrays rather than applying an ineffective
id-only override to their children. Managed source module paths are pinned to
the snapshot's immutable release.

In isolated composition, all four native instruction configurations have
`maxBytes: 0`; the pinned implementation returns before cwd or filesystem
access. All four filesystem skill providers have no default/custom/bundled
roots and no watchers; native `tool-skill` consumers are disabled because their
user-invocation hook can load a body independently of tool admission. Native
config HMR is disabled for this fixed launch composition. A new profile layout
requires source review rather than a missing-reader default. This is an
explicit discovery exclusion, not a spoofed `working-directory/access` return.

The private canonical snapshot is fixed at
`/data/harness/runtime-config/native-isolated.json`, root-owned mode 0640 under
a root-owned setgid 2750 directory with the Harness read group. It is not a
public status file and is outside all project guest mounts. It may contain
ordinary configured provider values; it must not be copied into public
evidence. The snapshot binds the complete policy/source/launch identity and
the entries hash. Binding checks surround asynchronous imports/setup and the
atomic publication; the unprivileged carrier rejects unsafe ownership, links,
changed identity or changed contents. Importing these source modules does not
perform policy or filesystem I/O.

`vast/native-isolated-start.mjs` uses public SDK `boot`, `PluginPackages`,
`createRuntimeResolution`, `provideCmdline`, launch-environment and proxy APIs.
It boots the signed empty `native-isolated-root.json` with the already complete
snapshot; it never asks the CLI to reread mutable composition layers after
projection. Preparation finishes before any Loader entry, preset, agent or
ToolSet exists. The original Harness home, profile, session and persistence
roots, process cwd, environment layers, web arguments/ports, profile identity,
launch environment, app readiness and five-second bounded shutdown semantics
are retained. Native executor rows and their execution pipeline are unchanged.
The existing runtime admission plugin still provides the permanent isolated
guard and immutable execution binding to consumers. Child restarts reuse this
supervisor's snapshot and launch identity; a new supervisor/source update
requires a new root projection. Native profile configuration changes require
trusted cold maintenance and a new snapshot; this is not a control-plane
permission redesign.

Host compatibility keeps the original admission patch bytes and exact stock
CLI executable/arguments. It does not read, construct or publish the isolated
profile. No availability or Apps state chooses a mode, and no isolated failure
falls back to the host CLI.

Native automatic project/user AGENTS, CLAUDE and skill discovery is deliberately
absent in isolated mode. This unit does not claim equivalent automatic guest
instruction semantics. A model can explicitly read `/workspace/AGENTS.md` (and
other project instructions) through the already admitted guest file executor,
or request bounded excerpts using `focus_context`; these run through the same
guest command/file path and binding checks. Guest automatic instruction
discovery would require a separate guest-backed context provider. Historical
instruction text already recorded in a session is not erased or reread by this
unit; activation and legacy-session review remain separate requirements.

Tests use only public synthetic temporary files. Actual SDK readers are mounted
through the public boot carrier before first Tools resolution. The native
unprojected path includes normal AGENTS/skill sentinels and an external skill
directory-link sentinel before any tool executes; projected readers yield zero
content reads, and explicit skill snapshots are empty. The external AGENTS and
skill **file**-symlink case runs on Linux and explicitly skips Windows when
file-symlink privilege is unavailable. The fixture also checks immutable
identity, unknown composition refusal, private publication via in-memory
adapters, preparation order, readiness and shutdown. It does not start a web
server, use a model, publish a real policy/snapshot, or access a guest, live
backend or private data. The new suite passed **12/12 with zero skips** on local
Linux Node24 with the existing exact SDK, including both external file links;
the focused Windows run passed 78/79 with only that privilege skip. Full isolated
web startup remains an integration qualification requirement. Policy activation,
rollback enforcement floor and isolation acceptance are not provided here.
