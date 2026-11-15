'use strict';

const CHECKS = Object.freeze(['guestIdentity', 'capacity', 'fixtureCreated', 'sameDevice', 'moduleAvailable', 'mounted', 'lowerRead', 'copyUp', 'deleteWhiteout', 'lowerUnchanged', 'unmounted', 'cleaned']);
const STEPS = Object.freeze(['none', 'identity', 'capacity', 'fixture', 'same_device', 'module', 'mount', 'lower_read', 'copy_up', 'whiteout', 'lower_unchanged', 'unmount', 'cleanup', 'module_restore', 'interrupted']);
const RESTORES = Object.freeze(['not-required', 'restored', 'retained-in-use', 'retained-unknown', 'failed']);
const validNonce = nonce => typeof nonce === 'string' && /^[a-f0-9]{16}$/.test(nonce);

// Generation only. The operator must supply the managed Apps job lock, verified
// VM manifest and an outer busybox timeout45s. Never expose shell arguments to a model.
function fixedguestOverlayProbe(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length !== 2 || !Object.hasOwn(options, 'volumeId32hex') || !Object.hasOwn(options, 'nonce16hex')) throw new TypeError('Only fixed managed guest probe identities are accepted');
  const { volumeId32hex, nonce16hex } = options;
  if (typeof volumeId32hex !== 'string' || !/^[a-f0-9]{32}$/.test(volumeId32hex) || !validNonce(nonce16hex)) throw new TypeError('Invalid managed guest probe identity');
  return `#!/bin/sh
set -u
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C; export LC_ALL
fixture='/var/lib/harness/.overlay-probe-${nonce16hex}'
merged="$fixture/merged"
${CHECKS.map(name => `${name}=false`).join('\n')}
moduleInitiallyLoaded=false
moduleLoadedByProbe=false
moduleAttempted=false
fixtureDevice=unknown
moduleRestore=not-required
status=failed
failedStep=identity
kernel=unknown
fail() { status=failed; failedStep="$1"; exit 1; }
unsupported() { status=unsupported; failedStep=module; exit 0; }
mounted_here() { awk -v target="$merged" '$2 == target || index($2, target "/") == 1 { found=1 } END { exit !found }' /proc/mounts; }
unmounted_here() { awk -v target="$merged" '$2 == target || index($2, target "/") == 1 { found=1 } END { exit found ? 1 : 0 }' /proc/mounts; }
safe_fixture() {
 test "$guestIdentity" = true && test "$fixtureCreated" = true &&
 test -d "$fixture" && test ! -L "$fixture" &&
 test "$(readlink -f "$fixture")" = "$fixture" &&
 test "$(stat -c %u "$fixture")" = 0 &&
 test "$(stat -c %d "$fixture")" = "$fixtureDevice"
}
finish() {
 trap - EXIT HUP INT TERM
 if test "$moduleAttempted" = true && test "$moduleInitiallyLoaded" = false && test -d /sys/module/overlay; then moduleLoadedByProbe=true; fi
 if test "$fixtureCreated" = true; then
  if ! safe_fixture; then status=failed; failedStep=cleanup
  elif mounted_here; then
   if timeout 5 umount "$merged" >/dev/null 2>&1 && unmounted_here; then unmounted=true
   else status=failed; failedStep=unmount; fi
  elif unmounted_here; then unmounted=true
  else status=failed; failedStep=unmount
  fi
  if test "$unmounted" = true && safe_fixture && unmounted_here; then
   if timeout 5 rm -rf -- "$fixture" >/dev/null 2>&1 && test ! -e "$fixture" && test ! -L "$fixture"; then cleaned=true
   else status=failed; failedStep=cleanup; fi
  fi
 else
  unmounted=true
  cleaned=true
 fi
 if test "$moduleLoadedByProbe" = true; then
  if awk '$3 == "overlay" { found=1 } END { exit !found }' /proc/mounts; then moduleRestore=retained-in-use
  elif test ! -r /sys/module/overlay/refcnt; then moduleRestore=retained-unknown
  else
   refs=$(cat /sys/module/overlay/refcnt 2>/dev/null)
   if test "$refs" = 0; then
    if timeout 5 rmmod overlay >/dev/null 2>&1; then moduleRestore=restored; else moduleRestore=failed; fi
   else
    case "$refs" in ''|*[!0-9]*) moduleRestore=retained-unknown ;; *) moduleRestore=retained-in-use ;; esac
   fi
  fi
  case "$moduleRestore" in restored) ;; *) if test "$status" = supported; then status=failed; failedStep=module_restore; fi ;; esac
 fi
 supported=false
 if test "$status" = supported; then
  if ${CHECKS.map(name => `test "$${name}" = true`).join(' && ')}; then supported=true
  else status=failed; test "$failedStep" != none || failedStep=cleanup; fi
 fi
 payload=$(printf '{"version":1,"kernel":"%s","status":"%s","supported":%s,"failedStep":"%s","moduleInitiallyLoaded":%s,"moduleLoadedByProbe":%s,"moduleRestore":"%s","checks":{${CHECKS.map(name => `"${name}":%s`).join(',')}}}' "$kernel" "$status" "$supported" "$failedStep" "$moduleInitiallyLoaded" "$moduleLoadedByProbe" "$moduleRestore" ${CHECKS.map(name => `"$${name}"`).join(' ')} | base64 | tr -d '\\n')
 printf '\\nHARNESS_OVERLAY_${nonce16hex}=%s\\n' "$payload"
}
trap finish EXIT
trap 'status=failed; failedStep=interrupted; exit 143' HUP INT TERM
# Identity guards precede all filesystem mutations and module/mount operations.
test "$(id -u)" = 0 || fail identity
console_ok=false; cdrom_ok=false
for word in $(cat /proc/cmdline); do
 case "$word" in console=ttyS0|console=ttyS0,*) console_ok=true ;; alpine_dev=cdrom:iso9660) cdrom_ok=true ;; esac
done
test "$console_ok" = true && test "$cdrom_ok" = true || fail identity
test "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)" = QEMU || fail identity
test -d /var/lib/harness && test ! -L /var/lib/harness && test "$(readlink -f /var/lib/harness)" = /var/lib/harness || fail identity
awk '$1 == "/dev/vda" && $2 == "/var/lib/harness" && $3 == "ext4" { n++ } END { exit n != 1 }' /proc/mounts || fail identity
test -f /var/lib/harness/.stratadashseek-volume && test ! -L /var/lib/harness/.stratadashseek-volume || fail identity
test "$(stat -c %s /var/lib/harness/.stratadashseek-volume)" = 32 || fail identity
test "$(cat /var/lib/harness/.stratadashseek-volume)" = '${volumeId32hex}' || fail identity
guestIdentity=true
kernel=$(uname -r)
case "$kernel" in ''|*[!a-zA-Z0-9._+-]*) kernel=unknown ;; esac
test "\${#kernel}" -le 128 || kernel=unknown
failedStep=capacity
blocks=$(df -Pk /var/lib/harness | awk 'NR == 2 { print $4 }')
inodes=$(df -Pi /var/lib/harness | awk 'NR == 2 { print $4 }')
case "$blocks:$inodes" in *[!0-9:]*|:*|*:) fail capacity ;; esac
test "$blocks" -ge 65536 && test "$inodes" -ge 64 || fail capacity
for tool in timeout mount umount readlink stat base64 tr rm sha256sum; do command -v "$tool" >/dev/null 2>&1 || fail capacity; done
capacity=true
failedStep=fixture
test ! -e "$fixture" && test ! -L "$fixture" || fail fixture
# mkdir without -p atomically refuses a preexisting directory or symlink.
mkdir "$fixture" || fail fixture
fixtureCreated=true
fixtureDevice=$(stat -c %d /var/lib/harness) || fail fixture
mkdir "$fixture/lower" "$fixture/upper" "$fixture/work" "$merged" || fail fixture
failedStep=same_device
for dir in "$fixture" "$fixture/lower" "$fixture/upper" "$fixture/work" "$merged"; do
 test -d "$dir" && test ! -L "$dir" && test "$(stat -c %d "$dir")" = "$fixtureDevice" || fail same_device
done
sameDevice=true
failedStep=module
if test -d /sys/module/overlay || grep -qw overlay /proc/filesystems; then moduleInitiallyLoaded=true
else
 command -v modprobe >/dev/null 2>&1 || unsupported
 moduleAttempted=true
 if timeout 5 modprobe overlay >/dev/null 2>&1; then moduleLoadedByProbe=true; else unsupported; fi
fi
grep -qw overlay /proc/filesystems || unsupported
moduleAvailable=true
printf 'original-base\\n' > "$fixture/lower/base" || fail fixture
printf 'original-delete\\n' > "$fixture/lower/delete-me" || fail fixture
lower_hash=$(sha256sum "$fixture/lower/base" "$fixture/lower/delete-me") || fail fixture
failedStep=mount
timeout 5 mount -t overlay overlay -o "lowerdir=$fixture/lower,upperdir=$fixture/upper,workdir=$fixture/work" "$merged" >/dev/null 2>&1 || fail mount
mounted_here || fail mount
mounted=true
test "$(cat "$merged/base")" = original-base || fail lower_read
lowerRead=true
printf 'changed-base\\n' > "$merged/base" || fail copy_up
test "$(cat "$merged/base")" = changed-base && test "$(cat "$fixture/upper/base")" = changed-base && test "$(cat "$fixture/lower/base")" = original-base || fail copy_up
copyUp=true
rm "$merged/delete-me" || fail whiteout
test ! -e "$merged/delete-me" && test ! -L "$merged/delete-me" && test "$(cat "$fixture/lower/delete-me")" = original-delete || fail whiteout
deleteWhiteout=true
test "$(sha256sum "$fixture/lower/base" "$fixture/lower/delete-me")" = "$lower_hash" || fail lower_unchanged
lowerUnchanged=true
status=supported
failedStep=none
exit 0
`;
}

