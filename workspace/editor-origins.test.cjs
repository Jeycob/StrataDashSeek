'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const{EditorOrigins}=require('./editor-origins.cjs');
test('origin assignments survive restarts and cannot be recycled or silently changed with configuration',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'editor-origins-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'origins.json'),config={ownerOrigin:'https://owner.test',endpoints:[{origin:'https://owner.test:19443',listenerPort:29443},{origin:'https://owner.test:19444',listenerPort:29444}]};
 const first=new EditorOrigins(file,config),a=first.allocate('A');assert.equal(a.origin,config.endpoints[0].origin);a.origin='https://attacker.test';assert.notEqual(first.allocate('A').origin,a.origin);
 const second=new EditorOrigins(file,{...config,endpoints:[...config.endpoints].reverse()});assert.equal(second.allocate('A').origin,config.endpoints[0].origin);assert.equal(second.allocate('B').origin,config.endpoints[1].origin);assert.throws(()=>second.allocate('C'),{code:'EDITOR_ORIGIN_CAPACITY'});
 assert.throws(()=>new EditorOrigins(file,{...config,endpoints:[config.endpoints[0]]}),{code:'EDITOR_ORIGIN_CONFIGURATION_CHANGED'});
});
test('owner origin, duplicate listener and duplicate or linked registry are refused',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'editor-origins-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'origins.json'),config={ownerOrigin:'https://owner.test',endpoints:[{origin:'https://owner.test:19443',listenerPort:29443}]};
 for(const endpoints of[[{origin:config.ownerOrigin,listenerPort:29443}],[config.endpoints[0],{origin:'https://owner.test:19444',listenerPort:29443}]])assert.throws(()=>new EditorOrigins(file,{...config,endpoints}),{code:'EDITOR_ORIGINS_INVALID'});
 await fs.writeFile(file,JSON.stringify({version:1,assignments:{A:config.endpoints[0],B:config.endpoints[0]}}));assert.throws(()=>new EditorOrigins(file,config),{code:'EDITOR_ORIGIN_CONFIGURATION_CHANGED'});
});
