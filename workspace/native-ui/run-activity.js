// Included inside the Native plugin factory, beside source.js.
const runActivityLabels = {
 en: {'model.waiting':'Waiting for model capacity','heavyTools.waiting':'Waiting for tool capacity',verifying:'Verifying the result',preview:'Preparing the preview link'},
 cs: {'model.waiting':'Čeká na volný model','heavyTools.waiting':'Čeká na volný nástroj',verifying:'Ověřuje výsledek',preview:'Připravuje odkaz na náhled'}
};

function ActiveRunStatus({sessionId, useSession, usePanelInfo, useChat}) {
 const language = useLanguage();
 const running = useSession(s => s.running && !s.subagent);
 const inConversation = usePanelInfo(p => p.activePanelId === null);
 const calls = useChat(s => s.legacy.runningCalls);
 const [visible, setVisible] = React.useState(() => !document.hidden);
 const [snapshot, setSnapshot] = React.useState(null);
 const active = Boolean(sessionId && running && inConversation && visible);
 React.useEffect(() => {
  const changed = () => setVisible(!document.hidden);
  document.addEventListener('visibilitychange', changed);
  changed();
  return () => document.removeEventListener('visibilitychange', changed);
 }, []);
 React.useEffect(() => {
  setSnapshot(null);
  if (!active) return;
  const controller = new AbortController();
  let timer;
  async function poll() {
   try {
    const result = await nativeJSON('/api/workbench', {method:'POST', headers:{'Content-Type':'application/json'},
     body:JSON.stringify({op:'run-activity', sessionId}), signal:controller.signal}, 5000);
    if (!controller.signal.aborted) setSnapshot(result?.version === 1 && result.sessionId === sessionId && Array.isArray(result.phases) ? result : null);
   } catch {
    if (!controller.signal.aborted) setSnapshot(null);
   } finally {
    if (!controller.signal.aborted) timer = setTimeout(poll, 4000);
   }
  }
  void poll();
  return () => { controller.abort(); clearTimeout(timer); };
 }, [sessionId, active]);
 if (!active) return null;
 const copy = runActivityLabels[language] || runActivityLabels.en;
 const phases = new Map();
 if (snapshot?.sessionId === sessionId) {
  for (const {phase, elapsedSeconds} of snapshot.phases) if (Object.hasOwn(copy, phase)) phases.set(phase, elapsedSeconds);
 }
 for (const call of calls) {
  if (call.phase !== 'start') continue;
  if (call.name === 'verify_project') { if (!phases.has('verifying')) phases.set('verifying', null); }
  if (call.name === 'project_preview' && !phases.has('preview') && typeof call.argsRaw === 'string' && call.argsRaw.length <= 2048) {
   try { if (JSON.parse(call.argsRaw)?.operation === 'open') phases.set('preview', null); } catch { /* No confirmed preview operation yet. */ }
  }
 }
 if (!phases.size) return null;
 const rows = [...phases].map(([phase, seconds]) =>
  h('span', {key:phase,'data-phase':phase}, copy[phase] + (Number.isSafeInteger(seconds) && seconds >= 0 ? ' · ' + seconds + ' s' : ''))
 );
 return h('div', {className:'harness-run-activity','data-run-session':sessionId}, ...rows);
}

function registerRunActivity(ctx) {
 const slot = 'conversation.input.dock';
 ctx.slots.inject(slot, () => ctx.slots.register({name:slot, id:'harness.run-activity', order:40}, ActiveRunStatus));
}
