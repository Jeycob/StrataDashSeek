# Reviewed SDK conversation helpers

Source review: local pinned SDK `0.2.2-rc.2`, under
`node_modules/@deepseek-ai/`. This is a source/effects inventory, not a live
enabled-tool inventory, provider acceptance, or a claim that isolated activation
or its enforcement floor is complete. No production, model, VM, UI or network
call was made. The shipped standard preset uses native execution
(`dsh-base/cordis.patch.yml:512`); the separate PTC preset selects its own
executor. Profile overrides were not inferred from those shipped defaults.

## Narrow implemented unit

`workspace/conversation-tools.mjs` explicitly invokes the reviewed todo and
ordinary question consumer factories using a private registrar. It does not
discover or trust current registry entries by name. Each scoped wrapper keeps
the consumer's original parameters, output schema, renderer, presentation and
validation. Only the exact wrapper definitions in a private WeakSet participate
in the workspace's existing admission slot. Captured native definitions,
foreign replacements, removed definitions and all other helper families remain
closed in isolated mode.

The production loader lazily reads the two fixed SDK consumer files under
`/data/harness/runtime/node_modules`, checks their bounded source against the
SHA256 values recorded in the module, and imports only matching files. It runs
only in isolated composition. A trusted direct test seam supplies the pinned
local SDK location; config/browser input selects neither source nor mode. This
pins these consumer callbacks, not every dependency in the SDK; overall runtime
integrity remains part of Root's existing source/runtime flow.

* `todo_write` retains the standard preset's explicit parallel-list policy
  (`allowParallelInProgress:true`), trimming/duplicate validation, counts and
  `todo/write` event. A private execution view gates the actual Session.append
  immediately before calling the real Session method. The SDK arguments and
  actual target Session remain unchanged. Children update their own lists.
  The native `todos` projection registration is shared through the SDK's
  reference-counted registry and only this consumer's handle is released.
* `ask_user_question` captures **ordinary legacy mode only**. It passes the exact
  actual Agent to the real UserQuestionService, retaining the SDK's live-agent
  and delegated-child checks. Each call owns an AbortController, forwards
  caller cancellation, and checks the immutable mode/slot/definition while
  waiting on a 100ms interval. This is cancellation monitoring, not a hard
  timing guarantee or availability-based mode selection. Scope removal,
  consumer disposal or a closed/changed binding aborts the original request.
  A replaced underlying question service also closes its outstanding request;
  Cordis's public original-service identity distinguishes a real replacement
  from fresh caller-context proxy wrappers.
  The helper awaits actual SDK/provider settlement, rejects late answers after
  revocation, and never races an early success against an unfinished provider.
  Disposal joins the same outstanding settlement promise on repeated calls.
  A provider that ignores abort continues to hold that owned pending call until
  it settles; cleanup is not fabricated.

The ordinary SDK question consumer only copies answer data after its await
(`dsh-tool-ask-user/lib/index.js:304`). UserQuestionService.ask validates and
awaits the scoped answerer without post-answer mutation
(`dsh-user-questions/lib/index.js:675`). The reviewed SDK JSON-RPC bridge forwards
the supplied cancellation signal, notifies cancellation and removes its abort
listener in finally (`dsh-sdk-jsonrpc-server/lib/index.js:164–205`). No
askTimed/continued question, late-reply steer, plan approval or new-turn path is
introduced by this unit. The actual UI/remote transport was not executed.

`execution-composition.mjs` constructs this registrar only after entering its
existing isolated branch, includes its exact definitions in admission, and
disposes it after closing the workspace slot. `plugin.mjs` awaits its readiness
only for isolated mode, before model restoration/tool-set resolution. The host
branch body and native host helper registrations are unchanged. Missing
optional question/projection services leave the corresponding helper closed;
an unreviewed consumer source fails readiness. No global SDK/ToolsService method
is patched.

## Definition/effect inventory

References below are relative to the SDK base above. A reviewed consumer does
not establish that its concrete provider/engine effects satisfy isolated mode.

