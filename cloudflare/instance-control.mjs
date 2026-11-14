// Best-effort coordination inside one isolate. No global rate-limit guarantee.
export function createInstanceControl({request,now=Date.now}={}){
 let cached,expires=0,pendingRead,pendingWake,wakeResult,wakeUntil=0,cooldown=0,generation=0;
 const counts={statusRequests:0,wakeRequests:0,reads:0,writes:0,cacheHits:0,joinedReads:0,joinedWakes:0};
 async function call(method,body){
  if(now()<cooldown)throw Object.assign(Error('Provider cooldown'),{status:429,retryAfterSeconds:Math.ceil((cooldown-now())/1000)});
  counts[method==='GET'?'reads':'writes']++;
  try{return await request(method,body);}catch(error){cooldown=now()+1000*(error.retryAfterSeconds??15);throw error;}
 }
 async function read({fresh=false}={}){
  if(!fresh)counts.statusRequests++;
  if(cached&&now()<expires&&(!fresh||now()-cached.at<2000)){counts.cacheHits++;return{data:cached.data,source:'cache'};}
  if(pendingRead){counts.joinedReads++;return pendingRead;}
  const version=generation;
  const action=(async()=>{const data=await call('GET');if(!data?.instances)throw Error('Instance state unavailable');
   if(version===generation){cached={data,at:now()};expires=now()+(data.instances.actual_status==='running'?5000:15000);}
   return{data,source:'provider'};
  })();pendingRead=action;try{return await action;}catch(error){cooldown=Math.max(cooldown,now()+1000*(error.retryAfterSeconds??15));throw error;}finally{if(pendingRead===action)pendingRead=undefined;}
 }
 async function wake(){
  counts.wakeRequests++;
  if(pendingWake){counts.joinedWakes++;return pendingWake;}
  if(wakeResult&&now()<wakeUntil){counts.joinedWakes++;return wakeResult;}
  const action=(async()=>{
   const {data}=await read({fresh:true});if(data.instances.intended_status==='running')return{ok:true,queued:false};
   generation++;cached=undefined;expires=0;
   let result;try{result=await call('PUT',{state:'running'});}finally{generation++;cached=undefined;expires=0;}
   if(result.success===false){if(/resources.*unavailable|state change queued/iu.test(String(result.msg??result.error??'')))return{ok:false,queued:true,code:'CAPACITY_UNAVAILABLE',retryAfterSeconds:15};throw Error('Vast rejected the start');}
   if(result.success!==true)throw Error('Vast did not confirm the start');return{ok:true,queued:false};
  })();pendingWake=action;try{wakeResult=await action;wakeUntil=now()+15000;return wakeResult;}catch(error){cooldown=Math.max(cooldown,now()+1000*(error.retryAfterSeconds??15));throw error;}finally{if(pendingWake===action)pendingWake=undefined;}
 }
 return{read,wake,metrics:()=>({...counts,cooldownSeconds:Math.max(0,Math.ceil((cooldown-now())/1000))})};
}
