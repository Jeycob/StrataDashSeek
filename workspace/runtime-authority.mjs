import fs from 'node:fs/promises';
import path from 'node:path';
import {bindProjectExecution} from './execution-mode.mjs';
const fail=code=>Object.assign(Error(code),{code,status:409});
function policyReadOnly(ctx,session){const mode=ctx.sandboxPolicy.resolve({session})?.mode;if(!['read-only','workspace-write','danger-full-access'].includes(mode))throw fail('PROJECT_RUNTIME_POLICY_UNAVAILABLE');return mode==='read-only';}
// Called only from trusted Native code under Workbench -> registry locks.
// The browser/model may supply a session identifier, never a filesystem root,
// port allocation, permission mode or runtime identity.
export async function runtimeContext(ctx,manager,input){
 const execution=bindProjectExecution(manager.execution);
 if(execution.snapshot.mode!=='isolated-guest')throw fail('PROJECT_RUNTIME_MODE_UNAVAILABLE');
 const checked=async action=>{execution.assertUnchanged();const value=await action();execution.assertUnchanged();return value;};
 const {sessionId,op,kind,generation,accessSessionId}=input;
 if(Object.keys(input).some(k=>!['sessionId','op','kind','generation','accessSessionId'].includes(k))||!['ensure','execute'].includes(op)||!['editor','executor','relay'].includes(kind)||typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)||!/^[a-f0-9]{32}$/.test(generation||''))throw fail('PROJECT_RUNTIME_REQUEST_INVALID');
 const record=manager.data.sessions[sessionId],project=await checked(()=>manager.projectFor(sessionId));
 if(!record||record.legacy||record.nativeWorktree||record.independentRepository!==true||manager.data.trash?.[sessionId]||ctx.workspaceRegistry.archivedSessionIds.has(sessionId)||!project.live||project.header.origin==='subagent')throw fail('PROJECT_RUNTIME_NOT_ISOLATED');
 const root=await checked(()=>fs.realpath(record.root)),base=await checked(()=>fs.realpath(manager.projectsRoot)),git=path.join(root,'.git');
 if(root!==record.root||root!==project.root||path.dirname(root)!==base)throw fail('PROJECT_RUNTIME_NOT_ISOLATED');
 for(const[id,other]of Object.entries(manager.data.sessions))if(id!==sessionId&&other.root&&(root===other.root||root.startsWith(other.root+path.sep)||other.root.startsWith(root+path.sep)))throw fail('PROJECT_RUNTIME_SHARED');
 const info=await checked(()=>fs.lstat(git));if(!info.isDirectory()||info.isSymbolicLink()||await checked(()=>fs.realpath(git))!==git)throw fail('PROJECT_RUNTIME_GIT_SHARED');
 for(const name of ['commondir','objects/info/alternates','objects/info/http-alternates'])try{await checked(()=>fs.lstat(path.join(git,name)));throw fail('PROJECT_RUNTIME_GIT_SHARED');}catch(error){if(error.code!=='ENOENT')throw error;execution.assertUnchanged();}
 const ports=record.ports;if(!Array.isArray(ports)||ports.length!==4||new Set(ports).size!==4||ports.some(p=>!Number.isInteger(p)||p<1024||p>65535)||Object.entries(manager.data.sessions).some(([id,p])=>id!==sessionId&&p.ports?.some(port=>ports.includes(port))))throw fail('PROJECT_RUNTIME_PORTS_INVALID');
 let readOnly=policyReadOnly(ctx,project.live);
 if(accessSessionId&&accessSessionId!==sessionId){
  const agent=ctx.agents.list().find(a=>a.id===accessSessionId);
  if(!agent||manager.ownerAgent(agent)?.id!==sessionId)throw fail('PROJECT_RUNTIME_ACCESS_SESSION_INVALID');
  readOnly=policyReadOnly(ctx,agent.session)||readOnly;
 }
 execution.assertUnchanged();return{version:1,op,kind,sessionId,projectRoot:root,readOnly,generation,ports:[...ports]};
}
