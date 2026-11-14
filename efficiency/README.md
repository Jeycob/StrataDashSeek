# Efficient local Qwen work

Implementation branch: `feat/qwen-efficiency`. Ownership: only `efficiency/`.
The workspace runtime owns project isolation, native shell, checkpoints and the
single repair budget; HomeAI owns Docker, lifecycle and sleep. This extension
does not create another repair loop or patch the model proxy.

Implemented units:

1. Stable system instructions; semantic runtime context; bounded, archived shell
   logs; a tool for relevant file excerpts and current changes.
2. Narrow edits after a verified milestone. Large native overwrites require a
   one-use explanation tied to the current source hash and verification plan.
3. Observe canonical prompt/tool fingerprints. Preserve historical messages and
   tool-call/result pairing; do not reorder provider-owned tool declarations.
4. Record queue, model, tools, repair and verified success. Allocate a billing
   interval once across concurrent tasks; keep idle/unknown cost explicit.
5. Optional request-level FIFO scheduling, with at most one local inference
   stream, cancellation-safe release and overlap between inference and tools.
   Replace the old whole-turn gate only after coordinated isolated validation.

No speed or model-quality gain is claimed until measured on the actual engine.
Installed Strata is not assumed to accept vanilla llama.cpp flags. Read its
actual metrics and compare repeated stable prefixes with deliberately changed
prefixes. Do not restart or retune the live engine during this rollout.

## Context and edits

`focus_context` returns the task card, unresolved checks, Git change summary and
at most six bounded file excerpts with hashes. With no files it selects a few
changed source files. Original messages, constraints, tool-call/result pairing,
file read outputs and images are preserved. Only long command-tool text is
compacted before it enters model history. Complete output is saved by content
hash under `.harness/efficiency/logs/`; repeats share one archive and return a
shorter diagnosis. Exit code, timeout and error status are always included.
Archives are capped at 256 files/32MiB; when full, compaction is skipped instead
of claiming a truncated archive is complete.

The fixed system section contains no task path, clock or changing status. The
work card uses native append-only runtime context and changes only with semantic
facts. Native Harness already orders declarations canonically; this plugin
observes system/tool fingerprints and does not rewrite adapter-owned messages or
tool order. Compaction keeps the existing factual bounded handoff policy.

After a successful verification milestone, native `write`, `edit` and common `apply_patch` large
overwrites are checked. A replacement removing over45% and at least40 lines (or
most of a large minified file) needs `explain_rewrite`: exact current file hash,
concrete cause and regression-check plan. The explanation is one-use and is not
a human approval flow. Small edits/new files continue normally. This bounded
classifier is not a parser of arbitrary shell commands or every patch dialect;
shell changes remain subject to native confinement and final source-hash-bound
verification. The single workspace repair budget remains authoritative.

## Scheduler

`install.cjs` exports a semantic YAML patch that replaces only the verified
`cloud-homeai-turn-queue-v1` implementation. Never mount two active schedulers.
Apply it only after checking native running sessions, model busy/queued and the
other chats' maintenance/cold-cycle work. Existing lifecycle tracking protects
the entire turn, including tools; it is neither removed nor replaced.

Request FIFO holds one permit until its actual async iterator fully unwinds.
Cancellation cannot release a GPU permit while a provider is still working.
Other projects may infer during a tool/build phase. A separate FIFO limits
heavy native tool operations to one; ordinary reads retain native scheduling.
`schedule:false` provides observation/policy with the legacy scheduler retained
for controlled comparisons. Cache switching can offset concurrency gains, so
real traces must distinguish responsiveness from total accepted-task throughput.

## Measurement and cost

The append-only private ledger records model wait, model wall time, first token,
tools, repair intervals, disjoint SDK token counters and system/tool hashes.
Repair is an overlay after failed structured verification, including a failed
or cancelled attempt through turn end; do not sum it with its component phases.
Engine prefill/decode/reuse are taken from the actual Strata `/metrics` schema.
Only one unique new engine record inside the serialized call is attributed;
ambiguous/external activity leaves measurements unknown. No timings are guessed
from token count. At32MiB the ledger stops with an explicit incomplete marker.

