'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/vm-ownership.cjs');

test('unowned warm pidfile never becomes a recovered worker or permits effects',async()=>{
 const f=fixture({record:'73\n'});assert.equal(f.worker.phase,'quarantined');assert.equal(f.worker.pid(),null);
 await assert.rejects(f.worker.ensure(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});await assert.rejects(f.worker.start(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});await assert.rejects(f.worker.stop(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});assert.deepEqual(f.events,[]);
});
test('read errors, malformed, symlink and stale pid records stay UNKNOWN before effects',async()=>{
 for(const options of[{record:'73',readError:true},{record:'NaN'},{record:'73 74'},{record:'0'},{record:'73',symlink:true},{record:'999999\n'}]){const f=fixture(options);assert.equal(f.worker.phase,'quarantined');await assert.rejects(f.worker.start(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});await assert.rejects(f.worker.stop(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});assert.deepEqual(f.events,[]);}
});
test('disabled unknown guest retains the existing disabled quarantine',async()=>{
 const f=fixture({record:'73',enabled:false});assert.equal(f.worker.phase,'quarantined');await assert.rejects(f.worker.start(),{code:'APPS_WORKER_DISABLED'});assert.deepEqual(f.events,[]);
});
test('proven absent cold path still spawns exactly once and reaches ready with its private child',async()=>{
 const f=fixture();assert.equal(f.worker.phase,'asleep');await f.worker.start();assert.equal(f.worker.phase,'ready');assert.equal(f.worker.pid(),731);assert.equal(f.events.filter(x=>x==='spawn').length,1);assert.equal(f.events.includes('proc-read'),false);f.setRecord(null);f.exit();f.close();
});
test('pidfile disappearance cannot settle a live owned child; exit alone cannot settle it either',async()=>{
 const f=fixture();await f.worker.start();f.setRecord(null);assert.equal(f.worker.pid(),731);let settled=false;
 const pending=f.worker.stop().then(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.notEqual(f.worker.phase,'asleep');assert(f.events.includes('poweroff'));
 f.exit();await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.notEqual(f.worker.phase,'asleep');f.close();await pending;assert.equal(f.worker.phase,'asleep');assert.equal(f.worker.pid(),null);
});
test('owned pidfile read failure and replacement refuse stop without losing the claim',async()=>{
 const f=fixture();await f.worker.start();const before=f.events.length;f.setReadError(true);await assert.rejects(f.worker.stop(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});assert.notEqual(f.worker.phase,'asleep');assert.equal(f.events.length,before);
 f.setReadError(false);f.setRecord('732\n');await assert.rejects(f.worker.stop(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});assert.notEqual(f.worker.phase,'asleep');assert.equal(f.events.length,before);f.setRecord(null);f.exit();f.close();
});
test('close deadline rejects and retains owned work instead of manufacturing asleep or a new spawn',async()=>{
 const f=fixture({expireClose:true});await f.worker.start();f.setRecord(null);await assert.rejects(f.worker.stop(),{code:'APPS_VM_SETTLEMENT_UNCONFIRMED'});assert.notEqual(f.worker.phase,'asleep');assert.equal(f.worker.pid(),731);const events=f.events.length;await assert.rejects(f.worker.start(),{code:'APPS_VM_SETTLEMENT_UNCONFIRMED'});await assert.rejects(f.worker.ensure(),{code:'APPS_VM_SETTLEMENT_UNCONFIRMED'});assert.equal(f.events.length,events);assert.equal(f.events.filter(x=>x==='spawn').length,1);f.exit();f.close();
});
test('stale pidfile after real owned close remains held, never permits automatic replacement',async()=>{
 const f=fixture();await f.worker.start();f.exit();f.close();assert.notEqual(f.worker.phase,'asleep');await assert.rejects(f.worker.start(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});assert.equal(f.events.filter(x=>x==='spawn').length,1);
});
test('legacy or pending restart without a pidfile is UNKNOWN, not evidence of absence',async()=>{
 for(const savedState of[{initialized:true},{initialized:false},{initialized:false,workerProcess:{version:1,state:'starting'}},{workerProcess:{version:99,state:'absent'}}]){const f=fixture({savedState});assert.equal(f.worker.phase,'quarantined');await assert.rejects(f.worker.start(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});assert.deepEqual(f.events,[]);}
});
test('start intent precedes dispatch and cannot be reused as absence after controller restart',async()=>{
 const f=fixture();await f.worker.start();assert(f.events.indexOf('save')<f.events.indexOf('spawn'));assert.equal(f.snapshots[0].workerProcess.state,'starting');
 const restarted=fixture({savedState:f.snapshots[0]});assert.equal(restarted.worker.phase,'quarantined');await assert.rejects(restarted.worker.start(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});f.setRecord(null);f.exit();f.close();
});
test('only actual owned close publishes a durable absent receipt usable by a new controller',async()=>{
 const f=fixture();await f.worker.start();f.setRecord(null);const pending=f.worker.stop();await new Promise(resolve=>setImmediate(resolve));f.exit();assert(!f.snapshots.some(s=>s.workerProcess?.state==='absent'));f.close();await pending;
 const receipt=f.snapshots.at(-1);assert.equal(receipt.workerProcess.version,1);assert.equal(receipt.workerProcess.state,'absent');const restarted=fixture({savedState:receipt});assert.equal(restarted.worker.phase,'asleep');
});
test('failed durable absence publication keeps HOLD even after the child closed',async()=>{
 const f=fixture({failAbsenceSave:true});await f.worker.start();f.setRecord(null);const pending=f.worker.stop();await new Promise(resolve=>setImmediate(resolve));f.exit();f.close();await assert.rejects(pending);assert.notEqual(f.worker.phase,'asleep');await assert.rejects(f.worker.start(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});
});
