import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationStatusMayBeMasked as masked, shellVerificationKind as kind } from './shell-status.mjs';

function expect(commands, expected) {
  for (const command of commands) assert.equal(masked(command), expected, JSON.stringify(command));
}

test('direct verification and quoted name patterns retain an authoritative status', () => {
  expect([
    'npm test', 'node --test --test-name-pattern \'a|b\' tests/a.test.mjs',
    'node --test --test-name-pattern "a|b; c" tests/a.test.mjs',
    'printf "%s" "literal ; | & ( ) !"', "printf '%s' '$(printf unsafe) `x`'",
    'printf "%s" "$HOME"', 'echo hello! !',
  ], false);
});

test('escaped metacharacters and literal quote transitions are not control operators', () => {
  expect([
    String.raw`printf %s a\|b\;c\&d\(e\)`, String.raw`printf %s \!`,
    'printf "%s" "\\$(literal) \\`literal\\`"',
    String.raw`node --test \
 tests/a.test.mjs`,
    `printf '%s' a"|"b';'c`,
  ], false);
});

test('only trailing separators and comments are harmless', () => {
  expect([
    'npm test;', 'npm test\n', 'npm test;\n\n', '\n npm test\n\n',
    'npm test # | ; & $(not executed) `ignored`\n',
    'npm test; # ignored ;\n# ignored pipe |\n',
    '# | ; $(ignored)\n', '', '  ', 'echo word#literal',
  ], false);
  expect(['npm test; echo done', 'npm test\necho done', 'npm test\n# comment\necho done', 'npm test;;', '; npm test'], true);
  expect(['npm test \u00a0#| cat', 'npm test \r#| cat'], true);
});

test('AND chains preserve exit zero across every command including cd and redirections', () => {
  expect([
    'cd /project && node --test tests/a.test.mjs',
    'cd "project with spaces" &&\n# comment\n npm test && echo done',
    'A=one B="two words" npm test && npm run build;\n',
    'cd path\\ with\\ spaces && npm test > result.log 2>&1',
  ], false);
});

test('pipes, OR lists, background execution and multiple commands can mask status', () => {
  expect([
    'npm test | tail -20', 'npm test |& tail -20', 'npm test || true',
    'npm test &', 'npm test & echo done', 'npm test; echo "exit=$?"',
    'npm test\nprintf done', 'cd path && npm test; true',
    "node --test --test-name-pattern 'a|b' | tail -20", "npm test '#literal' | cat",
  ], true);
});

test('redirection ampersands and clobber pipe differ from shell control operators', () => {
  expect([
    'npm test 2>&1', 'npm test 2>& 1', 'npm test &>result.log',
    'npm test &>>result.log', 'npm test >|result.log', 'npm test 3<>data',
    'npm test 0<&3 3>&-', '2>errors npm test', 'npm test >"a|b;c&d"',
  ], false);
  expect(['npm test 2>&1 | tail', 'npm test &>out &', 'npm test >out; true'], true);
});

test('substitution, negation and subshells remain untrusted outside single quotes', () => {
  expect([
    'node --test "$(echo tests/a)"', 'node --test $(echo tests/a)',
    'npm test `echo extra`', 'npm test "`echo extra`"', '! npm test',
    'cd /project && ! npm test', 'A=1 ! npm test', '(npm test)', 'npm test <(echo data)',
    'value=$((1+2)) npm test',
  ], true);
});

test('unsupported or unbalanced shell syntax is conservatively untrusted', () => {
  expect([
    'npm test "unfinished', "npm test 'unfinished", 'npm test \\', 'npm test &&',
    'npm test && ;', 'npm test\n&& echo done', 'npm test >', 'npm test > >out',
    'npm test <<EOF\ntext\nEOF', "npm test $'ansi\\x27'", 'npm test "${FILE}"',
    'if npm test; then true; fi', '{ npm test; }', 'while true; do npm test; done',
    'npm test\0',
  ], true);
  assert.equal(masked(undefined), true);
});

function expectKind(commands, expected) {
  for (const command of commands) assert.equal(kind(command), expected, JSON.stringify(command));
}

test('verification kind comes from a real command head and exact script arguments', () => {
  expectKind([
    'npm test', 'npm run test:unit', 'npm check', 'npm run check:types', 'npm run typecheck',
    'pnpm run test:api', 'yarn test', 'bun test', 'playwright test tests/browser.spec.js',
    'npm --silent run test', 'npm --prefix "project with spaces" run test:unit',
    'npm run --silent test', "'npm' 'test'", 'A=one B="two words" npm test',
    '/opt/node/bin/npm test', 'node --test tests/a.test.mjs',
    '/opt/node/bin/node --test --test-name-pattern "a|b; c" tests/a.test.mjs',
    'node --no-warnings --test --test-force-exit tests/a.test.mjs',
    'node --require ./setup.cjs --test tests/a.test.mjs',
    'node --test --test-name-pattern --help tests/a.test.mjs',
    'pytest', 'pytest -v tests/test_api.py', 'cargo test --quiet', 'cargo +stable test',
    'go test ./...', 'dotnet test project.sln',
  ], 'test');
  expectKind([
    'npm run build', 'npm run build:client', 'npm run lint', 'pnpm build',
    'cargo build', 'cargo check', 'go build ./...', 'dotnet build project.sln',
    'tsc --noEmit', 'eslint src', '/project/node_modules/.bin/eslint src',
  ], 'build');
});

