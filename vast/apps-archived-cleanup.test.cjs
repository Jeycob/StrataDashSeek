'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {graph,ArchivedDockerCleanup}=require('./apps-archived-cleanup.cjs'),{LABEL}=require('./apps-engine.cjs');
const image='sha256:'+'a'.repeat(64),cid='b'.repeat(64),jobId='c'.repeat(16),pid='d'.repeat(16),token='e'.repeat(32),sid='session-owned';
function source(){const root=path.resolve('/synthetic/project'),record={containerId:cid,projectId:pid,jobId,imageId:image,name:'sdsh-'+pid+'-'+jobId,token,state:'created',role:'candidate'};return{authority:{sessions:[{id:sid,root,managed:true,title:'Chat title'}],archivedIds:[sid],activeIds:[],pinnedIds:[],workspaceRefs:[]},projects:{[pid]:{id:pid,directory:root,name:'Project name',dataPolicy:{kind:'stateless'}}},jobs:[{id:jobId,status:'failed',creations:[record]}],releases:[],deployments:[],saved:{resumeIds:[]},containers:[{Id:cid,Image:image,Name:'/'+record.name,Config:{Labels:{[LABEL]:'managed',[LABEL+'.project']:pid,[LABEL+'.job']:jobId,[LABEL+'.create']:token}},State:{Status:'exited',Running:false},Mounts:[]}],images:[{Id:image,Parent:'',Size:1000,RepoTags:['stratadashseek-app:'+pid+'-'+jobId],Labels:{[LABEL]:'managed',[LABEL+'.project']:pid,[LABEL+'.source']:'f'.repeat(64)}}],daemonId:'fixture-daemon'};}
test('manual unused resources remain eligible for an unarchived idle chat; auto is archived only',()=>{const s=source();s.authority.archivedIds=[];const r=graph(s).rows;assert.ok(r.every(r=>r.eligible));assert.ok(r.every(r=>!r.automaticEligible));assert.equal(r[0].displayName,'sdsh-'+pid+'-'+jobId);assert.deepEqual(r[0].projectNames,['Project name']);assert.deepEqual(r[0].chatNames,['Chat title']);});
test('shared, live, published, rollback, resume and incomplete-reference resources KEEP independently',()=>{const scenarios=[s=>s.authority.sessions.push({...s.authority.sessions[0],id:'session-other'}),s=>s.authority.activeIds.push(sid),s=>s.projects[pid].containerId=cid,s=>s.releases.push({status:'passed',containerId:cid,imageId:image}),s=>s.saved.resumeIds.push(cid),s=>s.unknown=['REFERENCE_UNKNOWN'],s=>s.containers[0].Mounts.push({Type:'volume',Source:'persistent-db'}),s=>s.jobs[0].status='running'];for(const change of scenarios){const s=source();change(s);assert.equal(graph(s).rows.find(r=>r.id===cid).eligible,false);}});
test('labels cannot adopt legacy resources without control-plane creation records; foreign tag keeps image',()=>{const s=source();s.jobs=[];assert.ok(graph(s).rows.every(r=>!r.eligible));const tagged=source();tagged.images[0].RepoTags.push('another-owner:latest');assert.ok(graph(tagged).rows.find(r=>r.kind==='image').reasonCodes.includes('OWNER_SHARED'));});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'archived-cleanup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const state=path.join(dir,'apps'),wb=path.join(dir,'wb'),root=path.join(dir,'project');for(const d of [state,wb,root])fs.mkdirSync(d);const p=crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0,16),s=source();s.projects={[p]:{...s.projects[pid],id:p,directory:fs.realpathSync(root)}};s.authority.sessions[0].root=fs.realpathSync(root);const c=s.jobs[0].creations[0];c.projectId=p;c.name='sdsh-'+p+'-'+jobId;s.containers[0].Name='/'+c.name;s.containers[0].Config.Labels[LABEL+'.project']=p;s.images[0].Labels[LABEL+'.project']=p;s.images[0].RepoTags=['stratadashseek-app:'+p+'-'+jobId];fs.writeFileSync(path.join(root,'.harness-app.json'),JSON.stringify({version:1,name:'Project name',dataPolicy:{kind:'stateless'}}));
 const authority=()=>fs.writeFileSync(path.join(wb,'docker-cleanup-authority.json'),JSON.stringify({version:1,token,pid:process.pid,reservedIds:[sid],expiresAt:Date.now()+60000,...s.authority}));authority();let calls=[],deleteHook;
 const manager={cfg:{stateDir:state,workbenchStateRoot:wb,enabled:true},store:{projects:s.projects,jobs:s.jobs},busy:null,ticking:false,previewRequests:0,setBusy(v){this.busy=v;},engine:{async json(method,route){calls.push([method,route]);if(route==='/info')return{ID:s.daemonId,Containers:s.containers.length};if(route==='/containers/json?all=true')return s.containers.map(c=>({Id:c.Id,Image:c.Image,State:c.State.Status}));if(route==='/images/json?all=true')return s.images.map(i=>({...i,ParentId:i.Parent}));if(route.startsWith('/containers/')&&route.endsWith('/json')){const id=decodeURIComponent(route.slice(12,-5));const c=s.containers.find(c=>c.Id===id);if(c)return structuredClone(c);throw{dockerStatus:404};}if(route.startsWith('/images/')&&route.endsWith('/json')){const id=decodeURIComponent(route.slice(8,-5));const i=s.images.find(i=>i.Id===id);if(i)return i;throw{dockerStatus:404};}throw Error('Unexpected route '+route);},async request(method,route){calls.push([method,route]);if(deleteHook)await deleteHook(route);if(route.startsWith('/containers/'))s.containers=s.containers.filter(c=>!route.includes(c.Id));else s.images=s.images.filter(i=>!route.includes(encodeURIComponent(i.Id)));return{status:204};}}};const cleanup=new ArchivedDockerCleanup(manager);return{dir,s,manager,cleanup,authority,calls,setDeleteHook(fn){deleteHook=fn;}};}
