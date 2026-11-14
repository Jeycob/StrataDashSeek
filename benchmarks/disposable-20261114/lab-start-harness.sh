#!/usr/bin/env bash
set -euo pipefail
R=/data/harness
test -x "$R/node/bin/node"
test -d "$R/runtime/node_modules/@deepseek-ai/dsh"
id harness >/dev/null 2>&1 || useradd --home-dir "$R/home" --shell /bin/bash harness
mkdir -p "$R/home/.dsh/profiles/web"
cp "$R/app/deployments/2026-11-14-homeai-iq3/harness-profile.yml" "$R/home/.dsh/profiles/web/cordis.patch.yml"
chown -R harness:harness "$R/home" "$R/logs" "$R/state" "$R/workspaces"
nohup runuser -u harness -- env HOME="$R/home" DSH_HOME="$R/home/.dsh" STRATA_GATEWAY_KEY=local-strata PATH="$R/node/bin:/usr/local/bin:/usr/bin:/bin" "$R/node/bin/node" "$R/app/vast/model-proxy.cjs" > "$R/logs/model-proxy.log" 2>&1 < /dev/null &
nohup runuser -u harness -- env HOME="$R/home" DSH_HOME="$R/home/.dsh" STRATA_GATEWAY_KEY=local-strata PATH="$R/node/bin:/usr/local/bin:/usr/bin:/bin" "$R/node/bin/node" "$R/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" web --no-open --port 3090 --public-url https://benchmark.invalid/ --trusted-host benchmark.invalid > "$R/logs/harness.log" 2>&1 < /dev/null &
echo LAB_HARNESS_STARTING
