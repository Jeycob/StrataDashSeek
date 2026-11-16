// This function's source executes ONLY inside A's isolated project executor.
// The optional root parameter is an internal synthetic-test seam, never wired
// to command input. Production invocation supplies only the decoded request.
export async function projectFileWorker(input, root = '/workspace') {
  const fs = require('node:fs/promises'), C = require('node:fs').constants;
  const path = require('node:path'), crypto = require('node:crypto');
  const fail = code => { throw Error(code); };
  const MAX = 1024 * 1024;
  const fingerprint = s => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink].join(':');
  if (['glob','grep'].includes(input.name)) {
    const args=input.arguments,target=args.path??'.';
    if(typeof target!=='string'||!target||target.includes('\\')||target.includes('\0')||path.isAbsolute(target)||target.split('/').includes('..'))fail('INVALID_SEARCH_PATH');
    if(typeof args.pattern!=='string'||!args.pattern.trim()||args.pattern.length>4096||args.pattern.includes('\0'))fail('INVALID_SEARCH_PATTERN');
    if(args.include!==undefined&&(typeof args.include!=='string'||!args.include||args.include.startsWith('!')||args.include.length>4096||args.include.includes('\0')))fail('INVALID_SEARCH_INCLUDE');
    let at=root;
    for(const part of path.relative(root,path.resolve(root,target)).split('/').filter(Boolean)){
      at=path.join(at,part);const info=await fs.lstat(at);if(info.isSymbolicLink())fail('PROJECT_LINK_REFUSED');
    }
    const flags=['--no-config','--no-follow','--max-depth=64'];
    if(input.name==='glob')flags.push('--files','--null','--glob='+args.pattern,'--sort=modified','--no-ignore','--hidden',...['.git','.hg','.svn'].flatMap(name=>['--glob=!**/'+name,'--glob=!**/'+name+'/**']));
    else {flags.push('--json','--regexp='+args.pattern);if(args.include!==undefined)flags.push('--glob='+args.include);}
    flags.push('--',target);
    const result=require('node:child_process').spawnSync('/usr/bin/rg',flags,{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8'},encoding:'utf8',timeout:15000,killSignal:'SIGKILL',maxBuffer:1024*1024});
    if(result.error||result.signal||![0,1].includes(result.status))fail('BOUNDED_SEARCH_FAILED');
    let lines;
    if(input.name==='glob')lines=result.stdout.split('\0').filter(Boolean).map(p=>JSON.stringify(p));
    else lines=result.stdout.split('\n').filter(Boolean).flatMap(line=>{
      const record=JSON.parse(line);if(record.type!=='match')return[];
      const data=record.data;if(!data||typeof data.path?.text!=='string'||!Number.isInteger(data.line_number))fail('SEARCH_RECORD_INVALID');
      return [JSON.stringify(data.path.text)+':'+data.line_number+': '+(typeof data.lines?.text==='string'?data.lines.text.replace(/\r?\n$/,''):'(non-UTF8 line)')];
    });
    let text='',kept=0;
    for(const line of lines){if(kept>=200||Buffer.byteLength(text+line)>65536)break;text+=line+'\n';kept++;}
    return{text:'[isolated search: maximum traversal depth 64; inline limit 200 results/64KiB]\n'+(text||'(no matches)'),truncated:kept<lines.length};
  }
  if (!['read','write','edit'].includes(input.name)) fail('UNSUPPORTED_FILE_OPERATION');
  const args=input.arguments, relative=args.file_path;
  if (typeof relative!=='string'||!relative||relative.length>4096||relative.includes('\0')||relative.includes('\\')||path.isAbsolute(relative)||relative.split('/').some(p=>p==='..')) fail('INVALID_PROJECT_PATH');
  const full=path.resolve(root,relative);
  if (!full.startsWith(root+'/')) fail('INVALID_PROJECT_PATH');
  // No symlink components at inspection time. OS mount isolation remains the
  // security boundary against concurrent ancestor replacement by project code.
  let parent=root;
  const parts=path.relative(root,full).split('/');
  for(const part of parts.slice(0,-1)) {
    parent=path.join(parent,part);
    let info;try{info=await fs.lstat(parent);}catch(error){if(error.code!=='ENOENT'||input.name!=='write')throw error;await fs.mkdir(parent,{mode:0o700});info=await fs.lstat(parent);}
    if(!info.isDirectory()||info.isSymbolicLink())fail('PROJECT_LINK_REFUSED');
  }
  async function snapshot(optional=false) {
    let fd;
    try {fd=await fs.open(full,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
    try {
      const before=await fd.stat({bigint:true});
      if(!before.isFile()||before.nlink!==1n||before.size>BigInt(MAX))fail('UNSUPPORTED_FILE_TYPE_OR_SIZE');
      // Never readFile an attacker-growing file into an unbounded allocation.
      const bytes=Buffer.alloc(MAX+1);let count=0;
      while(count<bytes.length){const read=await fd.read(bytes,count,bytes.length-count,null);if(!read.bytesRead)break;count+=read.bytesRead;}
      if(count>MAX||fingerprint(await fd.stat({bigint:true}))!==fingerprint(before))fail('PROJECT_FILE_CHANGED_OR_LIMIT');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count));
      if(text.includes('\0'))fail('BINARY_FILE_UNSUPPORTED');
      return {text,stamp:fingerprint(before),mode:Number(before.mode & 0o777n)};
    } finally {await fd.close();}
  }
  if(input.name==='read') {
    const current=await snapshot();
    const offset=args.offset??1,limit=args.limit??2000;
    if(!Number.isInteger(offset)||offset<1||!Number.isInteger(limit)||limit<1||limit>2000)fail('INVALID_READ_WINDOW');
    const lines=current.text.split('\n');if(lines.at(-1)==='')lines.pop();
    let text='',truncated=false;
    for(let i=offset-1;i<Math.min(lines.length,offset-1+limit);i++){
      const line=String(i+1)+': '+lines[i]+'\n';
      if(Buffer.byteLength(text+line)>65536){truncated=true;break;}text+=line;
    }
    truncated ||= offset-1+limit<lines.length;
    return {text:text||'(empty read window)',truncated};
  }
  const before=await snapshot(input.name==='write');
  let content=args.content;
  if(input.name==='edit') {
    if(typeof args.old_string!=='string'||!args.old_string||typeof args.new_string!=='string'||args.replace_all!==undefined&&typeof args.replace_all!=='boolean')fail('INVALID_EDIT');
    const occurrences=before.text.split(args.old_string).length-1;
    if(occurrences===0||!args.replace_all&&occurrences!==1)fail('EDIT_MATCH_NOT_UNIQUE_OR_MISSING');
    const replacements=args.replace_all?occurrences:1;
    if(Buffer.byteLength(before.text)+replacements*(Buffer.byteLength(args.new_string)-Buffer.byteLength(args.old_string))>MAX)fail('EDIT_RESULT_SIZE_LIMIT');
    content=args.replace_all?before.text.split(args.old_string).join(args.new_string):before.text.replace(args.old_string,()=>args.new_string);
  }
  if(typeof content!=='string'||Buffer.byteLength(content)>MAX||content.includes('\0'))fail('WRITE_CONTENT_LIMIT_OR_BINARY');
  let temp,fd;
  try {
    temp=path.join(path.dirname(full),'.homeai-write-'+crypto.randomBytes(16).toString('hex'));
    fd=await fs.open(temp,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
    if(before)await fd.chmod(before.mode);
    await fd.writeFile(content);await fd.sync();await fd.close();fd=null;
    let latest;try{latest=await fs.lstat(full,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    if(before ? !latest||fingerprint(latest)!==before.stamp : latest)fail('PROJECT_FILE_CHANGED');
    await fs.rename(temp,full);temp=null;
    return {text:input.name==='edit'?'Edited project file.':'Wrote project file.',truncated:false};
  } finally {if(fd)await fd.close();if(temp)await fs.unlink(temp).catch(()=>{});}
}
