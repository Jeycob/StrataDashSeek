import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {confined,digest,runProgram} from '../quality/core.mjs';

export async function focusContext(workspace, request={}) {
  const root=await fs.realpath(workspace),files=request.files??[];
  if(!Array.isArray(files)||files.length>6)throw Error('Request at most six relevant files.');
  const excerpts=[];let remaining=16000;
  for(const file of files){
    if(typeof file.path!=='string'||!Number.isInteger(file.start??1)||!Number.isInteger(file.lines??60)||(file.start??1)<1||(file.lines??60)<1||(file.lines??60)>120)throw Error('Use project-relative files, a positive start and 1–120 lines.');
    const name=await confined(root,file.path),stat=await fs.stat(name);
    if(!stat.isFile()||stat.size>1024*1024)throw Error('Excerpts require regular files up to1MiB.');
    const text=await fs.readFile(name,'utf8');if(text.includes('\0'))throw Error('Binary excerpts are not supported.');
    const all=text.split(/\r?\n/u),start=file.start??1;
    const content=all.slice(start-1,start-1+(file.lines??60)).map((s,i)=>`${start+i}: ${s}`).join('\n').slice(0,Math.min(6000,remaining));
    remaining-=content.length;excerpts.push({path:file.path,sha256:digest(text),start,totalLines:all.length,content,truncated:content.length>=6000||remaining<=0});
    if(remaining<=0)break;
  }
  const git=await runProgram(['git','--no-pager','-c','core.fsmonitor=false','diff','--no-ext-diff','--no-textconv','--stat','--no-renames','HEAD','--','.'],{cwd:root,timeoutMs:3000,outputLimit:2500});
  return {workspace:root,excerpts,changes:git.exitCode===0?git.stdout.trim():'No committed Git baseline available.',note:'Snapshot only. Use the file hash for a justified large rewrite; read more explicit ranges when needed.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await focusContext(process.argv[2],JSON.parse(process.argv[3]??'{}'))));}
  catch(error){console.log(JSON.stringify({error:error.message}));process.exitCode=1;}
}
