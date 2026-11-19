// Explicit owner recovery for an already completed, progress-only turn.
// This component reads the existing workspace manager; it never constructs one
// or writes its registry, budgets, project files, or historical session events.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {shouldContinue} from './completion-guard.mjs';
import {sameRequestOrigin,boundedJSON} from '../workspace/http.mjs';

export const name='homeai-continue-incomplete';
export const inject=['agents','sessions','sessionQuery','sessionProjections','jobs','connection'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code,status:409});};
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const sameMessage=(a,b)=>a?.id===b?.id&&hash(a)===hash(b);
const terminalJobs=new Set(['completed','failed','killed']);
const copy=value=>structuredClone(value);
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function bounded(action,signal){
  signal.throwIfAborted();let abort;
  const interrupted=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return action();}),interrupted]);}
  finally{signal.removeEventListener('abort',abort);}
}

async function readJSON(file,limit){
  const info=await fs.lstat(file);need(info.isFile()&&!info.isSymbolicLink()&&info.size<=limit,'CONTINUE_STATE_FILE_INVALID');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const actual=await handle.stat();need(actual.isFile()&&actual.size<=limit&&actual.dev===info.dev&&actual.ino===info.ino,'CONTINUE_STATE_FILE_CHANGED');const data=await handle.readFile();need(data.length<=limit,'CONTINUE_STATE_FILE_TOO_LARGE');return JSON.parse(data.toString('utf8'));}
  finally{await handle.close();}
}
async function syncDirectory(directory){
  if(process.platform==='win32')return;
  const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}
}
async function saveJournal(file,value,exclusive=false,signal){
  signal?.throwIfAborted();
  const temporary=exclusive?file:file+'.'+randomUUID()+'.tmp',handle=await fs.open(temporary,'wx',0o600);
  try{signal?.throwIfAborted();await handle.writeFile(JSON.stringify(value)+'\n');signal?.throwIfAborted();await handle.sync();}finally{await handle.close();}
  signal?.throwIfAborted();
  if(!exclusive)await fs.rename(temporary,file);
  signal?.throwIfAborted();
  await syncDirectory(path.dirname(file));
}
function history(events,nextSeq){
  need(Array.isArray(events)&&events.length===nextSeq&&events.length<=16384&&Buffer.byteLength(JSON.stringify(events))<=8*1024*1024&&events.every((e,i)=>e?.seq===i),'CONTINUE_HISTORY_INCOMPLETE');
  return events;
}
export function completedProgressProof(events,expectedTurnEndSeq,providers=new Set(['strata-vast'])){
  const end=events.at(expectedTurnEndSeq);
  need(end?.type==='turn/end'&&end.data?.reason?.kind==='completed'&&Number.isSafeInteger(end.data.turn),'CONTINUE_NOT_COMPLETED');
  need(events.slice(expectedTurnEndSeq+1).every(e=>e.type==='session/end-seed'&&e.data&&Object.keys(e.data).length===0),'CONTINUE_HISTORY_CHANGED');
  const start=events.findLast(e=>e.seq<end.seq&&e.type==='turn/start');
  need(start?.data?.turn===end.data.turn,'CONTINUE_TURN_CHANGED');
  const rows=events.slice(start.seq,end.seq),messages=rows.filter(e=>e.type==='assistant/message'),tools=rows.filter(e=>e.type==='tool/result'),last=messages.at(-1);
  const continuations=rows.filter(e=>e.type==='user/message'&&e.data?.source?.kind==='homeai-completion-guard').length;
  const hitTokenLimit=messages.some(e=>['length','max-tokens'].includes(e.data.message?.source?.replayState?.response?.stopReason));
  need(tools.at(-1)?.seq<last?.seq&&shouldContinue({turn:end.data.turn,tools:tools.length,lastToolFailed:tools.at(-1)?.data?.message?.isError!==false,hitTokenLimit,continuations,message:last?.data?.message},{turn:end.data.turn,inbox:{nextStep:[],nextTurn:[]},providers,maxContinuations:2}),'CONTINUE_NOT_PROGRESS_ONLY');
  const human=events.findLast(e=>e.type==='user/message'&&e.data?.role==='user'&&e.data.source?.kind==='user');
  need(human&&typeof human.data.id==='string'&&human.seq<end.seq,'CONTINUE_HUMAN_TASK_UNAVAILABLE');
  return{turn:end.data.turn,humanMessageId:human.data.id,historyHash:hash(events),lastAssistantSeq:last.seq};
}
// Inspect real SDK insertion/claim/removal, never fabricate an acknowledgement.
function acceptance(events,intent,inbox){
  need(hash(events.slice(0,intent.baselineSeq))===intent.historyHash,'CONTINUE_HISTORY_PREFIX_CHANGED');
  const tail=events.slice(intent.baselineSeq),insertions=tail.filter(e=>e.type==='agent/inbox/spliced'&&e.data?.inserted?.some(m=>sameMessage(m,intent.message)));
  need(insertions.length<=1,'CONTINUE_DUPLICATE_ADMISSION');
  const consumed=tail.some(e=>e.type==='user/message'&&sameMessage(e.data,intent.message));
  const queued=[...inbox.nextTurn,...inbox.nextStep].some(m=>sameMessage(m,intent.message));
  return{accepted:insertions.length===1&&(consumed||queued),state:consumed?'consumed':queued?'queued':insertions.length?'withdrawn':'unknown',insertSeq:insertions[0]?.seq};
}

