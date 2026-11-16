'use strict';
const http=require('node:http');
const routes=new Map([['/resources',['GET','/api/workbench/docker-resources']],['/resource-action',['POST','/api/workbench/docker-resources']],['/resource-export-download',['GET','/api/workbench/docker-resources/download']]]);
function nativeResourceRoute(route,method){const value=routes.get(route);return value?.[0]===method?value[1]:null;}
function proxyNativeResource({route,method,query,cookie,payload,res,port,publicHost,maxDownloadBytes=1024**3,deadlineMs=120000}){
 const target=nativeResourceRoute(route,method);if(!target)throw Error('RESOURCE_ROUTE_REFUSED');
 if(typeof cookie!=='string'||!cookie||cookie.length>16384)throw Error('RESOURCE_OWNER_REQUIRED');
 const parameters=new URLSearchParams();for(const k of ['scope','sessionId','kind','cursor','limit','q','operationId'])if(query.has(k))parameters.set(k,query.get(k));
 const data=method==='POST'?JSON.stringify(payload):null;if(data&&Buffer.byteLength(data)>16384)throw Error('RESOURCE_BODY_TOO_LARGE');
 return new Promise(resolve=>{
  let settled=false,upstream,timer,total=0;
  const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);res.removeListener('close',abort);upstream?.destroy();resolve();};
  const fail=code=>{if(res.headersSent)res.destroy();else{res.writeHead(502,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({code}));}finish();};
  const abort=()=>finish();res.once('close',abort);
  upstream=http.request({hostname:'127.0.0.1',port,path:target+(parameters.size?'?'+parameters:''),method,headers:{Host:publicHost,Cookie:cookie,Origin:'https://'+publicHost,...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})}},reply=>{
   const length=Number(reply.headers['content-length']),limit=route==='/resource-export-download'?maxDownloadBytes:4*1024**2;
   if(Number.isFinite(length)&&length>limit){reply.destroy();return fail('RESOURCE_RESPONSE_TOO_LARGE');}
   const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
   for(const key of ['content-type','content-length','content-disposition','retry-after'])if(reply.headers[key])headers[key]=reply.headers[key];
   if(reply.statusCode>=300&&reply.statusCode<400){reply.destroy();return fail('RESOURCE_REDIRECT_REFUSED');}
   res.writeHead(reply.statusCode,headers);reply.on('data',chunk=>{total+=chunk.length;if(total>limit){reply.destroy();fail('RESOURCE_RESPONSE_TOO_LARGE');}});reply.on('error',()=>fail('RESOURCE_UPSTREAM_FAILED'));reply.on('end',finish);reply.pipe(res);
  });upstream.on('error',()=>fail('RESOURCE_UPSTREAM_UNAVAILABLE'));timer=setTimeout(()=>fail('RESOURCE_DEADLINE'),deadlineMs);timer.unref?.();upstream.end(data);
 });
}
module.exports={nativeResourceRoute,proxyNativeResource};
