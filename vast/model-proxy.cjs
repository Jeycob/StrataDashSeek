'use strict';
const http=require('node:http');
http.createServer(async(req,res)=>{
 try {
  if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({object:'list',data:[{id:'strata',object:'model',owned_by:'local'}]}));}
  if(req.url!=='/v1/chat/completions'||req.method!=='POST'){res.writeHead(404);return res.end();}
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024){res.writeHead(413);return res.end();}chunks.push(chunk);}
  const payload=JSON.parse(Buffer.concat(chunks));payload.reasoning_effort??='medium';
  if(payload.reasoning_budget_tokens==null&&payload.thinking_budget_tokens==null)payload.reasoning_budget_tokens=Math.min(2048,Math.max(1,Math.floor((payload.max_tokens||16384)/2)));
  const body=Buffer.from(JSON.stringify(payload));
  const upstream=http.request({host:'127.0.0.1',port:8080,path:req.url,method:'POST',headers:{'Content-Type':'application/json','Content-Length':body.length}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);reply.on('error',()=>res.destroy());});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end();});res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});upstream.end(body);
 }catch{if(!res.headersSent)res.writeHead(400);res.end();}
}).listen(8088,'127.0.0.1');
