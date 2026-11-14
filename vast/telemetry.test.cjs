const test=require('node:test'),assert=require('node:assert/strict'),{normalizeRequests}=require('./telemetry.cjs');
test('native newest-first metrics retain the real latest rate and cache count',()=>{
 const requests=normalizeRequests({requests:[{id:'new',time:20,prompt_tokens:200,prompt_read:20,reused:180,prompt_ms:100,decode_tok_s:70,output_tokens:81,duration_s:1.6},{id:'old',time:10,decode_tok_s:79}]});
 assert.equal(requests.at(-1).id,'new');assert.equal(requests.at(-1).decodeTokensPerSecond,70);assert.equal(requests.at(-1).cachedTokens,180);assert.equal(requests.at(-1).prefillTokensPerSecond,200);assert.equal(requests.at(-1).durationSeconds,1.6);assert.deepEqual(normalizeRequests(null),[]);
});
test('energy uses Wh, with 1000 Wh per kWh',()=>{
 const {wattSecondsToWh}=require('./telemetry.cjs');assert.equal(wattSecondsToWh(100,3600),100);assert.equal(wattSecondsToWh(14,3600)/1000,.014);assert.equal(wattSecondsToWh(100,3600)/1000,.1);assert.equal(wattSecondsToWh(14,-60),0);assert.equal(wattSecondsToWh(Infinity,60),0);
});
test('CPU usage is normalized to assigned cores, with reset and first-sample handling',()=>{
 const {cpuPercentFromUsage}=require('./telemetry.cjs');assert.equal(cpuPercentFromUsage(1e6,4e6,3,1),100);assert.equal(cpuPercentFromUsage(1e6,4e6,3,6),100/6);assert.equal(cpuPercentFromUsage(undefined,4e6,3,6),null);assert.equal(cpuPercentFromUsage(4e6,1e6,3,6),null);assert.equal(cpuPercentFromUsage(1e6,4e6,0,6),null);
});
test('I/O is counted from this container instead of shared host disks',()=>{
 const {parseIoStat}=require('./telemetry.cjs');assert.deepEqual(parseIoStat('259:0 rbytes=100 wbytes=40 rios=2\n8:0 wbytes=60 rbytes=200\n'),{read:300,write:100,devices:2});assert.equal(parseIoStat(''),null);assert.equal(parseIoStat('259:0 invalid=3'),null);
});
test('whole-turn queue age includes tool gaps and the oldest waiting turn',()=>{
 const {queueSnapshot}=require('./telemetry.cjs');assert.deepEqual(queueSnapshot({owner:'A',active:[{rootId:'A',queuedAt:1000},{rootId:'A',queuedAt:4000}],waiting:[{queuedAt:2000},{queuedAt:3000}]},6000),{working:true,waiting:2,oldestWaitSeconds:4,ownerSeconds:5});assert.deepEqual(queueSnapshot({owner:null,active:[],waiting:[]},6000),{working:false,waiting:0,oldestWaitSeconds:0,ownerSeconds:0});
});