`billing-sample.mjs INSTANCE KEY_FILE [OBSERVATIONS_JSONL]` reads only the selected
Vast instance. It never prints a credential or copies one to the server. Storage
is separated from `dph_total`, not added twice. `billingWindows()` derives short
windows only between matching price/state observations; gaps and transitions
remain unknown. These are hourly-rate estimates, not invoice reconciliation;
network and unrecorded external API charges are explicitly excluded.

`billing-daemon.mjs` is a separate root-only reader of the existing idle guard's
Vast key, not a new credential copy. It samples once per minute and writes only
sanitized observations/windows readable by Harness. Coordinate this supervisor
entry with HomeAI (no supervisor restart during active work):

```js
launch('efficiency-billing','/usr/bin/flock',['-n','-F',R+'/root-secrets/efficiency-billing.lock',R+'/node/bin/node',R+'/app/efficiency/billing-daemon.mjs'],true);
```

The collector does not touch idle timestamps or create a keep-awake lease.
It re-reads the key for rotation, bounds observations at8MiB and exposes gaps
after downtime instead of inventing compute uptime. Concurrent copies share the
flock. No extra package installation or account is required.
For the coordinated vault migration, set the non-secret absolute file path in
`HARNESS_VAST_KEY_FILE` or `guard.json`'s `vastApiKeyFile`; the guard and collector
can share one RAM-materialized key. The legacy root-file path is only a fallback.

`node efficiency/report.mjs EVENTS_JSONL [BILLING_WINDOWS_JSON_OR_JSONL [FROM_MS TO_MS]]` reports allocation
of each rental interval once, split equally among active root tasks. Delegated
children do not create an extra share or user attempt. Idle time remains visible
as unattributed cost. Failed attempts contribute to cost; only the latest attempt
with current-source `verify_project complete:true` at turn end enters the success
denominator. That proves the declared contract, not arbitrary business correctness.
Missing rates, incomplete journals or zero accepted tasks never produce a false
zero-cost success. Task/server totals reconcile without double counting.

## Validation

`node --test efficiency/core.test.mjs efficiency/plugin.test.mjs` tests context,
rewrite policy, original outcomes, FIFO cancellation, overlapping phases and
shared/unknown billing. `efficiency/smoke.cjs` runs an isolated real Harness3197,
fake provider18897 and separate project roots; it compares whole-turn and request
gates and exercises the actual native tools. It must run after coordination and
does not use GPU inference.

The live synthetic cache probe on Strata0.1.59 used5445 prompt tokens: cold
prefill4802.4ms/reused0; identical repeat393.0ms/reused5438; changed early system
prefix4759.3ms/reused0. All four responses were correct. Reordering two supplied
tools in this build did not invalidate reuse; no general order-related speedup
is claimed. These short synthetic results are not a full coding-task benchmark.

At the current checkpoint, 28/28 local tests passed: 24 regressions plus four
integrations using the actual pinned Cordis/Tools/SystemPrompt SDK and YAML
parser, not mock replacements for those services. They exercise canonical
outcomes, monotonic rewrite denial, appended context, stable tool declarations,
and another task's inference during a heavy tool with max one provider stream.
Set `EFFICIENCY_SDK_ROOT` to the pinned runtime's `node_modules` and run
`node --test efficiency/core.test.mjs efficiency/plugin.test.mjs efficiency/sdk.test.mjs`.

After provider capacity recovered, the isolated Linux native-Harness fixture
passed all eight checks, including preserving the original file on a denied
overwrite, focused context, log errors, acceptance events and stable tool order.
The final synthetic second task took1669ms with the whole-turn gate and148ms with
the request gate; paired wall time was2333ms versus2185ms. This used a fake model,
not GPU inference, and does not establish a Qwen throughput gain.
The production scheduler was then replaced through HMR after two fresh checks
confirmed no running or queued work. Harness PID139 was preserved, the model was
not restarted, and the profile was backed up. Exactly one efficiency scheduler
is configured and loaded; the legacy scheduler is absent. The resumed-session
32768 output-token ceiling remains in force. HomeAI owns activation of the
separate billing collector. See `deployments/release-20261114/` for evidence.
