'use strict';
const http=require('node:http'),net=require('node:net');
function createPreview(manager, publicPort, listenPort){
 const cfg=manager.cfg;
 function allowed(req){try{return new URL('http://'+req.headers.host).hostname===cfg.applicationHost;}catch{return false;}}
 function headers(req){const h={...req.headers,host:cfg.applicationHost+':'+publicPort};for(const k of Object.keys(h))if(k.startsWith('tailscale-'))delete h[k];return h;}
 function fail(res,e){if(res.destroyed)return;res.writeHead(e.status||503,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Retry-After':'5'});res.end(e.message);}
 const server=http.createServer(async(req,res)=>{
  if(!allowed(req))return fail(res,{status:421,message:'Use the separate application address from Harness.'});
  let release,upstream,closed=false;
  const finish=()=>{if(closed)return;closed=true;release?.();upstream?.destroy();};res.once('close',finish);req.once('aborted',finish);
  try{
   release=await manager.beginPreview(publicPort);if(closed){release();return;}
   upstream=http.request({host:'127.0.0.1',port:publicPort,path:req.url,method:req.method,headers:headers(req)},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.on('error',()=>res.destroy());reply.pipe(res);});
   upstream.on('error',e=>{if(!res.headersSent)fail(res,e);else res.destroy();});upstream.setTimeout(600000,()=>upstream.destroy(Error('Application request timed out')));req.pipe(upstream);
  }catch(e){fail(res,e);finish();}
 });
 server.on('upgrade',async(req,socket,head)=>{
  if(!allowed(req)){socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');return;}
  let release,upstream,closed=false;
  const finish=()=>{if(closed)return;closed=true;release?.();upstream?.destroy();socket.destroy();};socket.on('error',finish);socket.on('close',finish);
  try{release=await manager.beginPreview(publicPort);if(closed){release();return;}
   upstream=net.connect(publicPort,'127.0.0.1',()=>{const h=headers(req);upstream.write(req.method+' '+req.url+' HTTP/'+req.httpVersion+'\r\n'+Object.entries(h).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});upstream.on('error',finish);upstream.on('close',finish);
  }catch{socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n');finish();}
 });
 server.requestTimeout=0;server.headersTimeout=65000;server.keepAliveTimeout=5000;
 if(listenPort)server.listen(listenPort,'127.0.0.1');return server;
}
module.exports={createPreview};
