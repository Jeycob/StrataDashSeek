#!/usr/bin/env bash
set -euo pipefail
if [ -x /data/harness/bootstrap/start.sh ]; then
 exec bash /data/harness/bootstrap/start.sh
fi
mkdir -p /data/harness/logs
exec 9>/data/harness/supervisor.lock
flock -n 9 || exit 0
exec /data/harness/node/bin/node /data/harness/app/vast/supervisor.cjs
