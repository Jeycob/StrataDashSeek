#!/usr/bin/env bash
set -euo pipefail
ROOT=/data/harness
mkdir -p "$ROOT/logs"
exec 9>"$ROOT/supervisor.lock"
flock -n 9 || exit 0
if [ ! -r "$ROOT/root-secrets/startup-update.json" ] || [ ! -r "$ROOT/root-secrets/startup-update-signers.gpg" ]; then
 echo 'Startup update policy or trust is missing; Harness remains stopped.' >&2
 exit 1
fi
# Failure intentionally holds Harness and its first model requests behind the gate.
"$ROOT/node/bin/node" "$ROOT/bootstrap/startup-update.cjs" "$ROOT"
exec "$ROOT/node/bin/node" "$ROOT/app/vast/supervisor.cjs"
