#!/bin/sh
# Verification is the default. Installation is only the explicit image-build step.
set -eu
export LC_ALL=C
fail() { echo "homeai-os-base: $*" >&2; exit 1; }
# Exact public policy from the pinned base layer; it already denies services.
# Keep it in place during APT, preserving/restoring its metadata even on failure.
policy_backup=
policy_target=
validate_policy() {
    [ -f "$1" ] && [ ! -L "$1" ] || fail 'pinned policy must be a regular file'
    [ "$(stat -c '%u:%g:%a:%h:%s' -- "$1")" = '0:0:755:1:255' ] || fail 'pinned policy metadata mismatch'
    policy_sha=$(sha256sum -- "$1"); policy_sha=${policy_sha%% *}
    [ "$policy_sha" = '21a8dca0d6a52cbac52cb7a86178d973616ffb42ea08747e6ff311659ab095e1' ] || fail 'pinned policy SHA256 mismatch'
}
preserve_policy() {
    validate_policy "$1"
    policy_target=$1
    policy_backup=$(mktemp -d /tmp/homeai-pinned-policy.XXXXXXXX)
    cp -p -- "$policy_target" "$policy_backup/original"
    validate_policy "$policy_backup/original"
}
restore_policy() {
    [ -n "$policy_backup" ] || return 0
    mv -T -- "$policy_backup/original" "$policy_target"
    rmdir -- "$policy_backup"
    policy_backup=
    validate_policy "$policy_target"
}
policy_exit() {
    policy_status=$?
    trap - EXIT HUP INT TERM
    restore_policy || policy_status=1
    exit "$policy_status"
}
# Package verification and install entry point.
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || fail 'usage: install-offline.sh DIRECTORY [--install]'
mode=${2:---verify}
case "$mode" in --verify|--install) ;; *) fail 'invalid mode';; esac
dir=$1
[ -d "$dir" ] && [ ! -L "$dir" ] || fail 'package directory required'
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lock=$here/os-packages.lock.tsv
tab=$(printf '\t')
count=0
while IFS="$tab" read -r name version arch sha bytes file extra; do
    [ -n "$name" ] && [ -z "$extra" ] || fail 'invalid lock row'
    case "$name" in *[!a-z0-9+.-]*) fail 'invalid package name';; esac
    case "$arch" in amd64|all) ;; *) fail 'invalid architecture';; esac
    [ "$file" = "${name}_${arch}.deb" ] || fail 'invalid local filename'
    path=$dir/$file
    [ -f "$path" ] && [ ! -L "$path" ] || fail "missing or linked package $file"
    [ "$(stat -c %h -- "$path")" = 1 ] || fail "hardlink $file"
    [ "$(stat -c %s -- "$path")" = "$bytes" ] || fail "size mismatch $file"
    actual=$(sha256sum -- "$path"); actual=${actual%% *}
    [ "$actual" = "$sha" ] || fail "SHA256 mismatch $file"
    identity=$(dpkg-deb --show --showformat='${Package}\t${Version}\t${Architecture}' "$path")
    expected=$(printf '%s\t%s\t%s' "$name" "$version" "$arch")
    [ "$identity" = "$expected" ] || fail "identity mismatch $file"
    count=$((count + 1))
done < "$lock"
actual=0
for path in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    [ -f "$path" ] && [ ! -L "$path" ] || fail 'unexpected directory or link'
    actual=$((actual + 1))
done
[ "$count" -gt 0 ] && [ "$actual" = "$count" ] || fail 'package set mismatch'
echo "Verified $count locked public Debian packages"
[ "$mode" = --install ] || exit 0
[ "$(id -u)" = 0 ] || fail 'installation needs image-build root'
trap policy_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
preserve_policy /usr/sbin/policy-rc.d
# No index refresh, remote sources, package removal, recommends or payload download.
DEBIAN_FRONTEND=noninteractive apt-get \
    -o Dir::Etc::sourcelist=- -o Dir::Etc::sourceparts=- \
    --yes --no-download --no-remove --no-install-recommends install "$dir"/*.deb
while IFS="$tab" read -r name version arch sha bytes file; do
    installed=$(dpkg-query --show --showformat='${Version}\t${Architecture}\t${db:Status-Status}' "$name")
    expected=$(printf '%s\t%s\tinstalled' "$version" "$arch")
    [ "$installed" = "$expected" ] || fail "installed version mismatch $name"
done < "$lock"
audit=$(dpkg --audit)
[ -z "$audit" ] || fail "dpkg audit: $audit"
