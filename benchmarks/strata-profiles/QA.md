# Record the ordinary #16 QA result once

This opt-in bridge runs inside the coordinator's existing authenticated Playwright QA script. It uses the same Native page and the delivered preview page. It never submits a prompt or starts, restarts or switches a service. Integrate the #16 source definitions and the `/api/workbench/qa-receipt` contribution first.

Before the already planned **single original submit**, prepare its original #16 input files in the ordinary SID and call:

```js
import {beginCase, finishCase} from './benchmarks/strata-profiles/qa.mjs';

const directory = '/operator-evidence/one-planned-case';
await beginCase({
  nativePage, sessionId, scenario: 'counter', // or 'b03', 'b10'
  directory, pairId: 'planned-counter-config-pair',
  // Use only the preregistered conditions; omit unknown conditions.
  cacheCondition: 'cold', budget: {mainSeconds: 600, maxRepairs: 0},
});
// The existing operator now makes the one authorized original submit using
// the exact inputs/<scenario>.prompt.txt bytes. This module does not submit.
```

Choose the already saved sampling profile before `beginCase`. The receipt retains that requested snapshot separately from actual response routes. `beginCase` checks every prepared input's bytes through the existing **own SID** download API. B10's `original.test.mjs.fixture` source must have been prepared as `original.test.mjs`, as #16 already specifies. It records the current event cursor, source SHA and runtime epoch before the prompt. Missing runtime identity or changed inputs stop preparation; they do not cause another submission. Do not reuse a directory or begin a new record after submitting merely to fill missing timing.

Once the ordinary result is delivered and its preview is already open:

```js
const result = await finishCase({
  nativePage, previewPage, directory,
  // Counter selectors identify the actual visible controls. The preserved
  // #16 reference uses these accessible names; other outputs may differ.
  counterSelectors: {value: '#value', plus: 'Přičíst', minus: 'Odečíst', reset: 'Reset'},
});
```

The original matching SDK request must already be completed before checking starts. The bridge reloads the existing preview tab to discard any older DOM, then uses the normal preview **status** operation to verify this SID, preview identity, generation and page origin before and after checking. It requires the same completed turn/end sequence afterwards. It does not restart or reopen the server. The bridge performs:

- Counter: real clicks for 0 → 1 → 0 → −1 → 0, plus an independent own-session file read proving `index.html` exists and its byte count. The original prompt's model-issued terminal check remains a separate #1 observation.
- B03: upload the original CSV through the labelled input, click its load button, compare the actual displayed summary against the original `expected.json`, click download and compare the downloaded JSON. This is #16's compact smoke, not a replacement for all official B03 criteria.
- B10: create a new note through the UI, type its title and text, save and verify the real response. Create another own QA note through the UI, exercise the original concurrent PATCH 200/409 oracle at version 1, then verify version 2, winning text and unchanged state after a stale PATCH. Existing notes are not edited or deleted. The two new synthetic QA notes remain as evidence.

The script automatically writes `begin.json`, `result.json` and a one-run `history.json` with restricted file permissions and no overwrite. `result.json` holds the observed values, check outcome, source identities and compact receipts; it contains no conversation text, credentials or raw model streams. A correctness assertion fails the check; unavailable transport or incomplete evidence stays unconfirmed. Review the result as with the existing QA evidence, then export one or two completed receipts:

```sh
node benchmarks/strata-profiles/qa.mjs export A/result.json B/result.json new-profile-history.json
```

Publish the reviewed output through the existing root-owned runtime-status path documented in [STRATA_PROFILES.md](../../docs/STRATA_PROFILES.md). The exporter accepts up to 100 existing result files within the 32-KiB report limit, so all three ordinary cases can be retained together. Each pair still has at most two runs. It performs no interaction or inference. Actual pairs use the same preregistered pair ID and display workspace; different tasks do not become a configuration pair. Do not hand-enter checks or measurements into the output.

## Timing and memory are distinct evidence

The SDK inbox insertion event supplies the exact original admission time and message ID. The corresponding entered human message must lead to one completed turn; additional human input, mismatched turns, incomplete output or a different prompt hash cannot borrow its receipt. The model completion time comes from that matching `turn/end`, not the last arbitrary event. The final QA receipt is read **after** independent checks; its server time records acceptance and includes receipt latency. The UI labels this basis separately from admission-to-model-completion. No browser/host clock subtraction is used.

Only the already-produced runtime telemetry file is sampled. RAM is labelled host/container used memory, and VRAM is labelled the whole GPU. It is a shared service sample, **not this run's RSS, peak, incremental use or isolated allocation**. It appears only if both receipts have the same SID/source/runtime epoch, the monitor start identity is unchanged, and the sample falls inside original admission through recorded QA acceptance with a fresh timestamp. A missing initial observation, monitor restart, old sample, changed runtime or missing metric remains unknown. Capacity and mapped-file size are not substituted for usage. Quantization remains unknown without its separate run-bound physical receipt.

The current context size comes from the qualified existing service observation. Cache condition and budget are preregistered conditions, not invented measurements. Omit them when unknown; the table then declines a quantitative pair delta. Preserve recorded waits and other conditions required by [#17](../../examples/app-starters/MEASUREMENT.md). A small smoke pair does not establish a general performance improvement.

## Local verification

`workspace/qa-receipt.test.mjs` uses the actual pinned SDK AgentLoop with a local adapter, checking admission/turn linkage, absence of raw text, separate timestamps, zero values and unavailable/restarted/foreign observations. `qa.browser.test.mjs` performs actual browser interaction on the preserved #16 counter, a synthetic B03 import/download fixture and a temporary copy of the original B10 app. It accepts the version-guarded fixture and rejects the original faulty one, and exercises automatic evidence export and prepared-input mismatch. These fixtures prove the bridge; they do not claim a new live model result.

Set `HARNESS_NATIVE_CLI` and `HARNESS_PLAYWRIGHT_MODULE` as for existing SDK/browser tests. `HOMEAI_SMOKE_ROOT` optionally points to the existing #16 definition directory when testing an isolated commit before integration. The tests install nothing and make no live requests.