function parseOverlayProbe(text, nonce) {
  if (!validNonce(nonce) || typeof text !== 'string' || text.length > 128 * 1024) throw new TypeError('Invalid overlay probe transcript');
  const prefix = 'HARNESS_OVERLAY_' + nonce + '=', lines = text.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (!lines.length) throw new Error('Overlay probe result missing');
  const encoded = lines.map(line => line.slice(prefix.length));
  if (new Set(encoded).size !== 1) throw new Error('Conflicting overlay probe results');
  const body = encoded[0];
  if (!body || body.length > 8192 || body.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error('Invalid overlay probe encoding');
  const buffer = Buffer.from(body, 'base64');
  if (buffer.toString('base64') !== body) throw new Error('Noncanonical overlay probe encoding');
  const decoded = buffer.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(buffer)) throw new Error('Invalid overlay probe text');
  let value; try { value = JSON.parse(decoded); } catch { throw new Error('Invalid overlay probe JSON'); }
  if (JSON.stringify(value) !== decoded) throw new Error('Noncanonical overlay probe JSON');
  const fields = ['version', 'kernel', 'status', 'supported', 'failedStep', 'moduleInitiallyLoaded', 'moduleLoadedByProbe', 'moduleRestore', 'checks'];
  const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  if (!exactKeys(value, fields) || value.version !== 1 || typeof value.kernel !== 'string' || !/^[a-zA-Z0-9._+-]{1,128}$/.test(value.kernel) || !['supported', 'unsupported', 'failed'].includes(value.status) || !STEPS.includes(value.failedStep) || !RESTORES.includes(value.moduleRestore) || !exactKeys(value.checks, CHECKS) || !CHECKS.every(key => typeof value.checks[key] === 'boolean') || ['supported', 'moduleInitiallyLoaded', 'moduleLoadedByProbe'].some(key => typeof value[key] !== 'boolean')) throw new Error('Invalid overlay probe metadata');
  if (value.moduleInitiallyLoaded && value.moduleLoadedByProbe || value.supported !== (value.status === 'supported') || value.supported && (value.failedStep !== 'none' || !CHECKS.every(key => value.checks[key]) || !['not-required', 'restored'].includes(value.moduleRestore)) || !value.supported && value.failedStep === 'none') throw new Error('Inconsistent overlay probe result');
  return Object.freeze({ ...value, checks: Object.freeze({ ...value.checks }) });
}

module.exports = { fixedguestOverlayProbe, parseOverlayProbe };
