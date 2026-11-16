'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { guestScript } = require('./guest-container-isolation-probe.cjs');
test('actual proof is restricted to new RAM daemon and two synthetic constrained containers', () => {
  const script = guestScript('a'.repeat(16)), runs = script.split('\n').filter(line => / docker .* run /.test(line));
  assert.equal(runs.length, 2);
  for (const command of runs) for (const flag of ['--network=none', '--user=1001:1001', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--cgroupns=private', '--memory=64m', '--memory-swap=64m', '--pids-limit=32']) assert(command.includes(flag));
  assert.match(runs[1], /target=\/workspace,readonly/);
  assert.doesNotMatch(runs.join('\n'), /old-volume|--privileged|--network=host|--pid=host|--cap-add|--device/);
  assert.match(script, /--data-root=\/tmp\/isolation-docker/);
  assert.match(script, /test "\$\(cat \/tmp\/isolation-caps\)" = 'true true true true true 2'/);
  assert.equal(script.split('\n').filter(line=>line.includes(' dockerd ')).length,1,'combined proof must not spend its bounded window on redundant daemon cycles');
  assert.match(script,/test "\$\(cat \/proc\/\$daemon\/cgroup\)" = '0::\/homeai-probe-daemons\/isolation'/);
  assert.match(script,/--cgroup-parent=\/homeai-probe-containers/);
  assert.match(script,/test "\$\(\$bb cat \/proc\/self\/cgroup\)" = '0::\/'/);
  assert.match(script,/\$bb grep -cx "\$\$"/);
});
test('proof has positive witnesses, exact owned canaries and explicit unsupported scope', () => {
  const script = guestScript('b'.repeat(16));
  for (const marker of ['ISOLATION_UID_CAPS_NNP_CGROUP_READBACK', 'ISOLATION_PRIVATE_READS', 'ISOLATION_MKNOD_CHOWN_ROOT_SIGNAL_NETWORK', 'ISOLATION_SYNTHETIC_CANARIES_UNCHANGED', 'ISOLATION_PROJECT_READONLY']) assert(script.includes(marker));
  assert.match(script, /if \$bb mknod \/workspace\/device c 1 3/); assert.match(script, /test ! -e \/tmp\/isolation-a\/device/);
  assert.match(script, /No_production_9p_editor_toolchain_egress_or_OOM_enforcement_proof/);
  assert.throws(() => guestScript('injection')); assert.throws(() => guestScript('b'.repeat(16), () => 'changed'), /TEMPLATE_CHANGED/);
});
