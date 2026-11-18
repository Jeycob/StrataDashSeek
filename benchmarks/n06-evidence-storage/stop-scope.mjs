// Driver-owned immutable absolute I/O ceiling. No effect at construction.
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
export function createStopScope({now,settlementMs},trusted={}){
 need(typeof now==='function'&&Number.isSafeInteger(settlementMs)&&settlementMs>0&&settlementMs<=120000,'FIXED_STOP_SCOPE_REQUIRED');
 const timer=trusted.setTimeout??setTimeout,clear=trusted.clearTimeout??clearTimeout,controller=new AbortController(),attached=new WeakSet();
 let ceiling=Infinity,firstCap=Infinity,primaryDeadline,stopping=false,handle;
 const cap=()=>Math.min(ceiling,firstCap);
 function arm(){clear(handle);const end=cap();if(!Number.isFinite(end))return;if(now()>=end){controller.abort();return;}handle=timer(()=>controller.abort(),end-now());handle?.unref?.();}
 function capture(deadline){need(Number.isSafeInteger(deadline),'ABSOLUTE_STOP_BOUND_REQUIRED');firstCap=Math.min(firstCap,deadline,now()+settlementMs);stopping=true;arm();}
 function external(signal){if(!signal||attached.has(signal))return;attached.add(signal);if(signal.aborted)controller.abort();else signal.addEventListener('abort',()=>controller.abort(),{once:true});}
 function options(input){
  need(Number.isSafeInteger(input?.deadline),'ABSOLUTE_IO_BOUND_REQUIRED');
  const deadline=Math.min(input.deadline,cap()),signal=AbortSignal.any([controller.signal,...(input.signal?[input.signal]:[])]);
  need(now()<deadline&&!signal.aborted,'STOP_SCOPE_CLOSED');return{...input,deadline,signal};
 }
 return Object.freeze({
  bindIntent(deadline){need(primaryDeadline===undefined&&Number.isSafeInteger(deadline),'SINGLE_INTENT_CLOCK_REQUIRED');primaryDeadline=deadline;ceiling=deadline+settlementMs;need(Number.isSafeInteger(ceiling),'ABSOLUTE_STOP_BOUND_REQUIRED');arm();},
  stop(input={}){external(input.signal);capture(input.deadline??Math.min(cap(),now()+settlementMs));return cap();},
  noteStop(){if(!stopping)capture(Math.min(cap(),now()+settlementMs));},
  finalization(input,{finish=false,externalSignal=false}={}){
   if(externalSignal)external(input?.signal);
   let end=input?.deadline;
   if(finish){need(Number.isSafeInteger(primaryDeadline),'ACTUAL_INTENT_REQUIRED');end=Math.min(end??Infinity,primaryDeadline,now()+settlementMs);}
   capture(Math.min(end??Infinity,cap()));return options({...input,deadline:Math.min(end,cap())});
  },
  async effect(input,work){const bounded=options(input),value=await work(bounded);options(bounded);return value;},
  assert:input=>options(input),
  snapshot:()=>({primaryDeadline,deadline:Number.isFinite(cap())?cap():null,stopping,aborted:controller.signal.aborted}),
 });
}