| Actual definitions reviewed | Effects and disposition |
| --- | --- |
| `todo_write` — `dsh-tool-todo/lib/index.js:98,172` | Canonical list validation, own-session synchronous append, native projection. Integrated as above. |
| `ask_user_question` — `dsh-tool-ask-user/lib/index.js:224,304` | Ordinary question service with actual agent/signal; original answer-copy semantics. Integrated with owned cancellation/drain. Timed mode is not enabled. |
| `exit_plan_mode` — `dsh-plan-mode/lib/index.js:238–324` | Conditional service-owned tool asks for a plan review, then mutates private pendingIntents after the await. Remains closed. It needs an explicit mode-aware service/factory seam adjacent to that transition, preserving the native plan-review protocol. An outer whole-call guard is insufficient. |
| `get_goal`, `create_goal`, `update_goal` — `dsh-tool-goal/lib/index.js:264,275,301` | Same-session goal service reads/mutations with exact-driver and direct-human/goal-round checks. Synchronous mutation callbacks are candidates for an owned registrar, but creation/update enables autonomous continuation and requires an explicit Root policy/integration unit. Not enabled here. |
| `list_agents`, `wait_agent` — `dsh-tool-subagent-control/lib/index.js:32,164` | Verified descendant-tree metadata and bounded inbox observation. Candidates for exact-definition integration with post-wait checks and owned cancellation on unload. Not enabled here. |
| `list_subagent_models` — `dsh-tool-subagent/lib/index.js:209` | Authorized child-route/model discovery, not a global default write. Candidate after its actual model/provider calls receive a bound facade; not enabled here. |
| Configured `subagent` / `subagent_fork`; `send_message`, `interrupt_agent` — `dsh-tool-subagent/lib/index.js:366`, `dsh-tool-subagent-control/lib/index.js:222,285` | Delegation and messaging can prepare cwd, materialize or cold-resume children and start turns after awaits. `dsh-subagent/lib/index.js:1511,1949–1969,2236,2260` contains those later effects. Remain closed until constrained cwd/provider/preset and effect-adjacent lifecycle binding are integrated. |
| `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read` — `dsh-tool-session-query/lib/index.js:955–1017` | Read-only operations, but cross-session authority uses equal header.cwd (`:456–495`), not workspace-owner identity; operations have multiple awaited queries (`:748–878`). Need an explicit owner/authorized-tree target facade and checks at query boundaries. Remain closed. The inert experimental session search/inspector Host modules add no definitions. |
| `team_task_list`, `team_task_get`, `team_task_create`, `team_task_update` — `dsh-tool-agent-team/lib/index.js:145,181,232,248` | List/get read a verified team. Create/update queue a persistent event transaction; `dsh-agent-team/lib/index.js:76,92,447` must check binding inside the queued action before append/flush. Remain closed. |
| `schedule_create`, `schedule_list`, `schedule_view`, `schedule_edit` — `dsh-tool-schedule/lib/index.js:518–693` | Host-global task access and future session delivery using captured cwd/preset. Remain closed pending separate project-bound scheduling/admission. |
| Configured workflow; `ralph` — `dsh-tool-workflow/lib/index.js:271,385–436`, `dsh-tool-ralph/lib/index.js` apply/execute | Arbitrary workflow orchestration, child activation, jobs and durable session effects. Consumer effects reviewed; workflow/runtime boundary not accepted. Remain closed. |
| `working_directory` — `dsh-tool-working-directory/lib/index.js:15–48` | Calls host cwd ensure/set. Requires a guest cwd abstraction, not an exemption. Closed. |
| `skill` — `dsh-tool-skill/lib/index.js:785,867–890` | Host cwd and skill provider list/get. Its pre-step/catalog hooks also access providers independently of tool execution. Requires a mode-aware provider/resource contract, including those hooks. Closed. |
| `present` — `dsh-tool-present/lib/index.js:25,85–132` | Host cwd, lstat/resolve/stat, durable file references and a later deliverables/presented append. Requires guest-bound file-reference/delivery integration. Closed. |
| `load_workspace_dependencies` — `dsh-tool-workspace-dependencies/lib/index.js:232–289` | Reads or unpacks a host primary runtime and returns host executable/library paths. Requires immutable guest toolchain metadata instead. Closed. |
| `office_render`, `office_convert`, `office_recalculate` — `dsh-tool-office/lib/index.js:402,455,474,497–556,653–690` | Host file reads, Office kit, output paths/attachments and possible subagent access. Needs guest-specific Office/file-reference integration. Closed. |
| `web_search`, `web_fetch` — `dsh-tool-web/lib/index.js:335,833` | Calls configured host web services with route readiness and timeouts. Consumers reviewed; concrete provider/network/credential effects not reviewed here. Remain closed pending an explicit trusted web-service contract. |
| `cordis_inspect_list`, `cordis_inspect_query` — `dsh-tool-cordis/lib/index.js:39–95` | Global host/client inspection providers and arbitrary declared inspection methods. Not required for ordinary project work; provider effects/scope need separate review. Closed. |
| `plugin_manager` — `dsh-plugin-manager/lib/types/tools.js:75–137` | Persistent profile/plugin/package management with host execution and escalation. Closed. Dynamic MCP tools (`dsh-mcp-client/lib/index.js:473–552`) dispatch actual server calls; their effects are not established by a name, schema or read-only hint. Each actual provider/definition requires its own review. |
| PTC `run_code` — `dsh-tool-executor-ptc/lib/index.js:273,348–390,1806–1840` | Program runtime, host cwd/policy resolution and nested tool dispatch. Separate executor transport, not a pure planning helper; requires its own guest runtime and nested-admission contract. Closed. |

No standalone thinking or generic tool-search definition was found in the
reviewed pinned SDK consumers/shipped presets. Native execution advertises
registered tool schemas directly. That finding does not admit an external MCP
tool or an unreviewed profile override with a similar name.

## Validation and next source seams

The new actual-SDK fixtures use the real Tools pipeline, Sessions,
SessionProjectionRegistry, UserQuestionService and consumer callbacks. They
cover native/captured/foreign definitions, exact child ownership, native
schemas/rendering, projection events, invalid todos, source/provider revocation,
late answers, caller cancellation, scope/fiber unload and repeated disposal.
Answerers are inert local fixtures; no UI or remote question was sent. Existing
composition, source-binding, T03/T06 and model-selection fixtures remain separate
regression checks. Native UI generation, deployment and isolation acceptance
remain Root-owned work.

The next minimal helper seams are an owned registrar for the reviewed read-only
child/goal/model metadata definitions, a plan-mode transition seam adjacent to
its post-question mutation, and constrained service-level delegation/session
query facades. They must compare actual captured definition objects, retain
their existing authority rules, and check binding at later effects. This unit
does not grant any of them by name.
