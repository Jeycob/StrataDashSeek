import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {installRuntimeAdmission} from './runtime-admission-hooks.mjs';
import {installClosedProjectExecutionSlot,installProjectExecutionMode} from './execution-mode-service.mjs';
import {createRequire} from 'node:module';
const {createExecutionModeContract}=createRequire(import.meta.url)('../vast/project-execution-mode.cjs');
export const name='root-runtime-admission';
export const inject=['agents','tools','connection'];
export function installTrustedRuntimeAdmission(ctx,binding,client){
 const execution=installProjectExecutionMode(ctx,binding);
 installRuntimeAdmission(ctx,{expectedCommit:execution.snapshot.sourceCommit},client);
 return execution;
}
export async function apply(ctx){
 installClosedProjectExecutionSlot(ctx);
 const location=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
 if(!/^\/data\/harness\/releases\/[a-f0-9]{40}$/.test(location))throw Object.assign(Error('PROJECT_EXECUTION_IMMUTABLE_RELEASE_REQUIRED'),{code:'PROJECT_EXECUTION_IMMUTABLE_RELEASE_REQUIRED'});
 installRuntimeAdmission(ctx,{expectedCommit:path.basename(location)});
 const root=await fs.realpath(location);
 if(root!==location)throw Object.assign(Error('PROJECT_EXECUTION_IMMUTABLE_RELEASE_REQUIRED'),{code:'PROJECT_EXECUTION_IMMUTABLE_RELEASE_REQUIRED'});
 const binding=createExecutionModeContract().bindForService({sourceCommit:path.basename(root),launchId:process.env.HARNESS_PROJECT_EXECUTION_LAUNCH_ID});
 installTrustedRuntimeAdmission(ctx,binding);
}
