'use strict';
// This helper runs INSIDE a restricted Docker container, with only one source
// volume (read-only) and one fresh target volume. Never open tenant databases
// in the privileged Harness process.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {constants}=require('node:fs'),{DatabaseSync,backup}=require('node:sqlite');
const fail=code=>Object.assign(Error(code),{code});
const filename=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function root(directory){
 const absolute=path.resolve(directory),canonical=await fs.realpath(absolute),stat=await fs.lstat(absolute);
 if(canonical!==absolute||!stat.isDirectory()||stat.isSymbolicLink())throw fail('SQLITE_VOLUME_UNSAFE');
 return{directory:absolute,stat};
}
async function regular(file){
 const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
 try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1)throw fail('SQLITE_FILE_UNSAFE');return{handle,stat};}catch(error){await handle.close();throw error;}
}
async function inventory(directory,database,maxBytes){
 const allowed=new Set([database,database+'-wal',database+'-shm',database+'-journal']);let bytes=0;
 for(const name of await fs.readdir(directory)){
  if(!allowed.has(name))throw fail('SQLITE_VOLUME_CONTENT_UNSUPPORTED');
  const{handle,stat}=await regular(path.join(directory,name));await handle.close();bytes+=stat.size;
  if(bytes>maxBytes)throw fail('SQLITE_SNAPSHOT_SIZE_LIMIT');
 }
 return bytes;
}
function schema(db){
 const rows=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
 return digest({rows,userVersion:db.prepare('PRAGMA user_version').get().user_version,applicationId:db.prepare('PRAGMA application_id').get().application_id});
}
async function inspectSqlite({sourceRoot,database,maxBytes=64*1024**2}){
 if(!filename.test(database||'')||!Number.isSafeInteger(maxBytes)||maxBytes<4096||maxBytes>256*1024**2)throw fail('SQLITE_SNAPSHOT_POLICY_INVALID');
 const source=await root(sourceRoot);await inventory(source.directory,database,maxBytes);
 const file=path.join(source.directory,database),opened=await regular(file);let db;
 try{
  db=new DatabaseSync(file,{readOnly:true,timeout:100,allowExtension:false,defensive:true});db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
  const now=await fs.lstat(file);if(now.isSymbolicLink()||now.dev!==opened.stat.dev||now.ino!==opened.stat.ino)throw fail('SQLITE_SOURCE_CHANGED');
  const pageSize=db.prepare('PRAGMA page_size').get().page_size,pageCount=db.prepare('PRAGMA page_count').get().page_count;
  if(!Number.isSafeInteger(pageSize*pageCount)||pageSize*pageCount>maxBytes)throw fail('SQLITE_SNAPSHOT_SIZE_LIMIT');
  if(db.prepare('PRAGMA quick_check(1)').get().quick_check!=='ok')throw fail('SQLITE_SOURCE_CORRUPT');
  return{source,file,opened,db,pageSize,pageCount,schemaHash:schema(db)};
 }catch(error){db?.close();await opened.handle.close();throw error;}
}
async function snapshotSqlite({sourceRoot,targetRoot,database,maxBytes=64*1024**2,timeoutMs=15000,expectedSchemaHash}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||expectedSchemaHash!==undefined&&!/^[a-f0-9]{64}$/.test(expectedSchemaHash))throw fail('SQLITE_SNAPSHOT_POLICY_INVALID');
 const target=await root(targetRoot),source=await root(sourceRoot);
 if(source.stat.dev===target.stat.dev&&source.stat.ino===target.stat.ino)throw fail('SQLITE_VOLUME_ALIAS');
 if((await fs.readdir(target.directory)).length)throw fail('SQLITE_TARGET_NOT_EMPTY');
 const input=await inspectSqlite({sourceRoot,database,maxBytes}),until=Date.now()+timeoutMs;
 let output,temporary=path.join(target.directory,'.snapshot-'+crypto.randomUUID()),published=false;
 const destination=path.join(target.directory,database);
 try{
  if(expectedSchemaHash&&input.schemaHash!==expectedSchemaHash)throw fail('SQLITE_SCHEMA_CHANGE_UNSUPPORTED');
  output=await fs.open(temporary,'wx',0o600);await output.close();output=null;
  await backup(input.db,temporary,{rate:32,progress({totalPages}){if(Date.now()>until)throw fail('SQLITE_SNAPSHOT_TIMEOUT');if(totalPages*input.pageSize>maxBytes)throw fail('SQLITE_SNAPSHOT_SIZE_LIMIT');}});
  const after=await fs.lstat(input.file);if(after.isSymbolicLink()||after.nlink!==1||after.dev!==input.opened.stat.dev||after.ino!==input.opened.stat.ino)throw fail('SQLITE_SOURCE_CHANGED');
  await inventory(source.directory,database,maxBytes);
  const verify=new DatabaseSync(temporary,{timeout:100,allowExtension:false,defensive:true});let schemaHash;
  // Online backup includes committed WAL pages in the new database. Normalize
  // the new file to DELETE mode before publishing, without copying WAL/SHM.
  try{verify.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');if(verify.prepare('PRAGMA quick_check(1)').get().quick_check!=='ok')throw fail('SQLITE_SNAPSHOT_CORRUPT');schemaHash=schema(verify);}finally{verify.close();}
  if(schemaHash!==input.schemaHash||expectedSchemaHash&&schemaHash!==expectedSchemaHash)throw fail('SQLITE_SCHEMA_CHANGE_UNSUPPORTED');
  const currentTarget=await fs.lstat(target.directory);if(currentTarget.dev!==target.stat.dev||currentTarget.ino!==target.stat.ino||(await fs.readdir(target.directory)).some(name=>path.join(target.directory,name)!==temporary))throw fail('SQLITE_TARGET_CHANGED');
  output=await fs.open(temporary,constants.O_RDWR|(constants.O_NOFOLLOW||0));const stat=await output.stat();
  if(!stat.isFile()||stat.nlink!==1||stat.size>maxBytes)throw fail('SQLITE_SNAPSHOT_SIZE_LIMIT');
  if(process.platform!=='win32'){await output.chown(input.opened.stat.uid,input.opened.stat.gid);await output.chmod(input.opened.stat.mode&0o666);}
  await output.sync();await output.close();output=null;
  // link is exclusive; it cannot overwrite an existing database after a race.
  await fs.link(temporary,destination);published=true;await fs.unlink(temporary);temporary=null;
  if(process.platform!=='win32'){await fs.chown(target.directory,source.stat.uid,source.stat.gid);await fs.chmod(target.directory,source.stat.mode&0o777);const directory=await fs.open(target.directory,constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}}
  return{version:1,kind:'sqlite-online-backup',database,bytes:stat.size,schemaHash};
 }catch(error){
  // Never remove a published generation. Its state is reconciled by the journal.
  await output?.close();output=null;
  if(!published&&temporary)await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});throw error;
 }finally{await output?.close();input.db.close();await input.opened.handle.close();}
}
async function inspectPolicy(options){const input=await inspectSqlite(options);try{return{version:1,database:options.database,schemaHash:input.schemaHash,bytes:input.pageSize*input.pageCount};}finally{input.db.close();await input.opened.handle.close();}}
module.exports={snapshotSqlite,inspectPolicy};
if(require.main===module){let options;try{options=JSON.parse(process.argv[2]);}catch{process.stderr.write('SQLITE_SNAPSHOT_POLICY_INVALID\n');process.exitCode=1;}
 if(options)(options.inspect?inspectPolicy(options):snapshotSqlite(options)).then(value=>process.stdout.write(JSON.stringify(value)+'\n'),error=>{process.stderr.write(/^[A-Z0-9_]{1,80}$/.test(error.code||'')?error.code+'\n':'SQLITE_SNAPSHOT_FAILED\n');process.exitCode=1;});
}
