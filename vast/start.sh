#!/usr/bin/env bash
set -euo pipefail
mkdir -p /data/harness/logs
exec 9>/data/harness/supervisor.lock
flock -n 9 || exit 0
exec /data/harness/node/bin/node /data/harness/app/vast/supervisor.cjs
