// Inert callback tests of the actual candidate lifecycle AND receipt factory.
// No network, subprocess, SDK tool, project code, credential or model is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRootLifecycle} from './lifecycle.mjs';
import {createRootBindings} from './bindings.mjs';
import {runPrimary} from './runner.mjs';
import {syntheticRecord} from '../n06-evidence-storage/fixtures.mjs';
const target=Object.freeze({owned:true,sessionId:'synthetic-session',workspaceId:'synthetic-workspace',projectId:'synthetic-project'});
const sourceCommit='a'.repeat(40),requestId='11111111-1111-4111-8111-111111111111',hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity=()=>({sourceCommit,sourceDigest:'b'.repeat(64),policySha256:'c'.repeat(64),launchId:'synthetic-launch',admissionEpoch:'synthetic-epoch',recoveryAttempt:'synthetic-recovery',profileSha256:'d'.repeat(64),nativeProcess:{pid:111,uid:1001,ppid:1,startTicks:'1234',argsSha256:'e'.repeat(64)}});
function history(count,{name='bash',args={command:'synthetic text never executed'},isError=false}={}){return Array.from({length:count},(_,i)=>[
 {seq:i*2+1,type:'tool/call',data:{callId:'call-'+i,name,arguments:typeof args==='string'?args:JSON.stringify(args)}},
 {seq:i*2+2,type:'tool/result',data:{message:{role:'tool',toolCallId:'call-'+i,source:{kind:'tool',callId:'call-'+i},isError,content:[{type:'text',text:'synthetic result never interpreted'}]}}},
 ]).flat();}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(predicate){for(let i=0;i<256;i++){if(predicate())return;await Promise.resolve();}throw Error('Synthetic boundary not reached');}
function fixture({proofMode='actual',metadataMode='actual',bind=true}={}){
 const state={now:1000,metadata:identity(),rows:[],children:[],ptys:[],preview:{sessionId:target.sessionId,state:'closed',workSettled:true},assertFailure:null,previewFailure:null,holdAttest:null,holdAssert:null,onAttest:null,onAssert:null};
 const counts={assert:0,attest:0,preview:0,proof:0,jobs:0,projections:0,terminals:0,follow:0,kill:0,cancel:0};const calls=[];
 const check=input=>{calls.push({deadline:input.deadline,signal:input.signal});assert(input.deadline>state.now);assert(!input.signal?.aborted);};
 const native={target,jobsSnapshot:async input=>{check(input);counts.jobs++;return structuredClone(state.rows);},projections:async input=>{check(input);counts.projections++;return{kind:'sequenced',asOfSeq:16384,values:{subagentCatalog:structuredClone(state.children)}};},terminals:async input=>{check(input);counts.terminals++;return structuredClone(state.ptys);},followJob:async(row,input)=>{check(input);counts.follow++;return row;},killJob:async(row,input)=>{check(input);counts.kill++;return{outcome:'requested'};}};
 const attest=async input=>{check(input);counts.attest++;if(state.onAttest)state.onAttest(input);const hold=state.holdAttest;if(hold){state.holdAttest=null;hold.entered=true;await hold.promise;}return{version:1,...target,sourceCommit,mode:'host-compat',ownedRangeProvider:true,profileSha256:state.metadata.profileSha256,preview:structuredClone(state.preview)};};
 const factory=()=>createRootBindings({target,sourceCommit},{native,attest,cancelOwned:async input=>{check(input);counts.cancel++;return{accepted:true};}},{now:()=>state.now});
 const bound=factory(),other=factory();
 const proveOwnedRange=async input=>{counts.proof++;const receipt=await bound.proveOwnedRange(input);if(proofMode==='clone')return structuredClone(receipt);if(proofMode==='lookalike')return{...receipt,terminalForeground:{version:1,kind:'terminal-foreground-range',...target,sourceCommit,profileSha256:state.metadata.profileSha256,requestId,callId:input.callId,fingerprint:input.fingerprint}};return receipt;};
 const life=createRootLifecycle({target,sourceCommit},{native,proveOwnedRange,stopOwnedRanges:bound.stopOwnedRanges,terminalForegroundReceipt:proofMode==='wrong-instance'?other.terminalForegroundReceipt:bound.terminalForegroundReceipt,
  assertTarget:async input=>{check(input);counts.assert++;if(state.onAssert)state.onAssert(input);const hold=state.holdAssert;if(hold&&counts.assert===hold.at){state.holdAssert=null;hold.entered=true;await hold.promise;}if(state.assertFailure)throw Object.assign(Error('private source details'),{code:state.assertFailure});return metadataMode==='missing'?undefined:metadataMode==='extra'?{...structuredClone(state.metadata),unexpected:true}:structuredClone(state.metadata);},
  previewStatus:async input=>{check(input);counts.preview++;if(state.previewFailure)throw Object.assign(Error('private provider details'),{code:state.previewFailure});return structuredClone(state.preview);},
 },{now:()=>state.now});
 if(bind)life.bindIntent({identity:{...target,sourceCommit},operator:{requestId,baselineSeq:0}});
 const options=extra=>({sessionId:target.sessionId,requestId,deadline:state.now+4000,...extra});
 return{state,counts,calls,bound,other,life,options,observe:(events,extra={})=>life.observeWork({...options(extra),events})};
}

