import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {confined} from './core.mjs';
import {validateBrowserServer,withBrowserServer} from './browser-server-contract.mjs';
import {createOwnPeerConnector} from '../workspace/host-peer-connector.mjs';
import {sameHostCustodyBackend} from '../workspace/preview-backend.mjs';
import {previewSupported} from '../workspace/host-preview.mjs';
import {retainHeavyToolLease} from '../efficiency/heavy-tool-lease.mjs';
import {browserServerInspection,readInspectionDiagnostic} from './browser-server-diagnostic.mjs';
const failure=code=>Object.assign(Error(code),{code}),need=(ok,code)=>{if(!ok)throw failure(code);};
const quote=x=>"'"+String(x).replaceAll("'","'\\''")+"'";
const inspector=fileURLToPath(new URL('./browser-server-inspect.mjs',import.meta.url));
const production={supported:previewSupported,backend:sameHostCustodyBackend,connector:createOwnPeerConnector,uid:()=>process.getuid()};

export function browserServerSocketPath(projectRoot,nonce,platform=process.platform){
  need(typeof nonce==='string'&&/^[a-f0-9]{64}$/.test(nonce),'BROWSER_SERVER_CHANNEL_INVALID');
  if(platform==='win32')return'\\\\.\\pipe\\homeai-quality-'+nonce;
  need(typeof projectRoot==='string'&&path.posix.isAbsolute(projectRoot)&&path.posix.normalize(projectRoot)===projectRoot,'BROWSER_SERVER_CHANNEL_INVALID');
  // Keep the endpoint inside the existing private project directory. Socket
  // filename entropy is independent of the full 256-bit authentication nonce.
  const value=path.posix.join(projectRoot,'.harness','q'+nonce.slice(0,12));
  need(Buffer.byteLength(value)<104,'BROWSER_SERVER_CHANNEL_UNAVAILABLE');return value;
}

