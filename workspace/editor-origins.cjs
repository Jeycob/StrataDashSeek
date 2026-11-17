'use strict';
// Browser storage survives process restarts and deletion of server-side data.
// An allocated origin therefore remains reserved to its session permanently.
const fs=require('node:fs'),{atomicJson}=require('../mobile/private-json.cjs');
const fail=code=>Object.assign(Error(code),{code,status:409});
class EditorOrigins{
 constructor(file,{ownerOrigin,endpoints}){
  const owner=new URL(ownerOrigin);if(owner.protocol!=='https:'||owner.origin!==ownerOrigin||!Array.isArray(endpoints)||!endpoints.length||endpoints.length>1024)throw fail('EDITOR_ORIGINS_INVALID');
  const origins=new Set(),ports=new Set();this.endpoints=endpoints.map(endpoint=>{const u=new URL(endpoint.origin),port=endpoint.listenerPort;if(u.protocol!=='https:'||u.origin!==endpoint.origin||u.origin===owner.origin||!Number.isInteger(port)||port<1024||port>65535||origins.has(u.origin)||ports.has(port))throw fail('EDITOR_ORIGINS_INVALID');origins.add(u.origin);ports.add(port);return{origin:u.origin,listenerPort:port};});
  this.file=file;let value;try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024**2)throw fail('EDITOR_ORIGIN_STATE_UNSAFE');value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;value={version:1,assignments:{}};}
  if(value.version!==1||!value.assignments||typeof value.assignments!=='object'||Array.isArray(value.assignments))throw fail('EDITOR_ORIGIN_STATE_UNSAFE');
  const used=new Set();for(const[id,saved]of Object.entries(value.assignments)){if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id)||!this.endpoints.some(e=>e.origin===saved.origin&&e.listenerPort===saved.listenerPort)||used.has(saved.origin))throw fail('EDITOR_ORIGIN_CONFIGURATION_CHANGED');used.add(saved.origin);}
  this.data=value;atomicJson(file,this.data);
 }
 allocate(sessionId){
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId))throw fail('EDITOR_SESSION_INVALID');
  const saved=Object.hasOwn(this.data.assignments,sessionId)?this.data.assignments[sessionId]:null;if(saved)return{...saved};
  const used=new Set(Object.values(this.data.assignments).map(x=>x.origin)),endpoint=this.endpoints.find(e=>!used.has(e.origin));if(!endpoint)throw fail('EDITOR_ORIGIN_CAPACITY');
  const next=structuredClone(this.data);Object.defineProperty(next.assignments,sessionId,{value:{...endpoint},enumerable:true,writable:true,configurable:true});atomicJson(this.file,next);this.data=next;return{...endpoint};
 }
}
module.exports={EditorOrigins};
