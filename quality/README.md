# Verified project checks

`verify_project` is an additive Harness tool for the managed workspace runtime.
It does not change inference parameters, install packages, start application servers,
or create a second repair loop. Native shell confinement and the shared repair budget
remain authoritative. Declare the contract early and verify a thin working slice.

Create `.harness-quality.json` in the project root (adapt commands and sources):

```json
{
  "version": 1,
  "sources": ["src", "tests", "package.json"],
  "requiredKinds": ["build", "test", "browser", "acceptance"],
  "checks": [
    {"id":"build","kind":"build","command":["npm","run","build"]},
    {"id":"unit","kind":"test","command":["node","--test","tests/unit.test.mjs"]},
    {"id":"flows","kind":"browser","plan":".harness-browser.json","timeoutMs":60000},
    {"id":"business","kind":"acceptance","command":["node","--test","tests/acceptance.test.mjs"]}
  ]
}
```

Programs are direct argv arrays. Globs are **not** shell-expanded: list test files
or use the test runner's directory discovery. A command's nonzero exit is always
failure. Tests need a positive assertion count (Node TAP/spec, pytest/Playwright,
or .NET summary). Other runners may write `resultFile` JSON containing this process's
`HARNESS_QUALITY_RUN_ID` as `runId`, plus integer `passed` and `failed` counts.
Shell wrappers are refused. This is honest evidence accounting, not protection
against an intentionally dishonest project test program.

Create `.harness-browser.json` using the application's assigned port:

```json
{
  "version":1,
  "baseURL":"http://127.0.0.1:${PORT}",
  "viewports":[{"name":"desktop","width":1440,"height":900},{"name":"mobile","width":390,"height":844}],
  "flows":[{"name":"catalog","steps":[
    {"action":"goto","path":"/"},
    {"action":"expect","selector":"h1","minCount":1},
    {"action":"checkpoint","name":"catalog","imageContainers":[".product-card"]}
  ]}]
}
```

Supported steps: `goto`, `click`, `fill`, `press`, `expect`, `checkpoint`.
Each flow must start with `goto` and include a positive UI expectation: an empty
page with a screenshot cannot pass. Expectations support min/max count, textIncludes/textExcludes and `focused:true`
(active element with visible outline/shadow). Every flow needs a real screenshot.
Checkpoints check visible NaN text, visible broken images, declared image containers,
horizontal overflow and console/page errors. Unknown options fail to prevent silent
assertion typos. Requests outside the application's origin are blocked; proxy API
requests through the app. Use local assets for repeatable checks.

Run the app through `project-run` before browser verification. Prepared Chromium is
required; missing browser produces failure, never DOM-only replacement evidence.
Limits: 4 viewports, 16 flows, 100 steps/flow, 120s native tool budget. Split large
suites into stages. Output and actual PNGs live under `.harness/quality/`, excluded
from source fingerprints. Do not list generated files among `sources`.

`passed:true` means selected checks passed; only `complete:true` means all declared
required stages passed in this invocation. Evidence is invalidated by source changes;
the manager independently checks its authoritative source hash before accepting it.
After forced process termination a leftover `verification.lock` may need removal,
but only after confirming the previous verification process has ended.

For shops, acceptance tests should independently cover anonymous access to customer
data/outbox, ownership of idempotency keys, changed payload with the same key, missing
keys, payment validation, server-calculated totals, inventory and persistence after
reopening the database. UI checks alone cannot prove those properties. Review these
requirements before writing implementation; do not weaken assertions to make a run pass.

Before declaring delivery, run the documented package entry points exactly as a user
will invoke them, including their lifecycle hooks. Running a script body separately
does not establish that `npm test`, `npm start` or an advertised seed command works.
Verify primary user flows through the UI as well as the API; an API-only substitute
cannot establish that a form submits the correct payload. Keep screenshots and the
real exit status of each check. A failed or interrupted check remains unverified.

Managed shell verification can remove an exact terminal display filter and one
display-only status echo from a recognized verifier command. It executes the verifier
directly and preserves its real result; arbitrary compound shell programs are not
rewritten. Unsupported status-masking constructs produce actionable feedback instead
of a milestone pass. Quoted pattern characters and ordinary redirections retain their
meaning. Repeated tool-error counters distinguish operation targets; a completed
success resolves only that operation's errors and never resumes a stopped run.

Conventional private credential paths are excluded from source fingerprints,
checkpoints, Changes and application build snapshots. This filename policy does not
detect arbitrary embedded secrets or replace project isolation. Existing private
recovery copies are retained; restoring old code does not overwrite runtime keys.

Self tests (no model/GPU calls):

```
node --test quality/core.test.mjs
PLAYWRIGHT_BROWSERS_PATH=/data/harness/dev/browsers node --test quality/browser.test.mjs
```

The browser suite serves a disposable miniature shop and requires real Chromium.
It checks working output and independently injects NaN, missing images, overflow,
and console errors at desktop/mobile sizes, then validates PNG signatures/dimensions.
It measures the verifier, not the coding model's success rate or inference speed.
