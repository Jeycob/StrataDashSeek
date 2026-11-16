'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { admission, qemuArgs, guestScript } = require('./guest-volume-census.cjs');
const GiB = 1024 ** 3;
test('census attaches original raw FD as mandatory read-only without network, shares or overlay writes', () => {
  const args = qemuArgs('a'.repeat(16)), nodes = args.flatMap((a, i) => a === '-blockdev' ? [JSON.parse(args[i + 1])] : []);
  assert.equal(nodes.length, 2); for (const node of nodes) { assert.equal(node['read-only'], true); assert.equal(node['auto-read-only'], false); }
  assert.equal(nodes[0].filename, '/proc/self/fd/6'); assert.equal(nodes[1].driver, 'raw'); assert.equal(nodes[1].file, nodes[0]['node-name']);
  assert.equal(args[args.indexOf('-nic') + 1], 'none'); assert.equal(args[args.indexOf('-m') + 1], '2048');
  assert.doesNotMatch(args.join(' '), /qcow|hostfwd|virtfs|fsdev|snapshot/); assert.throws(() => qemuArgs('inject'));
});
test('guest never starts a daemon on the old store and emits only aggregate categories and capability whitelist', () => {
  const script = guestScript('b'.repeat(16));
  assert.match(script, /mount -t ext4 -o ro,noload \/dev\/vda/);
  assert.match(script, /apk --cache-dir \/mnt\/old-volume\/apk-cache --no-network add docker/);
  const daemon = script.split('\n').filter(line => line.startsWith('dockerd ')); assert.equal(daemon.length, 1);
  assert.match(daemon[0], /--data-root=\/tmp\/homeai-empty-docker/); assert.doesNotMatch(daemon[0], /old-volume|2375|tcp:/);
  assert.doesNotMatch(script, /docker .* (run|start|restart|rm|prune|load|inspect)\b|mkfs|curl|wget|cat .*config\.json/);
  assert.match(script, /CENSUS_OFFLINE_COUNTS_NOT_OBJECT_VALIDATION/); assert.match(script, /CENSUS_NO_RECLAIMABILITY_OR_ENFORCEMENT_PROOF/);
});
test('memory admission checks every visible ancestor and rejects insufficient, malformed or unknown scope', () => {
  const files = { '/sys/fs/cgroup/a/b/memory.max': 'max', '/sys/fs/cgroup/a/b/memory.current': '0', '/sys/fs/cgroup/a/memory.max': String(7 * GiB), '/sys/fs/cgroup/a/memory.current': String(2 * GiB), '/sys/fs/cgroup/memory.max': 'max', '/sys/fs/cgroup/memory.current': '0' };
  const input = { meminfo: 'MemAvailable: 8388608 kB\n', cgroup: '0::/a/b\n', mountinfo: '28 22 0:28 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n', read: p => { assert(p in files); return files[p]; } };
  assert.deepEqual(admission(input), { hostAvailableBytes: 8 * GiB, cgroupHeadroomBytes: 5 * GiB, cgroupAncestorsChecked: 3 });
  files['/sys/fs/cgroup/a/memory.current'] = String(4 * GiB); assert.throws(() => admission(input), /CGROUP_MEMORY_RESERVE/);
  assert.throws(() => admission({ ...input, meminfo: 'MemAvailable: 2097152 kB' }), /HOST_MEMORY_RESERVE/);
  assert.throws(() => admission({ ...input, cgroup: '0::/../../x' }), /CGROUP_MEMORY_SCOPE_UNKNOWN/);
  assert.throws(() => admission({ ...input, mountinfo: '' }), /CGROUP_MEMORY_SCOPE_UNKNOWN/);
});