test('forty actual foreground receipts make four-per-poll progress then reuse with fresh constant barriers',async()=>{
 const f=fixture(),events=history(40);let previous=0;
 for(let poll=0;poll<10;poll++){
  const before={...f.counts},out=await f.observe(events),p=out.evidence.foregroundProofProgress;
  assert.equal(p.newProofs,4);assert.equal(p.reusedProofs,previous);assert.equal(p.pendingProofs,36-poll*4);assert.equal(f.counts.proof-before.proof,4);
  assert.equal(out.settled,poll===9);assert.equal(out.evidence.unknown.includes('FOREGROUND_PROOF_PENDING'),poll<9);assert.equal(f.counts.jobs-before.jobs,1);assert.equal(f.counts.projections-before.projections,1);assert.equal(f.counts.terminals-before.terminals,1);assert.equal(f.counts.preview-before.preview,1);previous+=4;
 }
 const before={...f.counts},out=await f.observe(events);assert.equal(out.settled,true);assert.deepEqual(out.evidence.foregroundProofProgress,{newProofs:0,reusedProofs:40,pendingProofs:0,newProofLimit:4,memoEnabled:true});
 assert.equal(f.counts.proof,40);assert.equal(f.counts.attest,80);assert.equal(f.counts.assert-before.assert,3);assert.equal(f.counts.jobs-before.jobs,1);assert.equal(f.counts.preview-before.preview,1);
 assert(out.evidence.toolProofs.every(row=>row.memo?.kind==='request-local-terminal-foreground-reuse'));assert.deepEqual(out.evidence.toolProofs.map(row=>row.callId),Array.from({length:40},(_,i)=>'call-'+i));
});

test('only exact receipt objects minted by this binding instance qualify',async()=>{
 const f=fixture(),events=history(1),input={...target,kind:'tool',requestId,callId:'call-0',call:events[0],result:events[1],fingerprint:hash({call:events[0].data,result:events[1].data}),deadline:5000};
 const proof=await f.bound.proveOwnedRange(input);assert.equal(Object.isFrozen(proof),true);const q=f.bound.terminalForegroundReceipt(proof);assert.equal(q.resultSeq,2);assert.equal(q.profileSha256,f.state.metadata.profileSha256);assert.equal(Object.isFrozen(q),true);
 for(const fake of [structuredClone(proof),{...proof,terminalForeground:q},JSON.parse(JSON.stringify(proof))])assert.equal(f.bound.terminalForegroundReceipt(fake),null);
 assert.equal(f.other.terminalForegroundReceipt(proof),null);assert.throws(()=>{proof.fingerprint='foreign';},TypeError);
});

test('cloned, lookalike and wrong-instance generic proofs can settle the current pass but never cache',async()=>{
 for(const proofMode of ['clone','lookalike','wrong-instance']){
  const f=fixture({proofMode}),events=history(7);for(let i=0;i<2;i++){const out=await f.observe(events);assert.equal(out.settled,true,proofMode);assert.equal(out.evidence.foregroundProofProgress.memoEnabled,false);assert.equal(out.evidence.foregroundProofProgress.reusedProofs,0);assert(!out.evidence.unknown.includes('FOREGROUND_PROOF_PENDING'));}assert.equal(f.counts.proof,14,proofMode);
 }
});

test('unsupported or absent metadata disables memoization without substituting a scope',async()=>{
 for(const metadataMode of ['missing','extra']){const f=fixture({metadataMode}),events=history(6);for(let i=0;i<2;i++){const out=await f.observe(events);assert.equal(out.settled,true);assert.equal(out.evidence.foregroundProofProgress.memoEnabled,false);}assert.equal(f.counts.proof,12);}
});

