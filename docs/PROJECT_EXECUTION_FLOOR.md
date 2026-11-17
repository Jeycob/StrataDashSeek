# Stable execution floor

This source adds stable enforcement for the separate execution-mode protocol.
It does not install the bootstrap, provision policy, migrate credentials or
qualify isolated execution. The integrated source declaration is described below.

## Separate capability, unchanged recovery identity

The existing securityEpoch2 ABI, compatibility ID, release attestation proof,
recovery policyHash/state and admission ACK format remain unchanged. The floor
reads the existing protected canonical policy and a separate descriptor in the
verified source tree:

```json
{"contract":"project-execution-v1","sourceProtocol":1,"version":1}
```

Root integration now supplies that exact descriptor for the complete bound
source composition. See PROJECT_EXECUTION_RELEASE_QUALIFICATION.md for the
checked consumers and remaining runtime acceptance. A module filename or
partial source preparation does not declare support. Descriptor bytes are
covered by the normal signed-source digest.

An absent descriptor is protocol0; the exact canonical descriptor is
protocol1. Malformed, linked, writable, oversized or future descriptors fail
even in host mode. Explicit host policy accepts0/1. Isolated policy accepts
only1 and SHA-named managed releases; anonymous legacy fallback directories
are refused. A missing/invalid policy is never interpreted as host mode.

## Enforced seams

`createExecutionFloor().capturePolicy()` captures an immutable policy identity.
Its synchronous `assertPolicyUnchanged`, `assertReleaseAllowed` and contained
`assertDirectoryAllowed` methods check that same identity. The narrowly named
`assertLegacyAppAllowed` handles the pre-rename initial app directory only in
explicit host composition. It is not an arbitrary path override.

Release attestation and sync/child verification apply the current floor while
returning exactly the existing core proof. Historical records remain intact;
an old attestation cannot bypass the current floor. Child verification checks
the parent's captured floor after its await and does not inherit FD9.

Candidate activation checks candidate and fallback before journaling or
switching. Its catch restoration checks the captured floor before touching the
pointer; rejected restoration retains the journal/applied evidence and reports
`PROJECT_EXECUTION_FLOOR_ROLLBACK_REQUIRED`. Direct interrupted-transaction
restoration validates both contained targets, the previous applied identity
and digest when present, and the current floor before switching. Unsupported
previous source never becomes the pointer as a claimed successful rollback.

The root launcher captures policy before creating the broker. It rechecks
release verification, asynchronous UI stop, offline purge reconciliation,
health/recovery observations and immediately before supervisor spawn. It
rechecks the current source pointer and verifies exact source bytes after
purge reconciliation. No executing launcher adopts a new policy in place.

The broker requires a separate trusted floor capability. The production root
factory captures one if its trusted launcher did not provide it. Checks cover
controller/current-pointer/queue waits, durable acceptance completion, final
signing and the HTTP response boundary. A mismatch closes persisted admission
and returns a signed denial. Already recorded acceptance stays recorded.
Heartbeat cannot publish enabled state under a mismatched captured policy.

## Source staging and bootstrap installation

Loading these modules has no policy I/O. Diagnostic `startup-update --check`
continues to stage/verify source without requiring execution policy or changing
the installed stable bootstrap. Ordinary source deployment does not upgrade
stable enforcement: old installed bootstrap bytes retain their old behavior.
Missing/invalid explicit policy becomes fatal when an upgraded floor consumer
is actually constructed/invoked. `adoptSignedStatus` reports differing/missing
stable helper bytes as bootstrap upgrade required.

Both bootstrap inventories include the shared policy reader and floor helper
before their consumers. Existing or partial bootstrap installs, including
missing new helpers, need explicit `upgradeBootstrap`. Changed installed bytes
require the actual inherited root FD9 exclusive flock and no service-UID
writers. Even a fresh installation requires pre-provisioned valid policy
before publishing floor-enabled code. Installation never creates that policy.
The entry is published last and the captured policy is checked before it.

FD9 proves exclusive ownership of its kernel open-file description. It cannot
prove that an old root launcher deliberately sharing that same description
has exited, and service-UID absence cannot prove that all root controllers or
user jobs have settled. Before a real upgrade the operator must close new
admission, settle all owned work, stop the old UI supervisor and root launcher,
then obtain the cold operator FD9 lease. Preserve model/Tailscale work as the
existing maintenance procedure requires. This source unit performs none of
those production operations.

Before any isolated activation, Root must qualify fully bound current,
candidate, active fallback and lastGood references, resolve or retain any
unfinished transaction, and install/verify the signed stable bootstrap under
that cold boundary. Historical inert rows may remain protocol0. Existing
grants and work can outlive a policy-file write; changing policy in a running
launcher is not an activation mechanism.

## Trusted fixture composition and checks

The mode contract and floor accept `rootDirectory` only as a trusted factory
dependency; production defaults remain `/data/harness`. No environment,
ordinary config, policy field or per-operation input can choose it. Actual
filesystem fixtures use owned protected `/root/homeai-execution-floor-test-*`
or `/var/lib/homeai-execution-floor-*-test-*` roots and the production readers.

The root test family covers old/new protocol launch with an actual FD9-held
child stand-in, real protected descriptors/attestations, activation/catch and
interrupted pointer positions, exact existing recovery/key semantics, queued
policy races, real competing root lease and service writer, and partial entry
publication. Existing Linux updater and inherited-lease regression fixtures
are adapted to explicit trusted host composition. No real project, guest,
model, Tailscale, Docker/QEMU, live service, policy or bootstrap is operated by
these fixtures. Root owns CI inventory and production acceptance separately.
