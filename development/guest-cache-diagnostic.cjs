'use strict';
// Source-only operator extension of the same <=180s RO-disk census runner.
// No network, old data-root daemon, persistent writes, container or image runs.
const census = require('./guest-volume-census.cjs');
function guestScript(nonce, base = census.guestScript) {
  const original = base(nonce), marker = '# Cached signed packages only. APK must fail if the cache is incomplete.';
  if (original.split(marker).length !== 2) throw Error('CENSUS_TEMPLATE_CHANGED');
  return original.slice(0, original.indexOf(marker)) + `
apk --version
apk_reason() {
  if grep -qi 'read-only file system' /tmp/census-apk.log; then echo CENSUS_APK_REASON=READONLY_CACHE;
  elif grep -qi 'permission denied' /tmp/census-apk.log; then echo CENSUS_APK_REASON=PERMISSION;
  elif grep -Eqi 'untrusted signature|bad signature|signature.*invalid' /tmp/census-apk.log; then echo CENSUS_APK_REASON=SIGNATURE;
  elif grep -qi 'unable to select packages' /tmp/census-apk.log; then echo CENSUS_APK_REASON=PACKAGE_SELECTION;
  elif grep -qi 'no such file' /tmp/census-apk.log; then echo CENSUS_APK_REASON=MISSING_FILE;
  else echo CENSUS_APK_REASON=OTHER_REDACTED; fi
}
if timeout 10 apk --cache-dir /mnt/old-volume/apk-cache --no-network add docker > /tmp/census-apk.log 2>&1; then
  echo CENSUS_READONLY_APK_STATUS=0
else
  apk_status=$?
  printf 'CENSUS_READONLY_APK_STATUS=%s\\n' "$apk_status"
  apk_reason
  # Only signed package/index regular files are copied. The original cache is
  # still ro,noload; RAM copy has an independent hard 128 MiB bound.
  mkdir /tmp/census-cache
  mount -t tmpfs -o size=134217728,nodev,nosuid,noexec,mode=0700 tmpfs /tmp/census-cache
  cache_count=0; cache_bytes=0
  for item in /mnt/old-volume/apk-cache/*; do
    test -e "$item" || continue
    case "$item" in *.apk|*/APKINDEX.*.tar.gz) ;; *) continue;; esac
    test -f "$item" && test ! -L "$item"
    amount=$(stat -c %s "$item")
    case "$amount" in ''|*[!0-9]*) echo CENSUS_CACHE_METADATA_INVALID; exit 1;; esac
    cache_count=$((cache_count + 1)); cache_bytes=$((cache_bytes + amount))
    test "$cache_count" -le 200 && test "$cache_bytes" -le 125829120
    cp "$item" /tmp/census-cache/
  done
  printf 'CENSUS_RAM_CACHE_FILES=%s BYTES=%s\\n' "$cache_count" "$cache_bytes"
  if timeout 45 apk --cache-dir /tmp/census-cache --no-network add docker > /tmp/census-apk.log 2>&1; then echo CENSUS_RAM_APK_STATUS=0;
  else
    apk_status=$?; printf 'CENSUS_RAM_APK_STATUS=%s\\n' "$apk_status"; apk_reason
    # A cache index is repository-URL keyed. Diagnose public package names,
    # then explicitly select the already bounded signed package files.
    awk 'length($1)<120 && $1 ~ /^[a-zA-Z0-9][a-zA-Z0-9+_.-]*$/ && /no such package|missing|conflict|breaks/ {print "CENSUS_APK_SELECTION_PACKAGE=" $1}' /tmp/census-apk.log
    for package in /tmp/census-cache/*.apk; do
      test -f "$package" && test ! -L "$package"
      name=$(basename "$package")
      case "$name" in *[!a-zA-Z0-9+_.-]*|'') echo CENSUS_CACHE_NAME_REFUSED; exit 1;; esac
      test "\${#name}" -lt 160
      printf 'CENSUS_CACHED_PACKAGE=%s\\n' "$name"
    done
    set -- /tmp/census-cache/*.apk
    # The diskless guest is intentionally discarded. This acknowledges ONLY
    # package persistence loss; signature verification remains mandatory.
    if timeout 45 apk --no-network --no-cache --force-non-repository add "$@" > /tmp/census-apk.log 2>&1; then echo CENSUS_EXPLICIT_APK_STATUS=0;
    else
      apk_status=$?; printf 'CENSUS_EXPLICIT_APK_STATUS=%s\\n' "$apk_status"; apk_reason
      awk 'length($1)<120 && $1 ~ /^[a-zA-Z0-9][a-zA-Z0-9+_.-]*$/ && /no such package|missing|conflict|breaks/ {print "CENSUS_APK_SELECTION_PACKAGE=" $1}' /tmp/census-apk.log
      # This bounded log was just produced by public signed-package install
      # inside the empty guest. It contains no old config, environment or data.
      echo CENSUS_PUBLIC_APK_DIAGNOSTIC_BEGIN
      tail -c 4096 /tmp/census-apk.log
      printf '\\nCENSUS_PUBLIC_APK_DIAGNOSTIC_END\\n'
      exit 1
    fi
  fi
fi
printf '\\nrc_cgroup_mode="unified"\\n' >> /etc/rc.conf
rc-service cgroups start > /tmp/census-cgroup.log 2>&1
test -f /sys/fs/cgroup/cgroup.controllers
if modprobe overlay > /tmp/census-overlay-module.log 2>&1 && grep -qw overlay /proc/filesystems; then echo CENSUS_OVERLAY_MODULE=available;
else echo CENSUS_OVERLAY_MODULE=unavailable; fi
daemon=''
trap 'if test -n "$daemon"; then kill "$daemon" 2>/dev/null || true; wait "$daemon" 2>/dev/null || true; fi' EXIT
for driver in vfs overlay2; do
  root=/tmp/homeai-empty-$driver
  socket=/tmp/homeai-$driver.sock
  mkdir "$root"
  dockerd --data-root="$root" --exec-root=/tmp/homeai-exec-$driver --pidfile=/tmp/homeai-$driver.pid --host=unix://$socket --storage-driver="$driver" --bridge=none --iptables=false --ip-forward=false --ip-masq=false > /tmp/census-daemon.log 2>&1 &
  daemon=$!; ready=0; attempt=0
  while test "$attempt" -lt 20; do
    if docker -H unix://$socket info --format '{{.CgroupVersion}}' > /tmp/census-ready 2>/dev/null; then ready=1; break; fi
    if ! kill -0 "$daemon" 2>/dev/null; then break; fi
    attempt=$((attempt + 1)); sleep 1
  done
  printf 'CENSUS_NEW_EMPTY_DAEMON driver=%s ready=%s\\n' "$driver" "$ready"
  if test "$ready" = 1; then
    test "$(cat /tmp/census-ready)" = 2
    test -z "$(docker -H unix://$socket ps -aq)"
    test -z "$(docker -H unix://$socket image ls -aq)"
    docker -H unix://$socket info --format 'CENSUS_CAPABILITIES memory={{.MemoryLimit}} swap={{.SwapLimit}} cpuCfsPeriod={{.CPUCfsPeriod}} cpuCfsQuota={{.CPUCfsQuota}} pids={{.PidsLimit}} cgroupVersion={{.CgroupVersion}} cgroupDriver={{.CgroupDriver}} storageDriver={{.Driver}}'
  else
    if grep -Eqi 'failed to mount overlay|overlay.*not supported|driver not supported|no such device' /tmp/census-daemon.log; then echo CENSUS_DAEMON_REASON=STORAGE_UNSUPPORTED;
    else echo CENSUS_DAEMON_REASON=OTHER_REDACTED; fi
  fi
  kill "$daemon" 2>/dev/null || true
  attempt=0
  while kill -0 "$daemon" 2>/dev/null; do attempt=$((attempt + 1)); test "$attempt" -lt 10; sleep 1; done
  wait "$daemon" 2>/dev/null || true
  daemon=''
  if test "$driver" = vfs && test "$ready" != 1; then exit 1; fi
done
echo CENSUS_NO_OLD_STORE_RECLAIMABILITY_OR_CONTAINER_ENFORCEMENT_PROOF=1
`;
}
module.exports = { guestScript };
