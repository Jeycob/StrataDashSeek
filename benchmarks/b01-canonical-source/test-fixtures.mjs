// Constructed records, SDK-shaped transport and durable FS only; no live effects.
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
import {Clock,MemoryFS,dependencies,syntheticRecord} from '../n06-evidence-storage/fixtures.mjs';
import {createRootIOAdapter} from '../n06-evidence-storage/adapter.mjs';
import {createFinalizerWriter} from '../n06-evidence-storage/finalization.mjs';
import {collectorIdentity,criteria} from './runner.mjs';
import {readB01PreviousRuns} from './prior.mjs';
import {campaignOrder,manifestSha256,acceptanceVersion,promptHashes,primaryPolicy,modelFor,serviceCommit,disabledB01Slot} from './policy.mjs';
export const hash=b=>createHash('sha256').update(b).digest('hex'),uuid=n=>'aaaaaaaa-bbbb-4ccc-8ddd-'+String(n).padStart(12,'0');
export function priorEnvelope(p){
 const own=Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,p[k]])),start=1700000000000,seconds=primaryPolicy(p.scenario).mainSeconds;
 const snapshot={isTemplate:false,status:'FAIL',scenario:p.scenario,variant:p.variant,pairId:p.pairId,runId:p.runId,attemptId:p.attemptId,comparison:{orderPosition:p.orderPosition},identity:{...own,sourceCommit:serviceCommit,runtimeCommit:serviceCommit,manifestSha256,promptSha256:promptHashes[p.scenario],acceptanceVersion,requestedModel:modelFor(p.variant)},limits:primaryPolicy(p.scenario),
 operator:{finalized:true,requestId:uuid(1),baselineSeq:0,rootHandoff:'synthetic-actual-prior',primaryDeadlineAt:new Date(start+seconds*1000).toISOString(),persistence:{unknownOutcome:false,lastDurableCheckpointId:uuid(2),pendingCheckpointId:uuid(3)}},slotHandoffEvidence:'synthetic-actual-prior',
 nativeObservation:{promptAdmission:'accepted',settled:true,historyComplete:true,events:[{seq:1,type:'turn/start'},{seq:2,type:'turn/end'}]},timestampsUtc:{runSubmittedAt:new Date(start).toISOString(),finishedAt:new Date(start+1000).toISOString(),settledAt:new Date(start+1000).toISOString()},
 rootFinalization:{status:'SETTLED_VISIBLE',settled:true,visible:true,archiveState:'visible',sourceCommit:serviceCommit,requestId:uuid(1),target:own,tupleSha256:'b'.repeat(64),deadline:start+seconds*1000}};
 return{version:1,phase:'final',attemptId:p.attemptId,target:own,checkpointId:uuid(3),previousCheckpointId:uuid(2),requestId:uuid(1),snapshotSha256:hash(JSON.stringify(snapshot)),snapshot};
}
export function actualPriors(record,target,handoff){
 const expected=campaignOrder.slice(0,handoff.orderPosition-1).map((label,i)=>{
  const [scenario,variant]=label.split(' '),checkpointDirectory='/synthetic/n06-b03-pair04-prior-'+i;
  return{scenario,variant,orderPosition:i+1,pairId:scenario==='B01'?record.pairId:'synthetic-pair-'+scenario,runId:'synthetic-run-'+i,attemptId:scenario==='B03'?'b03-pair04-'+variant.toLowerCase()+'-primary':'synthetic-'+scenario+'-'+variant+'-primary',sessionId:'synthetic-prior-session-'+i,workspaceId:'synthetic-prior-workspace-'+i,projectId:'synthetic-prior-project-'+i,checkpointDirectory,checkpointFile:checkpointDirectory+'/'+uuid(3)+'.json',checkpointSha256:null,actualWriterReceipt:null};
 });
 const files=new Map();for(const p of expected){const bytes=Buffer.from(JSON.stringify(priorEnvelope(p)));p.checkpointSha256=hash(bytes);files.set(p.checkpointFile,bytes);}
 const read=(file,cap)=>{const bytes=files.get(file);assert(bytes.length<=cap);return bytes;};
 return{expected,files,read,rows:readB01PreviousRuns({record,target,handoff,expected},read)};
}
export function campaign({scenario='B01',variant='HomeAI',completionMs=620000,missingRestart=false,observerUnknown=false}={}){
 const clock=new Clock(),memory=new MemoryFS(),record=syntheticRecord(),prompt=Buffer.from('Synthetic canonical900 integration bytes; not a frozen model prompt');
 Object.assign(record,{scenario,variant,pairId:'synthetic-current-pair',runId:'synthetic-current-run',attemptId:'synthetic-current-attempt',limits:primaryPolicy(scenario),comparison:{orderPosition:campaignOrder.indexOf(scenario+' '+variant)+1}});
 Object.assign(record.identity,{sourceCommit:serviceCommit,runtimeCommit:serviceCommit,manifestSha256,promptSha256:hash(prompt),acceptanceVersion});
 const target={owned:true,sessionId:'synthetic-own-session',workspaceId:'synthetic-own-workspace',projectId:'synthetic-own-project',projectRoot:'/data/harness/workspaces/projects/synthetic-own-session',sessionUrl:null,modelSelection:modelFor(variant),preparedFixtureEvidence:'/synthetic/fresh-project-proof.json'};
 const handoff={liveAuthorized:true,rootOperator:true,id:'synthetic-current-handoff',sourceCommit:serviceCommit,runtimeCommit:serviceCommit,orderPosition:record.comparison.orderPosition,settlementObservationMs:120000};
 const priors=scenario==='B01'?actualPriors(record,target,handoff):null;handoff.previousRuns=priors?.rows??Array.from({length:handoff.orderPosition-1},()=>({settled:true,finalized:true}));
 const slot={...disabledB01Slot(variant),executionEnabled:true,authorizationReference:uuid(5),target};
 let submitted=false,complete=false,prompts=0,cancels=0,stops=0;const began=clock.now(),history=[{seq:0,type:'session/context',data:{}}],calls=[],checkpoints=[];
 const add=(type,data)=>history.push({seq:history.length,type,data});
 const state=()=>{if(submitted&&!complete&&clock.now()-began>=completionMs){complete=true;add('turn/end',{reason:{kind:'completed'}});}return observerUnknown&&submitted?{cursor:history.at(-1).seq}:{active:true,cursor:history.at(-1).seq,running:submitted&&!complete,queue:[],pendingInput:[]};};
 const request=(settings,respond)=>{
  assert.equal(settings.hostname,'127.0.0.1');assert.equal(settings.port,3090);const req=new EventEmitter();req.destroy=()=>{};
  req.end=bytes=>queueMicrotask(()=>{try{const envelope=JSON.parse(bytes),method=envelope.method,data=envelope.payload.args.request;assert.equal(data.sessionId??data.address?.sessionId,target.sessionId);let value;
   if(method==='session/state')value=state();
   else if(method==='session/page'){const rows=history.filter(e=>e.seq<=data.throughSeq&&e.seq<(data.beforeSeq??Infinity)).slice(-64);value={records:rows.map(event=>({type:'event',event})),hasMore:rows[0].seq>0};}
   else if(method==='session/prompt'){prompts++;assert.equal(checkpoints[0].phase,'intent');assert.equal(checkpoints[0].receipt.durable,true);submitted=true;add('turn/start',{});add('request/header',{header:{config:target.modelSelection}});value={accepted:true};}
   else if(method==='session/cancel'){cancels++;if(!complete){complete=true;add('turn/end',{reason:{kind:'cancelled'}});}value={accepted:true};}else throw Error('Unexpected synthetic method');
   const res=new EventEmitter();res.statusCode=200;res.headers={};res.destroy=()=>{};respond(res);res.emit('data',Buffer.from(JSON.stringify({result:{ok:true,value}})));res.emit('end');
  }catch(error){req.emit('error',error);}});return req;
 };
 const adapter=createRootIOAdapter({target,attemptId:record.attemptId,ownerHost:'synthetic.invalid',ownerCookie:'session=synthetic_auth_value_12345',checkpointDirectory:'/synthetic/attemptA',checkpointBudgetBytes:67108864,checkpointBudgetCount:2048},{...dependencies(memory,clock),request});
 const writer=createFinalizerWriter({checkpoint:adapter.checkpoint,now:clock.now});
 const io={rpc:(method,data,options)=>{calls.push({method,deadline:options.deadline,at:clock.now()});return adapter.rpc(method,data,options);},
  checkpoint:async(row,options)=>{assert(options.deadline-clock.now()<=4000);const receipt=await writer.runner(row,options);checkpoints.push({phase:options.phase,receipt});return receipt;},
  preflight:async()=>({quiet:true,mode:'host-compat',sourceCommit:serviceCommit,runtimeCommit:serviceCommit,workspaceId:target.workspaceId,fixtureEvidence:target.preparedFixtureEvidence,modelSelection:target.modelSelection,modelSelectionEvidence:'synthetic exact selection',preview:{supported:true,evidence:'synthetic'},restart:missingRestart?null:{supported:true,evidence:'synthetic'}}),
  observeWork:async()=>({settled:true,evidence:{jobs:[],terminals:[],children:[],synthetic:true}}),stopOwnedWork:async()=>{stops++;}};
 const runnerClock={now:clock.now,sleep:async ms=>clock.advance(ms),bound:async(fn,deadline,signal)=>{assert(clock.now()<deadline);assert(!signal?.aborted);return fn({deadline,signal:signal??new AbortController().signal});}};
 return{record,target,handoff,slot,priors,io,inputs:{verify:async()=>({unchanged:true,prompt})},clock:runnerClock,rawClock:clock,memory,calls,checkpoints,stats:()=>({prompts,cancels,stops,history})};
}
export function report(record,now){return{collectorIdentity:collectorIdentity(record),checks:criteria[record.scenario].map(id=>({id,status:'PASS',evidence:['synthetic collection; no actual product QA']})),previewUrl:'https://preview.synthetic.invalid/',previewEvidence:'synthetic',artifactEvidence:'synthetic',reopenInstructions:'synthetic',validationStartedAt:new Date(now).toISOString(),finishedAt:new Date(now).toISOString(),qaWorkSettledAt:new Date(now).toISOString(),qaWorkSettlementEvidence:'synthetic work settled',provider:record.identity.requestedModel.provider,effectiveModel:record.identity.requestedModel.model,effectiveInferenceEvidence:'synthetic header',sourceCommit:serviceCommit,runtimeCommit:serviceCommit};}
