'use strict';
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');
const R='/data/harness',host='benchmark.invalid';
function local(path,method='GET',headers={},body=''){return new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:3090,path,method,headers:{Host:host,...headers}},r=>{let text='';r.setEncoding('utf8');r.on('data',c=>text+=c);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,text}));});q.on('error',reject);q.setTimeout(20000,()=>q.destroy(Error('timeout')));q.end(body);});}
async function call(method,request,cookie){const r=await local('/api/'+method,'POST',{Origin:'https://'+host,Cookie:cookie,'Content-Type':'application/json'},JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:method==='session/list'?{_request:request}:method==='commands/execute'?request:{request}}}));let d;try{d=JSON.parse(r.text)}catch{throw Error('RPC '+method+' HTTP '+r.status)}if(r.status!==200||!d.result?.ok)throw Error('RPC failed '+method+' '+JSON.stringify(d));return d.result.value;}
async function login(){const matches=[...fs.readFileSync(R+'/logs/harness.log','utf8').matchAll(/https:\/\/[^\s]+\?token=[^\s]+/g)];const u=new URL(matches.at(-1)[0]);if(u.host!==host)throw Error('Host mismatch');const r=await local('/?token='+encodeURIComponent(u.searchParams.get('token')));if(r.status!==303)throw Error('Login failed');return r.headers['set-cookie'].map(c=>c.split(';')[0]).join('; ');}
module.exports={call,login};

