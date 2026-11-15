'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { fixedguestOverlayProbe, parseOverlayProbe } = require('./apps-overlay-probe.cjs');
const volume = 'a'.repeat(32), nonce = 'b'.repeat(16), marker = 'HARNESS_OVERLAY_' + nonce + '=';
const checks = ['guestIdentity', 'capacity', 'fixtureCreated', 'sameDevice', 'moduleAvailable', 'mounted', 'lowerRead', 'copyUp', 'deleteWhiteout', 'lowerUnchanged', 'unmounted', 'cleaned'];
const script = () => fixedguestOverlayProbe({ volumeId32hex: volume, nonce16hex: nonce });
const value = () => ({ version: 1, kernel: '6.18.0-virt', status: 'supported', supported: true, failedStep: 'none', moduleInitiallyLoaded: true, moduleLoadedByProbe: false, moduleRestore: 'not-required', checks: Object.fromEntries(checks.map(key => [key, true])) });
const encode = object => marker + Buffer.from(typeof object === 'string' ? object : JSON.stringify(object)).toString('base64');

test('generator accepts only exact lowercase hex identities; no caller script, paths or mount options', () => {
  assert.ok(script().startsWith('#!/bin/sh\nset -u\numask 077'));
  for (const bad of [undefined, null, '', 'a'.repeat(31), 'A'.repeat(32), "a'; rm -rf / #", 'a'.repeat(32) + '\n']) assert.throws(() => fixedguestOverlayProbe({ volumeId32hex: bad, nonce16hex: nonce }), TypeError);
  for (const bad of [undefined, null, '', 'b'.repeat(15), 'B'.repeat(16), 'b'.repeat(16) + '\n', '$(id)']) assert.throws(() => fixedguestOverlayProbe({ volumeId32hex: volume, nonce16hex: bad }), TypeError);
  assert.throws(() => fixedguestOverlayProbe(), TypeError);
  assert.throws(() => fixedguestOverlayProbe({ volumeId32hex: volume, nonce16hex: nonce, path: '/CANARY' }), TypeError);
  assert.throws(() => fixedguestOverlayProbe(Object.create({ volumeId32hex: volume, nonce16hex: nonce })), TypeError);
});

test('main identity and capacity guards precede all fixture/module/mount changes', () => {
  const main = script().split('# Identity guards precede')[1];
  for (const required of ['$(id -u)', 'console=ttyS0', 'alpine_dev=cdrom:iso9660', '/sys/class/dmi/id/sys_vendor', '"/dev/vda"', '"ext4"', '.stratadashseek-volume', volume, 'readlink -f /var/lib/harness']) assert.ok(main.includes(required), required);
  const verified = main.indexOf('guestIdentity=true'), touch = main.indexOf('mkdir "$fixture"');
  assert.ok(verified > 0 && touch > verified);
  assert.ok(main.indexOf('test "$blocks" -ge 65536 && test "$inodes" -ge 64') < touch);
  assert.ok(main.indexOf('capacity=true') < touch);
  assert.ok(main.indexOf('test ! -e "$fixture" && test ! -L "$fixture"') < touch);
  assert.ok(main.indexOf('modprobe overlay') > touch); assert.ok(main.indexOf('mount -t overlay') > touch);
});

test('fixture is a fixed private new guest directory, same-device checked and tiny literal data only', () => {
  const s = script();
  assert.ok(s.includes("fixture='/var/lib/harness/.overlay-probe-" + nonce + "'"));
  assert.ok(s.includes('mkdir "$fixture" || fail fixture')); assert.equal(s.includes('mkdir -p'), false);
  assert.match(s, /test "\$\(stat -c %d "\$dir"\)" = "\$fixtureDevice"/);
  assert.ok(s.includes('test ! -L "$dir"')); assert.ok(s.includes('test "$(stat -c %u "$fixture")" = 0'));
  assert.ok(s.includes('lowerdir=$fixture/lower,upperdir=$fixture/upper,workdir=$fixture/work'));
  assert.ok(s.includes('sha256sum "$fixture/lower/base" "$fixture/lower/delete-me"'));
  assert.ok(s.includes('"$(cat "$fixture/upper/base")" = changed-base'));
  assert.ok(s.includes('test ! -e "$merged/delete-me"')); assert.ok(s.includes('"$(cat "$fixture/lower/delete-me")" = original-delete'));
  assert.equal(s.includes('/var/lib/harness/docker/'), false); assert.equal(s.includes('dd '), false);
});