test('changed call/result fingerprints and malformed or foreign history never reuse terminal evidence',async()=>{
 for(const mutate of [events=>events[0].data.arguments='{}',events=>events[1].data.message.content[0].text='changed',events=>events[1].data.message.source.callId='foreign',events=>events[1].seq=3]){
  const f=fixture(),events=history(1);assert.equal((await f.observe(events)).settled,true);const changed=structuredClone(events);mutate(changed);assert.equal((await f.observe(changed)).settled,false);assert.equal(f.counts.proof,1);assert.equal((await f.observe(events)).settled,true);assert.equal(f.counts.proof,2);
 }
 const f=fixture();assert.equal((await f.observe(history(1),{sessionId:'foreign'})).settled,false);assert.equal(f.counts.proof,0);
});

test('pending, malformed JSON, failed results and unknown tools retain their original proof paths',async()=>{
 const pending=fixture(),events=history(1);assert.equal((await pending.observe(events.slice(0,1))).settled,false);assert.equal(pending.counts.proof,0);assert.equal((await pending.observe(events)).settled,true);
 const malformed=fixture();for(let i=0;i<2;i++){const out=await malformed.observe(history(1,{args:'not JSON'}));assert.equal(out.settled,false);assert(out.evidence.unknown.includes('MANAGED_RANGE_PROOF_MISSING'));}assert.equal(malformed.counts.proof,2);
 const failed=fixture();for(let i=0;i<2;i++){const out=await failed.observe(history(1,{isError:true}));assert.equal(out.settled,true);assert.equal(out.evidence.foregroundProofProgress.reusedProofs,0);}assert.equal(failed.counts.proof,2);
 const unknown=fixture(),out=await unknown.observe(history(1,{name:'synthetic_unknown_tool'}));assert.equal(out.settled,false);assert(out.evidence.unknown.includes('UNREVIEWED_TOOL_synthetic_unknown_tool'));assert.equal(unknown.counts.proof,0);
});

test('fresh source/provider failures cannot reuse a warm receipt',async()=>{
 for(const failure of ['SOURCE_CHANGED','PROFILE_CHANGED','ADMISSION_CHANGED','NATIVE_PROCESS_CHANGED']){const f=fixture(),events=history(1);await f.observe(events);f.state.assertFailure=failure;const out=await f.observe(events);assert.equal(out.settled,false);assert(out.evidence.unknown.includes(failure));assert.equal(f.counts.proof,1);}
 const f=fixture(),events=history(1);await f.observe(events);f.state.previewFailure='PROVIDER_CHANGED';assert.equal((await f.observe(events)).settled,false);assert.equal(f.counts.proof,1);
});

test('scope changes require new receipts and a changed profile cannot retain old binding qualification',async()=>{
 for(const mutate of [s=>s.metadata.admissionEpoch='next-epoch',s=>s.metadata.nativeProcess.pid++,s=>s.metadata.nativeProcess.startTicks='2345',s=>s.metadata.sourceDigest='f'.repeat(64),s=>s.metadata.recoveryAttempt='next-recovery']){const f=fixture(),events=history(1);await f.observe(events);mutate(f.state);const out=await f.observe(events);assert.equal(out.settled,true);assert.equal(out.evidence.foregroundProofProgress.reusedProofs,0);assert.equal(f.counts.proof,2);}
 const f=fixture(),events=history(1);await f.observe(events);f.state.metadata.profileSha256='f'.repeat(64);const out=await f.observe(events);assert.equal(out.settled,false);assert(out.evidence.unknown.includes('BINDING_PROFILE_CHANGED'));
});

test('a final scope barrier failure discards every staged receipt',async()=>{
 const f=fixture(),events=history(1);f.state.onAssert=()=>{if(f.counts.assert===4)f.state.metadata.launchId='changed-during-pass';};let out=await f.observe(events);assert.equal(out.settled,false);assert(out.evidence.unknown.includes('FOREGROUND_MEMO_SCOPE_CHANGED'));assert.equal(f.counts.proof,1);
 f.state.onAssert=null;out=await f.observe(events);assert.equal(out.settled,true);assert.equal(out.evidence.foregroundProofProgress.reusedProofs,0);assert.equal(f.counts.proof,2);
});

