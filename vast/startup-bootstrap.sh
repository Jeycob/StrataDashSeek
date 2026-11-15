#!/usr/bin/env bash
set -euo pipefail
ROOT=/data/harness
if [ ! -r "$ROOT/root-secrets/startup-update.json" ] || [ ! -r "$ROOT/root-secrets/startup-update-signers.gpg" ]; then
 echo 'Startup update policy or trust is missing; Harness remains stopped.' >&2
 exit 1
fi
"$ROOT/node/bin/node" "$ROOT/bootstrap/runtime-paths.cjs" lock-file "$ROOT"
exec 9>"$ROOT/supervisor.lock"
flock -n 9 || exit 0
# Runs after the existing supervisor lock, so no old supervisor is migrated
# concurrently. An installed stable bootstrap requires an explicit upgrade.
"$ROOT/node/bin/node" "$ROOT/bootstrap/runtime-paths.cjs" prepare "$ROOT"
# Failure intentionally holds Harness and its first model requests behind the gate.
exec "$ROOT/node/bin/node" "$ROOT/bootstrap/runtime-launcher.cjs" "$ROOT"
