'use strict';
// This helper runs INSIDE a restricted Docker container, with only one source
// volume (read-only) and one fresh target volume. Never open tenant databases
// in the privileged Harness process.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {constants}=require('node:fs'),{DatabaseSync,backup,constants:SQL}=require('node:sqlite');
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
function quiescentProof(value){
 if(value===undefined)return false;
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||value.noRunningWriters!==true||Object.keys(value).sort().join(',')!=='noRunningWriters,version')throw fail('SQLITE_QUIESCENT_PROOF_REQUIRED');
 return true;
}
const sameFile=(a,b)=>['dev','ino','nlink','size','mode','uid','gid','mtimeMs','ctimeMs'].every(key=>a[key]===b[key]);
async function sourceHash(handle,maxBytes,until,copy){
 const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(64*1024);let position=0;
 for(;;){if(Date.now()>until)throw fail('SQLITE_SNAPSHOT_TIMEOUT');const{bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,maxBytes-position+1),position);if(!bytesRead)break;position+=bytesRead;if(position>maxBytes)throw fail('SQLITE_SNAPSHOT_SIZE_LIMIT');hash.update(buffer.subarray(0,bytesRead));if(copy){let written=0;while(written<bytesRead){const result=await copy.write(buffer,written,bytesRead-written,position-bytesRead+written);if(!result.bytesWritten)throw fail('SQLITE_SCRATCH_COPY_FAILED');written+=result.bytesWritten;}}}
 return hash.digest('hex');
}
async function unchanged(input){
 const current=await root(input.source.directory),names=(await fs.readdir(current.directory)).sort();
 if(!sameFile(current.stat,input.source.stat)||names.length!==1||names[0]!==input.database||!sameFile(await fs.lstat(input.file),input.opened.stat)||!sameFile(await input.opened.handle.stat(),input.opened.stat)||await sourceHash(input.opened.handle,input.maxBytes,input.until)!==input.sourceHash)throw fail('SQLITE_SOURCE_CHANGED');
}
async function releaseInput(input,originalError){
 const errors=[];try{input.db?.close();}catch(e){errors.push(e);}
 if(input.scratch)try{if(input.sourceHash)await unchanged(input);}catch(e){errors.push(e);}
 try{await input.opened?.handle.close();}catch(e){errors.push(e);}
 if(input.scratch)try{const stat=await fs.lstat(input.scratch.directory);if(stat.isSymbolicLink()||stat.dev!==input.scratch.stat.dev||stat.ino!==input.scratch.stat.ino)throw fail('SQLITE_SCRATCH_CHANGED');await fs.rm(input.scratch.directory,{recursive:true,force:false});}catch(e){errors.push(e);}
 if(errors.length){const error=errors[0];if(originalError){originalError.cleanupFailed=true;originalError.cleanupErrorCode=/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'SQLITE_SCRATCH_CLEANUP_FAILED';}else throw error;}
}
async function inspectSqlite({sourceRoot,database,maxBytes=64*1024**2,quiescentSource,scratchRoot='/scratch'},{readOnly=true}={}){
 if(!filename.test(database||'')||!Number.isSafeInteger(maxBytes)||maxBytes<4096||maxBytes>256*1024**2)throw fail('SQLITE_SNAPSHOT_POLICY_INVALID');
 const quiescent=quiescentProof(quiescentSource),source=await root(sourceRoot);await inventory(source.directory,database,maxBytes);
 const file=path.join(source.directory,database),opened=await regular(file),input={source,file,opened,database,maxBytes,until:Date.now()+15000};let db;
 try{
  const header=Buffer.alloc(20);await opened.handle.read(header,0,header.length,0);
  const names=await fs.readdir(source.directory),mainOnly=names.length===1&&names[0]===database,walHeader=header.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))&&header[18]===2&&header[19]===2;
  let inspectedFile=file;
  if(readOnly&&mainOnly&&walHeader&&!quiescent)throw fail('SQLITE_QUIESCENT_PROOF_REQUIRED');
  if(readOnly&&quiescent&&mainOnly&&walHeader){
   // The adapter has just excluded every running RW mount. Never use this path
   // with WAL/SHM/journal files: their committed pages must use online backup.
   const scratch=await root(scratchRoot);if(scratch.stat.dev===source.stat.dev&&scratch.stat.ino===source.stat.ino||process.platform!=='win32'&&((scratch.stat.mode&0o777)!==0o700||typeof process.getuid==='function'&&scratch.stat.uid!==process.getuid()))throw fail('SQLITE_SCRATCH_UNSAFE');
   const directory=await fs.mkdtemp(path.join(scratch.directory,'sqlite-ro-'));input.scratch={directory,stat:await fs.lstat(directory)};
   inspectedFile=path.join(directory,database);const copy=await fs.open(inspectedFile,'wx',0o600);
   try{input.sourceHash=await sourceHash(opened.handle,maxBytes,input.until,copy);await copy.sync();}finally{await copy.close();}
   await unchanged(input);
  }
  // A private, bounded copy may create its own WAL-index files. The mounted
  // source is always read-only, including this quiescent path; no immutable URI.
  const beforeOpen=await fs.lstat(file);if(!sameFile(beforeOpen,opened.stat)||beforeOpen.isSymbolicLink())throw fail('SQLITE_SOURCE_CHANGED');
  db=new DatabaseSync(inspectedFile,{readOnly:readOnly&&!input.scratch,timeout:100,allowExtension:false,defensive:true});input.db=db;db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
  const now=await fs.lstat(file);if(now.isSymbolicLink()||now.dev!==opened.stat.dev||now.ino!==opened.stat.ino)throw fail('SQLITE_SOURCE_CHANGED');
  const pageSize=db.prepare('PRAGMA page_size').get().page_size,pageCount=db.prepare('PRAGMA page_count').get().page_count;
  if(!Number.isSafeInteger(pageSize*pageCount)||pageSize*pageCount>maxBytes)throw fail('SQLITE_SNAPSHOT_SIZE_LIMIT');
  if(db.prepare('PRAGMA quick_check(1)').get().quick_check!=='ok')throw fail('SQLITE_SOURCE_CORRUPT');
  return Object.assign(input,{pageSize,pageCount,schemaHash:schema(db)});
 }catch(error){await releaseInput(input,error);throw error;}
}
async function snapshotSqlite({sourceRoot,targetRoot,database,maxBytes=64*1024**2,timeoutMs=15000,expectedSchemaHash,migration,quiescentSource,scratchRoot='/scratch'}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||expectedSchemaHash!==undefined&&!/^[a-f0-9]{64}$/.test(expectedSchemaHash))throw fail('SQLITE_SNAPSHOT_POLICY_INVALID');
 const target=await root(targetRoot),source=await root(sourceRoot);
 if(source.stat.dev===target.stat.dev&&source.stat.ino===target.stat.ino)throw fail('SQLITE_VOLUME_ALIAS');
 if((await fs.readdir(target.directory)).length)throw fail('SQLITE_TARGET_NOT_EMPTY');
 const input=await inspectSqlite({sourceRoot,database,maxBytes,quiescentSource,scratchRoot}),until=Date.now()+timeoutMs;
 let output,temporary=path.join(target.directory,'snapshot-'+crypto.randomUUID()+'.sqlite'),published=false,failure;
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
  let migrationProof;
  if(migration){migrationProof=await migrateSqlite({...migration,targetRoot:target.directory,database:path.basename(temporary),maxBytes,expectedSourceSchemaHash:input.schemaHash});schemaHash=migrationProof.schemaHash;}
  const currentTarget=await fs.lstat(target.directory);if(currentTarget.dev!==target.stat.dev||currentTarget.ino!==target.stat.ino||(await fs.readdir(target.directory)).some(name=>path.join(target.directory,name)!==temporary))throw fail('SQLITE_TARGET_CHANGED');
  output=await fs.open(temporary,constants.O_RDWR|(constants.O_NOFOLLOW||0));const stat=await output.stat();
  if(!stat.isFile()||stat.nlink!==1||stat.size>maxBytes)throw fail('SQLITE_SNAPSHOT_SIZE_LIMIT');
  if(process.platform!=='win32')await output.chmod(input.opened.stat.mode&0o666);
  await output.sync();
  // link is exclusive; it cannot overwrite an existing database after a race.
  await fs.link(temporary,destination);published=true;await fs.unlink(temporary);temporary=null;
  // Publish the helper-owned inode before CHOWN: protected_hardlinks correctly
  // refuses linking someone else's read-only file without CAP_FOWNER. Keep the
  // original FD for CHOWN/fsync; no write or ownership-bypass capability needed.
  if(process.platform!=='win32')await output.chown(input.opened.stat.uid,input.opened.stat.gid);
  await output.sync();await output.close();output=null;
  if(process.platform!=='win32'){const directory=await fs.open(target.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.chmod(source.stat.mode&0o777);await directory.chown(source.stat.uid,source.stat.gid);await directory.sync();}finally{await directory.close();}}
  return{version:1,kind:'sqlite-online-backup',database,bytes:stat.size,schemaHash,...(migrationProof?{sourceSchemaHash:input.schemaHash,userVersion:migrationProof.userVersion,migrationSha256:migrationProof.migrationSha256,existingDataPreserved:true}:{})};
 }catch(error){
  failure=error;
  // Never remove a published generation. Its state is reconciled by the journal.
  try{await output?.close();}catch(cleanup){error.cleanupFailed=true;error.cleanupErrorCode=cleanup.code||'SQLITE_SCRATCH_CLEANUP_FAILED';}output=null;
  if(!published&&temporary)await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT'){error.cleanupFailed=true;error.cleanupErrorCode=e.code||'SQLITE_SCRATCH_CLEANUP_FAILED';}});throw error;
 }finally{try{await output?.close();}catch(error){if(!failure){await releaseInput(input,error);throw error;}failure.cleanupFailed=true;failure.cleanupErrorCode=error.code||'SQLITE_SCRATCH_CLEANUP_FAILED';}await releaseInput(input,failure);}
}
async function inspectPolicy(options,access){const input=await inspectSqlite(options,access);let failure;try{return{version:1,database:options.database,schemaHash:input.schemaHash,userVersion:input.db.prepare('PRAGMA user_version').get().user_version,uid:input.opened.stat.uid,gid:input.opened.stat.gid,bytes:input.pageSize*input.pageCount};}catch(error){failure=error;throw error;}finally{await releaseInput(input,failure);}}
const quote=name=>'"'+name.replaceAll('"','""')+'"';
function existingData(db,definition){
 const tables=definition||db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>({name:row.name,columns:db.prepare('PRAGMA table_xinfo('+quote(row.name)+')').all()}));
 if(tables.length>64)throw fail('SQLITE_MIGRATION_LIMIT');const out=[];let total=0;
 for(const table of tables){
  if(!table.columns.length||table.columns.length>128)throw fail('SQLITE_MIGRATION_LIMIT');
  const current=db.prepare('PRAGMA table_xinfo('+quote(table.name)+')').all();if(JSON.stringify(current.slice(0,table.columns.length))!==JSON.stringify(table.columns))throw fail('SQLITE_MIGRATION_DATA_CHANGE');
  const statement=db.prepare('SELECT '+table.columns.map(col=>quote(col.name)).join(',')+' FROM '+quote(table.name));statement.setReadBigInts(true);let count=0,sum=0n,xor=0n;
  for(const row of statement.iterate()){
   if(++total>250000)throw fail('SQLITE_MIGRATION_LIMIT');const hash=crypto.createHash('sha256');
   for(const column of table.columns){const value=row[column.name],type=value===null?'null':value instanceof Uint8Array?'blob':typeof value,bytes=value===null?Buffer.alloc(0):value instanceof Uint8Array?Buffer.from(value):Buffer.from(String(value));if(bytes.length>1024**2)throw fail('SQLITE_MIGRATION_LIMIT');hash.update(type+':'+bytes.length+':');hash.update(bytes);}
   const value=BigInt('0x'+hash.digest('hex'));sum=(sum+value)&((1n<<256n)-1n);xor^=value;count++;
  }
  out.push({name:table.name,columns:table.columns,count,sum:sum.toString(16),xor:xor.toString(16)});
 }
 return out;
}
async function migrateSqlite({targetRoot,database,sql,sha256,expectedSourceSchemaHash,fromVersion,toVersion,maxBytes=64*1024**2}={}){
 if(typeof sql!=='string'||!sql.trim()||Buffer.byteLength(sql)>65536||!/^[a-f0-9]{64}$/.test(sha256||'')||crypto.createHash('sha256').update(sql).digest('hex')!==sha256||!/^[a-f0-9]{64}$/.test(expectedSourceSchemaHash||'')||!Number.isInteger(fromVersion)||!Number.isInteger(toVersion)||fromVersion<0||toVersion<=fromVersion||toVersion>2147483647)throw fail('SQLITE_MIGRATION_POLICY_INVALID');
 // Only the explicit writable migration target may initialize its own WAL
 // metadata. This private argument is never accepted through the helper DTO.
 const inspected=await inspectPolicy({sourceRoot:targetRoot,database,maxBytes},{readOnly:false});if(inspected.schemaHash!==expectedSourceSchemaHash||inspected.userVersion!==fromVersion)throw fail('SQLITE_MIGRATION_SOURCE_MISMATCH');
 const directory=await root(targetRoot),file=path.join(directory.directory,database);let db,committed=false;
 try{
  db=new DatabaseSync(file,{timeout:100,allowExtension:false,defensive:true});const pageSize=db.prepare('PRAGMA page_size').get().page_size;
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA max_page_count='+Math.floor(maxBytes/pageSize)+'; BEGIN IMMEDIATE;');
  const before=existingData(db),oldTables=new Set(before.map(row=>row.name));
  db.setAuthorizer((action,first,second,dbName)=>{
   if(dbName&&dbName!=='main')return SQL.SQLITE_DENY;
   if([SQL.SQLITE_READ,SQL.SQLITE_SELECT,SQL.SQLITE_ALTER_TABLE,SQL.SQLITE_CREATE_TABLE,SQL.SQLITE_CREATE_INDEX,SQL.SQLITE_REINDEX].includes(action))return SQL.SQLITE_OK;
   if(action===SQL.SQLITE_FUNCTION)return /^(?:load_extension|readfile|writefile)$/i.test(second||first||'')?SQL.SQLITE_DENY:SQL.SQLITE_OK;
   if([SQL.SQLITE_INSERT,SQL.SQLITE_UPDATE,SQL.SQLITE_DELETE].includes(action))return oldTables.has(first)||first==='sqlite_sequence'?SQL.SQLITE_DENY:SQL.SQLITE_OK;
   return SQL.SQLITE_DENY;
  });
  db.exec(sql);db.setAuthorizer(null);
  if(JSON.stringify(existingData(db,before))!==JSON.stringify(before))throw fail('SQLITE_MIGRATION_DATA_CHANGE');
  db.exec('PRAGMA user_version='+toVersion);
  if(db.prepare('PRAGMA quick_check(1)').get().quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').get())throw fail('SQLITE_MIGRATION_INTEGRITY');
  const schemaHash=schema(db);db.exec('COMMIT');committed=true;db.close();db=null;
  const handle=await fs.open(file,constants.O_RDWR|(constants.O_NOFOLLOW||0));let stat;try{stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>maxBytes)throw fail('SQLITE_MIGRATION_LIMIT');await handle.sync();}finally{await handle.close();}
  if(process.platform!=='win32'){const handle=await fs.open(directory.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();}}
  return{version:1,kind:'sqlite-additive-migration',database,bytes:stat.size,schemaHash,userVersion:toVersion,migrationSha256:sha256,fromVersion,toVersion,existingDataPreserved:true};
 }catch(error){if(db){db.setAuthorizer(null);try{db.exec('ROLLBACK');}catch{}db.close();}if(committed)throw fail('SQLITE_MIGRATION_OUTCOME_UNKNOWN');throw error.code?.startsWith('SQLITE_MIGRATION_')?error:fail('SQLITE_MIGRATION_REJECTED');}
}
module.exports={snapshotSqlite,inspectPolicy,migrateSqlite};
if(require.main===module){let options;try{options=JSON.parse(process.argv[2]);}catch{process.stderr.write('SQLITE_SNAPSHOT_POLICY_INVALID\n');process.exitCode=1;}
 if(options)(options.inspect?inspectPolicy(options):options.migrate?migrateSqlite(options):snapshotSqlite(options)).then(value=>process.stdout.write(JSON.stringify(value)+'\n'),error=>{process.stderr.write(/^[A-Z0-9_]{1,80}$/.test(error.code||'')?error.code+'\n':'SQLITE_SNAPSHOT_FAILED\n');process.exitCode=1;});
}
