# Archived Harness data: offline maintenance purge

This is a permanent deletion phase of the existing root boot/maintenance process. It is **not** the live minute cache callback, an Apps-only fence, or a model tool. Eligible archived data may be removed immediately (retention zero); the user's category authorization does not require another per-session prompt. Never interrupt current user jobs to create a purge window. Wait for the operator's genuine controlled Native/plugin shutdown, or an already quiescent cold boundary.

## Supported current profile

Pinned SDK `0.2.2-rc.2`: JSONL Zstandard sessions; official JSON storage backend; workspace domain v2; per-record projection cache v7 (its declared legacy stamps accepted); retained schedule domain v2/v1. The inspected production base/web profile uses JSON storage without route overrides and query SQLite `path: ':memory:', openAt: never`. Disk SQLite or another persisted domain is unsupported and must be declared unknown/KEEP, not ignored. This source does not evaluate config expressions, initialize models, start schedules, query a cloud service or issue raw SQL.

The adapter reads schedule targets, involved sessions, delivery history/pending targets and explicit creation cwd through the SDK schedule schema. It never changes the schedule domain. `workspace.before-import.json` has **no identified automatic consumer** in the inspected pinned SDK/boot path: `openSingleUnit` for spec `workspace` opens only `workspace.json`. Its manual restore status is therefore unknown, not proven active. By default, only its referenced session IDs/Linux paths KEEP their targets with `workspace-before-import-restore-status-unknown`. After the operator establishes historical-only status and absence of a configured restore consumer, optional private `historicalWorkspaceBackupHash` can bind that exact canonical JSON digest; the file remains untouched but is no longer mistaken for an active restore dependency. This is factual classification under existing authorization, not another user approval. Unknown storage entries, schemas, cache recovery files and unexplained artifacts refuse the operation. Legacy projection rows are removed through the official JSON backend too, preventing a later bootstrap from resurrecting them. Conversation/projection text is not copied into the deletion manifest or journal; projection state is represented by hashes.

## Ownership and barrier

The stable `RuntimeLauncher.launchUi()` calls `beforeNativeStart` after release verification and **before every supervisor spawn**, including rollback/recovery. Install `vast/offline-purge-maintenance.cjs` alongside the stable launcher during the explicit root bootstrap upgrade. Merely updating the agent release cannot replace that bootstrap. The helper uses a separately pinned, signed `engineCommit`, so a UI rollback cannot bypass or substitute unfinished purge recovery code.

The helper closes the root admission broker, requires its unchanged epoch, validates the inherited root FD9 supervisor flock, and scans `/proc` for absence of **all service-UID processes**. Existing controlled `stopUi()` must have acknowledged shutdown before a recovery restart reaches this hook; initial startup already requires the cold UID boundary. Surviving background tools/VM/Native writers cause refusal. Apps disabled, a stopped UI window, a PID file or SIGSTOP of a supervisor is not this barrier. There is deliberately no network hot-purge endpoint or automatic kill-all.

Every target session also takes the SDK's actual asynchronous POSIX flock on the existing `session.lock`, without truncating or recreating it. The inode and its directory remain as small sentinels after every log generation is removed. An incomplete journal must reconcile successfully before Native can start. A malformed or conflicting journal keeps admissions closed; missing metadata is not silently treated as successful cleanup.

Loading mutable npm code as root is forbidden. The helper checks the SDK module tree for root ownership, no group/other write permission, safe regular files and only internal links. If the current installation fails this check, do not weaken it or auto-chown an unknown tree. The operator must establish trusted installed SDK ownership before privileged execution.

## Private inputs, not public application UI

All request/graph/plan/journal files live in `/data/harness/root-secrets/runtime/state`, root-owned and not writable by the service user. Do not commit real session IDs, capture data or generated plans. The root config `offline-purge-config.json` contains:

```json
{
  "version": 1,
  "engineCommit": "<signed 40-character executor commit>",
  "sdkVersion": "0.2.2-rc.2",
  "backend": "json",
  "domainRoutes": {"workspace":"json","session_projcache":"json","schedule":"json"},
  "graphFile": "/data/harness/root-secrets/runtime/state/offline-purge-graph.json",
  "planFile": "/data/harness/root-secrets/runtime/state/offline-purge-plan.json",
  "applyPlanHash": null,
  "protectedIds": ["<current user and QA session IDs from the operator handoff>"],
  "protectedWorkspaceIds": ["<retained QA/current workspace IDs>"],
  "protectedPaths": ["<retained source/QA paths>"]
}
```

`domainRoutes` records effective routing, including the retained schedule domain. The helper requires a nonempty explicit private protection policy and merges it into the graph; it cannot be bypassed by omitting protections from an inventory. Current user, pinned/current/saved-resume and retained QA IDs/roots must be populated from the operator's actual inventory. No keys or owner cookies are inputs.

The **root-owned actual reference capture** has this schema (the example is structural, not an assertion that any real graph is complete):

```json
{
  "version": 1,
  "sdkVersion": "0.2.2-rc.2",
  "metadataIdentity": "<identity from createSDKAdapter(...).inspect() at this same closed boundary>",
  "sessionMetadataDomains": ["workspace","session_projcache","schedule"],
  "coverage": {
    "lineage":true,"plugins":true,"activity":true,"savedResume":true,
    "appsPublished":true,"appsRollback":true,"appsRecovery":true,"appsJobs":true,
    "appsDataOps":true,"snapshots":true,"restore":true
  },
  "unknown": [],
  "references": [{"source":"apps-published","sessionIds":[],"paths":[],"workspaceIds":[]}],
  "witnesses": [{"path":"<actual retained reference source>","kind":"json","sha256":"<canonical JSON digest>"}]
}
```

