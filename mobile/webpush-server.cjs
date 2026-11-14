'use strict';
// Standard Service Worker Web Push, compatible with iOS Home Screen apps >=16.4.
// The only public routes are /phone/*. Internal controls remain loopback-only.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {callApps,streamExport}=require('../vast/apps-cli.cjs');
const ROOT=path.resolve(__dirname,'../..');
const webpushPath=process.env.HARNESS_WEB_PUSH_MODULE||[path.join(__dirname,'../runtime/node_modules/web-push'),path.join(__dirname,'../../runtime/node_modules/web-push')].find(p=>fs.existsSync(p));
if(!webpushPath)throw Error('Install the pinned runtime dependencies first.');
const webpush=require(webpushPath);
function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function createPushServer(cfg,adapter=webpush){
 const origin='https://'+cfg.publicHost;
 if(!/^[a-z0-9.-]+\.ts\.net$/i.test(cfg.publicHost))throw Error('Invalid private HTTPS host');
 const secretDir=cfg.secretDir||path.join(ROOT,'work/.secrets');
 const files={keys:path.join(secretDir,'webpush-vapid.json'),subs:path.join(secretDir,'webpush-subscriptions.json'),pair:path.join(secretDir,'webpush-pair-code.json'),internal:path.join(secretDir,'webpush-internal.key')};
 fs.mkdirSync(secretDir,{recursive:true});
 let keys=readJson(files.keys,null);if(!keys){keys=adapter.generateVAPIDKeys();atomicJson(files.keys,keys);}
 adapter.setVapidDetails(origin+'/phone/',keys.publicKey,keys.privateKey);
 if(!fs.existsSync(files.internal))fs.writeFileSync(files.internal,crypto.randomBytes(32).toString('hex'),{mode:0o600});
 const internalKey=fs.readFileSync(files.internal,'utf8').trim();
 const store=readJson(files.subs,{version:1,installations:{}});
 let pair=readJson(files.pair,null),pairBusy=false,failures=0,failWindow=Date.now();
 let watcherAt=0;const stats={accepted:0,failed:0,lastStatus:null,lastAcceptedAt:null};
 const recent=new Map();
 function newPair(){pair={code:String(crypto.randomInt(10000000,100000000)),expiresAt:Date.now()+10*60000,used:false};atomicJson(files.pair,pair);return pair;}
 if(!pair||pair.used||pair.expiresAt<Date.now())newPair();
 function same(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
 function json(res,status,data,headers={}){res.writeHead(status,Object.assign({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},headers));res.end(JSON.stringify(data));}
 async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>65536){const e=Error('Too large');e.status=413;throw e;}}try{return JSON.parse(text||'{}')}catch{const e=Error('Invalid JSON');e.status=400;throw e;}}
 function harnessRequest(requestPath,cookie){
  return new Promise((resolve,reject)=>{
   const headers={Host:cfg.publicHost};if(cookie)headers.Cookie=cookie;
   const request=http.request({hostname:'127.0.0.1',port:cfg.harnessPort||3090,path:requestPath,method:'GET',headers},response=>{
    response.on('error',()=>{});response.resume();resolve({status:response.statusCode,headers:response.headers});
   });
   request.setTimeout(8000,()=>request.destroy(Error('Harness timeout')));request.on('error',reject);request.end();
  });
 }
 async function authorized(req){
  if(!req.headers.cookie)return false;
  try{const r=await harnessRequest('/',req.headers.cookie);return r.status===200;}catch{return false;}
 }
 function validSubscription(s){
  if(!s||typeof s.endpoint!=='string'||s.endpoint.length>8192||!s.keys||typeof s.keys.p256dh!=='string'||typeof s.keys.auth!=='string')return false;
  try{const u=new URL(s.endpoint);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['web.push.apple.com','webpush.push.apple.com','fcm.googleapis.com','updates.push.services.mozilla.com'].includes(u.hostname)&&/^[a-zA-Z0-9_\-=]+$/.test(s.keys.auth)&&s.keys.auth.length>=16&&/^[a-zA-Z0-9_\-=]+$/.test(s.keys.p256dh)&&s.keys.p256dh.length>=40;}catch{return false;}
 }
 const messages={done:{title:'Harness: hotovo',body:'Úloha je dokončená. Otevři Harness pro výsledek.'},attention:{title:'Harness: potřebuje vstup',body:'Úloha čeká na tvůj vstup nebo schválení.'},error:{title:'Harness: úloha se zastavila',body:'Otevři Harness a zkontroluj úlohu.'},test:{title:'Harness: test oznámení',body:'Push oznámení na tomto iPhonu fungují.'}};
 async function sendOne(id,category){
  const entry=store.installations[id];if(!entry||!messages[category])return;
  const payload=JSON.stringify(Object.assign({},messages[category],{url:cfg.notificationUrl||'/phone/',tag:'harness-'+category}));
  for(let attempt=0;attempt<2;attempt++){
   try{const r=await adapter.sendNotification(entry.subscription,payload,{TTL:300,urgency:'normal',timeout:10000});stats.accepted++;stats.lastStatus=r.statusCode||201;stats.lastAcceptedAt=new Date().toISOString();return;}
   catch(e){const status=Number(e.statusCode)||0;stats.lastStatus=status;if(status===404||status===410){delete store.installations[id];atomicJson(files.subs,store);stats.failed++;return;}if(attempt===0&&(!status||status===429||status>=500)){await new Promise(r=>setTimeout(r,5000));continue;}stats.failed++;return;}
  }
 }
 async function publish(category,id){
  if(!messages[category]||category==='test')return;
  if(recent.has(id))return;recent.set(id,Date.now());if(recent.size>512)recent.delete(recent.keys().next().value);
  await Promise.all(Object.keys(store.installations).filter(k=>!store.installations[k].retiredAt).map(k=>sendOne(k,category)));
 }
 const server=http.createServer(async(req,res)=>{
  try{
   const u=new URL(req.url,'http://loopback');
   if(u.pathname.startsWith('/internal/')){
    if(req.method!=='POST'||!same(req.headers['x-harness-notify-key'],internalKey))return json(res,403,{error:'Forbidden'});
    if(u.pathname==='/internal/state')return json(res,200,{registrations:Object.values(store.installations).filter(v=>!v.retiredAt).length,retiredRegistrations:Object.values(store.installations).filter(v=>v.retiredAt).length,watcherOnline:Date.now()-watcherAt<30000,...stats});
    if(u.pathname==='/internal/paircode'){const p=newPair();return json(res,200,{code:p.code,expiresAt:p.expiresAt});}
    if(u.pathname==='/internal/heartbeat'){watcherAt=Date.now();return json(res,200,{ok:true});}
    if(u.pathname==='/internal/event'){const data=await body(req);if(!['done','error','attention'].includes(data.category)||typeof data.id!=='string'||data.id.length>180)return json(res,400,{error:'Invalid event'});void publish(data.category,data.id);return json(res,202,{queued:true});}
    return json(res,404,{error:'Not found'});
   }
   if(!u.pathname.startsWith('/phone/'))return json(res,404,{error:'Not found'});
   if(u.pathname==='/phone/health'){try{const host=await harnessRequest('/');const ready=host.status===200||host.status===401;return json(res,ready?200:503,{ready,service:'harness-webpush'});}catch{return json(res,503,{ready:false,service:'harness-webpush'});}}
   if(u.pathname==='/phone/config.json'&&req.method==='GET')return json(res,200,{wakeUrl:cfg.wakeUrl});
   if(u.pathname==='/phone/entry'&&req.method==='GET'){
    const token=u.searchParams.get('token');if(!token||token.length>256)return json(res,401,{error:'Invalid entry'});
    const response=await harnessRequest('/?token='+encodeURIComponent(token));const cookies=response.headers['set-cookie']||[];
    if(response.status!==303||!cookies.length)return json(res,401,{error:'Invalid entry'});
    res.writeHead(303,{'Location':'/phone/','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':cookies.map(x=>/;\s*Secure(?:;|$)/i.test(x)?x:x+'; Secure')});return res.end();
   }
   if(req.method==='GET'){
    if(u.pathname==='/phone/apps.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return fs.createReadStream(path.join(__dirname,'apps.js')).pipe(res);}
    if(u.pathname==='/phone/manifest.webmanifest')return json(res,200,{id:'/phone/',name:'Strata Harness',short_name:'Harness',start_url:'/phone/',scope:'/phone/',display:'standalone',background_color:'#f6f7fb',theme_color:'#17243b',icons:[{src:'/phone/icon.png',sizes:'256x256',type:'image/png'}]});
    const staticFiles={'/phone/ui-copy.js':['../shared/ui-copy.cjs','text/javascript; charset=utf-8'],'/phone/localize.js':['localize.js','text/javascript; charset=utf-8'],'/phone/i18n.js':['../shared/i18n.cjs','text/javascript; charset=utf-8'],'/phone/workbench.js':['../workspace/client.js','text/javascript; charset=utf-8'],'/phone/':['phone.html','text/html; charset=utf-8'],'/phone/index.html':['phone.html','text/html; charset=utf-8'],'/phone/monitor.js':['monitor.js','text/javascript; charset=utf-8'],'/phone/boot.js':['phone-boot.js','text/javascript; charset=utf-8'],'/phone/app.js':['phone.js','text/javascript; charset=utf-8'],'/phone/sw.js':['phone-sw.js','text/javascript; charset=utf-8'],'/phone/icon.png':['phone-icon.png','image/png']};
    if(staticFiles[u.pathname]){const [file,type]=staticFiles[u.pathname];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...(file==='phone-sw.js'?{'Service-Worker-Allowed':'/phone/'}:{})});return fs.createReadStream(path.join(__dirname,file)).pipe(res);}
   }
   if(req.method==='POST'&&req.headers.origin!==origin)return json(res,403,{error:'Origin refused'});
   if(u.pathname==='/phone/api/tailscale-login'&&req.method==='POST'){
    // This listener is loopback-only, reached through the private Serve bridge.
    // Serve strips supplied identity headers and inserts the authenticated user's login.
    const login=req.headers['tailscale-user-login'];
    if(!Array.isArray(cfg.tailscaleAutoLoginUsers)||typeof login!=='string'||!cfg.tailscaleAutoLoginUsers.includes(login))return json(res,403,{error:'Tailscale identity not allowed'});
    const log=fs.readFileSync(cfg.desktopLog,'utf8');const match=[...log.matchAll(/https:\/\/[^\s]+\?token=[^\s]+/g)].at(-1);
    if(!match)throw Error('Entry unavailable');const entry=new URL(match[0]);if(entry.host!==cfg.publicHost)throw Error('Authority mismatch');
    const response=await harnessRequest('/?token='+encodeURIComponent(entry.searchParams.get('token')));const cookies=response.headers['set-cookie']||[];
    if(response.status!==303||!cookies.length)throw Error('Entry rejected');
    return json(res,200,{ok:true},{'Set-Cookie':cookies.map(x=>/;\s*Secure(?:;|$)/i.test(x)?x:x+'; Secure')});
   }
   if(u.pathname==='/phone/api/pair'&&req.method==='POST'){
    const data=await body(req);if(Date.now()-failWindow>60000){failures=0;failWindow=Date.now();}
    if(failures>=5)return json(res,429,{error:'Příliš mnoho pokusů. Počkej minutu.'});
    if(pairBusy||!pair||pair.used||pair.expiresAt<Date.now()||!same(String(data.code||'').trim(),pair.code)){failures++;return json(res,401,{error:'Kód není platný nebo vypršel.'});}
    pairBusy=true;
    try{
     const log=fs.readFileSync(cfg.desktopLog||path.join(ROOT,'work/.secrets/desktop-web.stdout.log'),'utf8');const match=[...log.matchAll(/https:\/\/[^\s]+\?token=[^\s]+/g)].at(-1);if(!match)throw Error('Desktop entry unavailable');const entry=new URL(match[0]);if(entry.host!==cfg.publicHost)throw Error('Desktop authority mismatch');
     const response=await harnessRequest('/?token='+encodeURIComponent(entry.searchParams.get('token')));
     const cookies=response.headers['set-cookie']||[];if(response.status!==303||!cookies.length)throw Error('Desktop rejected entry');
     pair.used=true;atomicJson(files.pair,pair);failures=0;
     return json(res,200,{ok:true},{'Set-Cookie':cookies.map(x=>/;\s*Secure(?:;|$)/i.test(x)?x:x+'; Secure')});
    }finally{pairBusy=false;}
   }
   if(!await authorized(req))return json(res,401,{error:'Tento prohlížeč ještě není propojený s Harness serverem.'});
   if(u.pathname.startsWith('/phone/api/apps/')){
    const route=u.pathname.slice('/phone/api/apps'.length),getRoutes=['/state','/job-log','/container-log','/releases','/release'],postRoutes=['/register','/scaffold','/vault-config','/project-settings','/target-settings','/project-action','/container-action','/worker-action','/hold','/preview-settings'];
    if(req.method==='GET'&&route==='/export-download')return streamExport(u.searchParams.get('id'),res,{keyFile:cfg.appsKeyFile||'/data/harness/secrets/apps-internal.key',port:cfg.appsPort||3093});
    if(!(req.method==='GET'&&getRoutes.includes(route)||req.method==='POST'&&postRoutes.includes(route)))return json(res,404,{error:'Not found'});
    const payload=req.method==='POST'?await body(req):undefined;
    return json(res,req.method==='POST'&&['/project-action','/worker-action','/preview-settings'].includes(route)?202:200,await callApps(route+(req.method==='GET'?u.search:''),payload,{keyFile:cfg.appsKeyFile||'/data/harness/secrets/apps-internal.key',port:cfg.appsPort||3093}));
   }
   if(u.pathname==='/phone/api/monitor'&&req.method==='GET')return json(res,200,readJson(cfg.telemetryFile||'/data/harness/state/telemetry.json',{ready:false}));
   if(u.pathname==='/phone/api/wake-config'&&req.method==='GET')return json(res,200,{wakeUrl:cfg.wakeUrl,key:cfg.wakeKeyFile?fs.readFileSync(cfg.wakeKeyFile,'utf8').trim():null});
   if(u.pathname==='/phone/api/state'&&req.method==='GET')return json(res,200,{authorized:true,registered:!!store.installations[u.searchParams.get('installationId')]&&!store.installations[u.searchParams.get('installationId')].retiredAt,vapidPublicKey:keys.publicKey,watcherOnline:Date.now()-watcherAt<30000,...stats});
   const data=await body(req);const id=String(data.installationId||'');if(!/^[a-zA-Z0-9_-]{16,80}$/.test(id))return json(res,400,{error:'Invalid installation'});
   if(u.pathname==='/phone/api/subscribe'&&req.method==='POST'){
    if(!validSubscription(data.subscription))return json(res,400,{error:'Invalid push endpoint'});
    if(!store.installations[id]&&Object.keys(store.installations).length>=4)return json(res,429,{error:'Installation limit reached'});
    store.installations[id]={subscription:data.subscription,createdAt:Date.now()};atomicJson(files.subs,store);return json(res,200,{ok:true});
   }
   if(u.pathname==='/phone/api/disable'&&req.method==='POST'){delete store.installations[id];atomicJson(files.subs,store);return json(res,200,{ok:true});}
   if(u.pathname==='/phone/api/test'&&req.method==='POST'){
    const entry=store.installations[id];if(!entry)return json(res,409,{error:'Nejprve zapni oznámení.'});if(Date.now()-(entry.lastTestAt||0)<60000)return json(res,429,{error:'Test lze poslat jednou za minutu.'});entry.lastTestAt=Date.now();atomicJson(files.subs,store);setTimeout(()=>void sendOne(id,'test'),5000);return json(res,202,{ok:true,message:'Test se odešle za 5 sekund. Zamkni telefon.'});
   }
   return json(res,404,{error:'Not found'});
  }catch(e){if(!res.headersSent)json(res,e.status||503,{error:'Služba není připravená. Zkus to znovu.'});else res.destroy();}
 });
 return {server,files,stats,publish,validSubscription};
}
module.exports={createPushServer};
if(require.main===module){const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const {server}=createPushServer(cfg);server.listen(cfg.port||3091,'127.0.0.1',()=>console.log('Private PWA push service ready on loopback'));}
