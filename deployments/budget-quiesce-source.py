import pathlib,json,urllib.request,os,signal,time,pwd,subprocess,tarfile,hashlib
r=pathlib.Path('/data/harness');uid=pwd.getpwnam('harness').pw_uid
if 'RTX 4060 Ti' not in subprocess.check_output(['nvidia-smi','--query-gpu=name','--format=csv,noheader'],text=True):raise RuntimeError('Not the source instance GPU')
def args(pid):
    try:return [x.decode() for x in pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0') if x]
    except OSError:return []
def quiet():
    life=json.loads((r/'state/lifecycle.json').read_text());model=json.load(urllib.request.urlopen('http://127.0.0.1:8080/status',timeout=5))
    return not life.get('active') and model.get('busy') is False and not model.get('queued')
services=json.loads((r/'state/services.json').read_text())['pids']
harness=next(p for p in services if any(x.endswith('/@deepseek-ai/dsh/lib/bin.js') for x in args(p)))
supervisor=next(int(p.name) for p in pathlib.Path('/proc').iterdir() if p.name.isdigit() and '/data/harness/app/vast/supervisor.cjs' in args(int(p.name)))
if not quiet():raise RuntimeError('Live user/model turn; migration cutover postponed')
os.kill(harness,signal.SIGSTOP)
if not quiet():
    os.kill(harness,signal.SIGCONT);raise RuntimeError('A turn started during preparation; resumed unchanged')
previews=[]
try:
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit() or p.stat().st_uid!=uid or int(p.name) in services:continue
        a=args(int(p.name));text=' '.join(a)
        if not a:continue
        if ('/vite/bin/vite.js' in text or '/@esbuild/' in text or 'apps/api/src/server.js' in a or (a[0]=='bash' and '/vite/bin/vite.js' in text)):
            previews.append(int(p.name))
        else:raise RuntimeError('Unknown workspace process remains: '+p.name)
except:
    os.kill(harness,signal.SIGCONT);raise
os.kill(supervisor,signal.SIGSTOP)
for p in services:
    if '/data/harness/app/mobile/https-proxy.cjs' in args(p):os.kill(p,signal.SIGTERM)
for p in previews:
    try:os.kill(p,signal.SIGTERM)
    except ProcessLookupError:pass
os.kill(supervisor,signal.SIGTERM);os.kill(supervisor,signal.SIGCONT)
time.sleep(.3)
try:os.kill(harness,signal.SIGCONT)
except ProcessLookupError:pass
def alive(pid):
    try:return not pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].startswith('Z')
    except OSError:return False
for _ in range(100):
    if not any(alive(p) for p in [supervisor,harness,*services,*previews]):break
    time.sleep(.1)
else:raise RuntimeError('A service did not finish stopping; preserve source and inspect')
stage=pathlib.Path('/data/pro4500-final');stage.mkdir(mode=0o700,exist_ok=True)
members=['data/harness/home','data/harness/workspaces','data/harness/secrets','data/harness/root-secrets','data/harness/config.json','data/harness/push-config.json']
subprocess.run(['tar','--warning=no-file-changed','-czf',str(stage/'state.tar.gz'),'-C','/',*members],check=True)
manifest={}
for directory in ['home','workspaces','secrets']:
    for f in (r/directory).rglob('*'):
        if f.is_file() and not f.is_symlink():manifest[str(f.relative_to(r))]={'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()}
with (stage/'state.tar.gz').open('rb') as stream:archive_sha=hashlib.file_digest(stream,'sha256').hexdigest()
record={'at':time.time(),'sourceId':60529418,'targetId':60637500,'files':manifest,'archiveSHA256':archive_sha,'previewProcessesStopped':len(previews),'servicesQuiesced':True}
(stage/'manifest.json').write_text(json.dumps(record))
print(json.dumps({'sourceQuiesced':True,'files':len(manifest),'archiveBytes':(stage/'state.tar.gz').stat().st_size,'archiveSHA256':record['archiveSHA256']}))
