#!/usr/bin/env bash
# Run as the lab user on a separate Linux x86-64 Blackwell host.
set -euo pipefail
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 1 && ( $1 == install || $1 == serve ) ]] || die "Usage: bash engine.sh {install|serve}"
action=$1
[[ $EUID != 0 ]] || die "Run as the unprivileged lab account with GPU access."
[[ $(uname -sm) == 'Linux x86_64' ]] || die "Basalt v0.5.7 requires Linux x86-64."
grep -qw avx2 /proc/cpuinfo || die "The release requires an AVX2 CPU."

lab_dir=${BASALT_LAB_HOME:-$HOME/.local/share/homeai-basalt-inkling}
[[ $lab_dir == /* && $lab_dir != / ]] || die "BASALT_LAB_HOME must name an absolute lab directory."
engine_dir=$lab_dir/engine
bundle=basalt-v0.5.7-linux-x64
runtime=$engine_dir/$bundle
archive=$engine_dir/$bundle.tar.gz
model_name=Inkling-2-Mini-NVFP4-MX8.basalt
model=$engine_dir/$model_name

# https://github.com/jesdga95/basalt/releases/expanded_assets/v0.5.7
archive_url=https://github.com/jesdga95/basalt/releases/download/v0.5.7/$bundle.tar.gz
archive_sha=a390c775c41d54454ca21c1e547855bf6c251732533ca387e8b890e538090525
archive_bytes=72149113
# Immutable model revision and the SHA-256 of the file bytes, not its Xet object ID.
model_revision=c2afac3adb772e14d77b2ea2ac7068ad4460e932
model_url=https://huggingface.co/jesdga/Inkling-2-Mini-Basalt/resolve/$model_revision/$model_name
model_sha=28ec70723feaa037942a02f55b9d5e898276f3e62a3b1fa083745f932a041b99
model_bytes=19606374189
manifest=.release-$archive_sha.sha256
model_receipt=$engine_dir/.model-$model_sha.verified

# Check the actual container, including its CUDA libraries, before a 19.6 GB transfer.
python3 - <<'PY'
import ctypes
import subprocess
import sys

if sys.version_info < (3, 10):
    sys.exit("Basalt requires Python 3.10+ with venv.")
try:
    gpu = subprocess.check_output([
        "nvidia-smi", "-i", "0", "--query-gpu=compute_cap,driver_version",
        "--format=csv,noheader,nounits",
    ], text=True).strip()
    capability, driver = (field.strip() for field in gpu.split(","))
    if capability != "12.0":
        sys.exit(f"GPU 0 reports compute capability {capability}. The release requires 12.0.")
    if tuple(map(int, driver.split("."))) < (580, 95, 5):
        sys.exit(f"The release needs Linux driver 580.95.05 or newer. Found {driver}.")
    for library in ("libcudart.so.13", "libcublas.so.13"):
        ctypes.CDLL(library)
except (OSError, ValueError, subprocess.CalledProcessError) as error:
    sys.exit(f"Check GPU 0 visibility and the CUDA 13 runtime library path: {error}")
PY

if [[ $action == install ]]; then
    mkdir -p -- "$engine_dir"
fi
[[ -d $engine_dir && ! -L $engine_dir && -O $engine_dir ]] || die "Missing or invalid lab engine directory: $engine_dir"
(( (8#$(stat -c %a -- "$engine_dir") & 0077) == 0 )) || die "The engine directory must be private to the lab account."
exec 9<"$engine_dir"
flock -xn 9 || die "Another installer or server is using $engine_dir."

file_identity() {
    [[ -f $1 && ! -L $1 ]] || return 1
    # Fixed timezone, nanosecond precision. A remount can change the device number.
    LC_ALL=C TZ=UTC0 stat -c '%d:%i:%s:%y|%z' -- "$1"
}

verify() {
    local path=$1 bytes=$2 sha=$3
    local before
    before=$(file_identity "$path") || return 1
    [[ $(stat -c %s -- "$path") == "$bytes" && $(sha256sum < "$path") == "$sha  -" ]] || return 1
    verified_identity=$(file_identity "$path") && [[ $verified_identity == "$before" ]]
}

record_verified_model() {
    local temp
    temp=$(mktemp -- "$engine_dir/.receipt.XXXXXXXX")
    printf '%s\n' "$verified_identity" > "$temp"
    mv -T -- "$temp" "$model_receipt"
}

verify_runtime() {
    [[ -d $runtime && ! -L $runtime && -f $runtime/$manifest ]] ||
        die "Missing or unrecognized installed release: $runtime"
    (cd -- "$runtime" && sha256sum --check --quiet -- "$manifest") ||
        die "Installed release files differ from the verified archive."
}

download() {
    local url=$1 path=$2 bytes=$3 sha=$4
    local part="$path.part" have=0 available published
    if [[ -e $path || -L $path ]]; then
        verify "$path" "$bytes" "$sha" || die "Existing file differs from its pin: $path"
        return
    fi
    if [[ -e $part || -L $part ]]; then
        [[ -f $part && ! -L $part && $(stat -c %h -- "$part") == 1 ]] || die "Invalid partial file: $part"
        have=$(stat -c %s -- "$part")
    fi
    if (( have < bytes )); then
        available=$(df -B1 --output=avail -- "$engine_dir" | tail -n 1)
        (( available >= bytes - have )) || die "Insufficient free disk space for $path."
        curl --disable --fail --location --proto '=https' --proto-redir '=https' \
            --retry 3 --connect-timeout 20 --continue-at - --output "$part" -- "$url"
    fi
    if ! verify "$part" "$bytes" "$sha"; then
        # Discard only our unfinished download. A rerun can fetch a clean copy.
        rm -f -- "$part"
        die "Downloaded bytes failed verification. Rerun install to fetch $path again."
    fi
    mv -T -- "$part" "$path"
    # Rename can advance ctime. All other identity fields must survive publication.
    published=$(file_identity "$path")
    if [[ ${verified_identity%|*} == "${published%|*}" ]]; then
        verified_identity=$published
    else
        verify "$path" "$bytes" "$sha" || die "File changed while publishing: $path"
    fi
}

if [[ $action == install ]]; then
    download "$archive_url" "$archive" "$archive_bytes" "$archive_sha"
    if [[ ! -e $runtime && ! -L $runtime ]]; then
        stage=$(mktemp -d -- "$engine_dir/.unpack.XXXXXXXX")
        trap 'rm -rf -- "$stage"' EXIT
        tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage"
        (cd -- "$stage/$bundle" && find . -type f -print0 | xargs -0 sha256sum) > "$stage/manifest"
        mv -- "$stage/manifest" "$stage/$bundle/$manifest"
        mv -T -- "$stage/$bundle" "$runtime"
        rmdir -- "$stage"
        trap - EXIT
    fi
    verify_runtime
    "$runtime/bin/basalt" --help > /dev/null
    # Build at the permanent path so venv entry points survive reruns.
    python3 -m venv "$runtime/.venv"
    "$runtime/.venv/bin/python" -m pip --disable-pip-version-check install \
        --no-cache-dir --only-binary=:all: -r "$runtime/requirements.txt"
    "$runtime/.venv/bin/python" -m pip check
    download "$model_url" "$model" "$model_bytes" "$model_sha"
    record_verified_model
    printf 'Installed Basalt v0.5.7 and verified %s. Start with bash engine.sh serve.\n' "$model_name"
    exit 0
fi

[[ -f $model_receipt && ! -L $model_receipt && -x $runtime/.venv/bin/python ]] || die "Run install first."
verify_runtime
current=$(file_identity "$model") || die "Missing or invalid Inkling 2 Mini pack."
if [[ $current != "$(<"$model_receipt")" ]]; then
    verify "$model" "$model_bytes" "$model_sha" || die "Inkling 2 Mini differs from its pin. Check the installation."
    record_verified_model
fi
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd -- "$runtime"
args=(--alias inkling-2-mini --host 127.0.0.1 --port 8080
      --gpu 0 --parallel 1 --max-context 131072 --kv fp8 --vision dynamic --image-remote-only)
case ${BASALT_IDLE_ENGINE:-0} in
    0) exec bin/basalt serve "$model" --python "$runtime/.venv/bin/python" "${args[@]}" ;;
    1) exec "$runtime/.venv/bin/python" -I -B -X pycache_prefix=/dev/null "$here/idle-engine.py" \
           --engine-bin "$runtime/bin/basalt" --model "$model" "${args[@]}" ;;
    *) die 'BASALT_IDLE_ENGINE must be 0 or 1' ;;
esac
