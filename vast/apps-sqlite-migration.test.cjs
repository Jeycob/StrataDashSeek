'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {snapshotSqlite,inspectPolicy,migrateSqlite}=require('./apps-sqlite-snapshot.cjs');
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sdsh-sqlite-migrate-')),dbs=[];for(const name of['active','shadow','final','scratch'])await fs.mkdir(path.join(dir,name),{mode:0o700});t.after(async()=>{for(const db of dbs)try{db.close();}catch{}const real=await fs.realpath(dir);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('sdsh-sqlite-migrate-'));await fs.rm(real,{recursive:true,force:true});});return{at:name=>path.join(dir,name),open(name){const db=new DatabaseSync(path.join(dir,name,'shop.sqlite'));dbs.push(db);return db;}};}
test('a real additive migration runs on shadow and latest final copies while all customer orders survive',async t=>{
 const f=await fixture(t),active=f.open('active');active.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE orders(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO orders VALUES(1,'original order');");const source=await inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite'});
 const sql='ALTER TABLE orders ADD COLUMN delivery_note TEXT; CREATE INDEX orders_value ON orders(value); CREATE TABLE migration_note(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO migration_note VALUES(1,\'schema extended\');',migration={database:'shop.sqlite',sql,sha256:hash(sql),fromVersion:1,toVersion:2,expectedSourceSchemaHash:source.schemaHash};
 await snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('shadow'),database:'shop.sqlite'});const shadowProof=await migrateSqlite({...migration,targetRoot:f.at('shadow')});assert.equal(shadowProof.existingDataPreserved,true);assert.equal(shadowProof.userVersion,2);
 f.open('shadow').exec("INSERT INTO orders VALUES(2,'test fixture',NULL)");assert.equal(active.prepare('SELECT count(*) AS n FROM orders').get().n,1);active.exec("INSERT INTO orders VALUES(3,'new production order')");
 await snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('final'),database:'shop.sqlite'});const finalProof=await migrateSqlite({...migration,targetRoot:f.at('final')});assert.equal(finalProof.schemaHash,shadowProof.schemaHash);assert.deepEqual(f.open('final').prepare('SELECT id,value FROM orders ORDER BY id').all().map(row=>({...row})),[{id:1,value:'original order'},{id:3,value:'new production order'}]);assert.equal((await inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite'})).userVersion,1);
 await assert.rejects(migrateSqlite({...migration,targetRoot:f.at('final')}),{code:'SQLITE_MIGRATION_SOURCE_MISMATCH'});
});

const quiescentSource={version:1,noRunningWriters:true};
test('closed WAL requires strict quiescent proof and uses a cleaned private copy without modifying source bytes or owner',async t=>{
 const f=await fixture(t),db=f.open('active');db.exec('PRAGMA journal_mode=WAL; CREATE TABLE orders(id INTEGER PRIMARY KEY); INSERT INTO orders VALUES(1),(7);');db.close();
 const file=path.join(f.at('active'),'shop.sqlite'),before=await fs.readFile(file),stat=await fs.stat(file);assert.equal(before[18],2);assert.deepEqual(await fs.readdir(f.at('active')),['shop.sqlite']);
 const options={sourceRoot:f.at('active'),database:'shop.sqlite',scratchRoot:f.at('scratch')};
 for(const proof of[undefined,true,{}, {version:1,noRunningWriters:false},{version:1,noRunningWriters:true,extra:true}])await assert.rejects(inspectPolicy({...options,...(proof===undefined?{}:{quiescentSource:proof})}),{code:'SQLITE_QUIESCENT_PROOF_REQUIRED'});
 await assert.rejects(inspectPolicy({...options,readOnly:false}),{code:'SQLITE_QUIESCENT_PROOF_REQUIRED'});
 await assert.rejects(inspectPolicy({...options,quiescentSource,maxBytes:4096}),{code:'SQLITE_SNAPSHOT_SIZE_LIMIT'});
 await assert.rejects(inspectPolicy({...options,quiescentSource,scratchRoot:f.at('active')}),{code:'SQLITE_SCRATCH_UNSAFE'});
 const inspected=await inspectPolicy({...options,quiescentSource});assert.equal(inspected.uid,stat.uid);assert.equal(inspected.gid,stat.gid);
 await snapshotSqlite({...options,quiescentSource,targetRoot:f.at('final'),expectedSchemaHash:inspected.schemaHash});
 assert.deepEqual(f.open('final').prepare('SELECT id FROM orders ORDER BY id').all().map(r=>r.id),[1,7]);assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readdir(f.at('active')),['shop.sqlite']);assert.deepEqual(await fs.readdir(f.at('scratch')),[]);
 const output=await fs.stat(path.join(f.at('final'),'shop.sqlite'));if(process.platform!=='win32'){assert.equal(output.uid,stat.uid);assert.equal(output.gid,stat.gid);assert.equal(output.mode&0o666,stat.mode&0o666);}
});

