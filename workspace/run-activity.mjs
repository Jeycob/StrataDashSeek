import { WorkbenchError } from './policy.mjs';

// The browser can request only the selected owner's phases. Gate state can
// contain other sessions and the automatic verifier stores paths and arguments.
export async function readRunActivity(manager, id) {
  const project = await manager.checked(() => manager.projectFor(id));
  if (project.header.origin === 'subagent' || manager.data.trash[id]) {
    throw new WorkbenchError('SESSION_NOT_FOUND', 'Conversation not found.', 404);
  }
  const status = await manager.checked(() => manager.ctx.waterfall(
    'efficiency/session-status', { sessionId: id }, () => undefined
  ));
  const phases = [];
  if (status?.version === 1 && status.sessionId === id && status.enabled === true) {
    for (const key of ['heavyTools', 'model']) {
      const gate = status[key];
      if (gate?.phase === 'waiting' || gate?.phase === 'admitted') {
        phases.push({ phase: key + '.' + gate.phase, since: gate.since });
      }
    }
  }
  const check = manager.data.sessions[id]?.budget?.automatic;
  if (check?.phase === 'checking' && !check.terminalAcknowledged && !check.uncertain &&
      check.activeCallId && check.operation?.callId === check.activeCallId) {
    phases.push({ phase: 'verifying', since: check.operation.startedAt });
  }
  const observedAt = Date.now();
  return { version: 1, sessionId: id, observedAt, phases: phases.map(({phase, since}) => ({
    phase, elapsedSeconds: Number.isSafeInteger(since) && since > 0 ? Math.max(0, Math.floor((observedAt - since) / 1000)) : null
  })) };
}
