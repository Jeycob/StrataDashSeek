# Signed runtime recovery: controller and integration contract

`vast/runtime-recovery.cjs` implements a durable recovery controller. The
candidate integrates it through `runtime-launcher.cjs`, the explicit stable
bootstrap upgrade, root admission broker, supervisor and Native dispatch hooks.
Production activation and a real application workload remain separate required
acceptance steps. Missing policy or trust never creates a last-good baseline.

The controller restores **code only**. It accepts commit identities, not paths,
commands, database backups or project directories. It never rolls back chats,
checkpoints, device revocations, notification outbox rows, project files or
application data. All those formats must remain compatible with both releases.

## Root authority and compatibility

Production must use `createRuntimeRecovery({root, policy, hooks})` from the
reviewed stable root bootstrap. It requires Linux UID0, uses the existing
protected runtime-path implementation, and holds a kernel-backed process lock
at `root-secrets/runtime/state/runtime-recovery.lock` for every operation.
State is atomically replaced, file-fsynced and parent-fsynced in the protected
`runtime-recovery.json` next to that lock. The exported `RuntimeRecovery` class
also accepts adapters for isolated tests; never expose its store or hooks to
the browser, Native agent, project files or a tenant-controlled plugin.

An explicit root-owned policy is mandatory: `enabled:true`,
`minimumSecurityEpoch:2`, `deniedCommits:[...]` and a 64-digit SHA256
`compatibilityId`. The fixed denylist additionally always includes unsafe
baseline `505460d62e63c389def4fba5c82da8b9ab9cfd13`. Unknown and legacy releases
are excluded, even if signed. P1 ancestry or commit ordering is not sufficient.

The root `verifyRelease({commit,signal})` hook must independently verify the
pinned Git signature and the actual immutable release digest using the signed
startup gate, then verify the protected root ABI attestation. Its result is:

```
{commit, digest, signatureVerified:true, rootProtected:true,
 securityEpoch:2, compatibilityId, admissionProtocol:1}
```

The booleans are an interface result, **not the proof itself**. The attestation
must live under root ownership with protected ancestors, private records and
no links. It must bind that exact commit and digest to verified protected
runtime paths, installed stable-bootstrap bytes, dependency/runtime ABI,
checkpoint ABI2 and notification-outbox ABI1 when those formats have been
opened. Compute `compatibilityId` from a canonical complete ABI manifest,
including device-registry/revocation formats; do not accept a release's own
unverified claim. `c79a766` having P1 protection does not establish compatibility
with newer checkpoint/outbox formats. Both candidate and last-good must pass.

The controller checks the complete verified descriptor again before switching.
A changed digest, missing signature, unknown ABI, altered policy or damaged
journal refuses automatic recovery. A reviewed policy/ABI migration must retain
the attempt history; deleting the journal is not an automatic upgrade strategy.

## Required hooks

All hooks run as trusted root code under the recovery lock. They must not call
back into the controller, otherwise the lock would deadlock. `verifyRelease`
and `currentCommit` are read-only. Ordinary hooks have a 1.5-second deadline;
`switchRelease` and `restart` have 10 seconds each. Each receives an AbortSignal.
Child processes need their own timeout and bounded output. A timeout cannot
prove that an external operation was cancelled, so an uncertain mutating hook
leaves recovery required and is never replayed automatically.

* `currentCommit({signal})` returns the exact physical managed pointer commit.
  Resolve the root-owned app symlink and verify the release, not a browser field.
* `fence({attemptId,commit,signal})` closes **all** user admission atomically and
  observes the same epoch. Return `{attemptId,commit,admissionClosed:true,
  acceptedWork:0,activeRequests:0,activeJobs:0,fenceToken,observedAt}`. The token
  is an unpredictable 64-digit root-held identity and `observedAt` is epoch
  milliseconds. The root broker must derive counters from authoritative
  admission/dispatch state, including existing conversations, background Apps
  jobs and other protocols. Missing paths or uncertain counters must fail.
  Closing admission must not cancel existing requests/jobs; their presence
  prevents rollback. Keep the fence closed through activation and recovery.
* `switchRelease({attemptId,from,to,fromDigest,toDigest,fenceToken,signal})`
  must, in the root admission critical section, revalidate the closed epoch,
  no accepted/active work, both signatures/digests, current expected pointer and
  compatible installed bootstrap. Atomically switch only the managed code
  pointer and root applied-release record with a durable root journal. It must
  not restore old bootstrap bytes or any data. Recheck signal and fence at the
  last side-effect boundary. Do not call the old generic activation rollback
  blindly: its legacy pointer is not necessarily an attested safe last-good.
* `restart(intent)` must check that same closed epoch and target again before
  replacing processes. Never stop active user work. Only restart the compatible
  runtime code; preserve model processes where the verified contract permits.
  Its return means command completion, not functional Native readiness.

## Bootstrap and admission sequence

1. On the first deployment of this controller, automation remains disabled
   until a reviewed safe new baseline is running. Call
   `adoptHealthy(commit, observation)` only after root signature/ABI verification
   and fresh authenticated Native functional health for that exact commit.
   Merely finding an old signed applied record cannot enroll a baseline. Initial
   enrollment creates a real healthy admission epoch after a closed zero-work
   fence; its returned attemptId is immediately usable by admitWork. Repeating
   enrollment of the same healthy serving release preserves that epoch, the
   accepted-work latch and all attempt history. It does not begin a self-update.
