// Executed only by the bound Linux runtime's existing bounded UID1001 reader.
// Kept self-contained so the same function body can be tested with inert FS.
export function b10FixtureChild(){
 const fs=require('node:fs'),crypto=require('node:crypto'),root=process.argv[1],pins=JSON.parse(process.argv[2]);
 const need=v=>{if(!v)throw Error('B10_FIXTURE_REFUSED');},id=s=>[s.dev,s.ino,s.uid,s.gid,s.mode].join(':'),same=(a,b)=>['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
 try{
  need(process.getuid()===1001&&process.getgid()===1001&&Array.isArray(pins)&&pins.length===6);
  const parents=[],dirs=new Map([['',new Set(['.gitignore','.harness'])]]);let at='';
  const directory=p=>{const s=fs.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink()&&[0,1001].includes(s.uid)&&!(s.mode&0o022)&&fs.realpathSync(p)===p);parents.push([p,s]);return s;};
  for(const part of root.slice(1).split('/')){need(part&&part!=='.'&&part!=='..');at+='/'+part;directory(at);}
  for(const pin of pins){
   need(/^fixtures\/B10\/[a-zA-Z0-9_./-]+$/.test(pin.path)&&!pin.path.split('/').includes('..')&&Number.isSafeInteger(pin.bytes)&&pin.bytes>0&&pin.bytes<=16384&&/^[a-f0-9]{64}$/.test(pin.sha256));
   const parts=pin.path.slice('fixtures/B10/'.length).split('/');let p='';
   for(let i=0;i<parts.length;i++){if(!dirs.has(p))dirs.set(p,new Set());dirs.get(p).add(parts[i]);if(i<parts.length-1)p+=(p?'/':'')+parts[i];}
  }
  for(const [relative,names]of dirs){if(relative)directory(root+'/'+relative);need(JSON.stringify(fs.readdirSync(root+(relative?'/'+relative:'')).sort())===JSON.stringify([...names].sort()));}
  const harness=fs.lstatSync(root+'/.harness');need(harness.isDirectory()&&!harness.isSymbolicLink());
  const files=[];
  for(const pin of pins){
   const file=root+'/'+pin.path.slice('fixtures/B10/'.length),safe=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===1001&&s.gid===1001&&!(s.mode&0o022)&&s.size===pin.bytes,before=fs.lstatSync(file);need(safe(before));
   const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let bytes;
   try{const opened=fs.fstatSync(fd);need(safe(opened)&&same(before,opened));const b=Buffer.alloc(pin.bytes+1),n=fs.readSync(fd,b,0,b.length,0);need(n===pin.bytes&&same(opened,fs.fstatSync(fd))&&same(opened,fs.lstatSync(file)));bytes=b.subarray(0,n);}finally{fs.closeSync(fd);}
   const hash=crypto.createHash('sha256').update(bytes).digest('hex');need(hash===pin.sha256);files.push({path:pin.path,bytes:bytes.length,sha256:hash});
  }
  for(const [p,s]of parents)need(id(fs.lstatSync(p))===id(s)&&fs.realpathSync(p)===p);
  process.stdout.write(JSON.stringify({rootIdentity:id(fs.lstatSync(root)),harnessIdentity:id(harness),files}));
 }catch{process.stderr.write('B10_FIXTURE_REFUSED\n');process.exitCode=1;}
}
