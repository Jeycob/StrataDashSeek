'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { guestScript } = require('./guest-cache-diagnostic.cjs');
test('cache diagnostic bounds independent RAM copy and never falls back to network or untrusted packages', () => {
  const script = guestScript('a'.repeat(16));
  assert.match(script, /mount -t ext4 -o ro,noload/); assert.match(script, /size=134217728,nodev,nosuid,noexec/);
  assert.match(script, /cache_count.*-le 200.*cache_bytes.*-le 125829120/);
  assert.equal(script.match(/apk --cache-dir[^\n]+--no-network add docker/g).length, 2);
  assert.doesNotMatch(script, /--allow-untrusted|apk update|https?:|curl|wget|apk\.log"?\s*$/m);
  assert.match(script, /CENSUS_APK_REASON=OTHER_REDACTED/); assert.throws(() => guestScript('invalid'));
});
test('both daemon probes use separate empty RAM roots and do not create, start or delete application objects', () => {
  const script = guestScript('b'.repeat(16));
  assert.match(script, /for driver in vfs overlay2/); assert.match(script, /root=\/tmp\/homeai-empty-\$driver/);
  const command = script.split('\n').find(line => line.trim().startsWith('dockerd ')); assert.match(command, /--data-root="\$root"/); assert.doesNotMatch(command, /old-volume|tcp:|2375/);
  assert.doesNotMatch(script, /docker .*\b(run|start|restart|rm|prune|import|load|build)\b/);
  assert.match(script, /kill "\$daemon"/); assert.match(script, /wait "\$daemon"/);
  assert.throws(() => guestScript('b'.repeat(16), () => 'unexpected'), /TEMPLATE_CHANGED/);
});
