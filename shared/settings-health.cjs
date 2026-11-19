(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.HarnessSettingsHealth=api;
})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const ROUTES=Object.freeze({release:'/api/workbench/health',model:'/phone/api/monitor',apps:'/phone/api/apps/state?scope=global'});
 const MAX_AGE_MS=20000,REQUEST_MS=5000,POLL_MS=10000;
 const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const timestamp=value=>Number.isSafeInteger(value)&&value>=0;
 const age=(at,now)=>timestamp(at)&&timestamp(now)&&now>=at&&now-at<=MAX_AGE_MS;
 const empty=state=>({state,observedAt:null});
 function sampleState(sample,now){
  if(!sample)return'unknown';
  if(sample.failed===true)return'unavailable';
  return age(sample.receivedAt,now)?null:'stale';
 }
 function project(samples={},now=Date.now()){
  let release=empty(sampleState(samples.release,now)||'unknown');
  const r=samples.release?.value;
  if(!sampleState(samples.release,now)&&object(r)&&typeof r.sourceCommit==='string'&&/^[a-f0-9]{40}$/.test(r.sourceCommit)&&typeof r.workspaceReady==='boolean')release={state:r.workspaceReady?'available':'unavailable',observedAt:samples.release.receivedAt,sourceCommit:r.sourceCommit};
  let model=empty(sampleState(samples.model,now)||'unknown');
  const t=samples.model?.value;
  if(!sampleState(samples.model,now)&&object(t)){
   if(!timestamp(t.at))model=empty('unknown');
   else if(!age(t.at,now))model=empty('stale');
   else if(object(t.model)&&t.model.loaded===false)model={state:'unavailable',observedAt:t.at};
   else if(object(t.model)&&t.model.loaded===true&&typeof t.model.id==='string'&&t.model.id.length>0&&t.model.id.length<=160&&!/[\x00-\x1f\x7f]/.test(t.model.id))model={state:'available',observedAt:t.at,id:t.model.id};
  }
  let apps=empty(sampleState(samples.apps,now)||'unknown'),vm={...apps};
  const a=samples.apps?.value;
  if(!sampleState(samples.apps,now)&&object(a)&&typeof a.enabled==='boolean'&&typeof a.available==='boolean'&&!(a.enabled===false&&a.available===true)){
   apps={state:!a.enabled?'disabled':a.available?'available':'unavailable',observedAt:samples.apps.receivedAt};
   // AppsManager constructs no VM controller when vm.enabled is false. An
   // explicit null is distinct from a missing/failed worker observation.
   if(!a.enabled||a.worker===null)vm={state:'disabled',observedAt:samples.apps.receivedAt};
   else if(object(a.worker)&&a.worker.managed===true&&['asleep','starting','restoring','ready','saving','blocked','error'].includes(a.worker.phase)){
    const ready=a.available&&a.worker.phase==='ready'&&a.worker.profile?.observedInRunningBoot===true;
    vm={state:ready?'available':'unavailable',observedAt:samples.apps.receivedAt};
   }
  }
  return{release,model,apps,vm};
 }
 function createController({fetch:request=globalThis.fetch,onChange=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let samples={},generation=0,disposed=false,poll;const active=new Set();
  const publish=()=>onChange({...samples});
  async function read(route,controller){
   let timer,rejectAbort;
   const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(Error('STATUS_UNAVAILABLE'));controller.signal.addEventListener('abort',rejectAbort,{once:true});timer=setTimer(()=>controller.abort(),REQUEST_MS);});
   try{return await Promise.race([aborted,(async()=>{
    const response=await request(route,{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if(!response.ok)throw Error('STATUS_UNAVAILABLE');
    const value=await response.json();
    if(controller.signal.aborted)throw Error('STATUS_UNAVAILABLE');
    return value;
   })()]);}
   finally{clearTimer(timer);controller.signal.removeEventListener('abort',rejectAbort);}
  }
  async function refresh(){
   if(disposed)return;
   const ticket=++generation;clearTimer(poll);for(const c of active)c.abort();active.clear();
   await Promise.all(Object.entries(ROUTES).map(async([key,route])=>{
    const controller=new AbortController();active.add(controller);
    try{const value=await read(route,controller);if(!disposed&&ticket===generation){samples={...samples,[key]:{value,receivedAt:now()}};publish();}}
    catch{if(!disposed&&ticket===generation){samples={...samples,[key]:{failed:true}};publish();}}
    finally{active.delete(controller);}
   }));
   if(!disposed&&ticket===generation)poll=setTimer(()=>{void refresh();},POLL_MS);
  }
  function dispose(){disposed=true;generation++;clearTimer(poll);for(const c of active)c.abort();active.clear();}
  return{refresh,dispose,snapshot:()=>project(samples,now())};
 }
 const COPY={
  en:{title:'Current runtime',release:'Served source SHA',model:'Loaded model',apps:'Applications / Docker',vm:'Apps VM',available:'Available',disabled:'Disabled / not configured',unavailable:'Unavailable',stale:'Stale or clock mismatch',unknown:'Not observed',observed:'Observed',refresh:'Refresh runtime status'},
  cs:{title:'Aktuální prostředí',release:'SHA obsluhujících zdrojů',model:'Načtený model',apps:'Aplikace / Docker',vm:'Apps VM',available:'Dostupné',disabled:'Vypnuto / nenakonfigurováno',unavailable:'Nedostupné',stale:'Zastaralé nebo nesouhlasí čas',unknown:'Neověřeno',observed:'Pozorováno',refresh:'Obnovit stav prostředí'}
 };
 function render(h,view,language,refresh){
  const c=COPY[language]||COPY.en;
  return h('section',{'data-runtime-health':true},h('h3',null,c.title),h('button',{type:'button',onClick:refresh},c.refresh),h('dl',null,...['release','model','apps','vm'].flatMap(key=>{
   const item=view[key];return[h('dt',{key:key+'-label'},c[key]),h('dd',{key:key,'data-runtime-health-kind':key,'data-runtime-health-state':item.state},c[item.state],item.sourceCommit&&h('code',null,' '+item.sourceCommit),item.id&&h('span',null,' '+item.id),item.observedAt!==null&&h('small',null,' · '+c.observed+' '+new Date(item.observedAt).toISOString()))];
  })));
 }
 const components=new WeakMap();
 function component(React){
  if(components.has(React))return components.get(React);
  function RuntimeHealth({language='en'}={}){
   const [samples,setSamples]=React.useState({}),[now,setNow]=React.useState(Date.now()),owner=React.useRef(null);
   React.useEffect(()=>{
    const controller=createController({onChange:value=>{setSamples(value);setNow(Date.now());}});owner.current=controller;void controller.refresh();
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>{owner.current=null;clearInterval(timer);controller.dispose();};
   },[]);
   return render(React.createElement,project(samples,now),language,()=>void owner.current?.refresh());
  }
  components.set(React,RuntimeHealth);return RuntimeHealth;
 }
 return{ROUTES,MAX_AGE_MS,REQUEST_MS,POLL_MS,project,createController,render,component};
});