test('existing committed WAL pages always use online backup even with quiescent proof and are never ignored',async t=>{
 const f=await fixture(t),db=f.open('active');db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE orders(id INTEGER PRIMARY KEY); INSERT INTO orders VALUES(1),(42);');
 const file=path.join(f.at('active'),'shop.sqlite'),before=await fs.readFile(file),wal=await fs.readFile(file+'-wal');assert(wal.length>0);
 await snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('final'),database:'shop.sqlite',quiescentSource,scratchRoot:path.join(f.at('scratch'),'must-not-be-opened')});
 assert.deepEqual(f.open('final').prepare('SELECT id FROM orders ORDER BY id').all().map(r=>r.id),[1,42]);assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readFile(file+'-wal'),wal);assert.deepEqual(await fs.readdir(f.at('scratch')),[]);
});

test('changed closed-WAL source is refused and its private scratch is removed',async t=>{
 const f=await fixture(t),db=f.open('active');db.exec('PRAGMA journal_mode=WAL; CREATE TABLE orders(id INTEGER);');db.close();const file=path.join(f.at('active'),'shop.sqlite'),originalOpen=fs.open;let changed=false;
 const mock=t.mock.method(fs,'open',async function(name,...args){const handle=await originalOpen.call(this,name,...args);if(String(name).startsWith(f.at('scratch')+path.sep)&&args[0]==='wx'){const write=handle.write.bind(handle);handle.write=async(...values)=>{const result=await write(...values);if(!changed){changed=true;const bytes=await fs.readFile(file);bytes[60]^=1;await fs.writeFile(file,bytes);}return result;};}return handle;});
 try{await assert.rejects(inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite',quiescentSource,scratchRoot:f.at('scratch')}),{code:'SQLITE_SOURCE_CHANGED'});}finally{mock.mock.restore();}
 assert(changed);assert.deepEqual(await fs.readdir(f.at('scratch')),[]);
});

test('scratch cleanup failure rejects success and preserves an earlier outcome code',async t=>{
 const f=await fixture(t),db=f.open('active');db.exec('PRAGMA journal_mode=WAL; CREATE TABLE orders(id INTEGER);');db.close();const originalRm=fs.rm;
 const mock=t.mock.method(fs,'rm',async function(name,...args){if(String(name).startsWith(f.at('scratch')+path.sep))throw Object.assign(Error('synthetic cleanup refusal'),{code:'EACCES'});return originalRm.call(this,name,...args);});
 const options={sourceRoot:f.at('active'),database:'shop.sqlite',quiescentSource,scratchRoot:f.at('scratch')};
 try{await assert.rejects(inspectPolicy(options),{code:'EACCES'});await assert.rejects(snapshotSqlite({...options,targetRoot:f.at('final'),expectedSchemaHash:'0'.repeat(64)}),error=>error.code==='SQLITE_SCHEMA_CHANGE_UNSUPPORTED'&&error.cleanupFailed===true&&error.cleanupErrorCode==='EACCES');}finally{mock.mock.restore();}
});

test('source mutation after publishing is detected on final recheck and never deletes the published generation',async t=>{
 const f=await fixture(t),db=f.open('active');db.exec('PRAGMA journal_mode=WAL; CREATE TABLE orders(id INTEGER); INSERT INTO orders VALUES(8);');db.close();const file=path.join(f.at('active'),'shop.sqlite'),originalLink=fs.link;let changed=false;
 const mock=t.mock.method(fs,'link',async function(...args){const result=await originalLink.apply(this,args);changed=true;const bytes=await fs.readFile(file);bytes[60]^=1;await fs.writeFile(file,bytes);return result;});
 try{await assert.rejects(snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('final'),database:'shop.sqlite',quiescentSource,scratchRoot:f.at('scratch')}),{code:'SQLITE_SOURCE_CHANGED'});}finally{mock.mock.restore();}
 assert(changed);assert.deepEqual(await fs.readdir(f.at('final')),['shop.sqlite']);assert.deepEqual(await fs.readdir(f.at('scratch')),[]);
});

