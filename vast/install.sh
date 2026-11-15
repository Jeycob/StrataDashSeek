#!/usr/bin/env bash
# Run as root after copying this repository into /data/harness/app.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends git gpgv util-linux curl ca-certificates xz-utils python3-venv build-essential
if ! command -v tailscale >/dev/null 2>&1; then
 curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
 curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
 apt-get update -qq
 apt-get install -y --no-install-recommends tailscale
fi
mkdir -p /data/harness/{runtime,home,workspaces,state,secrets,root-secrets}
chmod 700 /data/harness/{secrets,root-secrets}
if [ ! -x /data/harness/node/bin/node ]; then
 curl -fsSL https://nodejs.org/dist/v24.21.0/SHASUMS256.txt -o /tmp/harness-node-sha
 curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o /tmp/node-v24.21.0-linux-x64.tar.xz
 (cd /tmp && grep ' node-v24.21.0-linux-x64.tar.xz$' harness-node-sha | sha256sum -c -)
 mkdir -p /data/harness/node
 tar -xJf /tmp/node-v24.21.0-linux-x64.tar.xz -C /data/harness/node --strip-components=1
fi
export PATH=/data/harness/node/bin:$PATH
cp /data/harness/app/runtime/package.json /data/harness/app/runtime/package-lock.json /data/harness/runtime/
npm ci --prefix /data/harness/runtime
python3 -m venv /data/harness/venv
/data/harness/venv/bin/pip install 'zstandard==0.25.0'
id harness >/dev/null 2>&1 || useradd --home-dir /data/harness/home --shell /bin/bash harness
# The initializer quarantines legacy logs without following their contents and
# transfers only the top-level agent directories, never recursive/hardlink data.
/data/harness/node/bin/node /data/harness/app/vast/runtime-paths.cjs prepare /data/harness
chmod 755 /data/harness/app/vast/turn-queue
chmod 644 /data/harness/app/vast/turn-queue/*.mjs
# Configure Tailscale, config.json and root-secrets/guard.json before starting.
# Before the first service start, follow README's signed startup gate setup:
# stage one recognized onstart launcher, install the independently verified
# public keyring/full fingerprint with startup-install.cjs, then start the
# installed /data/harness/bootstrap/start.sh. Keep private signing keys off-host.

