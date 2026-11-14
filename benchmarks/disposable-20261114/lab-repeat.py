import subprocess,time,pathlib,json
node='/data/harness/node/bin/node'
subprocess.run([node,'/data/lab/lab-mario.cjs'],check=True,timeout=250)
for name in ['lab-benchmark-2','lab-benchmark-3']:
    if time.time()>1794620334-1000:break
    subprocess.run(['python3','/data/lab/lab-prepare-fixture.py',name],check=True)
    root='/data/harness/workspaces/'+name
    subprocess.run([node,'/data/lab/homeai-csv-project.cjs','vast',root],check=True,timeout=950)
    subprocess.run([node,'/data/lab/independent-grade.mjs',root],check=True,timeout=30)
pathlib.Path('/data/lab/repeats-completed.json').write_text(json.dumps({'at':time.time(),'completed':True}))