export function createIncompleteContinuation(ctx,config={}){
  const registryPath=config.registryPath??'/data/harness/state/workbench/registry.json',journalRoot=config.journalRoot??'/data/harness/state/incomplete-continuations';
  need(path.isAbsolute(registryPath)&&path.isAbsolute(journalRoot),'CONTINUE_CONFIG_INVALID');
  const timeoutMs=config.timeoutMs??12000;need(Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=12000,'CONTINUE_CONFIG_INVALID');
  const providers=new Set(config.providers??['strata-vast']),flights=new Map(),denied=new Set(),epoch=randomUUID();
  // Actual SDK agent/pre-step.messages contains ONLY the newly claimed inbox
  // batch, not conversation history. Prepend this gate ahead of workspace
  // accounting so a failed native queue withdrawal cannot run an orphan input.
  const removeGate=ctx.on('agent/pre-step',async(input,next)=>{
    const drop=[],human=(input.messages??[]).some(message=>message?.role==='user'&&message.source?.kind==='user');
    for(const message of input.messages??[]){
      const marker=message?.source?.homeaiContinuation;if(message?.source?.kind!=='workspace-runtime'||!marker)continue;
      // Current genuine human input supersedes this internal continuation.
      // Dropping only our exact notice preserves the normal owner's new task.
      if(human){drop.push(message);continue;}
        need(marker.epoch===epoch&&identifier(marker.requestId)&&Number.isSafeInteger(marker.expectedTurnEndSeq)&&marker.expectedTurnEndSeq>=0&&!denied.has(message.id),'CONTINUE_ADMISSION_UNCONFIRMED');
        const signal=AbortSignal.any([input.signal,AbortSignal.timeout(timeoutMs)]),file=path.join(journalRoot,hash([input.agent.id,marker.expectedTurnEndSeq])+'.json');
        const intent=await bounded(()=>readJSON(file,128*1024),signal);
        need(intent.epoch===epoch&&intent.sessionId===input.agent.id&&intent.requestId===marker.requestId&&intent.expectedTurnEndSeq===marker.expectedTurnEndSeq&&input.turn===intent.previousTurn+1&&intent.state==='accepted'&&intent.receipt?.accepted===true&&intent.messageHash===hash(message)&&sameMessage(intent.message,message),'CONTINUE_ADMISSION_UNCONFIRMED');
    }
    // A new human steering message may share this claimed batch. Run all normal
    // downstream gates and retain that input, dropping only our rejected notice
    // from the actual admission decision. Never replay or rewrite either log.
    const decision=await next();
    return drop.length&&decision.kind==='enter'?{...decision,messages:decision.messages.filter(message=>!drop.some(owned=>sameMessage(owned,message)))}:decision;
  },{prepend:true,global:true});
  async function durableHistory(agent,signal){need(await bounded(()=>ctx.sessions.flush(agent.session),signal)===true,'CONTINUE_HISTORY_FLUSH_UNCONFIRMED');const saved=await bounded(()=>ctx.sessionQuery.readSession(agent.id),signal);return history(saved?.events,agent.session.seq);}
  async function recover(request,requestSignal){
    need(request&&Object.keys(request).sort().join(',')==='expectedTurnEndSeq,requestId,sessionId'&&identifier(request.sessionId)&&identifier(request.requestId)&&Number.isSafeInteger(request.expectedTurnEndSeq)&&request.expectedTurnEndSeq>=0,'CONTINUE_REQUEST_INVALID');
    const key=hash([request.sessionId,request.expectedTurnEndSeq]),existing=flights.get(key);
    if(existing){need(existing.requestId===request.requestId,'CONTINUE_REQUEST_CONFLICT');return existing.promise;}
    const promise=run(request,key,requestSignal);flights.set(key,{requestId:request.requestId,promise});
    try{return await promise;}finally{if(flights.get(key)?.promise===promise)flights.delete(key);}
  }
  async function run(request,key,requestSignal){
    requestSignal?.throwIfAborted();
    const operationSignal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(requestSignal?[requestSignal]:[])]);
    const {sessionId:id,requestId,expectedTurnEndSeq}=request,agent=ctx.agents.get(id);
    need(agent&&agent.session.header.origin!=='subagent'&&typeof agent.runMaintenance==='function','CONTINUE_OWNER_UNAVAILABLE');
    await bounded(()=>fs.mkdir(journalRoot,{recursive:true,mode:0o700}),operationSignal);need(await bounded(()=>fs.realpath(journalRoot),operationSignal)===path.resolve(journalRoot),'CONTINUE_JOURNAL_PATH_INVALID');
    const file=path.join(journalRoot,key+'.json');let prior;
    try{prior=await bounded(()=>readJSON(file,128*1024),operationSignal);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(prior){
      need(prior.version===1&&prior.requestId===requestId&&prior.sessionId===id&&prior.expectedTurnEndSeq===expectedTurnEndSeq&&hash(prior.message)===prior.messageHash,'CONTINUE_REQUEST_CONFLICT');
      // Even an intent with no observed insertion may have crashed at dispatch.
      // Every existing journal is readback-only, including while work is active.
      const observed=acceptance(await durableHistory(agent,operationSignal),prior,agent.inbox);
      if(prior.epoch!==epoch&&observed.state==='queued')return{requestId,sessionId:id,expectedTurnEndSeq,accepted:false,state:'previous-instance-pending',reconciled:true};
      return{requestId,sessionId:id,expectedTurnEndSeq,...observed,reconciled:true};
    }
    return agent.runMaintenance(async maintenanceSignal=>{
      const signal=AbortSignal.any([maintenanceSignal,operationSignal]);
      let intent,claimed=false,inserted=false,listener=()=>{},withdrawn=false,withdrawalFailed=false;
      const current=()=>{signal.throwIfAborted();need(ctx.agents.get(id)===agent&&agent.status==='idle','CONTINUE_OWNER_CHANGED');};
      const quiet=(own=false)=>{current();need(Array.isArray(agent.inbox.nextTurn)&&Array.isArray(agent.inbox.nextStep)&&agent.inbox.nextStep.length===0&&agent.inbox.nextTurn.length<=(own?1:0)&&agent.inbox.nextTurn.every(m=>own&&intent&&sameMessage(m,intent.message)),'CONTINUE_PENDING_INPUT');};
      const resources=()=>{
        const jobs=ctx.jobs.list(id),projection=ctx.sessionProjections.snapshot(agent.session,['subagentCatalog']),terminal=ctx.get('terminalController');
        need(Array.isArray(jobs)&&jobs.length<=128&&jobs.every(j=>typeof j?.owner==='string')&&!jobs.some(j=>j.owner===id&&!terminalJobs.has(j.status)),'CONTINUE_ACTIVE_JOBS');
        need(projection?.asOfSeq===agent.session.seq-1&&Array.isArray(projection.values?.subagentCatalog)&&projection.values.subagentCatalog.length===0,'CONTINUE_ACTIVE_CHILDREN');
        need(typeof terminal?.list==='function'&&Array.isArray(terminal.list(id))&&terminal.list(id).length===0,'CONTINUE_ACTIVE_TERMINALS');
        const local=ctx.get('terminals');if(local)need(typeof local.hasOwnerActivity==='function'&&local.hasOwnerActivity(agent)===false&&Array.isArray(local.list(agent))&&local.list(agent).length===0,'CONTINUE_ACTIVE_TERMINALS');
      };
      const inspect=async()=>{
        quiet();resources();
        const review=await bounded(()=>ctx.waterfall('workspace-runtime/review',{sessionId:id},()=>undefined),signal);quiet();
        const registry=await bounded(()=>readJSON(registryPath,16*1024*1024),signal),record=registry.sessions?.[id],budget=review?.budget,a=budget?.automatic;quiet();
        need(review&&review.sessionId===id&&!review.legacy&&typeof review.root==='string'&&/^[a-f0-9]{64}$/.test(review.sourceHash??'')&&!review.restoreRecovery?.pending&&record&&!record.legacy&&!registry.trash?.[id]&&record.root===review.root&&hash(record.budget)===hash(budget),'CONTINUE_WORKSPACE_CHANGED');
        need(budget&&!budget.blocked&&a?.phase==='working'&&!a.uncertain&&!a.activeCallId&&!a.continuationNeeded&&!a.operation?.cancelledByCaller&&!['pending','blocked'].includes(a.recovery?.state)&&!['intent','dispatching','unknown'].includes(a.continuation?.state),'CONTINUE_WORK_UNRESOLVED');
        const events=await durableHistory(agent,signal);quiet();const proof=completedProgressProof(events,expectedTurnEndSeq,providers);
        for(const task of [record.automaticRequest,record.budgetRequest])need(task?.messageId===proof.humanMessageId&&Number.isSafeInteger(task.turn)&&task.turn>0&&task.turn<=proof.turn,'CONTINUE_ORIGINAL_TASK_CHANGED');
        return{review,budgetHash:hash(budget),tasksHash:hash([record.automaticRequest,record.budgetRequest]),proof,events};
      };
      const withdraw=()=>{if(intent&&inserted){denied.add(intent.message.id);try{const own=agent.inbox.nextTurn.find(m=>sameMessage(m,intent.message));if(own){agent.inbox.remove(own.id);withdrawn=true;}}catch{withdrawalFailed=true;}}};
      try{
        const before=await inspect();quiet();
        const message={id:randomUUID(),role:'user',source:{kind:'workspace-runtime',homeaiContinuation:{epoch,requestId,expectedTurnEndSeq}},content:[{type:'text',text:'The owner requested continuation of the SAME unfinished task after a progress-only response ended the previous turn. Continue from the retained files and original requirements; preserve the existing work accounting. Perform the next concrete implementation step you announced, then verify the requested result. Do not redo the completed probe or invent a new task. If a real blocker requires an owner decision, explain it and stop.'}]};
        intent={version:1,epoch,requestId,sessionId:id,expectedTurnEndSeq,previousTurn:before.proof.turn,state:'intent',baselineSeq:agent.session.seq,historyHash:before.proof.historyHash,budgetHash:before.budgetHash,tasksHash:before.tasksHash,humanMessageId:before.proof.humanMessageId,sourceHash:before.review.sourceHash,root:before.review.root,message,messageHash:hash(message),createdAt:Date.now()};
        await bounded(()=>saveJournal(file,intent,true,signal),signal);claimed=true;quiet();
        const fresh=await inspect();need(fresh.proof.historyHash===intent.historyHash&&fresh.budgetHash===intent.budgetHash&&fresh.tasksHash===intent.tasksHash&&fresh.review.root===intent.root&&fresh.review.sourceHash===intent.sourceHash,'CONTINUE_SOURCE_CHANGED');
        intent.state='dispatching';await bounded(()=>saveJournal(file,intent,false,signal),signal);quiet();resources();
        need(agent.session.seq===intent.baselineSeq&&hash(fresh.review.budget)===intent.budgetHash,'CONTINUE_STATE_CHANGED');
        listener=withdraw;signal.addEventListener('abort',listener,{once:true});signal.throwIfAborted();
        // The only dispatch. Maintenance holds the real SDK's wake/claim until
        // durable insertion is verified; no external or synthetic receipt.
        inserted=true;agent.followup(message);
        const events=await durableHistory(agent,signal);quiet(true);resources();
        const observed=acceptance(events,intent,agent.inbox);need(observed.accepted&&observed.state==='queued'&&events.length===intent.baselineSeq+1&&hash(fresh.review.budget)===intent.budgetHash,'CONTINUE_ADMISSION_UNCONFIRMED');
        intent.state='accepted';intent.receipt={...observed,at:Date.now()};await bounded(()=>saveJournal(file,intent,false,signal),signal);quiet(true);
        return{requestId,sessionId:id,expectedTurnEndSeq,...observed,reconciled:false};
      }catch(error){
        // runMaintenance wakes queued input even when its callback rejects.
        // Withdraw only our exact message; leave any new human input intact.
        withdraw();
        const cleanupSignal=AbortSignal.timeout(1000);
        if(intent&&claimed){intent.state=signal.aborted?'cancelled':'unknown';intent.failureCode=error.code??'CONTINUE_UNCONFIRMED';intent.withdrawn=withdrawn;intent.withdrawalFailed=withdrawalFailed;
          if(withdrawn)try{intent.withdrawalFlushed=await bounded(()=>ctx.sessions.flush(agent.session),cleanupSignal)===true;}catch{}
          try{await bounded(()=>saveJournal(file,intent,false,cleanupSignal),cleanupSignal);}catch{}
        }
        throw error;
      }finally{signal.removeEventListener('abort',listener);}
    });
  }
  return{recover,dispose:removeGate};
}

export function apply(ctx,config={}){
  const continuation=createIncompleteContinuation(ctx,config),disposed=new AbortController();
  ctx.effect(()=>()=>disposed.abort());
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/homeai/continue-incomplete',methods:['POST'],requestBody:'buffered',fetch:async request=>{
    if(!sameRequestOrigin(request))return reply({code:'ORIGIN_REFUSED'},403);
    try{return reply(await continuation.recover(await boundedJSON(request,2048),AbortSignal.any([request.signal,disposed.signal])));}
    catch(error){return reply({code:error.code??'CONTINUE_UNCONFIRMED'},error.status??409);}
  }}));
}
