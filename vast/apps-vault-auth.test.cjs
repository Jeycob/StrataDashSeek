'use strict';
const nodeTest=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const test=(name,fn)=>nodeTest(name,{timeout:5000},fn);
const{InfisicalVault}=require('./apps-vault.cjs');
const scope={projectId:'project-fixture',environment:'prod',secretPath:'/'};
const credentials=name=>({origin:'https://eu.infisical.com',clientId:'fixture-'+name,clientSecret:'synthetic-fixture-only-'+name});
const key=c=>JSON.stringify([c.origin,c.clientId,c.clientSecret]);
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vault-auth-fixture-')),file=path.join(root,'identity.json');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(file,JSON.stringify(credentials('A')),{mode:0o600});
 const state={logins:0,reads:0,login:async()=>null,read:async()=>null,tokens:new Map()};
 const vaultFetch=async(url,options)=>{
  assert.ok(url.startsWith('https://eu.infisical.com/')||url.startsWith('https://us.infisical.com/'));
  if(url.endsWith('/api/v1/auth/universal-auth/login')){
   const body=JSON.parse(options.body),c={...body,origin:new URL(url).origin},n=++state.logins;
   const response=await state.login(c,n);if(response)return response;
   const token='synthetic-token-'+n;state.tokens.set(token,key(c));return new Response(JSON.stringify({accessToken:token,expiresIn:300}));
  }
  state.reads++;
  const c=JSON.parse(await fs.readFile(file,'utf8')),token=options.headers.Authorization?.slice('Bearer '.length);
  // Assert only the predicate, so failure output never dumps identities/tokens.
  assert.ok(new URL(url).origin===c.origin&&state.tokens.get(token)===key(c),'request must use a token belonging to the current identity');
  const response=await state.read();return response||new Response(JSON.stringify({secret:{secretValue:'synthetic-value'}}));
 };
 const vault=new InfisicalVault({vaultMachineFile:file,vaultFetch});
 const rotate=async c=>{const temp=path.join(root,'replacement.json');await fs.writeFile(temp,JSON.stringify(c),{mode:0o600});await fs.rename(temp,file);};
 return{root,file,state,vault,vaultFetch,rotate};
}

test('cold parallel reads share one login; values themselves are never cached',async t=>{
 const f=await fixture(t),gate=deferred();f.state.login=()=>gate.promise;
 const reads=Array.from({length:12},()=>f.vault.read(scope,'EXAMPLE'));await tick();assert.equal(f.state.logins,1);
 gate.resolve();const values=await Promise.all(reads);assert.ok(values.every(value=>value==='synthetic-value'));assert.equal(f.state.reads,12);
 await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,1);assert.equal(f.state.reads,13);
});

test('expired token renewal is shared by concurrent callers',async t=>{
 const f=await fixture(t);await f.vault.auth();f.vault.token.until=Date.now()-1;
 const gate=deferred();f.state.login=()=>gate.promise;
 const requests=Array.from({length:8},()=>f.vault.auth());await tick();assert.equal(f.state.logins,2);
 gate.resolve();await Promise.all(requests);assert.equal(f.state.logins,2);
});

test('shared login failure and malformed response clear the flight for a later retry',async t=>{
 const f=await fixture(t),gate=deferred();f.state.login=async()=>{await gate.promise;return new Response('{}',{status:401});};
 const requests=Array.from({length:6},()=>f.vault.auth());const settled=Promise.allSettled(requests);await tick();assert.equal(f.state.logins,1);gate.resolve();
 assert.ok((await settled).every(x=>x.status==='rejected'&&x.reason.vaultStatus===401));
 f.state.login=async()=>new Response(JSON.stringify({expiresIn:300}));await assert.rejects(f.vault.auth(),/Invalid vault authentication response/);
 f.state.login=async()=>null;await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,3);
});

test('same-identity instances do not share tokens or in-flight state',async t=>{
 const f=await fixture(t),other=new InfisicalVault({vaultMachineFile:f.file,vaultFetch:f.vaultFetch}),gate=deferred();f.state.login=()=>gate.promise;
 const requests=[f.vault.auth(),other.auth()];await tick();assert.equal(f.state.logins,2);gate.resolve();await Promise.all(requests);
 await Promise.all([f.vault.read(scope,'EXAMPLE'),other.read(scope,'EXAMPLE')]);assert.equal(f.state.logins,2);
});

test('external origin, client ID and secret rotations invalidate otherwise valid token',async t=>{
 const f=await fixture(t);await f.vault.read(scope,'EXAMPLE');let current=credentials('A');
 for(const patch of[{origin:'https://us.infisical.com'},{clientId:'fixture-B'},{clientSecret:'synthetic-rotated-fixture-only'}]){
  current={...current,...patch};await f.rotate(current);assert.equal(f.vault.status().authenticatedUntil,null);await f.vault.read(scope,'EXAMPLE');
 }
 assert.equal(f.state.logins,4);assert.equal(f.state.reads,4);
});

