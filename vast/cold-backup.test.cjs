'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const{captureWithFence,withFailureStatus}=require('./cold-backup.cjs');
function fixture(){let writers=0,lease={dev:1,ino:2};const broker={state:{open:true,epoch:'fixed'},async closeAdmission(){this.state.open=false;}},calls=[];const input={root:'/fixture',uid:1001,broker,sourceCommit:'a'.repeat(40),inheritedLease:()=>calls.push('lease'),assertNoAgentProcesses:()=>{calls.push('writers');if(writers)throw Error('WRITER_PRESENT');},readLease:()=>lease};return{input,broker,calls,writers:value=>writers=value,lease:value=>lease=value};}
test('cold capture is fenced before source starts and cannot complete until capture settles',async()=>{
 const f=fixture(),events=[];const result=await captureWithFence({...f.input,async capture(guard){assert.equal(f.broker.state.open,false);events.push('start');const first=guard();await Promise.resolve();assert.deepEqual(guard(),first);events.push('finish');return{status:'captured'};}});assert.deepEqual(result,{status:'captured'});assert.deepEqual(events,['start','finish']);assert(f.calls.filter(x=>x==='writers').length>=4);
});
test('optional backup failures publish explicit status and preserve startup, while violated fences and lease ownership remain fatal',async()=>{
 for(const code of ['BACKUP_CAPACITY','BACKUP_CONFIGURATION_INVALID','BACKUP_SOURCE_INCOMPLETE']){
  let status;const result=await withFailureStatus(async()=>{throw Object.assign(Error(code),{code});},v=>{status=v;});assert.deepEqual(result,{status:'failed',code});assert.equal(status.code,code);assert.equal(status.status,'failed');
 }
 for(const code of ['BACKUP_FENCE_CHANGED','RUNTIME_LAUNCH_USER_PROCESS_ACTIVE','RUNTIME_LAUNCH_LEASE_BUSY']){let status;await assert.rejects(withFailureStatus(async()=>{throw Object.assign(Error(code),{code});},v=>{status=v;}));assert.equal(status.code,code);}
 await assert.rejects(withFailureStatus(async()=>{throw Error('capture');},()=>{throw Error('status unavailable');}),/status unavailable/);
});
test('writers, a changed epoch, reopened admission or changed lease invalidate capture without a success result',async()=>{
 const initial=fixture();initial.writers(1);let started=false;await assert.rejects(captureWithFence({...initial.input,capture:()=>{started=true;}}),/BACKUP_FENCE_CHANGED/);assert.equal(started,false);
 for(const mutation of[f=>f.writers(1),f=>f.broker.state.epoch='other',f=>f.broker.state.open=true,f=>f.lease({dev:1,ino:3})]){const f=fixture();await assert.rejects(captureWithFence({...f.input,async capture(guard){mutation(f);guard();return{status:'must-not-complete'};}}));}
});
test('unreadable lease and failed guard observations never become optional backup failures',async()=>{
 for(const field of ['readLease','assertNoAgentProcesses','inheritedLease']){const f=fixture();let calls=0;const original=f.input[field];f.input[field]=(...args)=>{if(calls++)throw Object.assign(Error('unavailable'),{code:'EBADF'});return original(...args);};let status;await assert.rejects(withFailureStatus(()=>captureWithFence({...f.input,capture:async guard=>guard()}),v=>{status=v;}),/BACKUP_FENCE_CHANGED/);assert.equal(status.code,'BACKUP_FENCE_CHANGED');}
 const f=fixture();f.input.broker.closeAdmission=async()=>{throw Error('unknown admission');};await assert.rejects(withFailureStatus(()=>captureWithFence({...f.input,capture:async()=>{}}),()=>{}),/BACKUP_FENCE_CHANGED/);
});
