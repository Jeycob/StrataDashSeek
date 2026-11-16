'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { guestScript } = require('./guest-cache-diagnostic.cjs');
test('cache diagnostic bounds independent RAM copy and never falls back to network or untrusted packages', () => {
  const script = guestScript('a'.repeat(16));
  assert.match(script, /mount -t ext4 -o ro,noload/); assert.match(script, /size=134217728,nodev,nosuid,noexec/);
  assert.match(script, /cache_count.*-le 200.*cache_bytes.*-le 125829120/);
  assert.equal(script.match(/apk --cache-dir[^\n]+--no-network add docker/g).length, 2);
  assert.match(script, /set -- \/tmp\/census-cache\/\*\.apk/);
  assert.match(script, /timeout 45 apk --no-network --no-cache --force-non-repository add "\$@"/);
  assert.equal(script.match(/--force-non-repository/g).length, 1);
  assert.doesNotMatch(script, /--allow-untrusted|apk update|https?:|curl|wget|(?:cat|head)\s+[^\n]*census-apk\.log/m);
  assert.match(script, /tail -c 4096 \/tmp\/census-apk\.log/);
  assert.match(script, /apk --version/);
  assert.match(script, /CENSUS_APK_REASON=OTHER_REDACTED/); assert.throws(() => guestScript('invalid'));
});
test('both daemon probes use separate empty RAM roots and do not create, start or delete application objects', () => {
  const script = guestScript('b'.repeat(16));
  assert.match(script, /for driver in vfs overlay2/); assert.match(script, /root=\/tmp\/homeai-empty-\$driver/);
  const command = script.split('\n').find(line => line.includes(' exec "$@"') && line.includes(' dockerd ')); assert.match(command, /--data-root="\$root"/); assert.doesNotMatch(command, /old-volume|tcp:|2375/);
  assert.doesNotMatch(script, /docker .*\b(run|start|restart|rm|prune|import|load|build)\b/);
  assert.match(script, /kill "\$daemon"/); assert.match(script, /wait "\$daemon"/);
  assert.throws(() => guestScript('b'.repeat(16), () => 'unexpected'), /TEMPLATE_CHANGED/);
});

test('daemon discovery uses its actual non-root cgroup and separates populated leaves from container delegation',()=>{
  const script=guestScript('c'.repeat(16));
  assert.match(script,/printf '\+cpu \+memory \+pids' > \/sys\/fs\/cgroup\/cgroup.subtree_control/);
  assert.match(script,/printf "%s\\n" "\$\$" > "\$group\/cgroup.procs"; exec "\$@"/);
  assert.match(script,/test "\$\(cat \/proc\/\$daemon\/cgroup\)" = "0::\/homeai-probe-daemons\/\$driver"/);
  assert.match(script,/--cgroup-parent=\/homeai-probe-containers/);
  assert.match(script,/test -z "\$\(cat \/sys\/fs\/cgroup\/homeai-probe-containers\/cgroup.procs\)"/);
  assert.doesNotMatch(script,/echo.*true.*SwapLimit|swapaccount=0|--memory-swap=-1/);
  const packagesOnly=guestScript('c'.repeat(16),undefined,{skipDaemonProbe:true});
  assert.doesNotMatch(packagesOnly,/ dockerd |for driver in vfs overlay2/);
  assert.match(packagesOnly,/CENSUS_EXPLICIT_APK_STATUS/);
});