test('owner migration can inspect its writable closed-WAL target without making source inspection writable',async t=>{
 const f=await fixture(t),db=f.open('active');db.exec('PRAGMA journal_mode=WAL; CREATE TABLE orders(id INTEGER PRIMARY KEY); INSERT INTO orders VALUES(11);');const proof=await inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite'});db.close();
 const statement='ALTER TABLE orders ADD COLUMN note TEXT;',result=await migrateSqlite({targetRoot:f.at('active'),database:'shop.sqlite',sql:statement,sha256:hash(statement),expectedSourceSchemaHash:proof.schemaHash,fromVersion:0,toVersion:1});assert.equal(result.userVersion,1);assert.deepEqual(f.open('active').prepare('SELECT id,note FROM orders').all().map(r=>({...r})),[{id:11,note:null}]);
});
test('failed or destructive migration rolls back the copied database and never changes production',async t=>{
 const f=await fixture(t),active=f.open('active');active.exec("PRAGMA user_version=1; CREATE TABLE orders(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO orders VALUES(1,'kept')");const source=await inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite'});await snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('shadow'),database:'shop.sqlite'});
 for(const sql of["ALTER TABLE orders ADD COLUMN note TEXT; INSERT INTO missing_table VALUES(1)",'DELETE FROM orders','UPDATE orders SET value=\'lost\'','DROP TABLE orders',"ATTACH ':memory:' AS extra",'COMMIT','PRAGMA user_version=99','ALTER TABLE orders DROP COLUMN value; ALTER TABLE orders ADD COLUMN value TEXT']){
  await assert.rejects(migrateSqlite({targetRoot:f.at('shadow'),database:'shop.sqlite',sql,sha256:hash(sql),fromVersion:1,toVersion:2,expectedSourceSchemaHash:source.schemaHash}),error=>/^SQLITE_MIGRATION_/.test(error.code));
  assert.equal((await inspectPolicy({sourceRoot:f.at('shadow'),database:'shop.sqlite'})).schemaHash,source.schemaHash);assert.equal(active.prepare('SELECT value FROM orders WHERE id=1').get().value,'kept');
 }
 assert.equal(f.open('shadow').prepare('SELECT value FROM orders WHERE id=1').get().value,'kept');
});
test('combined copy and migration publishes only the migrated database and preserves the source owner',async t=>{
 const f=await fixture(t),active=f.open('active');active.exec("PRAGMA user_version=1; CREATE TABLE orders(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO orders VALUES(7,'retained')");
 const source=await inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite'}),sql='ALTER TABLE orders ADD COLUMN note TEXT';
 const proof=await snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('shadow'),database:'shop.sqlite',expectedSchemaHash:source.schemaHash,migration:{sql,sha256:hash(sql),fromVersion:1,toVersion:2}});
 assert.equal(proof.userVersion,2);assert.equal(proof.sourceSchemaHash,source.schemaHash);assert.equal(proof.migrationSha256,hash(sql));assert.equal(proof.existingDataPreserved,true);assert.deepEqual(await fs.readdir(f.at('shadow')),['shop.sqlite']);assert.equal((await inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite'})).userVersion,1);
 assert.deepEqual(f.open('shadow').prepare('SELECT id,value,note FROM orders').all().map(row=>({...row})),[{id:7,value:'retained',note:null}]);
 if(process.platform!=='win32'){const from=await fs.stat(path.join(f.at('active'),'shop.sqlite')),to=await fs.stat(path.join(f.at('shadow'),'shop.sqlite'));assert.equal(to.uid,from.uid);assert.equal(to.gid,from.gid);}
});
