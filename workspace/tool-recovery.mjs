// Diagnostics are advisory. Never rewrite source, retry tools or grant permissions.
const boundedText = value => String(value ?? '').replace(/\u001b\[[0-9;]*m/gu, '').slice(0, 32000)
  + (String(value ?? '').length > 32000 ? '\n' + String(value).slice(-16000) : '');
const GUIDANCE = Object.freeze({
  success: '',
  verification: 'Verification ran and reported a failure. Inspect the first failing assertion or diagnostic, make a targeted correction, then rerun the same check. Do not suppress failures.',
  setup: 'The command did not reach meaningful verification. Check the exact executable, working directory, module path, imported modules, shared test setup and constructor options. A Node file/module bootstrap error can fail before its test cases run. If npm invokes node --test with a directory operand, inspect package.json and select actual test files or a quoted Node test glob; do not silently bypass npm lifecycle hooks or edit scripts automatically. Do not install or replace tools speculatively.',
  invocation: 'The tool or library invocation is invalid. Read its installed signature or CLI help and correct the argument count, argument types or option spelling. Do not rewrite arbitrary JavaScript automatically.',
  configuration: 'Verification configuration was rejected before meaningful checks. Read the installed contract and browser-plan schema in /data/harness/app/quality/README.md. Use supported keys, direct program arguments and assigned project ports. Keep the stage unverified; do not replace real assertions with trivial checks.',
  'stale-edit': 'The edit target no longer matches the supplied old text. Reread the current relevant lines, then submit a small exact edit. Never fuzzy-apply, force an edit, or overwrite the whole file to bypass the mismatch.',
  timeout: 'Execution exceeded its time limit; completion is unverified. Inspect the last visible progress, unresolved handles, pending requests and test cleanup. Stop only processes owned by this task. Keep the outer process deadline; do not turn a timeout into a pass or add force-exit to hide a hang.',
  cancelled: 'Execution was cancelled. No verification completion is recorded. Respect cancellation and wait for the next requested action.',
  'empty-verification': 'No runnable tests were verified. Check the test selection, skipped-test totals and working directory. For Node --test, use actual test files or quoted supported glob patterns. Zero tests do not complete a verified stage.',
  'tool-error': 'The tool failed without a completed verification result. Inspect its exact diagnostic and current inputs, then choose a different concrete approach if the same error repeats.',
});
const DIAGNOSTIC_CODES = new Set(['OK', 'TOOL_FAILURE', 'EXECUTION_CANCELLED', 'EXECUTION_TIMEOUT',
  'ASSERTION_FAILURE', 'EDIT_CONTEXT_STALE', 'INVALID_INVOCATION', 'SETUP_FAILURE', 'TEST_BOOTSTRAP_FAILURE', 'NO_TESTS_EXECUTED', 'VERIFICATION_STATUS_UNAVAILABLE', 'VERIFICATION_CONFIGURATION']);
const CONFIGURATION_CODES = new Set(['INVALID_CONTRACT', 'INVALID_CHECK', 'INVALID_BROWSER_CHECK', 'INVALID_BROWSER_PLAN', 'INVALID_BROWSER_ACTION', 'INVALID_BROWSER_URL', 'INVALID_VIEWPORT', 'INVALID_FLOW', 'INVALID_SELECTOR', 'INVALID_ROUTE', 'INVALID_BROWSER_VALUE', 'INVALID_ASSERTION', 'INVALID_SCREENSHOT', 'INVALID_COMMAND', 'INVALID_TIMEOUT', 'INVALID_ENV', 'INVALID_ARTIFACTS', 'INVALID_KIND', 'MISSING_REQUIRED_CHECK', 'NO_CHECKS', 'SHELL_REFUSED', 'EMPTY_BROWSER_FLOW', 'EMPTY_ASSERTION', 'SCREENSHOT_REQUIRED', 'UNASSIGNED_PORT']);

function count(text, name) {
  const values = [...text.matchAll(new RegExp('(?:^|\\n)\\s*(?:[#ℹ]\\s*)?' + name + '\\s+(\\d+)\\b', 'gmu'))];
  return values.length ? Number(values.at(-1)[1]) : undefined;
}

export function classifyToolOutcome(input = {}) {
  const text = boundedText(input.text), kind = input.kind;
  const explicitCounts = input.counts && ['tests', 'passed', 'failed'].every(key => Number.isSafeInteger(input.counts[key]) && input.counts[key] >= 0 && input.counts[key] <= 1000000) ? input.counts : undefined;
  const counts = explicitCounts ? { tests: explicitCounts.tests, passed: explicitCounts.passed, failed: explicitCounts.failed } : { tests: count(text, 'tests'), passed: count(text, 'pass'), failed: count(text, 'fail'), skipped: count(text, 'skipped'), todo: count(text, 'todo') };
  const assertion = /\b(?:ERR_ASSERTION|AssertionError|AssertionFailedError|assertion failed)\b/iu.test(text);
  const failed = Boolean(input.isError || input.timedOut || input.aborted || Number.isInteger(input.exitCode) && input.exitCode !== 0 || kind && (counts.failed ?? 0) > 0);
  let category = failed ? kind ? 'verification' : 'tool-error' : 'success', code = failed ? 'TOOL_FAILURE' : 'OK';
  if (input.aborted || ['TOOL_ABORTED', 'TOOL_ABORTED_BEFORE_DISPATCH', 'ABORT_ERR'].includes(input.errorCode)) {
    category = 'cancelled'; code = 'EXECUTION_CANCELLED';
  } else if (input.timedOut) {
    category = 'timeout'; code = 'EXECUTION_TIMEOUT';
  } else if (failed && assertion) {
    category = kind ? 'verification' : 'tool-error'; code = 'ASSERTION_FAILURE';
  } else if (failed && (CONFIGURATION_CODES.has(input.errorCode) || input.errorCode === 'VERIFICATION_CONFIGURATION')) {
    category = 'configuration'; code = 'VERIFICATION_CONFIGURATION';
  } else if (failed && ['SETUP_FAILURE', 'TEST_BOOTSTRAP_FAILURE', 'NO_MANAGED_PROJECT', 'NO_PROJECT_SANDBOX', 'BROWSER_UNAVAILABLE', 'PORT_UNAVAILABLE', 'QUALITY_RUNNER_FAILED', 'VERIFICATION_BUSY', 'ENOENT'].includes(input.errorCode)) {
    category = 'setup'; code = input.errorCode === 'TEST_BOOTSTRAP_FAILURE' ? input.errorCode : 'SETUP_FAILURE';
  } else if (failed && input.errorCode === 'INVALID_INVOCATION') {
    category = 'invocation'; code = 'INVALID_INVOCATION';
  } else if (failed && input.errorCode === 'NO_TESTS_EXECUTED') {
    category = 'empty-verification'; code = 'NO_TESTS_EXECUTED';
  } else if (failed && /(?:^|\n)\s*(?:AbortError:|\[TOOL_ABORTED(?:_BEFORE_DISPATCH)?\])/u.test(text)) {
    category = 'cancelled'; code = 'EXECUTION_CANCELLED';
  } else if (failed && /\b(?:ETIMEDOUT|ERR_TEST_TIMEOUT|CHECK_TIMEOUT|VERIFICATION_BUDGET_EXHAUSTED)\b|failureType:\s*['"]testTimeoutFailure['"]|\[(?:timed out|timeout)[^\]]*\]|(?:command|test|operation) timed out/iu.test(text)) {
    category = 'timeout'; code = 'EXECUTION_TIMEOUT';
  } else if (failed && (/\bERR_TEST_FAILURE\b/u.test(text) || /^\s*['"]test failed['"]\s*$/mu.test(text)) && /\b(?:ModuleJob\.run|Module\._compile|Module\._load|executeUserEntryPoint)\b/u.test(text)
    && !/\bat (?:async )?TestContext\b/u.test(text)
    && (([...text.matchAll(/^\s*not ok \d+ - (.+)$/gmu)].length > 0 && [...text.matchAll(/^\s*not ok \d+ - (.+)$/gmu)].every(match => /\.[cm]?[jt]s(?:x)?\s*$/u.test(match[1]))) || /test at [^\n]+:1:1\b/u.test(text))) {
    category = 'setup'; code = 'TEST_BOOTSTRAP_FAILURE';
  } else if (failed && /old_string[\s\S]{0,100}(?:not found|does not match)|(?:old text|search string|target text|search block)[\s\S]{0,100}(?:not found|does not match|not match|could not be found)|(?:no matches|no occurrences) found|(?:patch|edit)[\s\S]{0,80}(?:context mismatch|stale context)|could not find[\s\S]{0,80}(?:old_string|old text)|failed to find expected lines/iu.test(text)) {
    category = 'stale-edit'; code = 'EDIT_CONTEXT_STALE';
  } else if (failed && /\b(?:ERR_INVALID_ARG_TYPE|ERR_INVALID_ARG_VALUE|ERR_MISSING_ARGS|ERR_PARSE_ARGS_UNKNOWN_OPTION)\b|(?:invalid|unknown|unrecognized|bad) (?:option|argument)|(?:expected|expects)[^\n]{0,80}(?:arguments?|parameters?|object|boolean|number|string)[^\n]{0,80}(?:got|received|instead|but)|(?:transform|build)\([^\n]{0,80}(?:takes|arguments)|(?:first|second|third) argument[^\n]{0,60}(?:must|should) be/iu.test(text)) {
    category = 'invocation'; code = 'INVALID_INVOCATION';
  } else if (failed && /\b(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ENOENT|EACCES|EPERM|EADDRINUSE)\b|cannot find (?:module|package)|command not found|not recognized as (?:an internal|the name)|missing script:|could not (?:find|locate)[^\n]{0,80}(?:executable|package.json)|no such file or directory/iu.test(text)) {
    category = 'setup'; code = 'SETUP_FAILURE';
  } else if ((kind === 'test' || kind && explicitCounts) && (counts.tests === 0 || counts.tests !== undefined && counts.tests === (counts.skipped ?? 0) + (counts.todo ?? 0) && (counts.passed ?? 0) === 0 || /\bNODE_TEST_NO_FILES\b|no runnable Node test files|\bno (?:tests?|test files) (?:found|matched|collected)|collected 0 items/iu.test(text))) {
    category = 'empty-verification'; code = 'NO_TESTS_EXECUTED';
  } else if (kind && input.exitCode !== 0 && !Number.isInteger(input.exitCode)) {
    category = 'tool-error'; code = 'VERIFICATION_STATUS_UNAVAILABLE';
  }
  const verification = Boolean(kind && (category === 'verification' || category === 'success'));
  return { category, code, failed: failed || category === 'empty-verification' || code === 'VERIFICATION_STATUS_UNAVAILABLE', verification,
    guidance: GUIDANCE[category], evidence: { ...counts, assertion } };
}

export function classifyVerificationOutcome(value, input = {}) {
  const checks = Array.isArray(value?.checks) ? value.checks : [];
  const failed = checks.filter(check => check.passed !== true);
  const nonVerification = new Set(['setup', 'invocation', 'configuration', 'timeout', 'empty-verification', 'tool-error']);
  const inherited = failed.length && failed.every(check => nonVerification.has(check.category) && DIAGNOSTIC_CODES.has(check.diagnosticCode))
    ? failed.find(check => check.category === 'timeout') ?? failed[0] : undefined;
  const counts = checks.every(check => Number.isSafeInteger(check.checksTotal) && Number.isSafeInteger(check.checksPassed) && check.checksTotal >= check.checksPassed && check.checksPassed >= 0)
    ? checks.reduce((all, check) => ({ tests: all.tests + check.checksTotal, passed: all.passed + check.checksPassed, failed: all.failed + check.checksTotal - check.checksPassed }), { tests: 0, passed: 0, failed: 0 }) : undefined;
  return classifyToolOutcome({ ...input, counts, timedOut: input.timedOut || value?.timedOut || inherited?.category === 'timeout',
    errorCode: input.errorCode ?? value?.code ?? inherited?.diagnosticCode });
}

export function recoveryContext(input = {}, { maxChars = 2400 } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 8000) throw new TypeError('Invalid recovery-context bound');
  const value = input.category && input.code ? input : classifyToolOutcome(input);
  if (value.category === 'success') return '';
  // Fixed guidance deliberately excludes raw command arguments, source and log secrets.
  const code = DIAGNOSTIC_CODES.has(value.code) ? value.code : 'TOOL_FAILURE';
  const guidance = Object.hasOwn(GUIDANCE, value.category) ? GUIDANCE[value.category] : GUIDANCE['tool-error'];
  return ('[Harness diagnostic: ' + code + ']\n' + guidance).slice(0, maxChars);
}

// Deliberately small shell grammar: literal words/quotes only, no expansion,
// redirects or control operators. Unsupported forms remain untouched.
function words(command) {
  if (typeof command !== 'string' || command.length > 65536 || /[$`\r\n;&|<>\\#~]/u.test(command)) return null;
  const tokens = []; let at = 0;
  while (at < command.length) {
    while (/\s/u.test(command[at] ?? '') && at < command.length) at++;
    if (at === command.length) break;
    let word = '', quote = null;
    while (at < command.length) {
      const char = command[at++];
      if (quote) { if (char === quote) quote = null; else word += char; }
      else if (char === '"' || char === "'") quote = char;
      else if (/\s/u.test(char)) break;
      else word += char;
    }
    if (quote || !word) return null; tokens.push(word);
  }
  return tokens;
}
const quote = value => "'" + value.replace(/'/gu, "'\\''") + "'";
function isVerification(argv) {
  return argv && (argv[0] === 'node' && argv[1] === '--test' && !argv.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg))
    || ['npm', 'pnpm', 'yarn', 'bun'].includes(argv[0]) && /^(?:run )?(?:test|check|typecheck|build|lint)(?: |$)/u.test(argv.slice(1).join(' '))
    || ['pytest', 'tsc', 'eslint'].includes(argv[0]) || ['cargo', 'go', 'dotnet'].includes(argv[0]) && ['test', 'check', 'build'].includes(argv[1]));
}

function commandBody(command) {
  if (typeof command !== 'string') return null;
  if (!command.startsWith('cd ')) return { prefix: '', body: command };
  // One literal cd operand and one && only. Retain the original prefix so
  // directory names, quoting and failure of cd keep their shell semantics.
  const match = /^(cd\s+(?:'[^'\r\n]*'|"[^"\r\n]*"|[^\s'";&|<>]+)\s+&&\s+)([^\r\n]+)$/u.exec(command);
  if (!match) return null;
  const prefixWords = words(match[1].replace(/\s+&&\s+$/u, ''));
  if (prefixWords?.length !== 2 || prefixWords[0] !== 'cd' || prefixWords[1].startsWith('-')) return null;
  return { prefix: match[1], body: match[2] };
}

export function normalizeVerificationCommand(command) {
  if (typeof command !== 'string') return { command, changed: false };
  const parts = commandBody(command); if (!parts) return { command, changed: false };
  const match = /^(.*?)\s+2>&1\s*\|\s*tail\s+(?:-n\s+|--lines=|-)([1-9]\d{0,4})\s*$/u.exec(parts.body);
  const argv = match && words(match[1]);
  if (!argv || !isVerification(argv)) {
    // A narrowly recognized display-only pipeline. Split pipes outside literal
    // quotes, including quoted regex alternation, without evaluating shell text.
    if (/[$`\\\r\n]/u.test(parts.body)) return { command, changed: false };
    let quoted = null, start = 0; const segments = [];
    for (let index = 0; index < parts.body.length; index++) {
      const char = parts.body[index];
      if (quoted) { if (char === quoted) quoted = null; }
      else if (char === '"' || char === "'") quoted = char;
      else if (char === '|') { segments.push(parts.body.slice(start, index).trim()); start = index + 1; }
    }
    if (quoted) return { command, changed: false };
    segments.push(parts.body.slice(start).trim());
    if (segments.length < 2 || segments.length > 5 || !/\s+2>&1$/u.test(segments[0])) return { command, changed: false };
    const left = segments.shift().replace(/\s+2>&1$/u, ''), leftWords = words(left);
    const displayOnly = segment => /^(?:head|tail)\s+(?:-n\s*|--lines=|-)[1-9]\d{0,4}$/u.test(segment)
      || /^grep\s+-(?:vE|Ev)\s+(?:"[^"$`\\\r\n]*"|'[^'$`\\\r\n]*')$/u.test(segment);
    if (!isVerification(leftWords) || !segments.every(displayOnly)) return { command, changed: false };
    return { command: parts.prefix + left, changed: true, reason: 'VERIFICATION_OUTPUT_FILTERS_REMOVED' };
  }
  // Remove only the known terminal output filter. The runner already bounds
  // output; executing the left side directly preserves its real exit status.
  return { command: parts.prefix + match[1].trim(), changed: true, reason: 'TERMINAL_TAIL_REMOVED' };
}

export function nodeTestCommandRecipe(command, { nodePath, helperPath } = {}) {
  const parts = commandBody(command), argv = parts && words(parts.body);
  if (!argv || !['node', nodePath].includes(argv[0]) || argv[1] !== '--test' || !helperPath || !nodePath
    || /[*?\[\]{}]/u.test(command)
    || argv.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg) || /^--(?:eval|print)=/u.test(arg))) return { command, changed: false };
  return { command: parts.prefix + [nodePath, helperPath, '--', ...argv.slice(1)].map(quote).join(' '), changed: true, reason: 'NODE_TEST_DIRECTORY_COMPATIBILITY' };
}
