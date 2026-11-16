'use strict';
// Trusted boundary between a browser origin and one isolated code-server.
// Native owner credentials are never authentication for this listener and are
// never forwarded to the editor. Deployment must provide a unique, persistent
// origin per session and a privately owned UNIX socket from the OS launcher.
const http=require('node:http'),crypto=require('node:crypto');
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
const token=()=>crypto.randomBytes(32).toString('base64url');
const validToken=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const deniedPath=p=>/^\/(?:proxy|absproxy)(?:\/|$)/i.test(p)||p.startsWith('/__editor/');
function safePath(raw){try{const u=new URL(raw,'http://local');if(!raw.startsWith('/')||raw.startsWith('//')||u.origin!=='http://local'||/%(?:2f|5c|00|0d|0a)/i.test(u.pathname)||raw.includes('\\')||deniedPath(decodeURIComponent(u.pathname)))return null;return u.pathname+u.search;}catch{return null;}}
function incoming(req,host,websocket=false){
 const out={host};for(const[k,v]of Object.entries(req.headers))if(!hop.has(k)&&!['host','cookie','authorization','origin','referer','forwarded'].includes(k)&&!k.startsWith('x-forwarded-')&&!k.startsWith('tailscale-')&&!k.startsWith('x-harness-'))out[k]=v;
 // Do not negotiate compression through this byte-forwarding boundary. This
 // also avoids code-server's invalid extension response in Safari/WebKit.
 if(websocket){delete out['sec-websocket-extensions'];out.connection='Upgrade';out.upgrade='websocket';}
 return out;
}
function outgoing(headers,ownerOrigin){
 const out={};for(const[k,v]of Object.entries(headers))if(!hop.has(k)&&k!=='set-cookie'&&!k.startsWith('access-control-')&&k!=='service-worker-allowed')out[k]=v;
 out['cache-control']='no-store';out['referrer-policy']='no-referrer';out['origin-agent-cluster']='?1';out['x-content-type-options']='nosniff';
 const csp=String(out['content-security-policy']||'').split(';').map(x=>x.trim()).filter(x=>x&&!/^frame-ancestors(?:\s|$)/i.test(x));csp.push('frame-ancestors '+ownerOrigin);out['content-security-policy']=csp.join('; ');out['permissions-policy']='document-domain=()';
 return out;
}
function createEditorBroker({sessionId,generation,origin,ownerOrigin,socketPath,now=Date.now,grantMs=60000,sessionMs=30*60000,requestMs=30000,maxGrants=16}){
 const u=new URL(origin),owner=new URL(ownerOrigin);
 if(u.protocol!=='https:'||owner.protocol!=='https:'||u.origin!==origin||owner.origin!==ownerOrigin||origin===ownerOrigin||!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)||typeof generation!=='string'||!generation||typeof socketPath!=='string'||!(socketPath.startsWith('/')||process.platform==='win32'&&socketPath.startsWith('\\\\.\\pipe\\homeai-editor-'))||![grantMs,sessionMs,requestMs,maxGrants].every(x=>Number.isSafeInteger(x)&&x>0)||grantMs>120000||sessionMs>3600000)throw Error('EDITOR_CONFIGURATION_INVALID');
 const cookieName='__Secure-homeai-editor-'+digest(origin).slice(0,20),grants=new Map(),sessions=new Map(),sockets=new Set();let closed=false;
 const sweep=()=>{for(const map of[grants,sessions])for(const[k,v]of map)if(v<=now())map.delete(k);};
 const denied=(res,status=403,code='EDITOR_ACCESS_DENIED')=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify({code}));};
 const authority=req=>req.headers.host===u.host&&(!req.headers.origin||req.headers.origin===origin)&&req.headers['sec-fetch-site']!=='cross-site';
 function authorized(req){
  if(closed||!authority(req))return false;sweep();const values=String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));
  if(values.length!==1)return false;const value=values[0].slice(cookieName.length+1);return validToken(value)&&sessions.get(digest(value));
 }
 const bootstrapScript="const t=location.hash.slice(1);history.replaceState(null,'','/__editor/bootstrap');if(!/^[A-Za-z0-9_-]{43}$/.test(t))document.body.textContent='Editor link expired. Reopen it from the conversation.';else fetch('/__editor/claim',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant:t})}).then(r=>{if(!r.ok)throw Error();location.replace('/')}).catch(()=>document.body.textContent='Editor link expired. Reopen it from the conversation.');";
 const scriptHash=crypto.createHash('sha256').update(bootstrapScript).digest('base64');
 const server=http.createServer(async(req,res)=>{
  if(closed||!authority(req))return denied(res);
  if(req.method==='GET'&&req.url==='/__editor/bootstrap'){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Origin-Agent-Cluster':'?1','Content-Security-Policy':"default-src 'none'; script-src 'sha256-"+scriptHash+"'; connect-src 'self'; frame-ancestors "+ownerOrigin});
   return res.end('<!doctype html><meta charset="utf-8"><title>Opening editor</title><body>Opening editor…<script>'+bootstrapScript+'</script>');
  }
  if(req.method==='POST'&&req.url==='/__editor/claim'){
   if(req.headers.origin!==origin||String(req.headers['content-type']).split(';')[0]!=='application/json')return denied(res);
   let raw='',size=0;req.setTimeout(5000,()=>req.destroy());try{for await(const chunk of req){size+=chunk.length;if(size>512)return denied(res,413);raw+=chunk;}const v=JSON.parse(raw);sweep();if(!validToken(v.grant)||!grants.delete(digest(v.grant)))return denied(res);const credential=token();if(sessions.size>=maxGrants)return denied(res,429,'EDITOR_SESSION_LIMIT');sessions.set(digest(credential),now()+sessionMs);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':cookieName+'='+credential+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+Math.floor(sessionMs/1000)});return res.end('{"ok":true}');}catch{return denied(res,400);}
  }
  if(!authorized(req))return denied(res,401);const route=safePath(req.url);if(!route)return denied(res,404);
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin!==origin)return denied(res);
  const upstream=http.request({socketPath,path:route,method:req.method,headers:incoming(req,u.host)},reply=>{
   const location=reply.headers.location;if(location&&(!location.startsWith('/')||location.startsWith('//'))){reply.destroy();return denied(res,502,'EDITOR_REDIRECT_REFUSED');}
   res.writeHead(reply.statusCode,outgoing(reply.headers,ownerOrigin));reply.on('error',()=>res.destroy());reply.pipe(res);
  });upstream.setTimeout(requestMs,()=>upstream.destroy());upstream.on('error',()=>{if(res.headersSent)res.destroy();else denied(res,502,'EDITOR_UPSTREAM_UNAVAILABLE');});req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
 });
 server.on('upgrade',(req,socket,head)=>{
  const expires=authorized(req);if(!expires||req.headers.origin!==origin||req.headers.upgrade?.toLowerCase()!=='websocket'||!safePath(req.url)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  let peer,deadline;const request=http.request({socketPath,path:safePath(req.url),method:'GET',headers:incoming(req,u.host,true)});sockets.add(socket);
  const remove=()=>{clearTimeout(deadline);sockets.delete(socket);sockets.delete(peer);socket.destroy();peer?.destroy();request.destroy();};socket.on('error',remove);socket.on('close',remove);request.on('error',remove);request.setTimeout(5000,remove);
  request.on('response',reply=>{reply.resume();socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');});
  request.on('upgrade',(reply,upstream,upstreamHead)=>{peer=upstream;sockets.add(peer);peer.on('error',remove);peer.on('close',remove);request.setTimeout(0);
   if(reply.headers['sec-websocket-extensions'])return remove();
   const h=outgoing(reply.headers,ownerOrigin);h.connection='Upgrade';h.upgrade='websocket';delete h['content-length'];
   socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(h).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');if(upstreamHead.length)socket.write(upstreamHead);if(head.length)peer.write(head);socket.pipe(peer).pipe(socket);deadline=setTimeout(remove,Math.max(1,expires-now()));deadline.unref?.();
  });request.end();
 });
 return{server,sessionId,generation,origin,cookieName,issue(){if(closed)throw Error('EDITOR_CLOSED');sweep();if(grants.size>=maxGrants)throw Error('EDITOR_GRANT_LIMIT');const v=token(),expiresAt=now()+grantMs;grants.set(digest(v),expiresAt);return{version:1,sessionId,generation,state:'ready',url:origin+'/__editor/bootstrap#'+v,expiresAt};},close(){closed=true;grants.clear();sessions.clear();for(const s of sockets)s.destroy();server.closeAllConnections();server.close();}};
}
module.exports={createEditorBroker,safePath,incoming,outgoing};
