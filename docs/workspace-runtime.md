# Projects, files and verified stages

Open **More → Projects and files**, or press **Ctrl+Alt+P** on a PC. The `…`
button beside a workspace opens its general settings. Choose EN/CZ in the panel.

## Independent work

A new conversation is an independent task boundary. Automatic mode creates a
native Git worktree from an exact available local commit, or a fresh directory
for a non-Git source. Uncommitted source edits are deliberately preserved in the
source checkout. Every managed project receives four reserved ports and a
private `.harness/data/app.sqlite` database path. Applications must use the
assigned environment variables; the runtime cannot rewrite hardcoded database
URLs or ports inside arbitrary application code.

Existing conversations keep their current directory. Explicit **Continue in
the same project** is available, with a writer lease that rejects concurrent
writers to the same directory or its descendants. Leases include process
identity to avoid treating a reused PID as an active owner. Native background
jobs and child sessions protect the lease until they are finished.

Managed shell work uses `project_exec` with a narrow native filesystem policy.
Git worktrees receive write access only to their commit metadata directories;
the source checkout, shared hooks and shared Git config are not granted.
`.harness/` is ignored by Git in newly isolated projects. This is protection
against accidental interference, not a multi-tenant security product.

Native Harness, the Apps control service and project command execution still
share the `harness` OS account. Write confinement and separate project folders
do not provide complete read or process-signal isolation from credentials and
services owned by that same account. Use owner-trusted projects. Separating
executor identities and placing credential access behind an authenticated,
project-scoped broker is a proposed change requiring owner approval; it is not
installed. Moving values into Infisical alone does not remove this boundary:
the running services still need bootstrap identities and runtime credentials.

## Files and conversations

The file panel lists folders, creates files/folders, edits UTF-8 text, renames,
deletes, uploads and downloads. Saves, rename and deletion use observed file
versions: a stale editor cannot silently overwrite a changed file. Symlinks,
path escapes, `.git` and private `.harness` state are excluded. Files are read
from the effective remote project directory, not a stale Windows source path.

Editor limit: 1 MiB; new uploads: 4 MiB; downloads: 10 MiB. Binary/large files
have download/delete controls; binary rename currently uses download and upload
under a new name. Active writers and read-only sessions refuse file mutations.
Conversation deletion moves it to a reversible Trash. Its files and actual
history remain retained; restore is available. Running conversations cannot be
trashed. This does not claim permanent erasure or reduce project disk usage.

## Model defaults and reasoning

Workspace settings select provider/model, reasoning level, output limit,
temperature, top P and Strata thinking budget. They apply to newly created
conversations. A manual model selection in an existing chat remains effective.
Per-request generation overrides currently target the local `strata-vast`
adapter; other providers keep their native supported model/reasoning behavior.

The adapter clears thinking options for Off. Low defaults to 2048 reasoning
tokens and Medium to 4096; a workspace-specific budget is applied when its
effort matches the actual selected effort. Bounds are checked again by the
adapter. `/data/harness/state/model-wire.json` retains at most 100 effective
parameter records, without prompts, answers or credentials.

## Prepared tools and enforced review

The local startup preflight opens real Chromium, checks the console, renders a
WebGL pixel, saves a screenshot and checks .NET availability. Normal startup
does not install or download anything. Browser rendering uses CPU software
rendering and does not consume LLM GPU memory. `project_exec` exports prepared
Playwright/.NET paths and private package caches, home/temp and database values.
The optional .NET environment has an independently verified offline compile/run.

Declare `.harness-quality.json` early. Use **verify_project** for build, test,
browser and acceptance milestones. Browser plans require navigation, a positive
UI assertion and a real screenshot checkpoint. A zero-test result, nonzero
process exit or stale source is not accepted as success. See [quality
contracts](qwen-quality.md).

Three failed rounds without measurable improvement, or three repeats of the
same normalized error, pause the run before another inference/tool step. A
stage reaches automatic verification after its configured step interval
(default 60); step counts alone do not require another approval. A new explicit
owner message starts a fresh repair attempt, including its failure streak and
repeated-error counters. Measured verification baselines, source checkpoints
and prior session results remain retained. Internal followups, retries and
subagents cannot renew this attempt, and an unresolved verification stays
fenced. **Run review** shows the best source checkpoints. Restoring one first
saves the current sources; it does not overwrite databases or dependencies.
Checkpoints include at most 5000 source files/32 MiB, with each file at most
1 MiB. Larger assets are outside this recovery feature. Superseded checkpoint
generations are pruned; referenced best versions remain retained.

If repeated failed shell checks omit their numerical totals, the controller
can run one current-source contract check of the same kind before deciding
that repairs stalled. Quality reports distinguish measured counts from failure
placeholders. A valid failed check establishes one canonical repair baseline
and the existing repair window; it does not claim progress over a potentially
different old test suite or mark a stage passed. The prior baseline is retained.
The exception is persisted before dispatch and cannot be reused by an internal
followup or reload. Further missing evidence stops with a verification-unavailable
diagnostic; only a new explicit owner request or new verified passing source
proof can renew the exception. Stale results, missing totals, denied execution
and unchanged passing evidence never create a repair allowance.

## Wake and sleep

One foreground client wake operation is shared by overlapping callers. Health
polling backs off with jitter while the instance starts. A read-only monitor
does not wake the model or renew idle usage. The HomeAI applications controller
coordinates VM shutdown with the existing idle guard; there is no second
independent stop controller in this feature. Native active runs, jobs, unknown
model state and app work continue to protect the instance from shutdown.

