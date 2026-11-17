# N06 finalization regression package

This package preserves the repaired first-B03 benchmark composition and its
regression tests. It is reusable source, not a deployed benchmark launcher or a
record of benchmark quality. Importing it does not start a model, open a transport,
load credentials, create a session, or write a checkpoint.

The original, separately qualified operational bundle remains unchanged. This
publication does not replace that bundle or repeat its runtime qualification.
Live configuration, launch scripts, session identifiers and runtime evidence are
intentionally outside this package. A caller must supply independently authorized,
qualified adapters and actual evidence; boolean handoff fields do not grant access.

## Repaired behavior

- A closed preview can retain its real job identifier. Cleanup keeps that metadata
  and the full job roster, cancels only owned work, follows the owned jobs to a
  terminal state, and proves settlement before and after restoring visibility.
  A kill acknowledgement, unknown preview state, missing tool result, or still
  running job cannot become successful settlement.
- The first stop establishes an absolute cleanup deadline. Later observations,
  repeated cleanup calls and delayed continuations cannot extend it. The shared
  abort signal and deadline reach RPC, Native transport, runtime assertions and
  checkpoint effects. Guards run both before and after awaited operations, and
  RPC options are rebound after asynchronous target assertions.
- No new client effect is dispatched after that deadline and no late response
  counts as positive proof. An already dispatched server or kernel operation
  cannot be undone by a client abort; an unconfirmed outcome remains `HOLD`.
- The original 600-second primary/acceptance limit remains independent of the
  bounded cleanup window. Cleanup does not submit another prompt or reset time.

## Composition boundary

`driver-core.mjs` exports `composeFirstB03` and `validateHandoff`. Its only extraction
from the operational driver is the explicit `target`, `sourceCommit` and
`checkpointDirectory` constructor inputs, validation and an immutable snapshot of
the target. It has no live pins import or runtime loader. The B03/HomeAI first-run
record, matching source/runtime handoff and single-submit contract are retained;
it is not a general campaign runner or the second, DS-side validator.

For example, this is inert configuration data, with no real destination:

```js
const configuration = {
  target: {
    owned: true,
    scenario: 'B03',
    variant: 'HomeAI',
    sessionId: 'synthetic-session',
    workspaceId: 'synthetic-workspace',
    projectId: 'synthetic-project',
    projectRoot: '/synthetic/project',
    preparedFixtureEvidence: 'synthetic-fixture-evidence',
    modelSelection: { provider: 'synthetic-provider', model: 'synthetic-model' },
    sessionUrl: null,
  },
  sourceCommit: 'a'.repeat(40),
  checkpointDirectory: '/synthetic/checkpoints',
};
```

Construction also requires the existing handoff, record, verified inputs, runtime
adapters and module callbacks. The tests show an entirely inert composition with
synthetic identities and controlled clocks. There are no default successful
attestations, cancellation proofs, persistence receipts or network adapters.
The caller's target is cloned and recursively frozen before adapter construction;
changing its original identity or nested model selection cannot retarget the run.

## Provenance and validation

`stop-scope.mjs` and `finalization.mjs` retain their exact repaired operational bytes.
The six modules under `frozen/` retain their original bytes and relative import
closure: the primary runner, core finalizer, lifecycle r3, bindings, and both
identical Native transport placements used by the frozen imports. The duplicate
transport files deliberately preserve that closure; they are not two variants.
The repository attributes preserve their original line endings in Git and CI.

The regression test pins all eight unchanged source hashes. The source packet
manifest used for extraction is
`677867ca3d69efbe28a118e292519b0be163994404d661feb4c8fd867298fe39`.
These provenance hashes are not runtime qualification or authorization evidence.

Run the focused suite on Node.js 24:

```sh
node --test benchmarks/n06-finalization/finalization.test.mjs
```

The suite composes the actual frozen runner, finalizer, lifecycle and bindings
with inert transports. It covers retained closed-preview identity, rejection of
unsettled/unknown work, delayed and early stop, late follow, shared abort, absence
of effects after the cap, unchanged source bytes, and configuration isolation.
It makes no network requests, performs no inference, and writes no checkpoints.
Passing it proves these source-level contracts, not application acceptance or
model benchmark results.