test('old identity completion cannot publish a token or clear a new identity flight',async t=>{
 const f=await fixture(t),old=deferred(),fresh=deferred();f.state.login=async c=>{await(c.clientId===credentials('A').clientId?old.promise:fresh.promise);};
 const first=assert.rejects(f.vault.auth(),/identity changed/);await tick();await f.rotate(credentials('B'));
 const second=f.vault.auth();await tick();assert.equal(f.state.logins,2);
 old.resolve();await first;
 const third=f.vault.auth();await tick();assert.equal(f.state.logins,2);
 fresh.resolve();await Promise.all([second,third]);await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,2);
});

test('file rotation during login is detected even without another auth call',async t=>{
 const f=await fixture(t),gate=deferred();f.state.login=()=>gate.promise;
 const request=assert.rejects(f.vault.auth(),/identity changed/);await tick();await f.rotate(credentials('B'));gate.resolve();await request;
 f.state.login=async()=>null;await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,2);assert.equal(f.state.reads,1);
});

test('configure cannot expose its new token before atomic file publication',async t=>{
 const f=await fixture(t);await f.vault.read(scope,'EXAMPLE');const entered=deferred(),commit=deferred(),rename=fs.rename;
 fs.rename=async(source,target)=>{if(target===f.file){entered.resolve();await commit.promise;}return rename(source,target);};
 t.after(()=>{fs.rename=rename;commit.resolve();});
 const configuring=f.vault.configure(credentials('B'));await entered.promise;
 await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,2);
 commit.resolve();await configuring;fs.rename=rename;
 await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,2);
 assert.ok(f.vault.status().clientId===credentials('B').clientId);
});

test('failed configure authentication or persistence leaves previous identity usable',async t=>{
 const f=await fixture(t);await f.vault.read(scope,'EXAMPLE');
 f.state.login=async()=>new Response('{}',{status:401});await assert.rejects(f.vault.configure(credentials('B')),e=>e.vaultStatus===401);
 await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,2);
 f.state.login=async()=>null;const rename=fs.rename;fs.rename=async(source,target)=>{if(target===f.file)throw Object.assign(Error('fixture write refused'),{code:'EACCES'});return rename(source,target);};
 try{await assert.rejects(f.vault.configure(credentials('B')),e=>e.code==='EACCES');}finally{fs.rename=rename;}
 await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,3);assert.ok(f.vault.status().clientId===credentials('A').clientId);
 await f.vault.configure(credentials('B'));await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,4);
});

test('successful configuration invalidates a pending old-identity authentication',async t=>{
 const f=await fixture(t),gate=deferred();f.state.login=async c=>{if(c.clientId===credentials('A').clientId)await gate.promise;};
 const first=assert.rejects(f.vault.auth(),/identity changed/);await tick();await f.vault.configure(credentials('B'));gate.resolve();await first;
 await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,2);
});

test('same-identity configuration invalidates earlier flight by generation, not just identity',async t=>{
 const f=await fixture(t),gate=deferred();f.state.login=async(_,n)=>{if(n===1)await gate.promise;};
 const pending=assert.rejects(f.vault.auth(),/identity changed/);await tick();
 await f.vault.configure(credentials('A'));gate.resolve();await pending;
 await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,2);
 assert.deepEqual(Object.keys(f.vault.status()).sort(),['authenticatedUntil','clientId','configured','expiresAt','origin','provider']);
});

test('identity removal and restoration cannot revive an earlier authentication flight',async t=>{
 const f=await fixture(t),gate=deferred();f.state.login=async(_,n)=>{if(n===1)await gate.promise;};
 const pending=assert.rejects(f.vault.auth(),/identity changed/);await tick();
 await fs.unlink(f.file);await assert.rejects(f.vault.auth(),/Connect the external vault/);
 await f.rotate(credentials('A'));await f.vault.auth();gate.resolve();await pending;
 await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,2);
});

test('configuration commits are ordered and cannot overwrite a newer token with an older identity',async t=>{
 const f=await fixture(t),entered=deferred(),commit=deferred(),rename=fs.rename;let commits=0;
 fs.rename=async(source,target)=>{if(target===f.file&&++commits===1){entered.resolve();await commit.promise;}return rename(source,target);};
 t.after(()=>{fs.rename=rename;commit.resolve();});
 const first=f.vault.configure(credentials('B'));await entered.promise;
 const second=f.vault.configure(credentials('C'));await tick();assert.equal(f.state.logins,1);
 commit.resolve();await Promise.all([first,second]);fs.rename=rename;
 await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.logins,2);assert.ok(f.vault.status().clientId===credentials('C').clientId);
});

test('provider secret-read errors propagate without automatic replay or secret-value caching',async t=>{
 const f=await fixture(t);f.state.read=async()=>new Response('{}',{status:401});
 await assert.rejects(f.vault.read(scope,'EXAMPLE'),e=>e.vaultStatus===401);assert.equal(f.state.logins,1);assert.equal(f.state.reads,1);
 f.state.read=async()=>null;await f.vault.read(scope,'EXAMPLE');assert.equal(f.state.reads,2);assert.equal(f.state.logins,1);
});
