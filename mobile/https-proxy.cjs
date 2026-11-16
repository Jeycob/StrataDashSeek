'use strict';
// Private loopback bridge for Tailscale Serve. No public listener or auth bypass.
const http = require('http');
const net = require('net');
const fs = require('fs');
const {ownerRequestAllowed,ownerResponseHeaders}=require('./owner-origin.cjs');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!/^[a-z0-9.-]+\.ts\.net$/i.test(cfg.publicHost)) throw Error('Expected Tailscale DNS hostname');
const targetPort = cfg.targetPort || 3080;
function headersFor(req) {
  const h = Object.assign({}, req.headers);
  h.host = cfg.publicHost;
  h['x-forwarded-host'] = cfg.publicHost;
  h['x-forwarded-proto'] = 'https';
  return h;
}
function fail(res) { if (!res.headersSent) res.writeHead(502, {'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('Harness is starting. Please retry shortly.'); }
const server = http.createServer(async(req, res) => {
  if(!ownerRequestAllowed(req,'https://'+cfg.publicHost)){res.writeHead(403,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end('{"code":"ORIGIN_REFUSED"}');}
  const requestPath = req.url.split('?')[0];
  if (requestPath === '/phone') {
    res.writeHead(302, {Location:'/phone/','Cache-Control':'no-store'});
    return res.end();
  }
  const routedPort = requestPath.startsWith('/phone/') ? (cfg.pushPort || 3091) : targetPort;
  if(routedPort===targetPort&&(requestPath==='/api'||requestPath.startsWith('/api/'))&&!(req.method==='GET'&&req.url==='/api/workbench/health')){
    try{await require('../vast/runtime-client.cjs').admit('start_turn');}catch{res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':'2'});return res.end('{"code":"RUNTIME_ADMISSION_CLOSED"}');}
    if(req.destroyed||res.destroyed)return;
  }
  const upstream = http.request({hostname:'127.0.0.1',port:routedPort,path:req.url,method:req.method,headers:headersFor(req)}, reply => {
    const h = ownerResponseHeaders(reply.headers);
    res.writeHead(reply.statusCode,h);
    reply.on('error',()=>res.destroy());
    reply.pipe(res);
  });
  upstream.on('error',()=>fail(res));
  req.on('aborted',()=>upstream.destroy());
  res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
  req.pipe(upstream);
});
server.on('upgrade',async(req,socket,head)=>{
  if(!ownerRequestAllowed(req,'https://'+cfg.publicHost,{upgrade:true})){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  let grant;try{grant=await require('../vast/runtime-client.cjs').admit('socket_enqueue');}catch{socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 2\r\n\r\n');return;}
  if(socket.destroyed)return;
  const upstream = net.connect(targetPort,'127.0.0.1',()=>{
    if(grant.enforced&&grant.expiresAt<=Date.now()){socket.destroy();upstream.destroy();return;}
    const h = headersFor(req);
    upstream.write(req.method+' '+req.url+' HTTP/'+req.httpVersion+'\r\n'+Object.keys(h).map(k=>k+': '+h[k]).join('\r\n')+'\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error',()=>socket.destroy());
  socket.on('error',()=>upstream.destroy());
  socket.on('close',()=>upstream.destroy());
  upstream.on('close',()=>socket.destroy());
});
server.keepAliveTimeout=65000;
server.headersTimeout=66000;
server.timeout=0;
server.listen(cfg.port||3081,'127.0.0.1',()=>console.log('Private HTTPS bridge ready on loopback'));
