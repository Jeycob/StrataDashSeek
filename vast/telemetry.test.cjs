const test=require('node:test'),assert=require('node:assert/strict'),{normalizeRequests}=require('./telemetry.cjs');
test('native newest-first metrics retain the real latest rate and cache count',()=>{
 const requests=normalizeRequests({requests:[{id:'new',time:20,prompt_tokens:200,prompt_read:20,reused:180,prompt_ms:100,decode_tok_s:70,output_tokens:81,duration_s:1.6},{id:'old',time:10,decode_tok_s:79}]});
 assert.equal(requests.at(-1).id,'new');assert.equal(requests.at(-1).decodeTokensPerSecond,70);assert.equal(requests.at(-1).cachedTokens,180);assert.equal(requests.at(-1).prefillTokensPerSecond,200);assert.equal(requests.at(-1).durationSeconds,1.6);assert.deepEqual(normalizeRequests(null),[]);
});
test('energy uses Wh, with 1000 Wh per kWh',()=>{
 const {wattSecondsToWh}=require('./telemetry.cjs');assert.equal(wattSecondsToWh(100,3600),100);assert.equal(wattSecondsToWh(14,3600)/1000,.014);assert.equal(wattSecondsToWh(100,3600)/1000,.1);assert.equal(wattSecondsToWh(14,-60),0);assert.equal(wattSecondsToWh(Infinity,60),0);
});
