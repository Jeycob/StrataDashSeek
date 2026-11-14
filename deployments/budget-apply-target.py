import pathlib,subprocess,json,hashlib,os,signal,time,shutil
r=pathlib.Path('/data/harness');stage=pathlib.Path('/data/pro4500-final');migration=pathlib.Path('/data/migration')
if 'RTX A4000' not in (migration/'hardware.txt').read_text():raise RuntimeError('Wrong target GPU')
if (migration/'final-applied.json').exists():raise RuntimeError('Final snapshot already applied; preserve live data')
info=json.loads((stage/'manifest.json').read_text())
if info.get('sourceId')!=60529418 or info.get('targetId')!=60637500 or not info.get('servicesQuiesced'):raise RuntimeError('Wrong source snapshot')
with (stage/'state.tar.gz').open('rb') as f:
    if hashlib.file_digest(f,'sha256').hexdigest()!=info['archiveSHA256']:raise RuntimeError('Archive not completely transferred')
bench=migration/'benchmark-results';bench.mkdir(exist_ok=True)
for name in ['agent-results.json','independent-grade.json','independent-tests.txt']:
    source=r/'workspaces/budget-benchmark-20261114'/name
    if source.exists():shutil.copyfile(source,bench/name)
for item in json.loads((migration/'preflight-pids.json').read_text()):
    pid=item['pid']
    try:
        cmd=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes()
        needle=b'model-proxy.cjs' if item['name']=='model-proxy' else b'@deepseek-ai/dsh/lib/bin.js'
        if needle not in cmd or os.getpgid(pid)!=pid:raise RuntimeError('Unexpected preflight process identity')
        os.killpg(pid,signal.SIGTERM)
    except ProcessLookupError:pass
time.sleep(4)
backup=migration/'preflight-snapshot';backup.mkdir(mode=0o700)
for name in ['home','workspaces','secrets','root-secrets']:os.rename(r/name,backup/name)
subprocess.run(['tar','-xzf',str(stage/'state.tar.gz'),'-C','/'],check=True)
bad=[]
for name,expected in info['files'].items():
    p=r/name
    if not p.is_file() or p.stat().st_size!=expected['bytes']:bad.append(name);continue
    with p.open('rb') as f:
        if hashlib.file_digest(f,'sha256').hexdigest()!=expected['sha256']:bad.append(name)
if bad:raise RuntimeError('Restored file verification failed: '+str(len(bad)))
g=json.loads((r/'root-secrets/guard.json').read_text());g.update(instanceId=60637500,enabled=False,ignoreDetachedPreviews=True);(r/'root-secrets/guard.json').write_text(json.dumps(g));os.chmod(r/'root-secrets/guard.json',0o600)
(r/'state/maintenance.json').write_text(json.dumps({'until':time.time()+3600}))
for name in ['app','node','runtime','venv']:
    root=r/name
    for parent,dirs,files in os.walk(root,followlinks=False):
        p=pathlib.Path(parent);os.chown(p,0,0);os.chmod(p,p.stat().st_mode&~0o022)
        for n in files:
            f=p/n;os.chown(f,0,0,follow_symlinks=False)
            if not f.is_symlink():os.chmod(f,f.stat().st_mode&~0o022)
onstart=pathlib.Path('/root/onstart.sh');onstart.write_text('#!/usr/bin/env bash\nmkdir -p /data/harness/logs\nnohup bash /data/harness/app/vast/start.sh > /data/harness/logs/supervisor.log 2>&1 < /dev/null &\n');os.chmod(onstart,0o755)
result={'targetId':60637500,'filesVerified':len(info['files']),'archiveSHA256':info['archiveSHA256'],'privateStateRestored':True,'idleGuardEnabled':False,'immutableRuntimeRootOwned':True,'at':time.time()}
(migration/'final-applied.json').write_text(json.dumps(result));print(json.dumps(result))