test('cleanup never deletes a mounted or unverified fixture, handles TERM, and never forces module unload', () => {
  const s = script(), cleanup = s.slice(s.indexOf('finish()'), s.indexOf('trap finish EXIT'));
  assert.ok(s.includes("failedStep=interrupted; exit 143' HUP INT TERM"));
  assert.ok(cleanup.includes('timeout 5 umount "$merged"'));
  assert.ok(cleanup.includes('if test "$unmounted" = true && safe_fixture && unmounted_here; then'));
  assert.equal(cleanup.includes('! mounted_here'), false, 'An unreadable mount table must not be mistaken for successful unmount');
  assert.equal((s.match(/rm -rf/g) || []).length, 1);
  assert.ok(cleanup.includes('timeout 5 rm -rf -- "$fixture"'));
  assert.ok(cleanup.includes('test "$(readlink -f "$fixture")" = "$fixture"') || s.includes('test "$(readlink -f "$fixture")" = "$fixture"'));
  assert.ok(cleanup.includes('moduleAttempted')); assert.ok(cleanup.includes('test "$moduleInitiallyLoaded" = false'));
  assert.ok(cleanup.includes('if test "$moduleLoadedByProbe" = true; then'));
  assert.ok(cleanup.includes('test "$refs" = 0')); assert.ok(cleanup.includes('timeout 5 rmmod overlay'));
  assert.equal(/(?:umount|rmmod)\s+.*(?:--force|\s-f(?:\s|$)|--lazy|\s-l(?:\s|$))/.test(s), false);
});

test('script exposes only bounded fixed probe operations, never daemon/install/network/config changes', () => {
  const s = script();
  for (const forbidden of ['dockerd', 'buildkitd', 'apk ', 'curl ', 'wget ', 'docker run', 'unshare ', 'nsenter ', 'iptables ', 'mkfs', 'fallocate', '/etc/docker', 'mount --bind', 'mount -o bind']) assert.equal(s.includes(forbidden), false, forbidden);
  assert.ok(s.includes('timeout 5 modprobe overlay')); assert.ok(s.includes('timeout 5 mount -t overlay'));
  assert.ok(s.includes('printf \'\\n' + marker + '%s\\n\''));
  assert.ok(s.length < 16000);
});

test('parser accepts only actual complete success metadata and freezes the sanitized result', () => {
  const expected = value(), result = parseOverlayProbe('serial noise\r\n' + encode(expected) + '\r\nroot prompt', nonce);
  assert.deepEqual(result, expected); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.checks));
  assert.equal(JSON.stringify(result).includes('/var/lib/'), false);
});

test('unsupported and failed results stay unsupported; failed unmount/cleanup cannot be promoted to success', () => {
  for (const [status, step] of [['unsupported', 'module'], ['failed', 'identity'], ['failed', 'unmount'], ['failed', 'cleanup'], ['failed', 'interrupted']]) {
    const sample = value(); sample.status = status; sample.supported = false; sample.failedStep = step; sample.checks.mounted = false; sample.checks.cleaned = step !== 'unmount';
    assert.equal(parseOverlayProbe(encode(sample), nonce).supported, false);
  }
  for (const key of checks) { const sample = value(); sample.checks[key] = false; assert.throws(() => parseOverlayProbe(encode(sample), nonce), /Inconsistent/); }
  for (const restore of ['retained-in-use', 'retained-unknown', 'failed']) { const sample = value(); sample.moduleRestore = restore; assert.throws(() => parseOverlayProbe(encode(sample), nonce), /Inconsistent/); }
});

test('parser rejects missing, wrong-nonce, oversized and noncanonical base64/UTF8/JSON records', () => {
  for (const text of ['', encode(value()).replace(nonce, 'c'.repeat(16)), marker + '%%%=', marker + 'AA', marker + 'AB==', marker + 'a'.repeat(8196), marker + Buffer.from([0xff]).toString('base64'), marker + Buffer.from('{').toString('base64'), marker + Buffer.from(JSON.stringify(value(), null, 2)).toString('base64')]) assert.throws(() => parseOverlayProbe(text, nonce));
  assert.throws(() => parseOverlayProbe('a'.repeat(128 * 1024 + 1), nonce), TypeError);
  assert.throws(() => parseOverlayProbe(encode(value()), 'invalid'), TypeError);
  assert.throws(() => parseOverlayProbe(null, nonce), TypeError);
});

