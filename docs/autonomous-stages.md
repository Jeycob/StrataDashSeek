# Automatic stage verification

The workspace policy version is **4**. Its normal stage boundary is a verification
interval, rather than a request for a user-written strategy.

Defaults per actual human request:

| Setting | Default | Allowed range |
| --- | ---: | ---: |
| `maxStageSteps` | 60 | 10–100 |
| `maxTaskSteps` | 240 | 60–600 |
| `maxAutomaticChecks` | 3 | 0–6 |

At an interval with changed application code, the controller invokes
`verify_project(kind: all)` through the **normal SDK tool executor**, preserving
the initiating agent's permissions, dispatch guards, cancellation and final
result observer. It does not directly invoke the verifier or create a second
result-accounting path. Each automatic call has its own 120-second deadline.
The controller races an asynchronous SDK hang against that deadline and does
not claim the executor stopped merely because its signal was aborted. Like any
in-process timer, this requires a responsive Node event loop; a synchronously
blocked runtime requires external process supervision, not a tool-kill bypass.

Completed current-source verification with new evidence advances a stage. The
same source hash and verification kind cannot repeatedly renew it. A stale,
cancelled, empty-test, unknown-exit or refused operation never earns progress.
Repeated identical successful checks also preserve the existing failure history.

For managed automatic budgets, only structured `verify_project` has canonical
stage credit: its trusted before/after source proof must match the final source.
A raw foreground shell check keeps its actual return value, output and failure
accounting, but its post-run source snapshot alone cannot prove what a parallel
child tested. Such an unbound success does not advance a stage or create a
source-associated best checkpoint. Pure legacy policy callers remain compatible.

An ordinary unsuccessful automatic check grants at most 20 further model steps
to inspect its owned report/log paths and repair a smaller behavior. The actual
failure counters remain in force. Three repeated errors without improvement,
the automatic-check allowance or the total task allowance can still stop work.
The model is told to ask a question only for a concrete owner decision, rather
than routinely asking for permission to repair failed validation.

Fewer failed assertions, or more genuinely passed assertions without increasing
the failure minimum, count as partial repair progress. This resets only that
consecutive failed-repair streak; it does not manufacture a successful stage,
reset task steps or renew automatic-check attempts. Editing files by itself is
not verification progress.

The automatic-check count and total model-step count are durable. Successful
verification, internal followups, child agents, provider retries, checkpoint
restore and manual strategy review cannot renew the total allowance. Only a new
server-observed human message with a new identity and later turn starts another
bounded request. Child requests cannot perform this transition. Retry admissions
are deduplicated even when child steps are interleaved.

This is a model-step and verification-attempt guard, **not a dollar/token meter**.
Normal agent-requested verification remains governed by the task-step allowance
and existing tool permissions. Raising a workspace limit is an explicit owner
configuration change. `maxAutomaticChecks: 0` selects manual stage review.

Read-only scopes, legacy projects, unchanged projects and prose-only edits do
not acquire a writable verifier or fabricate a stage pass. Their permission and
change status is reconsidered at the next interval; their task allowance still
applies. Loading a deployment does not itself wake or resume old paused chats.
An old `STAGE_BUDGET` pause can use automatic verification after a new actual
human request; an explicit one-click review can also schedule verification.

The review UI distinguishes current stage, last verified progress, task steps,
automatic-check attempts and the last check result. Ordinary checking/repairing
does not show a strategy prompt. An exceptional stopped run may offer one click
to verify current work and retry a smaller repair if both allowances remain.
Custom strategy text is optional and validates 15–2000 characters before submit;
drafts survive failure and refresh. A total-limit stop requires a new bounded
request, rather than a misleading resume button.

A new actual human request also allows replanning after a repeated-error stop,
without requiring a strategy form. It preserves the error/verification history:
immediately repeating the same failing action can still stop again. Internal
followups and subagents cannot perform this transition. An uncertain in-flight
verification remains exceptional and is not cleared by an unrelated message.

If a process dies with a saved in-flight automatic check, its outcome is
uncertain and is not blindly replayed. A new human message cannot reset that
fence, counters or active call identity. A signal-ignoring SDK executor also
causes a bounded uncertain response at the deadline, while its live promise
retains the project lease until the SDK acknowledges settlement. Late settlement
does not clear the durable fence or credit progress. Normal review/resume refuses
an unresolved operation; operator reconciliation is required. Files are never restored or
discarded by an automatic review. Explicit checkpoint restoration remains a
separate reviewed transaction.

