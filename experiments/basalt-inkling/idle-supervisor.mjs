import { spawn } from 'node:child_process';
import { constants as flags } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createIdleGuard, readBasaltMetrics } from './idle-guard.mjs';

const helper = fileURLToPath(new URL('./idle-supervisor-host.py', import.meta.url));
let lock;

function host(op, fields = {}, signal = AbortSignal.timeout(25000)) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-B', helper], {
      stdio: ['pipe','pipe','ignore', lock?.fd ?? 'ignore'], signal,
      env: { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8' },
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.length > 4096) child.kill('SIGKILL');
    });
    // A timeout may race a completed kernel write. Never retry an operation here.
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', code => {
      try {
        const result = JSON.parse(out);
        if (code !== 0 || !result.ok) throw Error('Unconfirmed host operation');
        resolve(result.value);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ op, ...fields }) + '\n');
  });
}

function newGuard() {
  return createIdleGuard({
    async observe(signal) {
      const [state, engine] = await Promise.all([host('observe', {}, signal), readBasaltMetrics(signal)]);
      const [, native] = state.identity;
      return { generation: JSON.stringify(state.identity),
        native: { epoch: native[2], revision: native[3], busy: state.nativeBusy },
        engine: { ...engine, busy: engine.busy || state.engineBusy } };
    },
    async tryFence(generation, signal) {
      await host('fence', { identity: JSON.parse(generation) }, signal);
      return { reopen: () => host('abort'), commitStop: () => host('commit') };
    },
  });
}

async function main() {
  if (process.getuid() !== 0 || process.argv.slice(2).some(a => a !== '--resolve-running') || process.argv.length > 3)
    throw Error('Invalid invocation');
  process.umask(0o077);
  await host('init');
  lock = await open('/var/lib/basalt-idle/supervisor.lock', flags.O_NOFOLLOW | flags.O_RDWR | flags.O_CREAT, 0o600);
  // Python flocks the same open file description inherited from Node. Active host
  // operations retain it even if their supervising Node process is interrupted.
  await host('lock');
  if (process.argv[2] === '--resolve-running') {
    const outcome = await host('reconcile', { manual: true });
    console.log(outcome);
    if (!['idle','retired'].includes(outcome)) process.exitCode = 2;
    return;
  }
  let guard = newGuard(), previous, backoff = 30000;
  for (;;) {
    const start = performance.now();
    let state, interval = 5000;
    try {
      state = await host('reconcile');
      if (state === 'idle') {
        state = await guard.tick();
        if (state === 'stop-submitted' || state === 'stop-outcome-pending') guard = newGuard();
        backoff = 30000;
      } else {
        guard = newGuard();
        if (['stopping','pending','pending-provider-unconfirmed'].includes(state)) {
          interval = backoff;
          backoff = Math.min(300000, backoff * 2);
        }
      }
    } catch {
      guard = newGuard();
      state = 'reconciliation-unconfirmed';
    }
    if (previous !== state) console.log(new Date().toISOString(), state);
    previous = state;
    await delay(Math.max(1, interval - (performance.now() - start)));
  }
}

try { await main(); }
catch { console.error('Basalt idle supervisor unavailable'); process.exitCode = 1; }
finally { await lock?.close(); }
