import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import contract from '../vast/native-isolated-profile.cjs';
import {executionBindingFixture} from '../workspace/fixtures/execution-binding.mjs';
import {bootIsolatedSnapshot,createAppLifecycle,readProtectedSnapshot} from '../vast/native-isolated-start.mjs';
const {canonical}=createRequire(import.meta.url)('../vast/project-execution-mode.cjs');
const {ROOT,SNAPSHOT,REVIEWED,MAX_BYTES,projectNativeReaders,loadReviewedComposition,nativeRuntimePatch,prepareNativeIsolatedLaunch,validateSnapshot,boundedRead}=contract;
const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules',load=(name,file='index.js')=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib',file)));
const [bootApi,{Context},{default:SystemPrompt},{default:Tools},{NativeToolExecutor},{LocalFileSystem},{default:Skills},{Session},{createScope,scopeTarget}]=await Promise.all([load('dsh-app-boot'),load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-tool-executor-native'),load('dsh-fs-local'),load('dsh-skill'),load('dsh-session'),load('dsh-scope')]);
const manifest={dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}},hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function composition(source=executionBindingFixture('isolated-guest'),options={}){return loadReviewedComposition({sdkRoot:SDK,binding:source.binding,manifest,...options});}
async function temp(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-native-reader-'));t.after(async()=>{const real=await fs.realpath(root);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('homeai-native-reader-'));await fs.rm(real,{recursive:true,force:true});});return root;}
function rows(entries,name){const found=[];function visit(list){for(const row of list){if(row.name===name)found.push(row);if(row.name==='@deepseek-ai/dsh-agent-preset')visit(row.config.plugins);else if(row.group)visit(row.config);}}visit(entries);return found;}
function snapshot(binding,entries){return{version:1,projection:binding.snapshot,entries,entriesSha256:hash(canonical(entries))};}
function expectedNativePlugins(root,sourceCommit){
 const release=new URL('file://'+path.posix.join(root,'releases',sourceCommit)+'/');
 return [
  {id:'root-runtime-admission',name:new URL('workspace/runtime-admission-plugin.mjs',release).href},
  {id:'homeai-output-continuation',name:new URL('runtime/output-continuation/index.mjs',release).href},
 ];
}

test('pinned real SDK complete presets are projected before mounting, without changing native executors or unrelated configuration',async()=>{
 const source=executionBindingFixture('isolated-guest'),result=await composition(source);assert.deepEqual(result.counts,{instructions:4,skillProviders:4,skillConsumers:4,presets:4});
 for(const row of rows(result.entries,'@deepseek-ai/dsh-agent-instructions'))assert.deepEqual(row.config,{maxBytes:0});
 for(const row of rows(result.entries,'@deepseek-ai/dsh-skill-filesystem'))assert.deepEqual(row.config,{includeDefaultRoots:false,customSkillDirs:[],watch:false,watchFollowSymlinks:false});
 for(const row of rows(result.entries,'@deepseek-ai/dsh-tool-skill'))assert.equal(row.disabled,true);
 assert.equal(rows(result.entries,'@deepseek-ai/dsh-hmr')[0].disabled,true);
 assert(rows(result.entries,'@deepseek-ai/dsh-tool-executor-native').length>=1);assert(rows(result.entries,'@deepseek-ai/dsh-tool-executor-ptc').length>=1);
 const stock=bootApi.composeEntries(Object.keys(REVIEWED).filter(file=>file.endsWith('.yml')).map(file=>bootApi.loadOverlayPatches('fixture',path.join(SDK,'@deepseek-ai',file))));
 for(const name of ['@deepseek-ai/dsh-tool-executor-native','@deepseek-ai/dsh-tool-executor-ptc','@deepseek-ai/dsh-working-directory','@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-jsonl','@deepseek-ai/dsh-persona'])assert.deepEqual(rows(result.entries,name),rows(stock,name));
 assert.equal(validateSnapshot(snapshot(source.binding,result.entries),source.binding).entries,result.entries);
});
test('unknown bundles, plugins, reader identity, omitted preset children, expressions and duplicate entries fail closed',async()=>{
 await assert.rejects(composition(undefined,{manifest:{dsh:{profile:{bundles:['unknown']}}}}),{code:'NATIVE_PROFILE_BUNDLES_UNREVIEWED'});
 const base=(await composition()).entries;
 for(const change of [v=>v.push({id:'new-reader',name:'@example/unknown-reader'}),v=>v.push(structuredClone(v[0])),v=>v.find(row=>row.id==='preset-standard').config.plugins.pop(),v=>v.find(row=>row.id==='preset-standard').config.plugins.find(row=>row.id==='agent-instructions').name='@example/changed-reader',v=>v.find(row=>row.id==='hmr').disabled={__jsExpr:'readUnexpectedProjectFile()'},v=>v.splice(v.findIndex(row=>row.id==='preset-minimal'),1)]){
  const value=structuredClone(base);change(value);assert.throws(()=>projectNativeReaders({baselineEntries:base,entries:value,binding:executionBindingFixture('isolated-guest').binding}),/NATIVE_PROFILE_/);
 }
 await assert.rejects(composition(undefined,{profileText:'- id: unknown-missing-row\n  disabled: true\n'}),{code:'NATIVE_PROFILE_PATCH_UNRESOLVED'});
 await assert.rejects(composition(undefined,{read:()=>''}),{code:'NATIVE_PROFILE_SDK_UNREVIEWED'});
});
test('only the reviewed subprocess replacement retains its original identity and release path',async()=>{
 const source=executionBindingFixture('isolated-guest'),prefix='- id: subprocess\n  disabled: true\n- insert:\n    - id: cloud-owned-range-subprocess\n      name: ',profileText=prefix+'file:///data/harness/app/workspace/owned-range-subprocess.mjs\n',projected=await composition(source,{profileText});
 const found=projected.entries.filter(row=>row.id==='cloud-owned-range-subprocess');assert.equal(found.length,1);assert.equal(found[0].name,'file:///data/harness/releases/'+source.binding.snapshot.sourceCommit+'/workspace/owned-range-subprocess.mjs');assert.equal(projected.entries.find(row=>row.id==='subprocess').disabled,true);
 for(const name of ['file:///unreviewed/provider.mjs','@example/subprocess'])await assert.rejects(composition(source,{profileText:prefix+JSON.stringify(name)+'\n'}),{code:'NATIVE_PROFILE_COMPOSITION_UNREVIEWED'});
 await assert.rejects(composition(source,{profileText:'- insert:\n    - id: cloud-owned-range-subprocess\n      name: file:///data/harness/app/workspace/owned-range-subprocess.mjs\n'}),{code:'NATIVE_PROFILE_COMPOSITION_UNREVIEWED'});
});
test('snapshot binds mode, stable policy, source and launch identity and rejects changed contents',async()=>{
 const source=executionBindingFixture('isolated-guest'),entries=(await composition(source)).entries,value=snapshot(source.binding,entries);
 for(const patch of [{sourceCommit:'c'.repeat(40)},{launchId:crypto.randomUUID()},{policyEpoch:crypto.randomUUID()},{mode:'host-compat'}]){const changed=executionBindingFixture('isolated-guest');assert.throws(()=>validateSnapshot(value,changed.binding),/NATIVE_PROFILE_/);source.change(patch);assert.throws(()=>validateSnapshot(value,source.binding),/NATIVE_PROFILE_|PROJECT_EXECUTION_/);}
 const fresh=executionBindingFixture('isolated-guest'),valid=snapshot(fresh.binding,entries);valid.entries[0].disabled=false;assert.throws(()=>validateSnapshot(valid,fresh.binding),{code:'NATIVE_PROFILE_SNAPSHOT_INVALID'});
 assert.throws(()=>projectNativeReaders({baselineEntries:entries,entries,binding:executionBindingFixture('host-compat').binding}),{code:'NATIVE_PROFILE_ISOLATED_REQUIRED'});
});
test('private publication is bounded, group-readable only and checked across reads and writes; no filesystem publication in this fixture',async()=>{
 const source=executionBindingFixture('isolated-guest'),writes=[],files=new Map([[ROOT+'/home/.dsh/profiles/web/package.json',JSON.stringify(manifest)],[ROOT+'/home/.dsh/profiles/web/cordis.patch.yml','[]']]);
 const read=(file,options={})=>files.has(file)?files.get(file):file.startsWith(path.normalize(SDK))?boundedRead(file):options.optional?undefined:assert.fail('Unexpected fixture read '+file);
 const runtime={ensureDirectory(...args){assert.deepEqual(args,[ROOT+'/runtime-config',0o2750,1234]);},atomic(file,bytes,mode){writes.push({file,bytes,mode});files.set(file,bytes);}};
 const result=await prepareNativeIsolatedLaunch({binding:source.binding,gid:1234,sdkRoot:SDK,read,runtime});assert.equal(result.script,ROOT+'/releases/'+source.binding.snapshot.sourceCommit+'/vast/native-isolated-start.mjs');assert.deepEqual(result.args,[]);assert.equal(writes.length,1);assert.equal(writes[0].file,SNAPSHOT);assert.equal(writes[0].mode,0o640);assert(Buffer.byteLength(writes[0].bytes)<MAX_BYTES);
 const publishedSnapshot=JSON.parse(writes[0].bytes),expected=expectedNativePlugins(ROOT,source.binding.snapshot.sourceCommit);
 assert.deepEqual(publishedSnapshot.projection,source.binding.snapshot);
 for(const plugin of expected)assert.deepEqual(publishedSnapshot.entries.filter(row=>row.id===plugin.id),[plugin]);
 const revoked=executionBindingFixture('isolated-guest');let published=0;await assert.rejects(prepareNativeIsolatedLaunch({binding:revoked.binding,gid:1234,sdkRoot:SDK,read(file,options){const value=read(file,options);if(file.replaceAll('\\','/').endsWith('/dsh-app-boot/lib/index.js'))revoked.fail();return value;},runtime:{...runtime,atomic(){published++;}}}),/BINDING_CHANGED/);assert.equal(published,0);
 const changed=executionBindingFixture('isolated-guest');await assert.rejects(prepareNativeIsolatedLaunch({binding:changed.binding,gid:1234,sdkRoot:SDK,read,runtime:{...runtime,atomic(...args){runtime.atomic(...args);changed.fail();}}}),/BINDING_CHANGED/);
});
test('the unprivileged fixed-path snapshot reader rejects unsafe control parents, aliases, ownership and mutation',()=>{
 const source=executionBindingFixture('isolated-guest'),value=snapshot(source.binding,[]),changes=new Map();let reads=0;
 const directory={uid:0,mode:0o2750,nlink:1,isDirectory:()=>true,isFile:()=>false,isSymbolicLink:()=>false},file={...directory,mode:0o640,isDirectory:()=>false,isFile:()=>true},filesystem={lstatSync(target){return{...(target===SNAPSHOT?file:directory),...changes.get(target)};},realpathSync:target=>changes.get(target)?.realpath??target},read=()=>{reads++;return canonical(value);};
 assert.equal(readProtectedSnapshot(source.binding,{filesystem,read}).entriesSha256,value.entriesSha256);assert.equal(reads,1);
 for(const [target,change]of [[SNAPSHOT,{uid:1234}],[SNAPSHOT,{mode:0o660}],[SNAPSHOT,{nlink:2}],[SNAPSHOT,{isSymbolicLink:()=>true}],[ROOT+'/runtime-config',{mode:0o2770}],[ROOT+'/runtime-config',{realpath:'/untrusted'}]]){changes.set(target,change);assert.throws(()=>readProtectedSnapshot(source.binding,{filesystem,read}),{code:'NATIVE_PROFILE_SNAPSHOT_UNSAFE'});changes.clear();}
 assert.equal(reads,1);assert.throws(()=>readProtectedSnapshot(source.binding,{filesystem,read(){source.fail();return canonical(value);}}),/BINDING_CHANGED/);
});
test('bounded input reader refuses oversized and non-file inputs without reading project content',async t=>{
 const directory=await temp(t),file=path.join(directory,'public.txt');await fs.writeFile(file,'public');assert.equal(boundedRead(file),'public');assert.equal(boundedRead(path.join(directory,'absent'),{optional:true}),undefined);assert.throws(()=>boundedRead(directory),{code:'NATIVE_PROFILE_INPUT_UNSAFE'});await fs.truncate(file,MAX_BYTES+1);assert.throws(()=>boundedRead(file),{code:'NATIVE_PROFILE_INPUT_UNSAFE'});
});

async function automaticFixture(t,{mode='isolated',project,readerRows}){
 const state={ensures:0,reads:[],resolved:false,executed:0},source=executionBindingFixture('isolated-guest'),id=crypto.randomUUID(),session=new Session(id,undefined,{version:4,id,createdAt:1,isSeeded:false,cwd:project}),agent={id:session.id,session,status:'idle',inbox:{nextStep:[],remove(){},prepend(){},replace(){}}};let ctx,scope;
 const entries=readerRows.map((row,index)=>({...row,id:'reader-'+index})),life=createAppLifecycle({dispose:()=>ctx?.fiber.dispose(),complete(){},forceExit(){assert.fail('Unexpected fixture forced shutdown');}});
 const setup=host=>{
  new SystemPrompt(host,{});new Tools(host);new Skills(host,{});new LocalFileSystem(host,{cwd:project,diffBasisMaxBytes:10*1024*1024});scope=createScope(host,agent);agent.ctx=scope.ctx;
  host.provide('agents',{turnBoundaryOf:()=>({openTurnStartSeq:null,lastStepBoundary:null})});host.provide('workingDirectory',{ensure:async()=>{state.ensures++;return project;},get:()=>project});
  const actual=host.fs[Symbol.for('cordis.original')]??host.fs;for(const method of ['readText','streamText','readBytes']){const original=actual[method].bind(actual);actual[method]=async(target,...rest)=>{state.reads.push({method,path:target.targetKey});return original(target,...rest);};}
  host.tools.setExecutor(new NativeToolExecutor(host));host.tools.register({name:'fixture_only',description:'inert proof',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute(){state.executed++;return{};}},{when(){state.resolved=true;return true;}});
 };
 ctx=await bootIsolatedSnapshot({binding:source.binding,snapshot:snapshot(source.binding,entries),args:[],configurationPath:fileURLToPath(new URL('../vast/native-isolated-root.json',import.meta.url)),bareModuleBaseUrl:pathToFileURL(path.join(SDK,'@deepseek-ai/dsh/package.json')).href,profileContext:{name:'web',home:'/synthetic-home',dir:'/synthetic-profile'},environment:{},lifecycle:life,api:{...bootApi,environmentKey:'fixture-environment',prepareHost:setup,providePackages:async()=>{},provideCmdline(){}}});
 assert.equal(state.resolved,false);assert.equal(state.reads.length,0);assert.equal(state.executed,0);
 t.after(async()=>{await scope.dispose();await ctx.fiber.dispose();});
 async function propose(text='A public synthetic fixture prompt'){
  const signal=new AbortController().signal,messages=[{id:crypto.randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text}]}];
  const toolSet=await ctx.tools.resolve({agent,modelSelection:{provider:'fixture',model:'fixture'},signal});assert.equal(state.resolved,true);assert.equal(state.executed,0);assert.equal(state.reads.length,0);
  try{const assembly=await ctx.systemPrompt.assemble({agent,modelSelection:{provider:'fixture',model:'fixture'},signal,toolSet});const decision=await ctx.waterfall(scopeTarget(agent),'agent/pre-step',{agent,messages,turn:1,step:1,signal},()=>({kind:'enter',messages}));return{assembly,decision};}finally{toolSet.dispose();}
 }
 return{ctx,agent,state,propose,source};
}
for(const link of ['none','file','directory'])test('actual SDK before-tools instruction and skill discovery: '+({none:'normal project files',file:'external file symlinks',directory:'external skill directory link'})[link]+' are absent isolated and retained host',async t=>{
 const directory=await temp(t),project=path.join(directory,'project'),outside=path.join(directory,'public-external'),skill=path.join(project,'.agents/skills/public-sentinel');await fs.mkdir(skill,{recursive:true});await fs.mkdir(outside,{recursive:true});await fs.mkdir(path.join(project,'.git'));
 const marker='PUBLIC_AGENTS_SENTINEL_'+crypto.randomUUID(),skillMarker='PUBLIC_SKILL_SENTINEL_'+crypto.randomUUID(),instruction=path.join(outside,'PUBLIC_AGENTS.md'),skillFile=path.join(outside,'PUBLIC_SKILL.md');await fs.writeFile(instruction,marker);await fs.writeFile(skillFile,'---\nname: public-sentinel\ndescription: '+skillMarker+'\n---\n'+skillMarker+'\n');
 if(link==='file'){try{await fs.symlink(instruction,path.join(project,'AGENTS.md'),'file');await fs.symlink(skillFile,path.join(skill,'SKILL.md'),'file');}catch(error){if(process.platform==='win32'&&['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Windows file symlink privilege unavailable; Linux CI must run the same external-sentinel case');return;}throw error;}}
 else{await fs.copyFile(instruction,path.join(project,'AGENTS.md'));if(link==='directory'){await fs.rmdir(skill);await fs.copyFile(skillFile,path.join(outside,'SKILL.md'));await fs.symlink(outside,skill,process.platform==='win32'?'junction':'dir');}else await fs.copyFile(skillFile,path.join(skill,'SKILL.md'));}
 const projected=await composition(),isolatedReaders=['@deepseek-ai/dsh-agent-instructions','@deepseek-ai/dsh-skill-filesystem','@deepseek-ai/dsh-tool-skill'].map(name=>rows(projected.entries,name).find(row=>row.disabled!==true)??rows(projected.entries,name)[0]);
 const hostReaders=[{name:'@deepseek-ai/dsh-agent-instructions',config:{maxBytes:65536,dshHome:path.join(directory,'dsh-home'),agentsHome:path.join(directory,'agents-home')}},{name:'@deepseek-ai/dsh-skill-filesystem',config:{watch:false,dshHome:path.join(directory,'dsh-home'),agentsHome:path.join(directory,'agents-home')}},{name:'@deepseek-ai/dsh-tool-skill'}];
 const isolated=await automaticFixture(t,{project,readerRows:isolatedReaders}),safe=await isolated.propose('Use $public-sentinel');assert(!JSON.stringify(safe).includes(marker));assert(!JSON.stringify(safe).includes(skillMarker));assert.equal(isolated.state.reads.length,0);assert.equal(isolated.state.ensures,0);assert.equal(isolated.state.executed,0);assert.deepEqual((await isolated.ctx.skills.snapshot({cwd:project,scope:isolated.agent,signal:new AbortController().signal})).skills,[]);assert.equal(isolated.state.reads.length,0);
 const host=await automaticFixture(t,{mode:'host',project,readerRows:hostReaders}),ordinary=await host.propose('Use $public-sentinel');assert(JSON.stringify(ordinary).includes(marker),'host instructions still load');assert(JSON.stringify(ordinary).includes(skillMarker),'host automatic skill catalog/body still load');assert(host.state.reads.length>0);assert(host.state.ensures>0);assert.equal(host.state.executed,0);
});
test('public SDK boot prepare finishes before the first native executor tool set; binding changes after awaited host setup prevent mount',async t=>{
 const directory=await temp(t),config=path.join(directory,'empty.json');await fs.writeFile(config,'[]');const source=executionBindingFixture('isolated-guest'),order=[],events=[];let mounted=false,ctx;
 const pkg=path.join(directory,'synthetic-plugin.mjs');await fs.writeFile(pkg,'export function apply(ctx){ctx.get("fixture").mounted();}\n');const entries=[{id:'synthetic',name:pathToFileURL(pkg).href}],life=createAppLifecycle({dispose:()=>ctx?.fiber.dispose(),complete:()=>{},forceExit:()=>assert.fail('no forced exit')});
 ctx=await bootIsolatedSnapshot({binding:source.binding,snapshot:snapshot(source.binding,entries),args:['--no-open','--host','127.0.0.1','--port','3090'],configurationPath:config,bareModuleBaseUrl:pathToFileURL(path.join(SDK,'@deepseek-ai/dsh/package.json')).href,profileContext:{name:'web',home:'/fixture-home',dir:'/fixture-profile'},environment:{public:'fixture'},lifecycle:life,api:{...bootApi,environmentKey:'fixture-environment',prepareHost(host){host.provide('fixture',{mounted(){mounted=true;order.push('mount');assert.equal(host.get('cmdlineArgs').join(' '),'--no-open --host 127.0.0.1 --port 3090');}});},async providePackages(){order.push('packages-start');await Promise.resolve();order.push('packages-done');},provideCmdline(host,options){order.push('cmdline');host.provide('cmdlineArgs',options.args);options.ready.onReady(()=>events.push('ready'));}}});t.after(()=>ctx.fiber.dispose());assert(mounted);assert.deepEqual(order,['packages-start','packages-done','cmdline','mount']);assert.deepEqual(events,['ready']);
 const changed=executionBindingFixture('isolated-guest');let reached=false;await assert.rejects(bootIsolatedSnapshot({binding:changed.binding,snapshot:snapshot(changed.binding,entries),args:[],configurationPath:config,lifecycle:life,api:{...bootApi,environmentKey:'fixture-environment',async providePackages(){changed.fail();},provideCmdline(){reached=true;}}}),/host preparation failed|BINDING_CHANGED/);assert.equal(reached,false);
});
test('readiness and shutdown coalesce, wait for quiescence and force on repeated signals',async()=>{
 let release,disposes=0;const pending=new Promise(resolve=>{release=resolve;}),effects=[],life=createAppLifecycle({dispose(){disposes++;return pending;},complete:code=>effects.push(['complete',code]),forceExit:code=>effects.push(['force',code])});let ready=0;life.ready.onReady(()=>ready++);life.commit();life.commit();assert.equal(ready,1);const one=life.shutdown(0),two=life.shutdown(0);assert.equal(one,two);await Promise.resolve();assert.equal(disposes,1);assert.deepEqual(effects,[]);release();await one;assert.deepEqual(effects,[['complete',0]]);
 const stopped=createAppLifecycle({dispose:()=>new Promise(()=>{}),forceExit:code=>effects.push(['force',code]),setTimer:()=>123,clearTimer(){}});stopped.interrupt(130);stopped.interrupt(130);assert.deepEqual(effects.at(-1),['force',130]);let late=0;stopped.ready.onReady(()=>late++);stopped.commit();assert.equal(late,0);
});
test('the shared Native patch registers both plugins from the selected release and the supervisor passes it to the stock CLI',async()=>{
 const sourceCommit=executionBindingFixture('isolated-guest').binding.snapshot.sourceCommit;
 assert.deepEqual(bootApi.composeEntries([nativeRuntimePatch(sourceCommit)]),expectedNativePlugins(ROOT,sourceCommit));
 const alternateRoot='/fixture/harness',alternateCommit='c'.repeat(40);
 assert.deepEqual(bootApi.composeEntries([nativeRuntimePatch(alternateCommit,alternateRoot)]),expectedNativePlugins(alternateRoot,alternateCommit));
 const text=await fs.readFile(new URL('../vast/supervisor.cjs',import.meta.url),'utf8');
 assert.match(text,/runtime\.atomic\(\s*admissionPatch,\s*require\('\.\/native-isolated-profile\.cjs'\)\.nativeRuntimePatch\(\s*sourceStatus\.appliedCommit\s*,\s*R\s*\)\s*,\s*0o644\s*\)/u);
 assert(text.includes("projectExecution.mode==='host-compat'?{script:R+'/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',args:['web','--patch',admissionPatch]}"));
 const launch=text.indexOf('const nativeLaunch='),services=text.indexOf("launch('strata'");
 assert(launch>=0&&services>launch,'Native launch is prepared before starting services');
 assert(text.includes("'--no-open','--host','127.0.0.1','--port','3090','--public-url','https://'+cfg.publicHost+'/','--trusted-host',cfg.publicHost"));
});
