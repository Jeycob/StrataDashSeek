import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolOutcome, classifyVerificationOutcome, recoveryContext, normalizeVerificationCommand, nodeTestCommandRecipe } from './tool-recovery.mjs';

test('Node file bootstrap failures differ from exceptions inside actual test cases', () => {
  const loader = 'TypeError: root path required\n at ModuleJob.run (node:internal/modules/esm/module_job:1:1)\n# Subtest: tests/api.test.mjs\nnot ok 1 - tests/api.test.mjs\n error: test failed\n code: ERR_TEST_FAILURE\n# tests 1\n# pass 0\n# fail 1';
  assert.equal(classifyToolOutcome({ kind: 'test', exitCode: 1, text: loader }).code, 'TEST_BOOTSTRAP_FAILURE');
  assert.equal(classifyToolOutcome({ kind: 'test', exitCode: 1, text: loader + '\n at TestContext.<anonymous> (test.mjs:3:1)' }).category, 'verification');
  assert.equal(classifyToolOutcome({ kind: 'test', exitCode: 1, text: loader + '\n ERR_ASSERTION' }).category, 'verification');
});

test('structured verification preserves configuration, timeout and assertion meanings and measured failure counts', () => {
  const common = { kind: 'all', exitCode: 1, text: '' };
  assert.equal(classifyVerificationOutcome({ code: 'INVALID_CONTRACT', checks: [] }, common).category, 'configuration');
  assert.equal(classifyVerificationOutcome({ code: 'NO_PROJECT_SANDBOX', checks: [] }, common).category, 'setup');
  const check = { passed: false, checksTotal: 1, checksPassed: 0, category: 'setup', diagnosticCode: 'TEST_BOOTSTRAP_FAILURE' };
  assert.equal(classifyVerificationOutcome({ checks: [check] }, common).category, 'setup');
  assert.equal(classifyVerificationOutcome({ checks: [{ ...check, category: 'timeout', diagnosticCode: 'EXECUTION_TIMEOUT' }] }, common).category, 'timeout');
  const failure = { ...check, category: 'verification', diagnosticCode: 'ASSERTION_FAILURE', checksTotal: 5, checksPassed: 2 };
  const actual = classifyVerificationOutcome({ checks: [failure] }, common); assert.equal(actual.category, 'verification'); assert.equal(actual.evidence.failed, 3);
  assert.equal(classifyVerificationOutcome({ checks: [] }, { kind: 'all', exitCode: 0 }).category, 'empty-verification');
  assert.equal(classifyVerificationOutcome({ code: 'INVALID_CONTRACT', checks: [] }, { ...common, text: 'ERR_ASSERTION' }).category, 'verification');
});

test('only literal display filters are removed, including quoted grep alternation and head SIGPIPE patterns', () => {
  const command = 'node --test tests/api.test.mjs 2>&1 | grep -vE "^ℹ (suites|duration)" | head -70';
  assert.deepEqual(normalizeVerificationCommand(command), { command: 'node --test tests/api.test.mjs', changed: true, reason: 'VERIFICATION_OUTPUT_FILTERS_REMOVED' });
  assert.equal(normalizeVerificationCommand('cd server && ' + command).command, 'cd server && node --test tests/api.test.mjs');
  for (const value of ['npm test 2>&1 | grep -q passed', 'npm test 2>&1 | tee evidence.log', 'npm test 2>&1 | head -70; exit 0', 'npm test 2>&1 | grep -vE "$(touch bad)" | head -70', 'cat secret 2>&1 | head -70']) assert.equal(normalizeVerificationCommand(value).changed, false);
});

test('setup and invocation errors do not masquerade as completed verification', () => {
  const examples = [
    ['Error: Cannot find module /project/test\ncode: MODULE_NOT_FOUND\n# tests 1\n# fail 1', 'setup'],
    ['npm error Missing script: "test"', 'setup'],
    ['sh: playwright: command not found', 'setup'],
    ['Error [ERR_INVALID_ARG_TYPE]: options must be an object. Received string', 'invocation'],
    ['node: bad option: --testtimout', 'invocation'],
    ['Error: The third argument must be an object', 'invocation'],
    ['old_string not found in current file', 'stale-edit'],
    ['Failed to find expected lines in /project/app.js', 'stale-edit'],
  ];
  for (const [text, category] of examples) {
    const result = classifyToolOutcome({ kind: 'test', exitCode: 1, isError: true, text });
    assert.equal(result.category, category, text); assert.equal(result.verification, false, text); assert.equal(result.failed, true);
  }
});

