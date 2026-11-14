import pathlib,json,urllib.request,os,signal,time,pwd,subprocess,tarfile,hashlib
r=pathlib.Path('/data/harness');uid=pwd.getpwnam('harness').pw_uid
if 'RTX 4060 Ti' not in subprocess.check_output(['nvidia-smi','--query-gpu=name','--format=csv,noheader'],text=True):raise RuntimeError('Not the source instance GPU')
def args(pid):
    try:return [x.decode() for x in pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0') if x]
    except OSError:return []
def quiet():
    life=json.loads((r/'state/lifecycle.json').read_text());model=json.load(urllib.request.urlopen('http://127.0.0.1:8080/status',timeout=5))
    queue=json.loads((r/'state/turn-queue.json').read_text())
    return not life.get('active') and model.get('busy') is False and not model.get('queued') and not queue.get('owner') and not queue.get('waiting')
services=json.loads((r/'state/services.json').read_text())['pids']
harness=next(p for p in services if any(x.endswith('/@deepseek-ai/dsh/lib/bin.js') for x in args(p)))
supervisor=next(int(p.name) for p in pathlib.Path('/proc').iterdir() if p.name.isdigit() and '/data/harness/app/vast/supervisor.cjs' in args(int(p.name)))
proxy=next(p for p in services if '/data/harness/app/mobile/https-proxy.cjs' in args(p))
if not quiet():raise RuntimeError('Live user/model turn; migration cutover postponed')
os.kill(proxy,signal.SIGSTOP)
try:
    time.sleep(1)
    code="const a=require('/data/harness/root-secrets/homeai-migrate-admin.cjs');(async()=>{const c=await a.login();const s=await a.call('session/list',{},c);process.stdout.write(s.items.some(x=>x.running)?'busy':'idle')})().catch(()=>process.exit(1));"
    running=subprocess.check_output([str(r/'node/bin/node'),'-e',code],text=True,timeout=20)
    if running!='idle' or not quiet():raise RuntimeError('A queued or running turn exists; cutover postponed')
    os.kill(harness,signal.SIGSTOP)
    if not quiet():raise RuntimeError('A turn started during preparation')
except:
    for p in [harness,proxy]:
        try:os.kill(p,signal.SIGCONT)
        except ProcessLookupError:pass
    raise
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
    os.kill(harness,signal.SIGCONT);os.kill(proxy,signal.SIGCONT);raise
os.kill(supervisor,signal.SIGSTOP)
for p in services:
    if '/data/harness/app/mobile/https-proxy.cjs' in args(p):os.kill(p,signal.SIGTERM)
for p in previews:
    try:os.kill(p,signal.SIGTERM)
    except ProcessLookupError:pass
os.kill(supervisor,signal.SIGTERM);os.kill(supervisor,signal.SIGCONT)
time.sleep(.3)
for p in [harness,proxy]:
    try:os.kill(p,signal.SIGCONT)
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
