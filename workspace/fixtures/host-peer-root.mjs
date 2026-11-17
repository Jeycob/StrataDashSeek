// Qualification fixture only; Root prepares the empty outer directory first.
import fs from 'node:fs/promises';
import path from 'node:path';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const same=(a,b)=>['dev','ino','uid','gid','mode'].every(key=>a[key]===b[key]);
export async function createPreparedPeerRun(approved,{uid,gid},files=fs){
 need(Number.isSafeInteger(uid)&&uid>0&&Number.isSafeInteger(gid)&&gid>=0,'PEER_FIXTURE_NONROOT_REQUIRED');
 need(typeof approved==='string'&&/^\/var\/lib\/homeai-host-peer-fixture-[A-Za-z0-9]{12}$/.test(approved),'PEER_FIXTURE_PREPARED_ROOT_REQUIRED');
 async function directoryInfo(directory){
  need(await files.realpath(directory)===directory,'PEER_FIXTURE_CANONICAL_ROOT_REQUIRED');const info=await files.lstat(directory);
  need(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===uid&&info.gid===gid&&(info.mode&0o7777)===0o700,'PEER_FIXTURE_PRIVATE_OWNER_REQUIRED');return info;
 }
 const before=await directoryInfo(approved);need((await files.readdir(approved)).length===0,'PEER_FIXTURE_FRESH_EMPTY_ROOT_REQUIRED');
 const directory=await files.mkdtemp(approved+'/run-');
 need(path.posix.dirname(directory)===approved&&/^run-[A-Za-z0-9]{6}$/.test(path.posix.basename(directory)),'PEER_FIXTURE_RUN_PATH_INVALID');
 const identity=await directoryInfo(directory);need(same(before,await directoryInfo(approved)),'PEER_FIXTURE_OUTER_CHANGED');
 return Object.freeze({directory,async cleanup(){
  // Caller must first settle its own sockets/SDK job. No outer or unknown run
  // is removed, even if the expected child was replaced or disappeared.
  need(same(before,await directoryInfo(approved))&&same(identity,await directoryInfo(directory)),'PEER_FIXTURE_RUN_CHANGED');
  await files.rm(directory,{recursive:true,force:false});
 }});
}
