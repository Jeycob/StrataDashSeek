// Advisory lexical check, not a shell parser or an execution/permission check.
// Only simple commands, redirections, trailing separators and AND chains are
// accepted. Unsupported constructs deliberately keep their status untrusted.
function statusTokens(command) {
  const tokens = [];
  let quote = null, value = '', started = false, bare = true;
  const word = () => {
    if (started) tokens.push({ kind: 'word', value, bare });
    value = ''; started = false; bare = true;
  };
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
      i++;
      if (next !== '\n') { value += next; started = true; bare = false; }
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '`' || c === '$' && ['(', '{'].includes(next)) return null;
      else value += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c; started = true; bare = false; continue;
    }
    if (c === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i++;
      i--; continue;
    }
    if (c === '`' || c === '$' && ['(', '{', "'", '"'].includes(next)) return null;
    if (c === '(' || c === ')') return null;
    // Recognize redirection operators before treating their & or | as control
    // operators. A preceding unquoted number is an IO descriptor, not a word.
    if (c === '<' || c === '>' || c === '&' && next === '>') {
      if (c === '<' && next === '<') return null; // heredocs/strings need a parser
      if (started && bare && /^\d+$/u.test(value)) { value = ''; started = false; bare = true; }
      else word();
      if (c === '&') { i++; if (command[i + 1] === '>') i++; }
      else if (next === c || next === '&' || c === '>' && next === '|' || c === '<' && next === '>') i++;
      tokens.push({ kind: 'redirect' }); continue;
    }
    if (c === '|') return null;
    if (c === '&') {
      if (next !== '&') return null;
      word(); tokens.push({ kind: 'and' }); i++; continue;
    }
    if (c === ';' || c === '\n') {
      word(); tokens.push({ kind: c === ';' ? 'semicolon' : 'newline' }); continue;
    }
    // Shell token separators are space/tab, not JavaScript's wider Unicode
    // whitespace class (which could incorrectly turn a literal # into a comment).
    if (c === ' ' || c === '\t') { word(); continue; }
    value += c; started = true;
  }
  if (quote) return null;
  word();
  return tokens;
}

const unsupportedCommandWords = new Set(['!', '{', '}', '[[', ']]', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'coproc', 'time']);

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
