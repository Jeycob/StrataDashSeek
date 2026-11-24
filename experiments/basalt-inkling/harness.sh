#!/usr/bin/env bash
# Run the repository's Native web app on the separate Basalt lab host.
set -euo pipefail
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }
action=${1:-serve}
[[ $# -le 1 && ( $action == setup || $action == config || $action == serve ) ]] ||
    die 'Usage: bash harness.sh [setup|config]'
[[ $(uname -s) == Linux && $EUID != 0 ]] || die 'Run as an unprivileged Linux lab user.'
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source_runtime=$(cd -- "$here/../../runtime" && pwd -P)
lab=${BASALT_LAB_HOME:-$HOME/.local/share/homeai-basalt-inkling}
[[ $lab == /* ]] || die 'BASALT_LAB_HOME must be absolute.'
lab=$(realpath -m -- "$lab")
normal_dsh=$(realpath -m -- "${DSH_HOME:-$HOME/.dsh}")
case "$lab" in
    /|"$HOME"|"$normal_dsh"|"$normal_dsh"/*|"${source_runtime%/runtime}"|/data/harness|/data/harness/*)
        die 'Choose a dedicated lab directory outside the ordinary Harness installation.' ;;
esac
mkdir -p -- "$lab"
[[ -O $lab && -d $lab ]] || die 'The lab directory must belong to the lab user.'
(( (8#$(stat -c %a -- "$lab") & 0077) == 0 )) || die 'Use a private lab directory (mode 0700).'
# Setup may replace node_modules. Keep an active server on the same SDK until exit.
exec 9<"$lab"
flock -xn 9 || die 'Another lab Harness command is active.'

runtime=$lab/runtime
lab_home=$lab/home
projects=$lab/projects
project=$projects/deepseek-harness/default-workspace
for dir in "$runtime" "$lab_home/.dsh" "$project" "$lab/tmp" "$lab/npm-cache"; do
    [[ $(realpath -m -- "$dir") == "$dir" ]] || die "Expected a directory inside the lab: $dir"
done
mkdir -p -- "$runtime" "$lab_home" "$project" "$lab/tmp"
node_bin=$(type -P node) || die 'Install Node.js 24 with npm for this account.'
"$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 24 && minor >= 9 ? 0 : 1)' ||
    die 'Use Node.js 24.9 or newer in the 24.x series.'
# Do not inherit account credentials, SDK overlays, proxies, HOME or XDG paths.
lab_env=(env -i "PATH=$PATH" "HOME=$lab_home" "DSH_HOME=$lab_home/.dsh"
    "TMPDIR=$lab/tmp" "LANG=${LANG:-C.UTF-8}" DSH_TELEMETRY_DISABLED=1)
if [[ ${BASALT_IDLE_BRIDGE:-0} == 1 ]]; then
    lab_env+=(BASALT_IDLE_BRIDGE=1)
fi
if [[ $action == setup ]]; then
    npm_bin=$(type -P npm) || die 'Install npm alongside Node.js 24.'
    cp -- "$source_runtime/package.json" "$source_runtime/package-lock.json" "$runtime/"
    cd -- "$runtime"
    exec "${lab_env[@]}" "$npm_bin" ci --cache "$lab/npm-cache" --no-audit --no-fund
fi

cli=$runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
[[ -f $cli && -f $runtime/node_modules/.package-lock.json ]] &&
    cmp -s -- "$runtime/package.json" "$source_runtime/package.json" &&
    cmp -s -- "$runtime/package-lock.json" "$source_runtime/package-lock.json" ||
    die 'Install the SDK for this revision with: bash harness.sh setup'
cd -- "$project"
overlay=$lab/basalt.patch.yml
stage=$(mktemp -- "$lab/.basalt-patch.XXXXXXXX")
trap 'rm -f -- "$stage"' EXIT
"${lab_env[@]}" "$node_bin" "$here/profile.mjs" "$projects" > "$stage"
mv -T -- "$stage" "$overlay"
trap - EXIT

launch=("$node_bin")
if [[ $action == serve && ${BASALT_IDLE_BRIDGE:-0} == 1 ]]; then
    launch+=(--import "$here/idle-preload.mjs")
fi
launch+=("$cli" web --patch "$overlay")
if [[ $action == config ]]; then
    exec "${lab_env[@]}" "${launch[@]}" --dump-config
fi
# The pi-ai OpenAI client requires a credential even on a keyless loopback server.
# Never reuse a real provider key. Native browser pairing is handled by the SDK.
access_args=(--public-url http://127.0.0.1:8787/)
if [[ ${BASALT_ANDORRA_TAILNET:-0} == 1 ]]; then
    access_args=(--public-url https://basalt-inkling.tail9a42c6.ts.net/
        --trusted-host basalt-inkling.tail9a42c6.ts.net 127.0.0.1:8787)
fi
exec "${lab_env[@]}" BASALT_LOOPBACK_KEY=local-only "${launch[@]}" \
    --no-open --host 127.0.0.1 --port 8787 "${access_args[@]}"
