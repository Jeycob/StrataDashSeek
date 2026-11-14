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
stage also has a bounded step count (default 60). This is enforced by runtime
hooks, not only by a prompt. **Run review** shows the best source checkpoints
and requires a changed strategy before resuming. Restoring a checkpoint first
saves the current sources; it does not overwrite databases or dependencies.
Checkpoints include at most 5000 source files/32 MiB, with each file at most
1 MiB. Larger assets are outside this recovery feature. Superseded checkpoint
generations are pruned; referenced best versions remain retained.

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
