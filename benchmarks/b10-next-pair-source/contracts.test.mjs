// Source-only regressions. Synthetic transport/process/clock; no live calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {disabledSlot,validateFixedSlot,frozen,serviceCommit,operatorProducerCommit,ineligibleSession} from './spec.mjs';
import {boundSlot,envelope,sha,uuid} from './test-fixtures.mjs';
import {readActualPreviousRuns,requireBoundPreviousRuns,validateActualPrior} from './prior.mjs';
import {createRuntimeSource} from './runtime.mjs';
import {runtimePins} from './runtime-pins.mjs';
import {b10FixtureChild} from './fixture.mjs';
import {makeRestartRequest,createB10RestartConsumer,validateProcessRestart} from './restart.mjs';
import {createSupervisor,safeCollector} from './supervisor.mjs';
import {collectorIdentity} from '../n06-evidence-storage/runner.mjs';
import {Clock,until} from '../n06-evidence-storage/fixtures.mjs';

test('disabled templates carry no actual target/proof/clock; producer differs from service',()=>{
 for(const variant of ['DS','HomeAI']){
  const slot=disabledSlot(variant);assert.equal(slot.executionEnabled,false);assert.equal(slot.authorizationReference,null);
  for(const key of ['sessionId','workspaceId','projectId','projectRoot','sessionUrl','preparedFixtureEvidence'])assert.equal(slot.target[key],null);
  for(const key of ['checkpointDirectory','codeRoot','recordSha256','frozenRoot','qaRoot','actualRuntimeProofFile','actualRuntimeProofSha256'])assert.equal(slot[key],null);
  assert(Object.values(slot.actual).every(x=>x===null));assert.throws(()=>validateFixedSlot(slot),/SOURCE_DISABLED/);
  const record=JSON.parse(fs.readFileSync(new URL((variant==='DS'?'ds-first':'homeai-second')+'/primary.record.json',import.meta.url)));
  assert.equal(record.isTemplate,true);assert.equal(record.status,'NOT RUN');assert(Object.values(record.timestampsUtc).every(x=>x===null));assert(!JSON.stringify(record).includes('B03'));
 }
 assert.notEqual(serviceCommit,operatorProducerCommit);assert.equal(serviceCommit,'266196e9427db575609cbbe5c8c6fb7c814f27ff');
});
test('canonical module hashes remain exact Git04b including adapter and runner',()=>{
 for(const [path,expected]of Object.entries(runtimePins(disabledSlot('DS')).modules))assert.equal(sha(fs.readFileSync(new URL('../../'+path,import.meta.url))),expected,path);
 assert.equal(frozen.canonical.find(x=>x.path.endsWith('/adapter.mjs')).sha256,'3dc9dae4b47fd6e0846bf34dbf0fab102a1eebbf55781269dbfe67f779d2bb16');
 assert.equal(frozen.canonical.find(x=>x.path.endsWith('/runner.mjs')).sha256,'3d4840bd0f5e31778bef9b5be60ece8295899a11f930fb66145dd786e5a39dd8');
});
test('actual raw finals bind DS position3 / HA position4 and cannot be replaced by booleans or old slots',()=>{
 for(const variant of ['DS','HomeAI']){
  const {slot,previousRuns}=boundSlot(variant);assert.equal(requireBoundPreviousRuns(slot,previousRuns).length,variant==='DS'?2:3);
  assert.throws(()=>requireBoundPreviousRuns(slot,previousRuns.map(x=>({...x}))),/ACTUAL_FIXED_CAMPAIGN/);
  assert.throws(()=>requireBoundPreviousRuns(structuredClone(slot),previousRuns),/ACTUAL_FIXED_CAMPAIGN/);
  const old=structuredClone(slot);old.previous[0].attemptId='b03-pair03-homeai-primary';assert.throws(()=>validateFixedSlot(old),/NEW_B03_PAIR04/);
  const wrong=structuredClone(slot);wrong.target.sessionId=ineligibleSession;assert.throws(()=>validateFixedSlot(wrong),/FRESH_ELIGIBLE/);
  const limits=structuredClone(slot);limits.limits.mainSeconds=900;assert.throws(()=>validateFixedSlot(limits),/ORIGINAL_B10_LIMITS/);
  if(variant==='HomeAI'){const wrongPair=structuredClone(slot);wrongPair.previous[2].pairId='old-b10';assert.throws(()=>validateFixedSlot(wrongPair),/SAME_PAIR/);}
 }
});
test('prior envelope hash, final clock, identity, fence and durability failures stay closed',()=>{
 const {slot}=boundSlot(),expected=slot.previous[0];
 const check=mutate=>{const e=envelope(expected);mutate(e);e.snapshotSha256=sha(JSON.stringify(e.snapshot));const bytes=Buffer.from(JSON.stringify(e));return()=>validateActualPrior({checkpointBytes:bytes,expected:{...expected,checkpointSha256:sha(bytes)}});};
 for(const mutate of [e=>e.phase='observation',e=>e.snapshot.status='HOLD',e=>e.snapshot.identity.runtimeCommit=operatorProducerCommit,e=>e.snapshot.operator.primaryDeadlineAt=new Date(1700000900000).toISOString(),e=>e.snapshot.rootFinalization.status='HOLD',e=>e.snapshot.operator.persistence.unknownOutcome=true,e=>e.snapshot.nativeObservation.promptAdmission='unknown',e=>e.snapshot.comparison.orderPosition=2])assert.throws(check(mutate));
 const bytes=Buffer.from(JSON.stringify(envelope(expected)));assert.throws(()=>validateActualPrior({checkpointBytes:bytes,expected:{...expected,checkpointSha256:'0'.repeat(64)}}),/HASH_MISMATCH/);
 const receipt={durable:true,checkpointId:uuid(99),sha256:sha(bytes),bytes:bytes.length};assert.throws(()=>validateActualPrior({checkpointBytes:bytes,expected:{...expected,checkpointSha256:sha(bytes),actualWriterReceipt:receipt}}),/RECEIPT_MISMATCH/);
 assert.throws(()=>readActualPreviousRuns(slot,()=>Buffer.alloc(2200000)),/BOUNDED_BYTES/);
});

