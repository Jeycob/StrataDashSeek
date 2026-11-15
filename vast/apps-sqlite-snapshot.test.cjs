'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const {snapshotSqlite,inspectPolicy}=require('./apps-sqlite-snapshot.cjs');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sdsh-sqlite-copy-')),dbs=[];for(const name of ['active','shadow','final'])await fs.mkdir(path.join(dir,name));
 t.after(async()=>{for(const db of dbs)try{db.close();}catch{}const real=await fs.realpath(dir);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('sdsh-sqlite-copy-'));await fs.rm(real,{recursive:true,force:true});});
 return{dir,at:name=>path.join(dir,name),open(name){const db=new DatabaseSync(path.join(dir,name,'shop.sqlite'));dbs.push(db);return db;}};
}
test('real WAL snapshots isolate candidate writes and take fresh production writes at cutover',async t=>{
 const f=await fixture(t),active=f.open('active');active.exec("PRAGMA journal_mode=WAL; CREATE TABLE orders(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO orders VALUES(1,'original');");
 const policy=await inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite'});
 const first=await snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('shadow'),database:'shop.sqlite',expectedSchemaHash:policy.schemaHash});assert.equal(first.kind,'sqlite-online-backup');
 const shadow=f.open('shadow');shadow.exec("INSERT INTO orders VALUES(2,'test fixture'); UPDATE orders SET value='candidate mutation' WHERE id=1;");
 assert.deepEqual(active.prepare('SELECT * FROM orders').all().map(r=>({...r})),[{id:1,value:'original'}]);
 active.exec("INSERT INTO orders VALUES(3,'new customer order');");
 await snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('final'),database:'shop.sqlite',expectedSchemaHash:policy.schemaHash});
 assert.deepEqual(f.open('final').prepare('SELECT * FROM orders ORDER BY id').all().map(r=>({...r})),[{id:1,value:'original'},{id:3,value:'new customer order'}]);
 assert.equal((await fs.readdir(f.at('final'))).includes('shop.sqlite-wal'),false);
});
test('schema migration is refused without overwriting source or publishing a partial database',async t=>{
 const f=await fixture(t),db=f.open('active');db.exec('CREATE TABLE kept(id INTEGER PRIMARY KEY); INSERT INTO kept VALUES(7)');const before=await inspectPolicy({sourceRoot:f.at('active'),database:'shop.sqlite'});db.exec('ALTER TABLE kept ADD COLUMN incompatible TEXT');
 await assert.rejects(snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('shadow'),database:'shop.sqlite',expectedSchemaHash:before.schemaHash}),{code:'SQLITE_SCHEMA_CHANGE_UNSUPPORTED'});
 assert.deepEqual(await fs.readdir(f.at('shadow')),[]);assert.equal(db.prepare('SELECT id FROM kept').get().id,7);
});
test('unknown volume contents, linked databases and an occupied target cannot be copied or replaced',async t=>{
 const f=await fixture(t),db=f.open('active');db.exec('CREATE TABLE kept(id)');
 await fs.writeFile(path.join(f.at('active'),'uploads.bin'),'keep');await assert.rejects(snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('shadow'),database:'shop.sqlite'}),{code:'SQLITE_VOLUME_CONTENT_UNSUPPORTED'});await fs.unlink(path.join(f.at('active'),'uploads.bin'));
 await fs.link(path.join(f.at('active'),'shop.sqlite'),f.at('outside-link'));await assert.rejects(snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('shadow'),database:'shop.sqlite'}),{code:'SQLITE_FILE_UNSAFE'});await fs.unlink(f.at('outside-link'));
 await fs.writeFile(path.join(f.at('shadow'),'keep'),'retained');await assert.rejects(snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('shadow'),database:'shop.sqlite'}),{code:'SQLITE_TARGET_NOT_EMPTY'});assert.equal(await fs.readFile(path.join(f.at('shadow'),'keep'),'utf8'),'retained');
 await assert.rejects(snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('active'),database:'shop.sqlite'}),{code:'SQLITE_VOLUME_ALIAS'});
});
test('size and corruption checks refuse unsafe sources and leave no published target',async t=>{
 const f=await fixture(t),db=f.open('active');db.exec('CREATE TABLE large(data BLOB); INSERT INTO large VALUES(zeroblob(16384))');await assert.rejects(snapshotSqlite({sourceRoot:f.at('active'),targetRoot:f.at('shadow'),database:'shop.sqlite',maxBytes:4096}),{code:'SQLITE_SNAPSHOT_SIZE_LIMIT'});
 await fs.writeFile(path.join(f.at('final'),'shop.sqlite'),'not a database');await assert.rejects(snapshotSqlite({sourceRoot:f.at('final'),targetRoot:f.at('shadow'),database:'shop.sqlite'}));assert.deepEqual(await fs.readdir(f.at('shadow')),[]);
});
