'use strict';
const fs=require('node:fs'),http=require('node:http');
async function callApps(route,data,cfg={}){const key=fs.readFileSync(cfg.keyFile||'/data/harness/secrets/apps-internal.key','utf8').trim();return new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:cfg.port||3093,path:route,method:data?'POST':'GET',headers:{'X-Harness-Apps-Key':key,...(data?{'Content-Type':'application/json'}:{})}},res=>{let body='';res.on('data',c=>{body+=c;if(body.length>2*1024*1024)r.destroy(Error('Response too large'));});res.on('error',reject);res.on('end',()=>{try{const d=JSON.parse(body);if(res.statusCode>=400)throw Object.assign(Error(d.error||'Application API error'),{status:res.statusCode});resolve(d);}catch(e){reject(e);}});});r.setTimeout(20000,()=>r.destroy(Error('Application API timeout')));r.on('error',reject);r.end(data?JSON.stringify(data):undefined);});}
function streamExport(id,res,cfg={}){if(!/^[a-f0-9]{16}$/.test(id))throw Error('Invalid export');const key=fs.readFileSync(cfg.keyFile||'/data/harness/secrets/apps-internal.key','utf8').trim();const req=http.get({hostname:'127.0.0.1',port:cfg.port||3093,path:'/export-download?id='+id,headers:{'X-Harness-Apps-Key':key}},up=>{if(up.statusCode!==200){up.resume();res.writeHead(404,{'Content-Type':'text/plain'});return res.end('Export unavailable');}res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':up.headers['content-disposition'],'Content-Length':up.headers['content-length'],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});up.pipe(res);up.on('error',()=>res.destroy());});req.setTimeout(120000,()=>req.destroy());req.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});res.on('close',()=>req.destroy());}
module.exports={callApps,streamExport};
if(require.main===module){const [action,id,option]=process.argv.slice(2);let route,data;
 if(action==='state')route='/state';
 else if(action==='register'){route='/register';data={path:id};}
 else if(['scaffold','scaffold-plan'].includes(action)){route='/scaffold';data={path:id,dryRun:action==='scaffold-plan'};}
 else if(['build','deploy','check','verify','compose','export','rollback','remote-verify','remote-preflight'].includes(action)){route='/project-action';data={id,action,...(action==='rollback'||action==='export'?{releaseId:option}:{}),...(action.startsWith('remote-')?{targetId:option}:{})};}
 else if(action==='releases')route='/releases?id='+encodeURIComponent(id);
 else if(action==='release')route='/release?id='+encodeURIComponent(id)+'&releaseId='+encodeURIComponent(option);
 else if(['wake','sleep'].includes(action)){route='/worker-action';data={action};}
 else if(action==='hold'){route='/hold';data={minutes:Number(id)};}
 else if(['start','stop'].includes(action)){route='/container-action';data={id,action};}
 else if(action==='job-log')route='/job-log?id='+encodeURIComponent(id);
 else if(action==='logs')route='/container-log?id='+encodeURIComponent(id);
 else{console.error('Usage: apps-cli.cjs state | scaffold-plan|scaffold|register PATH | verify|build|deploy|check|compose|export PROJECT_ID | rollback PROJECT_ID RELEASE_ID | releases PROJECT_ID | release PROJECT_ID RELEASE_ID | remote-preflight|remote-verify PROJECT_ID TARGET_ID | wake|sleep | hold MINUTES | start|stop|logs CONTAINER_ID | job-log JOB_ID');process.exitCode=2;}
 if(route)callApps(route,data).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});}
