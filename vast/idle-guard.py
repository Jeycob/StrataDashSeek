"""Root watchdog: never stop across a live turn, build, unknown model state or stale heartbeat."""
import json, pathlib, time, urllib.request, os, pwd, subprocess, datetime
from preview_settings import PreviewSettings
ROOT=pathlib.Path('/data/harness')
def load(path): return json.loads(path.read_text())
def decide(now, last, lifecycle, model, jobs, lease_until, idle_seconds=300, applications=None):
    if now < lease_until: return False,'maintenance lease'
    if now-lifecycle.get('at',0)/1000>20: return False,'lifecycle heartbeat unavailable'
    if lifecycle.get('active',0): return False,'agent turn active'
    if model.get('busy') is not False or model.get('queued',0): return False,'model busy or unknown'
    if applications is not None:
        if now-applications.get('at',0)/1000>20:return False,'application worker heartbeat unavailable'
        if applications.get('active',0):return False,'application build or test active'
        if applications.get('holdUntil',0)>now*1000:return False,'application awake lease'
        worker=applications.get('worker') or {}
        if worker.get('pid') and worker.get('phase') not in ('ready','asleep'):return False,'application worker transition or error'
    if jobs: return False,'workspace process active'
    if now-max(last,lifecycle.get('lastActivity',now*1000)/1000,(applications or {}).get('lastActivity',0)/1000)<idle_seconds: return False,'idle countdown'
    return True,'idle'
def preview_processes(processes):
    """Recognize development listeners; unknown builds remain active jobs."""
    ignored=set()
    for pid,proc in processes.items():
        a=proc.get('args',[])
        cwd=pathlib.PurePosixPath(proc.get('cwd','/'))
        known_home_server=cwd==ROOT/'home/HomeAI/server' and len(a)==2 and a[1]=='src/index.js'
        if not a or not (cwd.is_relative_to(ROOT/'workspaces') or known_home_server):continue
        exe=pathlib.PurePosixPath(a[0]).name
        if exe in ('node','nodejs') and len(a)>1:
            vite=a[1].endswith('/vite/bin/vite.js') and 'build' not in a[2:]
            nextdev=a[1].endswith('/next/dist/bin/next') and any(x in ('dev','start') for x in a[2:])
            api=a[1]=='apps/api/src/server.js' or a[1].endswith('/apps/api/src/server.js')
            if vite or nextdev or api or known_home_server:ignored.add(pid)
        if exe.startswith('python') and a[1:3]==['-m','http.server']:ignored.add(pid)
    changed=True
    while changed:
        changed=False
        for pid,proc in processes.items():
            if pid in ignored:continue
            a=proc.get('args',[])
            descendants=proc.get('ppid') in ignored
            children=[p for p,v in processes.items() if v.get('ppid')==pid]
            wrapper=(a and pathlib.PurePosixPath(a[0]).name in ('bash','sh') and '-c' in a and '/vite/bin/vite.js' in ' '.join(a) and ' build' not in ' '.join(a) and children and all(p in ignored for p in children))
            if descendants or wrapper:ignored.add(pid);changed=True
    return ignored

def passive_worker_processes(processes, applications, now):
    """Only the exact private service and its known VM may be passive infrastructure."""
    if not applications or now-applications.get('at',0)/1000>20:return set()
    pid=applications.get('servicePid');service=processes.get(pid,{})
    a=service.get('args',[])
    if len(a)!=3 or a[0]!=str(ROOT/'node/bin/node') or a[1]!=str(ROOT/'app/vast/apps-service.cjs') or a[2]!=str(ROOT/'apps-config.json'):return set()
    ignored={pid};worker=applications.get('worker') or {};vm_pid=worker.get('pid');vm=processes.get(vm_pid,{})
    args=vm.get('args',[])
    disk='file='+str(ROOT/'docker-worker/volume.raw')+',format=raw,if=virtio,cache=writeback'
    if vm.get('ppid') in (pid,1) and vm.get('cwd')==str(ROOT/'docker-worker') and args and pathlib.PurePosixPath(args[0]).name=='qemu-system-x86_64' and disk in args and any(args[i:i+2]==['-name','stratadashseek-docker'] for i in range(len(args)-1)):ignored.add(vm_pid)
    return ignored

def jobs_running(ignore_previews=False, applications=None):
    uid=pwd.getpwnam('harness').pw_uid
    services=set(load(ROOT/'state/services.json').get('pids',[]))
    processes={}
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():continue
        try:
            if entry.stat().st_uid!=uid: continue
            status=(entry/'stat').read_text().rsplit(') ',1)[1]
            if status.startswith('Z'):continue
            try:cwd=os.readlink(entry/'cwd')
            except PermissionError:
                cwd=subprocess.check_output(['runuser','-u','harness','--','readlink',str(entry/'cwd')],text=True,timeout=3).strip()
            processes[int(entry.name)]={'ppid':int(status.split()[1]),'args':[x.decode(errors='replace') for x in (entry/'cmdline').read_bytes().split(b'\0') if x],'cwd':cwd}
        except (FileNotFoundError,ProcessLookupError):continue
        except OSError:return True
    ignored=services|passive_worker_processes(processes,applications,time.time())
    if ignore_previews:ignored|=preview_processes(processes)
    return bool(set(processes)-ignored)

