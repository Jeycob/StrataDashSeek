# Project execution floor — standalone helper

This source prepares a stable-bootstrap floor for the explicit execution-mode
contract. It is **not wired** into startup, recovery, admission or the supervisor.
It installs nothing, publishes no policy or projection, and does not declare this
partially integrated source capable of isolated execution.

`createExecutionFloor()` performs no I/O. Its only dependencies configurable by
trusted tests are filesystem/platform/getuid. `capturePolicy()` reads the
mandatory root policy through the existing `createExecutionModeContract`
protected reader. There is no second private-policy parser or default.

```js
const {createExecutionFloor} = require('./project-execution-floor.cjs');
const floor = createExecutionFloor();
const binding = floor.capturePolicy();
// After the existing GPG/source-digest verification, and again after awaits:
binding.assertPolicyUnchanged();
const capability = binding.assertReleaseAllowed(verifiedCommit);
// capability is only {sourceCommit, sourceProtocol}; it is not a release proof.
```

Commit IDs must be exact lowercase40-hex strings. The helper reads only
`/data/harness/releases/<commit>/vast/project-execution-compatibility.json`.
Every ancestor must be canonical, root-owned, unlinked and unwritable outside
root. It bounds the descriptor at4096 bytes, opens without following links,
checks file/parent identities around the read and rejects unsafe or changed
objects. The actual signed source digest and complete release-tree validation
remain the caller's job; a descriptor alone never authenticates source.

An absent descriptor in an otherwise protected existing release is protocol0.
A missing source/parent directory or any malformed/unsafe descriptor is an error.
Protocol1 requires this exact schema, encoded with the shared `canonical()`
function as UTF-8 with no newline:

```json
{"contract":"project-execution-v1","sourceProtocol":1,"version":1}
```

Explicit host mode accepts protocol0 or1. Explicit isolated mode accepts only1.
Unknown versions, additional/duplicate keys, coercions and future protocol
numbers are rejected in both modes. **Do not add this declaration to a source
until supervisor and all consumers are wired and their composition is proven.**
This preparation commit intentionally contains no declaration file.

The binding retains immutable policy fields and their canonical hash. A changed
mode, epoch or activation provenance blocks the old binding, including a change
during descriptor reading. Missing/corrupt policy also blocks it. An identical
atomic rewrite is the same semantic policy; an inode replacement during a read
is rejected by the shared reader. An existing launcher must not adopt new policy
in place. A caller waiting on a lock, shutdown, reconciliation or admission must
assert again after the wait and before its effect.

## Later integration

Keep securityEpoch2, existing ABI/compatibility ID and every persisted recovery
proof/policyHash unchanged. The helper returns a separate capability only.
Apply it dynamically to old attestations as well as newly staged sources.

- `runtime-release.attest/verifySync`: keep GPG/exact digest checks and existing
  proof shape; require a fresh valid policy binding and source capability before
  accepting the release. CLI verification uses the same path.
- `runtime-launcher`: capture one binding before broker construction. Assert it
  before/after asynchronous verification, UI stop and purge reconciliation, and
  immediately before supervisor spawn, source switch or opening admission.
- Admission: assert before/after the controller's `admitWork` await for every
  grant; close admission on a mismatch. This does not settle existing work or
  revoke its effects by itself. Explicit mode changes require closed admission,
  settled work and a cold launcher/supervisor restart.
- `startup-update`: guard ordinary candidate activation, catch-path restoration
  and interrupted-transaction restoration before pointer mutation. Validate
  restoration paths/identities; a non-SHA legacy-directory journal requires
  explicit recovery rather than treating it as a signed source. Do not consume
  an unresolved journal or report a disallowed restore as successful.
- `startup-install` and `runtime-paths.adoptSignedStatus`: copy/list this helper
  and the shared contract before their consumers. Bootstrap upgrade remains
  explicit maintenance under the exclusive inherited supervisor lease. The
  absence of service-UID processes alone does not exclude a root launcher.

No existing file is changed by this unit. No runtime hook, activation writer,
descriptor declaration, bootstrap installation or isolated-mode acceptance is
implied by its tests. Tests use protected-filesystem fixtures and the actual
pure recovery controller, not a live production filesystem or supervisor.
