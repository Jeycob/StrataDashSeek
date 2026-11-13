"""Root watchdog: never stop across a live turn, build, unknown model state or stale heartbeat."""
import json, pathlib, time, urllib.request, os, pwd
ROOT=pathlib.Path('/data/harness')
def load(path): return json.loads(path.read_text())
def decide(now, last, lifecycle, model, jobs, lease_until, idle_seconds=300):
    if now < lease_until: return False,'maintenance lease'
    if now-lifecycle.get('at',0)/1000>20: return False,'lifecycle heartbeat unavailable'
    if lifecycle.get('active',0): return False,'agent turn active'
    if model.get('busy') is not False or model.get('queued',0): return False,'model busy or unknown'
    if jobs: return False,'workspace process active'
    if now-max(last,lifecycle.get('lastActivity',now*1000)/1000)<idle_seconds: return False,'idle countdown'
    return True,'idle'
def jobs_running():
    uid=pwd.getpwnam('harness').pw_uid
    services=set(load(ROOT/'state/services.json').get('pids',[]))
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():continue
        try:
            if entry.stat().st_uid!=uid or int(entry.name) in services: continue
            status=(entry/'stat').read_text().split(') ',1)[1]
            if status.startswith('Z'):continue
            return True
        except (OSError,ProcessLookupError):continue
    return False
def main():
    started=time.time();last=started
    # Preserve the idle clock when only this watchdog is restarted for maintenance.
    try:
        prior=load(ROOT/'state/idle-status.json')
        last=min(started,prior['at']-prior['idleSeconds'])
    except (OSError,ValueError,KeyError,TypeError):pass
    while True:
        try:
            cfg=load(ROOT/'root-secrets/guard.json')
            now=time.time();life=load(ROOT/'state/lifecycle.json')
            with urllib.request.urlopen('http://127.0.0.1:8080/status',timeout=4) as r:model=json.load(r)
            jobs=jobs_running();lease=load(ROOT/'state/maintenance.json').get('until',0) if (ROOT/'state/maintenance.json').exists() else 0
            if life.get('active') or model.get('busy') or model.get('queued') or jobs:last=now
            stop,reason=decide(now,last,life,model,jobs,lease,cfg.get('idleSeconds',300))
            state={'at':now,'canStop':stop,'reason':reason,'idleSeconds':max(0,int(now-max(last,life.get('lastActivity',now*1000)/1000)))}
            (ROOT/'state/idle-status.json').write_text(json.dumps(state))
            if stop and cfg.get('enabled',False):
                # Second read prevents stopping across an observed new turn.
                time.sleep(2)
                life2=load(ROOT/'state/lifecycle.json')
                with urllib.request.urlopen('http://127.0.0.1:8080/status',timeout=4) as r:model2=json.load(r)
                if not decide(time.time(),last,life2,model2,jobs_running(),lease,cfg.get('idleSeconds',300))[0]:continue
                key=(ROOT/'root-secrets/vast-api.key').read_text().strip()
                req=urllib.request.Request('https://console.vast.ai/api/v0/instances/'+str(cfg['instanceId'])+'/',data=b'{"state":"stopped"}',headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},method='PUT')
                with urllib.request.urlopen(req,timeout=15) as r:
                    if not 200<=r.status<300:raise RuntimeError('Stop rejected')
                print('Instance stop requested after safe idle',flush=True);time.sleep(60)
        except Exception as error:print('Idle guard holding: '+type(error).__name__,flush=True)
        time.sleep(5)
if __name__=='__main__':main()
