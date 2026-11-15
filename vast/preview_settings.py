"""Root-owned reconciler for the owner's explicitly approved eight private preview ports.

The unprivileged Apps API may request only a boolean. No command, recipient,
address, port or ACL can be supplied by the browser or the agent.
"""
import json, pathlib, os, subprocess, time, tempfile
from runtime_paths import RuntimePaths, trusted_directory

class PreviewSettings:
    def __init__(self, root=pathlib.Path('/data/harness'), run=subprocess.run, account=None):
        self.root=root;self.run=run;self.applied=False;self.last_attempt=0
        self.runtime=RuntimePaths(root,account);self.config=root/'preview-settings.json';self.request=root/'state/applications/preview-request.json';self.status=self.runtime.public/'preview-status.json'
    def read(self,p,default=None):
        try:
            if p==self.request:return self.runtime.read_agent('applications/preview-request.json',4096,default)
            trusted_directory(p.parent)
            fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            with os.fdopen(fd,'rb') as f:
                import stat
                s=os.fstat(f.fileno())
                if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode&0o022:raise ValueError('Unsafe preview status/configuration')
                raw=f.read(4097)
            if len(raw)>4096:raise ValueError('Preview settings exceeded limit')
            return json.loads(raw)
        except FileNotFoundError:return default
    def write(self,p,value):
        if p==self.status:self.runtime.publish('preview-status.json',value)
        elif p==self.config:self.runtime.write(p,value)
        else:raise ValueError('Unsupported preview output')
    def apply(self,enabled):
        for index in range(8):
            port=18080+index
            args=['/usr/bin/tailscale','--socket='+str(self.root/'tailscaled.sock'),'serve','--bg','--tcp='+str(port)]
            args.append('tcp://127.0.0.1:'+str(18180+index) if enabled else 'off')
            result=self.run(args,capture_output=True,timeout=5)
            if result.returncode:raise RuntimeError('Private preview port '+str(port)+' could not be configured')
    def tick(self,now=None):
        now=time.time() if now is None else now
        cfg=self.read(self.config)
        if cfg is None:return
        if type(cfg.get('enabled')) is not bool:raise ValueError('Invalid root preview configuration')
        status=self.read(self.status,{}) or {};request=self.read(self.request,{}) or {}
        import re
        pending=bool(re.fullmatch('[a-f0-9]{16}',str(request.get('id','')))) and request.get('id')!=status.get('requestId')
        if pending and (set(request)!={'id','enabled'} or type(request.get('enabled')) is not bool):raise ValueError('Preview request accepts only id and enabled')
        if not pending and (self.applied or now-self.last_attempt<30):return
        self.last_attempt=now;desired=request['enabled'] if pending else cfg['enabled'];error=None
        try:
            self.apply(desired);cfg={'enabled':desired,'updatedAt':int(now*1000)};self.write(self.config,cfg);self.applied=True
        except Exception as e:
            error=str(e);self.applied=False
            if desired!=cfg['enabled']:
                try:self.apply(cfg['enabled'])
                except Exception:error+='; rollback needs attention'
        self.write(self.status,{'configured':True,'enabled':cfg['enabled'],'verified':error is None,'ports':list(range(18080,18088)),'scope':'existing-tailscale-rules','at':int(now*1000),'requestId':request.get('id') if pending else status.get('requestId'),'error':error})