test('parser dedupes identical complete records and rejects conflicting results or unknown metadata', () => {
  const line = encode(value()); assert.deepEqual(parseOverlayProbe(line + '\n' + line, nonce), value());
  const other = value(); other.kernel = '6.19.0-virt'; assert.throws(() => parseOverlayProbe(line + '\n' + encode(other), nonce), /Conflicting/);
  for (const mutate of [v => { v.secret = 'CANARY'; }, v => { v.checks.secret = true; }, v => { v.kernel = 'x"\\nCANARY'; }, v => { v.status = 'ready'; }, v => { v.failedStep = '/private'; }, v => { v.version = 2; }, v => { v.supported = 'true'; }, v => { delete v.checks.cleaned; }, v => { v.checks.cleaned = 1; }]) {
    const sample = value(); mutate(sample); assert.throws(() => parseOverlayProbe(encode(sample), nonce));
  }
  const duplicate = JSON.stringify(value()).replace('"supported":true', '"supported":false,"supported":true');
  assert.throws(() => parseOverlayProbe(encode(duplicate), nonce), /Noncanonical/);
});

test('parser rejects contradictory module flags, claimed success status and missing failedStep', () => {
  for (const mutate of [v => { v.moduleLoadedByProbe = true; }, v => { v.supported = false; }, v => { v.status = 'failed'; }, v => { v.failedStep = 'cleanup'; }, v => { v.moduleRestore = 'arbitrary'; }, v => { v.moduleInitiallyLoaded = 1; }]) {
    const sample = value(); mutate(sample); assert.throws(() => parseOverlayProbe(encode(sample), nonce));
  }
});

test('generated fixed script parses with an already-installed POSIX shell when available; never executes the probe', t => {
  const candidates = [process.env.OVERLAY_PROBE_SH, process.env.HARNESS_BASH, process.platform === 'win32' ? path.resolve(path.dirname(process.execPath), '../../native/git/usr/bin/sh.exe') : '/bin/sh', 'sh', 'bash'].filter(Boolean);
  let checked = false;
  for (const shell of candidates) {
    if (!['sh', 'bash'].includes(shell) && !fs.existsSync(shell)) continue;
    const result = cp.spawnSync(shell, ['-n'], { input: script(), encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.error?.code === 'ENOENT') continue;
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); checked = true; break;
  }
  if (!checked) t.skip('No installed POSIX shell found: syntax execution not verified here. No live overlay test performed.');
});

test('unchanged script refuses the local non-guest host before mutations and emits parseable failure metadata', t => {
  const candidates = [process.env.HARNESS_BASH, process.env.OVERLAY_PROBE_SH, process.platform === 'win32' ? path.resolve(path.dirname(process.execPath), '../../native/git/usr/bin/sh.exe') : '/bin/sh', 'bash', 'sh'].filter(Boolean);
  const installed = candidates.map(command => ({ command, prefix: [] }));
  if (process.platform === 'win32') installed.push({ command: path.join(process.env.SystemRoot || 'C:/Windows', 'System32/wsl.exe'), prefix: ['--exec', '/bin/sh'] });
  const invoke = (shell, args, options) => cp.spawnSync(shell.command, [...shell.prefix, ...args], { windowsHide: true, ...options });
  const shell = installed.find(candidate => invoke(candidate, ['-s'], { input: 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH; command -v id >/dev/null && command -v base64 >/dev/null\n', encoding: 'utf8', timeout: 3000 }).status === 0);
  if (!shell) { t.skip('No local shell for non-guest refusal check; no actual overlay run performed.'); return; }
  // Check this is not the target guest before testing its unchanged refusal path.
  const host = invoke(shell, ['-s'], { input: "if test -r /proc/cmdline && grep -q 'alpine_dev=cdrom:iso9660' /proc/cmdline; then exit 44; fi\nprintf NON_GUEST\n", encoding: 'utf8', timeout: 3000 });
  assert.equal(host.status, 0, 'Do not execute this test on a possible target guest'); assert.match(host.stdout, /NON_GUEST/);
  const result = invoke(shell, ['-s'], { input: script(), encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 1, result.stderr);
  const metadata = parseOverlayProbe(result.stdout, nonce);
  assert.equal(metadata.status, 'failed'); assert.equal(metadata.supported, false); assert.equal(metadata.failedStep, 'identity');
  assert.equal(metadata.checks.guestIdentity, false); assert.equal(metadata.checks.fixtureCreated, false); assert.equal(metadata.checks.mounted, false);
  assert.equal(metadata.moduleLoadedByProbe, false);
});
