'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { writeArchive } = require('./apps-resource-archive.cjs');
async function fixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-archive-')), server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  return { file: path.join(directory, 'owned.tar'), engine: { connection: { hostname: '127.0.0.1', port: server.address().port } } };
}
test('bounded archive stream writes complete content and hash without retaining whole export in memory', async t => {
  const data = Buffer.alloc(64000, 9), f = await fixture(t, (_req, res) => res.end(data));
  const result = await writeArchive(f.engine, '/synthetic', f.file, { maxBytes: 100000, reserveBytes: 0 });
  assert.equal(result.bytes, data.length); assert.equal(result.sha256.length, 64); assert.deepEqual(await fs.readFile(f.file), data);
});
test('oversized/failed/interrupted exports leave no downloadable partial and preserve a preexisting file', async t => {
  const f = await fixture(t, (req, res) => req.url === '/bad' ? res.writeHead(500).end('private error') : res.end(Buffer.alloc(20000)));
  for (const route of ['/large', '/bad']) { await assert.rejects(writeArchive(f.engine, route, f.file, { maxBytes: 1000, reserveBytes: 0 })); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' }); }
  await fs.writeFile(f.file, 'preexisting'); await assert.rejects(writeArchive(f.engine, '/large', f.file, { maxBytes: 1000, reserveBytes: 0 }), { code: 'EEXIST' }); assert.equal(await fs.readFile(f.file, 'utf8'), 'preexisting');
});
test('absolute export deadline terminates stalled stream and removes its file', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200); res.write('partial'); });
  await assert.rejects(writeArchive(f.engine, '/stall', f.file, { maxBytes: 1000, reserveBytes: 0, timeoutMs: 40 })); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});
