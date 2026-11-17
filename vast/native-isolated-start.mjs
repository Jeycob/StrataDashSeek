// Isolated-only SDK carrier. Host-compat still launches the stock CLI.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createExecutionModeContract}=require('./project-execution-mode.cjs');
const {ROOT,SNAPSHOT,boundedRead,captureBinding,validateSnapshot}=require('./native-isolated-profile.cjs');
const SDK=ROOT+'/runtime/node_modules',HOME=ROOT+'/home/.dsh',PROFILE=HOME+'/profiles/web';
const fail=code=>Object.assign(Error(code),{code});
export function createAppLifecycle({dispose,forceExit=code=>process.exit(code),complete=code=>{process.exitCode=code;},setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let pending,timer,completed=false,forced=false,ready=false;const listeners=new Set();
 const force=code=>{if(forced)return;forced=true;if(timer!==undefined)clearTimer(timer);forceExit(code);},finish=code=>{if(completed||forced)return;completed=true;if(timer!==undefined)clearTimer(timer);complete(code);};
 const stop=(code,forceAfterDispose)=>{if(pending){if(forceAfterDispose)force(code);return pending;}timer=setTimer(()=>force(code),5000);pending=Promise.resolve().then(dispose).then(()=>forceAfterDispose?force(code):finish(code),()=>force(code));return pending;};
 return{ready:{onReady(listener){if(ready){listener();return()=>{};}listeners.add(listener);return()=>listeners.delete(listener);}},commit(){if(ready||pending)return;ready=true;for(const listener of [...listeners])listener();listeners.clear();},shutdown:code=>stop(code,false),interrupt:code=>stop(code,true)};
}
export function readProtectedSnapshot(binding,{filesystem=fs,read=boundedRead}={}){
 // Fixed control path, outside every guest project mount. No root secret is
 // made readable; only this operator-owned composition is shared with Harness.
 let current='/';for(const part of path.posix.dirname(SNAPSHOT).slice(1).split('/')){current=path.posix.join(current,part);const stat=filesystem.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||stat.mode&0o022||filesystem.realpathSync(current)!==current)throw fail('NATIVE_PROFILE_SNAPSHOT_UNSAFE');}
 const stat=filesystem.lstatSync(SNAPSHOT);if(stat.uid!==0||stat.mode&0o022||stat.nlink!==1||!stat.isFile()||stat.isSymbolicLink())throw fail('NATIVE_PROFILE_SNAPSHOT_UNSAFE');
 const mode=captureBinding(binding);mode.check();const value=validateSnapshot(JSON.parse(read(SNAPSHOT)),binding);mode.check();return value;
}
export async function bootIsolatedSnapshot({binding,snapshot,args,api,configurationPath,bareModuleBaseUrl,profileContext,environment,lifecycle}){
 const mode=captureBinding(binding),value=validateSnapshot(snapshot,binding);
 mode.check();const ctx=await api.boot('dsh',configurationPath,[{insert:value.entries}],async host=>{
  mode.check();api.prepareHost?.(host);
  // Same session/runtime/home/profile facts as stock runProfile. The only
  // composition input is the private snapshot, never current project files.
  host.provide('profileContext',profileContext);
  host.provide(api.environmentKey,environment);
  await api.providePackages(host);mode.check();
  api.provideCmdline(host,{args,exit:code=>void lifecycle.shutdown(code),ready:lifecycle.ready});
 },bareModuleBaseUrl);try{mode.check();}catch(error){await ctx.fiber.dispose();throw error;}
 if(ctx.fiber.state===2&&ctx.get('loader')!==undefined)lifecycle.commit();return ctx;
}
export async function main(){
 const release=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
 if(!/^\/data\/harness\/releases\/[a-f0-9]{40}$/.test(release)||fs.realpathSync(release)!==release)throw fail('NATIVE_PROFILE_IMMUTABLE_RELEASE_REQUIRED');
 const binding=createExecutionModeContract().bindForService({sourceCommit:path.basename(release),launchId:process.env.HARNESS_PROJECT_EXECUTION_LAUNCH_ID}),mode=captureBinding(binding),snapshot=readProtectedSnapshot(binding);
 const load=(pkg,file='index.js')=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',pkg,'lib',file)));
 mode.check();const [bootApi,cmdline,launchEnvironment,httpProxy]=await Promise.all([load('dsh-app-boot'),load('dsh-cmdline'),load('dsh-launch-environment'),load('dsh-http-proxy')]);mode.check();
 process.env.DSH_USER_AGENT_SUFFIX='dsh-profile/web';
 const environment=bootApi.loadLayeredEnv('dsh'),disposeProxy=await httpProxy.installProxyFromEnvironment(environment,message=>process.stderr.write('dsh: '+message+'\n'));
 let app,disposal;const dispose=()=>disposal??=(async()=>{try{await app?.fiber.dispose();}finally{await disposeProxy();}})(),lifecycle=createAppLifecycle({dispose});
 bootApi.installFailLoud('dsh',process,dispose);
 for(const [signal,code]of [['SIGTERM',0],['SIGINT',130]])process.on(signal,()=>lifecycle.interrupt(code));
 try{
  mode.check();
  const installAnchor=SDK+'/@deepseek-ai/dsh/package.json',profile={name:'web',dir:PROFILE,patchPath:PROFILE+'/cordis.patch.yml',layers:[],patches:[],skippedBundles:[]};
  mode.check();const resolution=await bootApi.createRuntimeResolution({installAnchor,profile,home:HOME});mode.check();
  const profileContext=Object.freeze({name:'web',dir:PROFILE,patchPath:PROFILE+'/cordis.patch.yml',installAnchor,startedBundles:Object.freeze(['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']),cwd:process.cwd(),home:HOME,overlays:Object.freeze([]),telemetryDisabledEnv:process.env.DSH_TELEMETRY_DISABLED});
  app=await bootIsolatedSnapshot({binding,snapshot,args:process.argv.slice(2),configurationPath:release+'/vast/native-isolated-root.json',bareModuleBaseUrl:pathToFileURL(installAnchor).href,profileContext,environment,lifecycle,api:{...bootApi,environmentKey:launchEnvironment.DSH_LAUNCH_ENVIRONMENT_KEY,provideCmdline:cmdline.provideCmdline,prepareHost:host=>{app=host;},providePackages:host=>host.plugin(bootApi.PluginPackages,{resolution})}});
 }catch(error){try{await dispose();}catch(cleanup){throw new AggregateError([error,cleanup],'Isolated SDK startup and cleanup failed');}throw error;}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await main();
