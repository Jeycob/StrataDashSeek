'use strict';
// Explicit SDK gate: actual Native Host and workspace plugin, no model turn.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),http=require('node:http'),net=require('node:net'),{pathToFileURL}=require('node:url');
const {createRuntimeReadiness,probe}=require('./runtime-readiness.cjs');
const {createRequire}=require('node:module');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('actual pinned Native Host authenticates functional workspace health before model readiness',{timeout:60000},async t=>{
 assert(process.env.HARNESS_NATIVE_CLI,'Configure the existing pinned Native CLI for this explicit gate');
 const repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'harness-health-native-')),commit='a'.repeat(40),release=path.join(temp,'releases',commit),log=path.join(temp,'native.log');
 let child,childClosed,model;
 t.after(async()=>{
  if(child&&child.exitCode===null){if(process.platform==='win32')cp.execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else child.kill('SIGKILL');}await childClosed;
  if(model)await new Promise(resolve=>model.close(resolve));
  const real=fs.realpathSync(temp);assert.equal(path.dirname(real),fs.realpathSync(os.tmpdir()));assert(path.basename(real).startsWith('harness-health-native-'));fs.rmSync(real,{recursive:true,force:true});
 });
 const names=cp.execFileSync('git',['ls-files','-z','--','workspace','development','runtime','vast','quality'],{cwd:repo,encoding:'utf8'}).split('\0').filter(Boolean);
 for(const name of names){const target=path.join(release,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(repo,name),target);}
 fs.writeFileSync(log,'',{mode:0o640});
 const sdkRequire=createRequire(path.resolve(process.env.HARNESS_NATIVE_CLI)),worktree=sdkRequire.resolve('@deepseek-ai/dsh-experimental-worktree');
 const overlay=path.join(temp,'patch.json');fs.writeFileSync(overlay,JSON.stringify([{insert:[{id:'cloud-native-worktrees',name:pathToFileURL(worktree).href,config:{retainOnArchive:true}},{id:'functional-workspace-health',name:pathToFileURL(path.join(release,'workspace/plugin.mjs')).href,config:{stateRoot:path.join(temp,'state'),projectsRoot:path.join(temp,'projects'),environmentReport:path.join(temp,'development.json'),appsConfigFile:path.join(temp,'absent-apps.json'),appsWorkspaceRoot:path.join(temp,'projects')}}]}]));
 const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const host='fixture.example.ts.net';
 child=cp.spawn(process.execPath,[path.resolve(process.env.HARNESS_NATIVE_CLI),'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port',String(port),'--public-url','https://'+host+'/','--trusted-host',host],{cwd:temp,env:{...process.env,DSH_HOME:path.join(temp,'home'),HOME:temp,USERPROFILE:temp,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe'],windowsHide:true});
 childClosed=new Promise(resolve=>child.once('close',resolve));
 child.stdout.on('data',bytes=>fs.appendFileSync(log,bytes));child.stderr.on('data',bytes=>fs.appendFileSync(log,bytes));
 child.on('error',()=>{});
 model=http.createServer((req,res)=>{assert.equal(req.method,'GET');assert.equal(req.url,'/health');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({loaded:false}));});await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
 const sampler=createRuntimeReadiness({publicHost:host,harnessPort:port,modelPort:model.address().port,desktopLog:log},{read:name=>name==='startup-update.json'?{version:1,enabled:true,phase:'ready',signatureVerified:true,appliedCommit:commit}:{at:Date.now(),sourceCommit:commit,phase:'ready'}});
 const deadline=Date.now()+40000;let state;
 while(Date.now()<deadline){assert.equal(child.exitCode,null,'Native Host exited before functional health');state=await sampler.sample();if(state.runtimeReady)break;await pause(300);}
 if(!state?.runtimeReady){const safe=fs.readFileSync(log,'utf8').replace(/https?:\/\/\S+/g,'[fixture-url]').slice(-2500);assert.fail('Functional Native health not ready: '+JSON.stringify(state)+'; '+safe);}
 assert.equal(state.sourceCommit,commit);assert.equal(state.sourceReady,true);assert.equal(state.runtimeReady,true);assert.equal(state.modelReady,false);assert.equal(state.phase,'model_loading');assert.equal(state.ready,false);
 const anonymous=await probe(port,'/api/workbench/health',{hostHeader:host});assert.equal(anonymous.status,401);
 assert.doesNotMatch(JSON.stringify(state),/token=|Cookie|cookie|Bearer|local=/);
});
