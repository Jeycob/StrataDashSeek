'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const ID=/^[a-f0-9]{16}$/;
const {atomicJson}=require('../mobile/private-json.cjs');
class Releases{
 constructor(root){this.root=root;}
 dir(project,id){if(!ID.test(project)||id!==undefined&&!ID.test(id))throw Error('Invalid release');return path.join(this.root,project,...(id?[id]:[]));}
 async put(project,id,data){const dir=this.dir(project,id);await fs.mkdir(dir,{recursive:true,mode:0o700});atomicJson(path.join(dir,'release.json'),{...data,id,projectId:project});return data;}
 async get(project,id){const dir=this.dir(project,id),st=await fs.lstat(dir),file=path.join(dir,'release.json');if(st.isSymbolicLink()||!st.isDirectory())throw Error('Invalid release directory');const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>2*1024*1024)throw Error('Invalid release report');return JSON.parse(await fs.readFile(file,'utf8'));}
 async list(project){let names;try{names=await fs.readdir(this.dir(project));}catch(e){if(e.code==='ENOENT')return[];throw e;}const all=[];for(const n of names.filter(n=>ID.test(n))){try{const r=await this.get(project,n);all.push({id:r.id,projectId:r.projectId,kind:r.kind||'container',status:r.status,startedAt:r.startedAt,completedAt:r.completedAt,source:r.source,checks:r.checks,error:r.error,previousReleaseId:r.previousReleaseId,rollbackOf:r.rollbackOf,browser:r.browser?{coverage:r.browser.coverage,passed:r.browser.passed,failed:r.browser.failed,screenshotCount:r.browser.screenshots?.length||0}:null});}catch(e){if(e.code!=='ENOENT')throw e;}}return all.sort((a,b)=>b.startedAt-a.startedAt).slice(0,50);}
}
module.exports={Releases};
