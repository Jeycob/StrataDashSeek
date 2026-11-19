// Real pinned AgentLoop/SessionStore/native tool executor with an inert adapter.
// No sockets, provider requests, project files, subprocesses or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {apply} from './completion-guard.mjs';

const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const load=name=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib/index.js')).href);
const [{Context},{default:Sessions},{default:Agents},{default:Projections},{default:Llm,LlmAdapter},{default:SystemPrompt},{default:Tools},{default:AgentLoop},{NativeToolExecutor}]=await Promise.all(['cordis','dsh-session','dsh-agent','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent-loop','dsh-tool-executor-native'].map(load));
const probeProgress='WebGL2 funguje i v headless Chromium (SwiftShader) — můžu tedy ověřit render reálnými screenshoty. Teď napíšu samotnou hru.';
async function active(fibers){
  const deadline=Date.now()+2000;
  while(fibers.some(f=>f.state!==2)){
    await Promise.all(fibers.map(f=>f.await()));
    assert(Date.now()<deadline,'Actual SDK services must initialize');
    await new Promise(resolve=>setImmediate(resolve));
  }
}
for(const progress of [probeProgress,"WebGL2 works in headless Chromium. I'll now write the game."])test('real SDK continues the same turn after probe report: '+progress.slice(0,24),{timeout:10000},async t=>{
  const ctx=new Context(),events=[],requests=[];let tools=0;
  t.after(()=>ctx.fiber.dispose());
  await active([Sessions,Agents,Projections,Llm,SystemPrompt,Tools].map(plugin=>ctx.plugin(plugin,{})));
  await active([ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1})]);
  ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  ctx.tools.register({name:'fixture_probe',description:'Inert local completion fixture',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render:()=>[{type:'text',text:'The fixture tool succeeded.'}]},execute(){tools++;return{};}});
  class Inert extends LlmAdapter{
    async *stream(request){
      requests.push(request);
      const call=requests.length;
      assert(call<=4,'The fixture must not dispatch more than four inert responses');
      if(call===1||call===3)yield{type:'block-end',index:0,block:{type:'tool-call',id:'fixture-'+call,name:'fixture_probe',arguments:'{}'}};
      else{
        if(progress===probeProgress)yield{type:'reasoning-delta',index:0,text:'Synthetic reasoning from the inert adapter.'};
        yield{type:'text-delta',index:progress===probeProgress?1:0,text:call===2?progress:'Done. The fixture task is complete.'};
      }
      yield{type:'finish',reason:{kind:'stop'},replayState:{response:{stopReason:'stop'}}};
    }
  }
  ctx.llm.registerAdapter(['strata-vast'],new Inert());
  ctx.on('session/event',(session,event)=>{if(session.id==='completion-fixture')events.push(structuredClone(event));},{global:true});
  apply(ctx);
  const {agent}=await ctx.agents.create({sessionId:'completion-fixture',meta:{cwd:process.cwd()},agentOptions:{provider:'strata-vast',model:'inert-local-fixture'}});
  agent.followup({id:'original-human',role:'user',source:{kind:'user'},content:[{type:'text',text:'Finish the synthetic two-tool task after the initial probe.'}]});
  await agent.whenIdle();
  assert.equal(requests.length,4,JSON.stringify(events.filter(e=>e.type==='turn/end')));
  assert.equal(tools,2);
  assert.equal(events.filter(e=>e.type==='turn/start').length,1);
  const ended=events.filter(e=>e.type==='turn/end');
  assert.equal(ended.length,1);assert.equal(ended[0].data.reason.kind,'completed');
  const steering=events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='homeai-completion-guard');
  assert.equal(steering.length,1);
  assert(steering[0].seq>events.find(e=>e.type==='turn/start').seq&&steering[0].seq<ended[0].seq);
  assert.equal(events.filter(e=>e.type==='user/message'&&e.data.id==='original-human').length,1);
  assert.equal(events.filter(e=>e.type==='assistant/message').length,4);
  assert.deepEqual(events.filter(e=>e.type==='assistant/message')[1].data.message.content.map(block=>block.type),progress===probeProgress?['reasoning','text']:['text']);
  assert.equal(agent.status,'idle');
});
