import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceManifest, saveCheckpoint } from './storage.mjs';
test('checkpoint checks opened fd after an ancestor is redirected outside the project', {skip:process.platform!=='linux'}, async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-checkpoint-race-')),root=path.join(directory,'project'),outside=path.join(directory,'private');
  t.after(async()=>{t.mock.restoreAll();const real=await fs.realpath(directory);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('homeai-checkpoint-race-'));await fs.rm(real,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'sub'),{recursive:true});await fs.mkdir(outside);await fs.writeFile(path.join(root,'sub','source.txt'),'public');await fs.writeFile(path.join(outside,'source.txt'),'PRIVATE_CANARY');
  const original=fs.open.bind(fs);let redirected=false;t.mock.method(fs,'open',async(file,...args)=>{
    if(!redirected&&file===path.join(root,'sub','source.txt')){redirected=true;await fs.rename(path.join(root,'sub'),path.join(root,'held'));await fs.symlink(outside,path.join(root,'sub'));}
    return original(file,...args);
  });
  await assert.rejects(sourceManifest(root),{code:'CHECKPOINT_CHANGED'});assert(redirected);
});

test('checkpoint capture rejects a redirected ancestor even when outside bytes match its manifest', {skip:process.platform!=='linux'}, async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-checkpoint-race-')),root=path.join(directory,'project'),outside=path.join(directory,'private'),destination=path.join(directory,'checkpoint');
  t.after(async()=>{t.mock.restoreAll();const real=await fs.realpath(directory);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('homeai-checkpoint-race-'));await fs.rm(real,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'sub'),{recursive:true});await fs.mkdir(outside);
  // Equal bytes ensure that hash validation cannot hide a containment failure.
  await fs.writeFile(path.join(root,'sub','source.txt'),'same bytes');await fs.writeFile(path.join(outside,'source.txt'),'same bytes');
  const manifest=await sourceManifest(root),original=fs.open.bind(fs);let redirected=false;
  t.mock.method(fs,'open',async(file,...args)=>{
    if(!redirected&&file===path.join(root,'sub','source.txt')){redirected=true;await fs.rename(path.join(root,'sub'),path.join(root,'held'));await fs.symlink(outside,path.join(root,'sub'));}
    return original(file,...args);
  });
  await assert.rejects(saveCheckpoint(root,destination,manifest,{minFreeBytes:0}),{code:'CHECKPOINT_CHANGED'});assert(redirected);
  assert.equal((await fs.readdir(directory)).some(name=>name.startsWith('checkpoint')),false,'failed capture leaves no partial generation');
});
