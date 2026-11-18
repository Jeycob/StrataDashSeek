# B10 next pair — disabled source candidate

DS is global position 3, after the two actual finalized B03PAIR04 records. HomeAI is position 4, after those records and this same new B10 DS pair. This package creates no session and performs no automatic repair. Main 600s; at most one separately authorized 300s repair remains the frozen campaign policy. It does not implement a repair trigger.

Both checked-in configs are disabled. All actual session/workspace/project/root, fixture receipt, code/input locations, checkpoint locations, record/proof pins, authorization and clocks remain NULL. The planned pair/run/attempt labels are source labels. Doom session `session-5007e9ba-0d62-4255-b375-e8b4fb4fb39d` is always ineligible. No previous qualification, CP, request, runtime clock or session was recycled.

## Reuse and concrete changes

- Canonical Git04b adapter `3dc9dae4…` and runner `3d4840bd…`, lifecycle, native transport, finalizer, bindings and stop scope are referenced unchanged from their existing paths. Runtime/service is separately pinned to `266196e…`; Git04b is the canonical operator module producer, not an app cutover. Exact hashes are in `frozen-pins.json` and `runtime-pins.mjs`.
- `driver.mjs` derives the canonical composition body; changes are the B10 slot/prior validator, exact per-slot record matching, a captured owner restart during QA, and matching its actual receipt before R3 PASS. The 64MiB/2048 budget, four-second effect caps and finalizer body are unchanged.
- `runtime.mjs` derives the private B03PAIR03 concrete runtime. It retains protected operator-common validation, Linux Root/UID1001 split, signed service witness, strict profile, fast guards, owner routes and SDK transport. It replaces the CSV inspector with the six-file B10 inspector, changes only the fresh seed phase, and wires the existing owner `restart` operation to the existing `project_preview_restart` provider. This is a concrete runtime factory, not an external callback placeholder.
- `runtime-guard.mjs` and `frozen-inputs.mjs` are byte-for-byte copies of the private B03PAIR03 sources. The original B03PAIR03 directories and Root/D B03PAIR04 work were not modified.
- `supervisor.mjs` derives the private controller with B10 identity/order and `restart` added. Original primary deadline stays armed during QA. Repeated Stop never extends the first 120s cleanup cap. Unknown persistence/restart/cleanup remains HOLD; no alternative dispatch or new lease is inferred.
- `prior.mjs` verifies bounded actual raw final-envelope bytes, hashes, new B03PAIR04 identities, original clocks, accepted submission, complete history, settled visible fence and durable chain. It privately brands the rows; caller booleans and another slot's rows are rejected. Settled quality FAIL is a valid campaign predecessor; HOLD is not.

## Root qualification and command

Root owns the next live action. Prepare a separate reviewed, protected bound copy of the configs with fresh sessions and two copies of the original six-file B10 fixture (no `notes.json`). Bind actual B03PAIR04 final CP path/hash pairs; HomeAI additionally binds the actual final CP of this new DS pair. Fill the actual code/frozen/QA roots, per-slot record SHA, fixture receipt, authorization, checkpoint directory and fresh restart qualification file/hash. There is no enable flag or environment fallback.

The seed receipt schema is `{phase:'TWO_FROZEN_B10_FIXTURES_PREPARED',targets:[{sessionId,workspaceId,projectId,rootIdentity,harnessIdentity}]}`. The concrete UID1001 inspector reads all six files itself and compares them to the frozen pins; the receipt cannot assert their contents.

The protected restart capability qualification has `{version:1,kind:'B10_OWN_PROCESS_RESTART_CAPABILITY',sourceCommit,ownedRangeProvider:true,operation:'restart',sdkTool:'project_preview_restart',target:{sessionId,workspaceId,projectId},runtimeTupleSha256,qualifiedAt}`. Root produces it from the current verified provider contract and exact current runtime tuple; it must be at most 60s old at preflight. `runtimeTupleSha256` is the existing operator's hash of its canonical `{target:slot.target,metadata:fastGuard.metadata(input),rootIdentity:actualFixture.rootIdentity}`. The file and its hash remain NULL here. This startup capability qualification is separate from the actual process restart required for R3.

After binding, the first command is:

```sh
node <protected-producer-root>/benchmarks/b10-next-pair-source/ds-first/cli.mjs
```

Its private stdin uses JSON lines `{"op":"start"}`, `{"op":"status"}`, `{"op":"restart"}`, `{"op":"accept","report":...}`, `{"op":"stop"}`. Root's existing QA collector runs only after `implementation-ready`, under the emitted **original** `primaryDeadlineAt`. Before `restart`, it reads the saved note and version through the actual user preview. The `restart-completed` event supplies the captured request/before/after process receipt. QA reads the note again through that same preview and supplies `report.restartEvidence` with `kind:'B10_OWN_PROCESS_RESTART'`, sourceCommit, exact target IDs, that unchanged receipt, `beforeNote` and `afterNote` (`id,title,body,version`). Same content/version, new job and generation, same preview ID/origin/expiry are required for R3 PASS. Reload does not satisfy it. All 19 frozen checks and canonical collector identity/QA-settlement evidence remain mandatory. Unknown restart never gets resubmitted. HomeAI uses the analogous `homeai-second/cli.mjs` only after actual DS final settlement.

The checked-in command currently returns `disabled/HOLD`, exit 2, before auth/runtime work. That is intentional. Actual Root qualification, user preview and live acceptance are **PENDING**, not benchmark results. B's independent quality/server-producer work remains separate; this package adds no lifecycle or custody exemption and does not claim that unwired quality producer support exists.

## Local evidence

```sh
node --test benchmarks/b10-next-pair-source/contracts.test.mjs benchmarks/b10-next-pair-source/composition.test.mjs
```

17/17 source tests passed with bundled Node v24.22.3 on 2026-11-18. They run the real canonical adapter → runner → lifecycle → finalizer with in-memory SDK-shaped events and durable-writer simulation for DS and HomeAI, plus actual fixed owner HTTP request shape through EventEmitter transport injection. No socket/model/SSH/browser/session was opened. Coverage includes six-file UID1001 inspection, saved-state/symlink/read-change rejection, final-prior ordering and hashes, actual restart receipt, original QA/cleanup deadlines, 4s caps, 64MiB/2048 budgets and disabled CLIs. These are local source tests, not runtime qualification or product QA.
