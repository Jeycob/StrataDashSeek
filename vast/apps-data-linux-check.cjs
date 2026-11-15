'use strict';
// Explicit production-platform gate; portable test discovery must not silently
// skip the read-only WAL and kernel-lock/crash checks.
const assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
async function child(args,options={}){const process=cp.spawn(args[0],args.slice(1),{stdio:['ignore','pipe','pipe'],...options});let out='',err='';process.stdout.on('data',c=>out+=c);process.stderr.on('data',c=>err+=c);const done=new Promise((resolve,reject)=>{process.once('error',reject);process.once('close',(code,signal)=>resolve({code,signal,out,err}));});return{process,done};}
async function waitFor(fn,timeout=5000){const until=Date.now()+timeout;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Bounded fixture wait expired');}
(async()=>{
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'sdsh-data-linux-'));let active,owner;
 try{
  const source=path.join(directory,'source'),target=path.join(directory,'target');await fsp.chmod(directory,0o755);await fsp.mkdir(source);await fsp.mkdir(target);await fsp.chown(source,65534,65534);await fsp.chown(target,65534,65534);await fsp.chmod(target,0o700);
  active=new DatabaseSync(path.join(source,'app.sqlite'));active.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE orders(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO orders VALUES(1,'committed WAL');");
  for(const name of await fsp.readdir(source)){await fsp.chown(path.join(source,name),65534,65534);await fsp.chmod(path.join(source,name),0o444);}await fsp.chmod(source,0o555);
  const before=new Map((await fsp.readdir(source)).map(name=>[name,fs.readFileSync(path.join(source,name))]));
  const snapshot=await child(['setpriv','--reuid=65534','--regid=65534','--clear-groups','--bounding-set=-all',process.execPath,path.join(__dirname,'apps-sqlite-snapshot.cjs'),JSON.stringify({sourceRoot:source,targetRoot:target,database:'app.sqlite'})]);const result=await snapshot.done;
  assert.equal(result.code,0,result.err);assert.equal(JSON.parse(result.out).kind,'sqlite-online-backup');const copied=new DatabaseSync(path.join(target,'app.sqlite'),{readOnly:true});try{assert.equal(copied.prepare('SELECT value FROM orders WHERE id=1').get().value,'committed WAL');}finally{copied.close();}
  assert.deepEqual((await fsp.readdir(source)).sort(),[...before.keys()].sort());for(const[name,bytes]of before)assert.deepEqual(await fsp.readFile(path.join(source,name)),bytes);
  // Migration must run while the temporary copy is still helper-owned. The
  // helper retains CHOWN only here, with no DAC_OVERRIDE write bypass.
  const migratedTarget=path.join(directory,'migrated');await fsp.mkdir(migratedTarget,{mode:0o700});const sql='ALTER TABLE orders ADD COLUMN note TEXT',migration={sql,sha256:crypto.createHash('sha256').update(sql).digest('hex'),fromVersion:1,toVersion:2};
  const migrationChild=await child(['setpriv','--bounding-set=-all,+chown',process.execPath,path.join(__dirname,'apps-sqlite-snapshot.cjs'),JSON.stringify({sourceRoot:source,targetRoot:migratedTarget,database:'app.sqlite',migration})]),migrationResult=await migrationChild.done;assert.equal(migrationResult.code,0,migrationResult.err);const migrationProof=JSON.parse(migrationResult.out);assert.equal(migrationProof.userVersion,2);assert.equal(migrationProof.existingDataPreserved,true);assert.equal((await fsp.stat(path.join(migratedTarget,'app.sqlite'))).uid,65534);assert.equal((await fsp.stat(migratedTarget)).uid,65534);assert.deepEqual(await fsp.readdir(migratedTarget),['app.sqlite']);for(const[name,bytes]of before)assert.deepEqual(await fsp.readFile(path.join(source,name)),bytes);
  const {scanScript}=require('./apps-worker-footprint.cjs'),nonce='a'.repeat(16),scan=await child(['sh','-c',scanScript(source,nonce)]),scanned=await scan.done;assert.equal(scanned.code,0,scanned.err);const footprint=scanned.out.match(/HARNESS_FOOTPRINT_aaaaaaaaaaaaaaaa=(\d+),(\d+)/);assert(footprint);assert(Number(footprint[1])>0);assert.equal(Number(footprint[2]),before.size+1);
  const special=path.join(directory,'special');await fsp.mkdir(special,{mode:0o755});cp.execFileSync('mkfifo',[path.join(special,'app.sqlite')]);const refused=await child([process.execPath,path.join(__dirname,'apps-sqlite-snapshot.cjs'),JSON.stringify({inspect:true,sourceRoot:special,database:'app.sqlite'})]);const refusal=await refused.done;assert.equal(refusal.code,1);assert.match(refusal.err,/SQLITE_FILE_UNSAFE/);
  // The actual service owner survives a second process's failed attempt. After
  // SIGKILL the next owner recovers by PID/start/boot identity and kernel flock.
  const cfg={stateDir:path.join(directory,'controller')},ownerModule=path.join(__dirname,'apps-service-owner.cjs'),script="const fs=require('node:fs'),http=require('node:http');require(process.argv[1]).ownAppsService(JSON.parse(process.argv[2]),()=>{fs.appendFileSync(process.argv[3],'constructed\\n');return{manager:{busy:null},server:http.createServer()};},{timeoutMs:50}).then(()=>{console.log('OWNED');setInterval(()=>{},1000);},e=>{console.error(e.code);process.exitCode=73;});",marker=path.join(directory,'constructors');
  owner=await child([process.execPath,'-e',script,ownerModule,JSON.stringify(cfg),marker]);await waitFor(()=>fs.existsSync(marker));
  const denied=await child([process.execPath,'-e',script,ownerModule,JSON.stringify(cfg),marker]);const denial=await denied.done;assert.equal(denial.code,73,denial.err);assert.match(denial.err,/LOCK_BUSY/);assert.equal(fs.readFileSync(marker,'utf8'),'constructed\n');
  owner.process.kill('SIGKILL');assert.equal((await owner.done).signal,'SIGKILL');
  owner=await child([process.execPath,'-e',script,ownerModule,JSON.stringify(cfg),marker]);await waitFor(()=>fs.readFileSync(marker,'utf8').split('\n').length===3);owner.process.kill('SIGKILL');await owner.done;owner=null;
  console.log(JSON.stringify({passed:10,checks:['actual UID65534 no capabilities','read-only WAL online backup','committed rows retained','source bytes and files unchanged','combined copy/migration before CHOWN with no DAC_OVERRIDE','FIFO refused without blocking','real filesystem bytes/inode diagnostic','second writer rejected before constructor','actual controller SIGKILL','dead-owner recovery without deleting kernel lock inode'],gpuRequests:0}));
 }finally{
  if(owner){owner.process.kill('SIGKILL');await owner.done;}active?.close();
  // Only this gate's owned fixture; restore its modes before guarded removal.
  const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert(path.basename(target).startsWith('sdsh-data-linux-'));for(const name of['source','target','migrated']){const dir=path.join(target,name);if(fs.existsSync(dir))await fsp.chmod(dir,0o700);}await fsp.rm(target,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
