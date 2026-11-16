'use strict';
// Operator-only disposable guest. No existing writable disk, network, Docker,
// service state or host namespace is attached or changed. Never called at boot.
const fs = require('node:fs'), crypto = require('node:crypto'), cp = require('node:child_process');
const ROOT = '/data/harness/docker-worker';
const ISO_SHA256 = '157d353f8e54252cad2d9812a0d56bb7fa2231fc154a110e1d180d7480ef8b4f';
function digest(fd, start = 0, length = fs.fstatSync(fd).size) {
  const hash = crypto.createHash('sha256'), block = Buffer.alloc(1024 * 1024); let at = 0;
  while (at < length) { const n = fs.readSync(fd, block, 0, Math.min(block.length, length - at), start + at); if (!n) throw Error('BOOT_ARTIFACT_TRUNCATED'); hash.update(block.subarray(0, n)); at += n; }
  return hash.digest('hex');
}
function isoBootFiles(fd) {
  const total = fs.fstatSync(fd).size;
  function read(start, length) { if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 1 || length > 1024 * 1024 || start + length > total) throw Error('ISO_BOUNDS'); const data = Buffer.alloc(length); if (fs.readSync(fd, data, 0, length, start) !== length) throw Error('ISO_TRUNCATED'); return data; }
  function record(data, at) {
    const length = data[at]; if (!length) return null;
    const nameLength = data[at + 32]; if (length < 34 || at + length > data.length || 33 + nameLength > length) throw Error('ISO_RECORD_INVALID');
    let name = data.toString('utf8', at + 33, at + 33 + nameLength).replace(/;\d+$/, '').replace(/\.$/, '').toLowerCase(), cursor = at + 33 + nameLength;
    if (cursor % 2) cursor++;
    while (cursor + 4 <= at + length) { const size = data[cursor + 2]; if (size < 4 || cursor + size > at + length) break; if (data.toString('ascii', cursor, cursor + 2) === 'NM' && size >= 5 && !(data[cursor + 4] & 6)) name = data.toString('utf8', cursor + 5, cursor + size); cursor += size; }
    return { length, name, start: data.readUInt32LE(at + 2) * 2048, size: data.readUInt32LE(at + 10), directory: !!(data[at + 25] & 2) };
  }
  function children(parent) { if (!parent?.directory) throw Error('ISO_DIRECTORY_MISSING'); const data = read(parent.start, parent.size), rows = []; for (let at = 0; at < data.length;) { const row = record(data, at); if (!row) { at = Math.floor(at / 2048 + 1) * 2048; continue; } rows.push(row); at += row.length; } return rows; }
  const pvd = read(16 * 2048, 2048); if (pvd.toString('ascii', 1, 6) !== 'CD001') throw Error('ISO_HEADER_INVALID');
  const boot = children(record(pvd, 156)).find(r => r.name === 'boot'), rows = children(boot);
  return ['vmlinuz-virt', 'initramfs-virt'].map(name => { const matches = rows.filter(r => r.name === name); if (matches.length !== 1 || matches[0].directory || matches[0].size < 1 || matches[0].size > 128 * 1024 ** 2 || matches[0].start + matches[0].size > total) throw Error('ISO_BOOT_INVALID'); return matches[0]; });
}
function guestScript(nonce) {
  if (!/^[a-f0-9]{16}$/.test(nonce)) throw Error('NONCE_INVALID');
  return `#!/bin/sh
set -eu
echo PROBE_KERNEL
uname -r
cat /proc/cmdline
if test -r /proc/config.gz; then zcat /proc/config.gz | grep -E '^(CONFIG_(CGROUPS|CGROUP_SCHED|MEMCG|SWAP|CGROUP_PIDS|NAMESPACES|USER_NS|PID_NS|NET_NS))=' || true; else echo CONFIG_UNAVAILABLE; fi
echo PROBE_MOUNTS_BEFORE
grep cgroup /proc/mounts || true
printf '\\nrc_cgroup_mode="unified"\\n' >> /etc/rc.conf
if rc-service cgroups start; then echo OPENRC_CGROUP_START=0; else echo OPENRC_CGROUP_START=1; fi
echo PROBE_MOUNTS_AFTER
grep cgroup /proc/mounts || true
test -f /sys/fs/cgroup/cgroup.controllers
cat /sys/fs/cgroup/cgroup.controllers
grep -qw memory /sys/fs/cgroup/cgroup.controllers
printf '+memory +cpu +pids' > /sys/fs/cgroup/cgroup.subtree_control
mkdir /sys/fs/cgroup/homeai-probe-${nonce}
cg=/sys/fs/cgroup/homeai-probe-${nonce}
test -f "$cg/memory.swap.max"
printf 67108864 > "$cg/memory.max"
printf 0 > "$cg/memory.swap.max"
printf '10000 100000' > "$cg/cpu.max"
printf 32 > "$cg/pids.max"
test "$(cat "$cg/memory.max")" = 67108864
test "$(cat "$cg/memory.swap.max")" = 0
test "$(cat "$cg/cpu.max")" = '10000 100000'
test "$(cat "$cg/pids.max")" = 32
sh -c 'echo $$ > "$1/cgroup.procs"; cat /proc/self/cgroup' probe "$cg"
rmdir "$cg"
echo PROBE_LIMITS_READBACK=passed
`;
}
function qemuArgs(nonce) {
  if (!/^[a-f0-9]{16}$/.test(nonce)) throw Error('NONCE_INVALID');
  return ['-name', 'homeai-disposable-probe-' + nonce, '-accel', 'tcg,thread=single,tb-size=32', '-smp', '1', '-m', '384', '-cpu', 'max', '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-no-reboot', '-nic', 'none', '-kernel', '/proc/self/fd/3', '-initrd', '/proc/self/fd/4', '-drive', 'file=/proc/self/fd/5,media=cdrom,readonly=on,format=raw', '-append', 'console=ttyS0 alpine_dev=cdrom:iso9660 modules=loop,squashfs,sd-mod,usb-storage quiet cgroup_no_v1=all swapaccount=1'];
}
async function probe() {
  if (process.platform !== 'linux' || process.getuid() === 0) throw Error('UNPRIVILEGED_LINUX_OPERATOR_REQUIRED');
  const freeKiB = Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  if (!Number.isSafeInteger(freeKiB) || freeKiB < 1024 * 1024) throw Error('HOST_MEMORY_RESERVE');
  const descriptors = [];
  try {
    for (const name of ['vmlinuz-virt', 'initramfs-virt', 'alpine.iso']) { const fd = fs.openSync(ROOT + '/' + name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); descriptors.push(fd); const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size < 1 || stat.size > 256 * 1024 ** 2) throw Error('BOOT_ARTIFACT_INVALID'); }
    const [kernel, initrd, iso] = descriptors;
    if (digest(iso) !== ISO_SHA256) throw Error('PINNED_ISO_MISMATCH');
    const boot = isoBootFiles(iso); for (let i = 0; i < 2; i++) if (digest(descriptors[i]) !== digest(iso, boot[i].start, boot[i].size)) throw Error('BOOT_ISO_MISMATCH');
    const nonce = crypto.randomBytes(8).toString('hex'), startedAt = new Date().toISOString(), started = Date.now();
    const child = cp.spawn('/usr/bin/nice', ['-n', '19', 'qemu-system-x86_64', ...qemuArgs(nonce)], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', TERM: 'dumb' }, cwd: '/', stdio: ['pipe', 'pipe', 'pipe', kernel, initrd, iso] });
    let output = '', sent = false, loggingIn = false, finished = false, reason = 'GUEST_EXITED_BEFORE_RESULT', forced, peakRssBytes = 0;
    const stop = value => { if (finished) return; finished = true; reason = value; child.kill('SIGTERM'); forced = setTimeout(() => child.kill('SIGKILL'), 2000); forced.unref(); };
    const timer = setTimeout(() => stop('DEADLINE_EXCEEDED'), 178000);
    const monitor = setInterval(() => { try { const rss = Number(fs.readFileSync('/proc/' + child.pid + '/status', 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024; peakRssBytes = Math.max(peakRssBytes, rss || 0); if (rss > 640 * 1024 ** 2) stop('HOST_RSS_LIMIT'); } catch { /* exit handler owns process lifetime */ } }, 1000);
    const interrupted = () => stop('OPERATOR_INTERRUPTED'); process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
    function data(chunk) {
      output += chunk.toString(); if (Buffer.byteLength(output) > 256 * 1024) { output = output.slice(-128 * 1024); stop('CONSOLE_LIMIT'); return; }
      const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      if (!loggingIn && /login:\s*$/.test(clean)) { loggingIn = true; child.stdin.write('root\n'); }
      if (!sent && /(?:localhost:~|\/\s*)#\s*$/.test(clean)) {
        sent = true; const encoded = Buffer.from(guestScript(nonce)).toString('base64').match(/.{1,160}/g).join('\n');
        child.stdin.write("stty -echo\nbase64 -d > /tmp/homeai-probe.sh <<'PROBE_SCRIPT'\n" + encoded + "\nPROBE_SCRIPT\nsh /tmp/homeai-probe.sh; printf '\\nPROBE_DONE_" + nonce + "=%s\\n' \"$?\"\n");
      }
      const done = clean.match(new RegExp('(?:^|\\n)PROBE_DONE_' + nonce + '=(\\d+)(?:\\r?\\n|$)')); if (done) stop(Number(done[1]) === 0 ? 'CAPABILITIES_OBSERVED' : 'GUEST_PROBE_FAILED');
    }
    child.stdout.on('data', data); child.stderr.on('data', data); child.stdin.on('error', () => {});
    try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { clearTimeout(timer); clearTimeout(forced); clearInterval(monitor); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
    return { version: 1, startedAt, durationMs: Date.now() - started, reason, peakRssBytes, guestMemoryMiB: 384, tcgCacheMiB: 32, hostRssLimitMiB: 640, vcpus: 1, hostWritableDisks: 0, networkAdapters: 0, isoSHA256: ISO_SHA256, output, limits: 'Capability/readback evidence only; no Docker, application, swapping or OOM enforcement test.' };
  } finally { for (const fd of descriptors) fs.closeSync(fd); }
}
module.exports = { qemuArgs, guestScript, isoBootFiles, digest };
if (require.main === module) { if (process.argv[2] !== 'run-disposable') { console.error('Operator only: guest-capability-probe.cjs run-disposable; requires fresh quiescence.'); process.exitCode = 2; } else probe().then(result => { console.log(JSON.stringify(result)); if (result.reason !== 'CAPABILITIES_OBSERVED') process.exitCode = 1; }, error => { console.error(error.message); process.exitCode = 1; }); }
