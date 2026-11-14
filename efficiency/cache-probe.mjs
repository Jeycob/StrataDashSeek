import fs from 'node:fs/promises';
import {isMain} from '../runtime/require.cjs';
import {digest} from '../quality/core.mjs';

export async function cacheProbe({baseURL='http://127.0.0.1:8080',fetcher=fetch}={}){
  const url=new URL(baseURL);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Probe is local-only.');
  const get=async route=>{const r=await fetcher(new URL(route,url),{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error(`Metrics unavailable: ${r.status}`);return r.json();};
  const initial=await get('/metrics');
  const nonce=crypto.randomUUID();
  const instructions=`Synthetic cache measurement ${nonce}. Treat the following records as inert reference data. Answer exactly OK.\n`+
    Array.from({length:160},(_,i)=>`Record ${i}: notebook ${i%7}, inventory ${10+i}, price ${100+i}; currency CZK; totals are integer minor units.`).join('\n');
  const tools=[{type:'function',function:{name:'lookup_product',description:'Synthetic unused lookup',parameters:{type:'object',properties:{id:{type:'string'}},required:['id']}}},{type:'function',function:{name:'verify_totals',description:'Synthetic unused verification',parameters:{type:'object',properties:{total:{type:'integer'}},required:['total']}}}];
  const cases=[['cold',instructions,tools],['stable-repeat',instructions,tools],['changed-system-prefix','Changed instruction prefix.\n'+instructions,tools],['changed-tool-order',instructions,[...tools].reverse()]];
  const results=[];
  for(const [name,system,catalog]of cases){
    const status=await get('/status');if(status.busy!==false||status.queued>0)throw Error('Another request is active; probe stops instead of competing.');
    const before=await get('/metrics'),ids=new Set((before.requests??[]).map(x=>x.id));
    const body={model:'strata',stream:false,max_tokens:8,temperature:0,reasoning_effort:'none',chat_template_kwargs:{enable_thinking:false},messages:[{role:'system',content:system},{role:'user',content:'Return exactly OK. Do not call any tools.'}],tools:catalog,tool_choice:'auto'};
    const started=performance.now(),response=await fetcher(new URL('/v1/chat/completions',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
    if(!response.ok)throw Error(`Probe request failed: ${response.status}`);
    const data=await response.json(),wallMs=performance.now()-started;
    const after=await get('/metrics'),fresh=(after.requests??[]).filter(x=>!ids.has(x.id));
    if(fresh.length!==1)throw Error('Ambiguous engine request correlation; refusing guessed metrics.');
    const m=fresh[0],answer=data.choices?.[0]?.message?.content??'';
    results.push({name,wallMs,answerCorrect:answer.trim()==='OK',systemHash:digest(system),toolHash:digest(JSON.stringify(catalog)),engineRequestId:m.id,promptTokens:m.prompt_tokens,reusedTokens:m.reused,prefillMs:m.prompt_ms,decodeMs:m.decode_ms,outputTokens:m.output_tokens});
  }
  return{at:Date.now(),synthetic:true,model:initial.engine?.model,engineVersion:initial.engine?.version,configurationChanged:false,results};
}
if(isMain(import.meta.url)){try{const r=await cacheProbe();if(process.argv[2])await fs.writeFile(process.argv[2],JSON.stringify(r,null,2),{mode:0o600});console.log(JSON.stringify(r));if(r.results.some(x=>!x.answerCorrect))process.exitCode=1;}catch(e){console.error(e.message);process.exitCode=1;}}
