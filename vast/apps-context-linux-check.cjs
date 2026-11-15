'use strict';
// Production Linux proof: swap the canonical directory after the last path
// check and before the actual write. No Docker, networking or GPU is involved.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {scaffold}=require('./apps-scaffold.cjs');
(async()=>{
 assert.equal(process.platform,'linux');const base=await fs.mkdtemp(path.join(os.tmpdir(),'harness-app-fd-race-')),a=path.join(base,'a'),b=path.join(base,'b'),moved=path.join(base,'a-original');await fs.mkdir(a);await fs.mkdir(b);for(const dir of [a,b])await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({scripts:{start:'node server.js'}}));const id=crypto.createHash('sha256').update(await fs.realpath(a)).digest('hex').slice(0,16),write=fs.writeFile;let swapped=false;
 try{
  const descriptors=(await fs.readdir('/proc/self/fd')).length;
  fs.writeFile=async function(file,...args){if(!swapped&&String(file).startsWith('/proc/self/fd/')&&path.basename(String(file))==='Dockerfile'){swapped=true;await fs.rename(a,moved);await fs.symlink(b,a,'dir');}return write.call(this,file,...args);};
  try{await assert.rejects(scaffold('a',{workspaceRoot:base},id),e=>e.code==='PROJECT_CONTEXT_MISMATCH');}finally{fs.writeFile=write;}
  assert(swapped);assert.deepEqual(await fs.readdir(b),['package.json']);assert.deepEqual(await fs.readdir(moved),['package.json']);assert.equal((await fs.readdir('/proc/self/fd')).length,descriptors);
  await fs.unlink(a);await fs.rename(moved,a);const positive=await scaffold('a',{workspaceRoot:base},id);assert.equal(JSON.parse(positive.files['.harness-app.json']).name,'a');assert.equal(JSON.stringify(positive).includes('/proc/self/fd/'),false);
  console.log(JSON.stringify({platform:process.platform,passed:5,checks:['post-check directory swap cannot write other project','rollback stays in held directory','directory descriptors close','bound scaffold succeeds','private plan target stays off API'],gpuRequests:0}));
 }finally{fs.writeFile=write;const target=path.resolve(base);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('harness-app-fd-race-'));await fs.rm(target,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
