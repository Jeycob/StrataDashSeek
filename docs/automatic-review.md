# Automatic verification and continuation

Long tasks keep their original user request. A stage, task-step or accumulated
check count does not ask the user to approve another run. `maxStageSteps` selects
the automatic check interval; legacy `maxTaskSteps` and `maxAutomaticChecks`
settings remain readable for compatibility and impose no fixed-count stop.
The stage-local `steps` counter still changes after genuine new verification;
`automatic.taskSteps` and `checks` preserve actual task usage. A new identified
human request starts its own accounting; internal continuation is not one.

Each automatic `verify_project` runs through the normal SDK guards, policy and
final observer, with its original absolute 120-second deadline. Three repeated
failures without progress still stop; recovering three consecutive interrupted
checks also stops. Missing permissions and unknown operation identity remain
concrete blockers. A passing subset, stale source, cancellation or unknown result
never becomes full application acceptance.

The controller persists the owner, root, source hash and call identity before
dispatch, and retains the matching final observer receipt even after cancellation.
It accounts for that receipt once. Restart reconciliation requires the saved
matching receipt and terminal acknowledgement, including any required owned-range
proof. It never credits rendered tool text or a different call's result.

The HOST quality plugin privately supplies the actual shell handle for its
automatic verifier. Recovery can stop only that retained handle, under the first
absolute cleanup deadline (at most ten seconds after the verification deadline).
A kill acknowledgement does not prove quiescence. Only the qualified provider's
range-aware completion can supply it; missing/unobservable work remains blocked.
Unrelated preview jobs, processes, files and history are not cancelled or reset.

For the reviewed legacy ACK format, including the deployed e782 implementation,
the saved ACK establishes that the captured SDK batch drained its started bodies.
It does not establish quality. When that exact legacy object/call is still current,
the SDK execution is absent, result bookkeeping drains within its bound, and fresh
idle/inbox/owned-job observations agree, recovery writes a separate
`TERMINAL_OUTCOME_UNKNOWN` audit entry. It changes no counters, proof, errors,
history, files or `nextCheckAt`. One fresh bounded verification must run before
another model step or continuation. No historical receipt or PASS is invented.

Late final results and owned process completion invoke the same owner singleflight
used by pre-step and the owner's `POST /api/workbench` operation
`automatic-reconcile`. It works while the progress panel is closed. GET is read-only.
The response is `{automatic, blocked, continued}`; `automatic` is null before
enrollment. Its public recovery object contains only state/code/canContinue, and
terminalAcknowledged is a boolean. Call IDs, process handles, receipt and proof maps
remain private. `recovery` may be absent before the first automatic check.

An internal same-task `agent.followup` is allowed only for a genuinely idle owner
with both inbox lists empty. Its source/task/call/receipt-bound intent is saved
before the sole dispatch. `continued:true` requires matching identified inbox or
message history after a successful `SessionStore.flush`. An ambiguous write is
held without resubmission; a later read may confirm the existing message. The
pre-step fence prevents inference while acceptance is unknown. Admission does not
mean the model is currently running. Explicit caller cancellation does not create
an automatic continuation. Its original signal remains observed after timeout
through late terminal reconciliation and pending queue admission. A matching
Stop is persisted with the task/call/source, survives restart, and is checked
again after each asynchronous continuation boundary; its listener is removed on
Stop, normal completion, confirmed admission or plugin disposal.

These changes do not alter frozen benchmark limits or external Codex approvals.
Source regression results are not deployment, live Doom recovery or application
acceptance; those remain separate operator qualifications.

Session.seq is the next append offset. A matching durable insertion at exactly
the saved baseline is included in admission evidence. Re-observing an existing
accepted message never dispatches it again and never implies that its agent is
currently running.

The explicit owner operation `automatic-resume-consumed` handles one narrow
recovery: the recorded internal message was durably accepted, claimed, and ended
at the known continuation guard before any model step. It requires complete
matching history, the same task/root/source/final receipt, unchanged source,
empty inboxes and independently observed idle owned resources. It preserves the
old intent and failure proof, then permits one new internal recovery intent per
receipt under the same owner singleflight. Unknown dispatch is observed without
resubmission. This operation does not create a new human request, reset task
accounting, or renew verification limits. SDK maintenance protects admission
against concurrent Stop; only its exact new owned queued message may be removed
on cancellation. An earlier idle Stop is not inferred from an absent log event;
the explicit owner operation provides the new recovery intent.

Registry snapshots are serialized and published with file fsync and, on Linux,
parent-directory fsync. A failed persistence acknowledgement cannot authorize
continuation dispatch. The explicit recovery shares one absolute owner-action
expiry with its shorter queue-proof bound; waiting does not renew that expiry.
