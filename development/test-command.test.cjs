'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises');
const path = require('node:path'), os = require('node:os'), { execFile } = require('node:child_process');
const { normalizeNodeTestArgs } = require('./test-command.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'node-test-command-')), root = path.join(directory, 'project');
  await fs.mkdir(root);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'node-test-command-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function write(name, content = '') { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file; }
  const normalize = (argv, options = {}) => normalizeNodeTestArgs(argv, { cwd: root, projectRoot: root, ...options });
  async function run(argv) {
    const env = { ...process.env, DSH_PROJECT_ROOT: root }; delete env.NODE_TEST_CONTEXT;
    return new Promise((resolve, reject) => execFile(process.execPath, [path.join(__dirname, 'test-command.cjs'), '--', ...argv],
      { cwd: root, env, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') reject(error);
        else resolve({ code: error?.code ?? 0, stdout, stderr });
      }));
  }
  return { directory, root, write, normalize, run };
}

test('Node --test directory discovery is deterministic, recursive, bounded and excludes dependencies', async t => {
  const f = await fixture(t);
  const a = await f.write('test/a.mjs'), b = await f.write('test/nested/b.cjs');
  await f.write('test/readme.md'); await f.write('test/node_modules/pkg/excluded.js'); await f.write('test/.git/excluded.js');
  const result = await f.normalize(['--test', '--test-timeout', '6000', 'test/']);
  assert.equal(result.changed, true); assert.equal(result.expandedDirectories, 1);
  assert.deepEqual(result.argv, ['--test', '--test-timeout', '6000', a, b]);
  assert.equal((await fs.readdir(f.root)).includes('.harness'), false);
});

test('outside test/ only Node default test names match, while options retain their value operands', async t => {
  const f = await fixture(t);
  const first = await f.write('tests/one.test.js'), second = await f.write('tests/test-two.ts');
  await f.write('tests/helper.js'); await f.write('tests/types.d.ts'); await f.write('tests/readme.txt');
  const result = await f.normalize(['--test', '--test-name-pattern', 'tests/', '--test-reporter=tap', 'tests/']);
  assert.deepEqual(result.argv, ['--test', '--test-name-pattern', 'tests/', '--test-reporter=tap', first, second]);
  const withoutTypes = await f.normalize(['--test', '--no-strip-types', 'tests/']);
  assert.deepEqual(withoutTypes.argv, ['--test', '--no-strip-types', first]);
});

test('ordinary Node programs, eval, explicit files, globs and unknown CLI options remain untouched', async t => {
  const f = await fixture(t); await f.write('test/a.mjs');
  for (const argv of [['server.js', 'test/'], ['server.js', '--test', 'test/'], ['--test-name-pattern', '--test', 'test/'], ['--eval', 'code()', '--test', 'test/'], ['--test', 'test/a.mjs'],
    ['--test', 'test/*.mjs'], ['--test', '--future-option', 'test/'], ['--test'], ['--test', '--test-timeout']]) {
    const result = await f.normalize(argv); assert.equal(result.changed, false); assert.deepEqual(result.argv, argv);
  }
});

test('empty directories and discovery limits are errors instead of zero-test success or partial test selection', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'empty'));
  await assert.rejects(f.normalize(['--test', 'empty/']), { code: 'NODE_TEST_NO_FILES' });
  await f.write('test/a.js'); await f.write('test/b.js');
  await assert.rejects(f.normalize(['--test', 'test/'], { maxFiles: 1 }), { code: 'NODE_TEST_DISCOVERY_LIMIT' });
  await assert.rejects(f.normalize(['--test', 'test/'], { maxVisited: 1 }), { code: 'NODE_TEST_DISCOVERY_LIMIT' });
  await assert.rejects(f.normalize(['--test', 'test/'], { maxArgBytes: 4 }), { code: 'NODE_TEST_DISCOVERY_LIMIT' });
});

test('test selection rejects outside roots and symbolic links without following them', async t => {
  const f = await fixture(t), outside = path.join(f.directory, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'external.test.js'), 'throw Error("must not execute")');
  await assert.rejects(f.normalize(['--test', '../outside/']), { code: 'NODE_TEST_OUTSIDE_PROJECT' });
  await fs.symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.normalize(['--test', 'linked/']), { code: 'NODE_TEST_SYMLINK' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.normalize(['--test', 'linked/'], { signal: controller.signal }), { name: 'AbortError' });
});

test('real Node 24 CLI executes discovered tests and preserves failing exit status', async t => {
  const f = await fixture(t);
  await f.write('test/ok.mjs', "import test from 'node:test'; test('real pass',()=>{});\n");
  const passed = await f.run(['--test', '--test-reporter=tap', 'test/']);
  assert.equal(passed.code, 0, passed.stderr); assert.match(passed.stdout, /# tests 1/); assert.match(passed.stdout, /# pass 1/);
  assert.match(passed.stderr, /expanded 1 Node test directory/);
  await f.write('test/fail.mjs', "import test from 'node:test'; import assert from 'node:assert/strict'; test('real failure',()=>assert.equal(1,2));\n");
  const failed = await f.run(['--test', '--test-reporter=tap', 'test/']);
  assert.equal(failed.code, 1); assert.match(failed.stdout, /# fail 1/); assert.match(failed.stdout, /ERR_ASSERTION/);
});

test('real CLI refuses zero-file expansion and never injects force-exit into argv', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'empty'));
  const result = await f.run(['--test', 'empty/']);
  assert.equal(result.code, 2); assert.match(result.stderr, /NODE_TEST_NO_FILES/);
  await f.write('test/a.js'); const args = await f.normalize(['--test', 'test/']);
  assert.equal(args.argv.includes('--test-force-exit'), false);
});
