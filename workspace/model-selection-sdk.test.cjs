'use strict';
// Real pinned SDK registry, AgentModel, Session events and projection replay.
// Adapters are local catalog fixtures; no account settings or inference calls.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url');
test('actual SDK routes session selections, replays durable events and preserves other sessions and registry defaults',async t=>{
 const cli=process.env.HARNESS_NATIVE_CLI??'/data/harness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',base=path.resolve(path.dirname(cli),'../..');
 const load=name=>import(pathToFileURL(path.join(base,name,'lib/index.js')).href);
 const [{Context},L,{Session},{AgentModel,modelSelectionProjectionDefinition:projection},{createModelSelection,installModelSelection},{WorkspaceManager}]=await Promise.all([load('cordis'),load('dsh-llm'),load('dsh-session'),load('dsh-agent'),import('./model-selection.mjs'),import('./manager.mjs')]);
 const ctx=new Context(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'model-sdk-')),agents=new Map(),routes=[];
 t.after(async()=>{await ctx.fiber.dispose();await fs.rm(directory,{recursive:true,force:true});});new L.default(ctx);
 class Adapter extends L.LlmAdapter{
  listModels(provider){return Promise.resolve([{provider,id:provider==='strata-vast'?'strata':'cloud/model+preview',name:'Catalog model'}]);}
  resolveModel(provider,id){return Promise.resolve({provider,id,name:id,reasoning:{efforts:[{id:'off',name:'Off'},{id:provider==='strata-vast'?'medium':'max',name:'Provider effort'}],defaultEffort:provider==='strata-vast'?'medium':'max'}});}
  async *stream(){throw Error('No inference is permitted in this fixture');}
 }
 const local=ctx.llm.registerAdapter(['strata-vast'],new Adapter()),cloud=ctx.llm.registerAdapter(['cloud'],new Adapter());
 ctx.provide('agents',{get:id=>agents.get(id)});ctx.provide('connection',{fetch:{register:entry=>{routes.push(entry);return()=>{};}}});
 function agent(id,seed=[]){
  const session=new Session(id,seed.length?seed:undefined),events=[...seed];let folded=seed.reduce(projection.apply,projection.init());
  const append=session.append.bind(session);session.append=(...args)=>{const event=append(...args);events.push(event);folded=projection.apply(folded,event);ctx.emit('session/event',session,event);return event;};
  const value={id,session,events,model:new AgentModel(()=>folded,session,{provider:'strata-vast',model:'strata'})};agents.set(id,value);return value;
 }
 const a=agent('one'),b=agent('two'),workspace={id:'workspace',sessionIds:['one','two']};
 ctx.provide('workspaceRegistry',{get:()=>workspace,list:()=>[workspace]});
 const manager=new WorkspaceManager(ctx,{stateRoot:directory});manager.data={workspaces:{},modelPreferences:{}};
 manager.projectFor=async id=>{const value=agents.get(id);if(!value)throw Error('SESSION_NOT_FOUND');return{header:value.session.header,live:value.session};};
 const models=installModelSelection(ctx,manager,{lifecycle:false}),endpoint=routes.find(row=>row.path==='/api/workbench/models');assert(endpoint);
 async function post(sessionId,selection){return endpoint.fetch(new Request('http://dsh.internal/api/workbench/models',{method:'POST',headers:{host:'native.fixture',origin:'https://native.fixture','content-type':'application/json'},body:JSON.stringify({sessionId,selection})}));}
 const route={provider:'cloud',model:'cloud/model+preview',reasoningEffort:'max'},response=await post('one',route);assert.equal(response.status,200,await response.clone().text());assert.deepEqual(a.model.current(),route);assert.deepEqual(b.model.current(),{provider:'strata-vast',model:'strata'});assert.equal(a.events.at(-1).type,'model/selection');
 assert.deepEqual(await ctx.llm.resolveCallConfig(a.model.current()),route);assert.deepEqual(ctx.llm.listProviders().map(row=>row.id),['strata-vast','cloud']);
 const persisted=JSON.parse(await fs.readFile(manager.file,'utf8'));assert.deepEqual(persisted.modelPreferences.one.selection,route);assert.equal(persisted.modelPreferences.two,undefined);
 const eventFile=path.join(directory,'session-events.json');await fs.writeFile(eventFile,JSON.stringify(a.events));
 const restored=agent('one',JSON.parse(await fs.readFile(eventFile,'utf8'))),reloaded=new WorkspaceManager(ctx,{stateRoot:directory});reloaded.data=persisted;reloaded.projectFor=manager.projectFor;
 const recovered=createModelSelection(ctx,reloaded);await recovered.restoreAfterDefaults(restored,'startup',(value,source)=>reloaded.applyDefaults(value,source));assert.deepEqual(restored.model.current(),route);assert.equal(restored.events.filter(event=>event.type==='model/selection').length,1,'SDK avoids duplicate durable model selections after restore');
 await reloaded.updateSettings('workspace',{provider:'cloud',model:'cloud/model+preview'});await recovered.select('one',null);assert.deepEqual(restored.model.current(),{provider:'cloud',model:'cloud/model+preview'});assert.deepEqual(await ctx.llm.resolveCallConfig(restored.model.current()),route,'omitted effort follows the real provider default');
 assert.deepEqual(b.model.current(),{provider:'strata-vast',model:'strata'});assert.deepEqual((await ctx.llm.listModels('strata-vast')).map(row=>row.id),['strata']);
 await assert.rejects(recovered.select('two',{provider:'cloud',model:'Display label only'}),{code:'MODEL_UNAVAILABLE'});assert.equal((await post('two',{provider:'cloud',model:'cloud/model+preview',reasoningEffort:'medium'})).status,409);
 // Existing native model menu remains authoritative over an older preference.
 restored.model.select({provider:'strata-vast',model:'strata'});models.observe(restored.session,restored.events.at(-1));
 cloud();local();
});
test('actual sibling-fiber sessionController access requires the declared workspace injection for a cold conversation',async t=>{
 const base=path.resolve(path.dirname(process.env.HARNESS_NATIVE_CLI??'/data/harness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),'../..');
 const [{Context},{createModelSelection},{inject}]=await Promise.all([import(pathToFileURL(path.join(base,'cordis/lib/index.js')).href),import('./model-selection.mjs'),import('./plugin.mjs')]);
 assert(inject.includes('sessionController'));
 for(const includeController of [false,true]){
  const root=new Context(),agents=new Map(),resolved=[],selection={provider:'cloud',model:'cloud-model'};let selected,models;
  t.after(()=>root.fiber.dispose());
  const cold={id:'cold',session:{id:'cold',header:{}},model:{current:()=>selected,select:value=>{selected=value;}}};
  root.provide('agents',{get:id=>agents.get(id)});root.provide('llm',{listProviders:()=>[{id:'cloud'}],listModels:async()=>[{id:'cloud-model'}],resolveModelInfo:async()=>({}),resolveCallConfig:async value=>value});
  await root.plugin({name:'controller-owner',apply(owner){owner.provide('sessionController',{async resolveAgent(id){resolved.push(id);agents.set(id,cold);return{agent:cold};}});}}).await();
  const manager={data:{modelPreferences:{}},projectFor:async()=>({header:cold.session.header}),settings:()=>selection,inOrder:fn=>fn(),save:async()=>{}};
  await root.plugin({name:'model-route-consumer',inject:inject.filter(key=>['agents','llm',...(includeController?['sessionController']:[])].includes(key)),apply(scoped){models=createModelSelection(scoped,manager);}}).await();
  if(includeController){await models.select('cold',selection);assert.deepEqual(resolved,['cold']);assert.deepEqual(selected,selection);}
  else{await assert.rejects(models.select('cold',selection),/cannot get property "sessionController" without inject/);assert.deepEqual(resolved,[]);assert.equal(selected,undefined);}
 }
});
