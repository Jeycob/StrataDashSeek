import path from 'node:path';
import {createRequire} from 'node:module';
import {createProjectCommandRunner,registerProjectTool} from './project-tool.mjs';
import {createManagedShell} from './managed-shell.mjs';
import {createGuestProjectCommandRunner} from './project-guest-runner.mjs';
import {createProjectFileTools} from './project-file-tools.mjs';
import {createProjectFileHandlers,projectRelativePath} from './project-file-executor.mjs';
import {createGuestContext} from './guest-context.mjs';
import {createGuestHelperTools,createGuestJobTools} from './guest-helper-tools.mjs';
import {createConversationTools} from './conversation-tools.mjs';
import {installProjectVerification} from './project-verification.mjs';
import {createProjectAppsTools} from './project-apps-tools.mjs';
import {createProjectAppsReceiptStore} from './project-apps-receipts.mjs';
import {createProjectRuntimeReceiptStore} from './project-runtime-receipts.mjs';
import {installEditorSessions} from './editor-session.mjs';
import {createProjectEditorAdapter} from './editor-runtime-adapter.mjs';
import {retainHeavyToolLease} from '../efficiency/heavy-tool-lease.mjs';
import {requireProjectExecutionMode} from './execution-mode-service.mjs';
import {createHostPreview,previewSettings,previewSupported} from './host-preview.mjs';
const require=createRequire(import.meta.url);
const defaults=Object.freeze({hostRunner:createProjectCommandRunner,guestRunner:createGuestProjectCommandRunner,runtimeReceipts:createProjectRuntimeReceiptStore,appsReceipts:createProjectAppsReceiptStore,projectApps:createProjectAppsTools,editorSessions:installEditorSessions,editorAdapter:createProjectEditorAdapter,hostPreview:createHostPreview,previewSupported});

