// Dedicated private Root stdin process. No live operation when imported.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createSupervisor} from '../supervisor.mjs';
import {prepareB02} from '../driver.mjs';
import {runtimePins} from '../runtime-pins.mjs';
import {slot} from './config.mjs';
const {sourceCommit,codeRoot,driverFolder}=runtimePins(slot);
const {executionEnabled,authorizationReference}=slot,settlementObservationMs=120000,preparationMs=30000;
const need=ok=>{if(!ok)throw Error('PRIVATE_PROTOCOL_REFUSED');};
export function commandDecoder(){
 let bytes=0,count=0,buffer=Buffer.alloc(0);
 function line(value){need(value.length>0&&value.length<=262144&&++count<=32);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value));}
 return Object.freeze({
  push(part){const chunk=Buffer.from(part);bytes+=chunk.length;need(bytes<=1048576);buffer=Buffer.concat([buffer,chunk]);const out=[];let at;
   while((at=buffer.indexOf(10))!==-1){let value=buffer.subarray(0,at);if(value.at(-1)===13)value=value.subarray(0,-1);out.push(line(value));buffer=buffer.subarray(at+1);}need(buffer.length<=262144);return out;
  },
  end(){const out=buffer.length?[line(buffer)]:[];buffer=Buffer.alloc(0);return out;},
 });
}
export async function main(){
 const fixed=value=>process.stdout.write(JSON.stringify(value)+'\n');
 if(executionEnabled!==true||typeof authorizationReference!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(authorizationReference)){
  fixed({version:1,event:'disabled',phase:'HOLD',sourceCommit,reason:'ROOT_BINDING_REQUIRED'});process.exitCode=2;return;
 }
 try{need(process.platform==='linux'&&process.getuid?.()===0&&process.getgid?.()===0&&process.argv.length===2&&!process.env.NODE_OPTIONS&&!process.env.NODE_PATH&&!process.env.NODE_DEBUG&&!process.env.NODE_DEBUG_NATIVE&&!process.env.DEBUG&&!process.env.PWDEBUG);need(await fs.realpath(path.dirname(fileURLToPath(import.meta.url)))===codeRoot+'/'+driverFolder);}catch{
  fixed({version:1,event:'disabled',phase:'HOLD',sourceCommit,reason:'FIXED_ROOT_ENVIRONMENT_REQUIRED'});process.exitCode=2;return;
 }
 let outputBytes=0,supervisor;
 const emit=value=>{const text=JSON.stringify(value)+'\n';outputBytes+=Buffer.byteLength(text);need(outputBytes<=131072);process.stdout.write(text);if(value.event==='terminal')process.stdin.destroy();};
 supervisor=createSupervisor({slot,prepare:options=>prepareB02(slot,options),emit,settlementMs:settlementObservationMs,preparationMs});
 process.stdout.on('error',()=>supervisor.channelFailed());process.stdin.on('error',()=>supervisor.channelFailed());
 const decoder=commandDecoder();
 try{for await(const part of process.stdin)for(const command of decoder.push(part))supervisor.handle(command);for(const command of decoder.end())supervisor.handle(command);}catch{supervisor.channelFailed();}
 const result=await supervisor.end();
 process.exitCode=result.phase==='COMPLETED'?(result.resultStatus==='PASS'?0:1):2;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await main().catch(()=>{process.stdout.write(JSON.stringify({version:1,event:'terminal',phase:'HOLD',sourceCommit,reason:'SUPERVISOR_UNCONFIRMED'})+'\n');process.exitCode=2;});
