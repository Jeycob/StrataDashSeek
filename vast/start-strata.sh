#!/usr/bin/env bash
set -euo pipefail
export HOME=/root
export PATH=/root/.local/bin:$PATH
mkdir -p /data/logs
exec 9>/data/strata-start.lock
flock -n 9 || exit 0
ulimit -l unlimited 2>/dev/null || true
# Reuse the verified, pinned installation and saved configuration on normal boots.
# The full CLI remains the fallback for an unprovisioned/repaired installation.
runtime=/root/.local/share/strata/terminal/0.1.59.1
config=/root/.local/state/strata/launch/vast-poc.json
if [ -f "$config" ] && [ -x "$runtime/python/bin/python3.12" ]; then
  cd "$runtime"
  exec "$runtime/python/bin/python3.12" -m serve.server --engine strata \
    --config "$config" --host 127.0.0.1 --port 8080
fi
exec strata launch --family qwen --model iq3_s --context 131072 --parallel 1 \
  --vision cpu --kv int8 --tune skip --no-api-key --drafting dflash2 --access local --port 8080 \
  --data-dir /data/strata --save-preset vast-poc --yes --no-tui \
  --set vram-reserve-mib=1536 --set prompt-cache=12 --set conversation-cache-mib=4096 \
  --set conversation-cache-slots=8 --set conversation-cache-min-free-mib=8192