async function preview(f,automatic=false){return(await f.cleanup.handle({op:'preview',token,automatic})).plan;}

test('unordered Docker census and tag sets preserve a plan while semantic changes still invalidate it',async t=>{
 const f=fixture(t),foreign='sha256:'+'8'.repeat(64);f.s.images.push({Id:foreign,Parent:'',Size:500,RepoTags:['foreign:one'],Labels:{}});f.s.images[0].RepoTags.push(f.s.images[0].RepoTags[0]+'-extra');
 f.s.containers.push({Id:'9'.repeat(64),Image:foreign,Name:'/foreign',Config:{Labels:{}},State:{Running:false,Status:'exited'},Mounts:[{Type:'volume',Source:'first',Destination:'/first'},{Type:'volume',Source:'second',Destination:'/second'}]});
 const before=await f.cleanup.capture(token),plan=await preview(f);f.s.images.reverse();f.s.containers.reverse();for(const i of f.s.images)i.RepoTags.reverse();for(const c of f.s.containers)c.Mounts.reverse();
 const after=await f.cleanup.capture(token);assert.equal(after.binding,before.binding);assert.deepEqual(after.rows,before.rows);
 const done=await f.cleanup.handle({op:'apply',token,planId:plan.id,planHash:plan.hash,selections:[{kind:'container',id:cid}]});assert.equal(done.operation.state,'completed');assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,1);
 const a=graph(f.s).binding;f.s.images.find(i=>i.Id===foreign).Size++;assert.notEqual(graph(f.s).binding,a);
 const b=graph(f.s).binding;f.s.containers[0].Mounts[0].Source='changed';assert.notEqual(graph(f.s).binding,b);
});

