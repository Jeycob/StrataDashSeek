'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util'),{DatabaseSync}=require('node:sqlite');
const {DockerSqliteData,planOf}=require('./apps-deployment-data.cjs'),{DockerEngine,LABEL}=require('./apps-engine.cjs'),exec=promisify(execFile);
const project='a'.repeat(16),release='b'.repeat(16),generation='c'.repeat(16),candidate='d'.repeat(16),old='e'.repeat(64),image='sha256:'+'f'.repeat(64);
const basePlan={projectId:project,releaseId:release,dataGeneration:generation,candidateDataGeneration:candidate,volume:'data',database:'app.sqlite',mountPath:'/data',oldContainerIds:[old]};
function sql(file,statement){const db=new DatabaseSync(file);try{return statement.startsWith('SELECT')?db.prepare(statement).all():db.exec(statement);}finally{db.close();}}
async function fixture(t,{first=false,helperTimeoutMs=2000}={}){
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'apps-data-adapter-')),volumes=new Map(),containers=new Map(),calls=[],bodies=[],job={id:release,projectId:project},plan={...basePlan,oldContainerIds:first?[]:[old]};let next=1,hang=false,ambiguousVolume=false;
 function volume(name,labels={[LABEL]:'managed',[LABEL+'.project']:project}){const dir=path.join(directory,name);fs.mkdirSync(dir,{mode:0o700});const info={Name:name,Driver:'local',Scope:'local',Options:{},Labels:labels,dir};volumes.set(name,info);return info;}
 if(!first){const v=volume('production');sql(path.join(v.dir,'app.sqlite'),"CREATE TABLE orders(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO orders VALUES(1,'retained-order');");containers.set(old,{Id:old,Image:'sha256:'+'1'.repeat(64),Config:{Labels:{[LABEL]:'managed',[LABEL+'.project']:project}},State:{Running:true},Mounts:[{Type:'volume',Name:v.Name,Destination:'/data',RW:true}]});}
 const server=http.createServer(async(req,res)=>{let input='';for await(const chunk of req)input+=chunk;const body=input?JSON.parse(input):null,u=new URL(req.url,'http://local');calls.push([req.method,u.pathname]);const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  try{
   if(u.pathname.startsWith('/images/'))return send({Id:image,Config:{Labels:{[LABEL+'.data-helper']:'sqlite-v1'}}});
   if(u.pathname==='/volumes/create'){const v=volume(body.Name,body.Labels);if(ambiguousVolume)return send({message:'lost acknowledgement'},500);return send(v);}
   if(u.pathname.startsWith('/volumes/'))return volumes.has(decodeURIComponent(u.pathname.slice(9)))?send(volumes.get(decodeURIComponent(u.pathname.slice(9)))):send({message:'missing'},404);
   if(u.pathname==='/containers/json'){const filter=JSON.parse(u.searchParams.get('filters')).volume[0];return send([...containers.values()].filter(c=>c.Mounts.some(m=>m.Name===filter)).map(c=>({Id:c.Id})));}
   if(u.pathname==='/containers/create'){bodies.push(body);assert(job.dataOperations&&Object.values(job.dataOperations.operations).some(o=>o.state==='intent'));const id=(next++).toString(16).padStart(64,'0');containers.set(id,{Id:id,Name:'/'+u.searchParams.get('name'),Image:body.Image,Config:{Labels:body.Labels},body,State:{Running:false,Status:'created',StartedAt:'0001-01-01T00:00:00Z'},Mounts:body.HostConfig.Mounts.map(m=>({Type:m.Type,Name:m.Source,Destination:m.Target,RW:!m.ReadOnly}))});return send({Id:id});}
   const match=u.pathname.match(/^\/containers\/([a-f0-9]{64})\/(json|start|wait|logs|stop|kill)$/),c=match&&containers.get(match[1]);if(!c)return send({message:'not found'},404);
   if(match[2]==='json')return send(c);
   if(match[2]==='start'){c.State.Running=true;c.work=(async()=>{if(hang)return new Promise(()=>{});const opts=JSON.parse(c.body.Cmd[2]);for(const m of c.body.HostConfig.Mounts){if(m.Target==='/source')opts.sourceRoot=volumes.get(m.Source).dir;if(m.Target==='/target')opts.targetRoot=volumes.get(m.Source).dir;}try{const result=await exec(process.execPath,['-e',c.body.Cmd[0],c.body.Cmd[1],JSON.stringify(opts)],{timeout:1500,maxBuffer:4096,windowsHide:true});c.output=result.stdout;c.exit=0;}catch{c.output='';c.exit=1;}c.State.Running=false;})();return send({});}
   if(match[2]==='wait'){if(hang)return;await c.work;return send({StatusCode:c.exit});}
   if(match[2]==='logs')return res.end(c.output);
   if(match[2]==='stop'||match[2]==='kill'){c.State.Running=false;return send({});}
  }catch(error){send({message:'fixture error'},500);}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const manager={cfg:{dataHelperImageId:image},engine:new DockerEngine({url:'http://127.0.0.1:'+server.address().port}),store:{projects:{}},busy:release,save(){},log(){}};
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const real=await fsp.realpath(directory);assert.equal(path.dirname(real),await fsp.realpath(os.tmpdir()));assert(path.basename(real).startsWith('apps-data-adapter-'));assert.equal((await fsp.lstat(directory)).isSymbolicLink(),false);await fsp.rm(real,{recursive:true,force:true});});
 return{directory,volumes,containers,calls,bodies,job,plan,manager,adapter:new DockerSqliteData(manager,job,{helperTimeoutMs,cleanupTimeoutMs:50}),volume,setHang(){hang=true;},setAmbiguousVolume(){ambiguousVolume=true;},file:name=>path.join(volumes.get(name).dir,'app.sqlite')};
}
test('latest active SQLite rows survive separate tested shadow and final generations over actual loopback Docker protocol',async t=>{
 const f=await fixture(t),active=await f.adapter.inspectActive(f.plan),shadow=await f.adapter.prepareShadow(f.plan,active);
 sql(f.file(shadow.shadowVolume),"INSERT INTO orders VALUES(2,'TEST-ONLY');");const verified=await f.adapter.verifyShadow(f.plan,shadow);
 sql(f.file('production'),"INSERT INTO orders VALUES(3,'new-production-order');");await assert.rejects(f.adapter.finalizeLatest(f.plan,verified),{code:'DEPLOYMENT_DATA_OLD_WRITER_NOT_STOPPED'});
 f.containers.get(old).State.Running=false;const final=await f.adapter.finalizeLatest(f.plan,verified);assert.deepEqual(sql(f.file(final.finalVolume),'SELECT id FROM orders ORDER BY id').map(r=>r.id),[1,3]);assert.deepEqual(sql(f.file(shadow.shadowVolume),'SELECT id FROM orders ORDER BY id').map(r=>r.id),[1,2]);assert(!JSON.stringify(final).includes('retained-order'));
 assert(f.job.creations.length>=4);assert(f.job.creations.every(record=>record.jobId===release&&record.slot));
 for(const body of f.bodies){assert.equal(body.HostConfig.NetworkMode,'none');assert.equal(body.HostConfig.ReadonlyRootfs,true);assert.equal(body.HostConfig.Memory,128*1024**2);assert.deepEqual(body.HostConfig.CapDrop,['ALL']);assert.deepEqual(body.HostConfig.CapAdd,['CHOWN','DAC_READ_SEARCH']);assert(body.HostConfig.Mounts.every(m=>m.VolumeOptions.NoCopy===true));assert(body.HostConfig.Mounts.filter(m=>m.Target==='/source').every(m=>m.ReadOnly));}
});
test('first deployment keeps initialized PRETEST baseline instead of promoting test-written data',async t=>{
 const f=await fixture(t,{first:true}),active=await f.adapter.inspectActive(f.plan),shadow=await f.adapter.prepareShadow(f.plan,active);sql(f.file(shadow.shadowVolume),"CREATE TABLE orders(id INTEGER PRIMARY KEY); INSERT INTO orders VALUES(1);");
 const baseline=await f.adapter.verifyShadow(f.plan,shadow,{captureBaseline:true});sql(f.file(shadow.shadowVolume),'INSERT INTO orders VALUES(2);');const verified=await f.adapter.verifyShadow(f.plan,baseline),final=await f.adapter.finalizeLatest(f.plan,verified);assert.deepEqual(sql(f.file(final.finalVolume),'SELECT id FROM orders').map(r=>r.id),[1]);assert.equal(final.volumeGen,generation);assert.equal(shadow.volumeGen,candidate);
});
test('declared additive SQL migration runs identically on test shadow and latest final without changing source',async t=>{
 const f=await fixture(t),statement='ALTER TABLE orders ADD COLUMN note TEXT;',migration={sql:statement,sha256:crypto.createHash('sha256').update(statement).digest('hex'),fromVersion:0,toVersion:1},plan={...f.plan,migration};
 const active=await f.adapter.inspectActive(plan),shadow=await f.adapter.prepareShadow(plan,active);assert.equal(shadow.userVersion,1);const verified=await f.adapter.verifyShadow(plan,shadow);sql(f.file('production'),"INSERT INTO orders VALUES(4,'last-order');");f.containers.get(old).State.Running=false;
 const final=await f.adapter.finalizeLatest(plan,verified);assert.equal(final.schemaHash,verified.schemaHash);assert.deepEqual(sql(f.file(final.finalVolume),'SELECT id FROM orders ORDER BY id').map(r=>r.id),[1,4]);assert.equal(sql(f.file('production'),"SELECT count(*) AS n FROM pragma_table_info('orders')")[0].n,2);
});
test('unknown volume create is journaled before side effect and never duplicated after adapter restart',async t=>{
 const f=await fixture(t,{first:true});f.setAmbiguousVolume();const active=await f.adapter.inspectActive(f.plan);await assert.rejects(f.adapter.prepareShadow(f.plan,active),{phase:'recovery_required'});const n=f.calls.filter(c=>c[1]==='/volumes/create').length;
 await assert.rejects(new DockerSqliteData(f.manager,f.job).prepareShadow(f.plan,active),{code:'DEPLOYMENT_DATA_RECOVERY_REQUIRED'});assert.equal(f.calls.filter(c=>c[1]==='/volumes/create').length,n);
});
test('helper timeout stops only the known helper, preserves source and refuses automatic repeated create',async t=>{
 const f=await fixture(t,{helperTimeoutMs:80});f.setHang();await assert.rejects(f.adapter.inspectActive(f.plan),{phase:'recovery_required'});const creates=f.bodies.length;assert(f.calls.some(c=>c[1].endsWith('/kill')));assert.equal(f.containers.get(old).State.Running,true);await assert.rejects(f.adapter.inspectActive(f.plan),{code:'DEPLOYMENT_DATA_RECOVERY_REQUIRED'});assert.equal(f.bodies.length,creates);
});
test('legacy adoption needs actual same-project mounts, while other-project or competing running writers are refused',async t=>{
 const f=await fixture(t);f.volumes.get('production').Labels={};await assert.rejects(f.adapter.inspectActive(f.plan),{code:'DEPLOYMENT_DATA_VOLUME_UNOWNED'});const p={...f.plan,allowLegacy:true};assert.equal((await f.adapter.inspectActive(p)).legacyAdoption,true);
 const other='2'.repeat(64);f.containers.set(other,{...structuredClone(f.containers.get(old)),Id:other});await assert.rejects(f.adapter.inspectActive(p),{code:'DEPLOYMENT_DATA_VOLUME_BUSY'});f.containers.get(other).Config.Labels[LABEL+'.project']='3'.repeat(16);await assert.rejects(f.adapter.inspectActive(p));
});
test('unsupported databases, ambiguous generations and altered SQL are refused before Docker mutation',()=>{
 assert.throws(()=>planOf({...basePlan,engine:'postgres'}));assert.throws(()=>planOf({...basePlan,candidateDataGeneration:generation}));assert.throws(()=>planOf({...basePlan,database:'../secret'}));assert.throws(()=>planOf({...basePlan,migration:{sql:'DROP TABLE orders;',sha256:'0'.repeat(64),fromVersion:0,toVersion:1}}));
});

