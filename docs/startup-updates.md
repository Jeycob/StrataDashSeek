# Updates before the first Harness request

The required managed startup gate follows `main` in the public
`Jeycob/StrataDashSeek` repository. It fetches only at instance startup, verifies
the **actual Git commit signature** with a locally pinned public key, stages the
signed source tree, and switches the application pointer before launching
Harness. It needs no GitHub token and never downloads model weights.

GitHub's `verification.verified` is not the trust decision: a correctly signed
local commit can have an unrecognized committer email on GitHub. `gpgv` must
verify the signed commit payload against the separately installed keyring and
an explicitly pinned full fingerprint. Repository contents cannot change this
keyring or its policy.

## Installation

Linux root, Git, Python 3, `gpgv`, and the existing Harness Node runtime are
required. Export only the trusted public signing key from the operator's
computer. Keep the private signing key there. Transfer the public keyring to
a root-only file on the server, then run:

```sh
node /data/harness/app/vast/startup-install.cjs \
  /root/operator-public-signers.gpg FULL_PRIMARY_FINGERPRINT
```

The installer recognizes exactly one existing
`bash /data/harness/app/vast/start.sh` line in `/root/onstart.sh`, preserves the
rest of that file, and stores a root-only backup. Unrecognized startup commands
need explicit operator integration; the installer does not guess. It installs
a stable bootstrap outside the release tree, which is essential for recovery
if power is lost while switching the first directory to a release pointer.
Installing the gate does not restart a model or a running conversation.
The stable updater and extractor are not replaced by automatic code releases.
Their upgrade requires a separate reviewed operator maintenance plan,
so a failed code activation cannot leave a mixed recovery implementation.

Install the gate before the first service start on a new instance. The normal
`vast/start.sh` entry refuses a missing, non-file or non-executable stable
bootstrap; it has no direct-supervisor fallback. The installer can prepare the
gate while services remain stopped and publishes its executable entry only
after policy, public trust and updater files are present. An existing stable
updater is not silently overwritten: apply a reviewed operator upgrade before
claiming that a running installation has these newer policy checks.

Private policy is `/data/harness/root-secrets/startup-update.json`. Its source
is fixed to this repository's `main` branch. The keyring is separately pinned
in `startup-update-signers.gpg`. The bootstrap uses the existing supervisor
lock so parallel startup invocations cannot deploy twice.

## Activation and failure behavior

- A normal boot performs one shallow Git fetch, verifies the commit, and skips
  extraction when that exact release is already applied.
- Changed source is extracted to a bounded private stage. Absolute paths,
  traversal, links, devices, duplicates and oversized archives are rejected.
- The candidate runtime manifests must match the installed runtime exactly.
  A dependency upgrade is an explicit maintenance operation. The gate blocks
  first queries rather than run newer code against incompatible dependencies.
- Critical JavaScript and bootstrap syntax is checked before activation.
  At least 2 GiB disk reserve must remain. Models, caches, sessions, profiles,
  configuration, credentials, project source and application databases stay
  outside the release tree and are preserved.
- The previous code directory is retained. A private, durable journal recovers
  interrupted pointer changes through the stable bootstrap. Activation failure
  restores the previous pointer. Old models, caches or backups are not pruned.
- Network, signature, dependency or disk errors block startup. They do not
  silently launch a stale release, change the rental or create another instance.
  An administrator can repair the cause and invoke the stable bootstrap again.
- Missing, malformed or disabled update policy also blocks startup and check-only
  validation. `enabled` must be the JSON boolean `true`; absent values and strings
  cannot authorize stale-source startup. No offline or unsigned fallback permits
  the first model request. Root-only maintenance primitives remain available for
  controlled recovery; they are not an alternate normal service-start path.

`node /data/harness/bootstrap/startup-update.cjs /data/harness --check` verifies
and stages the current signed `main` without switching the live application or
changing its published status. Use this while preparing a deployment; it does
not prove that a production cold start has completed.

The read-only `state.update` field of `/api/workbench` exposes version, enabled,
phase, checkedAt, appliedCommit, targetCommit, error and signatureVerified.
It contains no credentials, keyring paths, cookies or raw command output.
`ready` describes verified source activation, not completion of model loading.
Existing model health and application lifecycle checks remain separate.

Service packages are loaded from the persistent runtime, independently of the
release pointer (`HOMEAI_RUNTIME`, or `/data/harness/runtime`). No global module
path is added to project processes. Push data defaults use `HOMEAI_ROOT`, the
parent of an explicit runtime, or the existing `/data/harness` installation;
explicit push configuration paths retain priority. ESM command entry checks
compare real file paths so a launch through `app` still executes its main code.

## Verification

The portable Node regression checks use a real signed public commit and public
key, then prove that modified content and an unpinned signer fail. Linux root
checks separately test interrupted activation, actual unprivileged reading of
the release, retained project files and tampered/link-containing source trees.
Python checks exercise ordinary extraction plus traversal, absolute paths,
symlinks, hardlinks, devices and extraction limits. Run Linux-specific checks
in an isolated fixture, never against production directories.

```sh
node --test vast/startup-update.test.cjs
node --test vast/startup-update-linux-check.cjs
python3 vast/startup-extract-tests.py
```

This is a code update gate, not a new whole-stack installer. Runtime upgrades,
signer rotation, model changes and data migrations require their own checked
maintenance plan. A code release that passes startup checks can still have an
application defect; inspect service health after a deployment.
