'use strict';
// Trusted operator primitive. The caller owns a continuous writer-exclusion
// fence; this module never infers quiescence from an activity sample.
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const { Transform, Writable } = require('node:stream'), { pipeline } = require('node:stream/promises');
const MAGIC = Buffer.from('HOMEAIB2'), MAX = 2 * 1024 ** 3;
const fail = code => Object.assign(Error(code), { code });
const fingerprint = key => crypto.createHash('sha256').update((key?.type === 'public' ? key : crypto.createPublicKey(key)).export({ format: 'der', type: 'spki' })).digest('hex');
function publicKey(value) { const key = value?.type === 'public' ? value : crypto.createPublicKey(value); if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072) throw fail('BACKUP_KEY_INVALID'); return key; }
function proof(value) { if (!value || value.version !== 1 || value.kind !== 'cold-start' || !/^[a-f0-9]{40}$/.test(value.sourceCommit || '') || !/^[a-f0-9]{64}$/.test(value.fenceWitnessHash || '')) throw fail('BACKUP_FENCE_REQUIRED'); return { version: 1, kind: value.kind, sourceCommit: value.sourceCommit, fenceWitnessHash: value.fenceWitnessHash }; }
async function privateDirectory(directory) { const resolved = path.resolve(directory), stat = await fsp.lstat(resolved); if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(resolved) !== resolved || process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw fail('BACKUP_DIRECTORY_UNSAFE'); return resolved; }
function bounded(controller, timeoutMs) { if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60000) throw fail('BACKUP_DEADLINE_INVALID'); const timer = setTimeout(() => controller.abort(fail('BACKUP_TIMEOUT')), timeoutMs); timer.unref(); return () => clearTimeout(timer); }
async function abortable(promise, signal) { signal.throwIfAborted(); let abort; try { return await Promise.race([promise, new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })]); } finally { if (abort) signal.removeEventListener('abort', abort); } }
async function encryptSnapshot({ source, sourceComplete, destination, recipientPublicKey, assertFence, maxBytes = MAX, reserveBytes = 256 * 1024 ** 2, timeoutMs = 300000, signal }) {
  if (typeof assertFence !== 'function' || !sourceComplete?.then || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX || !Number.isSafeInteger(reserveBytes) || reserveBytes < 0) throw fail('BACKUP_CAPTURE_CONTRACT_REQUIRED');
  // Observe early source failures while the stream drains; still require its
  // successful exit before any completed archive can be published.
  const completion = Promise.resolve(sourceComplete); completion.catch(() => {});
  // Fence checks are synchronous kernel/controller assertions, not network
  // polling or a promise that could silently outlive the capture deadline.
  const capture = proof(assertFence()), key = publicKey(recipientPublicKey), parent = await privateDirectory(path.dirname(destination));
  if (path.resolve(destination) !== path.join(parent, path.basename(destination)) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.haenc$/.test(path.basename(destination))) throw fail('BACKUP_DESTINATION_INVALID');
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, clear = bounded(controller, timeoutMs), secret = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({ version: 2, algorithm: 'RSA-OAEP-SHA256+AES-256-GCM', createdAt: new Date().toISOString(), recipient: fingerprint(key), capture, iv: iv.toString('base64url'), encryptedKey: crypto.publicEncrypt({ key, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, secret).toString('base64url') }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length); const prefix = Buffer.concat([MAGIC, length, header]), cipher = crypto.createCipheriv('aes-256-gcm', secret, iv); cipher.setAAD(prefix); secret.fill(0);
  const temporary = destination + '.partial-' + crypto.randomBytes(8).toString('hex'), hash = crypto.createHash('sha256'); let archiveBytes = 0, output, published = false, owned = false;
  try {
    combined.throwIfAborted(); const capacity = await fsp.statfs(parent); if (capacity.bavail * capacity.bsize < reserveBytes + maxBytes + 8192) throw fail('BACKUP_CAPACITY');
    const descriptor = fs.openSync(temporary, 'wx', 0o600); owned = true;
    output = fs.createWriteStream(null, { fd: descriptor, autoClose: true }); output.on('error', () => {}); hash.update(prefix); output.write(prefix);
    let nextCheck = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) { archiveBytes += chunk.length; if (archiveBytes > maxBytes) return done(fail('BACKUP_SIZE_LIMIT')); if (archiveBytes < nextCheck) return done(null, chunk); nextCheck = archiveBytes + 8 * 1024 ** 2; fsp.statfs(parent).then(s => done(s.bavail * s.bsize < reserveBytes + chunk.length ? fail('BACKUP_CAPACITY') : null, chunk), done); } });
    const hashed = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } });
    await pipeline(source, limit, cipher, hashed, output, { signal: combined }); await abortable(completion, combined); combined.throwIfAborted();
    if (!archiveBytes || JSON.stringify(proof(assertFence())) !== JSON.stringify(capture)) throw fail('BACKUP_FENCE_CHANGED');
    const tag = cipher.getAuthTag(); hash.update(tag); const handle = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0));
    try { await handle.write(tag); await handle.sync(); } finally { await handle.close(); }
    // link refuses an existing destination on POSIX and Windows. A partial
    // transfer can never replace an older verified archive.
    await fsp.link(temporary, destination); published = true; await fsp.unlink(temporary);
    if (process.platform !== 'win32') { const directory = await fsp.open(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { await directory.sync(); } finally { await directory.close(); } }
    return { version: 2, encrypted: true, algorithm: 'RSA-OAEP-SHA256+AES-256-GCM', createdAt: JSON.parse(header).createdAt, recipient: fingerprint(key), archiveBytes, bytes: prefix.length + archiveBytes + 16, sha256: hash.digest('hex'), capture };
  } catch (error) { output?.destroy(); if (output && !output.closed) await new Promise(resolve => output.once('close', resolve)); if (owned && !published) await fsp.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); throw error; }
  finally { clear(); }
}
function openEnvelope(file, recipientPrivateKey, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX) throw fail('BACKUP_SIZE_LIMIT_INVALID');
  const key = recipientPrivateKey?.type === 'private' ? recipientPrivateKey : crypto.createPrivateKey(recipientPrivateKey); publicKey(key);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size < 29 || stat.size > maxBytes + 8192) throw fail('BACKUP_FILE_INVALID');
    const lead = Buffer.alloc(12); if (fs.readSync(fd, lead, 0, lead.length, 0) !== lead.length || !lead.subarray(0, 8).equals(MAGIC)) throw fail('BACKUP_FORMAT_INVALID');
    const headerSize = lead.readUInt32BE(8); if (headerSize < 1 || headerSize > 4096 || 12 + headerSize + 16 >= stat.size) throw fail('BACKUP_HEADER_INVALID');
    const body = Buffer.alloc(headerSize); if (fs.readSync(fd, body, 0, body.length, 12) !== body.length) throw fail('BACKUP_HEADER_INVALID');
    const header = JSON.parse(body), iv = Buffer.from(header.iv || '', 'base64url'); proof(header.capture);
    if (header.version !== 2 || header.algorithm !== 'RSA-OAEP-SHA256+AES-256-GCM' || header.recipient !== fingerprint(key) || iv.length !== 12) throw fail('BACKUP_HEADER_INVALID');
    const secret = crypto.privateDecrypt({ key, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(header.encryptedKey || '', 'base64url'));
    if (secret.length !== 32) throw fail('BACKUP_KEY_INVALID'); const tag = Buffer.alloc(16); fs.readSync(fd, tag, 0, tag.length, stat.size - 16);
    return { fd, stat, header, secret, iv, tag, prefix: Buffer.concat([lead, body]), start: 12 + headerSize, end: stat.size - 17 };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function decoder(envelope) { const decipher = crypto.createDecipheriv('aes-256-gcm', envelope.secret, envelope.iv); decipher.setAAD(envelope.prefix); decipher.setAuthTag(envelope.tag); return decipher; }
function read(envelope) { return fs.createReadStream(null, { fd: envelope.fd, autoClose: false, start: envelope.start, end: envelope.end }); }
async function authenticate(envelope, signal) { const digest = crypto.createHash('sha256'); let bytes = 0; await pipeline(read(envelope), decoder(envelope), new Writable({ write(chunk, _encoding, done) { digest.update(chunk); bytes += chunk.length; done(); } }), { signal }); return { archiveBytes: bytes, archiveSHA256: digest.digest('hex') }; }
async function verifySnapshot({ file, recipientPrivateKey, maxBytes = MAX, timeoutMs = 300000, signal }) {
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, clear = bounded(controller, timeoutMs); let envelope;
  try { envelope = openEnvelope(file, recipientPrivateKey, maxBytes); return { version: 2, authenticated: true, recipient: envelope.header.recipient, capture: envelope.header.capture, ...await authenticate(envelope, combined) }; }
  finally { clear(); if (envelope) { envelope.secret.fill(0); fs.closeSync(envelope.fd); } }
}
async function restoreIsolated({ file, recipientPrivateKey, destinationParent, python, maxBytes = MAX, maxExtractedBytes = 8 * 1024 ** 3, timeoutMs = 300000, signal }) {
  if (!path.isAbsolute(python || '') || !Number.isSafeInteger(maxExtractedBytes) || maxExtractedBytes < 1 || maxExtractedBytes > 8 * 1024 ** 3) throw fail('BACKUP_RESTORE_CONFIGURATION_INVALID');
  const parent = await privateDirectory(destinationParent), controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, clear = bounded(controller, timeoutMs);
  let envelope, stage, child, committed = false;
  try {
    envelope = openEnvelope(file, recipientPrivateKey, maxBytes); const verified = await authenticate(envelope, combined); combined.throwIfAborted();
    const capacity = await fsp.statfs(parent); if (capacity.bavail * capacity.bsize < maxExtractedBytes + 256 * 1024 ** 2) throw fail('BACKUP_RESTORE_CAPACITY');
    stage = await fsp.mkdtemp(path.join(parent, '.homeai-restore-')); await fsp.chmod(stage, 0o700);
    // The extractor only writes under this new empty directory. No live restore
    // destination exists in this API. It rejects links, devices and security state.
    child = cp.spawn(python, [path.join(__dirname, 'backup-extract.py'), stage, String(maxExtractedBytes)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: combined });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 4096) child.kill(); }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(fail('BACKUP_EXTRACTION_FAILED'))); }); ended.catch(() => {});
    const digest = crypto.createHash('sha256'), hashed = new Transform({ transform(chunk, _encoding, done) { digest.update(chunk); done(null, chunk); } });
    await pipeline(read(envelope), decoder(envelope), hashed, child.stdin, { signal: combined }); await ended;
    if (digest.digest('hex') !== verified.archiveSHA256 || fs.fstatSync(envelope.fd).size !== envelope.stat.size) throw fail('BACKUP_CHANGED_DURING_RESTORE');
    const extracted = JSON.parse(stdout); if (extracted.version !== 1 || extracted.complete !== true) throw fail('BACKUP_EXTRACTION_UNPROVEN');
    const destination = path.join(parent, 'restored-' + crypto.randomBytes(16).toString('hex')); await fsp.rename(stage, destination); committed = true;
    return { ...verified, authenticated: true, isolated: true, destination, files: extracted.files, extractedBytes: extracted.bytes, liveInstalled: false, securityStateRestored: false };
  } finally {
    clear(); if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 2000); child.once('close', () => { clearTimeout(timer); resolve(); }); }); }
    if (envelope) { envelope.secret.fill(0); fs.closeSync(envelope.fd); }
    if (stage && !committed) { const real = await fsp.realpath(stage); if (path.dirname(real) !== parent || !path.basename(real).startsWith('.homeai-restore-')) throw fail('BACKUP_CLEANUP_REFUSED'); await fsp.rm(real, { recursive: true, force: true }); }
  }
}
module.exports = { encryptSnapshot, verifySnapshot, restoreIsolated, fingerprint };
