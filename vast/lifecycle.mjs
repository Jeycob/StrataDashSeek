// Track a whole agent turn, including its tools/builds, independently of LLM traffic.
import fs from 'node:fs';
import path from 'node:path';

export const name = 'harness-idle-lifecycle';

const activityEvents = new Set(['turn/start', 'turn/end', 'user/message', 'tool/call', 'tool/result']);

export function apply(ctx, config = {}) {
  const stateFile = config.file || '/data/harness/state/lifecycle.json';
  const activeSessions = new Set();
  let lastActivity = Date.now();

  fs.mkdirSync(path.dirname(stateFile), {recursive: true});

  function writeState() {
    const temporaryFile = stateFile + '.tmp';
    const state = {
      pid: process.pid,
      at: Date.now(),
      active: activeSessions.size,
      lastActivity
    };
    fs.writeFileSync(temporaryFile, JSON.stringify(state), {mode: 0o600});
    fs.renameSync(temporaryFile, stateFile);
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') activeSessions.add(session);
    if (event.type === 'turn/end') activeSessions.delete(session);
    if (activityEvents.has(event.type)) lastActivity = Date.now();
    writeState();
  });

  const heartbeat = setInterval(writeState, 5000);
  heartbeat.unref();
  ctx.on('dispose', () => clearInterval(heartbeat));
  writeState();
}
