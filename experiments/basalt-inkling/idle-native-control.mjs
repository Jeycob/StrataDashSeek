import { lstatSync, writeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { installAdmission } from './idle-admission.mjs';

const directory = '/run/basalt-idle-bridge';
const endpoint = directory + '/native.sock';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function createNativeControl(activity, admission, stop) {
  let lease = null;
  async function status() {
    if (!admission.healthy()) throw Error('Native admission guard unavailable');
    const before = admission.revision();
    const state = await activity.read(AbortSignal.timeout(5000));
    if (!admission.healthy() || before !== admission.revision() || state.revision !== activity.revision()) {
      throw Error('Native changed during observation');
    }
    return { ...state, revision: state.revision + before, busy: state.busy || admission.busy() };
  }
  async function request(command, write) {
    const { op, rid } = command;
    if (!uuid.test(rid)) throw Error('Invalid request');
    function reject() { write({ ok: false, rid, epoch: activity.epoch, open: admission.open() }); }
    if (op === 'thaw' && uuid.test(command.lease) && (lease === null || lease === command.lease)) {
      admission.reopen(); lease = null;
      // THAW attests release. New work after release is captured by the next STATUS.
      write({ ok: true, rid, epoch: activity.epoch, revision: activity.revision() + admission.revision(),
        busy: true, lease: command.lease });
      return;
    }
    if (op === 'status' && !lease) {
      try { write({ ok: true, rid, ...await status() }); } catch { reject(); }
      return;
    }
    if (op !== 'freeze' || lease || !uuid.test(command.lease) || command.epoch !== activity.epoch ||
        !Number.isSafeInteger(command.revision) || !admission.close()) { reject(); return; }
    let timer;
    try {
      const deadline = new Promise((_, rejectDeadline) => {
        timer = setTimeout(() => rejectDeadline(Error('Native drain deadline')), 2500);
        timer.unref();
      });
      // rc.2 appends to write-behind storage. Include every active write handle
      // in its SDK durability barrier before publishing a frozen snapshot.
      const state = await Promise.race([Promise.resolve().then(() => activity.flush()).then(status), deadline]);
      // The final revision and admission check, kernel write of the proof and SIGSTOP
      // are synchronous. No queued JavaScript callback can run between them.
      if (state.busy || state.revision !== command.revision || admission.busy() || !admission.healthy() ||
          activity.revision() + admission.revision() !== command.revision) throw Error('Native changed');
      lease = command.lease;
      write({ ok: true, rid, ...state, lease });
      stop();
    } catch {
      lease = null;
      admission.reopen();
      reject();
    } finally { clearTimeout(timer); }
  }
  return { request, status };
}

function isRootEndpoint() {
  const parent = lstatSync(directory), socket = lstatSync(endpoint);
  return parent.isDirectory() && parent.uid === 0 && !(parent.mode & 0o022) && socket.isSocket() && socket.uid === 0;
}

export function attachBridge(ctx, activity) {
  const ingress = globalThis[Symbol.for('stratadashseek.basalt.idle-ingress.v1')];
  const admission = installAdmission(ctx, ingress);
  const control = createNativeControl(activity, admission, () => process.kill(process.pid, 'SIGSTOP'));
  let closed = false, socket, timer;
  function retry() { if (!closed) { timer = setTimeout(connect, 1500); timer.unref(); } }
  function connect() {
    try { if (!isRootEndpoint()) { retry(); return; } } catch { retry(); return; }
    const conn = createConnection(endpoint);
    socket = conn;
    let buffer = '', handling = false;
    function write(value) {
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      const fd = conn._handle?.fd;
      if (!Number.isInteger(fd) || conn.destroyed || writeSync(fd, bytes) !== bytes.length) {
        conn.destroy(); throw Error('Native control peer unavailable');
      }
    }
    conn.setEncoding('utf8');
    conn.once('connect', () => { try { write({ op: 'hello', epoch: activity.epoch }); } catch { conn.destroy(); } });
    conn.on('data', chunk => {
      buffer += chunk;
      if (handling || buffer.length > 1024) { conn.destroy(); return; }
      if (!buffer.includes('\n')) return;
      if (buffer.indexOf('\n') !== buffer.length - 1) { conn.destroy(); return; }
      handling = true;
      let command;
      try { command = JSON.parse(buffer); } catch { conn.destroy(); return; }
      buffer = '';
      control.request(command, write).catch(() => conn.destroy()).finally(() => { handling = false; });
    });
    conn.on('error', () => conn.destroy());
    conn.once('close', retry);
  }
  connect();
  ctx.effect(() => () => { closed = true; clearTimeout(timer); socket?.destroy(); });
  return control;
}
