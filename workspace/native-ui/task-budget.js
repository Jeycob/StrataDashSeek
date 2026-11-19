// Included inside the same Native factory as source.js; uses the session
// supplied by the composer's public slot, never a DOM-inferred identity.
const taskBudgetLabels = {
 en: {title:'Task budget',none:'No new limit',elapsed:'Elapsed minutes',tokens:'Reported tokens',save:'Use for next request',saved:'Saved for one new request.',help:'Optional, for your next request only. Internal continuation does not reset it. The next new request has no new limit.',meter:'Tokens are not a price. Usage is checked after each model response and may exceed the limit by that response. Missing exact totals stop the task.',time:'Time starts at the recorded acceptance receipt and includes later waits. Without a receipt timestamp, it starts at the first runtime step. A finished task and its delivered preview do not keep the timer running.',scope:'Late completion notices stay suppressed for managed project commands. Other background services retain their own notification behavior.',failed:'Task budget could not be loaded.',busy:'Set the limit before sending the request.',used:'Reported tokens',TASK_TIME_LIMIT:'Task time limit reached. Files and recorded checks are retained.',TASK_TOKEN_LIMIT:'Reported token limit reached. Files and recorded checks are retained.',TASK_BUDGET_USAGE_UNAVAILABLE:'Exact token usage was not reported. The task stopped; files and recorded checks are retained.',TASK_BUDGET_USAGE_INTERRUPTED:'Token accounting was interrupted. The task stopped; files and recorded checks are retained.'},
 cs: {title:'Rozpočet úlohy',none:'Bez nového limitu',elapsed:'Uplynulé minuty',tokens:'Vykázané tokeny',save:'Použít pro příští zadání',saved:'Uloženo pro jedno nové zadání.',help:'Volitelný limit jen pro příští zadání. Interní pokračování jej neobnovuje. Další nové zadání má opět výchozí stav bez limitu.',meter:'Tokeny nejsou cena. Spotřeba se kontroluje po odpovědi modelu; poslední odpověď může limit překročit. Když přesný součet chybí, úloha se zastaví.',time:'Čas začíná zaznamenaným přijetím zadání a zahrnuje následné čekání. Chybí-li čas přijetí, začíná prvním krokem běhu. Dokončená úloha ani předaný náhled časovač neudržují.',scope:'Pozdní dokončení spravovaných příkazů projektu už úlohu neprobudí. Jiné služby na pozadí zachovávají vlastní chování oznámení.',failed:'Rozpočet se nepodařilo načíst.',busy:'Limit nastavte před odesláním zadání.',used:'Vykázané tokeny',TASK_TIME_LIMIT:'Dosažen časový limit úlohy. Soubory i zaznamenané kontroly zůstaly zachovány.',TASK_TOKEN_LIMIT:'Dosažen limit vykázaných tokenů. Soubory i zaznamenané kontroly zůstaly zachovány.',TASK_BUDGET_USAGE_UNAVAILABLE:'Model neposkytl přesný součet tokenů. Úloha se zastavila; soubory a kontroly zůstaly zachovány.',TASK_BUDGET_USAGE_INTERRUPTED:'Účtování tokenů bylo přerušeno. Úloha se zastavila; soubory a kontroly zůstaly zachovány.'}
};
function TaskBudgetControl({sessionId,useSession,usePanelInfo}) {
 const language=useLanguage(),copy=taskBudgetLabels[language]||taskBudgetLabels.en;
 const running=useSession(s=>s.running),subagent=useSession(s=>s.subagent),conversation=usePanelInfo(p=>p.activePanelId===null);
 const [open,setOpen]=React.useState(false),[value,setValue]=React.useState(null),[kind,setKind]=React.useState('none'),[amount,setAmount]=React.useState('10'),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[saved,setSaved]=React.useState(false);
 const generation=React.useRef(0),request=React.useRef(null),id=React.useId();
 React.useEffect(()=>{setOpen(false);setValue(null);setKind('none');setError('');setSaved(false);return()=>{++generation.current;request.current?.abort();};},[sessionId]);
 React.useEffect(()=>{
  if(!open||!sessionId)return;
  const ticket=++generation.current,controller=new AbortController();request.current=controller;setBusy(true);setError('');
  void nativeJSON('/api/workbench',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'task-budget',action:'status',sessionId}),signal:controller.signal},5000).then(result=>{
   if(ticket!==generation.current||controller.signal.aborted)return;
   if(result.version!==1||result.sessionId!==sessionId)throw Error('Invalid task budget');
   setValue(result);setKind(result.nextTaskLimit?.kind||'none');setAmount(String(result.nextTaskLimit?.minutes??result.nextTaskLimit?.totalTokens??10));
  }).catch(()=>{if(!controller.signal.aborted&&ticket===generation.current)setError(copy.failed);}).finally(()=>{if(ticket===generation.current)setBusy(false);});
  return()=>{controller.abort();++generation.current;};
 },[sessionId,open,running]);
 if(!sessionId||subagent||!conversation)return null;
 async function save(event){
  event.preventDefault();if(busy||running||!value)return;
  const ticket=++generation.current,controller=new AbortController();request.current?.abort();request.current=controller;setBusy(true);setError('');setSaved(false);
  const limit=kind==='none'?null:{kind,[kind==='elapsed'?'minutes':'totalTokens']:Number(amount)};
  try{const result=await nativeJSON('/api/workbench',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'task-budget',action:'configure',sessionId,limit}),signal:controller.signal},5000);if(ticket!==generation.current||controller.signal.aborted)return;if(result.version!==1||result.sessionId!==sessionId)throw Error('Invalid task budget');setValue(result);setSaved(true);}
  catch(e){if(!controller.signal.aborted&&ticket===generation.current)setError(e.code==='TASK_ALREADY_RUNNING'?copy.busy:copy.failed);}
  finally{if(ticket===generation.current)setBusy(false);}
 }
 const reason=value?.current?.reason,previous=value?.previousStop;
 return h('details',{'data-task-budget-session':sessionId,open,onToggle:e=>setOpen(e.currentTarget.open),style:{maxWidth:'100%',fontSize:'12px'}},
  h('summary',null,copy.title+(value?.nextTaskLimit?' · '+(value.nextTaskLimit.minutes??value.nextTaskLimit.totalTokens):'')),
  open&&h('form',{onSubmit:save,style:{display:'flex',flexWrap:'wrap',gap:'8px',padding:'8px 0'}},
   h('label',{htmlFor:id+'-kind'},copy.title),h('select',{id:id+'-kind',value:kind,disabled:busy||running||!value,onChange:e=>{setKind(e.target.value);setAmount(e.target.value==='tokens'?'50000':'10');setSaved(false);}},...['none','elapsed','tokens'].map(k=>h('option',{key:k,value:k},copy[k]))),
   kind!=='none'&&h(React.Fragment,null,h('label',{htmlFor:id+'-amount'},copy[kind]),h('input',{id:id+'-amount',type:'number',required:true,min:1,max:kind==='tokens'?10000000:1440,step:1,value:amount,disabled:busy||running,onChange:e=>{setAmount(e.target.value);setSaved(false);},style:{width:'8em'}})),
   h('button',{type:'submit',disabled:busy||running||!value},copy.save),h('p',{style:{flexBasis:'100%',margin:0}},copy.help),h('p',{style:{flexBasis:'100%',margin:0}},kind==='tokens'?copy.meter:copy.time),
   value?.current?.limit.kind==='tokens'&&h('p',null,copy.used+': '+(value.current.usageAvailable===false?'—':value.current.usedTokens)+' / '+value.current.limit.totalTokens),
   h('p',{style:{flexBasis:'100%',margin:0}},copy.scope),
   previous&&h('p',{'data-task-budget-previous-turn':previous.turn},(language==='cs'?'Předchozí úloha':'Earlier task')+' ('+new Date(previous.startedAt).toLocaleString()+'): '+(copy[previous.reason.code]||previous.reason.message)),
   reason&&h('p',{'data-task-budget-reason':reason.code,role:'status'},copy[reason.code]||reason.message),error&&h('p',{role:'alert'},error),saved&&h('p',{role:'status'},copy.saved)));
}
function registerTaskBudget(ctx){
 const slot='conversation.input.dock';
 ctx.slots.inject(slot,()=>ctx.slots.register({name:slot,id:'harness.task-budget',order:45},TaskBudgetControl));
}
