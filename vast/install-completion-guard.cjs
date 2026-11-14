'use strict';
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const ID='cloud-homeai-completion-guard';
function addGuard(text,yaml){
 const doc=yaml.parseDocument(text);if(doc.errors.length)throw doc.errors[0];
 const rows=doc.contents.items;
 if(rows.some(x=>x.get?.('id')===ID||x.get?.('insert')?.items?.some(y=>y.get?.('id')===ID)))return text;
 rows.push(doc.createNode({insert:[{id:ID,name:'file:///data/harness/app/vast/completion-guard.mjs',config:{providers:['strata-vast'],maxContinuations:2,statusPath:'/data/harness/state/completion-guard.json'}}]}));
 return String(doc);
}
module.exports={addGuard};
if(require.main===module){
 const root='/data/harness',req=createRequire(root+'/runtime/node_modules/@deepseek-ai/dsh/package.json'),yaml=req('yaml'),file=root+'/home/.dsh/profiles/web/cordis.patch.yml';
 const before=fs.readFileSync(file,'utf8'),after=addGuard(before,yaml);
 if(before===after){console.log(JSON.stringify({alreadyInstalled:true}));process.exit(0);}
 const backup=root+'/root-secrets/completion-guard-'+Date.now();fs.mkdirSync(backup,{mode:0o700});fs.writeFileSync(backup+'/cordis.patch.yml',before,{mode:0o600});
 const stat=fs.statSync(file),temp=file+'.completion-guard.tmp';fs.writeFileSync(temp,after,{mode:stat.mode&0o777});fs.chownSync(temp,stat.uid,stat.gid);fs.renameSync(temp,file);
 console.log(JSON.stringify({installed:true,profileOnlyAddedPlugin:true,backupCreated:true,requiresRestart:false}));
}
