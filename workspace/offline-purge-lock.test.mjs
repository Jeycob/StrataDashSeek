import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {lockSessionDirectory} from './offline-purge-sdk.mjs';
const scope=process.env.HARNESS_PURGE_SDK_SCOPE|| (process.env.HARNESS_NATIVE_CLI?path.resolve(path.dirname(process.env.HARNESS_NATIVE_CLI),'../..'):null);
test('actual SDK POSIX flock excludes another process and releases on holder death without replacing inode',{skip:process.platform!=='linux'||!scope,timeout:10000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'offline-purge-lock-')),file=path.join(root,'session.lock');await fs.writeFile(file,'');const before=await fs.stat(file);let holder;
 t.after(async()=>{holder?.kill('SIGKILL');assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('offline-purge-lock-'));await fs.rm(root,{recursive:true,force:true});});
 const source=`import {lockSessionDirectory} from ${JSON.stringify(new URL('./offline-purge-sdk.mjs',import.meta.url).href)};const held=await lockSessionDirectory(process.argv[1],process.argv[2]);console.log('READY');setInterval(()=>{},1000);`;
 holder=spawn(process.execPath,['--input-type=module','-e',source,root,scope],{env:{...process.env},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{let err='';const timer=setTimeout(()=>reject(Error('Holder startup timeout')),4000);holder.stderr.on('data',c=>err+=c);holder.stdout.once('data',()=>{clearTimeout(timer);resolve();});holder.once('exit',code=>{clearTimeout(timer);reject(Error('Holder exited '+code+': '+err));});});
 await assert.rejects(lockSessionDirectory(root,scope),e=>['EAGAIN','EWOULDBLOCK'].includes(e.code));
 await new Promise(resolve=>{holder.once('exit',resolve);holder.kill('SIGKILL');});holder=null;
 const after=await lockSessionDirectory(root,scope);await after.release();assert.equal((await fs.stat(file)).ino,before.ino);
});
