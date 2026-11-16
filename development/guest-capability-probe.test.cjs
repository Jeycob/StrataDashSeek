'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { qemuArgs, guestScript } = require('./guest-capability-probe.cjs');
test('operator probe plan attaches only read-only pinned boot descriptors without network or persistent volumes', () => {
  const args = qemuArgs('a'.repeat(16));
  assert.equal(args[args.indexOf('-m') + 1], '384'); assert.equal(args[args.indexOf('-smp') + 1], '1'); assert.equal(args[args.indexOf('-nic') + 1], 'none');
  assert.equal(args[args.indexOf('-accel') + 1], 'tcg,thread=single,tb-size=32');
  assert.equal(args.filter(x => x === '-drive').length, 1); assert.match(args[args.indexOf('-drive') + 1], /^file=\/proc\/self\/fd\/5,media=cdrom,readonly=on,format=raw$/);
  assert.doesNotMatch(args.join(' '), /volume\.raw|hostfwd|virtfs|fsdev|qmp|daemonize/);
  assert.throws(() => qemuArgs('bad;command'));
});
test('guest commands test independent memory and swap limits on a disposable child cgroup', () => {
  const script = guestScript('a'.repeat(16)); assert.match(script, /rc_cgroup_mode="unified"/); assert.match(script, /memory\.swap\.max/); assert.match(script, /cgroup\.procs/);
  assert.doesNotMatch(script, /apk add|dockerd|mkfs|\/dev\/vda|curl|wget|killall/); assert.throws(() => guestScript('bad'));
});
