'use strict';
const fs = require('node:fs'), fsp = require('node:fs/promises'), http = require('node:http'), crypto = require('node:crypto');
const { Transform } = require('node:stream'), { pipeline } = require('node:stream/promises');
const fail = code => Object.assign(Error(code), { code, status: 409 });
async function writeArchive(engine, route, file, { maxBytes = 512 * 1024 ** 2, reserveBytes = 2 * 1024 ** 3, timeoutMs = 120000, signal } = {}) {
  if (![maxBytes, reserveBytes, timeoutMs].every(Number.isSafeInteger) || maxBytes < 1 || maxBytes > 2 * 1024 ** 3 || reserveBytes < 0 || timeoutMs < 1 || timeoutMs > 300000) throw fail('RESOURCE_EXPORT_LIMIT_INVALID');
  const controller = new AbortController(), abort = () => controller.abort(signal.reason);
  signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(fail('RESOURCE_EXPORT_TIMEOUT')), timeoutMs); timer.unref?.();
  let output, ownedFile = false, bytes = 0, nextCapacityCheck = 0; const digest = crypto.createHash('sha256');
  try {
    const capacity = await fsp.statfs(require('node:path').dirname(file));
    if (capacity.bavail * capacity.bsize < reserveBytes + maxBytes) throw fail('RESOURCE_EXPORT_CAPACITY');
    const descriptor = fs.openSync(file, 'wx', 0o600);
    ownedFile = true;
    output = fs.createWriteStream(null, { fd: descriptor, autoClose: true });
    output.on('error', () => {}); // pipeline observes errors after source admission.
    const response = await new Promise((resolve, reject) => {
      const request = http.get({ ...engine.connection, path: route, signal: controller.signal }, res => {
        if (res.statusCode !== 200) { res.destroy(); reject(fail('RESOURCE_EXPORT_SOURCE_FAILED')); return; }
        resolve(res);
      }); request.on('error', reject);
    });
    const limit = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(fail('RESOURCE_EXPORT_SIZE_LIMIT'));
      const accept = () => { digest.update(chunk); done(null, chunk); };
      if (bytes >= nextCapacityCheck) {
        nextCapacityCheck = bytes + 8 * 1024 ** 2;
        fsp.statfs(require('node:path').dirname(file)).then(s => s.bavail * s.bsize >= reserveBytes + chunk.length ? accept() : done(fail('RESOURCE_EXPORT_CAPACITY')), done);
      } else accept();
    } });
    await pipeline(response, limit, output, { signal: controller.signal });
    if (!bytes) throw fail('RESOURCE_EXPORT_EMPTY');
    const handle = await fsp.open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    return { bytes, sha256: digest.digest('hex') };
  } catch (e) {
    output?.destroy(); if (output && !output.closed) await new Promise(resolve => output.once('close', resolve));
    if (ownedFile) await fsp.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    throw e;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
module.exports = { writeArchive };
