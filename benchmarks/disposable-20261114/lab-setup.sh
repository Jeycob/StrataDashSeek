#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive HOME=/root
mkdir -p /data/lab /data/harness/{app,runtime,home,logs,state,workspaces,root-secrets}
apt-get update -qq
apt-get install -y --no-install-recommends curl ca-certificates git xz-utils python3 libgomp1 libatomic1 libnuma1 zlib1g
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader > /data/lab/hardware.txt
cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max >> /data/lab/hardware.txt
curl -fsSL --max-time 120 https://github.com/Niko1221/Strata/releases/download/v0.2.13/install.sh -o /data/lab/strata-install.sh
STRATA_FEED=https://github.com/Niko1221/Strata/releases/download/v0.2.13 sh /data/lab/strata-install.sh
export PATH=/root/.local/bin:$PATH
strata --version
# Download/preparation/inference are a separate bounded process group.
setsid bash -c 'exec strata launch --family qwen --model iq3_s --context 131072 --parallel 1 --vision cpu --kv int8 --tune skip --no-api-key --drafting dflash2 --access local --port 8080 --data-dir /data/strata --save-preset lab --yes --no-tui --set vram-reserve-mib=1536 --set prompt-cache=12 --set conversation-cache-mib=4096 --set conversation-cache-slots=8 --set conversation-cache-min-free-mib=8192' > /data/lab/strata.log 2>&1 < /dev/null &
echo $! > /data/lab/strata.pid
git clone --quiet https://github.com/Jeycob/StrataDashSeek.git /data/lab/source
git -C /data/lab/source checkout --quiet 1c84cf9
cp -a /data/lab/source/. /data/harness/app/
curl -fsSL --max-time 120 https://nodejs.org/dist/v24.21.0/SHASUMS256.txt -o /data/lab/node-sha
curl -fsSL --max-time 120 https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o /data/lab/node.tar.xz
(cd /data/lab; grep ' node-v24.21.0-linux-x64.tar.xz$' node-sha | sed 's/node-v24.21.0-linux-x64.tar.xz/node.tar.xz/' | sha256sum -c -)
mkdir /data/harness/node
tar -xJf /data/lab/node.tar.xz -C /data/harness/node --strip-components=1
export PATH=/data/harness/node/bin:$PATH
cp /data/harness/app/runtime/package*.json /data/harness/runtime/
npm ci --prefix /data/harness/runtime --no-audit --no-fund
mkdir -p /data/harness/home/.dsh/profiles
cp /data/harness/app/deployments/2026-11-14-homeai-iq3/harness-profile.yml /data/harness/home/.dsh/profiles/default.yml
echo LAB_SETUP_READY
