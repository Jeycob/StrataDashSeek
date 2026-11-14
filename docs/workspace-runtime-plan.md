# Workspace and runtime improvements

Scope: automatic per-session projects / native Git worktrees, collision leases,
workspace files operations, workspace defaults, reversible session deletion,
prepared browser and optional .NET tooling, enforced repair budgets, reasoning
verification, wake/sleep hardening, and English/Czech UI.

Existing conversations keep their project on follow-up. A new conversation is
the default independent-task boundary; users can explicitly start another
project. Git worktrees are pinned to a resolved local commit; dirty source files
are never silently copied. Runtime isolation is not a security boundary between
mutually hostile users of one Unix account.

Changes live on `feat/workspace-runtime-improvements`. HomeAI is concurrently
developing the container workbench on `feat/container-workbench`; preserve its
UI, service and idle-guard contributions when integrating. Do not replace
production wholesale or interrupt active conversations for validation.

Implementations use installed Harness APIs: `workingDirectory`, `worktrees`,
`sandboxPolicy`, `connection.fetch`, tool execution guards and whole-turn hooks.
No destructive session/file operation runs merely by installing the feature.
Deletion is user initiated and reversible; busy sessions/files are refused.

Install simplification is design only: consider a versioned deployment manifest,
prebuilt browser/runtime image, provider adapters, preflight checks, explicit
secret provisioning and one health report. Do not create a new one-click
installer or rent replacement hardware in this task.

Validation must cover actual API operations, file version conflicts and path
escapes, cross-session leases, real tool outcomes, hard loop pauses, real browser
screenshots/console/WebGL, .NET build, effective reasoning wire parameters,
EN/CZ UI, and a safe real stop/wake cycle when no user work is running.
