'use strict';
// Operator-only, no boot hook. The old disk is read-only at the host FD,
// QEMU block layer AND guest ext4 mount. dockerd receives a NEW RAM data root.
// Restart-policy rationale: https://docs.docker.com/engine/containers/start-containers-automatically/
// Block layer: https://www.qemu.org/docs/master/system/qemu-manpage.html
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const defaultHelpers = require('./guest-capability-probe.cjs');
const ROOT = '/data/harness/docker-worker', GiB = 1024 ** 3;
const ISO_SHA256 = '157d353f8e54252cad2d9812a0d56bb7fa2231fc154a110e1d180d7480ef8b4f';
function admission({ meminfo, cgroup, mountinfo, read }) {
  const available = Number(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024;
  if (!Number.isSafeInteger(available) || available < 4 * GiB) throw Error('HOST_MEMORY_RESERVE');
  const group = cgroup.match(/^0::([^\n]+)$/m)?.[1];
  const mounts = mountinfo.split('\n').map(line => line.split(' ')).filter(fields => fields[fields.indexOf('-') + 1] === 'cgroup2');
  if (!group || mounts.length !== 1) throw Error('CGROUP_MEMORY_SCOPE_UNKNOWN');
  const [, , , root, mount] = mounts[0];
  // Escaped or ambiguous namespace paths require operator clarification.
  if (![root, mount, group].every(p => p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..')) || !(group === root || group.startsWith(root === '/' ? '/' : root + '/'))) throw Error('CGROUP_MEMORY_SCOPE_UNKNOWN');
  const relative = group.slice(root === '/' ? 1 : root.length + 1);
  let current = path.posix.join(mount, relative), headroom = Infinity, checked = 0;
  for (;;) {
    const max = read(current + '/memory.max').trim();
    const used = Number(read(current + '/memory.current').trim());
    if (!/^\d+$/.test(max) && max !== 'max' || !Number.isSafeInteger(used) || used < 0) throw Error('CGROUP_MEMORY_SCOPE_UNKNOWN');
    if (max !== 'max') { const limit = Number(max); if (!Number.isSafeInteger(limit)) throw Error('CGROUP_MEMORY_SCOPE_UNKNOWN'); headroom = Math.min(headroom, limit - used); }
    checked++;
    if (current === mount) break;
    current = path.posix.dirname(current);
    if (!current.startsWith(mount) || checked > 128) throw Error('CGROUP_MEMORY_SCOPE_UNKNOWN');
  }
  if (headroom < 4 * GiB) throw Error('CGROUP_MEMORY_RESERVE');
  return { hostAvailableBytes: available, cgroupHeadroomBytes: headroom === Infinity ? null : headroom, cgroupAncestorsChecked: checked };
}
function qemuArgs(nonce, helpers = defaultHelpers) {
  const args = helpers.qemuArgs(nonce);
  args[args.indexOf('-m') + 1] = '2048';
  args[args.indexOf('-name') + 1] = 'homeai-readonly-volume-census-' + nonce;
  args.push('-blockdev', JSON.stringify({ driver: 'file', 'node-name': 'old-volume-file', filename: '/proc/self/fd/6', 'read-only': true, 'auto-read-only': false }), '-blockdev', JSON.stringify({ driver: 'raw', 'node-name': 'old-volume', file: 'old-volume-file', 'read-only': true, 'auto-read-only': false }), '-device', 'virtio-blk-pci,drive=old-volume');
  return args;
}
function guestScript(nonce) {
  if (!/^[a-f0-9]{16}$/.test(nonce)) throw Error('NONCE_INVALID');
  return `#!/bin/sh
set -eu
mkdir /mnt/old-volume
mount -t ext4 -o ro,noload /dev/vda /mnt/old-volume
grep -q '^/dev/vda /mnt/old-volume ext4 ro,' /proc/mounts
echo CENSUS_OLD_DISK_READONLY=1
echo CENSUS_OLD_SCOPE=offline_metadata_not_live_census
for category in apk-cache docker/vfs docker/buildkit docker/image docker/containers docker/volumes docker/network docker/tmp; do
  target=/mnt/old-volume/$category
  if test -d "$target" && test ! -L "$target" && test "$(readlink -f "$target")" = "$target"; then
    if ! timeout 20 du -skx "$target" > /tmp/census-du 2>/dev/null; then echo CENSUS_DU_INCOMPLETE; exit 1; fi
    size=$(awk '{print $1}' /tmp/census-du)
    case "$size" in ''|*[!0-9]*) echo CENSUS_DU_INCOMPLETE; exit 1;; esac
    printf 'CENSUS_DU_KIB %s %s\\n' "$category" "$size"
  else printf 'CENSUS_CATEGORY_UNAVAILABLE %s\\n' "$category"; fi
done
for category in docker/containers docker/image/vfs/imagedb/content/sha256 docker/volumes; do
  target=/mnt/old-volume/$category
  if test -d "$target" && test ! -L "$target" && test "$(readlink -f "$target")" = "$target"; then
    if ! timeout 10 find "$target" -mindepth 1 -maxdepth 1 -print > /tmp/census-count 2>/dev/null; then echo CENSUS_COUNT_INCOMPLETE; exit 1; fi
    count=$(wc -l < /tmp/census-count)
    printf 'CENSUS_OFFLINE_ENTRY_COUNT %s %s\\n' "$category" "$count"
  fi
done
echo CENSUS_OFFLINE_COUNTS_NOT_OBJECT_VALIDATION=1
test -d /mnt/old-volume/apk-cache
test ! -L /mnt/old-volume/apk-cache
test "$(readlink -f /mnt/old-volume/apk-cache)" = /mnt/old-volume/apk-cache
# Cached signed packages only. APK must fail if the cache is incomplete.
if ! timeout 45 apk --cache-dir /mnt/old-volume/apk-cache --no-network add docker > /tmp/census-apk.log 2>&1; then echo CENSUS_CACHED_APK_UNAVAILABLE; exit 1; fi
printf '\\nrc_cgroup_mode="unified"\\n' >> /etc/rc.conf
rc-service cgroups start > /tmp/census-cgroup.log 2>&1
test -f /sys/fs/cgroup/cgroup.controllers
mkdir /tmp/homeai-empty-docker
# The readonly old store is never supplied to Docker. No restart policy can run.
dockerd --data-root=/tmp/homeai-empty-docker --exec-root=/tmp/homeai-empty-exec --pidfile=/tmp/homeai-empty.pid --host=unix:///tmp/homeai-empty.sock --storage-driver=vfs --bridge=none --iptables=false --ip-forward=false --ip-masq=false > /tmp/census-daemon.log 2>&1 &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true; wait "$daemon" 2>/dev/null || true' EXIT
attempt=0
until docker -H unix:///tmp/homeai-empty.sock info --format '{{.CgroupVersion}}' > /tmp/census-ready 2>/dev/null; do
  attempt=$((attempt + 1)); test "$attempt" -lt 30; kill -0 "$daemon"; sleep 1
done
test "$(cat /tmp/census-ready)" = 2
test -z "$(docker -H unix:///tmp/homeai-empty.sock ps -aq)"
test -z "$(docker -H unix:///tmp/homeai-empty.sock image ls -aq)"
echo CENSUS_NEW_EMPTY_DAEMON=1
docker -H unix:///tmp/homeai-empty.sock info --format 'CENSUS_CAPABILITIES memory={{.MemoryLimit}} swap={{.SwapLimit}} cpuCfsPeriod={{.CPUCfsPeriod}} cpuCfsQuota={{.CPUCfsQuota}} pids={{.PidsLimit}} cgroupVersion={{.CgroupVersion}} cgroupDriver={{.CgroupDriver}} storageDriver={{.Driver}}'
echo CENSUS_NO_RECLAIMABILITY_OR_ENFORCEMENT_PROOF=1
`;
}
async function runCensus({ helpers = defaultHelpers } = {}) {
  if (process.platform !== 'linux' || process.getuid() === 0) throw Error('UNPRIVILEGED_LINUX_OPERATOR_REQUIRED');
  const memory = admission({ meminfo: fs.readFileSync('/proc/meminfo', 'utf8'), cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8'), mountinfo: fs.readFileSync('/proc/self/mountinfo', 'utf8'), read: p => fs.readFileSync(p, 'utf8') });
  const descriptors = [];
  try {
    for (const name of ['vmlinuz-virt', 'initramfs-virt', 'alpine.iso', 'volume.raw']) {
      const fd = fs.openSync(ROOT + '/' + name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); descriptors.push(fd);
      const s = fs.fstatSync(fd); if (!s.isFile() || s.size < 1 || (name === 'volume.raw' ? s.size !== 3 * GiB : s.size > 256 * 1024 ** 2)) throw Error('READONLY_ARTIFACT_INVALID');
    }
    const [kernel, initrd, iso, volume] = descriptors;
    if (helpers.digest(iso) !== ISO_SHA256) throw Error('PINNED_ISO_MISMATCH');
    const boot = helpers.isoBootFiles(iso); for (let i = 0; i < 2; i++) if (helpers.digest(descriptors[i]) !== helpers.digest(iso, boot[i].start, boot[i].size)) throw Error('BOOT_ISO_MISMATCH');
    const before = fs.fstatSync(volume), nonce = crypto.randomBytes(8).toString('hex'), startedAt = new Date().toISOString(), started = Date.now();
    const child = cp.spawn('/usr/bin/nice', ['-n', '19', 'qemu-system-x86_64', ...qemuArgs(nonce, helpers)], { cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe', ...descriptors] });
    let output = '', sent = false, loggingIn = false, stopped = false, reason = 'GUEST_EXITED_BEFORE_RESULT', forced, peakRssBytes = 0;
    const stop = value => { if (stopped) return; stopped = true; reason = value; child.kill('SIGTERM'); forced = setTimeout(() => child.kill('SIGKILL'), 2000); forced.unref(); };
    const timer = setTimeout(() => stop('DEADLINE_EXCEEDED'), 178000);
    const monitor = setInterval(() => { try { const rss = Number(fs.readFileSync('/proc/' + child.pid + '/status', 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024; peakRssBytes = Math.max(peakRssBytes, rss || 0); if (rss > 2560 * 1024 ** 2) stop('HOST_RSS_LIMIT'); } catch { /* close owns lifecycle */ } }, 500);
    const interrupted = () => stop('OPERATOR_INTERRUPTED'); process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
    function data(chunk) {
      output += chunk.toString(); if (Buffer.byteLength(output) > 256 * 1024) { output = output.slice(-128 * 1024); stop('CONSOLE_LIMIT'); return; }
      const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      if (!loggingIn && /login:\s*$/.test(clean)) { loggingIn = true; child.stdin.write('root\n'); }
      if (!sent && /(?:localhost:~|\/\s*)#\s*$/.test(clean)) {
        sent = true; const encoded = Buffer.from(guestScript(nonce)).toString('base64').match(/.{1,160}/g).join('\n');
        child.stdin.write("stty -echo\nbase64 -d > /tmp/census.sh <<'CENSUS_SCRIPT'\n" + encoded + "\nCENSUS_SCRIPT\nsh /tmp/census.sh; printf '\\nCENSUS_DONE_" + nonce + "=%s\\n' \"$?\"\n");
      }
      const done = clean.match(new RegExp('(?:^|\\n)CENSUS_DONE_' + nonce + '=(\\d+)(?:\\r?\\n|$)')); if (done) stop(Number(done[1]) === 0 ? 'READONLY_CENSUS_OBSERVED' : 'GUEST_CENSUS_FAILED');
    }
    child.stdout.on('data', data); child.stderr.on('data', data); child.stdin.on('error', () => {});
    try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { clearTimeout(timer); clearTimeout(forced); clearInterval(monitor); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
    const after = fs.fstatSync(volume), sourceMetadataUnchanged = before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
    if (!sourceMetadataUnchanged) reason = 'SOURCE_CHANGED_DURING_CENSUS';
    return { version: 1, startedAt, durationMs: Date.now() - started, reason, memory, peakRssBytes, guestMemoryMiB: 2048, hostRssLimitMiB: 2560, vcpus: 1, networkAdapters: 0, hostWritableDisks: 0, originalDiskBytes: before.size, sourceMetadataUnchanged, isoSHA256: ISO_SHA256, output, limits: 'Offline old-store size/count metadata only; capabilities belong to a NEW EMPTY RAM daemon. No old container start, live census, reclaimability, application or limit-enforcement proof.' };
  } finally { for (const fd of descriptors) fs.closeSync(fd); }
}
module.exports = { admission, qemuArgs, guestScript, runCensus };
if (require.main === module) { if (process.argv[2] !== 'run-readonly') { console.error('Operator only: guest-volume-census.cjs run-readonly; requires fresh VM-disabled quiescence.'); process.exitCode = 2; } else runCensus().then(result => { console.log(JSON.stringify(result)); if (result.reason !== 'READONLY_CENSUS_OBSERVED') process.exitCode = 1; }, error => { console.error(error.message); process.exitCode = 1; }); }