test('valid pre/inventory/final identity mismatches fail even when generic receipts disable caching',async()=>{
 for(const [at,proofMode]of [[2,'actual'],[4,'clone']]){
  const f=fixture({proofMode}),events=history(1);f.state.onAssert=()=>{if(f.counts.assert===at)f.state.metadata.admissionEpoch='changed-during-barrier';};const out=await f.observe(events);
  assert.equal(out.settled,false);assert(out.evidence.unknown.includes('FOREGROUND_MEMO_SCOPE_CHANGED'));assert.equal(out.evidence.toolProofs,undefined);
  f.state.onAssert=null;const before=f.counts.proof,next=await f.observe(events);assert.equal(next.settled,true);assert.equal(next.evidence.foregroundProofProgress.reusedProofs,0);assert.equal(f.counts.proof,before+1);
 }
});

test('warm receipts do not settle fresh jobs, children or PTYs and never control unowned jobs',async()=>{
 for(const mode of ['job','children','pty']){const f=fixture(),events=history(1);await f.observe(events);if(mode==='job')f.state.rows=[{id:'own-active',owner:target.sessionId,kind:'bash',startedAt:1,status:'running'}];if(mode==='children')f.state.children=[{id:'child'}];if(mode==='pty')f.state.ptys=[{id:'pty'}];const out=await f.observe(events);assert.equal(out.settled,false,mode);assert.equal(f.counts.kill,0);assert.equal(f.counts.follow,0);}
 const f=fixture(),events=history(1);await f.observe(events);f.state.rows=[{id:'unowned',kind:'bash',startedAt:1,status:'running'},{id:'foreign',owner:'foreign-session',kind:'bash',startedAt:1,status:'running'}];const out=await f.observe(events);assert.equal(out.settled,true);assert.equal(out.evidence.unownedVisibleIgnored,1);assert.equal(f.counts.kill,0);assert.equal(f.counts.follow,0);assert.equal(out.evidence.foregroundProofProgress.reusedProofs,1);
});

test('background and preview producer proofs remain fresh and ordered without terminal memoization',async()=>{
 const background=fixture(),events=history(6,{args:{command:'synthetic',run_in_background:true}});for(let i=0;i<2;i++){const out=await background.observe(events);assert.equal(out.settled,true);assert.equal(out.evidence.foregroundProofProgress.reusedProofs,0);assert.deepEqual(out.evidence.toolProofs.map(row=>row.callId),Array.from({length:6},(_,i)=>'call-'+i));}assert.equal(background.counts.proof,12);
 const f=fixture(),previewEvents=history(1,{args:{command:'synthetic',run_in_background:true}}),correlated={callId:'call-0',rootCallId:'call-0',toolName:'bash'};
 f.state.rows=[{id:'preview-job',owner:target.sessionId,kind:'bash',startedAt:1,status:'running'}];f.state.preview={version:1,sessionId:target.sessionId,state:'ready',jobId:'preview-job',previewId:'synthetic-preview',generation:'1',expiresAt:100000,correlation:{version:1,sessionId:target.sessionId,ownerAgentId:target.sessionId,jobId:'preview-job',previewId:'synthetic-preview',generation:'1',expiresAt:100000,originalCall:correlated,producerCall:correlated}};
 for(let i=0;i<2;i++){const out=await f.observe(previewEvents);assert.equal(out.settled,true);assert.equal(out.evidence.toolProofs[0].kind,'exact-preview-producer');assert.equal(out.evidence.foregroundProofProgress.reusedProofs,0);}assert.equal(f.counts.proof,2);
 f.state.preview.previewId='changed';assert.equal((await f.observe(previewEvents)).settled,false);
});

test('preview, job-kill and nonprocess history barriers preserve proof order and meaning',async()=>{
 const f=fixture(),branch=(name,args,id,offset)=>history(1,{name,args}).map(row=>({...row,seq:row.seq+offset,data:row.type==='tool/call'?{...row.data,callId:id}:{message:{...row.data.message,toolCallId:id,source:{kind:'tool',callId:id}}}}));
 const events=[...history(1),...branch('working_directory',{cd:'/synthetic'},'cwd-call',2),...branch('project_preview',{operation:'status'},'preview-call',4),...branch('job_kill',{job_id:'foreign'},'kill-call',6)];
 const out=await f.observe(events);assert.equal(out.settled,false);assert(out.evidence.unknown.includes('JOB_KILL_TARGET_UNQUALIFIED'));assert.deepEqual(out.evidence.toolProofs.map(row=>row.kind),['owned-range','reviewed-awaited-effect','controller-awaited-preview-operation']);assert.equal(f.counts.kill,0);
});