test('real assertions outrank setup-like words printed in their failure messages', () => {
  const result = classifyToolOutcome({ kind: 'test', exitCode: 1,
    text: 'AssertionError [ERR_ASSERTION]: expected "Cannot find module; AbortError; test timed out"\n# tests 1\n# fail 1' });
  assert.equal(result.category, 'verification'); assert.equal(result.verification, true); assert.equal(result.failed, true);
});

test('timeouts and cancellation preserve incomplete status and actionable cleanup guidance', () => {
  for (const input of [{ timedOut: true }, { exitCode: 1, text: "failureType: 'testTimeoutFailure'" }, { exitCode: 1, text: '[timed out after 110000ms]' }]) {
    const result = classifyToolOutcome({ kind: 'test', ...input });
    assert.equal(result.category, 'timeout'); assert.equal(result.verification, false); assert.match(result.guidance, /cleanup|handles/);
  }
  assert.equal(classifyToolOutcome({ kind: 'test', aborted: true }).category, 'cancelled');
  assert.equal(classifyToolOutcome({ kind: 'test', errorCode: 'TOOL_ABORTED_BEFORE_DISPATCH' }).category, 'cancelled');
});

test('browser navigation and locator timeout diagnostics remain incomplete verification', () => {
  for (const text of [
    'page.reload: Timeout 6000ms exceeded.\nCall log:\n  - waiting for navigation until "networkidle"\n  name: \'TimeoutError\'',
    'locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for a visible control',
    'TimeoutError: waiting for application readiness',
  ]) {
    for (const kind of [undefined, 'browser', 'test']) {
      const result = classifyToolOutcome({ kind, exitCode: 1, text });
      assert.equal(result.category, 'timeout', text); assert.equal(result.code, 'EXECUTION_TIMEOUT');
      assert.equal(result.verification, false); assert.equal(result.failed, true);
    }
    assert.equal(classifyToolOutcome({ exitCode: 0, text }).category, 'success');
    assert.equal(classifyToolOutcome({ kind: 'test', exitCode: 1, text: 'AssertionError [ERR_ASSERTION]\n' + text }).category, 'verification');
  }
});

test('exit zero cannot turn zero tests, all skipped tests or masked failures into a stage pass', () => {
  for (const text of ['# tests 0\n# pass 0\n# fail 0', 'ℹ tests 2\nℹ pass 0\nℹ skipped 2', 'No test files found', '[NODE_TEST_NO_FILES] No runnable Node test files were found in the requested directory', '# tests 1\n# pass 0\n# todo 1']) {
    const result = classifyToolOutcome({ kind: 'test', exitCode: 0, text });
    assert.equal(result.category, 'empty-verification', text); assert.equal(result.verification, false); assert.equal(result.failed, true);
  }
  const masked = classifyToolOutcome({ kind: 'test', exitCode: 0, text: '# tests 3\n# pass 2\n# fail 1' });
  assert.equal(masked.failed, true); assert.equal(masked.category, 'verification');
  const unknown = classifyToolOutcome({ kind: 'test', exitCode: null, text: 'still running' });
  assert.equal(unknown.verification, false); assert.equal(unknown.failed, true);
});

test('successful commands can legitimately contain error words and explicit verification keeps its status', () => {
  const result = classifyToolOutcome({ kind: 'test', exitCode: 0, text: 'checks reject invalid argument / cannot find module\n# tests 2\n# pass 2\n# fail 0' });
  assert.equal(result.category, 'success'); assert.equal(result.verification, true); assert.equal(result.failed, false);
  assert.equal(classifyToolOutcome({ exitCode: 0, text: 'ordinary tool output' }).verification, false);
});

test('recovery feedback is bounded and never copies secret command arguments or logs', () => {
  const secret = 'PRIVATE_TOKEN_DO_NOT_COPY';
  const input = { kind: 'test', exitCode: 1, text: 'Cannot find module ' + secret, arguments: { password: secret } };
  const feedback = recoveryContext(input);
  assert.match(feedback, /SETUP_FAILURE/); assert.equal(feedback.includes(secret), false);
  assert.ok(recoveryContext(input, { maxChars: 70 }).length <= 70);
  assert.equal(recoveryContext({ category: 'setup', code: secret, guidance: secret }).includes(secret), false);
  assert.equal(recoveryContext({ exitCode: 0 }), '');
});

