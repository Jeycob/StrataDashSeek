import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {confined,digest} from '../quality/core.mjs';
import {POLICY,WorkCard,archiveLog,summarizeLog,rewriteRisk,patchRemovals,prefixFingerprint} from './context.mjs';
import {EventLedger,uniqueEngineRecord} from './ledger.mjs';
import {FairGate,heavyTool,normalizeCompaction,sessionGateStatus} from './gate.mjs';
import {createTurnScheduler} from './turn-scheduler.mjs';
import {resourceSnapshot} from './resources.mjs';
import {bindHeavyToolLease} from './heavy-tool-lease.mjs';
import {checkWorkspaceHeavyAdmission} from './heavy-admission.mjs';
import {requireProjectExecutionMode} from '../workspace/execution-mode-service.mjs';

export const name='qwen-efficiency';
export const inject=['agents','tools','systemPrompt','shell','shellEnv','llm','sessionQuery','projectExecutionMode'];
const DIR=path.dirname(fileURLToPath(import.meta.url));
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const textOf=blocks=>(blocks??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
export function rootAgent(agent,agents){const seen=new Set();while(agent?.session?.header?.origin==='subagent'){if(seen.has(agent.id))throw Error('Agent ancestry cycle');seen.add(agent.id);agent=agents.get(agent.session.header.parentSession);}return agent;}
const fileArg=args=>args?.file_path??args?.path;

export async function apply(ctx,config={}){
  const mode=requireProjectExecutionMode(ctx),check=()=>mode.assertUnchanged();
  const providers=new Set(config.providers??['strata-vast']),cards=new Map(),grants=new Map(),runs=new Map(),pendingAccepted=new Map(),repairStarts=new Map(),projectCache=new Map(),rewriteDenials=new Map();
  const directory=config.stateDirectory??'/data/harness/state/efficiency';await fs.mkdir(directory,{recursive:true});check();
  const ledger=new EventLedger(path.join(directory,'events.jsonl'));
  const emit=(type,data)=>{try{return ledger.record(type,data);}catch{/* Metrics failure cannot change task outcome or release a gate. */}};
  const root=agent=>rootAgent(agent,ctx.agents),idOf=agent=>root(agent)?.session?.id;
  const card=id=>{if(!cards.has(id))cards.set(id,new WorkCard());return cards.get(id);};
  const hydrated=new Map();
  async function hydrate(id){
    if(!hydrated.has(id))hydrated.set(id,(async()=>{
      // Read canonical history once per loaded session, including requests that
      // compaction removed from the current model surface. Never use summaries
      // or a child agent's assignment as the owner's latest human request.
      const query=ctx.sessionQuery??ctx.get?.('sessionQuery');
      if(query){const saved=await query.readSession(id);check();card(id).observeMessages(saved.events.flatMap(e=>e.type==='user/message'?[e.data]:e.type==='agent/inbox/spliced'?e.data.inserted??[]:[]));}
    })().catch(error=>{hydrated.delete(id);throw error;}));
    await hydrated.get(id);
  }
  const review=async id=>{check();const value=await ctx.waterfall('workspace-runtime/review',{sessionId:id},()=>undefined);check();return value;};
  const projectFor=async id=>{if(!projectCache.has(id))projectCache.set(id,await review(id));return projectCache.get(id);};
  const activeFor=agent=>{const id=idOf(agent);return{id,runId:runs.get(id)??`${id}:unknown`};};
  const phase=(taskId,phase,start,end)=>emit('phase',{taskId,phase,start,end});
  const schedule=config.schedule!==false;
  const localProvider=provider=>provider==='strata-vast'&&providers.has(provider);
  const writeQueue=state=>{
    try{const file=config.statusPath??path.join(directory,'queue.json'),temp=file+'.'+process.pid+'.tmp';fssync.mkdirSync(path.dirname(file),{recursive:true});fssync.writeFileSync(temp,JSON.stringify({...state,updatedAt:new Date().toISOString(),implementation:'efficiency-turn-fifo-v1'}),{mode:0o600});fssync.renameSync(temp,file);}catch{}
  };
  const turnScheduler=createTurnScheduler(ctx.agents,writeQueue);
  const modelGate=new FairGate();
  const toolGate=new FairGate({capacity:config.maxHeavyTools??1});
  // Internal read for an already-authorized session; transport/UI owns access.
  // A live snapshot avoids reconstructing current work from historical metrics.
  ctx.on('efficiency/session-status',({sessionId})=>{
    check();const agent=ctx.agents.get(sessionId);if(!agent)return undefined;
    const id=idOf(agent);if(!id)return undefined;
    return{version:1,sessionId:id,enabled:schedule,model:sessionGateStatus(turnScheduler.snapshot(),id),heavyTools:sessionGateStatus(toolGate.snapshot(),id)};
  });
  // Preserve the legacy gate's output ceiling for resumed sessions.
  ctx.on('agent/request',async(_input,next)=>{
    const request=await next();check();if(!providers.has(request.provider))return request;
    return{...request,maxTokens:Math.min(request.maxTokens??32768,config.maxTokens??32768)};
  },{global:true});
  // Stable content only. All task paths/errors are appended as runtime context.
  ctx.systemPrompt.section({name:'efficiency:stable-work-policy',order:650,text:POLICY,interpolate:false});
  ctx.systemPrompt.context({name:'efficiency:work-card',order:230,text:assembly=>{const agent=assembly.agent??ctx.agents.get(assembly.scope?.id);const id=agent?idOf(agent):undefined;return id?cards.get(id)?.render()??'':'';},interpolate:false});

  ctx.on('agent/pre-step',async(input,next)=>{
    check();
    const {id}=activeFor(input.agent);
    if(providers.has(input.modelSelection.provider)){
      if(schedule&&localProvider(input.modelSelection.provider)){
        await turnScheduler.join(turnScheduler.start(input.agent.session,input.turn,true),input.signal);
      }
      check();
      await hydrate(id);
      if(input.agent.session.id===id)card(id).observeMessages(input.messages);
      await projectFor(id); // Root identity is stable; do not rescan all sources on every step.
    }
    check();return next();
  },{global:true});

  // Archive only command logs. File reads, user instructions and message history
  // are untouched; canonical value/error/exitCode remain executor-owned.
  ctx.on('tools/post-execute',async(exec,result,next)=>{
    const decision=await next();check();if(decision.kind!=='accept'||decision.content!==undefined||decision.value!==undefined)return decision;
    if(!['project_exec','bash','terminal'].includes(exec.name)||!exec.agent)return decision;
    const raw=textOf(result.content);if(raw.length<(config.logThreshold??8000))return decision;
    const {id}=activeFor(exec.agent),project=await projectFor(id);if(!project||project.legacy)return decision;
    check();let file;try{file=await archiveLog(project.root,raw);}catch{check();return decision;}check();if(!file)return decision;
    const c=card(id),hash=digest(raw),repeated=c.recentLogs.has(hash);c.recentLogs.add(hash);if(c.recentLogs.size>128)c.recentLogs.delete(c.recentLogs.values().next().value);
    const summary=`Tool status: isError=${result.isError}; exitCode=${result.value?.exitCode??'unavailable'}; timedOut=${result.value?.timedOut??false}\n`+summarizeLog(raw,file,{repeated});emit('log-compacted',{taskId:id,inputBytes:Buffer.byteLength(raw),outputBytes:Buffer.byteLength(summary),logPath:file,hash,repeated});
    let inserted=false;const content=result.content.flatMap(b=>b.type!=='text'?[b]:inserted?[]:(inserted=true,[{type:'text',text:summary}]));
    return{...decision,content};
  },{global:true});

  async function overwrite(exec){
    const args=exec.arguments;if(!['write','edit','apply_patch'].includes(exec.name))return null;
    mode.assertTool(exec);
    if(mode.snapshot.mode==='isolated-guest'){
      const decision=await ctx.waterfall('workspace-runtime/overwrite-admission',{execution:exec},()=>undefined);
      mode.assertTool(exec);
      if(decision?.allowed===true)return null;
      if(typeof decision?.denial?.reason==='string')return decision.denial;
      return{reason:'The isolated rewrite admission handler is unavailable; host inspection is refused.',info:{code:'PROJECT_EXECUTION_GUEST_REWRITE_UNAVAILABLE'}};
    }
    const operations=exec.name==='apply_patch'?patchRemovals(args?.patch??args?.input):(typeof fileArg(args)==='string'?[{path:fileArg(args)}]:[]);
    if(!operations.length)return null;
    const {id}=activeFor(exec.agent),project=await projectFor(id);check();if(!project||project.legacy)return null;
    const c=card(id);if(!c.verified&&!Object.keys(project.checkpoints??{}).length)return null;
    const authorized=[];
    for(const operation of operations){
    const relative=path.isAbsolute(operation.path)?path.relative(project.root,operation.path):operation.path;
    let name,before;try{name=await confined(project.root,relative);check();const stat=await fs.stat(name);check();if(!stat.isFile()||stat.size>1024*1024)continue;before=await fs.readFile(name,'utf8');check();}catch(error){check();if(error.code==='ENOENT')continue;throw error;}
    let after=args.content;
    if(exec.name==='edit'){
      const old=args.old_string??args.oldText,replacement=args.new_string??args.newText;
      if(typeof old!=='string'||typeof replacement!=='string'||!before.includes(old))continue;
      after=args.replace_all&&old?before.split(old).join(replacement):before.replace(old,replacement);
    }
    const lines=before.split(/\r?\n/u).length,removed=operation.deleted?lines:operation.removed;
    const large=exec.name==='apply_patch'?removed>=40&&removed/lines>.45:typeof after==='string'&&rewriteRisk(before,after).large;
    if(!large)continue;
    const hash=digest(before),key=`${id}:${name}`,grant=grants.get(key);
    if(grant?.hash!==hash)return{reason:`Large overwrite after a working milestone: ${relative}. Prefer a focused edit, or call explain_rewrite with this file hash, the concrete cause and regression-check plan: ${hash}`,info:{code:'REWRITE_EXPLANATION_REQUIRED'}};
    authorized.push({key,name,hash,grant});
    }
    check();for(const {key,name,hash,grant}of authorized){grants.delete(key);emit('large-rewrite-justified',{taskId:id,path:path.relative(project.root,name),hash,reason:grant.reason,validationPlan:grant.validationPlan});}
    return null;
  }
  ctx.on('tools/pre-execute',async(exec,next)=>{const decision=await next();mode.assertTool(exec);if(decision.kind==='allow'&&exec.agent){const denial=await overwrite(exec);mode.assertTool(exec);if(denial){rewriteDenials.set(exec.token,denial);return{kind:'deny',...denial};}}return decision;},{global:true});
  // Native guards are synchronous. The async precheck supplies a final monotonic denial.
  ctx.tools.guard(exec=>rewriteDenials.get(exec.token));

  ctx.on('tools/execute',async(exec,next)=>{
    if(!exec.agent)return next();const {id}=activeFor(exec.agent),queued=Date.now();let permit,started,release;
    try{mode.assertTool(exec);if(heavyTool(exec)){await checkWorkspaceHeavyAdmission(ctx,exec);if(config.schedule!==false){permit=await toolGate.acquire({rootId:id,sessionId:exec.agent.id,signal:exec.signal});phase(id,'tool-queue',queued,Date.now());}await checkWorkspaceHeavyAdmission(ctx,exec);mode.assertTool(exec);started=Date.now();if(permit)release=bindHeavyToolLease(exec,permit,()=>phase(id,'heavy-tools',started,Date.now()));}mode.assertTool(exec);started??=Date.now();return await next();}
    finally{phase(id,started===undefined?'tool-queue':'tools',started??queued,Date.now());if(release)release();else permit?.release();}
  },{global:true});
  ctx.on('tools/result',(exec,result)=>{
    rewriteDenials.delete(exec.token);
    try{check();}catch{return;}
    if(!exec.agent)return;const {id,runId}=activeFor(exec.agent),c=card(id),args=exec.arguments;
    if(['write','edit','apply_patch'].includes(exec.name)&&!result.isError){let file=fileArg(args)??'(patch)';const project=projectCache.get(id);if(project&&path.isAbsolute(file))file=path.relative(project.root,file);c.change(file);pendingAccepted.delete(id);emit('source-changed',{taskId:id});}
    if(exec.name==='verify_project'&&result.value){const r=result.value;c.verification(r,r.sourceHash);
      if(!r.passed){pendingAccepted.delete(id);emit('verification-failed',{taskId:id,runId});if(!repairStarts.has(id))repairStarts.set(id,Date.now());}
      else if(r.complete&&!r.stale){pendingAccepted.set(id,{hash:r.sourceHash,runId});if(repairStarts.has(id)){phase(id,'repair',repairStarts.get(id),Date.now());repairStarts.delete(id);}}
    }else{const key=exec.name+':'+digest(JSON.stringify(args??{})).slice(0,12);if(result.isError||Number.isInteger(result.value?.exitCode)&&result.value.exitCode!==0)c.failure(key,result.error?.message??textOf(result.content).slice(-700));else c.issues.delete(key);}
  },{global:true});

  async function metrics(){if(config.engineMetrics===false)return null;try{const u=new URL(config.engineURL??'http://127.0.0.1:8080');if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))return null;const r=await fetch(new URL('/metrics',u),{signal:AbortSignal.timeout(350)});return r.ok?await r.json():null;}catch{return null;}}
  ctx.on('llm/stream',function(options,next){
    check();
    if(!providers.has(options.provider))return next();
    const normalized=normalizeCompaction(options);if(normalized)return this.stream(normalized);
    let agent=options.sessionId?ctx.agents.get(String(options.sessionId)):undefined;
    if(!agent)try{const candidate=ctx.agents.currentInitiator?.();if(candidate&&ctx.agents.get(candidate.id)===candidate)agent=candidate;}catch{}
    const id=(agent&&idOf(agent))??String(options.sessionId??'@maintenance'),requestId=crypto.randomUUID();
    return(async function*(){
      const queued=Date.now();let permit,turnStream,started,firstToken,usage,finish,before;
      try{
        if(schedule){
          if(localProvider(options.provider)){
            turnStream=await turnScheduler.holdStream(agent?.session,id,requestId,options.signal);
          }
          permit=await modelGate.acquire({rootId:id,sessionId:String(options.sessionId??id),signal:options.signal});
        }
        check();phase(id,'model-queue',queued,Date.now());const observed=await Promise.all([metrics(),resourceSnapshot(path.dirname(directory))]);check();before=observed[0];started=Date.now();
        turnStream?.assertLive();
        emit('request-start',{taskId:id,requestId,provider:options.provider,model:options.model,purpose:options.purpose??'conversation',resources:observed[1],...prefixFingerprint(options)});
        for await(const chunk of await next()){
          check();
          if(firstToken===undefined&&['text-delta','reasoning-delta','tool-call-delta'].includes(chunk.type))firstToken=Date.now();
          if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')finish=chunk.reason.kind;
          yield chunk;
        }
      }finally{
        const ended=Date.now();try{
          if(started!==undefined){phase(id,'model',started,ended);const measured=uniqueEngineRecord(before,await metrics());
            emit('request-end',{taskId:id,requestId,started,ended,firstTokenMs:firstToken===undefined?null:firstToken-started,finish:finish??(options.signal?.aborted?'aborted':'interrupted'),engine:measured,engineCorrelation:measured?'unique-new-record-within-serialized-call':'unavailable-or-ambiguous'});
            if(usage)emit('usage',{taskId:id,requestId,...usage});
          }else phase(id,'model-queue',queued,ended);
        }finally{permit?.release();turnStream?.release();}
      }
    })();
  },{prepend:true,global:true});

  ctx.on('session/event',(session,event)=>{
    const agent=ctx.agents.get(session.id),id=agent?idOf(agent):session.id,child=id!==session.id;
    if(event.type==='turn/start'){
      if(schedule){
        const messageId=agent?.inbox?.nextTurn?.[0]?.id??
          agent?.inbox?.nextStep?.find(message=>message.role==='user'&&message.source?.kind==='user')?.id;
        turnScheduler.start(session,event.data.turn,localProvider(agent?.model?.current?.()?.provider),messageId);
      }
      const runId=`${session.id}:${event.data.turn}`;if(!child){runs.set(id,runId);pendingAccepted.delete(id);if(cards.get(id)?.issues.has('verification'))repairStarts.set(id,Date.now());}emit('turn-start',{taskId:id,runId,child});
    }
    if(event.type==='turn/end'){
      if(schedule)turnScheduler.end(session.id,event.data.turn);
      const runId=`${session.id}:${event.data.turn}`,at=Date.now(),candidate=child?undefined:pendingAccepted.get(id);if(!child)pendingAccepted.delete(id);emit('turn-end',{taskId:id,runId});
      if(!child&&repairStarts.has(id)){phase(id,'repair',repairStarts.get(id),at);repairStarts.delete(id);}
      if(candidate?.runId===runId)void review(id).then(current=>{check();if(current?.sourceHash===candidate.hash)emit('accepted',{taskId:id,runId,at,sourceHash:candidate.hash});else emit('source-changed',{taskId:id,at});}).catch(()=>{});
    }
  });
  if(schedule){
    ctx.on('agent/inbox/inserted',({agent,message})=>{
      if(localProvider(agent.model?.current?.()?.provider)&&agent.inbox?.nextTurn?.some(item=>item.id===message.id)){
        turnScheduler.reserveInbox(agent.session,message.id);
      }
    });
    ctx.on('agent/inbox/discarded',({agent,message})=>turnScheduler.discardInbox(agent.session.id,message.id));
    ctx.on('agent/status',({agent,status})=>{if(status==='idle')turnScheduler.finishSession(agent.session.id);});
    ctx.on('agent/disposed',({agent})=>turnScheduler.disposeSession(agent.session.id));
    ctx.on('session/disposed',session=>turnScheduler.disposeSession(session.id));
    ctx.on('efficiency/continuation-lease',(request,next)=>{check();return turnScheduler.continuationLease(request)??next();});
  }

  const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
  ctx.tools.register({name:'focus_context',description:'Get current task, unresolved checks, Git change summary and bounded relevant source excerpts from the isolated project. Prefer this to repeated full-file reads. Returned file hashes bind explain_rewrite to current content.',parameters:{type:'object',properties:{files:{type:'array',maxItems:6,items:{type:'object',properties:{path:{type:'string'},start:{type:'integer',minimum:1},lines:{type:'integer',minimum:1,maximum:120}},required:['path'],additionalProperties:false}}},additionalProperties:false},isConcurrencySafe:()=>true,output,async execute(args,exec){
    mode.assertTool(exec);
    if(mode.snapshot.mode==='isolated-guest'){
      const value=await ctx.waterfall('workspace-runtime/focus-context',{arguments:args,execution:exec},()=>undefined);mode.assertTool(exec);
      if(!value?.value||typeof value.value!=='object')throw Object.assign(Error('PROJECT_EXECUTION_GUEST_CONTEXT_UNAVAILABLE'),{code:'PROJECT_EXECUTION_GUEST_CONTEXT_UNAVAILABLE'});
      return value.value;
    }
    const {id}=activeFor(exec.agent),project=await review(id);if(!project||project.legacy)throw Error('Isolated project required.');if(ctx.shell.sandboxMode===undefined)throw Error('Project sandbox required.');
    const selected=args.files??card(id).changes.filter(x=>x!=='(patch)').slice(-3).map(p=>({path:p,lines:40}));
    const command='exec '+['/data/harness/node/bin/node','/data/harness/app/development/project-run.cjs','--','/data/harness/node/bin/node',path.join(DIR,'focus.mjs'),project.root,JSON.stringify({files:selected})].map(quote).join(' ');
    mode.assertTool(exec);const spec=ctx.shell.resolve({command,workdir:project.root,timeoutMs:10000,signal:exec.signal,dshEnv:ctx.shellEnv.collect(exec),sandboxPolicy:{mode:'workspace-write',workspaceRoot:project.root}});mode.assertTool(exec);const result=await(await ctx.shell.execute(spec)).result();mode.assertTool(exec);
    if(exec.signal.aborted)throw exec.signal.reason;if(result.exitCode!==0)throw Error('Context inspection failed: '+result.stdout.text.slice(-500));
    return{...card(id).snapshot(),...JSON.parse(result.stdout.text),sourceHash:project.sourceHash};
  }});
  ctx.tools.register({name:'explain_rewrite',description:'Before a large overwrite after a working milestone, record the concrete cause and regression-check plan. One use, exact project-relative path and current file SHA256 from focus_context. This is an agent explanation, not a user approval request.',parameters:{type:'object',properties:{path:{type:'string'},sha256:{type:'string'},reason:{type:'string',minLength:30,maxLength:1500},validationPlan:{type:'string',minLength:30,maxLength:1500}},required:['path','sha256','reason','validationPlan'],additionalProperties:false},isConcurrencySafe:()=>false,output,async execute(args,exec){
    mode.assertTool(exec);
    if(mode.snapshot.mode==='isolated-guest'){
      const value=await ctx.waterfall('workspace-runtime/explain-rewrite',{arguments:args,execution:exec},()=>undefined);mode.assertTool(exec);
      if(!value?.value||value.value.recorded!==true)throw Object.assign(Error('PROJECT_EXECUTION_GUEST_REWRITE_UNAVAILABLE'),{code:'PROJECT_EXECUTION_GUEST_REWRITE_UNAVAILABLE'});
      return value.value;
    }
    if(!/^[a-f0-9]{64}$/u.test(args.sha256)||typeof args.reason!=='string'||args.reason.length<30||typeof args.validationPlan!=='string'||args.validationPlan.length<30)throw Error('Current hash, concrete reason and verification plan are required.');
    const {id}=activeFor(exec.agent),project=await review(id);mode.assertTool(exec);if(!project||project.legacy)throw Error('Isolated project required.');const name=await confined(project.root,args.path);mode.assertTool(exec);const stat=await fs.stat(name);mode.assertTool(exec);if(!stat.isFile()||stat.size>1024*1024)throw Error('Bounded regular file required.');
    const hash=digest(await fs.readFile(name,'utf8'));mode.assertTool(exec);if(hash!==args.sha256)throw Error('File changed; refresh focus_context.');grants.set(`${id}:${name}`,{hash,reason:args.reason,validationPlan:args.validationPlan});return{recorded:true,path:args.path,sha256:hash,oneUse:true};
  }});
  ctx.effect(()=>()=>{turnScheduler.close();modelGate.close();toolGate.close();});
  if(schedule)writeQueue(turnScheduler.snapshot());
  check();await fs.writeFile(path.join(directory,'loaded.json'),JSON.stringify({at:Date.now(),pid:process.pid,scheduler:schedule?'turn-fifo':'observe-only',maxModelStreams:1,maxHeavyTools:toolGate.capacity}),{mode:0o600});check();
}
