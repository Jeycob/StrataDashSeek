// Advisory lexical check, not a shell parser or an execution/permission check.
// The status guard trusts only simple commands, redirections, trailing separators
// and AND chains. Kind detection may retain other top-level control boundaries;
// it never turns those boundaries into an authoritative execution result.
function statusTokens(command, { preserveControlBoundaries = false } = {}) {
  const tokens = [];
  let quote = null, value = '', started = false, bare = true, rawStart = -1, dynamic = false;
  const word = () => {
    if (started) tokens.push({
      kind: 'word', value, bare, dynamic,
      assignment: /^[A-Za-z_][A-Za-z0-9_]*=/u.test(command.slice(rawStart)),
    });
    value = ''; started = false; bare = true; rawStart = -1; dynamic = false;
  };
  const variableFollows = c => c !== undefined && /[A-Za-z0-9_?@*#$!-]/u.test(c);
  for (let i = 0; i < command.length; i++) {
    const c = command[i], next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else value += c;
      continue;
    }
    if (c === '\\') {
      if (next === undefined) return null;
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) {
        value += c; continue;
      }
      if (!started && next !== '\n') rawStart = i;
      i++;
      if (next !== '\n') { value += next; started = true; bare = false; }
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '`' || c === '$' && ['(', '{'].includes(next)) return null;
      else if (preserveControlBoundaries && c === '$' && next === '[') return null;
      else { if (c === '$' && variableFollows(next)) dynamic = true; value += c; }
      continue;
    }
    if (c === "'" || c === '"') {
      if (!started) rawStart = i;
      quote = c; started = true; bare = false; continue;
    }
    if (c === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i++;
      i--; continue;
    }
    if (c === '`' || c === '$' && ['(', '{', "'", '"'].includes(next)) return null;
    if (preserveControlBoundaries && c === '$' && next === '[') return null;
    if (c === '(' || c === ')') return null;
    // Recognize redirection operators before treating their & or | as control
    // operators. A preceding unquoted number is an IO descriptor, not a word.
    if (c === '<' || c === '>' || c === '&' && next === '>') {
      if (c === '<' && next === '<') return null; // heredocs/strings need a parser
      if (started && bare && /^\d+$/u.test(value)) { value = ''; started = false; bare = true; rawStart = -1; dynamic = false; }
      else word();
      if (c === '&') { i++; if (command[i + 1] === '>') i++; }
      else if (next === c || next === '&' || c === '>' && next === '|' || c === '<' && next === '>') i++;
      tokens.push({ kind: 'redirect' }); continue;
    }
    if (c === '|') {
      if (!preserveControlBoundaries) return null;
      word();
      tokens.push({ kind: next === '|' ? 'or' : 'pipe' });
      if (next === '|' || next === '&') i++;
      continue;
    }
    if (c === '&') {
      if (next !== '&' && !preserveControlBoundaries) return null;
      word(); tokens.push({ kind: next === '&' ? 'and' : 'background' });
      if (next === '&') i++;
      continue;
    }
    if (c === ';' || c === '\n') {
      word(); tokens.push({ kind: c === ';' ? 'semicolon' : 'newline' }); continue;
    }
    // Shell token separators are space/tab, not JavaScript's wider Unicode
    // whitespace class (which could incorrectly turn a literal # into a comment).
    if (c === ' ' || c === '\t') { word(); continue; }
    if (!started) rawStart = i;
    if (c === '$' && variableFollows(next)) dynamic = true;
    value += c; started = true;
  }
  if (quote) return null;
  word();
  return tokens;
}

const unsupportedCommandWords = new Set(['!', '{', '}', '[[', ']]', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'coproc', 'time']);

const helpFlags = new Set(['--help', '-h', '--version']);
const nodeValueOptions = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C',
  '--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination',
  '--test-concurrency', '--test-timeout', '--test-shard', '--test-isolation', '--test-rerun-failures',
  '--input-type', '--unhandled-rejections', '--env-file', '--env-file-if-exists', '--max-old-space-size',
]);
const nodeFlags = new Set([
  '--no-warnings', '--trace-warnings', '--no-deprecation', '--trace-deprecation', '--trace-uncaught',
  '--enable-source-maps', '--experimental-sqlite', '--experimental-strip-types', '--no-experimental-strip-types',
  '--test-only', '--test-force-exit', '--experimental-test-coverage', '--test-update-snapshots',
  '--watch', '--watch-preserve-output', '--inspect', '--inspect-brk', '--inspect-wait',
]);

function isHelp(args, shortVersion) {
  return args.some(arg => helpFlags.has(arg) || shortVersion.includes(arg) || /^--(?:help|version)=/u.test(arg));
}

function nodeVerificationKind(args) {
  let testing = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return testing ? 'test' : null;
    // These are execution modes, not data to search for a nested verifier.
    if (/^-[ep]/u.test(arg) || /^(?:--eval|--print)(?:=|$)/u.test(arg)) return null;
    if (isHelp([arg], ['-v', '-V'])) return null;
    if (arg === '--test') { testing = true; continue; }
    const equal = arg.indexOf('='), option = equal < 0 ? arg : arg.slice(0, equal);
    if (nodeValueOptions.has(option)) {
      if (equal < 0 && ++i >= args.length) return null;
      continue;
    }
    if (nodeFlags.has(arg) || /^--inspect(?:-brk|-wait)?=/u.test(arg) || /^-r.+/u.test(arg)) continue;
    if (arg.startsWith('-') || !testing) return null;
  }
  return testing ? 'test' : null;
}

