'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const ID=/^[a-f0-9]{16}$/;
class Releases{
 constructor(root){this.root=root;}
 dir(project,id){if(!ID.test(project)||id!==undefined&&!ID.test(id))throw Error('Invalid release');return path.join(this.root,project,...(id?[id]:[]));}
 async put(project,id,data){const dir=this.dir(project,id);await fs.mkdir(dir,{recursive:true,mode:0o700});const tmp=path.join(dir,'release.'+crypto.randomBytes(6).toString('hex')+'.tmp');await fs.writeFile(tmp,JSON.stringify({...data,id,projectId:project},null,2),{mode:0o600,flag:'wx'});await fs.rename(tmp,path.join(dir,'release.json'));return data;}
 async get(project,id){const dir=this.dir(project,id),st=await fs.lstat(dir);if(st.isSymbolicLink()||!st.isDirectory())throw Error('Invalid release directory');return JSON.parse(await fs.readFile(path.join(dir,'release.json'),'utf8'));}
 async list(project){let names;try{names=await fs.readdir(this.dir(project));}catch(e){if(e.code==='ENOENT')return[];throw e;}const all=[];for(const n of names.filter(n=>ID.test(n))){const r=await this.get(project,n);all.push(r);}return all.sort((a,b)=>b.startedAt-a.startedAt).slice(0,50);}
}
module.exports={Releases};
