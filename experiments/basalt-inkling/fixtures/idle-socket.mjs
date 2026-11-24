// Exercise rc.2's actual registered wire transport on one authenticated fixture socket.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { installAdmission } from '../idle-admission.mjs';

export async function verifyIdleSocket(ctx, sdk, sessionId) {
  const ingress = { accepting: false, initialized: false, inFlight: 0, revision: 0, intact: () => true };
  const gate = installAdmission(ctx, ingress);
  const base = ctx.webServer.getOrigin();
  const login = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(row => row.split(';')[0]).join('; ');
  assert.ok(cookie);
  const ws = new (sdk('ws'))(new URL('/api/remote.mux', base.replace(/^http/, 'ws')), {
    headers: { Origin: new URL(base).origin, Cookie: cookie },
  });
  const outstanding = new Map();
  ws.on('message', data => {
    const frame = JSON.parse(String(data));
    const resolve = outstanding.get(frame.streamId);
    if (resolve) { outstanding.delete(frame.streamId); resolve(frame); }
  });
  function openStream(endpoint, args) {
    const streamId = randomUUID();
    const reply = new Promise(resolve => outstanding.set(streamId, resolve));
    ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    return reply;
  }
  const follow = activate => openStream('session/follow', { request: { address: { kind: 'session', sessionId }, activate, maxMessages: 1 } });
  try {
    await once(ws, 'open', { signal: AbortSignal.timeout(5000) });
    assert.equal((await follow(false)).type, 'item', 'first passive snapshot');
    assert.equal((await openStream('terminal/watch', { sessionId })).type, 'item', 'passive terminal roster');
    assert.equal(gate.close(), true, 'passive stream may stay connected');
    assert.equal((await follow(true)).type, 'error', 'existing socket cannot submit activating open during drain');
    gate.reopen();
    assert.equal((await follow(false)).type, 'item', 'same socket accepts a fresh read after reopening');
  } finally {
    gate.reopen();
    ws.terminate();
  }
}