test('only a known terminal tail filter is removed, exposing the real verification status', () => {
  assert.deepEqual(normalizeVerificationCommand('node --test test/ 2>&1 | tail -n 40'),
    { command: 'node --test test/', changed: true, reason: 'TERMINAL_TAIL_REMOVED' });
  assert.equal(normalizeVerificationCommand('npm test 2>&1 | tail --lines=60').command, 'npm test');
  assert.equal(normalizeVerificationCommand('cd server && npm test 2>&1 | tail -60').command, 'cd server && npm test');
  assert.equal(normalizeVerificationCommand('cd "server folder" && node --test --test-timeout=6000 --test-reporter=spec test/api.test.mjs 2>&1 | tail -70').command,
    'cd "server folder" && node --test --test-timeout=6000 --test-reporter=spec test/api.test.mjs');
  for (const command of ['cat README.md 2>&1 | tail -n 40', 'npm test | tail -n 40',
    'npm test 2>&1 | tail -n 40; exit 0', 'cd app && cd child && npm test 2>&1 | tail -n 40',
    'node -e "run()" --test 2>&1 | tail -n 40', 'node server.js --test 2>&1 | tail -n 40', 'npm test "$(touch /tmp/probe)" 2>&1 | tail -n 40',
    'npm test 2>&1 | grep failed | tail -n 40']) {
    assert.deepEqual(normalizeVerificationCommand(command), { command, changed: false }, command);
  }
});

test('Node helper recipe retains literal argv, rejects shell programs and never rewrites JS', () => {
  const options = { nodePath: '/data/harness/node/bin/node', helperPath: '/data/harness/app/development/test-command.cjs' };
  const result = nodeTestCommandRecipe('node --test --test-timeout=6000 "test folder/"', options);
  assert.equal(result.changed, true); assert.match(result.command, /'--test' '--test-timeout=6000' 'test folder\/'$/);
  const nested = nodeTestCommandRecipe('cd server && node --test --test-timeout=6000 test/api.test.mjs', options);
  assert.equal(nested.changed, true); assert.ok(nested.command.startsWith('cd server && '));
  assert.match(nested.command, /'--test-timeout=6000' 'test\/api.test.mjs'$/);
  for (const command of ['npm test', 'node server.js --test test/', 'node -e "transform(x,\'{}\')" --test', 'node --test test/; echo done',
    'node --test ~/test', 'node --test *.test.js', 'node --test test/ # comment', 'node --test "$(bad)"']) {
    assert.deepEqual(nodeTestCommandRecipe(command, options), { command, changed: false }, command);
  }
});

test('literal cd normalization rejects expansions, extra shell operators and misleading quoted prefixes', () => {
  const options = { nodePath: '/node', helperPath: '/helper' };
  for (const prefix of ['cd "$(bad)" && ', 'cd `bad` && ', 'cd ~ && ', 'cd "$ROOT" && ',
    'cd - && ', 'cd a; npm test && ', 'cd "a&&b" && ', 'cd a && cd b && ', 'cd a || ', 'cd a #comment && ']) {
    const command = prefix + 'node --test test/';
    assert.deepEqual(nodeTestCommandRecipe(command, options), { command, changed: false }, command);
    const filtered = command + ' 2>&1 | tail -60';
    assert.deepEqual(normalizeVerificationCommand(filtered), { command: filtered, changed: false }, filtered);
  }
  const quoted = "cd 'server folder' && node --test test/";
  assert.ok(nodeTestCommandRecipe(quoted, options).command.startsWith("cd 'server folder' && "));
  const actual = 'cd server && node --test --test-timeout=6000 --test-reporter=spec test/api.test.mjs 2>&1 | tail -70';
  const unfiltered = normalizeVerificationCommand(actual);
  assert.equal(unfiltered.changed, true);
  const wrapped = nodeTestCommandRecipe(unfiltered.command, options);
  assert.equal(wrapped.changed, true); assert.ok(wrapped.command.startsWith('cd server && '));
  assert.equal(wrapped.command.includes('tail'), false); assert.match(wrapped.command, /'test\/api.test.mjs'$/);
});
