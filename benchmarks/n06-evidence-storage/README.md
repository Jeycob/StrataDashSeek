# Bounded N06 evidence storage

This is reusable source and inert regression coverage. It does not deploy or
launch a benchmark, submit a model prompt, create sessions, load credentials,
collect QA, or publish benchmark results. Callers must supply independently
authorized transports, target bindings and actual proofs. The synthetic tests
provide no production proof defaults.

The historical `../n06-finalization` package, its API, and all eight pinned
source bytes remain unchanged. This new version composes its existing portable
`driver-core.mjs` and `stop-scope.mjs` with the repaired storage modules. The
unchanged core finalizer and bindings are imported from that historical package;
the new lifecycle has its own unchanged Native transport import closure.
The composition API retains its first-B03/HomeAI record validation. It is not a
campaign launcher or the second-side prior-run validator; the generic storage
and runner modules still require the caller's fixed, validated composition.

## Storage contract

Every in-memory observation still contains the full, chronological Native
history. A durable snapshot uses the existing complete envelope, hash and
previous-checkpoint chain. There is no truncation, compression or new evidence
format. A noncritical observation can now explicitly return:

```js
{ checkpointId, durable: false, skipped: true,
  reason: 'unchanged' /* or 'sample_interval' or 'observation_budget' */ }
```

This is **not** a persistence receipt. It has no SHA or byte count, creates no
file, and advances no durable checkpoint ID. Both the runner and finalizer writer
must use this version of the contract together. The writer keeps the newest
full record in RAM even when an observation is skipped. Unknown/late writes
still quarantine it; missing intent/final durability still blocks progress.

Changed ordinary observations are sampled at most once per ten seconds;
duplicates skip. Their fixed internal budget is 4 MiB, identical for both model
providers. Reaching it is expected and does not stop the model or quarantine the
writer. The hard budget is 64 MiB, count cap 2,048 and snapshot limit 2 MiB.

Four critical writes are reserved and counted separately: one intent, at most
two final records, and one finalizer retention. If `E` is the maximum 2 MiB
snapshot plus the exact fixed envelope overhead and `C` is the exact writer
claim size, construction requires at least `4E + C` bytes and four slots. Each
ordinary write additionally preserves every remaining critical slot at its
maximum size. Actual allocation is bounded by `4 MiB + 4E + C`, and always by
64 MiB. A smaller valid budget skips ordinary observations sooner. Budgets are
declarations, not preallocation; even RPC-only callers must now pass valid
writer budgets. Existing tiny-budget helpers must select 64 MiB/2,048 or retain
their historical adapter. The fixtures and driver use 64 MiB/2,048.

Intent, final and finalizer-retention writes never skip. Oversized final records
and physical storage/IO failures remain unconfirmed, rather than being silently
accepted. The original 600-second primary and acceptance limit, 300-second repair
limit, four-second callback bound and first immutable cleanup deadline remain
unchanged. This package neither retries nor resumes an invalid prior attempt.

## Lifecycle addition

The sole lifecycle change from r3 classifies `working_directory` as a reviewed
awaited effect. The pinned SDK tool awaits `workingDirectory.ensure` or `set`;
the service awaits filesystem resolve/stat and commits the directory change,
then removes its pending operation before fulfillment. It starts no process.
An exact Native call/result and current target proof remain necessary. This
classification does not prove completion of jobs, processes, descendants or PTYs,
and does not accept missing or foreign results.

## Provenance and checks

The adapter, runner and finalization modules preserve the exact reviewed source
bytes from packet `c49c17316eb3afeb5769d0ad17395de86e46382677e6e8e46c82c53fe1ee7931`.
The lifecycle preserves the exact reviewed r4 bytes from packet
`50c4f1ccb2daecb77b0c8b55d048dd3b94a8d9f10928562d543dcbee2a68c770`.
Their hashes, the unchanged composition sources and the eight historical pins
are asserted by the composition suite. These are source provenance, not runtime
authorization, actual durable receipts or model-quality evidence.

Run on Node.js 24:

```sh
node --test benchmarks/n06-evidence-storage/checkpoint.test.mjs benchmarks/n06-evidence-storage/lifecycle.test.mjs benchmarks/n06-evidence-storage/composition.test.mjs
```

All three suites are required portable CI entries. They use only constructed
records, in-memory HTTP events, controlled clocks and a MemoryFS. No frozen
benchmark prompts or application fixtures are copied. The tests cover growing
history that would exceed the old 64 MiB write budget, a full logical 600-second
run, sparse writes, durable-chain continuity, all critical writes, a real
driver-core/runner/writer/finalizer composition, genuine simulated IO failure,
and missing/foreign lifecycle evidence. MemoryFS verifies sync call ordering
and receipt handling; it does **not** prove physical Linux fsync or application
acceptance. A production caller still owns actual storage/runtime qualification
and the existing independent QA workflow.
