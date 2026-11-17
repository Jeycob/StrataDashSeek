import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import protocol from '../development/project-custody.cjs';
import {startProject} from '../development/project-run.cjs';
import {custodyLaunch,custodyReader,startupEnvironment} from './project-custody.mjs';
import {createProjectCommandRunner} from './project-tool.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';

const control={version:1,nonce:'a'.repeat(64),generation:'b'.repeat(32)},identity={pid:1234,ppid:12,pgrp:12,startTicks:'987654',pidNamespace:'pid:[12345]'};
const encoded=protocol.frame(control,identity);
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
async function until(check){for(let n=0;n<100;n++){if(check())return;await tick();}assert.fail('fixture wait expired');}
function handle(initial=''){
 let buffer=Buffer.from(initial),finish;const done=new Promise(resolve=>{finish=resolve;});
 const process={status:'running',exitCode:null,signal:null,done,kills:0,hold:false,
  observed:{stdout:{readFrom(offset){return{text:buffer.subarray(offset).toString(),nextOffset:buffer.length,lossy:false};}},stderr:{readFrom(offset){return{text:'',nextOffset:offset,lossy:false};}}},
  append(text){buffer=Buffer.concat([buffer,Buffer.from(text)]);},
  release(){process.status='killed';finish();},kill(){process.kills++;if(!process.hold)process.release();},
 };return process;
}
test('strict canonical bounded frame preserves Linux stat start identity, including a parenthesis in comm',()=>{
 const stat=`1234 (a ) b) S 12 12 ${Array(16).fill('0').join(' ')} 987654 0`;
 const {pidNamespace,...statIdentity}=identity;assert.deepEqual(protocol.identityFromStat(stat,1234),statIdentity);
 assert.deepEqual(protocol.parseFrame(encoded,control),{stage:'wrapper-frame',generation:control.generation,...identity});
 for(const bad of [Buffer.concat([Buffer.from('x'),encoded]),Buffer.from(encoded.toString().replace('"pid":1234','"pid":1234,"pid":1234')),Buffer.from(encoded.toString().replace('"pid":1234','"extra":0,"pid":1234')),Buffer.from(encoded.toString().replace('987654','0')),Buffer.alloc(513,65)])assert.throws(()=>protocol.parseFrame(bad,control));
 assert.throws(()=>protocol.parseFrame(encoded,{...control,nonce:'c'.repeat(64)}));
});
test('split offset0 frame is hidden; all application output and later frame-looking text remain ordinary output',async()=>{
 const p=handle(),reader=custodyReader(p,control,{timeoutMs:200});
 assert.deepEqual(reader.stdout.readFrom(0),{text:'',nextOffset:0,lossy:false});
 for(let from=0;from<encoded.length;from+=19){p.append(encoded.subarray(from,from+19));await tick();}
 const anchor=await reader.ready;assert.equal(anchor.pid,1234);
 const app='český output\n'+encoded.toString();p.append(app);
 assert.deepEqual(reader.stdout.readFrom(0),{text:app,nextOffset:Buffer.byteLength(app),lossy:false});
 assert.equal(reader.stdout.readFrom(Buffer.byteLength('český output\n')).text,encoded.toString());
 p.release();assert.equal(p.kills,0);
});
test('lossy/offset-jumping/leading/partial/malformed output cannot be searched for authority',async()=>{
 const cases=[
  p=>{p.observed.stdout.readFrom=()=>({text:encoded.toString(),nextOffset:encoded.length,lossy:true});},
  p=>{p.observed.stdout.readFrom=()=>({text:encoded.toString(),nextOffset:encoded.length+1,lossy:false});},
  p=>p.append('untrusted prelude\n'+encoded),p=>p.append('x'.repeat(513)),p=>p.append(encoded.toString().replace('"version":1','"version":2')),
 ];
 for(const change of cases){const p=handle();change(p);const reader=custodyReader(p,control,{timeoutMs:20});await assert.rejects(reader.ready);assert.equal(reader.stdout.readFrom(0).text,'');p.release();}
 const p=handle(encoded.subarray(0,20)),reader=custodyReader(p,control,{timeoutMs:10});await assert.rejects(reader.ready,/TIMEOUT/);assert.equal(reader.stdout.readFrom(0).text,'');p.release();
});
test('capture abort and early process exit reject; later bytes never publish a prefix',async()=>{
 for(const abort of [true,false]){const p=handle(),controller=new AbortController(),reader=custodyReader(p,control,{signal:controller.signal,timeoutMs:100});if(abort)controller.abort();else p.release();await assert.rejects(reader.ready,/ABORTED|EXITED/);p.append(encoded);await tick();assert.equal(reader.stdout.readFrom(0).text,'');p.release();}
});
test('raw SDK spill paths cannot expose the private prefix through filtered job output',async()=>{
 const p=handle(encoded),raw=p.observed.stdout.readFrom;p.observed.stdout.readFrom=offset=>({...raw(offset),spillPath:'/raw/protocol-and-app-output'});
 const reader=custodyReader(p,control);await reader.ready;p.append('app');assert.deepEqual(reader.stdout.readFrom(0),{text:'app',nextOffset:3,lossy:false});p.release();
});
test('startup boundary suppresses outer Bash, loader and Node hooks without changing caller data',()=>{
 const parent={BASH_ENV:'/evil',ENV:'/evil','BASH_FUNC_exec%%':'() { evil; }',NODE_OPTIONS:'--require /evil',NODE_COMPILE_CACHE:'/evil',LD_PRELOAD:'/evil',DYLD_INSERT_LIBRARIES:'/evil',SHELLOPTS:'xtrace',OTHER:'retain'},copy={...parent};
 const env=startupEnvironment(parent);
 assert.deepEqual(parent,copy);assert.equal(env.BASH_ENV,'/dev/null');assert.equal(env.ENV,'/dev/null');assert.equal(env.PATH,'/usr/bin:/bin');
 for(const key of ['BASH_FUNC_exec%%','NODE_OPTIONS','NODE_COMPILE_CACHE','LD_PRELOAD','DYLD_INSERT_LIBRARIES','SHELLOPTS'])assert.equal(env[key],'');assert.equal(env.OTHER,undefined);
});
function wrapperFixture({input=JSON.stringify(control),shortWrite=false,platform='linux'}={}){
 const order=[],signals=new Map(),child=new EventEmitter();let offset=0;child.kill=signal=>order.push('kill:'+signal);
 const filesystem={readSync(fd,b,at,size){const value=Buffer.from(input).subarray(offset,offset+size);value.copy(b,at);offset+=value.length;return value.length;},
  readFileSync(file){order.push('read:'+file);return file==='/proc/self/stat'?`1234 (node) S 12 12 ${Array(16).fill('0').join(' ')} 987654`:JSON.stringify({ports:[21000,21001,21002,21003],databasePath:'/own/db'});},
  readlinkSync(file){assert.equal(file,'/proc/self/ns/pid');return identity.pidNamespace;},mkdirSync(){order.push('mkdir');},writeSync(fd,bytes){order.push('frame');assert.deepEqual(protocol.parseFrame(bytes,control).pid,1234);return shortWrite?1:bytes.length;},
 };
 const runtime={platform,pid:1234,env:{DSH_PROJECT_ROOT:'/own'},cwd:()=>'/own',on:(signal,callback)=>signals.set(signal,callback)};
 const spawn=(command,args,options)=>{order.push('spawn');assert.equal(command,'bash');assert.deepEqual(args,['-c','echo "quoted; $(literal)"']);assert.equal(options.detached,undefined);assert.equal(options.stdio,'inherit');return child;};
 return{order,signals,child,filesystem,runtime,spawn};
}
test('fixed wrapper writes complete frame before any mutable project read or child, preserving signals and exit',()=>{
 const f=wrapperFixture();startProject(['--host-custody-v1','--','bash','-c','echo "quoted; $(literal)"'],f);
 assert.deepEqual(f.order.slice(0,3),['read:/proc/self/stat','frame','read:'+path.join('/own','.harness/project.json')]);assert.equal(f.order.at(-1),'spawn');
 f.signals.get('SIGTERM')();assert.equal(f.order.at(-1),'kill:SIGTERM');f.child.emit('exit',7,null);assert.equal(f.runtime.exitCode,7);
});
test('bad input, unsupported platform and short frame write prevent all child/project execution',()=>{
 for(const options of [{input:'{}'},{input:' '.repeat(257)},{input:JSON.stringify(control).replace('"version":1','"version":1,"version":1')},{shortWrite:true},{platform:'win32'}]){
  const f=wrapperFixture(options);assert.throws(()=>startProject(['--host-custody-v1','--','bash','-c','echo "quoted; $(literal)"'],f));assert(!f.order.includes('spawn'));assert(!f.order.some(item=>item.includes('project.json')));
 }
});
test('ordinary wrapper does not read stdin/proc or emit metadata',()=>{
 const f=wrapperFixture({platform:'win32'});startProject(['--','bash','-c','echo "quoted; $(literal)"'],f);assert(!f.order.includes('frame'));assert(!f.order.includes('read:/proc/self/stat'));assert.equal(f.order.at(-1),'spawn');
});
async function fixture(t,{bad=false,hold=false,holdFrame=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'custody-pure-'));t.after(async()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'custody-pure-'));await fs.rm(root,{recursive:true,force:true});});
 const entries=new Map(),calls=[];let running,raw;
 const jobs={start(spec){const id='owned-job',job={spec,owner:spec.owner};entries.set(id,job);running=spec.run({append(){}});job.done=running.done;return id;},kill(id,owner){assert.equal(entries.get(id).owner,owner);running.cancel();}};
 const ctx={jobs,shellEnv:{collect:()=>({})},sandboxPolicy:{resolve:()=>({mode:'read-only'})},shell:{sandboxMode:'workspace-write',resolve:spec=>spec,async execute(spec){calls.push(spec);raw=handle(bad?'fake prelude\n':'');raw.hold=hold;const c=JSON.parse(spec.stdin);if(!bad&&!holdFrame)raw.append(protocol.frame(c,identity));return raw;}}};
 const agent={id:'owner',session:{id:'owner'}},controller=new AbortController(),execution={agent,signal:controller.signal};
 const manager={ownerAgent:a=>a,data:{sessions:{owner:{root,workspaceId:'workspace'}}}},run=createProjectCommandRunner(ctx,manager,{},hostExecutionBinding());
 t.after(()=>run.dispose());
 return{root,run,execution,controller,entries,calls,get raw(){return raw;}};
}
const args={command:'echo "quoted; $(literal)"',description:'owned mock',run_in_background:true};
test('trusted opt-in retains original handle/policy and private exact-owner generation, never model output',async t=>{
 const f=await fixture(t),background=await f.run.startWithCustody(args,f.execution),lease=await f.run.custodyFor(background.jobId,'owner');
 assert.deepEqual(Object.keys(background).sort(),['cwd','jobId','kind']);assert.equal(lease.identity.pid,1234);assert.equal(lease.identity.stage,'wrapper-frame');assert.equal(lease.context.projectRoot,f.root);lease.assertCurrent();
 const spec=f.calls[0];assert.equal(spec.sandboxPolicy.mode,'read-only');assert.equal(spec.dshEnv.DSH_PROJECT_READ_ONLY,'1');assert.equal(spec.onExpiry,'none');assert.equal(spec.timeoutMs,300000);assert.match(spec.command,/--host-custody-v1/);assert.equal(spec.env.BASH_ENV,'/dev/null');
 f.raw.append('app output');assert.deepEqual(f.entries.get(background.jobId).spec.output[0].read(0),{text:'app output',nextOffset:10,lossy:false});
 await assert.rejects(f.run.custodyFor(background.jobId,'FOREIGN'),{code:'PROJECT_CUSTODY_UNAVAILABLE'});f.controller.abort();lease.assertCurrent();assert.equal(f.raw.kills,0);
 f.raw.kill();await lease.done;assert.throws(lease.assertCurrent,{code:'PROJECT_CUSTODY_EXPIRED'});assert.equal(f.raw.kills,1);
});
test('bad custody prefix drains only its own original handle before rejecting acknowledgement',async t=>{
 const f=await fixture(t,{bad:true,hold:true});let rejected=false;
 const pending=f.run.startWithCustody(args,f.execution).catch(error=>{rejected=true;throw error;});void pending.catch(()=>{});
 await until(()=>f.raw?.kills>0);assert.equal(rejected,false);assert.equal(f.entries.get('owned-job').spec.output[0].read(0).text,'');f.raw.release();await assert.rejects(pending,/PROTOCOL_INVALID/);
});
test('caller cannot opt in with tool data and custody rejects foreground and pre-dispatch abort',async t=>{
 const f=await fixture(t);
 for(const extra of [{custody:true},{host:'127.0.0.1'},{pid:1234},{port:3090}])await assert.rejects(f.run.startWithCustody({...args,...extra},f.execution),{code:'INVALID_COMMAND'});
 await assert.rejects(f.run.startWithCustody({...args,run_in_background:false},f.execution),{code:'PROJECT_CUSTODY_BACKGROUND_REQUIRED'});
 f.controller.abort();await assert.rejects(f.run.startWithCustody(args,f.execution));assert.equal(f.calls.length,0);
});
test('abort while awaiting the private frame drains actual own handle before acknowledgement rejects',async t=>{
 const f=await fixture(t,{holdFrame:true,hold:true});let rejected=false;
 const pending=f.run.startWithCustody(args,f.execution).catch(error=>{rejected=true;throw error;});void pending.catch(()=>{});
 await until(()=>f.raw);f.controller.abort();await until(()=>f.raw.kills>0);assert.equal(rejected,false);
 f.raw.release();await assert.rejects(pending,{code:'PROJECT_CUSTODY_ABORTED'});assert.equal(f.calls.length,1);
});