function packageVerificationKind(args) {
  if (isHelp(args, ['-v', '-V'])) return null;
  let i = 0;
  const flags = new Set(['--silent', '-s', '--quiet', '-q', '--verbose', '--no-progress', '--no-color']);
  const values = new Set(['--prefix', '--workspace', '-w', '--dir', '--cwd', '-C']);
  const skipOptions = () => {
    while (i < args.length && args[i].startsWith('-')) {
      const arg = args[i++], equal = arg.indexOf('='), option = equal < 0 ? arg : arg.slice(0, equal);
      if (flags.has(arg)) continue;
      if (!values.has(option) || equal < 0 && i++ >= args.length) return false;
    }
    return true;
  };
  if (!skipOptions()) return null;
  if (args[i] === 'run') { i++; if (!skipOptions()) return null; }
  const script = args[i];
  if (/^(?:test|check|typecheck)(?::[A-Za-z0-9_.-]+)*$/u.test(script ?? '')) return 'test';
  if (/^(?:build|lint)(?::[A-Za-z0-9_.-]+)*$/u.test(script ?? '')) return 'build';
  return null;
}

function directVerificationKind(words) {
  if (words.some(word => word.dynamic)) return null;
  const program = words[0].value.split(/[\\/]/u).at(-1).replace(/\.(?:exe|cmd)$/iu, '');
  const args = words.slice(1).map(word => word.value);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) return packageVerificationKind(args);
  if (['node', 'nodejs'].includes(program)) return nodeVerificationKind(args);
  if (program === 'pytest') return isHelp(args, ['-V']) ? null : 'test';
  if (['tsc', 'eslint'].includes(program)) return isHelp(args, ['-v', '-V']) ? null : 'build';
  if (program === 'playwright') return args[0] === 'test' && !isHelp(args, ['-V']) ? 'test' : null;
  if (program === 'cargo' && /^\+[A-Za-z0-9_.-]+$/u.test(args[0] ?? '')) args.shift();
  if (isHelp(args, program === 'cargo' ? ['-V'] : [])) return null;
  if (['cargo', 'go', 'dotnet'].includes(program)) {
    if (args[0] === 'test') return 'test';
    if (args[0] === 'build' || program === 'cargo' && args[0] === 'check') return 'build';
  }
  return null;
}

// Classifies a potential direct verifier, never its execution or success. The
// separate status guard must still reject masked/conditional command results.
export function shellVerificationKind(command) {
  if (typeof command !== 'string' || command.includes('\0')) return null;
  const tokens = statusTokens(command, { preserveControlBoundaries: true });
  if (!tokens) return null;
  const commands = [];
  let words = [], content = false, target = false, boundary = null;
  for (const token of tokens) {
    if (token.kind === 'word') {
      if (target) target = false;
      else words.push(token);
      content = true; continue;
    }
    if (token.kind === 'redirect') {
      if (target) return null;
      target = true; content = true; continue;
    }
    if (target) return null;
    if (!content) { if (token.kind === 'newline') continue; return null; }
    commands.push(words); words = []; content = false; boundary = token.kind;
  }
  if (target) return null;
  if (content) commands.push(words);
  else if (['and', 'or', 'pipe'].includes(boundary)) return null;
  let found = null;
  for (const argv of commands) {
    let i = 0;
    while (argv[i]?.assignment) i++;
    const words = argv.slice(i);
    if (!words.length) continue;
    if (words[0].bare && unsupportedCommandWords.has(words[0].value)) return null;
    const kind = directVerificationKind(words);
    if (kind === 'test' || kind === 'build' && !found) found = kind;
  }
  return found;
}

export function verificationStatusMayBeMasked(command) {
  if (typeof command !== 'string' || command.includes('\0')) return true;
  const tokens = statusTokens(command);
  if (!tokens) return true;
  let content = false, program = false, target = false, afterAnd = false, ended = false;
  for (const token of tokens) {
    if (token.kind === 'word') {
      if (ended) return true; // another standalone command after ; or newline
      if (target) { target = false; content = true; afterAnd = false; continue; }
      if (!program) {
        if (token.bare && unsupportedCommandWords.has(token.value)) return true;
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token.value)) program = true;
      }
      content = true; afterAnd = false;
    } else if (token.kind === 'redirect') {
      if (ended || target) return true;
      target = true; content = true;
    } else if (token.kind === 'and') {
      if (ended || target || !content || afterAnd) return true;
      content = false; program = false; afterAnd = true;
    } else {
      if (target) return true;
      if (afterAnd) { if (token.kind === 'newline') continue; return true; }
      if (token.kind === 'semicolon' && (!content || ended)) return true;
      if (content) ended = true;
    }
  }
  return target || afterAnd;
}
