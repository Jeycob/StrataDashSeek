'use strict';
// Explicit live pilot validation; only our included demo application is changed.
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');
const {DockerEngine,decodeLogs}=require('../vast/apps-engine.cjs');
const key=fs.readFileSync('/data/harness/secrets/apps-internal.key','utf8').trim();
const engine=new DockerEngine({url:'http://127.0.0.1:19075'});
async function api(route,data){const r=await fetch('http://127.0.0.1:3093/'+route,{method:data?'POST':'GET',headers:{'x-harness-apps-key':key,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(110000)});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status});return value;}
function preview(host){return new Promise((resolve,reject)=>{const started=Date.now();http.get({host:'127.0.0.1',port:18180,path:'/',headers:{Host:host},timeout:360000},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body,milliseconds:Date.now()-started}));}).on('error',reject).on('timeout',function(){this.destroy(Error('Preview timeout'));});});}
async function exec(id,cmd){await engine.owned(id);const e=await engine.json('POST','/containers/'+id+'/exec',{json:{AttachStdout:true,AttachStderr:true,Cmd:cmd}});const r=await engine.request('POST','/exec/'+e.Id+'/start',{json:{Detach:false,Tty:false},timeout:10000});return decodeLogs(r.body);}
async function main(){
 const result={at:new Date().toISOString(),operations:[]};
 try{
  result.initial=await api('state');const p=await api('register',{path:'docker-demo'});
  async function perform(action){const job=await api('project-action',{id:p.id,action});for(let n=0;n<1800;n++){const state=await api('state'),saved=state.jobs.find(j=>j.id===job.id);if(!['queued','running'].includes(saved.status)){result.operations.push({...saved,log:(await api('job-log?id='+job.id)).text});if(saved.status!=='passed')throw Error(action+': '+saved.error);return saved;}await new Promise(r=>setTimeout(r,200));}throw Error('Job timeout');}
  await perform('build');await perform('deploy');await perform('check');
  let state=await api('state'),saved=state.projects.find(x=>x.id===p.id);result.containerId=saved.containerId;result.imageId=saved.deployedImageId;
  const marker='PERSIST_'+crypto.randomBytes(8).toString('hex');await exec(saved.containerId,['sh','-c',"printf '%s' '"+marker+"' > /tmp/strata-persist-check"]);
  await api('hold',{minutes:1});try{await api('prepare-sleep',{});throw Error('Awake lease was ignored');}catch(e){if(e.status!==409)throw e;result.holdProtected=true;}await api('hold',{minutes:0});
  const beforeSleep=Date.now(),prepared=await api('prepare-sleep',{});result.sleepMilliseconds=Date.now()-beforeSleep;await api('confirm-sleep',{token:prepared.token});result.asleep=await api('state');if(result.asleep.worker.phase!=='asleep')throw Error('Worker did not sleep');
  result.rejectedHarnessHostname=await preview('vast-harness.tail9a42c6.ts.net');if(result.rejectedHarnessHostname.status!==421)throw Error('Harness cookies could reach the preview');
  if((await api('state')).worker.phase!=='asleep')throw Error('Rejected preview woke Docker');
  await api('cancel-sleep',{token:prepared.token});result.resumedPreview=await preview('100.122.37.80');if(result.resumedPreview.status!==200||!result.resumedPreview.body.includes('HARNESS_DEPLOYED_APP_OK'))throw Error('Preview did not wake and restore its container');
  state=await api('state');saved=state.projects.find(x=>x.id===p.id);if(saved.containerId!==result.containerId||saved.deployedImageId!==result.imageId)throw Error('Unexpected rebuilt or replaced container');
  result.persistedWritableLayer=(await exec(saved.containerId,['cat','/tmp/strata-persist-check'])).trim()===marker;if(!result.persistedWritableLayer)throw Error('Writable layer was lost');
  await perform('check');result.final=await api('state');result.passed=true;
 }catch(e){result.passed=false;result.error=e.stack;process.exitCode=1;}
 finally{fs.writeFileSync('/data/harness/state/apps-live-lifecycle-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,error:result.error,operations:result.operations.map(j=>({action:j.action,status:j.status,milliseconds:j.endedAt-j.startedAt})),sleepMilliseconds:result.sleepMilliseconds,wakeMilliseconds:result.resumedPreview?.milliseconds,persistedWritableLayer:result.persistedWritableLayer,containerId:result.containerId}));}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
