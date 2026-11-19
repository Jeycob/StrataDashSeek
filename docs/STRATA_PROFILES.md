# Saved Strata profiles and recorded comparisons

Open **Strata profiles** in the Native conversation sidebar. Save a name, maximum output tokens, thinking-token budget, temperature and Top P. Saving does not apply the profile. Select a saved profile and choose **Use selected profile**; choose workspace defaults to reset. Profiles belong to the workspace, while the selected snapshot belongs to the conversation and persists across reloads. Editing a saved profile through the API does not change an already selected snapshot until it is selected again. There are at most 20 profiles per workspace.

These four controls reach the existing `strata-vast` loopback proxy on the next model request. An already running request retains its frozen values. Output remains bounded by the request and workspace limits; the thinking budget is capped at half the output limit. Selecting reasoning Off keeps thinking disabled. Other providers do not receive this proxy header.

**Requested quantization** is a saved deployment request. Applying a profile does not replace model weights, change the global deployment, or start a model run. **Currently loaded model** uses the shared settings-health controller and its fresh `/phone/api/monitor` sample. It remains unknown when that helper or a valid sample is unavailable. The model used by a past response remains the independently recorded request route, not the current selection or loaded-model indicator.

## Import existing benchmark results without another model run

The offline importer consumes ordinary N06 collector artifacts already produced for a run:

1. The frozen `*.record.json` plan with prompt, fixture, acceptance and budget identities.
2. The actual `actual-terminal.json` receipt with collector SID, workspace, project, source/runtime SHA, request ID and prompt digest.
3. Its `actual-final-metrics.json` or `actual-final-diagnostic.json` read-only final checkpoint projection.

It checks that the three artifacts name the same run, attempt, session, source, request and frozen input. A plan alone is rejected. Each source file is limited to 1 MiB; the output is limited to 32 KiB. The output contains SHA-256 references to the source files, never their private filesystem paths or conversation text. Existing output files are not overwritten.

```sh
node benchmarks/strata-profiles/import.mjs \
  --workspace WORKSPACE_TO_VIEW_THE_PAIR_IN \
  --output strata-profile-runs.json \
  --run A.record.json A.actual-terminal.json A.actual-final-metrics.json \
  --run B.record.json B.actual-terminal.json B.actual-final-metrics.json
```

The display workspace is an explicit import destination; each original workspace and SID remain in the frozen-input details. The original collector pair ID groups runs. A and B identify submission order, not a fabricated model variant. At most two different attempts may belong to one imported pair. A single recorded attempt can be displayed with comparison unavailable. This command has no network client and cannot submit, restart or schedule inference.

Publish the reviewed output as root-owned `/data/harness/runtime-status/strata-profile-runs.json` through the existing operator delivery path. Its directory and file must pass the same protected-file checks used by runtime status: no symlinks, single file link, trusted owner and write permissions on Linux. The application reads this fixed path; the browser cannot upload a result or assert that a measurement passed. Refreshing the pane only reads the report. Do not publish test fixtures as operational evidence.

The importer verifies artifact consistency and records their exact digests. It does not certify arbitrary supplied files as authentic; use the operator's existing exported collector evidence. It preserves unknown correctness when independent acceptance checks are absent, even if a run stopped at its deadline. A pass needs a complete set of independently evidenced passing checks. Time to accepted result needs that pass and its recorded acceptance timestamp. Request routes need the complete bounded route projection. Configured model names are never promoted to serving identity.

## Comparison and measurement boundaries

Reuse the existing [#16 prompts, inputs and oracle](../benchmarks/roadmap-16-smoke/README.md) and [#17 paired measurement protocol](../examples/app-starters/MEASUREMENT.md). The importer hashes the collector's canonical sorted fixture and acceptance hash lists; it does not introduce a second benchmark or change those definitions. Keep only configuration different for a configuration experiment, and record cache state, context, budget, source revision and waits. Historical HomeAI/DS comparisons remain that comparison; importing them does not turn them into a Strata quantization experiment.

A pair is comparable only when both complete frozen identities agree: definition, prompt/input/acceptance hashes, runtime revision, budget hash, known cache condition and context size. Missing conditions keep the pair unavailable for a delta. Quantization comparison additionally requires the same actual provider/model and a measured configuration digest for both runs.

The existing N06 final projection has no run-bound physical quantization or resident-memory receipt. Its importer therefore leaves both unknown. In particular, a later B005 OS proof or current health sample cannot fill an older run's missing data. The table supports separately collected authoritative samples only when the protected report binds them to the run's epoch and interval:

```json
{
  "epoch": "recorded-runtime-start-identity",
  "submittedAt": 1795000000000,
  "finishedAt": 1795000010000,
  "serving": {
    "epoch": "recorded-runtime-start-identity", "observedAt": 1795000005000,
    "evidenceId": "receipt-digest", "provider": "strata-vast", "model": "observed-id",
    "quantization": "observed-format", "configurationSha256": "64-character-lowercase-sha256"
  },
  "memory": {
    "epoch": "recorded-runtime-start-identity", "observedAt": 1795000005000,
    "evidenceId": "measurement-digest", "kind": "sample", "rssBytes": 1024, "vramBytes": 0
  }
}
```

This is a schema illustration, not a measurement. `sample` and `peak` are distinct; mapped-file bytes are not RSS, capacity is not usage, and a missing value is not zero. The shipped importer deliberately cannot invent those samples. The report and UI show evidence IDs and measurement times when provided by a qualified collector.

## Local checks and integration

`node --test workspace/generation-profiles.test.mjs benchmarks/strata-profiles/import.test.mjs workspace/settings-manager.test.mjs vast/model-proxy.test.cjs` checks persistence, immutable selection, actual adapter controls, importer joins and incomplete evidence. `workspace/native-ui/generation-profiles.test.cjs` uses the pinned Native SDK and a browser, with no model inference. Optional `HOMEAI_PROFILE_HISTORY` points to an actual locally imported report for a UI readback. The Native fixture uses the bundled settings-health module to check both fresh and stale model observations.

The source modules are wired into the native bundle builder. The integrator regenerates `client.js` after combining UI changes and settings-health. Live acceptance still needs the integrated build, an existing ordinary session, save/select/reload, an observed next-request proxy record, and a published report readback. No live Strata variant or physical memory comparison is claimed by the local browser test.
