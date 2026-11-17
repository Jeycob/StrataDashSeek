'use strict';
const {hostExecutionBinding}=require('./fixtures/execution-binding.cjs');
const {resourceEngine,resourceHost}=require('./resource-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {DockerEngine,LABEL,operationTimeout}=require('./apps-engine.cjs');
const {createManagedContainer,reconcilePendingCreations,reconcileLegacyCreations,retainJobs}=require('./apps-container-create.cjs');
const {Releases}=require('./apps-releases.cjs');
const image='sha256:'+'a'.repeat(64),projectId='b'.repeat(16),jobId='c'.repeat(16),containerId='d'.repeat(64);
const body=()=>({Image:image,Labels:{[LABEL]:'managed',[LABEL+'.project']:projectId},Env:['PRIVATE_VALUE=fixture-not-for-journal'],HostConfig:resourceHost()});
function manager(engine){engine=resourceEngine(engine,{imageResponse:true});const job={id:jobId,creations:[]},m={execution:hostExecutionBinding(),engine,store:{jobs:[job],projects:{}},save(){},log(){}};return{m,job};}
function inspected(record,patch={}){return{Id:containerId,Name:'/'+record.name,Image:record.imageId,Config:{Labels:{[LABEL]:'managed',[LABEL+'.project']:record.projectId,[LABEL+'.job']:record.jobId,[LABEL+'.create']:record.token}},State:{Status:'created',Running:false,StartedAt:'0001-01-01T00:00:00Z'},...patch};}

test('distinct data helper slots retain the parent job and a recorded step can never send a second create',async()=>{let posts=0;const engine={json:async(method,route,options)=>{assert.equal(method,'POST');posts++;assert.match(route,new RegExp('sdsh-test-'+projectId+'-'+jobId+'-db-(?:shadow|final)$'));assert(['db-shadow','db-final'].includes(options.json.Labels[LABEL+'.slot']));return{Id:(posts===1?'a':'f').repeat(64)};}},fixture=manager(engine),json=body();json.Labels[LABEL+'.role']='test';await createManagedContainer(fixture.m,fixture.job,json,{slot:'db-shadow'});await createManagedContainer(fixture.m,fixture.job,json,{slot:'db-final'});assert.equal(posts,2);assert(fixture.job.creations.every(record=>record.jobId===fixture.job.id));await assert.rejects(createManagedContainer(fixture.m,fixture.job,json,{slot:'db-shadow'}),{code:'DOCKER_CREATION_RECONCILIATION_REQUIRED'});assert.equal(posts,2);await assert.rejects(createManagedContainer(fixture.m,fixture.job,json,{slot:'../outside'}),/Invalid managed creation slot/);assert.equal(posts,2);});

test('a real lost create response recovers the original container without a second POST',async t=>{
 let creates=0,container=null,timer;const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'){creates++;let raw='';for await(const c of req)raw+=c;const json=JSON.parse(raw),name=new URL(req.url,'http://loopback').searchParams.get('name');timer=setTimeout(()=>{container={Id:containerId,Name:'/'+name,Image:json.Image,Config:{Labels:json.Labels},State:{Status:'created',Running:false,StartedAt:'0001-01-01T00:00:00Z'}};res.end(JSON.stringify({Id:containerId}));},90);return;}
  if(container)return res.end(JSON.stringify(container));res.writeHead(404);res.end(JSON.stringify({message:'not yet created'}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{clearTimeout(timer);await new Promise(r=>server.close(r));});
 const{m,job}=manager(new DockerEngine({url:'http://127.0.0.1:'+server.address().port})),created=await createManagedContainer(m,job,body(),{createTimeoutMs:40,reconcileMs:500,intervalMs:10});
 assert.equal(created.Id,containerId);assert.equal(creates,1);assert.equal(job.creations[0].reconciled,true);assert.equal(job.creations[0].state,'confirmed');assert.equal(JSON.stringify(job).includes('fixture-not-for-journal'),false);
});

test('explicit API rejection is preserved and no speculative second create is sent',async()=>{
 let calls=0;const{m,job}=manager({json:async()=>{calls++;throw Object.assign(Error('rejected'),{dockerStatus:400});}});
 await assert.rejects(createManagedContainer(m,job,body()),/rejected/);assert.equal(calls,1);assert.equal(job.creations[0].state,'rejected');
});

test('a missing or mismatched late container remains unresolved and cannot be adopted',async()=>{
 for(const mismatch of[false,true]){let posts=0;const{m,job}=manager({json:async method=>{if(method==='POST'){posts++;throw Error('lost response');}if(mismatch){const c=inspected(job.creations[0]);c.Config.Labels[LABEL+'.create']='wrong';return c;}throw Object.assign(Error('not found'),{dockerStatus:404});}});
  await assert.rejects(createManagedContainer(m,job,body(),{createTimeoutMs:10,reconcileMs:8,intervalMs:1}),/unresolved/);assert.equal(posts,1);assert.equal(job.creations[0].state,'unknown');
 }
});

async function unresolvedFixture(){const{m,job}=manager({json:async()=>{throw Object.assign(Error('rejected'),{dockerStatus:400});}});await assert.rejects(createManagedContainer(m,job,body()));job.creations[0].state='unknown';job.status='failed';return{m,job,record:job.creations[0]};}
test('restart reconciliation cleans only the nonce-bound never-started unreferenced container',async()=>{
 const{m,record}=await unresolvedFixture(),calls=[];m.engine={json:async()=>inspected(record),request:async(method,route,opts)=>{calls.push({method,route,opts});return{status:204};}};
 await reconcilePendingCreations(m);assert.equal(record.state,'cleaned');assert.deepEqual(calls,[{method:'DELETE',route:'/containers/'+containerId,opts:{timeout:120000}}]);
});

test('started, referenced, forged and invalid journal identities fail closed without deletion',async()=>{
 for(const kind of['started','referenced','forged','invalid']){const{m,record}=await unresolvedFixture();let deletes=0,reads=0;if(kind==='invalid')record.name='../images';if(kind==='referenced')m.store.projects[projectId]={containerId};m.engine={json:async()=>{reads++;const c=inspected(record);if(kind==='started')c.State={Status:'exited',Running:false,StartedAt:'2026-11-15T00:00:00Z'};if(kind==='forged')c.Config.Labels[LABEL+'.create']='wrong';return c;},request:async()=>{deletes++;}};await assert.rejects(reconcilePendingCreations(m),/refus|Invalid/);assert.equal(deletes,0);if(kind==='invalid')assert.equal(reads,0);}
});

test('an absent unknown create cannot be silently cleared; a completed pending delete can',async()=>{
 const{m,record}=await unresolvedFixture();m.engine={json:async()=>{throw Object.assign(Error('not found'),{dockerStatus:404});}};await assert.rejects(reconcilePendingCreations(m),/unresolved/);assert.equal(record.state,'unknown');record.state='cleanup-pending';await reconcilePendingCreations(m);assert.equal(record.state,'cleaned');
});

test('history retention keeps unresolved mutation records beyond the ordinary hundred jobs',async()=>{
 const{job}=await unresolvedFixture(),jobs=[job,...Array.from({length:120},(_,i)=>({id:String(i),status:'passed'}))],retained=retainJobs(jobs);assert.equal(retained.length,101);assert.ok(retained.includes(job));job.creations[0].state='cleaned';assert.equal(retainJobs(jobs).includes(job),false);
});
test('ambiguous data copies and deployment cutovers survive ordinary history retention',()=>{
 const recent=Array.from({length:120},(_,i)=>({id:String(i),status:'passed'}));
 for(const state of ['intent','recovery_required','unrecognized']){const job={id:'e'.repeat(16),status:'failed',creations:[{state:'confirmed'}],dataOperations:{version:1,operations:{'helper-db-final':{state}}}};assert(retainJobs([job,...recent]).includes(job));job.dataOperations.operations['helper-db-final'].state='complete';assert.equal(retainJobs([job,...recent]).includes(job),false);}
 const job={id:'f'.repeat(16),status:'failed',deploymentPhase:'recovery_required'};assert(retainJobs([job,...recent]).includes(job));
});

test('slow mutating operations have bounded deadlines while reads retain short defaults',()=>{
 assert.equal(operationTimeout('POST','/containers/create?name=example'),120000);assert.equal(operationTimeout('POST','/containers/example/start'),90000);assert.equal(operationTimeout('DELETE','/containers/example'),120000);assert.equal(operationTimeout('POST','/containers/example/stop?t=120'),135000);assert.equal(operationTimeout('GET','/containers/example/json'),15000);
});

async function legacyFixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'apps-legacy-create-'));t.after(async()=>{if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'apps-legacy-create-'))throw Error('Unexpected temporary path');await fs.rm(root,{recursive:true,force:true});});
 const job={id:jobId,projectId,status:'failed',action:'verify',stage:'candidate',startedAt:1000000,endedAt:1005000,error:'Docker operation timed out: POST /containers/create'},calls=[],m={cfg:{stateDir:root},store:{jobs:[job],projects:{}},save(){},log(){},worker:{status:()=>({phase:'ready',controlIsolation:{verified:true},profile:{storageObservedAt:2000000}})}};
 await new Releases(path.join(root,'releases')).put(projectId,jobId,{status:'failed',imageId:image});
 const c={Id:containerId,Name:'/sdsh-'+projectId+'-'+jobId,Image:image,Created:new Date(1001000).toISOString(),Config:{Labels:{[LABEL]:'managed',[LABEL+'.project']:projectId}},State:{Status:'created',Running:false,StartedAt:'0001-01-01T00:00:00Z'},HostConfig:{Privileged:false,CapDrop:['ALL']},Mounts:[]};
 m.engine={json:async()=>c,request:async(method,route,opts)=>{calls.push({method,route,opts});}};return{m,job,c,calls};
}
test('legacy timeout cleanup requires a fresh worker boot and matching retained failed release',async t=>{
 const{m,job,calls}=await legacyFixture(t);await reconcileLegacyCreations(m);assert.equal(job.status,'failed');assert.equal(job.legacyCreationOutcome,'removed-never-started');assert.deepEqual(calls,[{method:'DELETE',route:'/containers/'+containerId,opts:{timeout:120000}}]);await reconcileLegacyCreations(m);assert.equal(calls.length,1);
});
test('legacy recovery retains started, mounted, referenced, changed or unverified resources',async t=>{
 for(const kind of['not-fresh','running','mounted','referenced','image','project','creation-time','privileged']){const{m,c,calls}=await legacyFixture(t);if(kind==='not-fresh')m.worker.status=()=>({phase:'ready',controlIsolation:{verified:true},profile:{storageObservedAt:1004000}});if(kind==='running')c.State={Status:'running',Running:true,StartedAt:new Date(1002000).toISOString()};if(kind==='mounted')c.Mounts=[{Type:'volume'}];if(kind==='referenced')m.store.projects[projectId]={containerId};if(kind==='image')c.Image='sha256:'+'e'.repeat(64);if(kind==='project')c.Config.Labels[LABEL+'.project']='e'.repeat(16);if(kind==='creation-time')c.Created=new Date(900000).toISOString();if(kind==='privileged')c.HostConfig.Privileged=true;await assert.rejects(reconcileLegacyCreations(m),/Restart|refusing/);assert.equal(calls.length,0,kind);}
});
test('only a verified new daemon boot can resolve an absent pre-journal creation',async t=>{
 const{m,job,calls}=await legacyFixture(t);m.engine.json=async()=>{throw Object.assign(Error('absent'),{dockerStatus:404});};await reconcileLegacyCreations(m);assert.equal(job.legacyCreationOutcome,'absent-after-worker-restart');assert.equal(calls.length,0);
 const recent=Array.from({length:120},(_,i)=>({id:String(i),status:'passed'}));delete job.legacyCreationOutcome;assert.ok(retainJobs([job,...recent]).includes(job));
});
