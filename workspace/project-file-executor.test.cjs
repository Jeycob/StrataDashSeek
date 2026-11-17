'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn,spawnSync}=require('node:child_process');
async function fixture(t){
 const {createProjectFileHandlers}=await import('./project-file-executor.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-file-worker-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const calls=[];
 const execute=async(args,execution)=>{
  calls.push({args,execution});assert.equal(args.workdir,'.');assert.equal(args.timeoutMs,30000);assert(args.command.length<65536);assert(args.command.startsWith('/opt/code-server/lib/node -e '));
  // Local synthetic runtime seam only: replace fixed Node path and fixed root
  // inside the quoted helper. Production provides neither override.
  let command=args.command.replace('/opt/code-server/lib/node',"'"+process.execPath+"'").replace("root = '\\''/workspace'\\''",'root = '+JSON.stringify(root));
  if(process.env.HOMEAI_TEST_RG)command=command.replace("'\\''/usr/bin/rg'\\''",JSON.stringify(process.env.HOMEAI_TEST_RG));
  return new Promise((resolve,reject)=>{
   const child=spawn('/bin/sh',['-c',command],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
   child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('exit',(code,signal)=>resolve({result:{exitCode:code,signal,timedOut:false,aborted:false,stdout:{text:stdout,truncated:false},stderr:{text:stderr,truncated:false}}}));
  });
 };
 const handlers=createProjectFileHandlers(execute,{executionBinding:(await import('./fixtures/execution-binding.mjs')).isolatedExecutionBinding(),beforeMutation:async()=>({})}),execution={agent:{id:'actual-child'},signal:new AbortController().signal};
 const call=(name,args)=>handlers[name]({name,arguments:args,project:{ownerId:'owner',root:'/trusted/projects/one'}},execution);
 return{root,calls,handlers,execution,call};
}
test('prepared guest commands preserve UTF8 read windows, writes, exact edits and inert shell metacharacters',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),content="žluťoučký\n$(touch /tmp/SHOULD_NOT_RUN); `id` ' \"\nlast\n";
 await f.call('write',{file_path:'/trusted/projects/one/src/example.txt',content});
 assert.equal(await fs.readFile(path.join(f.root,'src/example.txt'),'utf8'),content);
 const read=await f.call('read',{file_path:'/workspace/src/example.txt',offset:2,limit:1});assert(read.text.includes('2: $(touch'));assert.equal(read.truncated,true);
 await f.call('edit',{file_path:'src/example.txt',old_string:'last',new_string:'changed'});
 assert((await fs.readFile(path.join(f.root,'src/example.txt'),'utf8')).endsWith('changed\n'));
 assert.equal(f.calls[0].execution,f.execution);
});
test('outside absolute paths and traversal fail before dispatch; missing operations have no handler',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);
 for(const file_path of ['/etc/passwd','/trusted/projects/other/a','/workspace/../secret','../other','a/../../x'])await assert.rejects(f.call('read',{file_path}));
 assert.equal(f.calls.length,0);for(const name of ['read_image','str_replace_editor'])assert.equal(f.handlers[name],undefined);
});
test('strict single-file patches add/update/delete with full preflight and reject unsupported/ambiguous input',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);
 const patch=body=>f.call('apply_patch',{patch:'*** Begin Patch\n'+body+'*** End Patch\n'});
 await patch('*** Add File: src/new.txt\n+first\n+middle\n+last\n');assert.equal(await fs.readFile(path.join(f.root,'src/new.txt'),'utf8'),'first\nmiddle\nlast\n');
 await patch('*** Update File: src/new.txt\n@@\n first\n-middle\n+changed\n last\n');assert.equal(await fs.readFile(path.join(f.root,'src/new.txt'),'utf8'),'first\nchanged\nlast\n');
 await assert.rejects(patch('*** Update File: src/new.txt\n@@\n-not present\n+changed\n'));
 await assert.rejects(patch('*** Add File: a\n+x\n*** Add File: b\n+y\n'));await assert.rejects(fs.stat(path.join(f.root,'a')));
 await assert.rejects(patch('*** Add File: ../outside\n+x\n'));
 await assert.rejects(patch('*** Update File: src/new.txt\n*** Move to: other\n@@\n-first\n+x\n'));
 assert.equal(await fs.readFile(path.join(f.root,'src/new.txt'),'utf8'),'first\nchanged\nlast\n');
 await patch('*** Delete File: src/new.txt\n');await assert.rejects(fs.stat(path.join(f.root,'src/new.txt')));
});
test('actual guest ripgrep preserves regex/glob syntax, ignores VCS for glob and bounds inline results',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.root,'src'));await fs.mkdir(path.join(f.root,'.git'));
 await fs.writeFile(path.join(f.root,'src/a.js'),'Alpha42\nBeta99\n');await fs.writeFile(path.join(f.root,'src/b.ts'),'Alpha88\n');await fs.writeFile(path.join(f.root,'.git/private'),'Alpha66');
 const files=await f.call('glob',{pattern:'**/*.{js,ts}',path:'/workspace'});assert(files.text.includes('src/a.js'));assert(files.text.includes('src/b.ts'));assert(!files.text.includes('.git/private'));
 const matches=await f.call('grep',{pattern:'Alpha[0-9]{2}',include:'*.js',path:'/trusted/projects/one'});assert(matches.text.includes('Alpha42'));assert(!matches.text.includes('Alpha88'));
 const none=await f.call('grep',{pattern:'NO_MATCH'});assert(none.text.includes('(no matches)'));
 await fs.writeFile(path.join(f.root,'src/many.txt'),('matched\n').repeat(250));const capped=await f.call('grep',{pattern:'matched'});assert.equal(capped.truncated,true);
 await assert.rejects(f.call('grep',{pattern:'['}));
 await fs.symlink('src',path.join(f.root,'linked'));await assert.rejects(f.call('glob',{pattern:'*',path:'linked'}));
});
test('guest worker rejects symlinks, hardlinks, FIFO, binary and ambiguous edits',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.root,'source'),'same same');await fs.symlink('source',path.join(f.root,'link'));await fs.link(path.join(f.root,'source'),path.join(f.root,'hard'));
 for(const file_path of ['source','link','hard'])await assert.rejects(f.call('write',{file_path,content:'no'}));
 await fs.unlink(path.join(f.root,'hard'));
 await assert.rejects(f.call('edit',{file_path:'source',old_string:'same',new_string:'new'}));
 assert.equal(await fs.readFile(path.join(f.root,'source'),'utf8'),'same same');
 await f.call('edit',{file_path:'source',old_string:'same',new_string:'new',replace_all:true});
 assert.equal(await fs.readFile(path.join(f.root,'source'),'utf8'),'new new');
 await fs.chmod(path.join(f.root,'source'),0o750);await f.call('write',{file_path:'source',content:'executable'});assert.equal((await fs.stat(path.join(f.root,'source'))).mode&0o777,0o750);
 assert.equal(spawnSync('mkfifo',[path.join(f.root,'pipe')]).status,0);await assert.rejects(f.call('read',{file_path:'pipe'}));
 await fs.writeFile(path.join(f.root,'expansion'),'x'.repeat(100000));await assert.rejects(f.call('edit',{file_path:'expansion',old_string:'x',new_string:'large'.repeat(100),replace_all:true}));
 await fs.writeFile(path.join(f.root,'binary'),Buffer.from([0,255]));await assert.rejects(f.call('read',{file_path:'binary'}));
 await fs.mkdir(path.join(f.root,'dir'));await fs.symlink('dir',path.join(f.root,'linked-dir'));
 await assert.rejects(f.call('write',{file_path:'linked-dir/new',content:'no'}));
});
test('bounded command/result and aborted runner cannot return successful file outcomes',async()=>{
 const {createProjectFileHandlers}=await import('./project-file-executor.mjs');let count=0;
 const request={name:'write',arguments:{file_path:'a',content:'x'.repeat(40000)},project:{root:'/trusted/project',ownerId:'one'}},execution={signal:new AbortController().signal};
 const handlers=createProjectFileHandlers(async()=>{count++;return{result:{exitCode:0,stdout:{text:'{}',truncated:false}}};},{executionBinding:(await import('./fixtures/execution-binding.mjs')).isolatedExecutionBinding(),beforeMutation:async()=>({})});
 await assert.rejects(handlers.write(request,execution));assert.equal(count,0);
 request.arguments.content='small';await assert.rejects(handlers.write(request,execution));assert.equal(count,1);
 const controller=new AbortController();controller.abort();await assert.rejects(handlers.write(request,{signal:controller.signal}));assert.equal(count,1);
 assert.throws(()=>createProjectFileHandlers(),/BINDING_REQUIRED/);
});
