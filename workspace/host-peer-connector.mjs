// Internal Linux TCP peer attribution. No HTTP, listener, discovery or lifecycle API.
import net from 'node:net';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const peerLimits=Object.freeze({milliseconds:2500,attempts:32,pollMs:25,processes:128,tasks:512,fds:4096,entries:8192,bytes:4*1024**2,operations:16384,fileBytes:262144,rows:4096,evidenceBytes:65536});
const failure=code=>Object.assign(Error(code),{code}),need=(ok,code)=>{if(!ok)throw failure(code);};
const decimal=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value);
const stable=value=>JSON.stringify(value);
const namespace=(value,kind)=>typeof value==='string'&&new RegExp('^'+kind+':\\[[1-9][0-9]{0,19}\\]$').test(value);
export function parsePeerStat(text,pid){
 const end=text.lastIndexOf(')'),fields=text.slice(end+2).trim().split(/\s+/);
 need(text.startsWith(pid+' (')&&end>0&&fields.length>=20&&decimal(fields[19]),'PEER_PROC_STAT_INVALID');
 const value={pid,ppid:Number(fields[1]),pgrp:Number(fields[2]),startTicks:fields[19],state:fields[0]};
 need(Number.isSafeInteger(pid)&&pid>1&&Number.isSafeInteger(value.ppid)&&value.ppid>=1&&Number.isSafeInteger(value.pgrp)&&value.pgrp>=1&&/^[RSDITtWP]$/.test(value.state),'PEER_PROCESS_NOT_LIVE');return value;
}
function address(hex){
 need(/^(?:[A-Fa-f0-9]{8}|[A-Fa-f0-9]{32})$/.test(hex),'PEER_TCP_INVALID');
 const bytes=Buffer.from(hex,'hex'),ordered=Buffer.alloc(bytes.length);
 for(let at=0;at<bytes.length;at+=4)for(let n=0;n<4;n++)ordered[at+n]=bytes[at+3-n];
 if(ordered.length===16){if(!ordered.subarray(0,12).equals(Buffer.from('00000000000000000000ffff','hex')))return null;return [...ordered.subarray(12)].join('.');}
 return [...ordered].join('.');
}
function endpoint(value){const parts=value.split(':');need(parts.length===2&&/^[0-9A-Fa-f]{4}$/.test(parts[1]),'PEER_TCP_INVALID');return{address:address(parts[0]),port:parseInt(parts[1],16)};}
export function parsePeerTcp(text){
 need(typeof text==='string'&&text.endsWith('\n'),'PEER_TCP_INCOMPLETE');const lines=text.trimEnd().split('\n');
 need(lines.length>0&&/\blocal_address\b/.test(lines[0])&&/\binode\b/.test(lines[0])&&lines.length<=peerLimits.rows+1,'PEER_TCP_INVALID');
 return lines.slice(1).map(line=>{const fields=line.trim().split(/\s+/);need(fields.length>=10&&/^\d+:$/.test(fields[0])&&/^[0-9A-Fa-f]{2}$/.test(fields[3])&&/^\d{1,20}$/.test(fields[9]),'PEER_TCP_INVALID');return{local:endpoint(fields[1]),remote:endpoint(fields[2]),state:fields[3].toUpperCase(),inode:fields[9]};});
}
function reverseRows(rows,tuple){return rows.filter(row=>row.state==='01'&&row.local.address==='127.0.0.1'&&row.remote.address==='127.0.0.1'&&row.local.port===tuple.remotePort&&row.remote.port===tuple.localPort);}
class ProcReader{
 constructor(files,check){this.fs=files;this.check=check;this.bytes=0;this.operations=0;this.entries=0;}
 async call(fn){this.check();need(++this.operations<=peerLimits.operations,'PEER_PROC_OPERATION_LIMIT');const result=await fn();this.check();return result;}
 async read(file,max=peerLimits.fileBytes){let handle;try{await this.call(async()=>{handle=await this.fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);return handle;});const buffer=Buffer.alloc(max+1);let size=0;while(size<buffer.length){const result=await this.call(()=>handle.read(buffer,size,buffer.length-size,null));if(!result.bytesRead)break;size+=result.bytesRead;}need(size<=max,'PEER_PROC_FILE_LIMIT');this.bytes+=size;need(this.bytes<=peerLimits.bytes,'PEER_PROC_BYTE_LIMIT');const bytes=buffer.subarray(0,size);need(!bytes.some(byte=>byte>127),'PEER_PROC_NONASCII');return bytes.toString('ascii');}finally{if(handle)await handle.close();}}
 async link(file){const result=await this.call(()=>this.fs.readlink(file));need(Buffer.byteLength(result)<=256,'PEER_PROC_LINK_LIMIT');return result;}
 async list(directory,limit){let handle;try{await this.call(async()=>{handle=await this.fs.opendir(directory);return handle;});const names=[];while(true){const item=await this.call(()=>handle.read());if(!item)break;need(++this.entries<=peerLimits.entries&&names.length<limit,'PEER_PROC_ENTRY_LIMIT');need(/^[1-9][0-9]*$|^0$/.test(item.name),'PEER_PROC_ENTRY_INVALID');names.push(item.name);}return names.sort((a,b)=>Number(a)-Number(b));}finally{if(handle)await handle.close();}}
 async identity(pid,uid,pidNamespace,netNamespace){
  const prefix='/proc/'+pid,s=await this.call(()=>this.fs.stat(prefix));need(s.uid===uid,'PEER_PROCESS_UID_CHANGED');
  const value=parsePeerStat(await this.read(prefix+'/stat',4096),pid);
  need(await this.link(prefix+'/ns/pid')===pidNamespace&&await this.link(prefix+'/ns/net')===netNamespace,'PEER_NAMESPACE_MISMATCH');return value;
 }
 async graph(anchor,target,namespaces){
  const records=[],queue=[{pid:anchor.pid,parent:null}],seen=new Set();let tasks=0;
  while(queue.length){const item=queue.shift();need(!seen.has(item.pid)&&records.length<peerLimits.processes,'PEER_DESCENDANT_GRAPH_INVALID');seen.add(item.pid);
   const value=await this.identity(item.pid,target.uid,namespaces.pid,namespaces.net);
   if(item.parent===null)need(value.pid===anchor.pid&&value.ppid===anchor.ppid&&value.pgrp===anchor.pgrp&&value.startTicks===anchor.startTicks,'PEER_ANCHOR_CHANGED');else need(value.ppid===item.parent,'PEER_ANCESTRY_CHANGED');
   const tids=await this.list('/proc/'+item.pid+'/task',peerLimits.tasks);need(tids.includes(String(item.pid))&&(tasks+=tids.length)<=peerLimits.tasks,'PEER_TASK_LIMIT');
   const children=[];for(const tid of tids){const raw=await this.read('/proc/'+item.pid+'/task/'+tid+'/children',16384);need(raw===''||/^\d+(?: \d+)* ?\n?$/.test(raw),'PEER_CHILDREN_INVALID');for(const child of raw.trim().split(/\s+/).filter(Boolean)){const pid=Number(child);need(Number.isSafeInteger(pid)&&pid>1&&!children.includes(pid),'PEER_CHILDREN_INVALID');children.push(pid);}}
   children.sort((a,b)=>a-b);const {state,...identity}=value;records.push({...identity,tids,children});for(const pid of children)queue.push({pid,parent:item.pid});
  }
  return records.sort((a,b)=>a.pid-b.pid);
 }
 async tcp(){return[...parsePeerTcp(await this.read('/proc/self/net/tcp')),...parsePeerTcp(await this.read('/proc/self/net/tcp6'))];}
 async holders(graph,inode){const holders=[];let total=0;for(const process of graph){const fds=await this.list('/proc/'+process.pid+'/fd',peerLimits.fds);need((total+=fds.length)<=peerLimits.fds,'PEER_FD_LIMIT');const matching=[];for(const fd of fds)if(await this.link('/proc/'+process.pid+'/fd/'+fd)==='socket:['+inode+']')matching.push(Number(fd));if(matching.length)holders.push({pid:process.pid,startTicks:process.startTicks,fds:matching});}return holders;}
}
function targetSnapshot(value){
 const fields=['jobId','owner','generation','projectSessionId','workspaceId','projectId','projectRoot','uid','port'];
 need(value&&Object.isFrozen(value)&&typeof value.assertCurrent==='function'&&value.signal&&typeof value.signal.aborted==='boolean'&&typeof value.signal.addEventListener==='function'&&typeof value.signal.removeEventListener==='function','PEER_TRUSTED_BINDING_REQUIRED');
 for(const key of ['jobId','owner','projectSessionId','workspaceId','projectId'])need(typeof value[key]==='string'&&value[key].length>0&&value[key].length<=256,'PEER_TARGET_INVALID');
 need(/^[a-f0-9]{32}$/.test(value.generation)&&Number.isSafeInteger(value.uid)&&value.uid>=0&&Number.isInteger(value.port)&&value.port>0&&value.port<=65535&&typeof value.projectRoot==='string'&&value.projectRoot.length<=4096&&path.posix.isAbsolute(value.projectRoot)&&path.posix.normalize(value.projectRoot)===value.projectRoot,'PEER_TARGET_INVALID');
 return Object.freeze(Object.fromEntries(fields.map(key=>[key,value[key]])));
}
// Required callbacks are trusted server composition, never request/config data.
export function createOwnPeerConnector({binding,custodyFor}={},trusted={}){
 need(typeof binding==='function'&&typeof custodyFor==='function','PEER_TRUSTED_CALLBACKS_REQUIRED');
 const files=trusted.fs??fs,makeSocket=trusted.socket??(()=>new net.Socket({allowHalfOpen:false,readableHighWaterMark:16384,writableHighWaterMark:16384})),now=trusted.now??Date.now,setTimer=trusted.setTimeout??setTimeout,clearTimer=trusted.clearTimeout??clearTimeout,sleep=trusted.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))),platform=trusted.platform??process.platform,endianness=trusted.endianness??os.endianness();
 return Object.freeze({async connect(options){
  need(options&&Object.keys(options).every(key=>['deadline','signal'].includes(key))&&Number.isSafeInteger(options.deadline),'PEER_CONNECT_OPTIONS_INVALID');
  need(platform==='linux'&&endianness==='LE','PEER_PLATFORM_UNSUPPORTED');const end=Math.min(options.deadline,now()+peerLimits.milliseconds);
  let socket,lease,source,target,timer,ended=false,resolveDone;const done=new Promise(resolve=>{resolveDone=resolve;});let rejectStop;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});void stopped.catch(()=>{});
  const close=()=>{ended=true;if(socket)socket.destroy();else resolveDone();};
  const stop=code=>{rejectStop(failure(code));close();};
  const abort=()=>stop('PEER_ABORTED'),revoke=()=>stop('PEER_BINDING_REVOKED');
  const check=()=>{need(!ended&&!options.signal?.aborted&&now()<end,'PEER_DEADLINE_OR_CLOSED');if(source){need(!source.signal.aborted,'PEER_BINDING_REVOKED');need(!source.assertCurrent()?.then,'PEER_ASYNC_ASSERT_UNSUPPORTED');need(stable(targetSnapshot(source))===stable(target),'PEER_BINDING_CHANGED');}if(lease)lease.assertCurrent();};
  const cleanup=()=>{clearTimer(timer);options.signal?.removeEventListener('abort',abort);source?.signal.removeEventListener('abort',revoke);};
  try{
   check();timer=setTimer(()=>stop('PEER_DEADLINE'),Math.max(0,end-now()));options.signal?.addEventListener('abort',abort,{once:true});
   const work=(async()=>{
    const candidate=await binding({deadline:end,signal:options.signal});check();target=targetSnapshot(candidate);source=candidate;check();source.signal.addEventListener('abort',revoke,{once:true});check();
    const captured=await custodyFor(target.jobId,target.owner);check();
    need(captured&&typeof captured.assertCurrent==='function','PEER_CUSTODY_MISMATCH');lease=captured;
    need(lease&&lease.jobId===target.jobId&&lease.owner===target.owner&&lease.identity?.generation===target.generation&&lease.context?.projectSessionId===target.projectSessionId&&lease.context?.workspaceId===target.workspaceId&&lease.context?.projectRoot===target.projectRoot&&typeof lease.assertCurrent==='function'&&lease.done?.then,'PEER_CUSTODY_MISMATCH');
    const anchor=Object.freeze({...lease.identity});need(namespace(anchor.pidNamespace,'pid'),'PEER_NAMESPACE_INVALID');
    const reader=new ProcReader(files,check),namespaces={pid:await reader.link('/proc/self/ns/pid'),net:await reader.link('/proc/self/ns/net')};need(anchor.pidNamespace===namespaces.pid&&namespace(namespaces.net,'net'),'PEER_NAMESPACE_MISMATCH');
    need(await reader.call(()=>files.realpath(target.projectRoot))===target.projectRoot,'PEER_PROJECT_ROOT_CHANGED');
    const rootBefore=await reader.call(()=>files.stat(target.projectRoot));need(rootBefore.isDirectory(),'PEER_PROJECT_ROOT_CHANGED');
    // No socket/bytes before trusted context and the live anchor are checked.
    const liveAnchor=await reader.identity(anchor.pid,target.uid,namespaces.pid,namespaces.net);need(['pid','ppid','pgrp','startTicks'].every(key=>liveAnchor[key]===anchor[key]),'PEER_ANCHOR_CHANGED');check();
    socket=makeSocket();socket.pause();socket.on('error',()=>close());socket.once('close',()=>{ended=true;rejectStop(failure('PEER_SOCKET_CLOSED'));cleanup();resolveDone();});
    Promise.resolve(lease.done).then(()=>stop('PEER_CUSTODY_EXPIRED'),()=>stop('PEER_CUSTODY_EXPIRED'));
    await new Promise((resolve,reject)=>{const fail=error=>reject(error?.code?failure('PEER_CONNECT_FAILED'):error);socket.once('error',fail);socket.once('connect',()=>{socket.removeListener('error',fail);resolve();});socket.connect({host:'127.0.0.1',port:target.port,family:4,localAddress:'127.0.0.1'});});check();
    const tuple={localAddress:socket.localAddress,localPort:socket.localPort,remoteAddress:socket.remoteAddress,remotePort:socket.remotePort};need(tuple.localAddress==='127.0.0.1'&&tuple.remoteAddress==='127.0.0.1'&&Number.isInteger(tuple.localPort)&&tuple.localPort>0&&tuple.remotePort===target.port&&socket.bytesWritten===0,'PEER_SOCKET_TUPLE_INVALID');
    for(let attempt=0;attempt<peerLimits.attempts;attempt++){
     check();try{
      const rows=reverseRows(await reader.tcp(),tuple);need(rows.length<=1,'PEER_REVERSE_TUPLE_AMBIGUOUS');
      if(rows.length&&decimal(rows[0].inode)){
       const inode=rows[0].inode,graph=await reader.graph(anchor,target,namespaces),holders=await reader.holders(graph,inode);need(holders.length<=1,'PEER_OWNER_AMBIGUOUS');
       if(holders.length===1){
        const after=await reader.graph(anchor,target,namespaces),again=await reader.holders(after,inode),reverse=reverseRows(await reader.tcp(),tuple);
        need(stable(graph)===stable(after)&&stable(holders)===stable(again)&&reverse.length===1&&reverse[0].inode===inode,'PEER_PROOF_CHANGED');
        const rootAfter=await reader.call(()=>files.stat(target.projectRoot));need(rootBefore.dev===rootAfter.dev&&rootBefore.ino===rootAfter.ino&&await reader.call(()=>files.realpath(target.projectRoot))===target.projectRoot,'PEER_PROJECT_ROOT_CHANGED');
        for(const process of after){const final=await reader.identity(process.pid,target.uid,namespaces.pid,namespaces.net);need(['pid','ppid','pgrp','startTicks'].every(key=>final[key]===process[key]),'PEER_PROOF_CHANGED');}
        check();need(!socket.destroyed&&socket.readyState==='open'&&socket.bytesWritten===0,'PEER_SOCKET_CLOSED');
        const evidence=Object.freeze({kind:'observed-own-established-peer',target,anchor,holder:Object.freeze({...holders[0],fds:Object.freeze([...holders[0].fds])}),tuple:Object.freeze(tuple),inode,pidNamespace:namespaces.pid,netNamespace:namespaces.net,ancestry:Object.freeze(graph.map(row=>Object.freeze({pid:row.pid,ppid:row.ppid,startTicks:row.startTicks,pgrp:row.pgrp}))),observedAt:now(),exclusiveOwnershipProven:false,atomicOwnershipLease:false});
        need(Buffer.byteLength(stable(evidence))<=peerLimits.evidenceBytes,'PEER_EVIDENCE_LIMIT');clearTimer(timer);return Object.freeze({socket,evidence,done,close});
       }
      }
     }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
     await sleep(Math.min(peerLimits.pollMs,Math.max(0,end-now())));check();
    }
    throw failure('PEER_UNATTRIBUTED');
   })();
   return await Promise.race([work,stopped]);
  }catch(error){close();cleanup();throw error?.code?error:failure('PEER_VERIFICATION_FAILED');}
 }});
}