test('quoted program text, edits and display commands never become verifier invocations', () => {
  expectKind([
    `node -e "p.scripts.test='node --test test/'"`,
    `node -e "console.log('npm test; pytest | cargo test')"`,
    `node --eval 'console.log("npm run build")'`,
    `node --print '"pytest"'`, `node -pe '"npm test"'`,
    'echo npm test', 'echo "node --test; npm build"',
    'printf "%s" "pytest | npm test"', "grep 'npm run test' package.json",
    "cat 'npm test'", 'cat package.json', 'node read-package.mjs npm test',
    'node script.mjs --test', 'node --require "--test" script.mjs',
    'node --test-name-pattern "--test" tests/a.test.mjs', 'node -- --test',
    'npm run', 'npm run contest', 'npm run testish', 'npm run build-not-tests',
    'npm exec -- node --test tests/a.test.mjs', 'bash -c "npm test"',
    "'A=one' npm test", String.raw`A\=one npm test`,
    'echo ok >pytest', '>"npm test"', 'go check ./...', 'dotnet check',
  ], null);
});

test('eval/print modes and help/version requests are not checks', () => {
  expectKind([
    'node --test --eval "1"', 'node --test -e "1"', 'node -e"1" --test',
    'node --test --print="1"', 'node --test -p "1"',
    'node --test --help', 'node --test --version', 'node -v --test',
    'npm test --help', 'npm run build --version', 'npm --version test',
    'npm run test -- --help', 'pytest --help', 'pytest --version', 'pytest -V',
    'cargo test --help', 'go test -h', 'dotnet build --help',
    'tsc --version', 'eslint -v', 'playwright test --help',
  ], null);
});

test('top-level separators retain detection for the separate masking guard', () => {
  expectKind([
    'cd /project && npm test', 'cd "$HOME/project" && npm test',
    'npm test | tail -20', 'node --test tests/a.test.mjs |& cat',
    'npm test || true', 'true || pytest', 'npm test &', 'npm test & echo done',
    'npm test; echo "exit=$?"', 'node --test >result.log 2>&1; cat result.log',
    'echo "npm run build"; pytest', 'npm test\n# diagnostic only\necho "$?"',
    'npm test &&\n pytest', '2>errors npm test', 'npm >result.log test',
    'npm test;', '\n# ignored\nnpm test\n\n',
  ], 'test');
  expectKind([
    'npm run build && npm test', 'npm test && npm run build',
    'npm run build | cat; pytest', 'tsc --noEmit || npm run test:unit',
  ], 'test');
  expectKind([
    `node -e "p.scripts.test='node --test test/'" && npm run build`,
    'echo "npm test" | npm run build',
  ], 'build');
  assert.equal(masked('npm test | tail -20'), true);
  assert.equal(masked('npm test; echo "exit=$?"'), true);
  assert.equal(masked('cd /project && npm test'), false);
});

test('literal quoted/escaped operators and redirection data are not extra heads', () => {
  expectKind([
    'node --test --test-name-pattern "npm run build|pytest; cargo test" tests/a.test.mjs',
    String.raw`node --test --test-name-pattern a\|b tests/a.test.mjs`,
    'npm test >"cargo build; pytest" 2>&1',
    "node --test --test-name-pattern '$HOME' tests/a.test.mjs",
  ], 'test');
  expectKind([
    'echo "npm test | pytest; cargo test"', String.raw`echo npm\ test\;pytest`,
    "printf '%s' '$(npm test) `pytest`'", 'cat <"npm test"',
  ], null);
});

test('unsupported shell structure and unresolved verifier arguments stay conservative', () => {
  expectKind([
    'npm test "unfinished', "npm test 'unfinished", 'npm test \\', 'npm test &&',
    'npm test |', 'npm test ||', 'npm test;;', '; npm test', 'npm test &;',
    'npm test\n&& echo done', 'npm test >', 'npm test > >out',
    'npm test <<EOF\npytest\nEOF', 'npm test $(echo file)',
    'npm test `echo file`', 'npm test $[1+2]', 'npm test "$[1+2]"',
    'node --test "${FILE}"', 'node --test "$FILE"',
    'npm run $SCRIPT', '"$NODE" --test', '"$HOME/bin/node" --test',
    'if npm test; then true; fi', '(npm test)', '! npm test', '{ npm test; }',
    'npm test ||| pytest', 'npm test\0',
  ], null);
  assert.equal(kind(undefined), null);
  assert.equal(kind(''), null);
});
