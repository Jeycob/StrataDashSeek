import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {apply} from './lifecycle.mjs';
test('concurrent turns remain protected through tool gaps and one turn ending',()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'harness-lifecycle-')),'state.json');const handlers={};apply({on(name,fn){handlers[name]=fn;}},{file});const state=()=>JSON.parse(fs.readFileSync(file));const a={},b={};
 try{handlers['session/event'](a,{type:'turn/start'});handlers['session/event'](b,{type:'turn/start'});assert.equal(state().active,2);handlers['session/event'](a,{type:'tool/call'});assert.equal(state().active,2);handlers['session/event'](a,{type:'turn/end'});assert.equal(state().active,1);handlers['session/event'](b,{type:'tool/result'});assert.equal(state().active,1);handlers['session/event'](b,{type:'turn/end'});assert.equal(state().active,0);}finally{handlers.dispose();}
});
