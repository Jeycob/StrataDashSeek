// Run each regression file in its own bounded process. Never hide a failed exit
// behind a passing TAP summary or leave a hung HTTP fixture holding the release.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runProgram,parseTestCounts} from '../quality/core.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=path.resolve(process.argv[2]??path.join(os.tmpdir(),'stratadashseek-checks-'+Date.now()));
const env={...process.env},runtime=env.HOMEAI_RUNTIME??path.join(root,'runtime'),modules=path.join(runtime,'node_modules');
env.HOMEAI_RUNTIME=runtime;env.EFFICIENCY_SDK_ROOT??=modules;
env.NODE_PATH=[modules,env.NODE_PATH].filter(Boolean).join(path.delimiter);
for(const [key,name]of [['HARNESS_WEB_PUSH_MODULE','web-push'],['HARNESS_PLAYWRIGHT_MODULE','playwright']])if(!env[key])try{await fs.access(path.join(modules,name,'package.json'));env[key]=path.join(modules,name);}catch{}
const startedAt=Date.now(),files=[];
async function sourceHash(){
  const git=await runProgram(['git','ls-files','-z'],{cwd:root,timeoutMs:5000,outputLimit:1024*1024});if(git.exitCode!==0)throw Error('Tracked release sources are unavailable.');
  const names=git.stdout.split('\0').filter(name=>/\.(?:[cm]?js|py|json|ya?ml|html|css)$/u.test(name)&&!/^deployments\/release-[^/]+\//u.test(name)).sort(),hash=crypto.createHash('sha256');
  for(const name of names){hash.update(name+'\0');hash.update((await fs.readFile(path.join(root,name),'utf8')).replaceAll('\r\n','\n'));hash.update('\0');}
  return{sha256:hash.digest('hex'),files:names.length,definition:'Sorted tracked JS/Python/config/UI paths and LF-normalized UTF-8 content; release evidence excluded.'};
}
const before=await sourceHash();
async function visit(relative){for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){const name=path.join(relative,entry.name);if(entry.isDirectory())await visit(name);else if(entry.isFile()&&/\.test\.(?:cjs|mjs)$/u.test(name))files.push(name);}}
for(const directory of ['cloudflare','desktop','efficiency','mobile','quality','vast','workspace'])await visit(directory);
await fs.mkdir(output,{recursive:true});files.sort();let cursor=0;
const results=[];
await Promise.all(Array.from({length:3},async()=>{while(cursor<files.length){const file=files[cursor++],run=await runProgram([process.execPath,'--test','--test-timeout=30000','--test-reporter=tap',file],{cwd:root,env,timeoutMs:45000,outputLimit:1024*1024}),counts=parseTestCounts(run.stdout);
  const log=file.replaceAll(path.sep,'__')+'.tap';await fs.writeFile(path.join(output,log),run.stdout+'\n[stderr]\n'+run.stderr);
  results.push({file:file.split(path.sep).join('/'),passed:run.exitCode===0&&!run.timedOut&&!run.error&&counts?.failed===0&&counts.passed>0,exitCode:run.exitCode,timedOut:run.timedOut,counts,skipped:Number(run.stdout.match(/(?:^|\n)# skipped (\d+)/u)?.[1]??0),log,...(run.error?{error:run.error}:{})});
}}));
results.sort((a,b)=>a.file.localeCompare(b.file));const after=await sourceHash(),stale=before.sha256!==after.sha256;
const report={startedAt,finishedAt:Date.now(),platform:process.platform,node:process.version,outputDirectory:output,source:after,stale,passed:!stale&&results.every(r=>r.passed),files:results.length,passedTests:results.reduce((n,r)=>n+(r.counts?.passed??0),0),failedTests:results.reduce((n,r)=>n+(r.counts?.failed??0),0),skippedTests:results.reduce((n,r)=>n+r.skipped,0),results};
await fs.writeFile(path.join(output,'node-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exitCode=report.passed?0:1;
