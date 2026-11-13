#!/usr/bin/env bash
# Run as root after copying this repository into /data/harness/app.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends git curl ca-certificates xz-utils python3-venv build-essential
if ! command -v tailscale >/dev/null 2>&1; then
 curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
 curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
 apt-get update -qq
 apt-get install -y --no-install-recommends tailscale
fi
mkdir -p /data/harness/{runtime,home,workspaces,logs,state,secrets,root-secrets}
chmod 700 /data/harness/{secrets,root-secrets}
if [ ! -x /data/harness/node/bin/node ]; then
 curl -fsSL https://nodejs.org/dist/v24.11.1/SHASUMS256.txt -o /tmp/harness-node-sha
 curl -fsSL https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz -o /tmp/node-v24.11.1-linux-x64.tar.xz
 (cd /tmp && grep ' node-v24.11.1-linux-x64.tar.xz$' harness-node-sha | sha256sum -c -)
 mkdir -p /data/harness/node
 tar -xJf /tmp/node-v24.11.1-linux-x64.tar.xz -C /data/harness/node --strip-components=1
fi
export PATH=/data/harness/node/bin:$PATH
cp /data/harness/app/runtime/package.json /data/harness/app/runtime/package-lock.json /data/harness/runtime/
npm ci --prefix /data/harness/runtime
python3 -m venv /data/harness/venv
/data/harness/venv/bin/pip install 'zstandard==0.25.0'
id harness >/dev/null 2>&1 || useradd --home-dir /data/harness/home --shell /bin/bash harness
chown -R harness:harness /data/harness/{home,workspaces,logs,state,secrets}
# Configure Tailscale, config.json and root-secrets/guard.json before starting.
# Preserve existing /root/onstart.sh and append: bash /data/harness/app/vast/start.sh &
