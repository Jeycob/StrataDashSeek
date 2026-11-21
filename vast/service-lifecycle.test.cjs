'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ServiceLifecycle}=require('./service-lifecycle.cjs');
test('crashes back off, exhaust the restart budget and remain blocked across a controller restart',()=>{
 let time=1000,saved;const options={now:()=>time,changed:value=>{saved=structuredClone(value);}},life=new ServiceLifecycle(options);
 const delays=[];for(let i=0;i<5;i++){assert.equal(life.canStart('harness'),true);life.started('harness');const next=life.exited('harness');assert.equal(next.restart,true);delays.push(next.delayMs);time+=next.delayMs;}
 assert.deepEqual(delays,[3000,6000,12000,24000,30000]);life.started('harness');assert.equal(life.exited('harness').restart,false);assert.equal(saved.phase,'failed');assert.equal(saved.failedService,'harness');
 const restarted=new ServiceLifecycle({...options,initial:saved});assert.equal(restarted.canStart('harness'),false);assert.equal(restarted.snapshot().phase,'failed');
 time+=300001;const later=new ServiceLifecycle({...options,initial:saved});assert.equal(later.canStart('harness'),true);
});
test('a failed service cannot be hidden by successful sibling starts and snapshots cannot mutate the budget',()=>{
 const life=new ServiceLifecycle({maxRestarts:0});life.started('harness');life.exited('harness');life.started('push');const publicCopy=life.snapshot();publicCopy.services.harness.failures.length=0;
 assert.equal(life.snapshot().phase,'failed');assert.equal(life.canStart('harness'),false);assert.equal(life.canStart('telemetry'),true);
});
test('notification watcher exhaustion is visible without blocking critical readiness or resetting its budget',()=>{
 const life=new ServiceLifecycle({maxRestarts:1});life.started('harness');life.started('push-watcher');
 assert.equal(life.exited('push-watcher').restart,true);
 assert.equal(life.snapshot().phase,'ready');
 assert.equal(life.snapshot().reasonCode,'NOTIFICATION_WATCHER_RESTARTING');
 life.started('push-watcher');assert.equal(life.exited('push-watcher').restart,false);
 assert.equal(life.canStart('push-watcher'),false);
 assert.equal(life.snapshot().failedService,'push-watcher');
 assert.equal(life.snapshot().reasonCode,'NOTIFICATION_WATCHER_UNAVAILABLE');
 assert.equal(life.snapshot().phase,'ready');
 life.exited('harness');life.started('harness');life.exited('harness');
 assert.equal(life.snapshot().failedService,'harness');
 assert.equal(life.snapshot().phase,'failed');
});
test('a controller restart preserves the remaining backoff without treating unused services as unready',()=>{
 let time=1000,saved;const first=new ServiceLifecycle({now:()=>time,changed:state=>{saved=state;}});first.started('harness');first.exited('harness');
 time=2000;const next=new ServiceLifecycle({now:()=>time,initial:saved});assert.equal(next.snapshot().phase,'ready');assert.deepEqual(next.admission('harness'),{allowed:false,retryAfterMs:2000});assert.equal(next.snapshot().phase,'starting_services');
 time=3999;assert.deepEqual(next.admission('harness'),{allowed:false,retryAfterMs:1});time=4000;assert.equal(next.canStart('harness'),true);next.started('harness');assert.equal(next.snapshot().phase,'ready');
});
