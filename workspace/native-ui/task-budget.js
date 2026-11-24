const taskBudgetLabels = {
 en: {
  title:'Task limit', next:'Limit for the next request', none:'No limit', elapsed:'Time', tokens:'Tokens',
  minutes:'Minutes', amount:'Token limit', save:'Save', close:'Close', loading:'Loading limit…',
  timeHint:'Includes time spent waiting.', tokenHint:'Checked after each model response.',
  loadError:'Could not load the limit.', saveError:'Could not save the limit.', busy:'The task has already started.',
  earlier:'Earlier task', used:'Reported tokens',
  TASK_TIME_LIMIT:'Time limit reached.', TASK_TOKEN_LIMIT:'Token limit reached.',
  TASK_BUDGET_USAGE_UNAVAILABLE:'The task stopped because token usage was unavailable.',
  TASK_BUDGET_USAGE_INTERRUPTED:'The task stopped because token accounting was interrupted.',
 },
 cs: {
  title:'Limit úlohy', next:'Limit pro příští zadání', none:'Bez limitu', elapsed:'Čas', tokens:'Tokeny',
  minutes:'Minuty', amount:'Počet tokenů', save:'Uložit', close:'Zavřít', loading:'Načítám limit…',
  timeHint:'Zahrnuje i čekání.', tokenHint:'Kontroluje se po každé odpovědi modelu.',
  loadError:'Limit se nepodařilo načíst.', saveError:'Limit se nepodařilo uložit.', busy:'Úloha už běží.',
  earlier:'Předchozí úloha', used:'Vykázané tokeny',
  TASK_TIME_LIMIT:'Dosažen časový limit.', TASK_TOKEN_LIMIT:'Dosažen limit tokenů.',
  TASK_BUDGET_USAGE_UNAVAILABLE:'Úloha skončila, protože údaj o spotřebě tokenů chyběl.',
  TASK_BUDGET_USAGE_INTERRUPTED:'Úloha skončila kvůli přerušení měření tokenů.',
 },
};

async function requestTaskLimit(sessionId, fields, signal) {
 const result = await nativeJSON('/api/workbench', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({op:'task-budget', sessionId, ...fields}), signal,
 }, 5000);
 if (result?.version !== 1 || result.sessionId !== sessionId) throw Error('Invalid task limit');
 return result;
}

function TaskLimitForm({sessionId, close}) {
 const language = useLanguage();
 const copy = taskBudgetLabels[language] || taskBudgetLabels.en;
 const [snapshot, setSnapshot] = React.useState(null);
 const [kind, setKind] = React.useState('none');
 const [amount, setAmount] = React.useState('10');
 const [saving, setSaving] = React.useState(false);
 const [error, setError] = React.useState(null);
 const request = React.useRef(null);
 const typeId = React.useId();

 React.useEffect(() => {
  const controller = new AbortController();
  request.current = controller;
  void requestTaskLimit(sessionId, {action:'status'}, controller.signal).then(value => {
   if (controller.signal.aborted) return;
   setSnapshot(value);
   const limit = value.nextTaskLimit;
   setKind(limit?.kind ?? 'none');
   setAmount(String(limit?.minutes ?? limit?.totalTokens ?? 10));
  }).catch(() => { if (!controller.signal.aborted) setError('loadError'); });
  return () => { request.current?.abort(); };
 }, [sessionId]);

 async function save(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!snapshot || saving) return;
  const controller = new AbortController();
  request.current = controller;
  setSaving(true);
  setError(null);
  const limit = kind === 'none' ? null : {kind, [kind === 'elapsed' ? 'minutes' : 'totalTokens']:Number(amount)};
  try {
   await requestTaskLimit(sessionId, {action:'configure', limit}, controller.signal);
   if (!controller.signal.aborted) close();
  } catch (failure) {
   if (!controller.signal.aborted) {
    setSaving(false);
    setError(failure.code === 'TASK_ALREADY_RUNNING' ? 'busy' : 'saveError');
   }
  }
 }

 const current = snapshot?.current;
 const previous = snapshot?.previousStop;
 const reason = current?.reason;
 return h('section', {
  className:'harness-task-limit', 'data-task-budget-session':sessionId, 'aria-label':copy.title,
  onKeyDown:event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } },
 },
  h('form', {onSubmit:save},
   h('label', {htmlFor:typeId}, copy.next),
   snapshot && h('select', {id:typeId, value:kind, disabled:saving, onChange:event => {
    const next = event.target.value; setKind(next); setAmount(next === 'tokens' ? '50000' : '10');
   }}, ...['none','elapsed','tokens'].map(k => h('option',{key:k,value:k},copy[k]))),
   snapshot && kind !== 'none' && h('label', null, kind === 'elapsed' ? copy.minutes : copy.amount,
    h('input', {type:'number',required:true,min:1,max:kind === 'tokens' ? 10000000 : 1440,step:1,
     value:amount,disabled:saving,onChange:event => setAmount(event.target.value)})),
   snapshot && h('button', {type:'submit',disabled:saving}, copy.save),
   h('button', {type:'button',onClick:close,autoFocus:true}, copy.close)),
  !snapshot && !error && h('p', {role:'status'}, copy.loading),
  snapshot && kind !== 'none' && h('p', null, kind === 'tokens' ? copy.tokenHint : copy.timeHint),
  current?.limit?.kind === 'tokens' && h('p',null,copy.used+' · '+(current.usageAvailable === false ? '—' : current.usedTokens)+' / '+current.limit.totalTokens),
  previous && h('p', {'data-task-budget-previous-turn':previous.turn},
   copy.earlier+' ('+new Date(previous.startedAt).toLocaleString()+') · '+(copy[previous.reason.code] || previous.reason.message)),
  reason && h('p', {'data-task-budget-reason':reason.code,role:'status'},copy[reason.code] || reason.message),
  error && h('p', {role:'alert'}, copy[error]));
}

function TaskBudgetControl({sessionId, useSession, usePanelInfo, launchers}) {
 const eligibleSession = useSession(state => !state.running && !state.subagent);
 const conversation = usePanelInfo(panel => panel.activePanelId === null);
 const eligible = Boolean(sessionId && eligibleSession && conversation);
 const [open, setOpen] = React.useState(false);
 React.useLayoutEffect(() => {
  if (!eligible) { setOpen(false); return; }
  const launch = () => setOpen(true);
  launchers.set(sessionId, launch);
  return () => { if (launchers.get(sessionId) === launch) launchers.delete(sessionId); };
 }, [sessionId, eligible, launchers]);
 return eligible && open ? h(TaskLimitForm, {sessionId,close:() => setOpen(false)}) : null;
}

function registerTaskBudget(ctx) {
 const launchers = new Map();
 const slot = 'conversation.input.dock';
 ctx.slots.inject(slot, () => ctx.slots.register({name:slot,id:'harness.task-budget',order:45},
  props => h(TaskBudgetControl, {...props, key:props.sessionId, launchers})));
 ctx.inject(['commandUi'], scope => {
  scope.effect(() => scope.get('commandUi').register({
   name:'task-limit', label:() => (taskBudgetLabels[window.HarnessI18n.language] || taskBudgetLabels.en).title,
   available:session => launchers.has(session.sessionId),
   ui:{kind:'action',run:session => launchers.get(session.sessionId)?.()},
  }), 'native-workbench: task limit command');
 });
}
