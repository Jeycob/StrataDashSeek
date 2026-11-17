'use strict';
const fs=require('node:fs'),contract=require('./project-execution-mode.cjs');
const {canonical,validateProjection}=contract;
const failure=code=>Object.assign(Error(code),{code,status:409});
function bindAppsExecution(binding){
 if(!binding||typeof binding!=='object'||typeof binding.assertUnchanged!=='function')throw failure('PROJECT_EXECUTION_BINDING_REQUIRED');
 const snapshot=validateProjection(binding.snapshot),expected=canonical(snapshot),check=binding.assertUnchanged.bind(binding);
 const assertUnchanged=()=>{try{if(canonical(validateProjection(check()))!==expected)throw failure('PROJECT_EXECUTION_BINDING_CHANGED');return snapshot;}catch(error){if(/^PROJECT_EXECUTION_[A-Z_]+$/.test(error.code||''))throw failure(error.code);throw error;}};
 assertUnchanged();return Object.freeze({snapshot,assertUnchanged});
}
function assertAppsExecution(manager,{isolated=false}={}){
 const binding=manager?.execution;if(!binding||typeof binding.assertUnchanged!=='function')throw failure('PROJECT_EXECUTION_BINDING_REQUIRED');
 const snapshot=validateProjection(binding.assertUnchanged());
 if(canonical(snapshot)!==canonical(validateProjection(binding.snapshot)))throw failure('PROJECT_EXECUTION_BINDING_CHANGED');
 if(isolated&&snapshot.mode!=='isolated-guest')throw failure('PROJECT_RUNTIME_MODE_UNAVAILABLE');
 return snapshot;
}
async function checkedAppsExecution(manager,action,options){assertAppsExecution(manager,options);const value=await action();assertAppsExecution(manager,options);return value;}
function protectedReleaseDirectory(directory,filesystem){
 // Apps runs as the service UID. Validate the immutable root-owned ancestry
 // read-only; runtime.directoryTree is a privileged mutation-side primitive.
 let current='/';
 try{for(const part of ['',...directory.slice(1).split('/')]){
  if(part)current=current==='/'?'/'+part:current+'/'+part;
  const stat=filesystem.lstatSync(current);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022)||filesystem.realpathSync(current)!==current)throw failure('PROJECT_EXECUTION_SOURCE_UNSAFE');
 }}catch(error){if(error.code==='PROJECT_EXECUTION_SOURCE_UNSAFE')throw error;throw failure('PROJECT_EXECUTION_SOURCE_UNSAFE');}
}
// Called by the actual Apps entrypoint before constructing a controller. None
// of these dependencies are read from Apps/user/browser configuration.
function bindAppsProcess({directory=__dirname,filesystem=fs,launchId=process.env.HARNESS_PROJECT_EXECUTION_LAUNCH_ID,modeContract=contract.createExecutionModeContract(),trustedDirectory}={}){
 const actual=filesystem.realpathSync(directory),match=/^\/data\/harness\/releases\/([a-f0-9]{40})\/vast$/.exec(actual);
 if(!match||actual!==directory)throw failure('PROJECT_EXECUTION_SOURCE_INVALID');
 if(trustedDirectory)trustedDirectory(actual);else protectedReleaseDirectory(actual,filesystem);
 const bound=bindAppsExecution(modeContract.bindForService({sourceCommit:match[1],launchId}));
 if(bound.snapshot.sourceCommit!==match[1]||bound.snapshot.launchId!==launchId)throw failure('PROJECT_EXECUTION_BINDING_CHANGED');
 return bound;
}
module.exports={bindAppsExecution,assertAppsExecution,checkedAppsExecution,bindAppsProcess};
