# Commands in isolated projects

The workspace plugin installs a project-scoped `bash` implementation for every
managed project. Both `bash` and `project_exec` use the same command runner, so a
model choosing the ordinary `bash` tool receives a real command result rather than
the former “Use project_exec” refusal. This applies to restored managed chats,
new chats, seeded sessions and their child agents. Legacy conversations retain
their original Native bash implementation.

The registration happens during agent creation and enrollment. Harness rc.2
captures its admitted tool set **before** `agent/pre-step`; installing a replacement
there would miss the first request. The guard checks that the admitted definition
is the trusted project implementation. A missing replacement, a stale admission,
Trash, an existing repair stop or an outside working directory still fails closed.
No execution arguments are rewritten in middleware and no Native approval hook is
bypassed.

Managed commands support `command`, `description`, optional `workdir`,
`timeoutMs` and explicit `run_in_background`. Foreground commands stop on timeout
and have a maximum 120-second limit. There is no automatic promotion on timeout
and no permission escalation argument. The original Native foreground output
schema, exit status, cancellation and terminal presentation are retained for
`bash`.

For a temporary server, set `run_in_background: true` and keep the returned
`jobId`. Use `job_output` to read its status/logs and `job_kill` to stop that
owned job. A job belongs to the actual executing agent, including a read-only
child. Another session cannot stop it by knowing its ID. A background job runs
for five minutes by default, with a ten-minute maximum; `timeoutMs` sets this
bounded lifetime. Owner or executor disposal cancels and drains the owned
handle. Missing job-registry/controller support refuses the start. Use these
handles instead of `nohup`, `setsid`, `pkill` or `killall`. Lasting deployments
belong in [Applications and Docker](applications.md).

A background acknowledgement is neither completed verification nor a failed
test. Run milestones in the foreground with `verify_project` so that the
completed result is recorded.

The acknowledgement includes an exact `job_output` call using `job_id`, `wait`
and `timeout_ms`. A wait deadline returns the same running job; it does not
authorize another launch. The public SDK result exposes `job.status` and
`job.detail`; process results also appear in its returned text. A `completed`
status with a nonzero exit code is a failed command. Source-bound acceptance
still belongs to `verify_project`, not a terminal status inferred from logs.

`runtime_capabilities` supplies `verificationRecipes` for `test`, `browser` and
`all`, with the installed quality schema and artifact directory. Adapt real
assertions to the requested behavior. Browser checks use the project's assigned
port, a positive visible expectation and a screenshot checkpoint. Require
`passed: true`, `complete: true`, and `stale: false` for full declared acceptance.

Apps jobs use the existing Apps registry. Retain the ID returned by the original
submission and call `apps-cli.cjs job-status JOB_ID` for bounded structured state,
then `job-log JOB_ID` when diagnosis is needed. These reads never wake Docker.
`runtime_capabilities.jobTracking` provides the exact argv for current owned jobs.
`queued` and `running` remain pending; `failed`, `interrupted`, `unknown` or
`recovery_required` never become a pass. Do not resubmit after a lost response or
wait deadline. Inspect the original receipt and resolve any recovery requirement.
A passed build still needs application and browser verification before delivery.

The working directory and its real filesystem target must remain in the project.
The runner exports the project's assigned ports, database and prepared tool paths
through `development/project-run.cjs`, then invokes the actual filesystem-confined
executor. Full-access session settings do not remove this project boundary.
Read-only sessions remain read-only, receive no extra writable roots and do not
create project cache directories while preparing the environment. Platform
temporary-directory exceptions still belong to the installed sandbox provider.

Known literal verification commands can drop display-only `tail`, `head` or
quoted literal `grep -E`/`grep -vE` display filters without file operands or
quiet mode so the first failure and final summary stay visible.
The output announces this adaptation and the original admitted arguments remain
in the audit trail. Direct `node --test` directory operands expand to bounded
test-file selections, including in the quality runner. Unsupported shell forms,
arbitrary JavaScript and npm scripts/lifecycle hooks remain unchanged.

All final SDK tool outcomes share one diagnostic queue, including calls made by
skills and `verify_project`. Configuration rejection, Node module/file bootstrap
failure, stale edit context and timeouts stay unverified and do not masquerade
as actual failed functional tests. Exceptions inside real test cases remain
failures. Three repetitions of the same tool error and the overall stage limit
still pause work. Empty, skipped-only, cancelled or incomplete verification
cannot pass. After eight steps of changed application code without a functional
check, one general reminder asks for a small tested behavior before expanding.

Verification covers the actual pinned Native tool registry and bash output schema,
first-step admission, independent policy denials, cancellation through quiescence,
legacy behavior and disposal. A separate Linux check uses the actual Native bash,
subprocess and kernel confinement providers to verify outside-project denial,
first-use read-only behavior and a project service's start/stop lifecycle.

Install with the normal signed source update. An already running Harness needs one
controlled Harness-only restart while its conversations are idle; model and Apps
services do not need a restart. Workbench state reports `managedShellVersion: 1`,
`projectBackgroundVersion: 1` and `repairPolicyVersion: 3` or later after this version is
loaded. Policy version 4 adds [automatic stage verification](autonomous-stages.md)
with a separate finite task allowance. A signed commit or a passing local test does not prove that a particular
server has activated it; inspect its installed revision and service health.
