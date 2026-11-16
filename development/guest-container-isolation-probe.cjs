'use strict';
// Operator-only extension of the read-only census VM. All objects below live
// in NEW guest RAM; no production project, original Docker root or network.
const diagnostic = require('./guest-cache-diagnostic.cjs');
function guestScript(nonce, base = diagnostic.guestScript) {
  if (!/^[a-f0-9]{16}$/.test(nonce)) throw Error('NONCE_INVALID');
  // Package setup + cgroup topology only: avoid two redundant daemon cycles
  // before this bounded combined proof. VFS/overlay2 readiness was recorded.
  const prior = base(nonce, undefined, {skipDaemonProbe:true}), marker = 'echo CENSUS_NO_OLD_STORE_RECLAIMABILITY_OR_CONTAINER_ENFORCEMENT_PROOF=1';
  if (prior.split(marker).length !== 2) throw Error('CENSUS_TEMPLATE_CHANGED');
  return prior.slice(0, prior.indexOf(marker)) + `
echo ISOLATION_SCOPE=fresh_guest_RAM_synthetic_no_production_project
mkdir /tmp/isolation-docker /tmp/isolation-rootfs /tmp/isolation-a /tmp/isolation-b
daemon_group=/sys/fs/cgroup/homeai-probe-daemons/isolation
mkdir "$daemon_group"
test -f "$daemon_group/memory.swap.max"
sh -c 'group=$1; shift; printf "%s\\n" "$$" > "$group/cgroup.procs"; exec "$@"' probe "$daemon_group" dockerd --data-root=/tmp/isolation-docker --exec-root=/tmp/isolation-exec --pidfile=/tmp/isolation.pid --host=unix:///tmp/isolation.sock --storage-driver=vfs --cgroup-parent=/homeai-probe-containers --bridge=none --iptables=false --ip-forward=false --ip-masq=false > /tmp/isolation-daemon.log 2>&1 &
daemon=$!; attempt=0
trap 'kill "$daemon" 2>/dev/null || true; wait "$daemon" 2>/dev/null || true' EXIT
until docker -H unix:///tmp/isolation.sock info --format '{{.CgroupVersion}}' > /tmp/isolation-ready 2>/dev/null; do attempt=$((attempt+1)); test "$attempt" -lt 20; kill -0 "$daemon"; sleep 1; done
test "$(cat /proc/$daemon/cgroup)" = '0::/homeai-probe-daemons/isolation'
test -f "$daemon_group/memory.swap.max"
echo ISOLATION_DAEMON_CGROUP=/homeai-probe-daemons/isolation
echo ISOLATION_DAEMON_SWAP_CONTROL=present
docker -H unix:///tmp/isolation.sock info --format '{{.MemoryLimit}} {{.SwapLimit}} {{.CPUCfsPeriod}} {{.CPUCfsQuota}} {{.PidsLimit}} {{.CgroupVersion}}' > /tmp/isolation-caps
test "$(cat /tmp/isolation-caps)" = 'true true true true true 2'
echo ISOLATION_REQUIRED_DAEMON_CAPABILITIES=passed
mkdir -p /tmp/isolation-rootfs/bin /tmp/isolation-rootfs/lib /tmp/isolation-rootfs/workspace /tmp/isolation-rootfs/tmp
cp /bin/busybox /tmp/isolation-rootfs/bin/
for lib in /lib/ld-musl-*.so.1; do test ! -f "$lib" || cp "$lib" /tmp/isolation-rootfs/lib/; done
printf ROOT_READONLY_CANARY > /tmp/isolation-rootfs/root-readonly-canary
chmod 666 /tmp/isolation-rootfs/root-readonly-canary
printf OWN_INITIAL > /tmp/isolation-a/own
printf SIBLING_PRIVATE > /tmp/isolation-b/private
printf GUEST_PRIVATE > /tmp/isolation-guest-private
ln -s /tmp/isolation-guest-private /tmp/isolation-a/absolute-escape
ln -s ../isolation-b/private /tmp/isolation-a/relative-escape
chown 1001:1001 /tmp/isolation-a /tmp/isolation-a/own
chmod 700 /tmp/isolation-a /tmp/isolation-b
tar -C /tmp/isolation-rootfs -cf /tmp/isolation-rootfs.tar .
test "$(stat -c %s /tmp/isolation-rootfs.tar)" -lt 16777216
image=$(docker -H unix:///tmp/isolation.sock import /tmp/isolation-rootfs.tar homeai-isolation:${nonce})
case "$image" in sha256:*) ;; *) echo ISOLATION_IMAGE_INVALID; exit 1;; esac
sleep 120 & canary_pid=$!
trap 'kill "$canary_pid" 2>/dev/null || true; wait "$canary_pid" 2>/dev/null || true; kill "$daemon" 2>/dev/null || true; wait "$daemon" 2>/dev/null || true' EXIT
cat > /tmp/isolation-a/check.sh <<'ISOLATION_CHECK'
set -eu
bb=/bin/busybox
test "$($bb id -u)" = 1001
test "$($bb awk '/^CapEff:/{print $2}' /proc/self/status)" = 0000000000000000
test "$($bb awk '/^NoNewPrivs:/{print $2}' /proc/self/status)" = 1
test "$($bb cat /sys/fs/cgroup/memory.max)" = 67108864
test "$($bb cat /sys/fs/cgroup/memory.swap.max)" = 0
test "$($bb cat /sys/fs/cgroup/pids.max)" = 32
test "$($bb cat /sys/fs/cgroup/cpu.max)" = '50000 100000'
test "$($bb cat /proc/self/cgroup)" = '0::/'
test "$($bb cat /sys/fs/cgroup/cgroup.type)" = domain
test "$($bb cat /sys/fs/cgroup/cgroup.procs | $bb grep -cx "$$")" = 1
echo ISOLATION_UID_CAPS_NNP_CGROUP_READBACK=passed
test "$($bb cat /workspace/own)" = OWN_INITIAL
printf OWN_WRITTEN > /workspace/own
for f in /tmp/isolation-b/private /workspace/../isolation-b/private /workspace/absolute-escape /workspace/relative-escape /proc/$GUEST_CANARY_PID/root/tmp/isolation-guest-private /var/run/docker.sock; do
  if $bb cat "$f" > /tmp/negative-output 2> /tmp/negative-error; then echo ISOLATION_UNEXPECTED_PRIVATE_READ; exit 41; fi
done
echo ISOLATION_PRIVATE_READS=blocked
if $bb mknod /workspace/device c 1 3 > /tmp/negative-output 2> /tmp/negative-error; then echo ISOLATION_MKNOD_ALLOWED; exit 42; fi
test ! -e /workspace/device
if $bb chown 0:0 /workspace/own > /tmp/negative-output 2> /tmp/negative-error; then echo ISOLATION_CHOWN_ALLOWED; exit 43; fi
if printf changed > /root-readonly-canary 2>/tmp/negative-error; then echo ISOLATION_ROOT_WRITE_ALLOWED; exit 44; fi
if $bb kill -0 "$GUEST_CANARY_PID" 2>/tmp/negative-error; then echo ISOLATION_GUEST_SIGNAL_VISIBLE; exit 45; fi
test "$($bb ls /sys/class/net)" = lo
for address in 127.0.0.1 10.0.2.2 10.0.2.15 169.254.169.254; do
  if $bb nc -w 1 "$address" 2375 < /dev/null > /tmp/negative-output 2>/tmp/negative-error; then echo ISOLATION_NETWORK_ALLOWED; exit 46; fi
done
echo ISOLATION_MKNOD_CHOWN_ROOT_SIGNAL_NETWORK=blocked
ISOLATION_CHECK
chown 1001:1001 /tmp/isolation-a/check.sh
timeout 20 docker -H unix:///tmp/isolation.sock run --name homeai-isolation-positive --network=none --user=1001:1001 --read-only --cap-drop=ALL --security-opt=no-new-privileges=true --cgroupns=private --memory=64m --memory-swap=64m --cpus=.5 --pids-limit=32 --tmpfs /tmp:rw,nosuid,nodev,size=16777216,mode=1777 --mount type=bind,source=/tmp/isolation-a,target=/workspace,bind-propagation=rprivate --env GUEST_CANARY_PID="$canary_pid" --entrypoint /bin/busybox "$image" sh /workspace/check.sh
test "$(cat /tmp/isolation-a/own)" = OWN_WRITTEN
test "$(cat /tmp/isolation-b/private)" = SIBLING_PRIVATE
test "$(cat /tmp/isolation-guest-private)" = GUEST_PRIVATE
test ! -e /tmp/isolation-a/device
kill -0 "$canary_pid"
echo ISOLATION_SYNTHETIC_CANARIES_UNCHANGED=passed
# The same UID owns this writable host file; a second RO mount must deny it.
timeout 10 docker -H unix:///tmp/isolation.sock run --name homeai-isolation-readonly --network=none --user=1001:1001 --read-only --cap-drop=ALL --security-opt=no-new-privileges=true --cgroupns=private --memory=64m --memory-swap=64m --cpus=.5 --pids-limit=32 --mount type=bind,source=/tmp/isolation-a,target=/workspace,readonly,bind-propagation=rprivate --entrypoint /bin/busybox "$image" sh -c 'if printf forbidden > /workspace/own; then exit 51; fi; test "$(/bin/busybox cat /workspace/own)" = OWN_WRITTEN; echo ISOLATION_PROJECT_READONLY=passed'
test "$(cat /tmp/isolation-a/own)" = OWN_WRITTEN
echo ISOLATION_RESULT=passed
echo ISOLATION_LIMITS=No_production_9p_editor_toolchain_egress_or_OOM_enforcement_proof
`;
}
module.exports = { guestScript };
