import pathlib,json,urllib.request,time,subprocess,hashlib,os
r=pathlib.Path('/data/harness');base=r/'workspaces/lab-benchmark';node=str(r/'node/bin/node')
deadline=1794620334 # 01:38:54 UTC, before independent 50-minute deletion
while time.time()<deadline-1100:
    try:
        health=json.load(urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=3))
        if health.get('loaded'):break
    except Exception:pass
    time.sleep(5)
else:raise RuntimeError('Model did not become ready with enough benchmark time')
engine=pathlib.Path('/root/.local/share/strata/components/engine/0.1.59-linux-x86_64-cuda-cuda13/strata')
actual=hashlib.sha256(engine.read_bytes()).hexdigest()
if actual!='0ba914b28df1c8e09c0b5209c2ca6040c75fb650a7408ff3d9ef3ad159a13eb9':raise RuntimeError('Different engine binary; benchmark must be labeled separately')
pathlib.Path('/data/lab/ready.json').write_text(json.dumps({'at':time.time(),'health':health,'engineSHA256':actual}))
subprocess.run([node,'/data/lab/homeai-csv-project.cjs','vast',str(base)],check=True,timeout=950)
subprocess.run([node,'/data/lab/independent-grade.mjs',str(base)],check=True,timeout=30)
if time.time()<deadline-510:
    subprocess.run([node,'/data/lab/lab-small-projects.cjs'],check=True,timeout=490)
pathlib.Path('/data/lab/completed.json').write_text(json.dumps({'at':time.time(),'completed':True}))
