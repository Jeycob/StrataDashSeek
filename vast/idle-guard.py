"""Root watchdog: never stop across a live turn, build, unknown model state or stale heartbeat."""
import json, pathlib, time, urllib.request, os, pwd, subprocess, datetime, http.client
from preview_settings import PreviewSettings
from runtime_paths import RuntimePaths
ROOT=pathlib.Path('/data/harness')
RUNTIME=None
DEFAULT_IDLE_SECONDS = 300

def load(path): return json.loads(path.read_text())


def idle_elapsed_seconds(now, last, lifecycle, applications):
    last_turn = lifecycle.get('lastActivity', now * 1000) / 1000
    last_app = (applications or {}).get('lastActivity', 0) / 1000
    return now - max(now if last is None else last, last_turn, last_app)


def fifo_has_work(queue):
    if queue is None:
        return False  # Older profiles without the whole-task scheduler.
    return (not isinstance(queue, dict) or 'owner' not in queue or queue['owner'] is not None
            or any(not isinstance(queue.get(key), list) or queue[key] for key in ('active', 'waiting')))


def model_idle(model):
    return (isinstance(model, dict) and model.get('loaded') is True and model.get('busy') is False
            and type(model.get('queued')) is int and model['queued'] == 0)


def observe_idle_clock(last, inputs):
    if not model_idle(inputs['model']):
        return None
    if (last is None or inputs['lifecycle'].get('active') or inputs['jobs'] or fifo_has_work(inputs['queue'])
            or (inputs['applications'] or {}).get('active')):
        return inputs['now']
    return last


def decide(now, last, lifecycle, model, jobs, lease_until, idle_seconds=DEFAULT_IDLE_SECONDS, applications=None, queue=None):
    if now < lease_until:
        return False, 'maintenance lease'
    if now - lifecycle.get('at', 0) / 1000 > 20:
        return False, 'lifecycle heartbeat unavailable'
    if lifecycle.get('active', 0):
        return False, 'agent turn active'
    if fifo_has_work(queue):
        return False, 'turn queue active or unknown'
    if not model_idle(model):
        return False, 'model busy or unknown'

    if applications is not None:
        if now - applications.get('at', 0) / 1000 > 20:
            return False, 'application worker heartbeat unavailable'
        if applications.get('active', 0):
            return False, 'application build or test active'
        if applications.get('holdUntil', 0) > now * 1000:
            return False, 'application awake lease'
        worker = applications.get('worker') or {}
        if worker.get('pid') and worker.get('phase') not in ('ready', 'asleep'):
            return False, 'application worker transition or error'

    if jobs:
        return False, 'workspace process active'
    if idle_elapsed_seconds(now, last, lifecycle, applications) < idle_seconds:
        return False, 'idle countdown'
    return True, 'idle'

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
    services=set(RUNTIME.read_private('services.json',{}).get('pids',[]))
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


def apps_sleep_mode(now, settings, applications, service_pid):
    if not isinstance(settings, dict) or type(settings.get('enabled')) is not bool:
        return None
    if not isinstance(applications, dict) or type(service_pid) is not int or service_pid <= 1:
        return None
    at = applications.get('at')
    if (type(at) is not int or not 0 <= now * 1000 - at <= 20000
            or applications.get('servicePid') != service_pid
            or applications.get('enabled') is not settings['enabled']
            or type(applications.get('draining')) is not bool):
        return None
    if settings['enabled']:
        return 'drain'
    if (any(type(applications.get(key)) is not int or applications[key] != 0
            for key in ('active', 'previewRequests'))
            or type(applications.get('holdUntil')) is not int
            or not 0 <= applications['holdUntil'] <= now * 1000
            or type(applications.get('lastActivity')) is not int
            or not 0 <= applications['lastActivity'] <= now * 1000
            or applications['draining'] or 'worker' not in applications):
        return None
    vm = settings.get('vm', {})
    if not isinstance(vm, dict) or type(vm.get('enabled', False)) is not bool:
        return None
    worker = applications['worker']
    if not vm.get('enabled', False):
        return 'off' if worker is None else None
    if (isinstance(worker, dict) and worker.get('phase') in ('disabled', 'asleep')
            and 'pid' in worker and worker['pid'] is None
            and 'error' in worker and worker['error'] is None):
        return 'off'
    return None


def read_model_status():
    try:
        with urllib.request.urlopen('http://127.0.0.1:8080/status', timeout=4) as response:
            if response.status != 200:
                return None
            status = json.load(response)
        with urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4) as response:
            if response.status != 200:
                return None
            health = json.load(response)
    except (OSError, ValueError, http.client.HTTPException):
        return None
    if not isinstance(status, dict) or not isinstance(health, dict):
        return None
    return {**status, 'loaded': health.get('loaded') is True}


