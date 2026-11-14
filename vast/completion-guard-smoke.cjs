// Optional Linux integration fixture: real installed Harness, loopback-only fake
// model, isolated home/profile/project. Does not contact the GPU or cloud LLMs.
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const R='/data/harness',runtime=process.env.HOMEAI_RUNTIME||R+'/runtime',node=R+'/node/bin/node',req=createRequire(runtime+'/node_modules/@deepseek-ai/dsh/package.json'),yaml=req('yaml');
const origin='http://127.0.0.1:3190',dir=R+'/home/.completion-guard-smoke-'+Date.now(),home=dir+'/.dsh',profile=home+'/profiles/web',project=dir+'/project',log=dir+'/harness.log';
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,server,calls=0,cookie='',steeringSeen=false;
function fixtureResponse(res,delta,reason){
 res.writeHead(200,{'Content-Type':'text/event-stream'});const base={id:'chatcmpl-guard-fixture-'+calls,object:'chat.completion.chunk',created:1,model:'guard-fixture'};
 for(const [d,f] of [[{role:'assistant',...delta},null],[{},reason]])res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:d,finish_reason:f}]})+'\n\n');
 res.write('data: '+JSON.stringify({...base,choices:[],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}})+'\n\n');res.end('data: [DONE]\n\n');
}
async function local(route,body){const r=await fetch(origin+route,{method:body?'POST':'GET',headers:{Origin:origin,Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(5000)});return r;}
async function rpc(method,request){const r=await local('/api/'+method,{type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:method==='session/list'?{_request:request}:{request}}}),d=await r.json();if(!r.ok||!d.result?.ok)throw Error('Fixture RPC failed: '+method);return d.result.value;}
(async()=>{
 fs.mkdirSync(profile,{recursive:true,mode:0o700});fs.mkdirSync(project,{mode:0o700});fs.mkdirSync(dir+'/state',{mode:0o700});
 for(const name of ['package.json','cordis.yml'])fs.copyFileSync(R+'/home/.dsh/profiles/web/'+name,profile+'/'+name);
 const doc=yaml.parseDocument(fs.readFileSync(R+'/home/.dsh/profiles/web/cordis.patch.yml','utf8'));if(doc.errors.length)throw doc.errors[0];
 function walk(n){if(yaml.isMap(n)){if(n.get('id')==='llm-pi-ai'){const p=n.getIn(['config','providers','strata-vast']).clone();p.set('baseURL','http://127.0.0.1:18889/v1');n.setIn(['config','providers'],doc.createNode({'strata-vast':p.toJSON()}));}for(const pair of n.items)walk(pair.value);}else if(yaml.isSeq(n)){for(const x of n.items)walk(x);}else if(yaml.isScalar(n)&&typeof n.value==='string'&&n.value.startsWith(R+'/state/'))n.value=dir+'/state/'+n.value.slice((R+'/state/').length);}
 walk(doc.contents);fs.writeFileSync(profile+'/cordis.patch.yml',String(doc),{mode:0o600});
 const uid=Number(cp.execFileSync('id',['-u','harness'])),gid=Number(cp.execFileSync('id',['-g','harness']));
 function own(p){fs.chownSync(p,uid,gid);if(fs.statSync(p).isDirectory())for(const x of fs.readdirSync(p))own(path.join(p,x));}own(dir);
 server=http.createServer(async(q,s)=>{try{
  if(q.url==='/v1/models'){s.setHeader('Content-Type','application/json');s.end(JSON.stringify({object:'list',data:[{id:'strata',object:'model'}]}));return;}
  if(q.url!=='/v1/chat/completions'){s.writeHead(404);s.end();return;}
  const chunks=[];for await(const c of q)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));calls++;
  if(calls>5)throw Error('Fixture request ceiling exceeded');
  const command=calls===1?'printf initial > guard-marker.txt':'printf resumed >> guard-marker.txt';
  if(calls===1||calls===3){if(calls===3){steeringSeen=JSON.stringify(body.messages).includes('[Completion check 1/2]');if(!steeringSeen)throw Error('Missing completion steering');}fixtureResponse(s,{tool_calls:[{index:0,id:'guard-tool-'+calls,type:'function',function:{name:'bash',arguments:JSON.stringify({command,description:'Isolated completion-guard fixture'})}}]},'tool_calls');}
  else fixtureResponse(s,{content:calls===2?'Now the stylesheet.':'Done. Fixture marker verified.'},'stop');
 }catch{if(!s.headersSent)s.writeHead(500);s.end();}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18889,'127.0.0.1',resolve);});
 const out=fs.openSync(log,'a',0o600);fs.fchownSync(out,uid,gid);
 child=cp.spawn(node,[runtime+'/node_modules/@deepseek-ai/dsh/lib/bin.js','web','--no-open','--port','3190','--public-url',origin+'/','--trusted-host','127.0.0.1:3190'],{cwd:project,uid,gid,detached:true,env:{HOME:dir,DSH_HOME:home,PATH:R+'/node/bin:/usr/local/bin:/usr/bin:/bin',STRATA_GATEWAY_KEY:'local-fixture'},stdio:['ignore',out,out]});fs.closeSync(out);
 let launch;const deadline=Date.now()+90000;
 while(Date.now()<deadline){if(child.exitCode!==null)throw Error('Fixture Harness exited');const text=fs.readFileSync(log,'utf8');launch=[...text.matchAll(/http:\/\/127\.0\.0\.1:3190\/\?token=([^\s]+)/g)].at(-1)?.[1];if(launch)break;await pause(250);}
 if(!launch)throw Error('Fixture launch timed out');const auth=await local('/?token='+encodeURIComponent(launch));cookie=auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');if(!cookie)throw Error('Fixture login failed');
 const created=await rpc('session/create',{cwd:project}),id=created.sessionId;await rpc('session/selectModel',{sessionId:id,provider:'strata-vast',model:'strata',reasoningEffort:'off'});
 await rpc('session/prompt',{sessionId:id,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'Use the bash tool to write guard-marker.txt in this isolated fixture project. Complete the task and verify the marker.'}]});
 let ended=false;for(let i=0;i<160;i++){const x=(await rpc('session/list',{})).items.find(x=>x.sessionId===id);if(x&&!x.running){ended=true;break;}await pause(250);}
 if(!ended)throw Error('Fixture turn did not finish');const p=await rpc('session/projections',{sessionId:id}),page=await rpc('session/page',{address:{kind:'session',sessionId:id},throughSeq:p.asOfSeq,maxMessages:200}),events=page.records.filter(x=>x.type==='event').map(x=>x.event);
 const turns=events.filter(e=>e.type==='turn/end'),corrections=events.filter(e=>e.type==='user/message'&&JSON.stringify(e.data).includes('\"kind\":\"homeai-completion-guard\"'));
 const marker=fs.existsSync(project+'/guard-marker.txt')?fs.readFileSync(project+'/guard-marker.txt','utf8'):'';
 const result={passed:turns.length===1&&turns[0].data.reason.kind==='completed'&&calls===4&&steeringSeen&&marker==='initialresumed',modelRequests:calls,sameTurn:turns.length===1,steeringSeen,correctionsLogged:corrections.length,marker,realHarness:true,realModel:false,usedGPU:false};
 fs.writeFileSync('/data/migration/completion-guard-smoke-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.passed)throw Error('Fixture continuation check failed');
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}await pause(1500);try{process.kill(-child.pid,'SIGKILL');}catch{}}if(server)await new Promise(r=>server.close(r));});

