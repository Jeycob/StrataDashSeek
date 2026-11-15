# Privileged runtime paths

This fixes root writes through agent-owned paths. It does not introduce a
separate per-project OS identity or a general secret broker. Projects remain
owner-trusted; that broader isolation limit still applies.

| Purpose | Path below `/data/harness` | Ownership and access |
| --- | --- | --- |
| Authoritative root state | `root-secrets/runtime/state` | root, directory0700/files0600 |
| Root service logs | `root-secrets/runtime/logs` | root only |
| Retained old logs/layout | `root-secrets/runtime/legacy` | root only; no recursive ownership change |
| Sanitized reader status | `runtime-status` | root writes; directory0755/files0644 |
| Existing Harness login log only | `logs/harness.log` | root-owned parent0750, group `harness`; file root:`harness`0640 |
| Project/plugin inputs | `state`, `home`, `workspaces`, `secrets` | existing service identity; no recursive chown |
| Stable startup code | `bootstrap` | root-owned and separately upgraded |

All other service logs, including non-root Apps/push/proxy children, are private.
Children write their inherited stdout/stderr descriptors, not privileged log
names. The service account may read its Harness log for the existing local
login flow. It cannot replace that log name, change its owner/mode, traverse
`root-secrets`, or read privileged service logs. Login URLs are never copied
into public telemetry. Public status writers use a field allowlist and redact
authentication URLs; service logs are not a supported public status type.

Every privileged output checks all parent components, rejects symlinked or
non-root/writable parents, and rejects non-regular, linked or writable files.
Root-owned sticky ancestors such as `/tmp` are allowed for isolated fixtures;
the chosen runtime root itself must be non-writable outside root. Logs use
`O_NOFOLLOW`, descriptor validation and a single-link/root-owned inode before
group/mode changes. Atomic state writes use exclusive random temporaries in a
protected parent. Lock files retain their inode across restarts.

Root reads lifecycle, activity, queue and maintenance input only after dropping
to the service UID/GID and clearing supplementary privileges. These remain
advisory owner-controlled inputs. A malicious service account can falsify its
own activity/maintenance claims; this change does not solve that availability
or cost risk. It cannot use an input path to make the privileged reader open
a root-only credential file. Missing or invalid required activity holds idle
stop rather than authorizing it.

The root billing wrapper collects into its own protected directory and
publishes only allowlisted rate measurements. It never appends, chmods or
chowns a ledger in the writable efficiency-event directory. Previous ledgers
are retained as `.legacy-*`; they are not silently trusted/imported as new
authoritative measurements. Operators can explicitly inspect those historical
files. Compatibility read aliases are created by a privilege-dropped helper;
root never writes through them or relies on them for its own control state.

## Reviewed migration of an existing installation

Do not replay the full first-install script. This migration requires a reviewed
maintenance window with the old supervisor and privileged children stopped.
No deployment, account mutation or restart is performed by the local tests.

1. Verify the reviewed signed source and the existing independently pinned
   public keyring/fingerprint. Preserve the model, project files, vault identity
   and current application data. Check `/data/harness` and its ancestors are
   protected; unexpected links/owners are refused, never recursively repaired.
2. Run the reviewed gate installer as root using the existing public trust:

   ```sh
   /data/harness/node/bin/node /data/harness/app/vast/startup-install.cjs \
     /root/operator-public-signers.gpg FULL_PRIMARY_FINGERPRINT \
     --upgrade-bootstrap
   ```

   The flag is an explicit operator upgrade. Ordinary source activation does
   **not** update the stable bootstrap. A changed bootstrap without the flag is
   refused. The old bootstrap bytes and onstart text are retained privately.
   Dependencies are copied before their consumer; the executable entry is last.
3. The initializer atomically moves the old log entry into the private legacy
   directory without traversing its children. It creates the protected log
   parent and changes only top-level agent-directory ownership, not existing
   project files. Existing status/ledger files are retained under `.legacy-*`
   names when reader aliases are installed by the unprivileged helper.
   Re-running an already successful migration does not archive logs again.
4. The installer preserves other onstart commands and rewrites the recognized
   supervisor redirect to `root-secrets/runtime/logs/supervisor.log`. Start
   through the reviewed stable bootstrap after the maintenance window is ready:

   ```sh
   nohup bash /data/harness/bootstrap/start.sh \
     > /data/harness/root-secrets/runtime/logs/supervisor.log 2>&1 < /dev/null &
   ```

5. Verify the signed update report in `runtime-status/startup-update.json`,
   service health, local owner login, telemetry, private preview reconciliation
   and idle-stop behavior. `source ready` alone is not runtime health proof.
   Do not restore the old vulnerable directory ownership for rollback. Preserve
   this I/O hardening when rolling back application code, or hold startup for
   operator recovery. Retained logs and previous bootstrap bytes are evidence,
   not permission to execute an unsafe old layout.

Normal wakes acquire the protected supervisor lock and idempotently validate
the layout before launching services. An interrupted explicit upgrade can be
re-run with the same reviewed source/trust; unknown trust changes are refused.

A source update reached through an older stable gate remains startup-compatible:
the new supervisor publishes source status from the root-owned applied record
only after verifying the exact active release digest. It never adopts the
legacy agent-writable diagnostic. `bootstrapUpgradeRequired:true` records that
the stable gate still needs its explicit operator upgrade. Until that upgrade,
the older gate's pre-supervisor legacy diagnostic/log handling remains a known
host migration gap; publishing this source alone does not close it. Do not
describe a host as fully remediated without the reviewed bootstrap/onstart step.

## Local evidence scope

Run `node --test vast/runtime-paths.test.cjs` for portable publication checks.
Run `node --test vast/runtime-paths-linux-check.cjs` and
`vast/startup-update-linux-check.cjs` as root in an isolated local Linux fixture
with the existing `nobody` UID65534. They create only uniquely named `/tmp`
fixtures, drop capabilities for the attacker, and check symlink/hardlink,
parent replacement, restarts, preserved victim ownership/content, status/log
confidentiality and explicit bootstrap upgrades. Python regression files use
hyphenated names and must be executed directly, not silently omitted by
`unittest discover`: `python3 vast/test-runtime-paths.py`,
`vast/test-preview-settings.py`, and `vast/test-idle-guard.py`.

These local checks do not prove a production migration, vendor permission
behavior on a different host, or full per-project OS isolation.