function fixture({extra=false,symlink=false,changed=false}={}){
 const pins=frozen.files.filter(x=>x.path.startsWith('fixtures/B10/')),base=new URL('../../../../homeai-team-20261116/reviewer/benchmarks/paired-20261116/',import.meta.url),root='/synthetic/project',nodes=new Map();let ino=1,output='',error='';
 const stat=(kind,bytes=Buffer.alloc(0))=>({dev:1,ino:ino++,uid:1001,gid:1001,mode:kind==='dir'?0o40700:0o100600,nlink:1,size:bytes.length,mtimeMs:1,ctimeMs:1,bytes,isDirectory:()=>kind==='dir',isFile:()=>kind==='file',isSymbolicLink:()=>kind==='link'});
 nodes.set('/synthetic',stat('dir'));nodes.set(root,stat('dir'));nodes.set(root+'/.harness',stat('dir'));nodes.set(root+'/.gitignore',stat('file'));nodes.set(root+'/test',stat('dir'));
 for(const p of pins)nodes.set(root+'/'+p.path.slice(13),stat('file',fs.readFileSync(new URL(p.path,base))));
 if(extra)nodes.set(root+'/notes.json',stat('file',Buffer.from('[]')));
 if(symlink)nodes.get(root+'/app.js').isSymbolicLink=()=>true;
 const handles=new Map();let fd=1,read=false;
 const fake={constants:fs.constants,lstatSync:p=>{const n=nodes.get(p);if(!n)throw Error('missing '+p);return{...n,...(changed&&read&&p===root+'/app.js'?{mtimeMs:2}:{})};},realpathSync:p=>p,readdirSync:p=>[...nodes.keys()].filter(k=>k.startsWith(p+'/')&&!k.slice(p.length+1).includes('/')).map(k=>k.slice(p.length+1)),openSync:p=>{handles.set(++fd,p);return fd;},fstatSync:n=>fake.lstatSync(handles.get(n)),readSync:(n,b)=>{const bytes=nodes.get(handles.get(n)).bytes;bytes.copy(b);read=true;return bytes.length;},closeSync:n=>handles.delete(n)};
 const proc={argv:['-e',root,JSON.stringify(pins)],getuid:()=>1001,getgid:()=>1001,stdout:{write:s=>output+=s},stderr:{write:s=>error+=s},exitCode:0};
 vm.runInNewContext('('+b10FixtureChild.toString()+')()',{require:name=>name==='node:fs'?fake:crypto,process:proc,Buffer});return{proc,output,error,pins};
}
test('B10 service-UID inspector accepts exactly six original files, rejects saved state, symlink and change during read',()=>{
 const good=fixture();assert.equal(good.proc.exitCode,0,good.error);assert.deepEqual(JSON.parse(good.output).files,good.pins);
 for(const options of [{extra:true},{symlink:true},{changed:true}]){const f=fixture(options);assert.equal(f.proc.exitCode,1);assert.equal(f.output,'');assert.equal(f.error,'B10_FIXTURE_REFUSED\n');}
});

