'use strict';
const http=require('node:http');
const LABEL='io.stratadashseek.apps';
function operationTimeout(method,route){
 if(method==='POST'&&/^\/containers\/create(?:\?|$)/.test(route))return 120000;
 if(method==='POST'&&/^\/containers\/[^/?]+\/start(?:\?|$)/.test(route))return 90000;
 if(method==='DELETE'&&/^\/containers\/[^/?]+(?:\?|$)/.test(route))return 120000;
 if(method==='POST'&&/^\/containers\/[^/?]+\/stop(?:\?|$)/.test(route)){const t=Number(new URL(route,'http://loopback').searchParams.get('t')??10);return(Math.max(15,Math.min(120,Number.isFinite(t)?t:10))+15)*1000;}
 return 15000;
}

// Only a dedicated local daemon or an explicit SSH tunnel; never a public TCP daemon.
class DockerEngine {
 constructor(cfg={}) {
  if(cfg.socketPath){this.connection={socketPath:cfg.socketPath};}
  else {const u=new URL(cfg.url||'http://127.0.0.1:19075');if(u.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(u.hostname)||u.username||u.password||u.pathname!=='/')throw Error('Docker API must use a local socket or loopback tunnel');this.connection={hostname:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port)||80};}
 }
 request(method,route,{json,stream,onChunk,timeout=operationTimeout(method,route),maxBytes=2*1024*1024}={}) {
  return new Promise((resolve,reject)=>{
   let done=false,total=0,response=null;const chunks=[];
   const fail=e=>{if(done)return;done=true;stream?.destroy();reject(e);};
   const abort=e=>{fail(e);response?.destroy();req.destroy();};
   const headers=json?{'Content-Type':'application/json'}:stream?{'Content-Type':'application/x-tar'}:{};
   const req=http.request({...this.connection,path:route,method,headers},res=>{
    response=res;
    res.on('data',chunk=>{if(done)return;total+=chunk.length;if(total>maxBytes){abort(Error('Docker response exceeded limit'));return;}try{if(onChunk)onChunk(chunk);else chunks.push(chunk);}catch(e){abort(e);}});
    res.on('error',fail);res.on('end',()=>{if(done)return;done=true;const raw=Buffer.concat(chunks);if(res.statusCode>=400){let message=raw.toString();try{message=JSON.parse(message).message}catch{}return reject(Object.assign(Error('Docker '+res.statusCode+': '+String(message).slice(0,1000)),{dockerStatus:res.statusCode}));}resolve({status:res.statusCode,body:raw});});
   });
   const timer=setTimeout(()=>abort(Object.assign(Error('Docker operation timed out: '+method+' '+route.split('?')[0]),{code:'DOCKER_OPERATION_TIMEOUT'})),timeout);timer.unref();
   req.on('error',fail);req.on('close',()=>clearTimeout(timer));
   if(stream){stream.on('error',abort);stream.pipe(req);}else req.end(json?JSON.stringify(json):undefined);
  });
 }
 async json(method,route,options){const r=await this.request(method,route,options);return r.body.length?JSON.parse(r.body):null;}
 async available(){const r=await this.request('GET','/_ping',{timeout:3000});if(r.body.toString()!=='OK')throw Error('Unexpected Docker response');return true;}
 async list(){const filters=encodeURIComponent(JSON.stringify({label:[LABEL+'=managed']}));return this.json('GET','/containers/json?all=1&filters='+filters);}
 async owned(id,projectId){if(!/^[a-f0-9]{12,64}$/.test(id))throw Error('Invalid container id');const data=await this.json('GET','/containers/'+id+'/json');if(data.Config?.Labels?.[LABEL]!=='managed'||projectId&&data.Config.Labels[LABEL+'.project']!==projectId)throw Error('Container is not managed by this project');return data;}
 async logs(id,projectId){await this.owned(id,projectId);const r=await this.request('GET','/containers/'+id+'/logs?stdout=1&stderr=1&tail=150&timestamps=1',{maxBytes:1024*1024});return decodeLogs(r.body);}
}
function decodeLogs(buffer){let offset=0,out='';while(offset+8<=buffer.length&&buffer[offset]<=2&&buffer[offset+1]===0&&buffer[offset+2]===0&&buffer[offset+3]===0){const length=buffer.readUInt32BE(offset+4);if(offset+8+length>buffer.length)break;out+=buffer.subarray(offset+8,offset+8+length).toString();offset+=8+length;}return offset===buffer.length?out:buffer.toString();}
module.exports={DockerEngine,LABEL,decodeLogs,operationTimeout};
