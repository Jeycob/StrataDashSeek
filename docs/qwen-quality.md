# Verified quality for local Qwen runs

Status: implemented and tested on A4000 on `feat/qwen-quality-gates`.
Plugin files are staged additively; shared profile activation follows the separate
workspace runtime's isolated native integration fixture.

The observed bottleneck was completion and verification, not just decode speed.
A faster decoder still produced long repair loops and a nominally complete web
app with missing images, invalid displayed money, and alternative paths leaking
another customer's order. A passing backend suite did not establish UI quality.

## Scope and concurrent ownership

- `quality/` and this document belong to this change.
- Workspace isolation, prepared runtimes, generation parameters, repair budgets,
  session controls, and UI belong to `feat/workspace-runtime-improvements`.
- Docker, VM lifecycle and maintenance leases belong to the container workbench.
- Keep the existing completion guard. Do not add a second continuation loop.

## Implementation contract

1. Declare a small `.harness-quality.json` near the start of an implementation.
   Check a working vertical slice early rather than rewriting the entire UI.
2. Run build/test/acceptance programs as argument arrays, preserve their real
   exit status, bound runtime/output, and reject a zero-test success.
3. Use the prepared real Playwright browser for declarative UI checks. Check
   visible output, images, console errors and horizontal overflow, not just HTTP
   200 or a successful frontend build. Produce actual PNGs and a JSON result.
4. Record the contract and source fingerprints around verification. Concurrent
   source edits invalidate the result. Never label skipped/blocked work passed.
5. Publish measured verification to the single workspace manager. A failure is
   evidence for its repair budget; an outdated pass must not reset that budget.
6. Return compact actionable diagnostics to the model instead of entire logs.

This is a verification mechanism, not a universal proof of satisfying arbitrary
natural-language requirements. Project authors must declare meaningful checks;
test programs and their source remain reviewable and are not trusted merely
because they print a green number. It does not grant extra filesystem/network
permissions or silently install runtimes.

## Agreed runtime integration

Read `workspace-runtime/review` for `{ sessionId }` to obtain the managed root,
budget, checkpoints and authoritative `sourceHash`. Publish
`workspace-runtime/verification` with `sessionId`, `kind`, `exitCode`, compact
`diagnostics`, `sourceHash`, `checksPassed`, `checksTotal`, and `artifactPaths`.
Re-read the source hash before accepting evidence. Native project execution and
its workspace-write policy remain responsible for command confinement.

## Validation before rollout

- Negative fixtures implemented: nonzero process despite printed success,
  shell masking, zero tests, stale result, source changes during checks,
  unavailable browser, missing images, invalid prices, overflow and console errors.
- Shop-specific anonymous outbox and cross-customer idempotency acceptance tests
  remain project requirements; this generic verifier does not invent coverage.
- Positive fixture: real build/tests plus real Chromium on desktop and mobile.
- Verify plugin cancellation and manager event payloads without GPU inference.
- Install additively only after coordination; preserve profile edits and active
  conversations. Never restart or change model parameters for this rollout.
- Any claimed model speed/quality improvement requires a controlled paired
  task; regression detection results are not a claimed model success rate.

## Measured validation

On the existing A4000 host, Node v24.21.0 and prepared Playwright 1.65.1:
`node --test quality/core.test.mjs quality/browser.test.mjs` passed 18/18 tests,
0 skipped, 0 failed, in 5.02 seconds. No GPU/model inference was requested.
The browser regression fixture produced and checked 10 actual desktop/mobile
PNGs across five shop variants. A further end-to-end core-driver check produced
two more PNGs and checked structured run nonce, source fingerprint and artifacts.
The test cleans its temporary fixture and evidence after assertions.

The positive shop passed; NaN prices, missing product images, horizontal overflow
and console errors were each rejected independently on both viewports. Unit tests
also cover process timeout/cancellation, concurrent verification locks, bounded
logs, partial vs complete stages, malformed output, native confinement arguments,
single manager reporting and rejection of a changed authoritative source hash.
Mocked manager tests do not establish live Harness registration; that is owned by
the joint native fixture before profile activation.

## Recommended order for Qwen IQ3_S / A4000

1. Establish build, business acceptance and browser checks before broad styling.
   Include the negative ownership/idempotency cases from `quality/README.md`.
2. Implement one usable vertical slice, verify it, then expand. Return a compact
   diagnosis and exact evidence path to reduce repeated full-file rewrites.
3. Use the shared repair budget and best checkpoint; avoid parallel continuation
   guards that each spend another token budget on the same failed stage.
4. Compare reasoning presets with an identical task and fixed tools/runtime in
   the workspace-runtime workstream. Score functional acceptance, visual defects,
   time to an accepted solution and total billed cost, including failed attempts.
5. Only then tune inference settings. The earlier faster decode rate did not
   establish faster delivery of a correct shop. This change deliberately makes
   no claim of a measured token-speed or model-success-rate improvement.
