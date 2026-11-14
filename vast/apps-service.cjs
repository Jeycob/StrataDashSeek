'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {AppsManager}=require('./apps-manager.cjs');
const {createPreview}=require('./apps-preview.cjs');
function same(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function createAppsService(cfg={},injected){
 const manager=injected||new AppsManager(cfg);
 const keyFile=cfg.keyFile||'/data/harness/secrets/apps-internal.key';fs.mkdirSync(path.dirname(keyFile),{recursive:true});if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});const key=fs.readFileSync(keyFile,'utf8').trim();
 manager.heartbeat();const clock=setInterval(()=>void manager.tick().catch(e=>console.error('Worker maintenance: '+e.message)),5000);clock.unref();
 const previews=[];if(cfg.preview?.enabled)for(let n=0;n<(cfg.portCount||8);n++)previews.push(createPreview(manager,(cfg.firstPort||18080)+n,(cfg.preview.firstListenPort||18180)+n));
 const server=http.createServer(async(req,res)=>{try{
  if(!same(req.headers['x-harness-apps-key'],key))return json(res,401,{error:'Unauthorized'});
  const u=new URL(req.url,'http://loopback');
  if(req.method==='GET'&&u.pathname==='/state')return json(res,200,await manager.state());
  if(req.method==='GET'&&u.pathname==='/job-log')return json(res,200,{text:manager.jobLog(u.searchParams.get('id'))});
  if(req.method==='GET'&&u.pathname==='/container-log')return json(res,200,{text:await manager.logs(u.searchParams.get('id'))});
  if(req.method==='GET'&&u.pathname==='/releases')return json(res,200,{releases:await manager.releaseList(u.searchParams.get('id'))});
  if(req.method==='GET'&&u.pathname==='/release')return json(res,200,{release:await manager.releaseDetail(u.searchParams.get('id'),u.searchParams.get('releaseId'))});
  if(req.method==='GET'&&u.pathname==='/export-download'){const e=manager.exportFile(u.searchParams.get('id')),s=fs.statSync(e.file),release=manager.beginTransfer();res.once('close',release);res.setTimeout(120000,()=>res.destroy());res.writeHead(200,{'Content-Type':'application/gzip','Content-Length':s.size,'Content-Disposition':'attachment; filename="'+e.filename+'"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});const input=fs.createReadStream(e.file);input.on('error',()=>res.destroy());res.on('close',()=>input.destroy());return input.pipe(res);}
  if(req.method!=='POST')return json(res,404,{error:'Not found'});
  let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>16384)throw Object.assign(Error('Request too large'),{status:413});}let data;try{data=JSON.parse(raw)}catch{throw Object.assign(Error('Invalid JSON'),{status:400});}
  if(u.pathname==='/register')return json(res,200,await manager.register(data.path));
  if(u.pathname==='/scaffold')return json(res,200,await manager.scaffold(data.path,data.dryRun===true));
  if(u.pathname==='/vault-config')return json(res,200,await manager.configureVault(data));
  if(u.pathname==='/project-settings')return json(res,200,manager.projectSettings(data.id,data));
  if(u.pathname==='/target-settings')return json(res,200,await manager.targetSettings(data));
  if(u.pathname==='/worker-action')return json(res,202,manager.enqueuePower(data.action));
  if(u.pathname==='/hold')return json(res,200,manager.hold(data.minutes));
  if(u.pathname==='/preview-settings')return json(res,202,manager.enqueuePreviewSettings(data.enabled));
  if(u.pathname==='/prepare-sleep')return json(res,200,await manager.prepareSleep());
  if(u.pathname==='/confirm-sleep')return json(res,200,manager.confirmSleep(data.token));
  if(u.pathname==='/cancel-sleep')return json(res,200,manager.cancelSleep(data.token));
  if(u.pathname==='/project-action')return json(res,202,manager.enqueue(data.id,data.action,{releaseId:data.releaseId,targetId:data.targetId}));
  if(u.pathname==='/container-action')return json(res,200,await manager.containerAction(data.id,data.action));
  return json(res,404,{error:'Not found'});
 }catch(e){if(!res.headersSent)json(res,e.status||400,{error:e.message});else res.destroy();}});
 server.on('close',()=>{clearInterval(clock);for(const p of previews)p.close();});return{server,manager,previews};
}
module.exports={createAppsService};
if(require.main===module){const file=process.argv[2]||'/data/harness/apps-config.json';const cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};const {server,manager}=createAppsService(cfg);server.listen(cfg.port||3093,'127.0.0.1',()=>console.log('Private application worker API ready'));for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{manager.worker?.serial?.destroy();manager.worker?.child?.unref();server.close(()=>process.exit());setTimeout(()=>process.exit(),3000).unref();});}
