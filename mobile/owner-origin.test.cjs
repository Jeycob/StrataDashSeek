'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const{ownerRequestAllowed,ownerResponseHeaders}=require('./owner-origin.cjs');
const origin='https://owner.test';
test('owner browser API and sockets reject sibling origins, missing/null Origin and duplicate auth cookies',()=>{
 const req={url:'/api/session/selectModel',method:'POST',headers:{cookie:'dsh-auth-a=synthetic'}};
 for(const given of [undefined,'null','https://owner.test:19000','https://evil.test'])assert.equal(ownerRequestAllowed({...req,headers:{...req.headers,...(given?{origin:given}:{})}},origin),false);
 assert.equal(ownerRequestAllowed({...req,headers:{...req.headers,origin}},origin),true);
 assert.equal(ownerRequestAllowed({...req,headers:{cookie:'dsh-auth-a=a; dsh-auth-a=b',origin}},origin),false);
 assert.equal(ownerRequestAllowed({url:'/socket',method:'GET',headers:{}},origin,{upgrade:true}),false);
 assert.equal(ownerRequestAllowed({url:'/socket',method:'GET',headers:{origin}},origin,{upgrade:true}),true);
});
test('no-cors sibling reads fail while normal owner downloads and read-only internal calls remain usable',()=>{
 for(const url of ['/api/workbench','/phone/api/apps/state','/api/workbench/download?path=x'])assert.equal(ownerRequestAllowed({url,method:'GET',headers:{'sec-fetch-site':'same-site',cookie:'dsh-auth-a=a'}},origin),false);
 assert.equal(ownerRequestAllowed({url:'/api/workbench/download?path=x',method:'GET',headers:{'sec-fetch-site':'same-origin',cookie:'dsh-auth-a=a'}},origin),true);
 assert.equal(ownerRequestAllowed({url:'/api/workbench/health',method:'GET',headers:{}},origin),true);
});
test('owner cookies cannot become domain-scoped or script-readable through the outer bridge',()=>{
 const h=ownerResponseHeaders({'set-cookie':['dsh-auth-a=value; Domain=owner.test; Path=/old; SameSite=Lax','prefs=dark'],'access-control-allow-origin':'*'});
 assert.equal(h['set-cookie'][0],'dsh-auth-a=value; Path=/; HttpOnly; Secure; SameSite=Strict');assert.equal(h['access-control-allow-origin'],undefined);assert.equal(h['origin-agent-cluster'],'?1');
});
