'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {readWorkbench}=require('./apps-context.cjs');
test('project registry has an absolute deadline despite a continuous trickle of bytes',async t=>{
 let interval,closed=false,bytes=0;const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');interval=setInterval(()=>{bytes++;res.write(' ');},10);res.once('close',()=>{closed=true;clearInterval(interval);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{clearInterval(interval);server.closeAllConnections();await new Promise(r=>server.close(r));});
 const started=Date.now();await assert.rejects(readWorkbench({port:server.address().port,publicHost:'fixture.ts.net',cookie:'owner=fixture',deadlineMs:120}),e=>e.status===504);assert(Date.now()-started<1000);assert(bytes>=3);for(let i=0;i<30&&!closed;i++)await new Promise(r=>setTimeout(r,10));assert.equal(closed,true);
});
test('registry read settles on success, size refusal and caller abort without leaving a deadline behind',async t=>{
 let mode='success';const server=http.createServer((req,res)=>{if(mode==='success')return res.end('{"projects":{}}');if(mode==='large')return res.end('x'.repeat(2*1024*1024+1));res.write('{');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});const options={port:server.address().port,publicHost:'fixture.ts.net',deadlineMs:200};
 assert.deepEqual(await readWorkbench(options),{projects:{}});mode='large';await assert.rejects(readWorkbench(options),e=>e.code==='WORKBENCH_RESPONSE_TOO_LARGE');mode='held';const abort=new AbortController(),pending=readWorkbench({...options,signal:abort.signal});abort.abort();await assert.rejects(pending,e=>e.name==='AbortError');await new Promise(r=>setTimeout(r,240));
});