// Trusted source-only fixture seam: factories are supplied directly by test
// code, never plugin config or a browser value. Production always uses defaults.
export function composeProjectExecution(ctx,manager,{appsConfig,callApps,capabilities}={},factories=defaults){
 factories={...defaults,...factories};
 const execution=requireProjectExecutionMode(ctx),isolated=execution.snapshot.mode==='isolated-guest',check=()=>execution.assertUnchanged();check();
 let previewConfig=previewSettings(appsConfig?.hostPreview);
 const editorEndpoints=appsConfig?.projectRuntime?.editorBrowser?.endpoints;
 if(previewConfig&&editorEndpoints!==undefined){
  const editor=previewSettings({enabled:true,ownerOrigin:appsConfig.projectRuntime.editorBrowser.ownerOrigin,endpoints:editorEndpoints});
  if(!editor||editor.endpoints.some(endpoint=>previewConfig.endpoints.some(app=>app.origin===endpoint.origin||app.listenerPort===endpoint.listenerPort)))previewConfig=null;
 }
 const capture=!isolated&&!!previewConfig&&factories.previewSupported();
 const shell=isolated?null:factories.hostRunner(ctx,manager,capture?{captureBackgroundCustody:true}:{},execution);
 if(!isolated){
  const project=registerProjectTool(ctx,manager,shell,execution),managedShell=createManagedShell(ctx,manager,shell,execution);
  const previews=factories.hostPreview(ctx,manager,shell,previewConfig,execution);
  return{isolated,run:shell,previews,install(agent){managedShell.install(agent);previews.install(agent);},remove(agent){managedShell.remove(agent);previews.remove(agent);},handles:actual=>managedShell.handles(actual)||previews.handles(actual),managerExecution:actual=>({...actual,agent:manager.ownerAgent(actual.agent),managedProjectShell:managedShell.handles(actual)}),async dispose(){managedShell.dispose();project.dispose();await previews.dispose();await shell.dispose?.();}};
 }
 const runtimeReceipts=factories.runtimeReceipts(manager.root,{executionBinding:execution}),appsReceipts=factories.appsReceipts(manager.root,{assertActive:check});
 const run=factories.guestRunner(ctx,manager,{appsConfig,callApps,receiptStore:runtimeReceipts},execution);
 const project=registerProjectTool(ctx,manager,run,execution),managedShell=createManagedShell(ctx,manager,run,execution);
 const context=createGuestContext(ctx,manager,run,execution),files=createProjectFileTools(ctx,manager,createProjectFileHandlers(run,{executionBinding:execution,beforeMutation:context.beforeMutation}),execution);
 const helpers=createGuestHelperTools(ctx,manager,context,execution,run.assertAvailable),jobs=createGuestJobTools(ctx,execution),conversation=(factories.conversationTools??createConversationTools)(ctx,execution);
 const projectApps=factories.projectApps(ctx,manager,{appsConfig,callApps,retainHeavyToolLease,receiptStore:appsReceipts},execution);
 const removeVerification=installProjectVerification(ctx,manager,run,execution);
 let editorOptions;
 const browser=appsConfig?.projectRuntime?.editorBrowser;
 if(appsConfig?.enabled===true&&appsConfig.vm?.enabled===true&&appsConfig.projectRuntime?.enabled===true&&browser){
  check();const {EditorOrigins}=require('./editor-origins.cjs'),{EditorTransportStore}=require('./editor-transport.cjs');
  const transport=new EditorTransportStore(appsConfig.projectRuntime.editorTransportRoot??'/data/harness/secrets/editor-transport');
  editorOptions={ownerOrigin:browser.ownerOrigin,origins:new EditorOrigins(path.join(manager.root,'editor-origins.json'),browser),adapter:factories.editorAdapter(manager,{appsConfig,callApps,receiptStore:runtimeReceipts,socketDirectory:path.join(manager.root,'editor-sockets'),transportIdentity:async({scopeId,generation})=>{check();const value=await transport.clientIdentity(scopeId,generation);check();return value;}},execution)};
 }
 // With Apps/VM OFF, no origins, identity/certificates or adapter are needed.
 const editors=factories.editorSessions(ctx,manager,editorOptions,execution),capabilityDefinitions=new WeakSet(),capabilityRegistrations=new Map();let closed=false;
 function install(agent){
  check();if(closed)throw Error('PROJECT_EXECUTION_WORKSPACE_CLOSED');managedShell.install(agent);files.install(agent);helpers.install(agent);jobs.install(agent);conversation.install(agent);
  if(capabilities&&!capabilityRegistrations.has(agent)){
   const definition={name:'runtime_capabilities',description:'Read bounded capabilities of this bound isolated project without waking Apps or choosing a host fallback.',parameters:{type:'object',properties:{},additionalProperties:false},isConcurrencySafe:()=>true,output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(_args,actual){check();actual.signal.throwIfAborted();const owner=manager.ownerAgent(actual.agent),record=manager.data.sessions[owner?.id];if(!record||record.legacy)throw Error('NO_MANAGED_PROJECT');const value=await capabilities.snapshot(record.root);check();return value;}};
   capabilityDefinitions.add(definition);capabilityRegistrations.set(agent,{definition,remove:agent.ctx.tools.register(definition)});
  }
 }
 function remove(agent){managedShell.remove(agent);files.remove(agent);helpers.remove(agent);jobs.remove(agent);conversation.remove(agent);const entry=capabilityRegistrations.get(agent);if(entry){capabilityDefinitions.delete(entry.definition);entry.remove();capabilityRegistrations.delete(agent);}}
 function managerExecution(actual){
  const owner=manager.ownerAgent(actual.agent),record=manager.data.sessions[owner?.id];let args=actual.arguments;
  // The manager's existing target/operation accounting uses its host project
  // root. Normalize only this private policy view for an actual guest shadow;
  // SDK admitted arguments and the executor's request remain immutable.
  const key=files.handles(actual)&&['write','edit'].includes(actual.name)?'file_path':managedShell.handles(actual)?'workdir':null;
  if(record&&key&&typeof args?.[key]==='string'&&(args[key]==='/workspace'||args[key].startsWith('/workspace/'))){try{args={...args,[key]:path.join(record.root,projectRelativePath(record.root,args[key],{allowRoot:key==='workdir'}))};}catch{/* Preserve invalid input so the original guard/executor refuses it. */}}
  return{...actual,arguments:args,agent:owner,managedProjectShell:managedShell.handles(actual)};
 }
 // Install all existing/seeded scopes before opening the permanent root slot.
 // Future children are synchronously shadowed by the plugin's created hook.
 for(const agent of ctx.agents.list())install(agent);
 const close=execution.registerWorkspace({handles:actual=>!closed&&([project,managedShell,files,helpers,jobs,conversation,projectApps].some(owner=>owner.handles(actual))||capabilityDefinitions.has(ctx.tools.get(actual.name,actual.agent,actual.toolSet))),async beforeHeavy(actual){check();await projectApps.beforeHeavy();check();await run.beforeHeavy(actual.signal);check();}});
 return{isolated,ready:conversation.ready,run,editors,install,remove,handles:managedShell.handles,managerExecution,async dispose(){if(closed)return;closed=true;close();for(const agent of [...capabilityRegistrations.keys()])remove(agent);managedShell.dispose();files.dispose();helpers.dispose();jobs.dispose();context.dispose();removeVerification?.();project.dispose();await Promise.allSettled([conversation.dispose(),projectApps.dispose(),run.dispose(),editors.dispose()]);}};
}
