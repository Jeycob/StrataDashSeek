"""Root-only runtime output and privilege-dropped reads of agent-owned input."""
import json, os, pathlib, pwd, re, stat, subprocess, sys, uuid

def trusted_directory(directory):
    directory=pathlib.Path(directory).absolute()
    for current in [*reversed(directory.parents),directory]:
        s=current.lstat()
        if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022 and not s.st_mode&stat.S_ISVTX:
            raise ValueError('Untrusted privileged path ancestor')
    return directory

class RuntimePaths:
    def __init__(self,root=pathlib.Path('/data/harness'),account=None):
        if not hasattr(os,'getuid') or os.getuid()!=0:raise RuntimeError('Runtime output requires Linux root')
        self.root=pathlib.Path(root).absolute();trusted_directory(self.root)
        if self.root.stat().st_mode&0o022:raise ValueError('Runtime root is writable outside root')
        self.private=self.root/'root-secrets/runtime/state';self.public=self.root/'runtime-status'
        for p in [self.root/'root-secrets',self.root/'root-secrets/runtime',self.private,self.public]:
            trusted_directory(p.parent)
            try:p.mkdir(mode=0o755 if p==self.public else 0o700)
            except FileExistsError:pass
            trusted_directory(p)
            if p.stat().st_mode&0o022:raise ValueError('Writable privileged output directory')
        if account is None:
            user=pwd.getpwnam('harness');account=(user.pw_uid,user.pw_gid)
        self.uid,self.gid=account
        if self.uid<=0 or self.gid<=0:raise ValueError('A non-root input identity is required')

    def read_agent(self,relative,limit=1024*1024,default=None):
        if any(x in ('','..','.') for x in relative.split('/')):raise ValueError('Invalid agent input path')
        r=subprocess.run([sys.executable,str(pathlib.Path(__file__).absolute()),'read-agent',str(self.root/'state'/relative),str(limit)],user=self.uid,group=self.gid,extra_groups=[],env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'},capture_output=True,timeout=5)
        if r.returncode==44:return default
        if r.returncode or len(r.stdout)>limit:raise ValueError('Agent input unavailable or unsafe')
        return json.loads(r.stdout)

    def read_private(self,name,default=None):
        p=self.private/name
        try:
            trusted_directory(p.parent);fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            with os.fdopen(fd,'rb') as f:
                s=os.fstat(f.fileno())
                if not stat.S_ISREG(s.st_mode) or s.st_uid or s.st_nlink!=1 or s.st_mode&0o022 or s.st_size>2*1024**2:raise ValueError('Unsafe private runtime file')
                return json.load(f)
        except FileNotFoundError:return default

    def write(self,p,value,mode=0o600):
        p=pathlib.Path(p)
        if p.parent not in (self.private,self.public,self.root):raise ValueError('Unrecognized privileged output directory')
        trusted_directory(p.parent)
        parent=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);name='.'+p.name+'.'+uuid.uuid4().hex
        try:
            try:
                s=os.stat(p.name,dir_fd=parent,follow_symlinks=False)
                if not stat.S_ISREG(s.st_mode) or s.st_uid or s.st_nlink!=1 or s.st_mode&0o022:raise ValueError('Unsafe existing privileged file')
            except FileNotFoundError:pass
            fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode,dir_fd=parent)
            with os.fdopen(fd,'w') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
            os.replace(name,p.name,src_dir_fd=parent,dst_dir_fd=parent);os.fsync(parent)
        finally:
            try:os.unlink(name,dir_fd=parent)
            except FileNotFoundError:pass
            os.close(parent)

    def publish(self,name,value):
        fields={'idle-status.json':('at','canStop','reason','idleTimeoutSeconds','idleSeconds'),'preview-status.json':('configured','enabled','verified','ports','scope','at','requestId','error')}
        if name not in fields:raise ValueError('Unsupported public runtime status')
        data={k:value[k] for k in fields[name] if k in value}
        for k,v in data.items():
            if isinstance(v,str):data[k]=re.sub(r'https?://\S*[?&](?:token|key|secret)=\S+','[redacted authentication URL]',v[:500],flags=re.I)
        self.write(self.private/name,data);self.write(self.public/name,data,0o644)

if __name__=='__main__':
    if len(sys.argv)!=4 or sys.argv[1]!='read-agent' or os.getuid()==0:raise SystemExit(2)
    try:fd=os.open(sys.argv[2],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError:raise SystemExit(44)
    with os.fdopen(fd,'rb') as f:
        s=os.fstat(f.fileno());limit=int(sys.argv[3])
        if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>limit:raise SystemExit(3)
        raw=f.read(limit+1)
        if len(raw)>limit:raise SystemExit(4)
        sys.stdout.write(json.dumps(json.loads(raw)))
