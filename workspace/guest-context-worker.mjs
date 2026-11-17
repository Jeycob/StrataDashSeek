// Serialized into the trusted guest executor. No invocation occurs on host.
// root/rewrite are explicit synthetic-test seams, never request fields.
export async function guestContextWorker(input,root='/workspace',rewrite){
 const fs=require('node:fs/promises'),C=require('node:fs').constants,path=require('node:path'),crypto=require('node:crypto');
 const fail=code=>{throw Error(code);},hash=text=>crypto.createHash('sha256').update(text).digest('hex');
 const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink].join(':');
 root=path.resolve(root);
 const relative=p=>{if(typeof p!=='string'||!p||p.includes('\0')||p.includes('\\')||path.isAbsolute(p)||p.length>4096||p.split('/').some(x=>!x||x==='.'||x==='..'))fail('INVALID_CONTEXT_PATH');return p;};
 async function read(p,optional=false){
  relative(p);let at=root;
  try{
   for(const part of p.split('/').slice(0,-1)){at=path.join(at,part);const s=await fs.lstat(at);if(!s.isDirectory()||s.isSymbolicLink())fail('CONTEXT_LINK_REFUSED');}
   const file=path.join(root,p),fd=await fs.open(file,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
   try{const before=await fd.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>1048576n)fail('CONTEXT_FILE_LIMIT');
    const bytes=Buffer.alloc(Number(before.size)+1);let used=0;
    while(used<bytes.length){const row=await fd.read(bytes,used,bytes.length-used,used);if(!row.bytesRead)break;used+=row.bytesRead;}
    const named=await fs.lstat(file,{bigint:true});if(used!==Number(before.size)||stamp(await fd.stat({bigint:true}))!==stamp(before)||stamp(named)!==stamp(before)||named.isSymbolicLink())fail('CONTEXT_FILE_CHANGED');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used));if(text.includes('\0'))fail('CONTEXT_BINARY');return{text,sha256:hash(text)};
   }finally{await fd.close();}
  }catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
 }
 function git(args,limit){const value=require('node:child_process').spawnSync('/usr/bin/git',['--no-optional-locks','--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','credential.helper=',...args],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},encoding:'utf8',timeout:3000,killSignal:'SIGKILL',maxBuffer:limit});return!value.error&&!value.signal&&value.status===0?value.stdout:null;}
 if(input.kind==='focus'){
  let files=input.files??[],changedFiles=[];if(!Array.isArray(files)||files.length>6)fail('CONTEXT_FILE_COUNT');
  if(!files.length){const status=git(['status','--porcelain=v1','-z','--untracked-files=normal'],8000);
   if(status){const rows=status.split('\0');for(let i=0;i<rows.length;i++){const row=rows[i];if(!row)continue;const name=row.slice(3);if(/^[RC]/.test(row))i++;if(!/(?:^|\/)(?:\.harness|node_modules|\.git|dist|build|bin|obj)(?:\/|$)/.test(name)&&/\.(?:[cm]?js|jsx|tsx?|py|cs|css|html|json|md)$/.test(name))changedFiles.push(name);}files=changedFiles.slice(0,3).map(p=>({path:p,lines:40}));}
  }
  const excerpts=[];let remaining=16000;
  for(const file of files){if(!file||Object.keys(file).some(k=>!['path','start','lines'].includes(k))||!Number.isInteger(file.start??1)||(file.start??1)<1||!Number.isInteger(file.lines??60)||(file.lines??60)<1||(file.lines??60)>120)fail('CONTEXT_RANGE_INVALID');
   const current=await read(file.path,true);if(!current){excerpts.push({path:file.path,deleted:true});continue;}
   const all=current.text.split(/\r?\n/),start=file.start??1,selected=all.slice(start-1,start-1+(file.lines??60)).map((line,i)=>(start+i)+': '+line).join('\n'),content=selected.slice(0,Math.min(6000,remaining));remaining-=content.length;
   excerpts.push({path:file.path,sha256:current.sha256,start,totalLines:all.length,content,truncated:content.length<selected.length});if(!remaining)break;
  }
  return{workspace:'/workspace',excerpts,changedFiles:changedFiles.slice(0,128),changes:(git(['diff','--no-ext-diff','--no-textconv','--stat','--no-renames','HEAD','--','.'],2500)??'No committed Git baseline available.').trim(),note:'Guest snapshot only. Hashes bind one-use rewrite explanations.'};
 }
 if(input.kind==='hash'){const current=await read(input.path);return{path:input.path,sha256:current.sha256};}
 if(input.kind==='admit'){
  if(!Array.isArray(input.operations)||input.operations.length!==1)fail('REWRITE_SINGLE_FILE_REQUIRED');
  const op=input.operations[0],current=await read(op.path,true);let large=false;
  if(current){
   if(input.name==='apply_patch'){const lines=current.text.split(/\r?\n/).length,removed=op.deleted?lines:op.removed;large=removed>=40&&removed/lines>.45;}
   else{let after=input.arguments.content;
    if(input.name==='edit'){const old=input.arguments.old_string,replacement=input.arguments.new_string;if(typeof old!=='string'||!old||typeof replacement!=='string')fail('REWRITE_EDIT_INVALID');after=input.arguments.replace_all?current.text.split(old).join(replacement):current.text.replace(old,()=>replacement);}
    large=rewrite(current.text,after).large;
   }
  }
  return{checks:[{path:op.path,sha256:current?.sha256??null,large}]};
 }
 fail('CONTEXT_OPERATION_INVALID');
}
