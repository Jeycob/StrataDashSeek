import pathlib,json,tarfile,shutil,time,urllib.request,subprocess,hashlib
lab=pathlib.Path('/data/lab');out=lab/'export';out.mkdir(exist_ok=True)
def copy(source,target):
    source=pathlib.Path(source)
    if source.exists():
        p=out/target;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,p)
for name in ['ready.json','hardware.txt','network.json','mario-result.json','mario-repair-result.json']:
    copy(lab/name,name)
copy(lab/'mario.html','mario-first.html')
copy('/data/harness/workspaces/mario-repair/index.html','mario-fixed.html')
copy('/data/harness/workspaces/mario-repair/independent-validation.json','mario-fixed-validation.json')
for name in ['results.json','lru.cjs','semaphore.cjs']:
    copy(lab/'small-projects'/name,'small-projects/'+name)
for i,name in enumerate(['lab-benchmark','lab-benchmark-2','lab-benchmark-3'],1):
    base=pathlib.Path('/data/harness/workspaces')/name
    for f in ['agent-results.json','independent-grade.json','independent-tests.txt','csv-agent/src/report.mjs']:
        copy(base/f,'csv-'+str(i)+'/'+f)
launch=json.loads(pathlib.Path('/root/.local/state/strata/launch/lab.json').read_text())
(out/'strata-launch.json').write_text(json.dumps({k:launch[k] for k in ['exe','args','cwd','tokenizer','model_name','vision','drafting','user_args'] if k in launch},indent=2))
metrics=json.load(urllib.request.urlopen('http://127.0.0.1:8080/metrics',timeout=4));e=metrics['engine']
(out/'engine.json').write_text(json.dumps({k:e[k] for k in ['model','max_context','kv','kv_resident','expert_slots','expert_cache_mib','spec','spec_min_p','drafting','conversation_cache_mib','conversation_cache_slots'] if k in e},indent=2))
snapshot={'at':time.time(),'cpuModel':next(x.split(':',1)[1].strip() for x in pathlib.Path('/proc/cpuinfo').read_text().splitlines() if x.startswith('model name')),'cpuMax':pathlib.Path('/sys/fs/cgroup/cpu.max').read_text().strip(),'memoryMaxBytes':int(pathlib.Path('/sys/fs/cgroup/memory.max').read_text()),'harnessVersion':json.loads(pathlib.Path('/data/harness/runtime/node_modules/@deepseek-ai/dsh/package.json').read_text())['version'],'nodeVersion':subprocess.check_output(['/data/harness/node/bin/node','--version'],text=True).strip()}
(out/'runtime-hardware.json').write_text(json.dumps(snapshot,indent=2))
manifest={str(p.relative_to(out)):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in out.rglob('*') if p.is_file()}
(out/'checksums.json').write_text(json.dumps(manifest,indent=2))
with tarfile.open(lab/'results.tar','w') as archive:
    for p in out.rglob('*'):
        if p.is_file():archive.add(p,arcname=str(p.relative_to(out)))
print(json.dumps({'exportedFiles':len(manifest),'archiveBytes':(lab/'results.tar').stat().st_size,'allCsvRunsPresent':all((out/f'csv-{i}/agent-results.json').exists() for i in [1,2,3]),'marioRepairPresent':(out/'mario-repair-result.json').exists()}))
