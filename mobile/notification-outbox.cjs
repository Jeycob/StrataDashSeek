'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const fail = (status, code) => Object.assign(new Error(code), {status, code});
const id = /^[A-Za-z0-9_.:-]{1,180}$/, device = /^[A-Za-z0-9_-]{1,80}$/;

class NotificationOutbox {
  constructor(file, {send, now = Date.now, random = Math.random, ttlMs = 300000, retentionMs = 86400000, maxEvents = 2048, maxAttempts = 5, retryBaseMs = 1000, retryMaxMs = 60000, leaseMs = 30000, sendTimeoutMs = 10000, minFreeBytes = 2 * 1024 ** 3} = {}) {
    if (typeof send !== 'function' || typeof now !== 'function' || typeof random !== 'function' ||
      ![ttlMs, retentionMs, maxEvents, maxAttempts, retryBaseMs, retryMaxMs, leaseMs, sendTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0) ||
      ttlMs > 86400000 || retentionMs < ttlMs || retentionMs > 7 * 86400000 || maxEvents > 10000 || maxAttempts > 10 || leaseMs <= sendTimeoutMs || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) throw new TypeError('Invalid outbox policy');
    Object.assign(this, {file: path.resolve(file), send, now, random, ttlMs, retentionMs, maxEvents, maxAttempts, retryBaseMs, retryMaxMs, leaseMs, sendTimeoutMs, minFreeBytes, active: null, timer: null, closed: false});
    const parent = path.dirname(this.file); fs.mkdirSync(parent, {recursive: true, mode: 0o700});
    const directory = fs.lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' && (directory.uid !== process.getuid() || directory.mode & 0o077)) throw fail(503, 'OUTBOX_UNSAFE_PARENT');
    // SQLite may inspect/recover sidecars during its first read. Reject aliases
    // and foreign/private-mode violations before opening the database at all.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {const info = fs.lstatSync(this.file + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077)) throw fail(503, 'OUTBOX_UNSAFE_FILE');} catch (error) {if (error.code !== 'ENOENT') throw error;}
    }
    this.capacity();
    // Set the initial database mode before SQLite derives sidecar permissions.
    try {const descriptor=fs.openSync(this.file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);fs.closeSync(descriptor);} catch(error){if(error.code!=='EEXIST')throw error;}
    let db;
    try {
      db = new DatabaseSync(this.file); db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      const identity = db.prepare('PRAGMA application_id').get().application_id, version = db.prepare('PRAGMA user_version').get().user_version;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (identity !== 0x484e4f42 && (identity !== 0 || version !== 0 || tables.length) || identity === 0x484e4f42 && version !== 1) throw fail(503, 'OUTBOX_STORE_INVALID');
      if (db.prepare('PRAGMA journal_mode=WAL').get().journal_mode !== 'wal') throw fail(503, 'OUTBOX_DURABILITY_UNAVAILABLE');
      db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,category TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,forget_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries(event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,device_id TEXT NOT NULL,phase TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,lease_until INTEGER,lease_token TEXT,provider_status INTEGER,code TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(event_id,device_id));
        CREATE INDEX IF NOT EXISTS due_deliveries ON deliveries(phase,next_at,lease_until);
        CREATE TABLE IF NOT EXISTS retired_devices(device_id TEXT PRIMARY KEY,at INTEGER NOT NULL,code TEXT NOT NULL);
        PRAGMA application_id=0x484e4f42; PRAGMA user_version=1; COMMIT;`);
      fs.chmodSync(this.file, 0o600); this.db = db;
    } catch (error) {db?.close(); throw error;}
  }
  capacity() {const s = fs.statfsSync(path.dirname(this.file)); if (Number(s.bavail) * Number(s.bsize) < this.minFreeBytes + 1024 * 1024) throw fail(507, 'OUTBOX_CAPACITY');}
  transaction(fn) {
    if (this.closed) throw fail(503, 'OUTBOX_CLOSED');
    this.db.exec('BEGIN IMMEDIATE');
    try {const result = fn(); this.db.exec('COMMIT'); return result;} catch (error) {try {this.db.exec('ROLLBACK');} catch {} throw error;}
  }
  enqueue(category, eventId, devices, {occurredAt = this.now(), notBeforeAt = this.now()} = {}) {
    if (!['done', 'attention', 'error', 'test'].includes(category) || typeof eventId !== 'string' || !id.test(eventId) || !Array.isArray(devices) || devices.length > 50 || devices.some(value => typeof value !== 'string' || !device.test(value)) || !Number.isSafeInteger(occurredAt) || !Number.isSafeInteger(notBeforeAt)) throw fail(400, 'INVALID_NOTIFICATION_EVENT');
    if (this.closed) throw fail(503, 'OUTBOX_CLOSED');
    const known = this.db.prepare('SELECT category FROM events WHERE id=?').get(eventId);
    if (known) {if (known.category !== category) throw fail(409, 'NOTIFICATION_ID_CONFLICT'); return {persisted: true, duplicate: true, eventId, queuedTargets: this.db.prepare("SELECT count(*) AS n FROM deliveries WHERE event_id=? AND phase IN ('pending','attempting')").get(eventId).n};}
    this.capacity(); const now = this.now();
    return this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE forget_at<=? AND expires_at<=?').run(now, now);
      const existing = this.db.prepare('SELECT category FROM events WHERE id=?').get(eventId);
      if (existing) {if (existing.category !== category) throw fail(409, 'NOTIFICATION_ID_CONFLICT'); return {persisted: true, duplicate: true, eventId, queuedTargets: this.db.prepare("SELECT count(*) AS n FROM deliveries WHERE event_id=? AND phase IN ('pending','attempting')").get(eventId).n};}
      if (this.db.prepare('SELECT count(*) AS n FROM events').get().n >= this.maxEvents) throw fail(507, 'OUTBOX_LIMIT');
      const expires = Math.min(now + this.ttlMs, occurredAt + this.ttlMs);
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(eventId, category, now, expires, now + this.retentionMs);
      const insert = this.db.prepare('INSERT INTO deliveries(event_id,device_id,phase,next_at,updated_at) VALUES (?,?,?,?,?)');
      let queued = 0;
      for (const target of new Set(devices)) {
        const retired = this.isRetired(target), phase = retired ? 'retired' : expires <= now ? 'expired' : 'pending';
        insert.run(eventId, target, phase, Math.min(expires, Math.max(now, notBeforeAt)), now); if (phase === 'pending') queued++;
      }
      return {persisted: true, duplicate: false, eventId, queuedTargets: queued};
    });
  }
  isRetired(target) {return !!this.db.prepare('SELECT 1 FROM retired_devices WHERE device_id=?').get(target);}
  retire(target, code = 'SUBSCRIPTION_RETIRED', providerStatus = null, lease = null) {
    if (typeof target !== 'string' || !device.test(target)) throw fail(400, 'INVALID_NOTIFICATION_DEVICE');
    const now = this.now();
    return this.transaction(() => {
      if (lease && !this.db.prepare("SELECT 1 FROM deliveries WHERE event_id=? AND device_id=? AND lease_token=? AND phase='attempting'").get(lease.eventId, target, lease.token)) return false;
      this.db.prepare('INSERT OR REPLACE INTO retired_devices VALUES (?,?,?)').run(target, now, code);
      this.db.prepare("UPDATE deliveries SET phase='retired',code=?,provider_status=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE device_id=? AND phase IN ('pending','attempting')").run(code, providerStatus, now, target);
    });
  }
  reinstate(target) {if (typeof target !== 'string' || !device.test(target)) throw fail(400, 'INVALID_NOTIFICATION_DEVICE'); return this.transaction(() => {
    this.db.prepare("UPDATE deliveries SET phase='retired',code='SUBSCRIPTION_REPLACED',lease_until=NULL,lease_token=NULL,updated_at=? WHERE device_id=? AND phase IN ('pending','attempting')").run(this.now(), target);
    this.db.prepare('DELETE FROM retired_devices WHERE device_id=?').run(target);
  });}
  claim() {
    const now = this.now();
    return this.transaction(() => {
      this.db.prepare("UPDATE deliveries SET phase='expired',code='NOTIFICATION_EXPIRED',lease_until=NULL,lease_token=NULL,updated_at=? WHERE phase IN ('pending','attempting') AND event_id IN (SELECT id FROM events WHERE expires_at<=?)").run(now, now);
      this.db.prepare("UPDATE deliveries SET phase='failed',code='ATTEMPT_LIMIT',lease_until=NULL,lease_token=NULL,updated_at=? WHERE attempts>=? AND (phase='pending' OR phase='attempting' AND lease_until<=?)").run(now, this.maxAttempts, now);
      const row = this.db.prepare("SELECT d.*,e.category,e.expires_at FROM deliveries d JOIN events e ON e.id=d.event_id WHERE (d.phase='pending' AND d.next_at<=? OR d.phase='attempting' AND d.lease_until<=?) AND d.attempts<? ORDER BY d.next_at,d.event_id,d.device_id LIMIT 1").get(now, now, this.maxAttempts);
      if (!row) return null;
      const token = crypto.randomUUID();
      this.db.prepare("UPDATE deliveries SET phase='attempting',attempts=attempts+1,lease_until=?,lease_token=?,updated_at=? WHERE event_id=? AND device_id=?").run(now + this.leaseMs, token, now, row.event_id, row.device_id);
      return {...row, attempts: row.attempts + 1, token};
    });
  }
  async attempt(row) {
    let status = 0, accepted = false, timer;
    const controller = new AbortController();
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.send(row.device_id, row.category, {eventId: row.event_id, ttlSeconds: Math.max(1, Math.ceil((row.expires_at - this.now()) / 1000)), signal: controller.signal})),
        new Promise((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(Error('Notification send timeout'));}, this.sendTimeoutMs);})
      ]);
      status = Number(result?.statusCode) || 0; accepted = status >= 200 && status < 300;
    } catch (error) {status = Number(error.statusCode) || 0;}
    finally {clearTimeout(timer);}
    if (status === 404 || status === 410) {this.retire(row.device_id, 'SUBSCRIPTION_GONE', status, {eventId: row.event_id, token: row.token}); return;}
    const now = this.now(), retryable = !status || status === 408 || status === 429 || status >= 500;
    const expired = row.expires_at <= now, retry = !accepted && retryable && !expired && row.attempts < this.maxAttempts;
    const random = this.random(), jitter = 0.8 + (Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5) * 0.4;
    const delay = Math.ceil(Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (row.attempts - 1) * jitter));
    const phase = accepted ? 'provider-accepted' : expired ? 'expired' : retry ? 'pending' : 'failed';
    this.transaction(() => this.db.prepare('UPDATE deliveries SET phase=?,next_at=?,lease_until=NULL,lease_token=NULL,provider_status=?,code=?,updated_at=? WHERE event_id=? AND device_id=? AND lease_token=? AND phase=\'attempting\'').run(phase, now + delay, status || null, accepted ? 'PROVIDER_ACCEPTED' : expired ? 'NOTIFICATION_EXPIRED' : retry ? 'RETRY_SCHEDULED' : 'ATTEMPT_FAILED', now, row.event_id, row.device_id, row.token));
  }
  tick({limit = 4} = {}) {
    if (this.active) return this.active;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) return Promise.reject(new TypeError('Invalid outbox batch size'));
    this.active = (async () => {for (let n = 0; n < limit && !this.closed; n++) {const row = this.claim(); if (!row) break; await this.attempt(row);}})().finally(() => {this.active = null;});
    return this.active;
  }
  start(intervalMs = 1000) {if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60000) throw new TypeError('Invalid outbox timer'); if (!this.timer) {this.timer = setInterval(() => {void this.tick().catch(() => {});}, intervalMs); this.timer.unref();} return this;}
  delivery(eventId, target) {return this.db.prepare('SELECT phase,attempts,next_at,provider_status,code FROM deliveries WHERE event_id=? AND device_id=?').get(eventId, target) || null;}
  lastEventAt(category, target) {return this.db.prepare('SELECT max(e.created_at) AS at FROM events e JOIN deliveries d ON d.event_id=e.id WHERE e.category=? AND d.device_id=?').get(category, target).at;}
  metrics() {
    const counts = Object.fromEntries(this.db.prepare('SELECT phase,count(*) AS n FROM deliveries GROUP BY phase').all().map(row => [row.phase, row.n]));
    const last = this.db.prepare("SELECT updated_at FROM deliveries WHERE phase='provider-accepted' ORDER BY updated_at DESC LIMIT 1").get();
    return {scope: 'retained-outbox', persistedEvents: this.db.prepare('SELECT count(*) AS n FROM events').get().n, queuedTargets: (counts.pending || 0) + (counts.attempting || 0), providerAcceptedTargets: counts['provider-accepted'] || 0, failedTargets: counts.failed || 0, retiredTargets: counts.retired || 0, expiredTargets: counts.expired || 0, lastAcceptedAt: last ? new Date(last.updated_at).toISOString() : null, deliveryConfirmed: false};
  }
  async stop() {if (this.timer) clearInterval(this.timer); this.timer = null; if (this.active) await this.active; if (!this.closed) {this.db.close(); this.closed = true;}}
}
module.exports = {NotificationOutbox};