// Private source composition only. No config, model tool or HTTP surface may
// supply these factories, an execution, a command, a port or a producer handle.
export async function createBrowserServerChannel(ctx,manager,run,{execution,projectRoot,sourceHash,kind,deadline},trusted=production){
  const f={...production,...trusted},nonce=randomBytes(32).toString('hex'),controller=new AbortController();
  const owner=manager.ownerAgent(execution.agent),record=manager.data.sessions[owner?.id];
  const check=()=>{
    ctx.projectExecutionMode.assertTool(execution);execution.signal.throwIfAborted();controller.signal.throwIfAborted();
    need(Date.now()<deadline,'BROWSER_SERVER_TIMEOUT');
    need(ctx.agents.get(execution.agent.id)===execution.agent&&manager.ownerAgent(execution.agent)===owner&&manager.data.sessions[owner.id]===record&&record.root===projectRoot&&!record.legacy&&!manager.data.trash?.[owner.id]&&!ctx.workspaceRegistry.archivedSessionIds.includes(owner.id),'BROWSER_SERVER_PROJECT_CHANGED');
    need(Array.isArray(record.ports)&&record.ports.length===4&&new Set(record.ports).size===4&&record.ports.every(p=>Number.isInteger(p)&&p>=1024&&p<=65535),'BROWSER_SERVER_PORTS_UNAVAILABLE');
    for(const [id,other]of Object.entries(manager.data.sessions))if(id!==owner.id)need(!other.ports?.some(p=>record.ports.includes(p))&&other.root!==projectRoot,'BROWSER_SERVER_PROJECT_SHARED');
    const workspaces=ctx.workspaceRegistry.list().filter(w=>w.sessionIds.includes(owner.id));need(workspaces.length===1&&workspaces[0].id===record.workspaceId,'BROWSER_SERVER_PROJECT_CHANGED');
  };
  need(record&&Number.isSafeInteger(deadline)&&deadline>Date.now()&&deadline<=Date.now()+110000,'BROWSER_SERVER_CHANNEL_INVALID');check();
  const directory=await confined(projectRoot,'.harness',{missing:true});await fs.mkdir(directory,{recursive:true,mode:0o700});
  const socketPath=browserServerSocketPath(projectRoot,nonce);
  const sockets=new Set(),attempted=new Set();let authenticated,active,chain=Promise.resolve(),closed=false,closing,outer;
  const settleActive=async()=>{const entry=active;if(!entry)return;entry.stopping=true;if(entry.operation){entry.finish();await entry.operation.catch(()=>{});}else{entry.abort.abort();try{await run.stopOwned(entry.jobId,execution.agent.id);}catch{}}await entry.capture.done;if(active===entry)active=undefined;};
  async function handle(message){
    check();
    if(message.type==='stop'){
      need(Object.keys(message).sort().join(',')==='checkId,type'&&active?.checkId===message.checkId,'BROWSER_SERVER_REQUEST_INVALID');await settleActive();return{stopped:true};
    }
    need(['all','browser'].includes(kind)&&message.type==='start'&&Object.keys(message).sort().join(',')==='checkId,contractHash,contractPath,deadline,planHash,type'&&!active&&!attempted.has(message.checkId)&&/^[a-z][a-z0-9_-]{0,63}$/.test(message.checkId)&&/^[a-f0-9]{64}$/.test(message.contractHash)&&/^[a-f0-9]{64}$/.test(message.planHash)&&Number.isSafeInteger(message.deadline)&&message.deadline<=deadline&&message.deadline>Date.now(),'BROWSER_SERVER_REQUEST_INVALID');
    attempted.add(message.checkId);
    need(f.supported(ctx),'BROWSER_SERVER_UNAVAILABLE');
    const review=await manager.review(owner.id);check();need(review?.sourceHash===sourceHash,'STALE_VERIFICATION');
    await confined(projectRoot,message.contractPath);
    const signal=AbortSignal.any([execution.signal,controller.signal]);
    const inspected=await run({command:[process.execPath,inspector,projectRoot,message.contractPath,message.checkId].map(quote).join(' '),description:'Inspect declared browser server',timeoutMs:Math.min(120000,message.deadline-Date.now())},{...execution,signal});check();
    const data=browserServerInspection(inspected.result);need(data.checkId===message.checkId&&data.contractHash===message.contractHash&&data.planHash===message.planHash&&record.ports.includes(data.port),'BROWSER_SERVER_CONTRACT_CHANGED');
    const spec=validateBrowserServer(data.server),cwd=await confined(projectRoot,data.cwd);check();
    need(await f.backend(ctx,{mode:'workspace-write',workspaceRoot:projectRoot,additionalWritableRoots:record.gitWritableRoots??[]},signal),'BROWSER_SERVER_BACKEND_UNAVAILABLE');check();
    const remaining=message.deadline-Date.now();need(remaining>=1000,'BROWSER_SERVER_TIMEOUT');
    const abort=new AbortController(),jobSignal=AbortSignal.any([signal,abort.signal]);
    const timer=setTimeout(()=>abort.abort(failure('BROWSER_SERVER_TIMEOUT')),remaining);
    const releaseAdmission=retainHeavyToolLease(execution);
    const serverStartedAt=Date.now();
    let job;
    try{
      const command=['env',...Object.entries(data.env).map(([key,value])=>key+'='+value),...spec.command].map(quote).join(' ');
      job=await run.startWithCustody({command,description:'Owned browser server '+message.checkId,workdir:data.cwd,run_in_background:true,timeoutMs:remaining},{...execution,signal:jobSignal});
      const capture=await run.custodyFor(job.jobId,execution.agent.id);
      const entry=active={checkId:message.checkId,jobId:job.jobId,capture,abort,stopping:false};
      const stopOnAbort=()=>{if(!entry.stopping){outer?.kill();void close().catch(()=>{});}};jobSignal.addEventListener('abort',stopOnAbort,{once:true});
      void capture.done.finally(()=>{releaseAdmission();clearTimeout(timer);jobSignal.removeEventListener('abort',stopOnAbort);if(active===entry&&!entry.stopping){outer?.kill();void close().catch(()=>{});}}).catch(()=>{});
      check();jobSignal.throwIfAborted();
      need(capture.context.projectSessionId===owner.id&&capture.context.workspaceId===record.workspaceId&&capture.context.projectRoot===projectRoot,'BROWSER_SERVER_CUSTODY_MISMATCH');
      const binding=async()=>{check();capture.assertCurrent();return Object.freeze({jobId:job.jobId,owner:execution.agent.id,generation:capture.identity.generation,projectSessionId:owner.id,workspaceId:record.workspaceId,projectId:createHash('sha256').update(projectRoot).digest('hex').slice(0,16),projectRoot,uid:f.uid(),port:data.port,signal:jobSignal,assertCurrent(){check();capture.assertCurrent();jobSignal.throwIfAborted();}});};
      const connector=f.connector({binding,custodyFor:run.custodyFor});
      let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
      const finish=new Promise(resolve=>{entry.finish=resolve;});
      entry.operation=withBrowserServer({server:spec,deadline:message.deadline,readinessDeadline:Math.min(message.deadline,serverStartedAt+spec.readinessTimeoutMs),signal:jobSignal,
        start:()=>({done:capture.done,assertCurrent(){check();capture.assertCurrent();},terminate(){entry.stopping=true;abort.abort();void run.stopOwned(job.jobId,execution.agent.id).catch(()=>{});}}),
        ready:async({deadline,signal})=>{const probe=await connector.connect({deadline,signal});probe.close();await probe.done;},
        verify:({signal})=>{readyResolve();return new Promise((resolve,reject)=>{const cancelled=()=>reject(signal.reason);signal.addEventListener('abort',cancelled,{once:true});void finish.then(()=>{signal.removeEventListener('abort',cancelled);resolve();});});},
      });
      void entry.operation.catch(error=>{readyReject(error);if(entry.ready&&!entry.stopping){outer?.kill();void close().catch(()=>{});}});
      await ready;entry.ready=true;check();capture.assertCurrent();
      return{ready:true,checkId:message.checkId};
    }catch(error){clearTimeout(timer);abort.abort();if(job&&!active){try{await run.stopOwned(job.jobId,execution.agent.id);}catch{}}await settleActive();releaseAdmission();throw error;}
  }
  const server=net.createServer(socket=>{
    if(sockets.size>=4||closed){socket.destroy();return;}
    sockets.add(socket);let buffer='',authorized=false,messages=0;socket.setEncoding('utf8');socket.on('error',()=>{});
    socket.on('close',()=>{sockets.delete(socket);if(authorized)void close().catch(()=>{});});
    socket.on('data',bytes=>{
      buffer+=bytes;if(Buffer.byteLength(buffer)>16384){socket.destroy();return;}
      let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        if(++messages>65){socket.destroy();break;}
        if(!authorized){try{const value=JSON.parse(line);need(!authenticated&&Object.keys(value).sort().join(',')==='nonce,type'&&value.type==='hello'&&value.nonce===nonce,'BROWSER_SERVER_CHANNEL_INVALID');authenticated=socket;authorized=true;socket.write(JSON.stringify({ok:true,value:{connected:true}})+'\n');}catch{socket.destroy();}continue;}
        chain=chain.then(async()=>{try{const value=await handle(JSON.parse(line));if(!socket.destroyed)socket.write(JSON.stringify({ok:true,value})+'\n');}catch(error){const inspection=readInspectionDiagnostic(error.inspection);if(!socket.destroyed)socket.write(JSON.stringify({ok:false,code:/^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)?error.code:'BROWSER_SERVER_FAILED',...(inspection?{inspection}:{})})+'\n');}});
      }
    });
  });
  async function close(){
    if(closing)return closing;
    let resolve,reject;closing=new Promise((a,b)=>{resolve=a;reject=b;});void closing.catch(()=>{});
    closed=true;controller.abort(failure('BROWSER_SERVER_CHANNEL_CLOSED'));
    void(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await chain;await settleActive();})().then(resolve,reject);return closing;
  }
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});}
  catch{server.close();throw failure('BROWSER_SERVER_CHANNEL_UNAVAILABLE');}
  const abort=()=>{outer?.kill();void close().catch(()=>{});};execution.signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,Math.max(0,deadline-Date.now()));
  if(execution.signal.aborted)abort();
  let attached=false;
  return Object.freeze({envelope:{version:1,path:socketPath,nonce,deadline},attach(process){need(!attached&&!closed&&process?.done?.then&&typeof process.kill==='function','BROWSER_SERVER_CHANNEL_INVALID');attached=true;outer=process;const done=Promise.resolve(process.done).finally(close);void done.catch(()=>{});return{done,kill(){process.kill();void close().catch(()=>{});return true;}};},async close(){clearTimeout(timer);execution.signal.removeEventListener('abort',abort);return close();}});
}

export function installBrowserServerHost(ctx,manager,run){
  const channels=new Set();
  const remove=ctx.on('workspace-runtime/browser-server-channel',async input=>{
    const channel=await createBrowserServerChannel(ctx,manager,run,input),managed={...channel,async close(){try{return await channel.close();}finally{channels.delete(managed);}}};channels.add(managed);return managed;
  });
  return async()=>{remove();await Promise.all([...channels].map(channel=>channel.close()));channels.clear();};
}
