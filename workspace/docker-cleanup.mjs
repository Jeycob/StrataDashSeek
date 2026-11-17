// Authenticated owner Settings and post-durability archive follow-up.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {sameRequestOrigin,boundedJSON} from './http.mjs';
const {atomicJson}=createRequire(import.meta.url)('../mobile/private-json.cjs');
const fail=code=>Object.assign(Error(code),{code,status:409});
const pending=op=>op&&['running','reconciliation_required'].includes(op.state);
async function json(file){const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>16*1024**2)throw fail('CLEANUP_UNAVAILABLE');return JSON.parse(await fs.readFile(file,'utf8'));}
export function registryBarrier(registry,readOperation){
 if(typeof registry.enqueueOperation!=='function')throw fail('CLEANUP_UNAVAILABLE');
 // Pinned rc.2 registry write queue covers native archive/unarchive/move too.
 const original=registry.enqueueOperation,run=original.bind(registry);
 const wrapped=function(action){return run(async()=>{if(pending(await readOperation()))throw fail('CLEANUP_RECONCILIATION_REQUIRED');return action();});};
 registry.enqueueOperation=wrapped;
 return{run,dispose(){if(registry.enqueueOperation===wrapped)registry.enqueueOperation=original;}};
}
export async function captureAuthority(ctx,manager){
 const headers=(await ctx.sessionPersistence.list()).map(x=>x.header),sessions=[],activityIds=[];
 for(const h of headers){const p=manager.data.sessions[h.id];let root=p?.root||h.cwd,managed=false;
  if(p?.root&&!p.legacy&&!p.nativeWorktree)try{root=await fs.realpath(p.root);const marker=await json(path.join(root,'.harness/project.json'));managed=root===p.root&&marker.root===root&&marker.sessionId===h.id&&[p.root,p.sourceRoot].includes(h.cwd);}catch{}
  if(typeof ctx.waterfall!=='function')throw fail('CLEANUP_UNAVAILABLE');const activity=await ctx.waterfall('workspace/session-activity',{sessionId:h.id},()=>Promise.resolve([]));if(!Array.isArray(activity))throw fail('CLEANUP_UNAVAILABLE');if(activity.length)activityIds.push(h.id);
  sessions.push({id:h.id,root,managed,parentSession:h.parentSession||null,...(typeof h.title==='string'?{title:h.title.slice(0,160)}:{})});
 }
 sessions.sort((a,b)=>a.id.localeCompare(b.id));return{sessions,archivedIds:[...ctx.workspaceRegistry.archivedSessionIds].sort(),pinnedIds:[...ctx.workspaceRegistry.pinnedSessionIds].sort(),activeIds:[...new Set([...activityIds,...ctx.agents.list().filter(a=>a.status==='running').map(a=>a.id)])].sort(),workspaceRefs:ctx.workspaceRegistry.list().map(w=>({id:w.id,path:w.path,sessionIds:[...w.sessionIds].sort()})).sort((a,b)=>a.id.localeCompare(b.id))};
}
export function installDockerCleanup(ctx,manager,appsConfig,callApps){
 if(!appsConfig)return;
 const journal=path.join(appsConfig.stateDir||'/data/harness/state/applications','archived-docker-cleanup.json'),authorityFile=path.join(manager.root,'docker-cleanup-authority.json');
 const readOperation=async()=>{try{return(await json(journal)).operation;}catch(e){if(e.code==='ENOENT')return null;throw e;}};
 const barrier=registryBarrier(ctx.workspaceRegistry,readOperation);let running=null,closed=false,timer;
 const rpc=input=>callApps('/archived-cleanup',input,{...appsConfig,timeoutMs:180000});
 const view=value=>({...value,operation:value.operation?{...Object.fromEntries(['id','state','startedAt','finishedAt','results','trigger','errorCode'].map(k=>[k,value.operation[k]])),planId:value.operation.planId??null,planHash:value.operation.planHash??null,selection:value.operation.selection??null}:null});
 // Consistent lock order: workbench queue BEFORE registry queue. Trash itself
 // takes these in that order; the opposite order would deadlock on detach.
 async function gated(action,reserve=[]){return manager.inOrder(()=>barrier.run(async()=>{
  if(closed)throw fail('CLEANUP_UNAVAILABLE');const token=crypto.randomBytes(16).toString('hex'),snapshot=await captureAuthority(ctx,manager);
  snapshot.activeIds=[...new Set([...snapshot.activeIds,...ctx.agents.list().filter(a=>a.status==='running').map(a=>a.id)])].sort();
  atomicJson(authorityFile,{version:1,token,pid:process.pid,expiresAt:Date.now()+300000,...snapshot,reservedIds:reserve});
  try{return await action(token);}finally{try{const current=await json(authorityFile);if(current.token===token)await fs.unlink(authorityFile);}catch(e){if(e.code!=='ENOENT')throw e;}}
 }));}
 async function runAuto(trigger){if(closed||running)return running;running=(async()=>{
  const preferences=await rpc({op:'preferences'});if(!preferences.enabled||preferences.availability!=='ready')return;
  await gated(async token=>{const current=await readOperation();if(pending(current))return rpc({op:'reconcile',token,operationId:current.id});const preview=await rpc({op:'preview',token,automatic:true});if(preview.availability!=='ready'||!preview.plan?.selection.length)return preview;const grant=await json(authorityFile),fresh=await captureAuthority(ctx,manager);fresh.activeIds=[...new Set([...fresh.activeIds,...ctx.agents.list().filter(a=>a.status==='running').map(a=>a.id)])].sort();atomicJson(authorityFile,{...grant,...fresh,reservedIds:preview.plan.rows.filter(r=>preview.plan.selection.some(x=>x.kind===r.kind&&x.id===r.id)).flatMap(r=>r.sessionIds)});return rpc({op:'apply',token,trigger,planId:preview.plan.id,planHash:preview.plan.hash,selections:preview.plan.selection});});
 })().catch(()=>ctx.logger?.warn('Archived Docker cleanup deferred; resources retained.')).finally(()=>{running=null;});return running;}
 // SDK event is inside its existing write queue, AFTER archive persistence.
 // Register and return: no I/O or nested queue wait in the callback itself.
 ctx.on('workspace/session-archived',()=>{setImmediate(()=>{void runAuto('archive');});});
 ctx.on('workspace/session-unarchiving',async()=>{if(pending(await readOperation()))throw fail('CLEANUP_RECONCILIATION_REQUIRED');});
 // Reserve the selected session family before Apps receives a deletion request.
 // A new manual turn in an unarchived chat cannot slip between snapshot and
 // DELETE. Already-running agents are captured above and KEEP their resources.
 const owner=ctx.root??ctx;
 const guardExecution=async(input,next)=>{const id=input.agent?.id;let reserved=[];try{const grant=await json(authorityFile);if(grant.expiresAt>Date.now())reserved=grant.reservedIds||[];}catch(e){if(e.code!=='ENOENT')throw e;}const op=await readOperation();if(id&&(reserved.includes(id)||pending(op)&&op.ownerSessionIds?.includes(id)))throw fail('CLEANUP_RECONCILIATION_REQUIRED');return next();};
 const removeStep=owner.on('agent/pre-step',guardExecution,{prepend:true,global:true}),removeTool=owner.on('tools/execute',guardExecution,{prepend:true,global:true});ctx.effect(()=>()=>{removeStep?.();removeTool?.();});
 const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/workbench/docker-cleanup',methods:['GET','POST'],requestBody:'buffered',fetch:async request=>{
  try{
   if(request.method==='GET'){const params=new URL(request.url).searchParams,selector=Object.fromEntries(['operationId','planId'].filter(k=>params.has(k)).map(k=>[k,params.get(k)]));if(Object.keys(selector).length)return response(view(await gated(token=>rpc({op:'reconcile',token,...selector}))));return response(view(await gated(token=>rpc({op:'status',token}))));}
   if(!sameRequestOrigin(request))return response({code:'ORIGIN_REFUSED',error:'Same-origin request required.'},403);
   const data=await boundedJSON(request,16384);if(!data||typeof data!=='object'||Array.isArray(data)||!['settings','preview','apply'].includes(data.op))throw Object.assign(fail('CLEANUP_REQUEST_INVALID'),{status:400});
   if(data.op==='settings')return response(view(await rpc({op:'settings',enabled:data.enabled})));
   let reserve=[];if(data.op==='apply'){const control=await json(journal),plan=control.plans?.[data.planId],receipt=control.receipts?.[data.planId];if(!plan&&!receipt||!Array.isArray(data.selections))throw fail('CLEANUP_PLAN_STALE');if(!receipt)reserve=plan.rows.filter(r=>data.selections.some(x=>x.kind===r.kind&&x.id===r.id)).flatMap(r=>r.sessionIds);}
   return response(view(await gated(token=>rpc({op:data.op,token,...(data.op==='preview'?{selections:data.selections}:{planId:data.planId,planHash:data.planHash,selections:data.selections,trigger:'manual'})}),reserve)));
  }catch(e){return response({code:e.code||'CLEANUP_UNAVAILABLE',error:e.code||'Cleanup unavailable'},e.status||503);}
 }}));
 // Existing housekeeping cadence; recovers missed events after either restart.
 timer=setInterval(()=>{void runAuto('periodic');},60000);timer.unref?.();setImmediate(()=>{void runAuto('periodic');});
 ctx.effect(()=>async()=>{closed=true;clearInterval(timer);await running;barrier.dispose();});return{runAuto};
}
