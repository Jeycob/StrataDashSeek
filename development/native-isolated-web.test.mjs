import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import owner from '../workspace/owner-api.cjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,ms,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}finally{clearTimeout(timer);}}
test('full pinned Native isolated web boots authenticated workspace and owned session with AppsOFF and no model/guest/host fallback',{timeout:60000},async t=>{
 assert.equal(process.platform,'linux','This mandatory full Native fixture requires the complete existing Linux SDK');assert(process.env.EFFICIENCY_SDK_ROOT);assert(process.env.HARNESS_NATIVE_CLI);
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-isolated-web-')),home=path.join(directory,'home'),project=path.join(directory,'projects/owner'),outside=path.join(directory,'public-external');await fs.mkdir(home);await fs.mkdir(project,{recursive:true});await fs.mkdir(outside);await fs.mkdir(path.join(project,'.git'));await fs.mkdir(path.join(project,'.agents/skills'),{recursive:true});
 const instruction=path.join(outside,'AGENTS.md');await fs.writeFile(instruction,'PUBLIC_CONTEXT_SENTINEL_AGENTS');await fs.writeFile(path.join(outside,'SKILL.md'),'---\nname: public-sentinel\ndescription: PUBLIC_CONTEXT_SENTINEL_SKILL\n---\nPUBLIC_CONTEXT_SENTINEL_SKILL\n');await fs.symlink(instruction,path.join(project,'AGENTS.md'));await fs.symlink(outside,path.join(project,'.agents/skills/public-sentinel'));
 // Positive control establishes that this temp filesystem records actual
 // content accesses; checking stat itself does not update atime. No SDK patch.
 const sentinels=[instruction,path.join(outside,'SKILL.md')];for(const file of sentinels){await fs.utimes(file,1,2);await fs.readFile(file);assert((await fs.stat(file)).atimeMs>1000,'Synthetic fixture needs observable access times');await fs.utimes(file,1,2);}
 const unread=async()=>{for(const file of sentinels)assert.equal((await fs.stat(file)).atimeMs,1000,'Automatic host context content was accessed');};
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/native-isolated-web.mjs',import.meta.url)),directory],{cwd:directory,env:{HOME:home,USERPROFILE:home,DSH_HOME:path.join(home,'.dsh'),AGENTS_HOME:path.join(home,'.agents'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_DATA_HOME:path.join(home,'.local/share'),PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH??'/usr/bin:/bin'),EFFICIENCY_SDK_ROOT:process.env.EFFICIENCY_SDK_ROOT,HARNESS_NATIVE_CLI:process.env.HARNESS_NATIVE_CLI,DSH_TELEMETRY_DISABLED:'fixture'},stdio:['ignore','pipe','pipe','ipc'],detached:true});
 let output='',closed=false;const messages=[];child.stdout.on('data',data=>{output=(output+data).slice(-65536);});child.stderr.on('data',data=>{output=(output+data).slice(-65536);});child.on('message',message=>messages.push(message));const completion=new Promise(resolve=>child.on('close',(code,signal)=>{closed=true;resolve({code,signal});}));
 const safeOutput=()=>output.replace(/https?:\/\/\S+/g,'[owned-fixture-url]').slice(-6000);
 t.after(async()=>{if(!closed){try{process.kill(-child.pid,'SIGKILL');}catch{}}await bounded(completion,5000,'Owned fixture failed to close');const real=await fs.realpath(directory);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('homeai-isolated-web-'));await fs.rm(real,{recursive:true,force:true});});
 async function wait(kind,ms=30000){const until=Date.now()+ms;while(Date.now()<until){const value=messages.find(message=>message.kind===kind);if(value)return value;assert(!closed,'Owned full web fixture exited: '+safeOutput());await pause(25);}assert.fail('Owned full web fixture did not reach '+kind+': '+safeOutput());}
 const ready=await wait('ready');assert.equal(ready.mode,'isolated-guest');assert.equal(ready.ready,true);assert.equal(ready.firstToolSet,true);assert.equal(ready.modelStreams,0);assert.equal(ready.fsObservations,0);await unread();
 const url=new URL(ready.loginUrl);assert.equal(url.hostname,'127.0.0.1');let cookie='',location=url.href;
 const anonymous=await fetch(new URL('/api/workbench/execution',url),{signal:AbortSignal.timeout(5000),redirect:'manual'});await anonymous.arrayBuffer();assert([401,403].includes(anonymous.status),'Actual Native API must reject an anonymous owner request');
 for(let n=0;n<6;n++){const next=new URL(location);assert.equal(next.origin,url.origin);const response=await fetch(next,{redirect:'manual',signal:AbortSignal.timeout(5000),headers:cookie?{Cookie:cookie}:{}});for(const value of response.headers.getSetCookie())cookie=value.split(';')[0];await response.arrayBuffer();if(!response.headers.get('location'))break;location=new URL(response.headers.get('location'),next).href;}
 assert(cookie,'Actual Native launch exchange must create an owner cookie');
 const get=async route=>{const response=await fetch(new URL(route,url),{signal:AbortSignal.timeout(5000),headers:{Cookie:cookie}});const text=await response.text();assert(text.length<1024*1024);assert.equal(response.status,200,text.slice(0,500));return JSON.parse(text);};
 const health=await get('/api/workbench/health');assert.equal(health.workspaceReady,true);assert.equal(health.admission.enforced,true);assert.equal(health.activeAgents,0);
 assert.deepEqual(await get('/api/workbench/execution'),{version:1,mode:'isolated-guest',available:true});
 const api=owner.createOwnerAPI({root:directory,host:url.host,port:Number(url.port)}),catalog=await api.call('session/modelCatalog',{},cookie);assert(catalog&&typeof catalog==='object');
 const ownList=await api.call('session/list',{},cookie);assert.equal(ownList.items.length,1);assert.equal(ownList.items[0].sessionId,ready.sessionId);
 const models=await get('/api/workbench/models?sessionId='+encodeURIComponent(ready.sessionId));assert.equal(models.sessionId,ready.sessionId);assert(Array.isArray(models.groups));assert(models.groups.length>0);
 child.send({kind:'proof'});const proof=await wait('proof',10000);assert.equal(proof.isError,true,proof.body);assert.match(proof.body,/PROJECT_RUNTIME_ISOLATION_UNAVAILABLE/);assert.equal(proof.modelStreams,0);assert.equal(proof.fsObservations,0);assert(!proof.body.includes('PUBLIC_CONTEXT_SENTINEL_HOST_FALLBACK'));assert(proof.nativeExecutorRows>=1);assert(proof.admissions.includes('tool_dispatch'),JSON.stringify(proof));await unread();
 assert.equal(await fs.readFile(instruction,'utf8'),'PUBLIC_CONTEXT_SENTINEL_AGENTS');
 child.kill('SIGTERM');const end=await bounded(completion,7000,'Owned full web fixture failed bounded native shutdown: '+safeOutput());assert.equal(end.code,0);assert.equal(end.signal,null);
 t.diagnostic(JSON.stringify({sdk:'0.2.2-rc.2',nativeWeb:true,ownerAuthenticated:true,workspaceReady:true,executionMode:'isolated-guest',modelCatalog:true,firstToolSet:true,publicSentinelReads:0,modelCalls:0,appsEnabled:false,vmEnabled:false,nativeExecutorUnchanged:true,shutdown:'settled'}));
});
