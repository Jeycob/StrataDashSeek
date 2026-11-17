'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(fetch){
 const source=fs.readFileSync(path.join(__dirname,'source.js'),'utf8'),start=source.indexOf('async function nativeJSON('),end=source.indexOf('\nasync function state()',start);
 assert(start>=0&&end>start,'Native requests need the explicit compatibility lifetime');
 const timers=new Map();let serial=0;
 function LegacyAbortSignal(){}LegacyAbortSignal.prototype=AbortSignal.prototype;
 const scope={AbortSignal:LegacyAbortSignal,AbortController,DOMException,fetch,setTimeout(fn){const id=++serial;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}};
 vm.createContext(scope);vm.runInContext(source.slice(0,source.indexOf('const inject='))+source.slice(start,end),scope);
 return {scope,timers};
}
test('older Native abort composition validates every signal and preserves the first cancellation reason',()=>{
 const {scope,timers}=fixture(),a=new AbortController(),b=new AbortController(),joined=scope.AbortSignal.any([a.signal,b.signal]);
 assert.equal(joined.aborted,false);b.abort('closed view');assert.equal(joined.reason,'closed view');a.abort('later');assert.equal(joined.reason,'closed view');
 assert.throws(()=>scope.AbortSignal.any([b.signal,{}]),/AbortSignal|Value of|not of type/);
 assert.throws(()=>scope.AbortSignal.timeout(-1),/timeout/);const timeout=scope.AbortSignal.timeout(15);assert.equal(timeout.aborted,false);[...timers.values()][0]();assert.equal(timeout.reason.name,'TimeoutError');
});
test('Native timeout covers a stalled JSON body and detaches the caller after rejection',async()=>{
 let request;const external=new AbortController(),add=external.signal.addEventListener.bind(external.signal),remove=external.signal.removeEventListener.bind(external.signal);let attached=0;
 external.signal.addEventListener=(...args)=>{attached++;return add(...args);};external.signal.removeEventListener=(...args)=>{attached--;return remove(...args);};
 const f=fixture(async(_url,options)=>{request=options;return{ok:true,json:()=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('body cancelled','AbortError')),{once:true}))};});
 const pending=f.scope.nativeJSON('/own-fixture',{signal:external.signal});await new Promise(r=>setImmediate(r));assert.equal(attached,1);assert.equal(f.timers.size,1);[...f.timers.values()][0]();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(request.signal.aborted,true);assert.equal(attached,0);assert.equal(f.timers.size,0);
});
test('Native requests clean up successful and failed bodies, preserve HTTP errors, and relay a closed view',async()=>{
 for(const mode of ['success','http','body','abort']){
  const external=new AbortController();let signal;
  const f=fixture(async(_url,options)=>{signal=options.signal;return{ok:mode!=='http',status:409,json:async()=>{if(mode==='body')throw Error('invalid JSON');if(mode==='abort')external.abort();return mode==='http'?{error:'conflict',code:'CONFLICT'}:{value:7};}};});
  const pending=f.scope.nativeJSON('/own-fixture',{signal:external.signal});
  if(mode==='success')assert.equal((await pending).value,7);else if(mode==='http')await assert.rejects(pending,{message:'conflict',code:'CONFLICT'});else if(mode==='body')await assert.rejects(pending,/invalid JSON/);else{await assert.rejects(pending,{name:'AbortError'});assert.equal(signal.aborted,true);}
  assert.equal(f.timers.size,0,mode);
 }
});
