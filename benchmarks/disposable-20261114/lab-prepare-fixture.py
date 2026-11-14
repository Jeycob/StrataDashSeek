import pathlib,tarfile,os,pwd,subprocess,json,sys
r=pathlib.Path('/data/harness');base=r/'workspaces'/(sys.argv[1] if len(sys.argv)>1 else 'lab-benchmark');target=base/'csv-agent'
if base.name not in ['lab-benchmark','lab-benchmark-2','lab-benchmark-3']:raise RuntimeError('Unexpected benchmark path')
if target.exists():raise RuntimeError('Preserve existing benchmark')
target.mkdir(parents=True)
with tarfile.open('/data/lab/csv-fixture.tar') as f:f.extractall(target,filter='data')
user=pwd.getpwnam('harness')
for root,dirs,files in os.walk(base):
    os.chown(root,user.pw_uid,user.pw_gid)
    for name in files:os.chown(pathlib.Path(root)/name,user.pw_uid,user.pw_gid)
p=subprocess.run([str(r/'node/bin/node'),'--test-isolation=none','--test','test/public.test.mjs','test/edge-cases.test.mjs'],cwd=target,capture_output=True,text=True)
pathlib.Path('/data/lab/csv-original-tests.txt').write_text(p.stdout+p.stderr)
print(json.dumps({'fixtureReady':True,'originalRegressionExit':p.returncode}))
if p.returncode!=1:raise RuntimeError('Expected original regression failures')
