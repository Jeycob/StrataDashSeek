# Bounded observer proof progress — source candidate

Repeated observation previously re-proved every completed foreground range on every poll. A single read-only replay of eight completed foreground calls took 3,812 ms of the original 4,000-ms observation budget, with all work settled. This candidate bounds new proof work and reuses only qualified permanent terminal facts. That replay measures current idle latency; it does not establish the exact cause of the earlier stopped attempt.

This is an isolated source candidate based on `8c20a4681fbfee5f138d0568333f07ff74f893c3`, exercised only through inert tests. It is not selected by an existing producer. The accepted `n06-evidence-storage` runner/lifecycle, frozen bindings, prepared benchmark closures and runtime pins are unchanged. A later producer must explicitly compose **all three** files here; the existing native transport is the only production source dependency. Read-only performance qualification and any later actual benchmark remain separate Root steps.

## Terminal foreground receipts

The copied binding still performs both original fresh attestations. Only its successful, parsed, non-background foreground branch mints a receipt in a **factory-local WeakMap**. The receipt binds the target, request, source, profile, exact call/result fingerprint and both event sequence numbers. Cloning, JSON serialization, a lookalike property or a receipt from another binding instance cannot create cache authority. Failed results, malformed arguments, background/restart work, preview exemptions and job receipts never enter this memo.

The provider contract makes this fact permanent: `workspace/owned-range-subprocess.mjs` awaits the SDK direct completion and then `waitForExit() === true`. Unknown range absence keeps completion pending. For the actual managed foreground bash path, `managed-shell.mjs:40 → project-tool.mjs:61` awaits `ShellExecution.result()`, which awaits the provider's `done`. The pinned subprocess SDK retains the first confirmed absence as its permanent no-more-signals boundary; later waits return true. This concerns that original managed range/handle. A later command/job is new work, observed through full immutable-prefix history and fresh Native inventory. This optimization does not infer range settlement from successful tool text or from an arbitrary persistent shell result.

The lifecycle accepts cache authority only through the corresponding binding's `terminalForegroundReceipt` callback. For a qualified observation it also requires the actual bounded runtime identity shape: source/digest/policy, launch, admission epoch, recovery attempt, profile and Native process identity. It hashes that entire identity together with the bound target/request. Unsupported or absent identity disables memoization and retains the original fresh generic-proof behavior. Different valid pre/inventory/final identities prevent publication.

Each poll retains fresh source/owner/tuple assertions before inventory, after inventory and before publication, fresh jobs/children/PTY inventory, and a fresh provider-backed preview status. The memo stores no fresh runtime attestation across polls. History still checks every event, the complete immutable prefix and the original 16,384-event/8-MiB caps. The in-memory memo can therefore contain at most 8,192 completed pairs and cannot be imported from persisted evidence.

## Bounded progress and Stop

On the qualified receipt path, an observation attempts at most **four new cache-eligible foreground proofs**, serially. It stages receipts locally, then commits only after its final fresh identity, original deadline/signal and lifecycle epoch checks succeed. Excess new work adds `FOREGROUND_PROOF_PENDING` and returns `settled: false`; the runner continues ordinary observation under the same absolute primary deadline. Verified terminal receipts allow the next poll to make progress through the backlog. Proofs and unknowns stay in original history order.

Already qualified terminal calls require no per-call range request on later polls. Reuse retains the original evidence with explicit `request-local-terminal-foreground-reuse` provenance; it is not a new provider receipt. `foregroundProofProgress` reports actual new, reused and pending counts. Generic old proofs can still settle the current pass but switch the memo off, rather than acquiring cache authority from their shape.

Background, preview, job-kill/follow and other classification paths retain their original serial behavior. Cached foreground work cannot settle current jobs, child agents, PTYs, unknown tools or a pending result. Stop immediately advances the existing epoch and clears the memo. An earlier observer cannot publish or commit after that change. Existing bounded in-flight read overlap remains possible; the epoch is not claimed to cancel an already running provider read. Stop never waits for the observer before beginning cancellation.

The costly new foreground work on that path is bounded per poll, while ordinary history validation remains proportional to bounded retained history. With the existing concrete attester the plan is nine fixed owner reads plus eight per new foreground proof, and three Native inventory calls, excluding unchanged job/preview branches. Thus four new proofs plan 41 owner reads; a fully warm foreground memo plans nine. These are source-derived plans, not measured dispatch counts or promised latency.

The original **600-second primary**, **4-second observation/RPC** and **120-second maximum cleanup** limits are unchanged. A slow or unknown operation still fails closed. The optimization does not promise arbitrary disk/network latency fits four seconds.

## First observation failure

The copied runner retains a nonwritable, frozen `firstObservationFailure` before a different cleanup failure can replace it. Operation-local facts distinguish `STATE_READ`, `PAGE_READ`, `OWNED_WORK`, `VALIDATION` and `UNKNOWN`, with phase captured at start. They contain only fixed safe code/method enums, matching bounded HTTP status, attempt count, original budget, elapsed time, time since submit and deadline/abort flags. An HTTP status is attributed only when the error's method matches the actual awaited state/page method. Recovered 503 reads retain their existing retry ledger without creating a first failure.

Subsequent failures use two fixed PRIMARY/CLEANUP slots with counters capped at 64, a saturation flag and one latest safe fact. The legacy last-error code is sanitized. Raw error messages, arbitrary properties, headers, response bodies and credentials are excluded. Late callbacks cannot overwrite the first fact. Retry, Stop, checkpoint behavior and deadlines remain the copied original behavior.

## Validation and use

The two required portable CI rows run 16 lifecycle/receipt/progress regressions and nine runner diagnostic regressions. They use synthetic callbacks and clocks with the actual copied lifecycle/binding/runner modules. They cover forty-call progress, warm fresh barriers, forged/cloned/wrong-instance receipts, malformed/changed history, source/profile/admission/process/provider changes, background/preview/job order, unowned work, abort/deadline, Stop preemption, real runner backlog handling and first-error preservation through cleanup and late resolution. No socket, service, model or benchmark prompt is used.

Explicit future composition:

```js
import {createRootBindings} from './bindings.mjs';
import {createRootLifecycle, bindLifecycleClock} from './lifecycle.mjs';
import {runPrimary, realClock} from './runner.mjs';
// Supply these exports through the existing trusted driver composition seam.
// It already spreads the returned binding methods into the lifecycle inputs.
```

`source-manifest.json` pins this candidate and its unchanged production dependency. Fresh runtime/source/owner qualification remains the operator's responsibility. No authorization, successful provider proof, model execution or automatic next attempt is inferred by importing this module.