test('a stopped/resumed writer invalidates any repeated finalization rather than returning an old cached final volume',async t=>{
 const f=await fixture(t),active=await f.adapter.inspectActive(f.plan),shadow=await f.adapter.prepareShadow(f.plan,active),verified=await f.adapter.verifyShadow(f.plan,shadow);f.containers.get(old).State.Running=false;
 const final=await f.adapter.finalizeLatest(f.plan,verified);for(const[id,c]of f.containers)if(c.Config?.Labels?.[LABEL+'.role']==='data-helper')f.containers.delete(id);
 f.containers.get(old).State.Running=true;sql(f.file('production'),"INSERT INTO orders VALUES(9,'accepted after failed cutover');");f.containers.get(old).State.Running=false;
 const count=f.bodies.length;await assert.rejects(new DockerSqliteData(f.manager,f.job).finalizeLatest(f.plan,verified),{code:'DEPLOYMENT_DATA_FINALIZATION_CONSUMED',phase:'recovery_required'});assert.equal(f.bodies.length,count);assert.deepEqual(sql(f.file('production'),'SELECT id FROM orders ORDER BY id').map(row=>row.id),[1,9]);assert.deepEqual(sql(f.file(final.finalVolume),'SELECT id FROM orders ORDER BY id').map(row=>row.id),[1]);
});
test('a forged verified boolean or proof cannot substitute for completed trusted preparation and tested journals',async t=>{
 const f=await fixture(t),active=await f.adapter.inspectActive(f.plan),shadow=await f.adapter.prepareShadow(f.plan,active);f.containers.get(old).State.Running=false;
 await assert.rejects(f.adapter.finalizeLatest(f.plan,{...shadow,verified:true}),{code:'DEPLOYMENT_DATA_VERIFICATION_REQUIRED'});assert(!f.job.dataOperations.operations.finalization);assert(!f.volumes.has('sdsh-'+project+'-'+generation+'-data'));
 sql(f.file(shadow.shadowVolume),'CREATE TABLE unapproved(id INTEGER);');await assert.rejects(f.adapter.verifyShadow(f.plan,shadow),{code:'DEPLOYMENT_DATA_SCHEMA_CHANGE_UNSUPPORTED'});
 const failedTestProof=f.job.dataOperations.operations['helper-db-inspect-tested'].proof;await assert.rejects(f.adapter.finalizeLatest(f.plan,{...shadow,...failedTestProof,verified:true}),{code:'DEPLOYMENT_DATA_VERIFICATION_REQUIRED'});assert(!f.job.dataOperations.operations['verified-shadow']);
});
test('finalization claims one durable intent even when two callers race after writer checks',async t=>{
 const f=await fixture(t),active=await f.adapter.inspectActive(f.plan),shadow=await f.adapter.prepareShadow(f.plan,active),verified=await f.adapter.verifyShadow(f.plan,shadow);f.containers.get(old).State.Running=false;
 const results=await Promise.allSettled([f.adapter.finalizeLatest(f.plan,verified),f.adapter.finalizeLatest(f.plan,verified)]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected'&&row.reason.code==='DEPLOYMENT_DATA_FINALIZATION_CONSUMED').length,1);assert.equal(f.calls.filter(row=>row[1]==='/volumes/create').length,2);
});
test('declared maxBytes is retained and enforces the actual SQLite size before shadow/final copy',async t=>{
 const f=await fixture(t),p={...f.plan,maxBytes:4096};assert.equal(planOf(p).maxBytes,4096);await assert.rejects(f.adapter.inspectActive(p),{phase:'recovery_required'});assert(f.bodies.every(body=>JSON.parse(body.Cmd[2]).maxBytes===4096));assert.equal(f.volumes.size,1);assert.equal(f.containers.get(old).State.Running,true);assert.throws(()=>planOf({...p,maxBytes:4095}),{code:'DEPLOYMENT_DATA_SIZE_POLICY_INVALID'});
});

test('already-target SQL may skip only for a fresh first-deploy baseline and records that decision',async t=>{
 const f=await fixture(t,{first:true}),statement='ALTER TABLE orders ADD COLUMN note TEXT;',p={...f.plan,migration:{sql:statement,sha256:crypto.createHash('sha256').update(statement).digest('hex'),fromVersion:0,toVersion:1}};
 const active=await f.adapter.inspectActive(p),shadow=await f.adapter.prepareShadow(p,active);sql(f.file(shadow.shadowVolume),'CREATE TABLE orders(id INTEGER PRIMARY KEY,note TEXT); PRAGMA user_version=1;');const baseline=await f.adapter.verifyShadow(p,shadow,{captureBaseline:true});assert.equal(baseline.migrationDisposition,'fresh-first-deployment-already-target');assert(!f.bodies.some(body=>JSON.parse(body.Cmd[2]).migrate));
});

test('test-driven schema changes hold original writer before any final generation is created',async t=>{
 const f=await fixture(t),active=await f.adapter.inspectActive(f.plan),shadow=await f.adapter.prepareShadow(f.plan,active);sql(f.file(shadow.shadowVolume),'CREATE TABLE test_side_effect(id INTEGER);');await assert.rejects(f.adapter.verifyShadow(f.plan,shadow),{code:'DEPLOYMENT_DATA_SCHEMA_CHANGE_UNSUPPORTED'});assert.equal(f.containers.get(old).State.Running,true);assert(!f.volumes.has('sdsh-'+project+'-'+generation+'-data'));
});

test('destructive SQL is held on a new shadow before original writer is stopped or source rows change',async t=>{
 const f=await fixture(t),statement='DROP TABLE orders;',p={...f.plan,migration:{sql:statement,sha256:crypto.createHash('sha256').update(statement).digest('hex'),fromVersion:0,toVersion:1}},active=await f.adapter.inspectActive(p);
 await assert.rejects(f.adapter.prepareShadow(p,active),{phase:'recovery_required'});assert.deepEqual(sql(f.file('production'),'SELECT id FROM orders').map(r=>r.id),[1]);assert.equal(f.containers.get(old).State.Running,true);assert(!f.volumes.has('sdsh-'+project+'-'+generation+'-data'));
});
test('Compose old-writer set must all stop; shared volume cannot be finalized while one writer remains active',async t=>{
 const f=await fixture(t),second='4'.repeat(64);f.containers.set(second,{...structuredClone(f.containers.get(old)),Id:second});const p={...f.plan,oldContainerIds:[old,second]},active=await f.adapter.inspectActive(p),shadow=await f.adapter.prepareShadow(p,active),verified=await f.adapter.verifyShadow(p,shadow);f.containers.get(old).State.Running=false;await assert.rejects(f.adapter.finalizeLatest(p,verified),{code:'DEPLOYMENT_DATA_OLD_WRITER_NOT_STOPPED'});f.containers.get(second).State.Running=false;assert((await f.adapter.finalizeLatest(p,verified)).finalVolume);
});
test('first-init migration uses inspected owner without added capabilities',async t=>{
 const f=await fixture(t,{first:true}),statement='ALTER TABLE orders ADD COLUMN note TEXT;',migration={sql:statement,sha256:crypto.createHash('sha256').update(statement).digest('hex'),fromVersion:0,toVersion:1},p={...f.plan,migration};
 const active=await f.adapter.inspectActive(p),shadow=await f.adapter.prepareShadow(p,active);sql(f.file(shadow.shadowVolume),'CREATE TABLE orders(id INTEGER PRIMARY KEY);');const baseline=await f.adapter.verifyShadow(p,shadow,{captureBaseline:true});assert.equal(baseline.migrationDisposition,'applied-before-tests');const body=f.bodies.find(body=>JSON.parse(body.Cmd[2]).migrate);assert(body);assert.match(body.User,/^\d+:\d+$/);assert.equal(body.HostConfig.CapAdd,undefined);assert.deepEqual(body.HostConfig.CapDrop,['ALL']);assert.equal(body.HostConfig.Mounts.length,1);assert.equal(body.HostConfig.Mounts[0].ReadOnly,false);
});
