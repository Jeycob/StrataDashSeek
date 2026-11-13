'use strict';
// Private loopback bridge for Tailscale Serve. No public listener or auth bypass.
const http = require('http');
const net = require('net');
const fs = require('fs');
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
const server = http.createServer((req, res) => {
  const requestPath = req.url.split('?')[0];
  if (requestPath === '/phone') {
    res.writeHead(302, {Location:'/phone/','Cache-Control':'no-store'});
    return res.end();
  }
  const routedPort = requestPath.startsWith('/phone/') ? (cfg.pushPort || 3091) : targetPort;
  const upstream = http.request({hostname:'127.0.0.1',port:routedPort,path:req.url,method:req.method,headers:headersFor(req)}, reply => {
    const h = Object.assign({},reply.headers);
    if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map(c => /;\s*secure(?:;|$)/i.test(c) ? c : c+'; Secure');
    h['referrer-policy']='no-referrer';
    res.writeHead(reply.statusCode,h);
    reply.on('error',()=>res.destroy());
    reply.pipe(res);
  });
  upstream.on('error',()=>fail(res));
  req.on('aborted',()=>upstream.destroy());
  res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
  req.pipe(upstream);
});
server.on('upgrade',(req,socket,head)=>{
  const upstream = net.connect(targetPort,'127.0.0.1',()=>{
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