2. Stage and verify the candidate before disturbing services. Call
   `begin(candidateCommit)` immediately before source activation. It persists
   a new attempt, captures the last-good identity and closes admission. Proceed
   with candidate activation **only** for a returned `phase:monitoring` and the
   matching attemptId. Any exception/recovery-required result holds startup.
3. Keep the admission epoch closed while starting the candidate. Poll existing
   functional readiness at most once per second and call
   `observe(attemptId, observation)`. An observation must have version1, exact
   sourceCommit, sourceReady and runtimeReady, a consistent ready/model_loading
   phase, and a fresh ISO observedAt no earlier than this attempt. A
   model still loading does not fail functional Native readiness. No inference
   request is required. The 90-second deadline is persisted before activation
   and does not reset when a controller restarts. Polling persists clock progress;
   a detected backward clock holds recovery rather than extending the budget.
4. Fresh functional success records `healthy` and the newly attested last-good.
   Before **every first user mutation/enqueue**, call
   `admitWork(attemptId, servingCommit)` and require `result.admitted === true`
   before dispatch. The durable accepted-work latch is set before returning.
   Integrate at Native session creation/prompt/file mutation/tool dispatch,
   Apps/background queues and sockets, not only at the later first model call.
   Unknown/root-broker failure denies admission. Read-only status is exempt.
5. If Native never becomes functional by 90 seconds, `observe` requires a fresh
   fence, no accepted work, no active requests/jobs, exact current candidate and
   freshly verified compatible last-good. It persists `rollback_intent` and
   consumes the budget **before** calling either mutating hook. The maximum is
   one attempted rollback per candidate and two per rolling 24 hours. History
   is retained across restarts; a full journal holds rather than evicting limits.
6. After switching/restarting, `rollback_switched` still keeps admission closed.
   Call `reconcile(attemptId, observation)` with fresh fallback health. Only
   verified pointer, compatibility, functional health and a closed zero-work
   fence can produce `rolled_back`; then `admitWork` may admit the fallback.
7. If a process dies during intent/switch/restart, or a side effect times out,
   read the durable state and use `reconcile`. It only observes, never repeats
   switch/restart. If the fallback is not already proven healthy, hold
   `recovery_required` for reviewed root recovery. Do not interrupt work to make
   the counters look idle. An accepted-work latch permanently prohibits
   automatic rollback for that attempt.

`status()` returns a sanitized recovery sub-object without filesystem paths,
cookies or fence tokens. `phase:healthy` and `functionalHealthConfirmed` describe
a historical verified transition, **not live uptime**. Its sourceReady and
runtimeReady are null; keep actual `/phone/health` as the independent fresh
source/runtime/model readiness authority. Do not spread recovery status over
that response or infer ready from the saved applied commit. Reconciliation and
admission mutations are private root operations; public status is read-only.

## Validation and remaining work

Portable tests use controlled root-hook fixtures and a real on-disk test
journal: functional/model distinction, refused legacy/unknown/changed proof,
90-second deadline across controller recreation, admission latch, active-work
refusal, ambiguous switch reconciliation, policy corruption, clock rollback,
daily budget, bounded hook cancellation and an actual controller SIGKILL after
the pointer side effect but before acknowledgement. They do not cryptographically
certify the fixture descriptors; the existing startup-signature gate is that
authority. Set `HARNESS_RUNTIME_RECOVERY_ROOT_TEST=1` and run the same test file
under Linux root to additionally exercise the actual protected fsync store,
kernel-backed lock and hardlink refusal. These are not Docker cutover tests or
production restart evidence.

The candidate stable launcher now supplies these hooks. The signed startup gate attests the exact staged tree before its beforeActivate hook, which enrolls a new candidate only from a previously healthy compatible root record. Epoch2 includes bootstrap2, checkpoints2, outbox1, device credentials2, deployment data1 and admission1. Old505 is always excluded. The first healthy baseline has no automatic legacy fallback.

The inherited supervisor flock is explicitly passed on FD9 only to the replaceable root supervisor. Models, Tailscale and unprivileged children receive an explicitly replaced FD9; a controller crash cannot allow a second root owner while the supervisor survives. Recovery drains only UI services via the private parent IPC channel, refuses unknown remaining service-UID processes and preserves the loaded model and Tailscale. An ambiguous stop is held, without forced user-job termination.

The broker durably latches pending work before signing its challenge/source/epoch-bound Ed25519 ACK. Expiry, lost responses and process restarts never clear acceptance. Fresh authenticated Native health is mandatory to reopen even a previously healthy same-commit cold boot. Root API/socket/Apps/preview/model ingresses and global SDK model/tool boundaries enforce admission. A protected startup patch installs the mandatory Native admission plugin independently of optional Workspace settings; shared listeners have application-root lifetime. Public recovery status contains bounded diagnostics only.

Additional targeted checks cover the real root trust store, Ed25519 HTTP exchanges, actual pinned Native ToolsService/AgentLoop dispatch, real Linux flock/SIGKILL and preserved synthetic model/Tailscale processes, and local Git/GPGv signed staging with a rejected admission hook before activation. Docker data cutover, production stable-bootstrap upgrade, installed PWA migration and real model workloads remain separate acceptance requirements. No live rollout is claimed by these local results.
