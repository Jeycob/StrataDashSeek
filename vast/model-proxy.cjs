'use strict';
const http=require('node:http');
const {setTimeout:delay}=require('node:timers/promises');
async function waitForModel(options,signal){const deadline=Date.now()+(options.readyTimeoutMs??180000);while(Date.now()<deadline){signal.throwIfAborted();try{const r=await fetch('http://127.0.0.1:'+(options.upstreamPort||8080)+'/health',{signal:AbortSignal.any([signal,AbortSignal.timeout(1800)])});if(r.ok&&(await r.json()).loaded)return;}catch(e){if(signal.aborted)throw signal.reason;}await delay(options.readyPollMs??1000,undefined,{signal});}throw Object.assign(Error('Model readiness timed out'),{status:503});}
function normalizePayload(input){
 const payload={...input,chat_template_kwargs:{...input.chat_template_kwargs}};
 const effort=payload.chat_template_kwargs.enable_thinking===false?'off':payload.reasoning_effort??payload.chat_template_kwargs.reasoning_effort??'medium';
 const off=['off','none'].includes(effort);payload.reasoning_effort=off?'none':effort;
 payload.chat_template_kwargs.enable_thinking=!off;
 if(off){delete payload.chat_template_kwargs.reasoning_effort;delete payload.reasoning_budget_tokens;delete payload.thinking_budget_tokens;}
 else {payload.chat_template_kwargs.reasoning_effort=effort;if(payload.reasoning_budget_tokens==null&&payload.thinking_budget_tokens==null)payload.thinking_budget_tokens=Math.min(({minimal:512,low:2048,medium:4096,high:8192})[effort]??4096,Math.max(1,Math.floor((payload.max_tokens||32768)/2)));}
 payload.max_tokens=Math.min(payload.max_tokens??32768,32768);
 payload.temperature??=1;payload.top_p??=.95;payload.top_k??=20;
 return payload;
}
function createModelProxy(options={}){return http.createServer(async(req,res)=>{
 const controller=new AbortController();let upstream;
 res.on('close',()=>{if(!res.writableEnded){controller.abort();upstream?.destroy();}});
 try {
  if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({object:'list',data:[{id:'strata',object:'model',owned_by:'local'}]}));}
  if(req.url!=='/v1/chat/completions'||req.method!=='POST'){res.writeHead(404);return res.end();}
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024){res.writeHead(413);return res.end();}chunks.push(chunk);}
  const payload=normalizePayload(JSON.parse(Buffer.concat(chunks)));
  await waitForModel(options,controller.signal);controller.signal.throwIfAborted();
  const body=Buffer.from(JSON.stringify(payload));
  upstream=http.request({host:'127.0.0.1',port:options.upstreamPort||8080,path:req.url,method:'POST',headers:{'Content-Type':'application/json','Content-Length':body.length}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);reply.on('error',()=>res.destroy());});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end();});res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});upstream.end(body);
 }catch(e){if(!res.headersSent)res.writeHead(e.status||400);res.end();}
});}
module.exports={normalizePayload,createModelProxy};
if(require.main===module)createModelProxy().listen(8088,'127.0.0.1');

