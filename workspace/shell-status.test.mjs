import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationStatusMayBeMasked as masked } from './shell-status.mjs';

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
