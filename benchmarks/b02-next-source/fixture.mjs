// Self-contained UID1001 child used by the existing bounded setpriv reader.
export function b02FixtureChild(){
 const fs=require('node:fs'),crypto=require('node:crypto'),root=process.argv[1],pins=JSON.parse(process.argv[2]);
 const need=v=>{if(!v)throw Error('B02_FIXTURE_REFUSED');},id=s=>[s.dev,s.ino,s.uid,s.gid,s.mode].join(':'),same=(a,b)=>['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
 try{
  need(process.getuid()===1001&&process.getgid()===1001&&Array.isArray(pins)&&pins.length===1);const pin=pins[0];need(pin.path==='fixtures/B02/inventory.csv'&&pin.bytes===156&&/^[a-f0-9]{64}$/.test(pin.sha256));
  const parents=[];let at='';for(const part of root.slice(1).split('/')){need(part&&part!=='.'&&part!=='..');at+='/'+part;const s=fs.lstatSync(at);need(s.isDirectory()&&!s.isSymbolicLink()&&[0,1001].includes(s.uid)&&!(s.mode&0o022)&&fs.realpathSync(at)===at);parents.push([at,s]);}
  need(JSON.stringify(fs.readdirSync(root).sort())===JSON.stringify(['.gitignore','.harness','inventory.csv']));const harness=fs.lstatSync(root+'/.harness');need(harness.isDirectory()&&!harness.isSymbolicLink());
  const file=root+'/inventory.csv',safe=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===1001&&s.gid===1001&&!(s.mode&0o022)&&s.size===156,before=fs.lstatSync(file);need(safe(before));const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let bytes;
  try{const opened=fs.fstatSync(fd);need(safe(opened)&&same(before,opened));const b=Buffer.alloc(157),n=fs.readSync(fd,b,0,b.length,0);need(n===156&&same(opened,fs.fstatSync(fd))&&same(opened,fs.lstatSync(file)));bytes=b.subarray(0,n);}finally{fs.closeSync(fd);}
  const hash=crypto.createHash('sha256').update(bytes).digest('hex'),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),lines=text.split('\r\n');need(hash===pin.sha256&&lines.length===7&&lines[6]===''&&lines[0]==='name,category,quantity'&&!text.replaceAll('\r\n','').includes('\n'));
  for(const [p,s]of parents)need(id(fs.lstatSync(p))===id(s)&&fs.realpathSync(p)===p);
  process.stdout.write(JSON.stringify({rootIdentity:id(fs.lstatSync(root)),harnessIdentity:id(harness),files:[{path:pin.path,bytes:156,sha256:hash}],crlfCount:6,errorLine:6}));
 }catch{process.stderr.write('B02_FIXTURE_REFUSED\n');process.exitCode=1;}
}