const view=target=>({version:1,state:'ready',sessionId:target.sessionId,previewId:'synthetic-preview',jobId:'synthetic-job1',generation:'synthetic-gen1',url:'https://preview.synthetic.invalid/',expiresAt:1700000600000});
test('owner restart uses actual fixed route/request and whitelist receipt, no arbitrary HTTP destination',async()=>{
 const {slot}=boundSlot(),first=slot.target,{ownerHost}=runtimePins(slot),before=view(first),after={...before,jobId:'synthetic-job2',generation:'synthetic-gen2',correlation:{private:'not-output'}};let count=0;
 const {createOwnerReads}=createRuntimeSource(slot);
 const read=createOwnerReads({Host:ownerHost,Origin:'https://'+ownerHost,Cookie:'session=synthetic_auth_123456789'},{now:()=>1700000000000,request:(settings,respond)=>{
  count++;assert.equal(settings.hostname,'127.0.0.1');assert.equal(settings.port,3090);assert.equal(settings.path,'/api/workbench/preview');assert.equal(settings.method,'POST');
  const req=new EventEmitter();req.destroy=()=>{};req.end=bytes=>{assert.deepEqual(JSON.parse(bytes),makeRestartRequest(first,before,'synthetic-restart'));queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={};res.destroy=()=>{};respond(res);res.emit('data',Buffer.from(JSON.stringify(after)));res.emit('end');});};return req;
 }});
 const actual=await read('previewRestart',{before,requestId:'synthetic-restart',deadline:1700000004000});assert.equal(count,1);
 const receipt=validateProcessRestart({target:first,before,after:actual,requestId:'synthetic-restart'});assert.equal(receipt.after.correlation,undefined);
 assert.throws(()=>validateProcessRestart({target:first,before,after:before,requestId:'synthetic-restart'}),/ACTUAL_PROCESS_RESTART/);
 await assert.rejects(()=>read('arbitrary',{deadline:1700000004000}),/ROUTE_REFUSED/);
});
test('restart consumer keeps original clock, exact note/version and one captured unknown operation',async()=>{
 const {slot}=boundSlot(),target=slot.target,before=view(target),note={id:'synthetic-note',title:'Žlutý kůň',body:'synthetic',version:3};let restarts=0,at=1700000000000;
 const make=fail=>createB10RestartConsumer({target,now:()=>at,uuid:()=>uuid(9),assertTarget:async o=>assert(o.deadline<=at+4000),readStatus:async()=>before,readNote:async()=>note,restart:async()=>{restarts++;if(fail)throw Error('UNKNOWN');return{...before,jobId:'synthetic-job2',generation:'synthetic-gen2'};}});
 const c=make(false),options={deadline:at+600000};const one=c.run(note.id,options);assert.equal(c.run(note.id,options),one);assert.equal((await one).afterNote.version,3);assert.equal(restarts,1);
 assert.throws(()=>c.run(note.id,{deadline:at+900000}),/ALREADY_CAPTURED/);
 const unknown=make(true),two=unknown.run(note.id,options);await assert.rejects(two,/UNKNOWN/);assert.equal(unknown.run(note.id,options),two);assert.equal(restarts,2);
});

test('concrete runtime preflight needs exact six-file seed, fresh own tuple and real restart capability',async()=>{
 const {slot}=boundSlot(),target=slot.target,{fixtureEvidence}=runtimePins(slot),files=frozen.files.filter(x=>x.path.startsWith('fixtures/B10/')),metadata={profileSha256:'b'.repeat(64)},actual={rootIdentity:'synthetic-root',harnessIdentity:'synthetic-harness',files},before={...view(target),expiresAt:Date.now()+600000};let restartCalls=0,capability;
 const o={json:file=>{assert.equal(file,fixtureEvidence);return{phase:'TWO_FROZEN_B10_FIXTURES_PREPARED',targets:[{...target,...actual}]};},projectJobs:()=>[],canonical:JSON.stringify,hash:sha};
 const read=async(kind,options)=>{
  assert(options.deadline<=Date.now()+10000);
  if(kind==='health')return{sourceCommit:serviceCommit,workspaceReady:true,activeAgents:0,admission:{enforced:true,activeRequests:0,activeTools:0}};
  if(kind==='modelHealth')return{busy:false,queued:0};
  if(kind==='model')return{version:1,sessionId:target.sessionId,source:'session',selection:target.modelSelection};
  if(kind==='preview')return before;
  if(kind==='previewRestart'){restartCalls++;return{...before,jobId:'synthetic-job2',generation:'synthetic-gen2'};}
  throw Error('unexpected '+kind);
 };
 const attester={assertTarget:async()=>metadata,attest:async()=>({ownedRangeProvider:true,preview:{state:'closed',workSettled:true}})};
 const {createRuntimeCallbacks}=createRuntimeSource(slot),callbacks=()=>createRuntimeCallbacks({o,read,attester,metadata:()=>metadata,inspectFixture:()=>actual,projectIdentity:()=>({root:target.projectRoot,identity:actual.rootIdentity}),target},{readRestartQualification:async()=>capability});
 const input={...target,deadline:Date.now()+10000};await assert.rejects(()=>callbacks().preflight(input),/ACTUAL_B10_RESTART_CAPABILITY/);
 capability={version:1,kind:'B10_OWN_PROCESS_RESTART_CAPABILITY',sourceCommit:serviceCommit,ownedRangeProvider:true,operation:'restart',sdkTool:'project_preview_restart',target,runtimeTupleSha256:sha(Buffer.from(JSON.stringify({target,metadata,rootIdentity:actual.rootIdentity}))),qualifiedAt:Date.now()-61000};
 await assert.rejects(()=>callbacks().preflight(input),/FRESH_RESTART_QUALIFICATION_TUPLE/);
 capability.qualifiedAt=Date.now();const c=callbacks(),ready=await c.preflight(input);assert.equal(ready.restart.supported,true);assert.equal(ready.preview.supported,true);
 const operation=c.restartPreview({...target,deadline:Date.now()+4000});assert.equal(c.restartPreview({...target,deadline:Date.now()+4000}),operation);assert.equal((await operation).after.jobId,'synthetic-job2');assert.equal(restartCalls,1);
});