test('original signal and four-second deadline prevent aborted or expired receipt commits',async()=>{
 for(const mode of ['abort','deadline']){const f=fixture(),events=history(1),controller=new AbortController(),deadline=5000;f.state.onAttest=()=>{if(f.counts.attest===2){if(mode==='abort')controller.abort();else f.state.now=deadline;}};const out=await f.observe(events,{deadline,signal:controller.signal});assert.equal(out.settled,false);assert.equal(f.counts.proof,1);assert(f.calls.every(row=>row.deadline===deadline&&row.signal===controller.signal));f.state.onAttest=null;f.state.now=1000;assert.equal((await f.observe(events)).settled,true);assert.equal(f.counts.proof,2);}
});

test('Stop preempts a held observation and prevents any late staged terminal memo commit',async()=>{
 const f=fixture(),events=history(1),hold=deferred();f.state.holdAssert={...hold,at:4,entered:false};const marker=f.state.holdAssert,observing=f.observe(events);await until(()=>marker.entered);
 const stop=await f.life.stopOwnedWork(f.options());assert.equal(stop.settled,false);assert.equal(f.counts.cancel,1);hold.resolve();const stale=await observing;assert.equal(stale.settled,false);assert(stale.evidence.unknown.includes('LIFECYCLE_OBSERVATION_SUPERSEDED'));
 const before=f.counts.proof,next=await f.observe(events);assert.equal(next.settled,true);assert.equal(next.evidence.foregroundProofProgress.reusedProofs,0);assert.equal(f.counts.proof,before+1);
});

test('the candidate runner treats proof backlog as ordinary unsettled progress within the original deadline',async()=>{
 const f=fixture({bind:false}),record=syntheticRecord(),prompt=Buffer.from('Synthetic observer progress; no benchmark prompt or tool is executed');record.identity.promptSha256=createHash('sha256').update(prompt).digest('hex');
 const own={...target,preparedFixtureEvidence:'synthetic-fixture',modelSelection:{provider:'synthetic-provider',model:'synthetic-model'}},events=[{seq:0,type:'session/context',data:{}}];let submitted=false,polls=0,backlogs=0;
 const clock={now:()=>f.state.now,sleep:async ms=>{f.state.now+=ms;},bound:async(fn,deadline,signal)=>{assert(f.state.now<deadline);assert(!signal?.aborted);return fn({deadline,signal:signal??new AbortController().signal});}};
 const out=await runPrimary({record,target:own,inputs:{verify:async()=>({unchanged:true,prompt})},clock,handoff:{liveAuthorized:true,rootOperator:true,id:'synthetic',sourceCommit,runtimeCommit:sourceCommit,orderPosition:1,previousRuns:[],settlementObservationMs:120000},io:{
  preflight:async()=>({quiet:true,mode:'host-compat',sourceCommit,runtimeCommit:sourceCommit,workspaceId:own.workspaceId,fixtureEvidence:own.preparedFixtureEvidence,modelSelection:own.modelSelection,modelSelectionEvidence:'synthetic',preview:{supported:true,evidence:'synthetic'}}),
  checkpoint:async(snapshot,options)=>{if(options.phase==='intent')f.life.bindIntent(snapshot);return{durable:true,checkpointId:options.checkpointId};},
  rpc:async(method,data)=>{
   if(method==='session/state')return{active:true,cursor:events.at(-1).seq,running:false,queue:[],pendingInput:[]};
   if(method==='session/page'){const rows=events.filter(row=>row.seq<=data.throughSeq&&row.seq<(data.beforeSeq??Infinity)).slice(-64);return{records:rows.map(event=>({type:'event',event})),hasMore:rows[0].seq>0};}
   if(method==='session/prompt'){assert.equal(submitted,false);submitted=true;events.push({seq:1,type:'turn/start',data:{}},...history(40).map(row=>({...row,seq:row.seq+1})),{seq:82,type:'turn/end',data:{reason:{kind:'completed'}}});return{accepted:true};}
   throw Error('Unexpected control or model RPC in inert progress test');
  },
  observeWork:async options=>{polls++;const observed=await f.life.observeWork(options);if(observed.evidence.unknown.includes('FOREGROUND_PROOF_PENDING'))backlogs++;return observed;},
  stopOwnedWork:async()=>{throw Error('Proof backlog must not stop the attempt');},
 }});
 assert.equal(polls,10);assert.equal(backlogs,9);assert.equal(f.counts.proof,40);assert.equal(out.stopReason,null);assert.equal(out.blockingPhase,'independent_acceptance');assert.equal(out.nativeObservation.firstObservationFailure,undefined);assert.equal(out.nativeObservation.settled,true);assert.equal(Date.parse(out.operator.primaryDeadlineAt)-Date.parse(out.timestampsUtc.submittedAt),600000);
});
