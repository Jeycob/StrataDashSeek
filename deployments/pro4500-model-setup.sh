#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive HOME=/root
mkdir -p /data/migration /data/logs
apt-get update -qq
apt-get install -y --no-install-recommends curl ca-certificates xz-utils python3 python3-venv libgomp1 libatomic1 libnuma1 zlib1g
touch /root/.no_auto_tmux
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader > /data/migration/hardware.txt
if [ -f /sys/fs/cgroup/cpu.max ]; then
 cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max >> /data/migration/hardware.txt
else
 cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu/cpu.cfs_period_us /sys/fs/cgroup/memory/memory.limit_in_bytes >> /data/migration/hardware.txt
fi
curl -fsSL --max-time 120 https://github.com/Niko1221/Strata/releases/download/v0.2.13/install.sh -o /data/migration/install-strata.sh
STRATA_FEED=https://github.com/Niko1221/Strata/releases/download/v0.2.13 sh /data/migration/install-strata.sh
export PATH=/root/.local/bin:$PATH
exec strata launch --family qwen --model iq3_s --context 131072 --parallel 1 --vision cpu --kv int8 --tune skip --no-api-key --drafting dflash2 --access local --port 8080 --data-dir /data/strata --save-preset vast-poc --yes --no-tui --set vram-reserve-mib=1536 --set prompt-cache=12 --set conversation-cache-mib=4096 --set conversation-cache-slots=8 --set conversation-cache-min-free-mib=8192