The final real stop/wake check exposed a provider limitation: Vast can return
HTTP 200 with `success:false` and unavailable resources for the original GPU.
The Worker now distinguishes an accepted start from a capacity queue, returns
202 with `CAPACITY_UNAVAILABLE`, and the foreground client retries the same
instance at most every 15 seconds for six minutes. Concurrent requests share
one in-flight provider operation. A hidden phone does not keep retrying wakes.
No replacement instance is silently rented. This cannot guarantee capacity:
Vast binds a stopped instance to its original GPU and may assign that GPU to
another job. See the [official troubleshooting
explanation](https://github.com/vast-ai/docs/blob/main/guides/reference/troubleshooting.mdx).

For predictable availability, a future design should keep the Harness and its
project data on a small persistent CPU host and wake only GPU inference, or
use capacity reservation. A shared host volume can make another GPU on the
same machine usable, but moving current data and changing rental/storage costs
requires a separate reviewed migration. It is not performed by this feature.

The new panel and custom shell use a shared EN/CZ dictionary. User messages,
source files and application logs are never machine-translated. Upstream
Harness labels retain their vendor language where no localization hook exists.

Whole-stack installation simplification is a [design proposal](installation-design.md)
only. No new rental or whole-stack one-click installer is introduced.
# Live changes and shared tool diagnostics

The Native right sidebar includes **Changes** beside **Workspace files** and
**Applications and Docker**. Its guide entry uses the same Native card as the
other tools. The panels use Native fonts, colors and dark-mode tokens; secondary
file actions remain available under **Workspace tools**.

Changes are captured from files on disk, including saves made by shell commands.
A new independent project compares against its empty project start; a Git
worktree compares against its recorded base commit. Existing continued or legacy
projects receive a bounded snapshot labelled **since tracking started**. Earlier
unsaved history cannot be reconstructed. The owner-only existing Workbench API
resolves the conversation's registered root; callers cannot supply another root.

Only the visible Changes tab polls: every two seconds while the conversation is
running and every fifteen seconds while idle. Hidden tabs stop polling and abort
outstanding requests. One request includes the file list and selected diff;
unchanged revisions preserve the selection. Tracking does not call the model or
wake Docker. Dependency/build folders, conventional secret files and symlinks
are excluded. Default limits are 1,000 files, 8 MiB source data, 256 KiB per text
diff and 5,000 displayed diff lines. Partial captures and binary/large files are
explicitly labelled. Tracking snapshots reserve 2 GiB free disk space.

All final SDK tool results, including future skill tools and admission failures,
enter the same per-project diagnostic queue. It does not mutate tool outcomes,
tool arguments, permissions or source. Before the next model step the queue
distinguishes failed assertions, missing prerequisites, invalid invocation,
stale edit context, timeout, cancellation and empty test selection. Fixed bounded
guidance contains no copied command arguments or log secrets. Reading a source
file containing failure text cannot itself become a failed test.

Repair policy version 3 counts actual failed verification separately from
launch, usage, stale-edit and timeout errors. Three repetitions of the same tool
error still pause the run, and the overall stage limit remains enforced. Zero
tests, all-skipped tests, missing exit status and timed-out commands cannot pass
a stage. Existing paused runs require a reviewed new strategy; upgrading does
not silently restart them.

Managed `bash` and `project_exec` share narrow, explicit compatibility rules:
known literal verification commands may drop a terminal `2>&1 | tail -N` filter
so the first error remains visible; direct literal `node --test` calls use a
bounded helper that expands directory operands to actual test files. One literal
`cd directory &&` prefix is supported. The output states each adaptation and
the original admitted arguments remain in the audit trail. Unsupported shell
forms and arbitrary JavaScript are unchanged. npm scripts and lifecycle hooks
are never silently bypassed or rewritten. A stale edit requires rereading the
current lines, and hanging tests require fixing cleanup; there is no fuzzy edit,
automatic side-effect retry or injected force-exit.

The same test-directory compatibility also applies to direct Node commands in
the quality runner. Literal display-only pipelines composed of `head`, `tail`
and quoted literal `grep -E`/`grep -vE` display filters are removed from known
verification commands; arbitrary pipelines, quiet/file-input grep checks and file-producing commands are
left intact. The original command remains in the audit trail. Structured
verification uses the final SDK outcome exactly once, with per-check diagnostic
categories and measured assertion counts. Configuration rejection, file/module
bootstrap failures and timeouts cannot masquerade as actual test failures or
successful verification. Exceptions inside real test cases remain failures.

If application code has changed after eight agent steps without a functional
test, the same context channel supplies one task-independent first-check
reminder. It asks for a small authentic behavior through validation and
persistence before expanding the interface, with isolated data, early resource
cleanup and I/O deadlines. A build alone does not satisfy this reminder.
Unchanged repositories and prose-only tasks are excluded. The reminder is
advisory; it never invents test cases, edits application code, changes a result
or resets the existing repair/stage limits.

Temporary servers can use explicit `run_in_background: true` on managed `bash`
or `project_exec`. The acknowledgement is the canonical Native background job
address, not verification completion. `job_output` reads the bounded log and
`job_kill` stops that registered job. The actual executing agent owns the job;
another session cannot acquire it by knowing its ID. A missing registry or job
controller fails closed. Both execution modes use the same prepared project
environment and filesystem policy, including an actual child agent's read-only
mode. The foreground deadline stays at most 120 seconds; a background job has a
five-minute default lifetime and ten-minute maximum. Cancellation, owner
disposal and executor disposal drain only their own process handles. There is
no implicit timeout promotion, adoption of arbitrary PIDs or process-name kill.
Use foreground verification for a completed milestone and Docker for lasting
application deployments.
