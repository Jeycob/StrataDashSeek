'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {atomicJson}=require('./private-json.cjs');
test('private JSON replacement sync failures preserve previous data and remove owned staging files',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'private-json-')),file=path.join(root,'state.json'),original=fs.fsyncSync;
 try{atomicJson(file,{version:1});fs.fsyncSync=()=>{throw Error('Fixture sync failure');};assert.throws(()=>atomicJson(file,{version:2}),/sync failure/);fs.fsyncSync=original;assert.deepEqual(JSON.parse(fs.readFileSync(file)),{version:1});assert.deepEqual(fs.readdirSync(root),['state.json']);}
 finally{fs.fsyncSync=original;const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('private-json-'));assert.equal(fs.lstatSync(root).isSymbolicLink(),false);fs.rmSync(resolved,{recursive:true,force:true});}
});
test('private JSON refuses hardlinked targets without modifying the retained inode',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'private-json-')),file=path.join(root,'state.json'),victim=path.join(root,'retained');
 try{fs.writeFileSync(victim,'fixture-retained');fs.linkSync(victim,file);assert.throws(()=>atomicJson(file,{changed:true}),/Unsafe/);assert.equal(fs.readFileSync(victim,'utf8'),'fixture-retained');}
 finally{const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('private-json-'));assert.equal(fs.lstatSync(root).isSymbolicLink(),false);fs.rmSync(resolved,{recursive:true,force:true});}
});