test('both concrete CLIs are disabled before platform/auth/runtime effects',()=>{
 for(const dir of ['ds-first','homeai-second']){
  const r=spawnSync(process.execPath,[new URL(dir+'/cli.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')],{encoding:'utf8',timeout:5000});
  assert.equal(r.status,2,r.stderr);const value=JSON.parse(r.stdout);assert.equal(value.phase,'HOLD');assert.equal(value.reason,'ROOT_BINDING_REQUIRED');assert.equal(r.stderr,'');
 }
});
test('supervisor retains the original primary timer during QA and first cleanup cap on repeated stop',async()=>{
 const {slot}=boundSlot(),clock=new Clock(),events=[];let cleanupInput,finishCalls=0;
 const supervisor=createSupervisor({slot,emit:e=>events.push(e),prepare:async({handoff,onIntent})=>{
  const record={scenario:slot.scenario,variant:slot.variant,pairId:slot.pairId,runId:slot.runId,attemptId:slot.attemptId,identity:{...slot.target,sourceCommit:serviceCommit,runtimeCommit:serviceCommit,manifestSha256:frozen.frozenManifestSha256,promptSha256:frozen.files.find(x=>x.path==='prompts/B10.txt').sha256,acceptanceVersion:'paired-20261116 v1 + product-qa supplement v1',requestedModel:slot.target.modelSelection},operator:{requestId:uuid(8),baselineSeq:0,rootHandoff:handoff.id},timestampsUtc:{implementationReadyAt:new Date(clock.now()).toISOString()},blockingPhase:'independent_acceptance',nativeObservation:{promptAdmission:'accepted',terminal:'completed',settled:true}};
  const identity=collectorIdentity(record);safeCollector(slot,identity,handoff.id);assert.throws(()=>safeCollector(slot,{...identity,extra:true},handoff.id),/COLLECTOR/);
  return{run:async()=>{onIntent({collectorIdentity:identity,primaryStartedAt:clock.now(),primaryDeadline:clock.now()+600000});return record;},stop:()=>{},cleanup:async input=>{cleanupInput=input;return new Promise(()=>{});},finish:async()=>{finishCalls++;throw Error('must not run');}};
 }},{now:clock.now,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,randomUUID:()=>uuid(6)});
 supervisor.handle({op:'start'});await until(()=>supervisor.status().phase==='AWAITING_QA');const deadline=supervisor.status().primaryDeadlineAt;
 clock.advance(600000);assert.equal(supervisor.status().phase,'STOPPING');await until(()=>cleanupInput);assert.equal(cleanupInput.deadline,clock.now()+120000);const first=supervisor.status().cleanupDeadlineAt;
 clock.advance(1000);supervisor.handle({op:'stop'});supervisor.handle({op:'accept',report:{}});assert.equal(supervisor.status().cleanupDeadlineAt,first);assert.equal(supervisor.status().primaryDeadlineAt,deadline);assert.equal(finishCalls,0);
 clock.advance(119000);assert.equal((await supervisor.wait()).phase,'HOLD');assert.equal(supervisor.status().reason,'ORIGINAL_CLEANUP_DEADLINE');
});
