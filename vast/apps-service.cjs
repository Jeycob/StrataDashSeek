'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {AppsManager}=require('./apps-manager.cjs');
const {diagnosticFor}=require('./apps-managed-resources.cjs');
const {createPreview}=require('./apps-preview.cjs');
const {guardAppsTarget}=require('./apps-context-guard.cjs');
const admission=require('./runtime-client.cjs');
const {bindAppsExecution,bindAppsProcess,assertAppsExecution}=require('./apps-execution-mode.cjs');
function same(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function createAppsService(cfg={},injected,dependencies={}){
 const execution=bindAppsExecution(dependencies.executionMode??injected?.execution??(!injected?bindAppsProcess():undefined));
 const manager=injected||new AppsManager(cfg,undefined,undefined,execution);
 const admissionControl=dependencies.admission||admission;
 const keyFile=cfg.keyFile||'/data/harness/secrets/apps-internal.key';fs.mkdirSync(path.dirname(keyFile),{recursive:true});if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});const key=fs.readFileSync(keyFile,'utf8').trim();
 manager.heartbeat();const clock=setInterval(()=>void (async()=>{if(admissionControl.required)await admissionControl.status();await manager.tick();})().catch(()=>{}),5000);clock.unref();
 const previews=[];if(cfg.preview?.enabled)for(let n=0;n<(cfg.portCount||8);n++)previews.push(createPreview(manager,(cfg.firstPort||18080)+n,(cfg.preview.firstListenPort||18180)+n));
 const server=http.createServer(async(req,res)=>{try{
  if(!same(req.headers['x-harness-apps-key'],key))return json(res,401,{error:'Unauthorized'});
  const u=new URL(req.url,'http://loopback');
  const runtimePost=req.method==='POST'&&u.pathname==='/project-runtime';
  if(!runtimePost)execution.assertUnchanged();
  if(manager.serviceClosing&&!runtimePost)return json(res,503,{error:'Application service is shutting down'});
  if(!runtimePost&&(req.method!=='GET'||u.pathname==='/export-download'))try{await admissionControl.admit('apps_enqueue');execution.assertUnchanged();}catch{return json(res,503,{code:'RUNTIME_ADMISSION_CLOSED',error:'Harness is verifying its runtime. Retry shortly.'});}
  if(req.method==='GET'){await guardAppsTarget(manager,u.pathname,Object.fromEntries(u.searchParams));execution.assertUnchanged();}
  if(req.method==='GET'&&u.pathname==='/state')return json(res,200,await manager.state());
  if(req.method==='GET'&&u.pathname==='/job-status')return json(res,200,require('./apps-job-status.cjs').jobStatus(manager,u.searchParams.get('id')));
  if(req.method==='GET'&&u.pathname==='/project-request')return json(res,200,require('./apps-project-request.cjs').requestStatus(manager,u.searchParams.get('_contextProjectId'),u.searchParams.get('requestId')));
  if(req.method==='GET'&&u.pathname==='/resource-export-download'){
   const e=manager.archivedCleanup.resourceDownload({...Object.fromEntries(u.searchParams),token:req.headers['x-harness-resource-authority']});let release;try{release=manager.beginTransfer();}catch(error){fs.closeSync(e.descriptor);throw error;}res.once('close',release);res.setTimeout(120000,()=>res.destroy());
   res.writeHead(200,{'Content-Type':'application/x-tar','Content-Length':e.bytes,'Content-Disposition':'attachment; filename="'+e.filename+'"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   const input=fs.createReadStream(null,{fd:e.descriptor,autoClose:true});input.on('error',()=>res.destroy());res.on('close',()=>input.destroy());return input.pipe(res);
  }
  if(req.method==='GET'&&u.pathname==='/job-log')return json(res,200,manager.jobOutput?manager.jobOutput(u.searchParams.get('id')):{text:manager.jobLog(u.searchParams.get('id'))});
  if(req.method==='GET'&&u.pathname==='/container-log')return json(res,200,{text:await manager.logs(u.searchParams.get('id'))});
  if(req.method==='GET'&&u.pathname==='/releases')return json(res,200,{releases:await manager.releaseList(u.searchParams.get('id'))});
  if(req.method==='GET'&&u.pathname==='/release')return json(res,200,{release:await manager.releaseDetail(u.searchParams.get('id'),u.searchParams.get('releaseId'))});
  if(req.method==='GET'&&u.pathname==='/export-download'){const e=manager.exportFile(u.searchParams.get('id')),s=fs.statSync(e.file),release=manager.beginTransfer();res.once('close',release);res.setTimeout(120000,()=>res.destroy());res.writeHead(200,{'Content-Type':'application/gzip','Content-Length':s.size,'Content-Disposition':'attachment; filename="'+e.filename+'"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});const input=fs.createReadStream(e.file);input.on('error',()=>res.destroy());res.on('close',()=>input.destroy());return input.pipe(res);}
  if(req.method!=='POST')return json(res,404,{error:'Not found'});
  let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>(u.pathname==='/project-runtime'?512*1024:16384))throw Object.assign(Error('Request too large'),{status:413});}let data;try{data=JSON.parse(raw)}catch{throw Object.assign(Error('Invalid JSON'),{status:400});}
  if(!data||typeof data!=='object'||Array.isArray(data))throw Object.assign(Error('Expected an operation object'),{status:400});
  // Closing new-work admission must still permit exact owned cleanup. This
  // exception is authenticated above, parsed and shape-checked here, then
  // capability-checked by ProjectRuntime.stop; it never wakes or creates work.
  const runtimeStop=runtimePost&&data.op==='stop'&&Object.keys(data).length===4&&Object.keys(data).every(key=>['op','sessionId','generation','stopToken'].includes(key))&&/^[A-Za-z0-9_-]{1,128}$/.test(data.sessionId||'')&&/^[a-f0-9]{32}$/.test(data.generation||'')&&/^[A-Za-z0-9_-]{43}$/.test(data.stopToken||'');
  if(runtimePost&&!runtimeStop){
   assertAppsExecution({execution},{isolated:true});
   if(manager.serviceClosing)return json(res,503,{error:'Application service is shutting down'});
   try{await admissionControl.admit('apps_enqueue');execution.assertUnchanged();}catch{return json(res,503,{code:'RUNTIME_ADMISSION_CLOSED',error:'Harness is verifying its runtime. Retry shortly.'});}
  }
  await guardAppsTarget(manager,u.pathname,data);
  if(!runtimeStop)execution.assertUnchanged();
  if(u.pathname==='/project-runtime'){
   const controller=new AbortController(),abort=()=>{if(!res.writableFinished)controller.abort();};req.once('aborted',abort);res.once('close',abort);
   try{if(req.aborted||res.destroyed)controller.abort();return json(res,200,await manager.projectRuntime(data,{signal:controller.signal}));}finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
  }
  if(u.pathname==='/archived-cleanup')return json(res,200,await manager.archivedCleanup.handle(data));
  if(u.pathname==='/resources')return json(res,200,await manager.archivedCleanup.resources(data));
  if(u.pathname==='/register')return json(res,200,await manager.register(data.path,data._contextProjectId));
  if(u.pathname==='/scaffold')return json(res,200,await manager.scaffold(data.path,data.dryRun===true,data._contextProjectId));
  if(u.pathname==='/vault-config')return json(res,200,await manager.configureVault(data));
  if(u.pathname==='/project-settings')return json(res,200,manager.projectSettings(data.id,data));
  if(u.pathname==='/target-settings')return json(res,200,await manager.targetSettings(data));
  if(u.pathname==='/worker-action')return json(res,202,manager.enqueuePower(data.action));
  if(u.pathname==='/worker-probe'){if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length)throw Error('The fixed worker probe accepts no arguments');return json(res,202,manager.enqueueWorkerProbe());}
  if(u.pathname==='/hold')return json(res,200,manager.hold(data.minutes));
  if(u.pathname==='/preview-settings')return json(res,202,manager.enqueuePreviewSettings(data.enabled));
  if(u.pathname==='/prepare-sleep')return json(res,200,await manager.prepareSleep());
  if(u.pathname==='/confirm-sleep')return json(res,200,manager.confirmSleep(data.token));
  if(u.pathname==='/cancel-sleep')return json(res,200,manager.cancelSleep(data.token));
  if(u.pathname==='/project-action')return json(res,202,require('./apps-project-request.cjs').enqueueProjectAction(manager,data));
  if(u.pathname==='/container-action')return json(res,200,await manager.containerAction(data.id,data.action));
  return json(res,404,{error:'Not found'});
 }catch(e){const resourceDiagnostic=diagnosticFor(e);if(!res.headersSent)json(res,e.status||400,{error:e.message,...(/^(?:CLEANUP|RESOURCE|PROJECT_RUNTIME|PROJECT_EXECUTION)_[A-Z_]+$/.test(e.code||'')?{code:e.code}:{}),...(/^[a-f0-9]{32}$/.test(e.operationId||'')?{operationId:e.operationId}:{}),...(/^[a-f0-9]{16}$/.test(e.jobId||'')?{jobId:e.jobId}:{}),...(resourceDiagnostic?{code:e.code,resourceDiagnostic}:{})});else res.destroy();}});
 server.on('close',()=>{clearInterval(clock);for(const p of previews)p.close();});return{server,manager,previews};
}
module.exports={createAppsService};
if(require.main===module){
 const file=process.argv[2]||'/data/harness/apps-config.json',cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
 require('./apps-service-owner.cjs').ownAppsService(cfg,createAppsService).then(({server,manager})=>{
  server.on('error',error=>{console.error('Application service failed: '+(error.code||'LISTEN_FAILED'));process.exit(1);});
  server.listen(cfg.port||3093,'127.0.0.1',()=>console.log('Private application worker API ready'));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
   // Retain the kernel lease until process exit, including the shutdown grace.
   // A background deployment must not overlap a replacement controller.
   manager.serviceClosing=true;manager.worker?.serial?.destroy();manager.worker?.child?.unref();server.close(()=>process.exit());setTimeout(()=>process.exit(),3000).unref();
  });
 }).catch(error=>{console.error('Application service not started: '+(error.code||'INITIALIZATION_FAILED'));process.exitCode=1;});
}
