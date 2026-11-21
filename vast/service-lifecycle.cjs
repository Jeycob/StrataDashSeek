'use strict';

class ServiceLifecycle {
 constructor({ now=Date.now, initial={}, maxRestarts=5, windowMs=300000, baseDelayMs=3000, maxDelayMs=30000, changed=()=>{} }={}) {
  this.now=now;this.maxRestarts=maxRestarts;this.windowMs=windowMs;this.baseDelayMs=baseDelayMs;this.maxDelayMs=maxDelayMs;this.changed=changed;this.services=new Map();
  for(const[name,row]of Object.entries(initial.services||{}))if(/^[a-z][a-z0-9-]{0,63}$/.test(name)&&Array.isArray(row.failures))this.services.set(name,{failures:row.failures.filter(at=>Number.isSafeInteger(at)&&at<=now()&&now()-at<windowMs),phase:'inactive',nextRetryAt:Number.isSafeInteger(row.nextRetryAt)&&row.nextRetryAt>now()?Math.min(row.nextRetryAt,now()+maxDelayMs):null});
 }
 admission(name){const row=this.services.get(name);if(!row)return{allowed:true,retryAfterMs:0};row.failures=row.failures.filter(at=>this.now()-at<this.windowMs);if(row.failures.length>this.maxRestarts){row.phase='failed';this.changed(this.snapshot());return{allowed:false,retryAfterMs:null};}if(row.nextRetryAt>this.now()){row.phase='starting_services';this.changed(this.snapshot());return{allowed:false,retryAfterMs:row.nextRetryAt-this.now()};}return{allowed:true,retryAfterMs:0};}
 canStart(name){return this.admission(name).allowed;}
 started(name){const old=this.services.get(name);this.services.set(name,{failures:old?.failures||[],phase:'ready',nextRetryAt:null,startedAt:this.now()});this.changed(this.snapshot());}
 exited(name){
  const now=this.now(),old=this.services.get(name),failures=(old?.failures||[]).filter(at=>now-at<this.windowMs);failures.push(now);
  const exhausted=failures.length>this.maxRestarts,delay=exhausted?null:Math.min(this.maxDelayMs,this.baseDelayMs*2**(failures.length-1));
  this.services.set(name,{failures,phase:exhausted?'failed':'starting_services',nextRetryAt:delay===null?null:now+delay});this.changed(this.snapshot());
  return{restart:!exhausted,delayMs:delay,reasonCode:exhausted?'SERVICE_RESTART_LIMIT':'SERVICE_RESTART_BACKOFF'};
 }
 snapshot(){
  const services=Object.fromEntries([...this.services].map(([name,row])=>[name,{...row,failures:[...row.failures]}]));
  const critical=Object.entries(services).filter(([name])=>name!=='push-watcher');
  const failed=critical.find(([,row])=>row.phase==='failed'),waiting=critical.some(([,row])=>row.phase==='starting_services');
  const watcher=services['push-watcher']?.phase;
  const phase=failed?'failed':waiting?'starting_services':'ready';
  let reasonCode='SERVICES_STARTED';
  if(failed)reasonCode='SERVICE_RESTART_LIMIT';
  else if(waiting)reasonCode='SERVICE_RESTART_BACKOFF';
  else if(watcher==='failed')reasonCode='NOTIFICATION_WATCHER_UNAVAILABLE';
  else if(watcher==='starting_services')reasonCode='NOTIFICATION_WATCHER_RESTARTING';
  return{version:1,at:this.now(),phase,reasonCode,failedService:failed?.[0]||(watcher==='failed'?'push-watcher':null),services};
 }
}
module.exports={ServiceLifecycle};