def application_call(route, payload=None, timeout=110):
    key=(ROOT/'secrets/apps-internal.key').read_text().strip()
    req=urllib.request.Request('http://127.0.0.1:3093/'+route,data=json.dumps(payload or {}).encode(),headers={'X-Harness-Apps-Key':key,'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(req,timeout=timeout) as response:return json.load(response)

def audit(event, **fields):
    print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'event':event,**fields}),flush=True)
def main():
    started=time.time();last=started;preview_settings=PreviewSettings()
    # Preserve the idle clock when only this watchdog is restarted for maintenance.
    try:
        prior=load(ROOT/'state/idle-status.json')
        last=min(started,prior['at']-prior['idleSeconds'])
    except (OSError,ValueError,KeyError,TypeError):pass
    while True:
        try:
            try:preview_settings.tick()
            except Exception as e:audit('preview_settings_error',error=type(e).__name__)
            cfg=load(ROOT/'root-secrets/guard.json')
            now=time.time();life=load(ROOT/'state/lifecycle.json')
            with urllib.request.urlopen('http://127.0.0.1:8080/status',timeout=4) as r:model=json.load(r)
            app_path=ROOT/'state/applications/activity.json'
            applications=load(app_path) if app_path.exists() else None
            app_cfg=ROOT/'apps-config.json'
            if app_cfg.exists() and load(app_cfg).get('enabled') and applications is None:raise RuntimeError('Enabled application service has no heartbeat')
            jobs=jobs_running(cfg.get('ignoreDetachedPreviews',False),applications);lease=load(ROOT/'state/maintenance.json').get('until',0) if (ROOT/'state/maintenance.json').exists() else 0
            if life.get('active') or model.get('busy') or model.get('queued') or jobs or applications and applications.get('active'):last=now
            stop,reason=decide(now,last,life,model,jobs,lease,cfg.get('idleSeconds',300),applications)
            state={'at':now,'canStop':stop,'reason':reason,'idleTimeoutSeconds':cfg.get('idleSeconds',300),'idleSeconds':max(0,int(now-max(last,life.get('lastActivity',now*1000)/1000,(applications or {}).get('lastActivity',0)/1000)))}
            (ROOT/'state/idle-status.json').write_text(json.dumps(state))
            if stop and cfg.get('enabled',False):
                # Second read prevents stopping across an observed new turn.
                time.sleep(2)
                life2=load(ROOT/'state/lifecycle.json')
                with urllib.request.urlopen('http://127.0.0.1:8080/status',timeout=4) as r:model2=json.load(r)
                apps2=load(app_path) if app_path.exists() else None
                if not decide(time.time(),last,life2,model2,jobs_running(cfg.get('ignoreDetachedPreviews',False),apps2),lease,cfg.get('idleSeconds',300),apps2)[0]:continue
                token=None
                try:
                    if apps2 is not None:
                        prepared=application_call('prepare-sleep')
                        if prepared.get('ready') is not True or not prepared.get('token'):raise RuntimeError('Application sleep was not confirmed')
                        token=prepared['token']
                    life3=load(ROOT/'state/lifecycle.json');apps3=load(app_path) if app_path.exists() else None
                    with urllib.request.urlopen('http://127.0.0.1:8080/status',timeout=4) as r:model3=json.load(r)
                    lease3=load(ROOT/'state/maintenance.json').get('until',0) if (ROOT/'state/maintenance.json').exists() else 0
                    if not decide(time.time(),last,life3,model3,jobs_running(cfg.get('ignoreDetachedPreviews',False),apps3),lease3,cfg.get('idleSeconds',300),apps3)[0]:
                        audit('sleep_cancelled',reason='new activity after Docker save');continue
                    if token and application_call('confirm-sleep',{'token':token},10).get('ready') is not True:raise RuntimeError('Application sleep token changed')
                    key=(ROOT/'root-secrets/vast-api.key').read_text().strip()
                    req=urllib.request.Request('https://console.vast.ai/api/v0/instances/'+str(cfg['instanceId'])+'/',data=b'{"state":"stopped"}',headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},method='PUT')
                    with urllib.request.urlopen(req,timeout=15) as r:
                        result=json.load(r)
                        if not 200<=r.status<300 or result.get('success') is not True:raise RuntimeError('Stop rejected')
                    audit('instance_stop_requested',instanceId=cfg['instanceId'],idleSeconds=state['idleSeconds'],dockerSaved=token is not None)
                    token=None;time.sleep(30)
                finally:
                    if token:
                        try:application_call('cancel-sleep',{'token':token},10)
                        except Exception:pass
        except Exception as error:audit('idle_guard_holding',error=type(error).__name__)
        time.sleep(5)
if __name__=='__main__':main()

