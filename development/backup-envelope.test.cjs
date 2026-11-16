'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { encryptSnapshot, verifySnapshot, restoreIsolated } = require('./backup-envelope.cjs');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const python = process.env.HARNESS_PYTHON || process.env.HOMEAI_BACKUP_PYTHON || (process.platform === 'win32' ? 'C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1112-611-0_26.1112.611.0_x64__3k8sg7r9htsxt/dependencies/python/python.exe' : require('node:child_process').execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {encoding:'utf8'}).trim());
const capture = { version: 1, kind: 'cold-start', sourceCommit: 'a'.repeat(40), fenceWitnessHash: 'b'.repeat(64) };
function tar(entries) {
  const chunks = [];
  for (const { name, content = '', type = '0', link = '' } of entries) {
    const bytes = Buffer.from(content), h = Buffer.alloc(512); h.write(name, 0, 100); h.write('0000600\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116); h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(32, 148, 156); h.write(type, 156); h.write(link, 157, 100); h.write('ustar\0' + '00', 257); const sum = h.reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); chunks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024)); return zlib.gzipSync(Buffer.concat(chunks));
}
async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'homeai-backup-test-')); await fsp.chmod(dir, 0o700);
  t.after(async () => { const real = await fsp.realpath(dir); assert.equal(path.dirname(real), await fsp.realpath(os.tmpdir())); assert(path.basename(real).startsWith('homeai-backup-test-')); await fsp.rm(real, { recursive: true, force: true }); });
  const destination = path.join(dir, 'synthetic.haenc');
  const encrypt = (archive, extra = {}) => encryptSnapshot({ source: Readable.from(archive), sourceComplete: Promise.resolve(), destination, recipientPublicKey: keys.publicKey, assertFence: () => capture, maxBytes: 1024 * 1024, reserveBytes: 0, ...extra });
  const restore = extra => restoreIsolated({ file: destination, recipientPrivateKey: keys.privateKey, destinationParent: dir, python, maxExtractedBytes: 1024 * 1024, ...extra });
  return { dir, destination, encrypt, restore };
}
test('public-key encrypted snapshot authenticates and restores actual project/session/database data only to a new isolated directory', async t => {
  const f = await fixture(t), { DatabaseSync } = require('node:sqlite'), dbFile = path.join(f.dir, 'synthetic.sqlite'), db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE markers(id INTEGER PRIMARY KEY, text TEXT); INSERT INTO markers VALUES(1, 'RESTORE_MARKER');"); db.close();
  const source = tar([{ name: 'projects/demo/main.js', content: 'console.log("synthetic");\n' }, { name: 'sessions/example.json', content: '{"messages":["synthetic session"]}' }, { name: 'applications/demo/db.sqlite', content: fs.readFileSync(dbFile) }]);
  const result = await f.encrypt(source); assert.equal(result.encrypted, true); assert.equal(result.archiveBytes, source.length); assert.doesNotMatch(fs.readFileSync(f.destination).toString(), /synthetic session|RESTORE_MARKER/);
  const verified = await verifySnapshot({ file: f.destination, recipientPrivateKey: keys.privateKey }); assert.equal(verified.authenticated, true);
  const restored = await f.restore(); assert.equal(restored.files, 3); assert.equal(restored.liveInstalled, false); assert.equal(restored.securityStateRestored, false); assert.equal(await fsp.readFile(path.join(restored.destination, 'projects/demo/main.js'), 'utf8'), 'console.log("synthetic");\n');
  const database = new DatabaseSync(path.join(restored.destination, 'applications/demo/db.sqlite'), { readOnly: true }); assert.equal(database.prepare('SELECT text FROM markers WHERE id=1').get().text, 'RESTORE_MARKER'); database.close();
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(restored.destination, 'sessions/example.json'), 'utf8')), { messages: ['synthetic session'] });
});
test('tampering and wrong private key fail authentication before an extraction directory exists', async t => {
  const f = await fixture(t); await f.encrypt(tar([{ name: 'projects/demo/file', content: 'payload' }])); const encrypted = fs.readFileSync(f.destination); encrypted[encrypted.length - 20] ^= 1; fs.writeFileSync(f.destination, encrypted);
  await assert.rejects(f.restore()); assert.equal((await fsp.readdir(f.dir)).some(name => name.includes('restore-')), false);
  const wrong = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }); await assert.rejects(verifySnapshot({ file: f.destination, recipientPrivateKey: wrong.privateKey }));
});
test('source failure, changed fence, capacity/size limits, deadline and existing target never publish or overwrite a completed backup', async t => {
  const f = await fixture(t), source = tar([{ name: 'projects/demo/file', content: 'payload' }]);
  await assert.rejects(f.encrypt(source, { sourceComplete: Promise.reject(Error('SOURCE_FAILED')) }), /SOURCE_FAILED/);
  let calls = 0; await assert.rejects(f.encrypt(source, { assertFence: () => ++calls === 1 ? capture : { ...capture, fenceWitnessHash: 'c'.repeat(64) } }), { code: 'BACKUP_FENCE_CHANGED' });
  await assert.rejects(f.encrypt(source, { maxBytes: 1 }), { code: 'BACKUP_SIZE_LIMIT' });
  await assert.rejects(f.encrypt(source, { reserveBytes: Number.MAX_SAFE_INTEGER }), { code: 'BACKUP_CAPACITY' });
  const keepAlive = setTimeout(() => {}, 1000); try { await assert.rejects(f.encrypt(source, { sourceComplete: new Promise(() => {}), timeoutMs: 20 }), { code: 'BACKUP_TIMEOUT' }); } finally { clearTimeout(keepAlive); }
  assert.deepEqual(await fsp.readdir(f.dir), []); fs.writeFileSync(f.destination, 'PRESERVE'); await assert.rejects(f.encrypt(source)); assert.equal(fs.readFileSync(f.destination, 'utf8'), 'PRESERVE'); assert.deepEqual(await fsp.readdir(f.dir), ['synthetic.haenc']);
});
test('authenticated hostile archives cannot escape, restore security state, follow links or publish partial trees', async t => {
  const f = await fixture(t);
  for (const entries of [[{ name: '../outside', content: 'escape' }], [{ name: 'projects/demo/link', type: '2', link: '../../../outside' }], [{ name: 'workbench/revocations.json', content: '{}' }], [{ name: 'projects/demo/data', content: 'large'.repeat(100) }], [{ name: 'projects/demo/FILE', content: 'a' }, { name: 'projects/demo/file', content: 'b' }], [{ name: 'projects/pax', type: 'x', content: 'A'.repeat(2 * 1024 ** 2) }]]) {
    await f.encrypt(tar(entries)); await assert.rejects(f.restore({ maxExtractedBytes: 100 })); assert.equal((await fsp.readdir(f.dir)).some(name => name.includes('restore-')), false); await fsp.unlink(f.destination);
  }
});
test('implicit and explicit parent aliases fail before publication on every platform, while identical parents preserve separate files', async t => {
  const f = await fixture(t);
  for (const entries of [
    [{ name: 'projects/demo/Config/one.txt', content: 'one' }, { name: 'projects/demo/config/two.txt', content: 'two' }],
    [{ name: 'projects/Demo/a/one.txt', content: 'one' }, { name: 'projects/demo/b/two.txt', content: 'two' }],
    [{ name: 'projects/demo/Config/one.txt', content: 'one' }, { name: 'projects/demo/config', type: '5' }],
    [{ name: 'projects/demo/Config', type: '5' }, { name: 'projects/demo/config/two.txt', content: 'two' }],
  ]) {
    await f.encrypt(tar(entries)); await assert.rejects(f.restore());
    assert.equal((await fsp.readdir(f.dir)).some(name => name.includes('restore-')), false); await fsp.unlink(f.destination);
  }
  await f.encrypt(tar([{ name: 'projects/demo/Config/one.txt', content: 'one' }, { name: 'projects/demo/Config', type: '5' }, { name: 'projects/demo/Config/two.txt', content: 'two' }]));
  const restored = await f.restore(); assert.equal(restored.files, 2);
  assert.equal(await fsp.readFile(path.join(restored.destination, 'projects/demo/Config/one.txt'), 'utf8'), 'one');
  assert.equal(await fsp.readFile(path.join(restored.destination, 'projects/demo/Config/two.txt'), 'utf8'), 'two');
});
