// Owned child of native-isolated-web.test.mjs. No production policy/path use.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {executionBindingFixture} from '../../workspace/fixtures/execution-binding.mjs';
import {bootIsolatedSnapshot,createAppLifecycle} from '../../vast/native-isolated-start.mjs';
import profile from '../../vast/native-isolated-profile.cjs';
const require=createRequire(import.meta.url),{canonical}=require('../../vast/project-execution-mode.cjs');
const directory=await fs.realpath(process.argv[2]),SDK=process.env.EFFICIENCY_SDK_ROOT;
if(process.platform!=='linux'||!path.basename(directory).startsWith('homeai-isolated-web-')||!SDK)throw Error('EXPLICIT_LINUX_FIXTURE_REQUIRED');
const load=(name,file='index.js')=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib',file)));
const [bootApi,cmdline,envApi,httpProxy,{installTrustedRuntimeAdmission}]=await Promise.all([load('dsh-app-boot'),load('dsh-cmdline'),load('dsh-launch-environment'),load('dsh-http-proxy'),import('../../workspace/runtime-admission-plugin.mjs')]);
const source=executionBindingFixture('isolated-guest'),binding=source.binding,state={ready:false,modelStreams:0,fsObservations:[],admissions:[]},home=process.env.DSH_HOME,project=path.join(directory,'projects/owner'),sessionId='fixture-'+crypto.randomUUID();
await fs.mkdir(path.join(directory,'workbench'),{recursive:true});await fs.writeFile(path.join(directory,'workbench/registry.json'),JSON.stringify({version:1,installedAt:0,workspaces:{},sessions:{[sessionId]:{root:project,independentRepository:true,legacy:false,nativeWorktree:false,checkpoints:{},ports:[22000,22001,22002,22003],databasePath:path.join(project,'fixture.sqlite')}},trash:{}}));
const installedHome=path.join(home,'profiles/web');await fs.mkdir(installedHome,{recursive:true});
const manifest={name:'synthetic-web-fixture',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}};await fs.writeFile(path.join(installedHome,'package.json'),JSON.stringify(manifest));
const rootWrapper=path.join(directory,'root-provider.mjs'),workspaceWrapper=path.join(directory,'workspace-provider.mjs');
await fs.writeFile(rootWrapper,`import {installTrustedRuntimeAdmission} from ${JSON.stringify(new URL('../../workspace/runtime-admission-plugin.mjs',import.meta.url).href)};\nexport const inject=['agents','tools','connection'];export function apply(ctx){ctx.get('fixtureHost').root(ctx,installTrustedRuntimeAdmission);}\n`);
await fs.writeFile(workspaceWrapper,`import {applyTrustedWorkspace,inject} from ${JSON.stringify(new URL('../../workspace/plugin.mjs',import.meta.url).href)};import {createConversationTools,loadReviewedConversationConsumers} from ${JSON.stringify(new URL('../../workspace/conversation-tools.mjs',import.meta.url).href)};export {inject};export function apply(ctx,config){return applyTrustedWorkspace(ctx,config,{conversationTools:(owner,binding)=>createConversationTools(owner,binding,{loadConsumers:()=>loadReviewedConversationConsumers(${JSON.stringify(SDK)})})});}\n`);
const release='/data/harness/releases/'+binding.snapshot.sourceCommit,configuration=[
 {id:'session-title-llm',disabled:true},
 {insert:[{id:'cloud-native-worktrees',name:'@deepseek-ai/dsh-experimental-worktree',config:{retainOnArchive:true}},{id:'cloud-workspace-runtime',name:'file://'+release+'/workspace/plugin.mjs',config:{stateRoot:path.join(directory,'workbench'),projectsRoot:path.join(directory,'projects'),appsConfigFile:path.join(directory,'missing-apps.json'),appsWorkspaceRoot:directory,environmentReport:path.join(directory,'environment.json'),updateReport:path.join(directory,'update.json')}}]}
];
const projected=await profile.loadReviewedComposition({sdkRoot:SDK,binding,manifest,profileText:JSON.stringify(configuration),admission:[{insert:[{id:'root-runtime-admission',name:'file://'+release+'/workspace/runtime-admission-plugin.mjs'}]}],telemetryDisabledEnv:'fixture'});
for(const row of projected.entries){if(row.id==='root-runtime-admission')row.name=pathToFileURL(rootWrapper).href;if(row.id==='cloud-workspace-runtime')row.name=pathToFileURL(workspaceWrapper).href;}
const snapshot={version:1,projection:binding.snapshot,entries:projected.entries,entriesSha256:crypto.createHash('sha256').update(canonical(projected.entries)).digest('hex')};await fs.writeFile(path.join(directory,'snapshot.json'),canonical(snapshot),{mode:0o600});
const environment=bootApi.loadLayeredEnv('dsh'),disposeProxy=await httpProxy.installProxyFromEnvironment(environment,()=>{});let app,agentHandle,disposal;
const dispose=()=>disposal??=(async()=>{await agentHandle?.dispose();try{await app?.fiber.dispose();}finally{await disposeProxy();}})();
const lifecycle=createAppLifecycle({dispose,complete:code=>{process.exitCode=code;process.disconnect?.();}});lifecycle.ready.onReady(()=>{state.ready=true;});
for(const [signal,code]of [['SIGTERM',0],['SIGINT',130]])process.on(signal,()=>lifecycle.interrupt(code));
bootApi.installFailLoud('isolated-web-fixture',process,dispose);
const installAnchor=path.join(SDK,'@deepseek-ai/dsh/package.json'),resolvedProfile={name:'web',dir:installedHome,patchPath:path.join(installedHome,'cordis.patch.yml'),layers:[],patches:[],skippedBundles:[]},resolution=await bootApi.createRuntimeResolution({installAnchor,profile:resolvedProfile,home});
const client={required:true,async admit(operation,{signal}={}){signal?.throwIfAborted();state.admissions.push(operation);return{enforced:true,admitted:true,expiresAt:Date.now()+3000};}};
try{
 app=await bootIsolatedSnapshot({binding,snapshot,args:['--no-open','--host','127.0.0.1','--port','0'],configurationPath:fileURLToPath(new URL('../../vast/native-isolated-root.json',import.meta.url)),bareModuleBaseUrl:pathToFileURL(installAnchor).href,profileContext:{name:'web',dir:installedHome,patchPath:resolvedProfile.patchPath,installAnchor,startedBundles:manifest.dsh.profile.bundles,cwd:directory,home,overlays:[],telemetryDisabledEnv:'fixture'},environment,lifecycle,api:{...bootApi,environmentKey:envApi.DSH_LAUNCH_ENVIRONMENT_KEY,provideCmdline:cmdline.provideCmdline,prepareHost(host){app=host;host.provide('fixtureHost',{root:ctx=>installTrustedRuntimeAdmission(ctx,binding,client)});host.on('llm/stream',()=>{state.modelStreams++;throw Error('FIXTURE_FORBIDS_MODEL_STREAMS');},{prepend:true,global:true});host.on('fs/observed',(target,observation)=>{if(target.displayPath?.includes('AGENTS')||target.displayPath?.includes('SKILL'))state.fsObservations.push({path:target.displayPath,kind:observation.kind});},{global:true});},providePackages:host=>host.plugin(bootApi.PluginPackages,{resolution})}});
 if(!state.ready)throw Error('ACTUAL_APP_READINESS_MISSING');
 // Seeded empty fixture metadata avoids enrolling/cloning a new host project.
 // It still mounts the actual standard preset and real workspace consumer.
 agentHandle=await app.agents.create({sessionId,meta:{cwd:project,isSeeded:true,agentPreset:'standard'},seed:[],inheritedEventCount:0});
 const agent=agentHandle.agent,selection=agent.model.current(),signal=AbortSignal.timeout(5000),toolSet=await app.tools.resolve({agent,signal,modelSelection:selection});
 const assembly=await app.systemPrompt.assemble({agent,modelSelection:selection,signal,toolSet});
 if(JSON.stringify(assembly).includes('PUBLIC_CONTEXT_SENTINEL'))throw Error('HOST_CONTEXT_SENTINEL_REACHED_ASSEMBLY');
 toolSet.dispose();
 process.send({kind:'ready',loginUrl:app.connection.authenticatedUrl(app.webServer.getOrigin()),sessionId:agent.id,mode:app.projectExecutionMode.snapshot.mode,ready:state.ready,firstToolSet:true,modelStreams:state.modelStreams,fsObservations:state.fsObservations.length});
 process.on('message',async message=>{
  if(message?.kind!=='proof')return;
  try{
   const signal=AbortSignal.timeout(5000),toolSet=await app.tools.resolve({agent,signal,modelSelection:selection});let result;
   try{result=(await app.tools.execute({agent,signal,toolSet,calls:[{id:crypto.randomUUID(),name:'bash',arguments:JSON.stringify({command:'printf PUBLIC_CONTEXT_SENTINEL_HOST_FALLBACK',description:'Synthetic AppsOFF refusal proof'})}]})).results[0].result;}finally{toolSet.dispose();}
   process.send({kind:'proof',isError:result.isError===true,error:result.error?.code??result.error?.message??null,modelStreams:state.modelStreams,fsObservations:state.fsObservations.length,admissions:[...new Set(state.admissions)],body:JSON.stringify(result).slice(0,2048),nativeExecutorRows:projected.entries.filter(row=>row.name==='@deepseek-ai/dsh-tool-executor-native').length});
  }catch(error){process.send({kind:'proof-error',code:error.code??error.message});}
 });
}catch(error){try{await dispose();}finally{throw error;}}