def read_idle_inputs(cfg):
    settings = load(ROOT/'apps-config.json')
    applications = RUNTIME.read_agent('applications/activity.json')
    # A disabled controller never exempts an old guest from live process checks.
    jobs = jobs_running(cfg.get('ignoreDetachedPreviews', False), applications if settings.get('enabled') is True else None)
    model = read_model_status()
    life = RUNTIME.read_agent('lifecycle.json')
    queue = RUNTIME.read_agent('turn-queue.json')
    lease = (RUNTIME.read_agent('maintenance.json', 4096) or {}).get('until', 0)
    applications = RUNTIME.read_agent('applications/activity.json')
    roles = RUNTIME.read_private('services.json', {}).get('names', {})
    now = time.time()
    mode = apps_sleep_mode(now, settings, applications, roles.get('applications'))
    authority = (mode, settings, roles.get('applications')) if mode and load(ROOT/'root-secrets/guard.json') == cfg else None
    inputs = dict(now=now, lifecycle=life, model=model, jobs=jobs, lease_until=lease,
                  idle_seconds=cfg.get('idleSeconds', DEFAULT_IDLE_SECONDS), applications=applications, queue=queue)
    return authority, inputs


def still_idle(authority, last, read_inputs, owns_drain=False):
    observed, inputs = read_inputs()
    if observed != authority or inputs['applications']['draining'] is not owns_drain:
        return None
    return inputs if decide(last=last, **inputs)[0] else None


def stop_if_idle(authority, last, read_inputs, call_apps, request_stop):
    if authority is None or not still_idle(authority, last, read_inputs):
        return False
    token = None
    try:
        if authority[0] == 'drain':
            prepared = call_apps('prepare-sleep')
            if prepared.get('ready') is not True or not prepared.get('token'):
                raise RuntimeError('Application sleep was not confirmed')
            token = prepared['token']
        final = still_idle(authority, last, read_inputs, owns_drain=token is not None)
        if token and final:
            if call_apps('confirm-sleep', {'token':token}, 10).get('ready') is not True:
                raise RuntimeError('Application sleep token changed')
            final = still_idle(authority, last, read_inputs, owns_drain=True)
        if not final:
            audit('sleep_cancelled', reason='runtime activity or application authority changed')
            return False
        request_stop(token is not None, max(0, int(idle_elapsed_seconds(
            final['now'], last, final['lifecycle'], final['applications']))))
        token = None
        return True
    finally:
        if token:
            try:
                call_apps('cancel-sleep', {'token':token}, 10)
            except Exception:
                pass


def stop_vast_instance(cfg, docker_saved, idle_seconds):
    key = pathlib.Path(cfg.get('vastApiKeyFile', str(ROOT/'root-secrets/vast-api.key'))).read_text().strip()
    req = urllib.request.Request('https://console.vast.ai/api/v0/instances/'+str(cfg['instanceId'])+'/',
        data=b'{"state":"stopped"}', headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'}, method='PUT')
    with urllib.request.urlopen(req,timeout=15) as response:
        result = json.load(response)
        if not 200 <= response.status < 300 or result.get('success') is not True:
            raise RuntimeError('Stop rejected')
    audit('instance_stop_requested', instanceId=cfg['instanceId'], idleSeconds=idle_seconds, dockerSaved=docker_saved)


def main():
    global RUNTIME
    RUNTIME=RuntimePaths(ROOT)
    last=None;preview_settings=PreviewSettings()

    def observe_inputs(cfg):
        nonlocal last
        try:
            authority, inputs = read_idle_inputs(cfg)
            last = observe_idle_clock(last, inputs)
            return authority, inputs
        except Exception:
            last = None
            raise

    while True:
        try:
            try:preview_settings.tick()
            except Exception as e:audit('preview_settings_error',error=type(e).__name__)
            cfg=load(ROOT/'root-secrets/guard.json')
            authority, inputs = observe_inputs(cfg)
            now, life, applications = (inputs[key] for key in ('now', 'lifecycle', 'applications'))
            stop, reason = decide(last=last, **inputs)
            if stop and (authority is None or applications['draining']):
                stop, reason = False, 'application sleep state unavailable or draining'
            state = {
                'at': now,
                'canStop': stop,
                'reason': reason,
                'idleTimeoutSeconds': inputs['idle_seconds'],
                'idleSeconds': max(0, int(idle_elapsed_seconds(now, last, life, applications))),
            }
            RUNTIME.publish('idle-status.json',state)
            if stop and cfg.get('enabled',False):
                time.sleep(2)
                if stop_if_idle(authority, last, lambda: observe_inputs(cfg), application_call,
                                lambda saved, idle: stop_vast_instance(cfg, saved, idle)):
                    time.sleep(30)
        except Exception as error:audit('idle_guard_holding',error=type(error).__name__)
        time.sleep(5)
if __name__=='__main__':main()

