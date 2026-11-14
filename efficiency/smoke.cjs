'use strict';
// Real Harness, fake LLM: verify the actual plugin seams without GPU inference.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const R='/data/harness',node=R+'/node/bin/node',runtime=R+'/runtime',yaml=createRequire(runtime+'/node_modules/@deepseek-ai/dsh/package.json')('yaml');
const {installEfficiency}=require('./install.cjs');
const origin='http://127.0.0.1:3197',pause=ms=>new Promise(r=>setTimeout(r,ms));
const checks={},results=[];let runningChild,runningServer;
const sampleProfile='- insert:\n  - id: cloud-homeai-turn-queue-v1\n    name: file:///data/harness/app/vast/turn-queue/plugin.mjs\n  - id: unchanged\n    name: example\n    config:\n      value: keep-me\n';
const installed=installEfficiency(sampleProfile,yaml);assert.equal(installEfficiency(installed,yaml),installed);assert(installed.includes('keep-me'));assert(!installed.includes('cloud-homeai-turn-queue-v1'));assert.throws(()=>installEfficiency(sampleProfile.replace('/vast/turn-queue/plugin.mjs','/unexpected.mjs'),yaml));assert.throws(()=>installEfficiency(sampleProfile,yaml,{schedule:false}));checks['semantic-installer-is-idempotent-and-single-scheduler']=true;
async function fixture(mode){
 const dir=R+'/home/.efficiency-smoke-'+mode+'-'+Date.now(),home=dir+'/.dsh',profile=home+'/profiles/web',source=dir+'/source',log=dir+'/harness.log',state=dir+'/state/efficiency';
 fs.mkdirSync(profile,{recursive:true,mode:0o700});fs.mkdirSync(source,{recursive:true,mode:0o700});fs.mkdirSync(state,{recursive:true,mode:0o700});
 for(const name of ['package.json','cordis.yml'])fs.copyFileSync(R+'/home/.dsh/profiles/web/'+name,profile+'/'+name);
 let doc=yaml.parseDocument(fs.readFileSync(R+'/home/.dsh/profiles/web/cordis.patch.yml','utf8'));if(doc.errors.length)throw doc.errors[0];
 const entries=[];
 function visit(n){if(yaml.isMap(n)){
   if(n.get('id'))entries.push(n);
   if(n.get('id')==='llm-pi-ai'){const p=n.getIn(['config','providers','strata-vast']).clone();p.set('baseURL','http://127.0.0.1:18897/v1');n.setIn(['config','providers'],doc.createNode({'strata-vast':p.toJSON()}));}
   for(const p of n.items)visit(p.value);
 }else if(yaml.isSeq(n))for(const x of n.items)visit(x);else if(yaml.isScalar(n)&&typeof n.value==='string'&&n.value.startsWith(R+'/state/'))n.value=dir+'/state/'+n.value.slice((R+'/state/').length);}
 visit(doc.contents);
 const workspace=entries.find(x=>x.get('id')==='cloud-workspace-runtime');if(!workspace)throw Error('Coordinated workspace runtime must be installed first.');
 workspace.get('config').set('stateRoot',dir+'/state/workbench');workspace.get('config').set('projectsRoot',dir+'/projects');workspace.get('config').set('portBase',34800);workspace.get('config').set('environmentReport',dir+'/state/development.json');
 if(mode==='request')doc=yaml.parseDocument(installEfficiency(String(doc),yaml,{stateDirectory:state,statusPath:dir+'/state/turn-queue.json',engineMetrics:false}));
 else{
   const installed=entries.find(x=>x.get('id')==='cloud-qwen-efficiency-v1');if(installed){installed.set('id','cloud-homeai-turn-queue-v1');installed.set('name','file:///data/harness/app/vast/turn-queue/plugin.mjs');installed.set('config',doc.createNode({providers:['strata-vast'],statusPath:dir+'/state/turn-queue.json',compactionMaxTokens:8192}));}
   doc.contents.items.push(doc.createNode({insert:[{id:'fixture-efficiency-observer',name:'file:///data/harness/app/efficiency/plugin.mjs',config:{schedule:false,engineMetrics:false,stateDirectory:state,statusPath:dir+'/state/observed-queue.json'}}]}));
 }
 fs.writeFileSync(profile+'/cordis.patch.yml',String(doc),{mode:0o600});
 const uid=Number(cp.execFileSync('id',['-u','harness'])),gid=Number(cp.execFileSync('id',['-g','harness']));
 function own(p){fs.chownSync(p,uid,gid);if(fs.statSync(p).isDirectory())for(const n of fs.readdirSync(p))own(path.join(p,n));}own(dir);
 let cookie='',active=0,maxActive=0,calls=0,overlap=false,projectA,firstA;
 const plans=new Map(),wire=[];
 const server=http.createServer(async(req,res)=>{try{
   if(req.url==='/v1/models'){res.end(JSON.stringify({object:'list',data:[{id:'strata',object:'model'}]}));return;}
   const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks)),id=req.headers['x-harness-session'];
   const item=plans.get(id)?.shift();if(!item)throw Error('Unplanned fake model request for '+id);
   calls++;active++;maxActive=Math.max(active,maxActive);if(id!==firstA&&projectA&&fs.existsSync(projectA+'/.harness/slow-start')&&!fs.existsSync(projectA+'/.harness/slow-end'))overlap=true;
   wire.push({sessionId:id,body});const base={id:'chatcmpl-efficiency-'+calls,object:'chat.completion.chunk',created:1,model:'fixture'};
   const delta=typeof item==='string'?{content:item}:{tool_calls:[{index:0,id:'eff-tool-'+calls,type:'function',function:{name:item.name,arguments:JSON.stringify(item.args)}}]};
   res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})+'\n\n');await pause(60);
   res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:typeof item==='string'?'stop':'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...base,choices:[],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}})+'\n\n');active--;res.end('data: [DONE]\n\n');
 }catch(e){if(!res.headersSent)res.writeHead(500);res.end(JSON.stringify({error:{message:e.message}}));}});
 await new Promise((r,j)=>{server.once('error',j);server.listen(18897,'127.0.0.1',r);});runningServer=server;
 const out=fs.openSync(log,'a',0o600);fs.fchownSync(out,uid,gid);
 const child=cp.spawn(node,[runtime+'/node_modules/@deepseek-ai/dsh/lib/bin.js','web','--no-open','--port','3197','--public-url',origin+'/','--trusted-host','127.0.0.1:3197'],{cwd:source,uid,gid,detached:true,env:{HOME:dir,DSH_HOME:home,PATH:R+'/node/bin:/usr/local/bin:/usr/bin:/bin',STRATA_GATEWAY_KEY:'fixture'},stdio:['ignore',out,out]});fs.closeSync(out);runningChild=child;
 const request=(route,body)=>fetch(origin+route,{method:body?'POST':'GET',headers:{Origin:origin,Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual',signal:AbortSignal.timeout(10000)});
 async function rpc(method,args){const r=await request('/api/'+method,{type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:method==='session/list'?{_request:args}:{request:args}}}),v=await r.json();if(!r.ok||!v.result?.ok)throw Error('Fixture RPC '+method+': '+JSON.stringify(v).slice(0,700));return v.result.value;}
 async function api(body){const r=await request('/api/workbench',body),v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v;}
 async function waitTurn(id){for(let i=0;i<400;i++){const s=(await rpc('session/list',{})).items.find(x=>x.sessionId===id);if(s&&!s.running)return;await pause(50);}throw Error('Fixture turn timed out.');}
 async function prompt(id,steps){plans.set(id,steps);await rpc('session/prompt',{sessionId:id,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'Complete the isolated efficiency integration fixture. Preserve arithmetic behavior and verify changes.'}]});}
 const tool=(name,args)=>({name,args}),command=text=>tool('project_exec',{command:text,description:'Isolated efficiency fixture'});
 try{
   let token;for(let i=0;i<240;i++){token=[...fs.readFileSync(log,'utf8').matchAll(/http:\/\/127\.0\.0\.1:3197\/\?token=([^\s]+)/g)].at(-1)?.[1];if(token)break;if(child.exitCode!==null)throw Error('Fixture Harness exited');await pause(250);}if(!token)throw Error('Harness start timeout');
   const auth=await request('/?token='+encodeURIComponent(token));cookie=auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');assert(cookie);
   let ready=false;for(let i=0;i<100;i++){if(fs.existsSync(state+'/loaded.json')){ready=true;break;}await pause(100);}assert(ready,'Efficiency plugin did not load');
   const w=(await rpc('workspace/create',{path:source})).workspace;
   const create=async()=>(await rpc('session/create',{workspaceId:w.workspaceId})).sessionId;
   const a=await create(),b=await create();firstA=a;projectA=(await api()).projects[a].root;
   const start=Date.now();await prompt(a,[command(`node -e "const fs=require('fs');fs.writeFileSync('.harness/slow-start','1');setTimeout(()=>fs.writeFileSync('.harness/slow-end','1'),1400)"`),'Done. First fixture completed.']);
   for(let i=0;i<200&&!fs.existsSync(projectA+'/.harness/slow-start');i++)await pause(20);assert(fs.existsSync(projectA+'/.harness/slow-start'));
   const bStart=Date.now();await prompt(b,['Done. Second fixture completed.']);await waitTurn(b);const bLatencyMs=Date.now()-bStart;await waitTurn(a);
   assert.equal(maxActive,1);assert.equal(overlap,mode==='request');checks[mode+'-single-stream-and-expected-overlap']=true;
   const schedule={mode,secondTaskLatencyMs:bLatencyMs,pairedWallMs:Date.now()-start,maxActive,overlap};
   if(mode==='request'){
     const c=await create(),project=(await api()).projects[c].root;
     const before=Array.from({length:100},(_,i)=>`const value${i}=${i};`).join('\n')+'\nexports.total=(a,b)=>a+b;';
     const after=Array.from({length:100},(_,i)=>`const renamed${i}=${i};`).join('\n')+'\nexports.total=(a,b)=>a+b;';
     for(const [p,text]of Object.entries({'cart.js':before,'pass.test.cjs':"const test=require('node:test'),assert=require('node:assert/strict');test('sum remains correct',()=>assert.equal(require('./cart.js').total(2,3),5));",'.harness-quality.json':JSON.stringify({version:1,sources:['cart.js','pass.test.cjs'],requiredKinds:['test'],checks:[{id:'unit',kind:'test',command:['node','--test','pass.test.cjs']}]})}))await api({op:'file',sessionId:c,operation:'write',args:{path:p,text}});
     await prompt(c,[tool('verify_project',{kind:'all'}),tool('write',{file_path:project+'/cart.js',content:after}),tool('explain_rewrite',{path:'cart.js',sha256:crypto.createHash('sha256').update(before).digest('hex'),reason:'This synthetic fixture deliberately replaces the variable table to test the large-rewrite policy.',validationPlan:'Rerun the independent arithmetic test and verify that total(2,3) still returns five.'}),tool('write',{file_path:project+'/cart.js',content:after}),tool('focus_context',{files:[{path:'cart.js',start:98,lines:5}]}),tool('verify_project',{kind:'all'}),'Done. Rewrite fixture completed and verified.']);await waitTurn(c);
     assert.equal(fs.readFileSync(project+'/cart.js','utf8'),after);const cWire=wire.filter(x=>x.sessionId===c).map(x=>JSON.stringify(x.body));assert(cWire.some(x=>x.includes('REWRITE_EXPLANATION_REQUIRED')));assert(cWire.some(x=>x.includes('Current work summary')));assert(cWire.some(x=>x.includes('totalLines')));checks['native-focused-context-and-one-use-rewrite']=true;
     const d=await create();const noisy=command("node -e \"console.log('noise '.repeat(4000));console.error('Error: synthetic failed check');process.exitCode=7\"");await prompt(d,[noisy,noisy,'Done. Error evidence fixture completed.']);await waitTurn(d);
     const dWire=wire.filter(x=>x.sessionId===d),last=JSON.stringify(dWire.at(-1).body);assert(last.includes('Repeated identical'));assert(last.includes('exitCode=7'));assert(last.length<40000);checks['native-log-compaction-preserves-error']=true;
     await pause(100);const journal=fs.readFileSync(state+'/events.jsonl','utf8').trim().split('\n').map(JSON.parse);assert(journal.some(x=>x.type==='accepted'&&x.taskId===c));assert(journal.some(x=>x.type==='log-compacted'&&x.repeated));assert(journal.some(x=>x.type==='phase'&&x.phase==='model-queue'));checks['native-cost-and-verified-acceptance-events']=true;
     const series=wire.filter(x=>x.sessionId===a),tools=series[0].body.tools.map(x=>x.function.name);assert.deepEqual(tools,series[1].body.tools.map(x=>x.function.name));assert.equal(new Set(tools).size,tools.length);checks['native-stable-tool-order']=true;
   }
   results.push({...schedule,calls,dir,state});
 }finally{if(child.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}await pause(500);try{process.kill(-child.pid,'SIGKILL');}catch{}}await new Promise(r=>server.close(r));runningChild=null;runningServer=null;}
}
(async()=>{await fixture('turn');await fixture('request');const result={passed:true,checks,results,realHarness:true,realModel:false,usedGPU:false};fs.writeFileSync('/data/harness/state/efficiency-smoke-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));})().catch(e=>{console.error(e.stack);fs.writeFileSync('/data/harness/state/efficiency-smoke-result.json',JSON.stringify({passed:false,checks,results,error:e.message}));process.exitCode=1;}).finally(async()=>{if(runningChild?.pid)try{process.kill(-runningChild.pid,'SIGKILL');}catch{}if(runningServer)await new Promise(r=>runningServer.close(r));});