test('consumed plan returns one durable receipt for canonical retries, across new plans, expiry and restart',async t=>{
 const f=fixture(t);f.setDeleteHook(()=>{throw{dockerStatus:409};});
 const p=await preview(f),apply={op:'apply',token,planId:p.id,planHash:p.hash,selections:p.selection};
 const first=structuredClone((await f.cleanup.handle(apply)).operation);
 assert.equal(first.planId,p.id);assert.equal(first.planHash,p.hash);assert.deepEqual(first.selection,p.selection);
 assert.ok(first.results.every(r=>r.outcome==='kept'));
 const count=()=>f.calls.filter(c=>c[0]==='DELETE').length;assert.equal(count(),1);
 const retry=(await f.cleanup.handle({...apply,selections:[...p.selection].reverse()})).operation;
 assert.deepEqual(retry,first);assert.equal(count(),1);
 await assert.rejects(f.cleanup.handle({...apply,selections:[p.selection[0]]}),e=>e.code==='CLEANUP_PLAN_CONSUMED');
 await assert.rejects(f.cleanup.handle({...apply,planHash:'0'.repeat(64)}),e=>e.code==='CLEANUP_PLAN_CONSUMED');
 const newer=await preview(f);assert.notEqual(newer.id,p.id);
 const second=(await f.cleanup.handle({...apply,planId:newer.id,planHash:newer.hash,selections:newer.selection})).operation;
 assert.notEqual(second.id,first.id);assert.equal(count(),2);
 // The original plan is no longer current; its expiry has no bearing on receipts.
 f.cleanup.data.plans[newer.id].expiresAt=0;f.cleanup.save();
 const restarted=new ArchivedDockerCleanup(f.manager);
 restarted.capture=()=>assert.fail('Receipt replay must not inspect or mutate Docker');
 assert.deepEqual((await restarted.handle(apply)).operation,first);assert.equal(count(),2);
 assert.equal(restarted.data.operation.id,second.id,'Historical lookup must not replace latest');
 for(const selector of [{planId:p.id},{operationId:first.id},{planId:p.id,operationId:first.id}]){
  assert.deepEqual((await restarted.handle({op:'reconcile',token,...selector})).operation,first);
 }
 await assert.rejects(restarted.handle({op:'reconcile',token,operationId:first.id,planId:newer.id}),e=>e.status===404&&e.code==='CLEANUP_OPERATION_NOT_FOUND');
 assert.equal(count(),2);
});

test('apply binding is durable before DELETE and lost outcome retry never replays deletion',async t=>{
 const f=fixture(t),p=await preview(f),apply={op:'apply',token,planId:p.id,planHash:p.hash,selections:p.selection};
 f.setDeleteHook(()=>{
  const disk=JSON.parse(fs.readFileSync(f.cleanup.file,'utf8')),receipt=disk.receipts[p.id];
  assert.equal(receipt.id,disk.operation.id);assert.equal(receipt.planHash,p.hash);
  assert.deepEqual(receipt.selection,p.selection);assert.ok(receipt.intent);
  f.s.containers=[];throw Error('response lost');
 });
 const first=structuredClone((await f.cleanup.handle(apply)).operation);
 assert.equal(first.state,'reconciliation_required');
 const restarted=new ArchivedDockerCleanup(f.manager);
 assert.deepEqual((await restarted.handle(apply)).operation,first);
 assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,1);
 const done=(await restarted.handle({op:'reconcile',token,planId:p.id})).operation;
 assert.equal(done.id,first.id);assert.equal(done.state,'completed');
 assert.equal(done.results[0].outcome,'already_absent');
 assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,1);
});

