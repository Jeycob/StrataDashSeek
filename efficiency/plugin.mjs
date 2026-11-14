import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {confined,digest} from '../quality/core.mjs';
import {POLICY,WorkCard,archiveLog,summarizeLog,rewriteRisk,prefixFingerprint} from './context.mjs';
import {EventLedger,uniqueEngineRecord} from './ledger.mjs';
import {FairGate,heavyTool,normalizeCompaction} from './gate.mjs';

export const name='qwen-efficiency';
export const inject=['agents','tools','systemPrompt','shell','shellEnv','llm'];
const DIR=path.dirname(fileURLToPath(import.meta.url));
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const textOf=blocks=>(blocks??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
export function rootAgent(agent,agents){const seen=new Set();while(agent?.session?.header?.origin==='subagent'){if(seen.has(agent.id))throw Error('Agent ancestry cycle');seen.add(agent.id);agent=agents.get(agent.session.header.parentSession);}return agent;}
const fileArg=args=>args?.file_path??args?.path;

export async function apply(ctx,config={}){
  const providers=new Set(config.providers??['strata-vast']),cards=new Map(),grants=new Map(),runs=new Map(),pendingAccepted=new Map(),repairStarts=new Map(),projectCache=new Map(),rewriteDenials=new Map();
  const directory=config.stateDirectory??'/data/harness/state/efficiency';await fs.mkdir(directory,{recursive:true});
  const ledger=new EventLedger(path.join(directory,'events.jsonl'));
  const emit=(type,data)=>{try{return ledger.record(type,data);}catch{/* Metrics failure cannot change task outcome or release a gate. */}};
  const root=agent=>rootAgent(agent,ctx.agents),idOf=agent=>root(agent)?.session?.id;
  const card=id=>{if(!cards.has(id))cards.set(id,new WorkCard());return cards.get(id);};
  const review=id=>ctx.waterfall('workspace-runtime/review',{sessionId:id},()=>undefined);
  const projectFor=async id=>{if(!projectCache.has(id))projectCache.set(id,await review(id));return projectCache.get(id);};
  const activeFor=agent=>{const id=idOf(agent);return{id,runId:runs.get(id)??`${id}:unknown`};};
  const phase=(taskId,phase,start,end)=>emit('phase',{taskId,phase,start,end});
  const modelGate=new FairGate({onChange:state=>{
    try{const file=config.statusPath??path.join(directory,'queue.json'),temp=file+'.'+process.pid+'.tmp';fssync.mkdirSync(path.dirname(file),{recursive:true});fssync.writeFileSync(temp,JSON.stringify({...state,updatedAt:new Date().toISOString(),implementation:'efficiency-request-v1'}),{mode:0o600});fssync.renameSync(temp,file);}catch{}
  }});
  const toolGate=new FairGate({capacity:config.maxHeavyTools??1});
  // Stable content only. All task paths/errors are appended as runtime context.
  ctx.systemPrompt.section({name:'efficiency:stable-work-policy',order:650,text:POLICY,interpolate:false});
  ctx.systemPrompt.context({name:'efficiency:work-card',order:230,text:assembly=>{const agent=assembly.agent??ctx.agents.get(assembly.scope?.id);const id=agent?idOf(agent):undefined;return id?cards.get(id)?.render()??'':'';},interpolate:false});

  ctx.on('agent/pre-step',async(input,next)=>{
    const {id}=activeFor(input.agent);
    if(providers.has(input.modelSelection.provider)){
      const task=input.messages?.filter(m=>m.source?.kind==='user').map(m=>textOf(m.content)).join('\n');if(task)card(id).setTask(task);
      await projectFor(id); // Root identity is stable; do not rescan all sources on every step.
    }
    return next();
  },{global:true});

  // Archive only command logs. File reads, user instructions and message history
  // are untouched; canonical value/error/exitCode remain executor-owned.
  ctx.on('tools/post-execute',async(exec,result,next)=>{
    const decision=await next();if(decision.kind!=='accept'||decision.content!==undefined||decision.value!==undefined)return decision;
    if(!['project_exec','bash','terminal'].includes(exec.name)||!exec.agent)return decision;
    const raw=textOf(result.content);if(raw.length<(config.logThreshold??8000))return decision;
    const {id}=activeFor(exec.agent),project=await projectFor(id);if(!project||project.legacy)return decision;
    let file;try{file=await archiveLog(project.root,raw);}catch{return decision;}if(!file)return decision;
    const c=card(id),hash=digest(raw),repeated=c.recentLogs.has(hash);c.recentLogs.add(hash);if(c.recentLogs.size>128)c.recentLogs.delete(c.recentLogs.values().next().value);
    const summary=`Tool status: isError=${result.isError}; exitCode=${result.value?.exitCode??'unavailable'}; timedOut=${result.value?.timedOut??false}\n`+summarizeLog(raw,file,{repeated});emit('log-compacted',{taskId:id,inputBytes:Buffer.byteLength(raw),outputBytes:Buffer.byteLength(summary),logPath:file,hash,repeated});
    let inserted=false;const content=result.content.flatMap(b=>b.type!=='text'?[b]:inserted?[]:(inserted=true,[{type:'text',text:summary}]));
    return{...decision,content};
  },{global:true});

  async function overwrite(exec){
    const args=exec.arguments;if(!['write','edit'].includes(exec.name)||typeof fileArg(args)!=='string')return null;
    const {id}=activeFor(exec.agent),project=await projectFor(id);if(!project||project.legacy)return null;
    const c=card(id);if(!c.verified&&!Object.keys(project.checkpoints??{}).length)return null;
    const relative=path.isAbsolute(fileArg(args))?path.relative(project.root,fileArg(args)):fileArg(args);
    let name,before;try{name=await confined(project.root,relative);const stat=await fs.stat(name);if(!stat.isFile()||stat.size>1024*1024)return null;before=await fs.readFile(name,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
    let after=args.content;
    if(exec.name==='edit'){
      const old=args.old_string??args.oldText,replacement=args.new_string??args.newText;
      if(typeof old!=='string'||typeof replacement!=='string'||!before.includes(old))return null;
      after=args.replace_all&&old?before.split(old).join(replacement):before.replace(old,replacement);
    }
    if(typeof after!=='string'||!rewriteRisk(before,after).large)return null;
    const hash=digest(before),key=`${id}:${name}`,grant=grants.get(key);
    if(grant?.hash===hash){grants.delete(key);emit('large-rewrite-justified',{taskId:id,path:path.relative(project.root,name),hash,reason:grant.reason,validationPlan:grant.validationPlan});return null;}
    return{reason:'Large overwrite after a working milestone. Prefer a focused edit, or call explain_rewrite with this file hash, the concrete cause and regression-check plan: '+hash,info:{code:'REWRITE_EXPLANATION_REQUIRED'}};
  }
  ctx.on('tools/pre-execute',async(exec,next)=>{const decision=await next();if(decision.kind==='allow'&&exec.agent){const denial=await overwrite(exec);if(denial){rewriteDenials.set(exec.token,denial);return{kind:'deny',...denial};}}return decision;},{global:true});
  // Native guards are synchronous. The async precheck supplies a final monotonic denial.
  ctx.tools.guard(exec=>rewriteDenials.get(exec.token));

  ctx.on('tools/execute',async(exec,next)=>{
    if(!exec.agent)return next();const {id}=activeFor(exec.agent),queued=Date.now();let permit,started;
    try{if(config.schedule!==false&&heavyTool(exec)){permit=await toolGate.acquire({rootId:id,signal:exec.signal});phase(id,'tool-queue',queued,Date.now());}started=Date.now();return await next();}
    finally{phase(id,started===undefined?'tool-queue':'tools',started??queued,Date.now());permit?.release();}
  },{global:true});
  ctx.on('tools/result',(exec,result)=>{
    rewriteDenials.delete(exec.token);
    if(!exec.agent)return;const {id,runId}=activeFor(exec.agent),c=card(id),args=exec.arguments;
    if(['write','edit','apply_patch'].includes(exec.name)&&!result.isError){let file=fileArg(args)??'(patch)';const project=projectCache.get(id);if(project&&path.isAbsolute(file))file=path.relative(project.root,file);c.change(file);pendingAccepted.delete(id);emit('source-changed',{taskId:id});}
    if(exec.name==='verify_project'&&result.value){const r=result.value;c.verification(r,r.sourceHash);
      if(!r.passed){pendingAccepted.delete(id);emit('verification-failed',{taskId:id,runId});if(!repairStarts.has(id))repairStarts.set(id,Date.now());}
      else if(r.complete&&!r.stale){pendingAccepted.set(id,{hash:r.sourceHash,runId});if(repairStarts.has(id)){phase(id,'repair',repairStarts.get(id),Date.now());repairStarts.delete(id);}}
    }else{const key=exec.name+':'+digest(JSON.stringify(args??{})).slice(0,12);if(result.isError||Number.isInteger(result.value?.exitCode)&&result.value.exitCode!==0)c.failure(key,result.error?.message??textOf(result.content).slice(-700));else c.issues.delete(key);}
  },{global:true});

  async function metrics(){if(config.engineMetrics===false)return null;try{const u=new URL(config.engineURL??'http://127.0.0.1:8080');if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))return null;const r=await fetch(new URL('/metrics',u),{signal:AbortSignal.timeout(350)});return r.ok?await r.json():null;}catch{return null;}}
  ctx.on('llm/stream',function(options,next){
    if(!providers.has(options.provider))return next();
    const normalized=normalizeCompaction(options);if(normalized)return this.stream(normalized);
    const agent=options.sessionId?ctx.agents.get(String(options.sessionId)):undefined;
    const id=agent?idOf(agent):String(options.sessionId??'@maintenance'),requestId=crypto.randomUUID();
    return(async function*(){
      const queued=Date.now();let permit,started,firstToken,usage,finish,before;
      try{
        if(config.schedule!==false)permit=await modelGate.acquire({rootId:id,sessionId:String(options.sessionId??id),signal:options.signal});
        phase(id,'model-queue',queued,Date.now());before=await metrics();started=Date.now();
        emit('request-start',{taskId:id,requestId,provider:options.provider,model:options.model,purpose:options.purpose??'conversation',...prefixFingerprint(options)});
        for await(const chunk of await next()){
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
        }finally{permit?.release();}
      }
    })();
  },{prepend:true,global:true});

  ctx.on('session/event',(session,event)=>{
    const agent=ctx.agents.get(session.id),id=agent?idOf(agent):session.id,child=id!==session.id;
    if(event.type==='turn/start'){const runId=`${session.id}:${event.data.turn}`;if(!child){runs.set(id,runId);pendingAccepted.delete(id);}emit('turn-start',{taskId:id,runId,child});}
    if(event.type==='turn/end'){
      const runId=`${session.id}:${event.data.turn}`,at=Date.now(),candidate=child?undefined:pendingAccepted.get(id);if(!child)pendingAccepted.delete(id);emit('turn-end',{taskId:id,runId});
      if(candidate?.runId===runId)void review(id).then(current=>{if(current?.sourceHash===candidate.hash)emit('accepted',{taskId:id,runId,at,sourceHash:candidate.hash});else emit('source-changed',{taskId:id,at});}).catch(()=>{});
    }
  });

  const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
  ctx.tools.register({name:'focus_context',description:'Get current task, unresolved checks, Git change summary and bounded relevant source excerpts from the isolated project. Prefer this to repeated full-file reads. Returned file hashes bind explain_rewrite to current content.',parameters:{type:'object',properties:{files:{type:'array',maxItems:6,items:{type:'object',properties:{path:{type:'string'},start:{type:'integer',minimum:1},lines:{type:'integer',minimum:1,maximum:120}},required:['path'],additionalProperties:false}}},additionalProperties:false},isConcurrencySafe:()=>true,output,async execute(args,exec){
    const {id}=activeFor(exec.agent),project=await review(id);if(!project||project.legacy)throw Error('Isolated project required.');if(ctx.shell.sandboxMode===undefined)throw Error('Project sandbox required.');
    const selected=args.files??card(id).changes.filter(x=>x!=='(patch)').slice(-3).map(p=>({path:p,lines:40}));
    const command='exec '+['/data/harness/node/bin/node','/data/harness/app/development/project-run.cjs','--','/data/harness/node/bin/node',path.join(DIR,'focus.mjs'),project.root,JSON.stringify({files:selected})].map(quote).join(' ');
    const spec=ctx.shell.resolve({command,workdir:project.root,timeoutMs:10000,signal:exec.signal,dshEnv:ctx.shellEnv.collect(exec),sandboxPolicy:{mode:'workspace-write',workspaceRoot:project.root}}),result=await(await ctx.shell.execute(spec)).result();
    if(exec.signal.aborted)throw exec.signal.reason;if(result.exitCode!==0)throw Error('Context inspection failed: '+result.stdout.text.slice(-500));
    return{...card(id).snapshot(),...JSON.parse(result.stdout.text),sourceHash:project.sourceHash};
  }});
  ctx.tools.register({name:'explain_rewrite',description:'Before a large overwrite after a working milestone, record the concrete cause and regression-check plan. One use, exact project-relative path and current file SHA256 from focus_context. This is an agent explanation, not a user approval request.',parameters:{type:'object',properties:{path:{type:'string'},sha256:{type:'string'},reason:{type:'string',minLength:30,maxLength:1500},validationPlan:{type:'string',minLength:30,maxLength:1500}},required:['path','sha256','reason','validationPlan'],additionalProperties:false},isConcurrencySafe:()=>false,output,async execute(args,exec){
    if(!/^[a-f0-9]{64}$/u.test(args.sha256)||typeof args.reason!=='string'||args.reason.length<30||typeof args.validationPlan!=='string'||args.validationPlan.length<30)throw Error('Current hash, concrete reason and verification plan are required.');
    const {id}=activeFor(exec.agent),project=await review(id);if(!project||project.legacy)throw Error('Isolated project required.');const name=await confined(project.root,args.path),stat=await fs.stat(name);if(!stat.isFile()||stat.size>1024*1024)throw Error('Bounded regular file required.');
    const hash=digest(await fs.readFile(name,'utf8'));if(hash!==args.sha256)throw Error('File changed; refresh focus_context.');grants.set(`${id}:${name}`,{hash,reason:args.reason,validationPlan:args.validationPlan});return{recorded:true,path:args.path,sha256:hash,oneUse:true};
  }});
  ctx.effect(()=>()=>{modelGate.close();toolGate.close();});
  await fs.writeFile(path.join(directory,'loaded.json'),JSON.stringify({at:Date.now(),pid:process.pid,scheduler:config.schedule===false?'observe-only':'request-fifo',maxModelStreams:1,maxHeavyTools:toolGate.capacity}),{mode:0o600});
}
