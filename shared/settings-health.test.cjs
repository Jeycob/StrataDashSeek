'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ROUTES,MAX_AGE_MS,REQUEST_MS,project,createController,render,component}=require('./settings-health.cjs');
const {workerProfile,PILOT_WORKER_PROFILE}=require('../vast/apps-worker-profile.cjs');
const SHA='a'.repeat(40),at=100000;
const sample=value=>({value,receivedAt:at});
const fixture=()=>({release:sample({workspaceReady:true,sourceCommit:SHA}),model:sample({at,model:{id:'effective-model',loaded:true}}),apps:sample({enabled:false,available:false,worker:null})});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const response=value=>({ok:true,json:async()=>value});
function timers(){let next=0;const pending=new Map();return{set:(fn,delay)=>{pending.set(++next,{fn,delay});return next;},clear:id=>pending.delete(id),fire:delay=>{for(const[id,t]of [...pending])if(t.delay===delay){pending.delete(id);t.fn();}},pending};}

test('served release and loaded model come from fresh current endpoints; disabled never means available',()=>{
 const data=fixture(),v=project(data,at);
 assert.equal(v.release.sourceCommit,SHA);assert.equal(v.model.id,'effective-model');assert.equal(v.apps.state,'disabled');assert.equal(v.vm.state,'disabled');
 assert.deepEqual(project({},at),Object.fromEntries(['release','model','apps','vm'].map(k=>[k,{state:'unknown',observedAt:null}])));
 data.release.value.sourceCommit='startup-update-is-not-a-current-source-sha';assert.equal(project(data,at).release.state,'unknown');
 data.model.value.model.loaded=undefined;assert.equal(project(data,at).model.id,undefined);
 data.model.value.model.loaded=false;assert.equal(project(data,at).model.state,'unavailable');
});
test('stale/future model telemetry and failed observations do not keep a healthy label or loaded identity',()=>{
 const data=fixture();data.model.value.at=at-MAX_AGE_MS-1;assert.equal(project(data,at).model.state,'stale');
 data.model.value.at=at+1;assert.equal(project(data,at).model.state,'stale');assert.equal(project(data,at).model.id,undefined);
 assert.equal(project(fixture(),at+MAX_AGE_MS+1).release.state,'stale');
 data.apps={failed:true,value:{enabled:true,available:true,worker:{managed:true,phase:'ready',profile:{observedInRunningBoot:true}}}};
 assert.equal(project(data,at).apps.state,'unavailable');assert.equal(project(data,at).vm.state,'unavailable');
});
test('VM readiness requires actual managed ready profile; missing state stays unknown',()=>{
 const data=fixture();data.apps=sample({enabled:true,available:true});assert.equal(project(data,at).vm.state,'unknown');
 data.apps.value.worker={managed:true,phase:'ready',profile:workerProfile({version:1,...PILOT_WORKER_PROFILE},{driver:'vfs',at,ready:false})};assert.equal(project(data,at).vm.state,'unavailable');
 data.apps.value.worker.profile=workerProfile({version:1,...PILOT_WORKER_PROFILE},{driver:'vfs',at,ready:true});assert.equal(project(data,at).vm.state,'available');
 data.apps.value.worker.phase='blocked';assert.equal(project(data,at).vm.state,'unavailable');
 data.apps.value.worker.phase='unknown';assert.equal(project(data,at).vm.state,'unknown');
 data.apps.value={enabled:false,available:true,worker:null};assert.equal(project(data,at).apps.state,'unknown');
});
test('fixed read-only requests project only needed public fields; component identity remains stable',async()=>{
 const t=timers(),seen=[],values=fixture();
 const ctl=createController({fetch:async(url,options)=>{seen.push({url,options});const key=Object.keys(ROUTES).find(k=>ROUTES[k]===url);return response({...values[key].value,password:'do-not-render'});},now:()=>at,setTimer:t.set,clearTimer:t.clear});
 await ctl.refresh();assert.deepEqual(seen.map(x=>x.url).sort(),Object.values(ROUTES).sort());
 for(const {options}of seen){assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.body,undefined);}
 assert.equal(JSON.stringify(ctl.snapshot()).includes('do-not-render'),false);assert.equal(ctl.snapshot().model.id,'effective-model');
 const React={};assert.equal(component(React),component(React));ctl.dispose();assert.equal(t.pending.size,0);
});
test('superseded requests ignoring abort cannot overwrite new responses or publish after disposal',async()=>{
 const t=timers(),old=[],seen=[];let round=0;
 const ctl=createController({fetch:async(url)=>{seen.push(url);if(round===0){const d=deferred();old.push(d);return d.promise;}return response(url===ROUTES.release?{workspaceReady:true,sourceCommit:'b'.repeat(40)}:url===ROUTES.model?{at,model:{id:'new-model',loaded:true}}:{enabled:true,available:true,worker:null});},onChange:x=>seen.push(x),now:()=>at,setTimer:t.set,clearTimer:t.clear});
 const first=ctl.refresh();round=1;await ctl.refresh();const n=seen.length;
 for(const d of old)d.resolve(response({workspaceReady:true,sourceCommit:SHA,at,model:{id:'old-model',loaded:true}}));
 await first;assert.equal(ctl.snapshot().release.sourceCommit,'b'.repeat(40));assert.equal(ctl.snapshot().model.id,'new-model');assert.equal(seen.length,n);
 ctl.dispose();await ctl.refresh();assert.equal(seen.length,n);assert.equal(t.pending.size,0);
});
test('request timeouts become unavailable without raw error disclosure and remove all request timers',async()=>{
 const t=timers(),events=[],ctl=createController({fetch:()=>new Promise(()=>{}),onChange:x=>events.push(x),now:()=>at,setTimer:t.set,clearTimer:t.clear});
 const pending=ctl.refresh();t.fire(REQUEST_MS);await pending;
 assert.equal(ctl.snapshot().release.state,'unavailable');assert.equal(ctl.snapshot().model.state,'unavailable');assert.equal(ctl.snapshot().apps.state,'unavailable');
 assert.equal(JSON.stringify(events).includes('STATUS_UNAVAILABLE'),false);ctl.dispose();assert.equal(t.pending.size,0);
});
test('real view distinguishes stale/unknown/disabled and exposes exact served SHA without private data',()=>{
 const h=(type,props,...children)=>({type,props,children}),view=project(fixture(),at);view.model={state:'stale',observedAt:null};view.vm={state:'unknown',observedAt:null};
 const node=render(h,view,'cs',()=>{}),text=JSON.stringify(node);
 assert.match(text,/SHA obsluhujících zdrojů/);assert.match(text,new RegExp(SHA));assert.match(text,/Zastaralé/);assert.match(text,/Neověřeno/);assert.match(text,/Vypnuto/);assert.doesNotMatch(text,/effective-model/);
});

test('rejects a non-string release SHA and keeps a stale VM disabled when Apps is off',()=>{
 const data=fixture();
 data.release=sample({sourceCommit:[SHA],workspaceReady:true});
 data.apps=sample({enabled:false,available:false,worker:{managed:true,phase:'ready',profile:{observedInRunningBoot:true}}});
 const view=project(data,at);
 assert.equal(view.release.state,'unknown');
 assert.equal(view.vm.state,'disabled');
});
