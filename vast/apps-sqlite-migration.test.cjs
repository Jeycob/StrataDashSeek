'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {snapshotSqlite,inspectPolicy,migrateSqlite}=require('./apps-sqlite-snapshot.cjs');
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sdsh-sqlite-migrate-')),dbs=[];for(const name of['active','shadow','final'])await fs.mkdir(path.join(dir,name));t.after(async()=>{for(const db of dbs)try{db.close();}catch{}const real=await fs.realpath(dir);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('sdsh-sqlite-migrate-'));await fs.rm(real,{recursive:true,force:true});});return{at:name=>path.join(dir,name),open(name){const db=new DatabaseSync(path.join(dir,name,'shop.sqlite'));dbs.push(db);return db;}};}
test('a real additive migration runs on shadow and latest final copies while all customer orders survive',async t=>{
 const f=await fixture(t),active=f.open('active');active.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE orders(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO orders VALUES(1,'original order');");const source=await inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite'});
 const sql='ALTER TABLE orders ADD COLUMN delivery_note TEXT; CREATE INDEX orders_value ON orders(value); CREATE TABLE migration_note(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO migration_note VALUES(1,\'schema extended\');',migration={database:'shop.sqlite',sql,sha256:hash(sql),fromVersion:1,toVersion:2,expectedSourceSchemaHash:source.schemaHash};
 await snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('shadow'),database:'shop.sqlite'});const shadowProof=await migrateSqlite({...migration,targetRoot:f.at('shadow')});assert.equal(shadowProof.existingDataPreserved,true);assert.equal(shadowProof.userVersion,2);
 f.open('shadow').exec("INSERT INTO orders VALUES(2,'test fixture',NULL)");assert.equal(active.prepare('SELECT count(*) AS n FROM orders').get().n,1);active.exec("INSERT INTO orders VALUES(3,'new production order')");
 await snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('final'),database:'shop.sqlite'});const finalProof=await migrateSqlite({...migration,targetRoot:f.at('final')});assert.equal(finalProof.schemaHash,shadowProof.schemaHash);assert.deepEqual(f.open('final').prepare('SELECT id,value FROM orders ORDER BY id').all().map(row=>({...row})),[{id:1,value:'original order'},{id:3,value:'new production order'}]);assert.equal((await inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite'})).userVersion,1);
 await assert.rejects(migrateSqlite({...migration,targetRoot:f.at('final')}),{code:'SQLITE_MIGRATION_SOURCE_MISMATCH'});
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
