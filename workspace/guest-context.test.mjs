import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {guestContextWorker} from './guest-context-worker.mjs';
import {projectFileWorker} from './project-file-worker.mjs';
import {rewriteRisk} from '../efficiency/context.mjs';
import {projectRelativePath,createProjectFileHandlers} from './project-file-executor.mjs';
import {executionBindingFixture} from './fixtures/execution-binding.mjs';
const require=createRequire(import.meta.url),context=Function('require','return ('+guestContextWorker.toString()+')')(require),files=Function('require','return ('+projectFileWorker.toString()+')')(require),hash=s=>crypto.createHash('sha256').update(s).digest('hex');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-context-worker-'));t.after(async()=>{const real=await fs.realpath(root);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('homeai-context-worker-'));await fs.rm(real,{recursive:true,force:true});});return{root,context:input=>context(input,root,rewriteRisk),files:input=>files(input,root)};}
test('serialized metadata worker returns bounded UTF8 excerpts and current hashes, never binary or traversal',async t=>{
 const f=await fixture(t),text='žluťoučký '+('x'.repeat(200))+'\n';await fs.writeFile(path.join(f.root,'a.js'),text.repeat(200));
 const value=await f.context({kind:'focus',files:[{path:'a.js',start:2,lines:120}]});assert.equal(value.excerpts[0].sha256,hash(text.repeat(200)));assert.equal(value.excerpts[0].start,2);assert.equal(value.excerpts[0].truncated,true);assert(value.excerpts[0].content.length<=6000);
 await assert.rejects(f.context({kind:'hash',path:'../outside'}),/INVALID_CONTEXT_PATH/);await assert.rejects(f.context({kind:'focus',files:[{path:'a.js',lines:121}]}),/CONTEXT_RANGE_INVALID/);
 await fs.writeFile(path.join(f.root,'binary'),Buffer.from([0,0xff]));await assert.rejects(f.context({kind:'hash',path:'binary'}));
 await fs.writeFile(path.join(f.root,'huge'),'x'.repeat(1048577));await assert.rejects(f.context({kind:'hash',path:'huge'}),/CONTEXT_FILE_LIMIT/);
});
test('metadata worker uses the existing T06 line/byte rewrite rule and literal patch deletion counts',async t=>{
 const f=await fixture(t),before='old source line\n'.repeat(80);await fs.writeFile(path.join(f.root,'a.js'),before);
 for(const input of [{name:'write',arguments:{content:'replacement'},operations:[{path:'a.js'}]},{name:'edit',arguments:{old_string:'old source line',new_string:'new',replace_all:true},operations:[{path:'a.js'}]},{name:'apply_patch',arguments:{},operations:[{path:'a.js',deleted:true,removed:0}]}]){const value=await f.context({kind:'admit',...input});assert.equal(value.checks[0].large,true);assert.equal(value.checks[0].sha256,hash(before));}
 assert.equal((await f.context({kind:'admit',name:'write',arguments:{content:'new'},operations:[{path:'new.js'}]})).checks[0].sha256,null);
});
test('actual serialized file worker rechecks trusted before-hash for write/edit/patch/delete and missing-file creation',async t=>{
 const f=await fixture(t),before='alpha\nbeta\n';await fs.writeFile(path.join(f.root,'a.js'),before);
 for(const[name,args]of [['write',{file_path:'a.js',content:'replacement'}],['edit',{file_path:'a.js',old_string:'alpha',new_string:'changed'}],['apply_patch',{patch:'*** Begin Patch\n*** Update File: a.js\n@@\n-alpha\n+changed\n beta\n*** End Patch'}],['apply_patch',{patch:'*** Begin Patch\n*** Delete File: a.js\n*** End Patch'}]]){await assert.rejects(f.files({name,arguments:args,expectedSha256:'0'.repeat(64)}),/REWRITE_SOURCE_CHANGED/);assert.equal(await fs.readFile(path.join(f.root,'a.js'),'utf8'),before);}
 await assert.rejects(f.files({name:'write',arguments:{file_path:'a.js',content:'replacement'},expectedSha256:null}),/REWRITE_SOURCE_CHANGED/);
 await f.files({name:'write',arguments:{file_path:'a.js',content:'replacement'},expectedSha256:hash(before)});assert.equal(await fs.readFile(path.join(f.root,'a.js'),'utf8'),'replacement');
 await f.files({name:'write',arguments:{file_path:'new.js',content:'created'},expectedSha256:null});assert.equal(await fs.readFile(path.join(f.root,'new.js'),'utf8'),'created');
});
test('executor confines canonical paths and refuses mutation without a trusted proof callback',async()=>{
 assert.equal(projectRelativePath('/projects/one','/workspace/a.js'),'a.js');assert.equal(projectRelativePath('/projects/one','/projects/one/a.js'),'a.js');
 for(const value of ['../other','a/../b','a//b','./a','/projects/two/a','a\\b'])assert.throws(()=>projectRelativePath('/projects/one',value));
 let calls=0;const f=executionBindingFixture('isolated-guest'),handlers=createProjectFileHandlers(async()=>{calls++;},{executionBinding:f.binding}),execution={signal:new AbortController().signal};await assert.rejects(handlers.write({name:'write',arguments:{file_path:'a.js',content:'changed'},project:{root:'/projects/one'}},execution),/REWRITE_ADMISSION_UNAVAILABLE/);assert.equal(calls,0);
});
test('a binding change while awaiting a mutation proof prevents guest command dispatch',async()=>{
 let calls=0;const f=executionBindingFixture('isolated-guest'),handlers=createProjectFileHandlers(async()=>{calls++;},{executionBinding:f.binding,beforeMutation:async()=>{f.fail();return{expectedSha256:null};}});await assert.rejects(handlers.write({name:'write',arguments:{file_path:'a.js',content:'changed'},project:{root:'/projects/one'}},{signal:new AbortController().signal}),/BINDING_CHANGED/);assert.equal(calls,0);
});
