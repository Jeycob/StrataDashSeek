'use strict';
// Node 24 test-directory compatibility. No monkeypatches, project edits or
// source evaluation: normalize literal argv, then run the original Node binary.
const fs = require('node:fs/promises'), path = require('node:path'), cp = require('node:child_process');
const SKIP = new Set(['node_modules', '.git', '.harness', '.codex', '.agents']);
const FLAGS = new Set(['--test', '--test-only', '--test-force-exit', '--enable-source-maps', '--no-warnings',
  '--experimental-test-coverage', '--experimental-strip-types', '--no-experimental-strip-types', '--no-strip-types']);
const VALUES = new Set(['--test-timeout', '--test-concurrency', '--test-name-pattern', '--test-skip-pattern', '--test-shard',
  '--test-reporter', '--test-reporter-destination', '--test-coverage-include', '--test-coverage-exclude',
  '--test-coverage-lines', '--test-coverage-functions', '--test-coverage-branches', '--test-rerun-failures',
  '--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions', '-C', '--env-file']);
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
function failure(code, message) { const error = new Error(message); error.code = code; return error; }

async function normalizeNodeTestArgs(argv, { cwd = process.cwd(), projectRoot = process.env.DSH_PROJECT_ROOT ?? cwd,
  signal, maxFiles = 2000, maxVisited = 20000, maxArgBytes = 128 * 1024 } = {}) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new TypeError('Node arguments must be strings');
  if (![maxFiles, maxVisited, maxArgBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError('Invalid discovery limits');
  signal?.throwIfAborted();
  const unchanged = () => ({ argv: [...argv], changed: false, expandedDirectories: 0 });
  if (!argv.includes('--test') || argv.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg) || /^--(?:eval|print)=/u.test(arg))) return unchanged();
  const operands = new Set(); let positionalOnly = false, hasTestFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && arg.startsWith('-')) {
      if (FLAGS.has(arg)) { if (arg === '--test') hasTestFlag = true; continue; }
      if (VALUES.has(arg)) { if (++i >= argv.length) return unchanged(); continue; }
      if (arg.includes('=') && VALUES.has(arg.slice(0, arg.indexOf('=')))) continue;
      // Unknown options can consume values. Do not guess which token is a path.
      return unchanged();
    }
    // After a script operand, --test belongs to the user's program rather
    // than Node. Its arguments must not be reinterpreted as test selection.
    if (!hasTestFlag) return unchanged();
    operands.add(i);
  }
  if (!hasTestFlag) return unchanged();
  const root = await fs.realpath(projectRoot), base = await fs.realpath(cwd);
  if (!inside(root, base)) throw failure('NODE_TEST_OUTSIDE_PROJECT', 'Test working directory is outside the project');
  const output = []; let expandedDirectories = 0, visited = 0, discovered = 0;
  const types = !argv.some(arg => ['--no-strip-types', '--no-experimental-strip-types'].includes(arg));
  const extension = types ? /\.(?:[cm]?js|[cm]?ts)$/u : /\.[cm]?js$/u;
  const matches = (relative, parentIsTest) => {
    const name = path.basename(relative);
    return extension.test(name) && !/\.d\.[cm]?ts$/u.test(name) && (parentIsTest || /^(?:test(?:\.|-)|.*[._-]test\.)/u.test(name));
  };
  async function checkedDirectory(directory) {
    const relative = path.relative(root, directory);
    if (!inside(root, directory)) throw failure('NODE_TEST_OUTSIDE_PROJECT', 'Test directory is outside the project');
    let at = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      at = path.join(at, part);
      const stat = await fs.lstat(at);
      if (stat.isSymbolicLink()) throw failure('NODE_TEST_SYMLINK', 'Test discovery does not follow symbolic links');
    }
    if (!inside(root, await fs.realpath(directory))) throw failure('NODE_TEST_OUTSIDE_PROJECT', 'Test directory is outside the project');
  }
  async function walk(directory, inTest, selected, depth = 0) {
    signal?.throwIfAborted();
    if (depth > 32) throw failure('NODE_TEST_DISCOVERY_LIMIT', 'Test directory nesting exceeds the discovery limit');
    await checkedDirectory(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true }); entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (++visited > maxVisited) throw failure('NODE_TEST_DISCOVERY_LIMIT', 'Test directory scan exceeds the discovery limit');
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, inTest || entry.name === 'test', selected, depth + 1);
      else if (entry.isFile() && matches(file, inTest)) {
        if (++discovered > maxFiles) throw failure('NODE_TEST_DISCOVERY_LIMIT', 'Too many test files; choose a narrower test directory');
        selected.push(file);
      }
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!operands.has(i) || /[*?\[\]{}]/u.test(arg)) { output.push(arg); continue; }
    const candidate = path.resolve(base, arg);
    const stat = await fs.lstat(candidate).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error; });
    if (stat?.isSymbolicLink()) throw failure('NODE_TEST_SYMLINK', 'Test discovery does not follow symbolic links');
    if (!stat?.isDirectory()) { output.push(arg); continue; }
    const selected = [];
    await walk(candidate, path.relative(root, candidate).split(path.sep).includes('test') || path.basename(candidate) === 'test', selected);
    if (!selected.length) throw failure('NODE_TEST_NO_FILES', 'No runnable Node test files were found in the requested directory');
    // Absolute operands cannot be mistaken for options even if a filename starts '-'.
    output.push(...selected); expandedDirectories++;
  }
  if (Buffer.byteLength(output.join('\0')) > maxArgBytes) throw failure('NODE_TEST_DISCOVERY_LIMIT', 'Expanded test arguments exceed the limit');
  return { argv: output, changed: expandedDirectories > 0, expandedDirectories };
}

module.exports = { normalizeNodeTestArgs };
if (require.main === module) {
  const argv = process.argv.slice(2); if (argv[0] === '--') argv.shift();
  normalizeNodeTestArgs(argv).then(result => {
    if (result.changed) process.stderr.write('[Harness: expanded ' + result.expandedDirectories + ' Node test directory operand(s); test exit status is preserved]\n');
    const child = cp.spawn(process.execPath, result.argv, { stdio: 'inherit', env: process.env, windowsHide: true });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { process.stderr.write('Node test launch failed: ' + error.message + '\n'); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
  }).catch(error => { process.stderr.write('[' + (error.code ?? 'NODE_TEST_INVOCATION') + '] ' + error.message + '\n'); process.exitCode = 2; });
}
