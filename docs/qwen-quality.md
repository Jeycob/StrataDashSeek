# Verified quality for local Qwen runs

Status: implementation in progress on `feat/qwen-quality-gates`.

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

- Negative fixtures: failed build, masked status, zero tests, stale result,
  source changes during checks, missing browser, missing images, invalid prices,
  anonymous outbox, and cross-customer idempotency replay.
- Positive fixture: real build/tests plus real Chromium on desktop and mobile.
- Verify plugin cancellation and manager event payloads without GPU inference.
- Install additively only after coordination; preserve profile edits and active
  conversations. Never restart or change model parameters for this rollout.
- Any claimed model speed/quality improvement requires a controlled paired
  task; regression detection results are not a claimed model success rate.
