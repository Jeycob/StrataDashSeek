'use strict';
// Local maintenance only. Never print or persist the launch token or cookies.
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');
const ROOT='/data/harness';
function createOwnerAPI({root=ROOT,port=3090,host}={}){
 host??=JSON.parse(fs.readFileSync(root+'/config.json','utf8')).publicHost;
 function local(route,method='GET',headers={},body=''){return new Promise((resolve,reject)=>{
  const request=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{Host:host,...headers}},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text}));});
  request.on('error',reject);request.setTimeout(20000,()=>request.destroy(Error('Local owner API timeout')));request.end(body);
 });}
 async function login(){const matches=[...fs.readFileSync(root+'/logs/harness.log','utf8').matchAll(/https?:\/\/[^\s]+\?token=[^\s]+/gu)];if(!matches.length)throw Error('No local Harness launch record');const url=new URL(matches.at(-1)[0]);if(url.host!==host)throw Error('Local Harness authority mismatch');const response=await local('/?token='+encodeURIComponent(url.searchParams.get('token')));if(response.status!==303||!response.headers['set-cookie']?.length)throw Error('Local owner authentication failed');return response.headers['set-cookie'].map(value=>value.split(';')[0]).join('; ');}
 async function call(method,request,cookie){const args=method==='session/list'?{_request:request}:method==='commands/execute'?request:method==='session/modelCatalog'?{}:{request};const response=await local('/api/'+method,'POST',{Origin:'https://'+host,Cookie:cookie,'Content-Type':'application/json'},JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}}));let data;try{data=JSON.parse(response.text);}catch{throw Error('Local RPC HTTP '+response.status);}if(response.status!==200||!data.result?.ok)throw Error('Local RPC rejected: '+method);return data.result.value;}
 return{login,call};
}
let defaults;module.exports={createOwnerAPI,login:(...args)=>(defaults??=createOwnerAPI()).login(...args),call:(...args)=>(defaults??=createOwnerAPI()).call(...args)};
