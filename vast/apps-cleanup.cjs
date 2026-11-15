'use strict';
// Only disposable copies owned by the application service are eligible. Never
// traverse projects, Docker volumes/images, caches, credentials or passed releases.
const fs=require('node:fs/promises'),path=require('node:path');
const ID=/^[a-f0-9]{16}$/,terminal=j=>['passed','failed','interrupted'].includes(j?.status);
async function directory(root,relative){
 const target=path.resolve(root,relative);if(target===root||!target.startsWith(root+path.sep))throw Error('Cleanup target escaped application state');
 let cursor=root;for(const part of path.relative(root,target).split(path.sep)){cursor=path.join(cursor,part);try{const st=await fs.lstat(cursor);if(st.isSymbolicLink()||!st.isDirectory())return null;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 if(await fs.realpath(target)!==target)throw Error('Cleanup directory changed');return target;
}
async function removeTree(root,relative){const target=await directory(root,relative);if(!target)return false;
 // Refuse symlinks anywhere in a candidate, including links to other projects.
 async function check(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const st=await fs.lstat(path.join(dir,e.name));if(st.isSymbolicLink()||!st.isDirectory()&&!st.isFile())throw Error('Cleanup candidate contains a link or special file');if(st.isDirectory())await check(path.join(dir,e.name));}}
 await check(target);if(await directory(root,relative)!==target)throw Error('Cleanup directory changed');await fs.rm(target,{recursive:true});return true;
}
async function cleanupTemporary(manager){
 if(manager.previewRequests)return{removed:0,skipped:'active-transfer'};
 const root=path.resolve(manager.cfg.stateDir),real=await fs.realpath(root);if(real!==root||(await fs.lstat(root)).isSymbolicLink())throw Error('Cleanup requires a canonical application state directory');
 const before=await fs.statfs(root),active=new Set(manager.store.jobs.filter(j=>!terminal(j)).map(j=>j.id));if(ID.test(manager.busy||''))active.add(manager.busy);
 const protectedReleases=new Set(Object.values(manager.store.projects).flatMap(p=>[p.releaseId]).filter(Boolean));
 let removed=0;const skipped=[];
 const drop=async relative=>{try{if(await removeTree(root,relative))removed++;}catch{skipped.push(relative);}};
 for(const j of manager.store.jobs){if(!ID.test(j.id)||active.has(j.id)||!terminal(j))continue;
  await drop('build-'+j.id);
  await drop(path.join('exports',j.id+'-metadata'));
  if(j.status!=='passed'){
   const file=path.join(root,'exports',j.id+'.tar.gz');try{const parent=await directory(root,'exports'),st=parent&&await fs.lstat(file);if(st?.isFile()&&!st.isSymbolicLink()){await fs.unlink(file);removed++;}}catch(e){if(e.code!=='ENOENT')skipped.push('partial-export');}
  }
 }
 const releases=await directory(root,'releases');if(releases)for(const project of await fs.readdir(releases)){if(!ID.test(project))continue;const parent=await directory(root,path.join('releases',project));if(!parent)continue;
  for(const id of await fs.readdir(parent)){if(!ID.test(id)||active.has(id)||protectedReleases.has(id))continue;const relative=path.join('releases',project,id),dir=await directory(root,relative);if(!dir)continue;
   try{const report=path.join(dir,'release.json'),st=await fs.lstat(report);if(!st.isFile()||st.isSymbolicLink()||st.size>2*1024**2)continue;const r=JSON.parse(await fs.readFile(report,'utf8'));
    if(r.id!==id||r.projectId!==project||r.status!=='failed'||!Number.isFinite(r.completedAt))continue;
    // Keep release.json and browser evidence. Source copies cannot be rolled
    // back after failure; preserve their .harness evidence directory in place.
    await drop(path.join(relative,'current'));
    const source=await directory(root,path.join(relative,'source'));if(source)for(const name of await fs.readdir(source)){if(name==='.harness')continue;const rel=path.join(relative,'source',name),file=path.join(root,rel),s=await fs.lstat(file);if(s.isSymbolicLink())continue;if(s.isDirectory())await drop(rel);else if(s.isFile()){await fs.unlink(file);removed++;}}
   }catch{skipped.push(relative);}
  }
 }
 const after=await fs.statfs(root);return{at:Date.now(),removed,reclaimedBytes:Math.max(0,after.bavail*after.bsize-before.bavail*before.bsize),skippedCount:skipped.length,policy:'temporary-copies-only-v1'};
}
function capacityStatus(cfg,stat){const freeBytes=stat.bavail*stat.bsize,requiredBytes=cfg.minFreeBytes+512*1024**2;return{freeBytes,minFreeBytes:cfg.minFreeBytes,requiredVerifyBytes:requiredBytes,deficitBytes:Math.max(0,requiredBytes-freeBytes)};}
async function ensureCapacity(manager,extra=512*1024**2,job){
 const free=()=>fs.statfs(manager.cfg.stateDir);let stat=await free();const required=manager.cfg.minFreeBytes+extra;
 if(stat.bavail*stat.bsize<required){manager.lastCleanup=await cleanupTemporary(manager);if(job)manager.log(job,'Automatic temporary cleanup: '+JSON.stringify(manager.lastCleanup)+'\n');stat=await free();}
 const available=stat.bavail*stat.bsize;if(available<required)throw Error('Insufficient disk reserve: '+available+' bytes free; '+required+' required; '+(required-available)+' bytes missing after safe temporary cleanup. Sources, credentials, successful releases and Docker data were preserved. Waking Docker does not free host storage.');
}
module.exports={cleanupTemporary,ensureCapacity,capacityStatus};
