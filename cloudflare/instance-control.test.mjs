import test from 'node:test';import assert from 'node:assert/strict';
import {createInstanceControl} from './instance-control.mjs';
test('100 overlapping status requests share one GET and status never wakes',async()=>{
 let calls=0,t=0;const control=createInstanceControl({now:()=>t,request:async method=>{assert.equal(method,'GET');calls++;await new Promise(r=>setImmediate(r));return{instances:{actual_status:'running'}};}});
 await Promise.all(Array.from({length:100},()=>control.read()));assert.equal(calls,1);t=4999;await control.read();assert.equal(calls,1);t=5000;await control.read();assert.equal(calls,2);
});
test('capacity attempts deduplicate sequential callers and writes invalidate stopped state',async()=>{
 let t=0,reads=0,writes=0;const control=createInstanceControl({now:()=>t,request:async method=>{if(method==='GET'){reads++;return{instances:{actual_status:'exited',intended_status:'stopped'}};}writes++;return{success:false,msg:'resources unavailable, state change queued'};}});
 assert.equal((await control.wake()).queued,true);for(let i=0;i<100;i++)await control.wake();assert.equal(writes,1);t=15000;await control.wake();assert.equal(writes,2);assert.equal(reads,2);
});
test('429 cooldown applies to status and wake without automatic retries',async()=>{
 let t=0,calls=0;const control=createInstanceControl({now:()=>t,request:async()=>{calls++;throw Object.assign(Error('limited'),{retryAfterSeconds:75});}});
 await assert.rejects(control.read());t=74000;await assert.rejects(control.wake());assert.equal(calls,1);t=75000;await assert.rejects(control.read());assert.equal(calls,2);
});
test('one failed caller does not poison recovery or leave a pending request',async()=>{
 let t=0,calls=0;const control=createInstanceControl({now:()=>t,request:async()=>{if(!calls++)throw Error('offline');return{instances:{actual_status:'running',intended_status:'running'}};}});
 await assert.rejects(control.read());t=15000;assert.equal((await control.wake()).ok,true);assert.equal(calls,2);
});