Use the actual closed Apps/deployment/dataOps/snapshot/job/plugin inventory, not empty arrays copied from this example. Coverage is a trusted root capture attestation, **not something this adapter can infer from directory names**. The operator must include every current/published/rollback/recovery/job/resume reference, including durable journals and saved VM mounts. An unavailable producer is listed in `unknown`, or has coverage false; all candidates then KEEP. The actual profile evidence must establish that no additional persistent session domain or query DB is omitted.

The SDK identity binds current headers/revisions, canonical metadata, schedule and backup hashes. External reference witnesses bind the remaining graph. JSON witnesses use `digest(parsedJSON)` exported by `offline-purge.mjs`; `kind: bytes` uses SHA256 of bytes (for example a closed Apps deployment DB plus required sidecars). The four inspected base/web/profile layer files (`dsh-base/cordis.patch.yml`, `dsh-web-app/cordis.patch.yml`, and the web profile's `cordis.yml`/`cordis.patch.yml`) are mandatory byte witnesses: YAML is not evaluated and file contents are never exported. Do not witness files this purge itself mutates: SDK/workbench state is already covered by `metadataIdentity` and the metadata baseline. Other production witnesses are restricted to Apps state and private root capture metadata; secret/key/vault files are rejected.

## Operator commands and integration

These commands run **inside the established offline root maintenance context**, with its genuine locked FD9 inherited. Calling them from an ordinary shell without that lease, with an open broker, or while Native/service-UID jobs survive must fail. They do not stop a running instance by themselves.

1. Collect the actual closed reference graph and protections. `createSDKAdapter({root:'/data/harness',engineCommit:...}).inspect().identity` supplies the graph binding; close the adapter after capture. The graph is not safe for apply if collected before quiescence or if any witness changes.
2. Produce the private dry-run manifest:

   ```sh
   /data/harness/node/bin/node /data/harness/bootstrap/offline-purge-maintenance.cjs plan /data/harness
   ```

   It reports a content-bound `planHash`, eligible IDs and KEEP reasons. The private plan contains exact absolute target paths, parent/leaf dev+inode identities, hashes, allocated blocks (`stat.blocks * 512`), source/metadata bindings and only the approved workspace registration removals. It never treats an unregistered directory or missing log as disposable. Windows planning cannot claim Linux allocated-byte evidence.
3. The already authorized operator sets `applyPlanHash` to that exact manifest hash in the private config, then executes under the same barrier:

   ```sh
   /data/harness/node/bin/node /data/harness/bootstrap/offline-purge-maintenance.cjs apply /data/harness
   ```

   Alternatively the next controlled boot executes the bound request before Native starts. Immediately before intent it acquires all session locks and regenerates the plan; any difference refuses before unlink. No per-ID user approval is added.
4. The durable journal phases are `logs → metadata → projects → complete`. It removes only listed log generations, keeps their lock inode, removes archive/member/cache/workbench state through pinned SDK contracts, then removes exact unreferenced managed roots and owned change/checkpoint data. It restores original metadata UID/GID/mode, so a root atomic rewrite cannot strand the non-root Native service. Restore-state directories are conservatively retained. Native worktrees/legacy/continue projects, hardlinks, foreign artifacts, mount crossings, lineage edges, active/pinned/protected/shared roots and unknown refs KEEP. Leaf symlinks may be unlinked but never traversed.
5. On failure/restart, leave the config, graph and journal intact. The boot hook reacquires locks and replays forward using before/after metadata comparisons. The explicit equivalent, under the same barrier, is `/data/harness/node/bin/node /data/harness/bootstrap/offline-purge-maintenance.cjs recover /data/harness`; it never begins a new batch. A new log, changed graph, changed unrelated state or unexplained remaining file blocks restart; do not mark it complete or restart Native around the hook. Permanent unlink has no automatic rollback; use the established external backup only for deliberate operator restoration.
6. Successful postverification proves target logs/archive/member/cache/workbench records absent and sentinels retained. The report gives exact removals, planned allocated bytes, filesystem free bytes before/after and the **signed** net free-byte delta; journal overhead or unrelated filesystem activity can affect the delta. No reclaimed production bytes are claimed by source/fixture tests.

After completion the request is consumed and later boots take the completed receipt fast path without rescanning the SDK. Preserve/rotate a completed journal to a root-owned hash-named historical receipt before requesting a different cleanup batch; never discard an unfinished journal. No change was made to the existing automatic npm-cache or Apps temporary-copy cleanup. The offline phase complements them at a safe maintenance boundary.

## Validation scope

Linux fixtures exercise actual allocated blocks, interrupted/partial unlink and metadata replay, stale plans/graphs, shared and retained roots, alias references, unknown graphs and concurrent applies. A separate **actual SDK POSIX flock** child proves exclusion and lock release after process death without inode replacement. The pinned SDK JSON/JSONL fixture runs the real adapter and whole Linux transaction, interrupts an actual SDK workspace write, recovers, checks schedule/restore-backup references KEEP, preserves untouched schedule bytes, removes legacy cache rows and checks restored UID1001 metadata ownership. The launch test proves failed purge recovery prevents supervisor spawn. These are local fixtures, not production deletion or live bootstrap acceptance.
