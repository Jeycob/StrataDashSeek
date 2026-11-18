// In-memory fixtures only. These do not invoke a service, credential or QA API.
import path from 'node:path';
export class Clock {
 constructor(){this.time=1700000000000;this.next=1;this.pending=new Map();}
 now=()=>this.time;
 setTimeout=(fn,ms)=>{const id=this.next++;this.pending.set(id,{at:this.time+ms,fn});return id;};
 clearTimeout=id=>this.pending.delete(id);
 advance(ms){this.time+=ms;for(const[id,row]of[...this.pending])if(row.at<=this.time){this.pending.delete(id);row.fn();}}
}
export class MemoryFS {
 constructor(){this.nodes=new Map();this.events=[];this.next=10;this.fd=30;this.hold=null;this.fail=null;this.syncs=0;for(const name of ['/','/synthetic','/synthetic/attemptA'])this.nodes.set(name,{kind:'dir',uid:0,gid:0,mode:0o40700,dev:1,ino:this.next++,nlink:2,bytes:Buffer.alloc(0)});}
 async step(name){this.events.push(name);if(this.fail===name)throw Object.assign(Error('synthetic fs error'),{code:'SYNTHETIC_IO'});if(this.hold?.name===name){this.hold.entered=true;await new Promise(resolve=>{this.hold.release=resolve;});}}
 statOf(n){return{uid:n.uid,gid:n.gid,mode:n.mode,dev:n.dev,ino:n.ino,nlink:n.nlink,size:n.bytes.length,isDirectory:()=>n.kind==='dir',isSymbolicLink:()=>n.kind==='link',isFile:()=>n.kind==='file'};}
 async lstat(name){await this.step('lstat:'+name);const n=this.nodes.get(name);if(!n)throw Object.assign(Error('synthetic missing'),{code:'ENOENT'});return this.statOf(n);}
 async realpath(name){await this.step('realpath:'+name);return name;}
 async readdir(name){await this.step('readdir:'+name);return[...this.nodes.keys()].filter(n=>n!==name&&path.posix.dirname(n)===name).map(n=>path.posix.basename(n));}
 async open(name,flags,mode){await this.step('open:'+name);let n=this.nodes.get(name);if(flags==='wx'){if(n)throw Object.assign(Error('synthetic existing'),{code:'EEXIST'});n={kind:'file',uid:0,gid:0,mode:0o100000|mode,dev:1,ino:this.next++,nlink:1,bytes:Buffer.alloc(0)};this.nodes.set(name,n);}else if(!n)throw Object.assign(Error('synthetic missing'),{code:'ENOENT'});const self=this;
  return{fd:this.fd++,async stat(){await self.step('fstat:'+name);return self.statOf(n);},async writeFile(bytes){await self.step('write:'+name);n.bytes=Buffer.from(bytes);},async sync(){const marker=n.kind==='dir'?'dir.sync#'+(++self.syncs):'file.sync:'+name;await self.step(marker);},async close(){await self.step('close:'+name);}};
 }
}
export const target=Object.freeze({owned:true,sessionId:'synthetic-own-session',workspaceId:'synthetic-own-workspace',projectId:'synthetic-own-project'});
export const attemptId='synthetic-attempt-01',cookie='session=synthetic_owner_cookie_value_123456',requestId='11111111-2222-4333-8444-555555555555';
export const id=n=>'aaaaaaaa-bbbb-4ccc-8ddd-'+String(n).padStart(12,'0');
export const snapshot=(previous=null,pending)=>({attemptId,identity:{sessionId:target.sessionId,workspaceId:target.workspaceId,projectId:target.projectId},operator:{requestId,persistence:{lastDurableCheckpointId:previous,...(pending?{pendingCheckpointId:pending}:{})}},status:'BLOCKED',nativeObservation:{events:[]}});
export function options(){return{target,attemptId,ownerHost:'fixture.invalid',ownerCookie:cookie,checkpointDirectory:'/synthetic/attemptA',checkpointBudgetBytes:67108864,checkpointBudgetCount:2048};}
export function dependencies(memory,clock){return{fs:memory,now:clock.now,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,platform:'linux',getuid:()=>0};}
export async function until(predicate){for(let n=0;n<256;n++){if(predicate())return;await Promise.resolve();}throw Error('in-memory boundary not reached');}
// Constructed data only; no frozen benchmark prompt, fixture or actual run is copied.
export function syntheticRecord(){return{
 recordVersion:1,isTemplate:true,recordKind:'model_benchmark_attempt',status:'NOT RUN',scenario:'B03',variant:'HomeAI',pairId:'synthetic-pair',runId:'synthetic-run',attemptId:'planned-b03-homeai-primary',
 identity:{promptSha256:null,manifestSha256:'c'.repeat(64),acceptanceVersion:'synthetic-acceptance'},
 limits:{mainSeconds:600,repairSeconds:300,maxRepairs:1},
 timestampsUtc:{runSubmittedAt:null,submittedAt:null,firstOutputAt:null,implementationReadyAt:null,validationStartedAt:null,acceptedAt:null,limitReachedAt:null,stopRequestedAt:null,finishedAt:null,settledAt:null},
 stopReason:null,timingMs:{},counts:{},quality:{accepted:null,checks:[]},missingDataReasons:[],
};}