test('selected operation lookup never falls back to latest, including when worker sleeps',async t=>{
 const f=fixture(t);f.cleanup.data.operation={id:'a'.repeat(32),state:'completed',results:[]};f.cleanup.save();
 f.manager.worker={status:()=>({phase:'asleep'})};
 await assert.rejects(f.cleanup.handle({op:'reconcile',token,operationId:'b'.repeat(32)}),e=>e.status===404&&e.code==='CLEANUP_OPERATION_NOT_FOUND');
 await assert.rejects(f.cleanup.handle({op:'reconcile',token,operationId:''}),e=>e.status===400);
 assert.equal((await f.cleanup.handle({op:'reconcile',token,operationId:'a'.repeat(32)})).operation.id,'a'.repeat(32));
 assert.equal(f.calls.length,0);
});

test('inventory and periodic preview preserve idle deadline and respect sleep drain',async t=>{
 const f=fixture(t);f.manager.lastActivity=123;let beats=0;
 f.manager.setBusy=()=>assert.fail('Maintenance must not reset idle time');
 f.manager.heartbeat=()=>{beats++;};
 await f.cleanup.handle({op:'status',token});await preview(f,true);
 assert.equal(f.manager.lastActivity,123);assert.equal(f.manager.busy,null);assert.equal(beats,4);
 const before=f.calls.length;f.manager.sleepToken=()=> 'sleep-drain';
 assert.equal((await f.cleanup.handle({op:'status',token})).reasonCode,'APPS_BUSY');
 await assert.rejects(preview(f,true),/CLEANUP_BUSY/);assert.equal(f.calls.length,before);
});
test('container phase precedes fresh image census; receipt and preference survive controller restart',async t=>{const f=fixture(t),p=await preview(f);assert.equal(p.selection.length,2);const result=await f.cleanup.handle({op:'apply',token,planId:p.id,planHash:p.hash,selections:p.selection});assert.equal(result.operation.state,'completed');const deletes=f.calls.filter(c=>c[0]==='DELETE');assert.equal(deletes.length,2);assert.match(deletes[0][1],/^\/containers\//);assert.match(deletes[1][1],/^\/images\//);assert.ok(deletes.every(c=>!c[1].includes('force=true')&&!c[1].includes('v=true')));assert.equal(f.s.images.length,0);await f.cleanup.handle({op:'settings',enabled:false});const restarted=new ArchivedDockerCleanup(f.manager);assert.equal(restarted.data.enabled,false);assert.equal(restarted.data.operation.id,result.operation.id);});
test('unarchive/move after preview makes plan stale before any DELETE',async t=>{const f=fixture(t),p=await preview(f);f.s.authority.archivedIds=[];f.authority();await assert.rejects(f.cleanup.handle({op:'apply',token,planId:p.id,planHash:p.hash,selections:p.selection}),/CLEANUP_PLAN_STALE/);assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,0);});
test('recheck after container removal keeps newly referenced image; no force or image graph replay',async t=>{const f=fixture(t),p=await preview(f);f.setDeleteHook(route=>{if(route.startsWith('/containers/')){f.s.authority.activeIds=[sid];f.authority();}});const result=await f.cleanup.handle({op:'apply',token,planId:p.id,planHash:p.hash,selections:p.selection});assert.equal(result.operation.results[1].outcome,'kept');assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,1);});
test('lost DELETE response persists intent; retry reconciles absence without repeating DELETE',async t=>{const f=fixture(t),p=await preview(f);f.setDeleteHook(()=>{f.s.containers=[];throw Error('response lost');});const r=await f.cleanup.handle({op:'apply',token,planId:p.id,planHash:p.hash,selections:p.selection});assert.equal(r.operation.state,'reconciliation_required');assert.ok(r.operation.intent);const restarted=new ArchivedDockerCleanup(f.manager);const done=await restarted.handle({op:'reconcile',token});assert.equal(done.operation.state,'completed');assert.equal(done.operation.results[0].outcome,'already_absent');assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,1);assert.equal(f.s.images.length,1);});
test('sleeping/unavailable and busy paths do not ensure or query a sleeping daemon',async t=>{const f=fixture(t);f.manager.worker={status:()=>({phase:'asleep'}),ensure(){assert.fail('No wake');}};const p=await f.cleanup.handle({op:'preview',token});assert.equal(p.availability,'deferred');assert.equal(f.calls.length,0);f.manager.busy='build';assert.equal((await f.cleanup.handle({op:'status',token})).reasonCode,'APPS_BUSY');await assert.rejects(f.cleanup.handle({op:'preview',token}),/CLEANUP_BUSY/);});
test('incomplete daemon census and forged read-only grant cannot authorize removal',async t=>{const f=fixture(t),original=f.manager.engine.json;f.manager.engine.json=async(method,route)=>route==='/info'?{ID:'fixture-daemon',Containers:99}:original(method,route);const status=await f.cleanup.handle({op:'status',token});assert.equal(status.reasonCode,'INVENTORY_INCOMPLETE');assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,0);f.manager.engine.json=original;const p=await preview(f),file=path.join(f.manager.cfg.workbenchStateRoot,'docker-cleanup-authority.json'),grant=JSON.parse(fs.readFileSync(file));grant.reservedIds=[];fs.writeFileSync(file,JSON.stringify(grant));await assert.rejects(f.cleanup.handle({op:'apply',token,planId:p.id,planHash:p.hash,selections:p.selection}),e=>e.code==='CLEANUP_AUTHORITY_REQUIRED'&&e.status===403);assert.equal(f.cleanup.data.operation,null);});
test('composed owner API preview/apply uses server reservation and real control-plane collector',async t=>{const f=fixture(t);await f.cleanup.handle({op:'settings',enabled:false});const {installDockerCleanup}=await import('../workspace/docker-cleanup.mjs'),root=f.s.authority.sessions[0].root,wb=f.manager.cfg.workbenchStateRoot;fs.mkdirSync(path.join(root,'.harness'));fs.writeFileSync(path.join(root,'.harness/project.json'),JSON.stringify({root,sessionId:sid}));let chain=Promise.resolve(),work=Promise.resolve(),handler;const dispose=[],ctx={workspaceRegistry:{get archivedSessionIds(){return f.s.authority.archivedIds;},pinnedSessionIds:[],list:()=>[],enqueueOperation(fn){const p=chain.then(fn);chain=p.catch(()=>{});return p;}},agents:{list:()=>[]},sessionPersistence:{list:async()=>[{header:{id:sid,cwd:root,title:'Chat title'}}]},waterfall:async(_name,_value,next)=>next(),logger:{warn(){}},on(){return()=>{};},effect(fn){const d=fn();if(typeof d==='function')dispose.push(d);},connection:{fetch:{register(route){handler=route.fetch;return()=>{};}}}};ctx.root=ctx;const manager={root:wb,data:{sessions:{[sid]:{root,sourceRoot:root}}},inOrder(fn){const p=work.then(fn);work=p.catch(()=>{});return p;}};installDockerCleanup(ctx,manager,{stateDir:f.manager.cfg.stateDir},async(_route,input)=>f.cleanup.handle(input));t.after(async()=>{for(const d of dispose.reverse())await d();});
 const post=body=>handler(new Request('https://owner.test/api/workbench/docker-cleanup',{method:'POST',headers:{host:'owner.test',origin:'https://owner.test','content-type':'application/json'},body:JSON.stringify(body)}));const response=await post({op:'preview'});assert.equal(response.status,200);const p=(await response.json()).plan;assert.equal(p.selection.length,2);const applied=await post({op:'apply',planId:p.id,planHash:p.hash,selections:p.selection});assert.equal(applied.status,200,await applied.clone().text());const result=await applied.json();assert.equal(result.operation.state,'completed');assert.equal(result.operation.results.filter(r=>r.outcome==='removed').length,2);assert.equal(fs.existsSync(path.join(wb,'docker-cleanup-authority.json')),false);});
