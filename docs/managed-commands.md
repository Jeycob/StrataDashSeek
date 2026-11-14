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

Managed commands support `command`, `description`, optional `workdir` and
`timeoutMs`. They run in the foreground, stop on timeout, and have a maximum
120-second limit. Background and permission escalation arguments are not offered
for these managed tools. Services can use a project-owned lifecycle helper; their
start command itself remains bounded. The original Native foreground output schema,
exit status, cancellation and terminal presentation are retained for `bash`.

The working directory and its real filesystem target must remain in the project.
The runner exports the project's assigned ports, database and prepared tool paths
through `development/project-run.cjs`, then invokes the actual filesystem-confined
executor. Full-access session settings do not remove this project boundary.
Read-only sessions remain read-only, receive no extra writable roots and do not
create project cache directories while preparing the environment. Platform
temporary-directory exceptions still belong to the installed sandbox provider.

This compatibility layer does not turn failed commands into success. Nonzero exit
codes, timeouts and real access denials remain visible. Repeated real failures still
consume the existing repair budget; build/test/browser/acceptance completion still
requires meaningful verification. The model and its caches are unchanged.

Verification covers the actual pinned Native tool registry and bash output schema,
first-step admission, independent policy denials, cancellation through quiescence,
legacy behavior and disposal. A separate Linux check uses the actual Native bash,
subprocess and kernel confinement providers to verify outside-project denial,
first-use read-only behavior and a project service's start/stop lifecycle.

Install with the normal signed source update. An already running Harness needs one
controlled Harness-only restart while its conversations are idle; model and Apps
services do not need a restart. Workbench state reports `managedShellVersion: 1`
after the updated plugin is loaded.
