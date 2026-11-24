"""Bounded Linux host operations for the root Basalt idle supervisor. No request or key is logged."""
import fcntl
import hashlib
import http.client
import json
import os
import pwd
import re
import socket
import stat
import struct
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

ID = '62357205'
STATE = Path('/var/lib/basalt-idle')
JOURNAL = STATE / 'attempt.json'
CONFIG = Path('/etc/basalt-idle')
SERVICE = Path('/usr/local/libexec/homeai-basalt')
BASE = Path('/workspace/homeai-basalt')
ENGINE = BASE / 'state/engine/basalt-v0.5.7-linux-x64'
NATIVE = Path('/run/basalt-lab-control/native-idle.sock')
GATE = Path('/run/basalt-pairing/idle-engine.sock')
NODE = '/opt/basalt-node-v24.22.3/bin/node'
CLI = str(BASE / 'state/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')


def need(condition):
    if not condition:
        raise ValueError('unconfirmed')


def directory(path, uid=0, mode=0o700):
    s = path.lstat()
    need(stat.S_ISDIR(s.st_mode) and s.st_uid == uid and (uid != 0 or s.st_gid == 0) and stat.S_IMODE(s.st_mode) == mode)


def protected(path, modes, size):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as f:
        s = os.fstat(f.fileno())
        need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_gid == 0 and s.st_nlink == 1 and stat.S_IMODE(s.st_mode) in modes)
        data = f.read(size + 1)
        need(len(data) <= size)
        return data


def enabled():
    try:
        directory(CONFIG)
        try:
            (CONFIG / 'maintenance').lstat()
            return False
        except FileNotFoundError:
            pass
        return protected(CONFIG / 'enabled', {0o600}, 10) in (ID.encode(), (ID + '\n').encode())
    except (OSError, ValueError):
        return False


def procstat(pid):
    fields = Path('/proc', str(pid), 'stat').read_text().rsplit(') ', 1)[1].split()
    return fields[0], fields[19]


def incarnation():
    return str(uuid.UUID(Path('/proc/sys/kernel/random/boot_id').read_text().strip())) + '_' + procstat(1)[1]


def listener(pid, port):
    proc = Path('/proc', str(pid))
    address = '0100007F:' + format(port, '04X')
    inodes = {row[9] for line in (proc / 'net/tcp').read_text().splitlines()[1:]
              if (row := line.split())[1] == address and row[3] == '0A'}
    for fd in (proc / 'fd').iterdir():
        try:
            if os.readlink(fd) in {'socket:[' + inode + ']' for inode in inodes}:
                return True
        except FileNotFoundError:
            continue
    return False


def verify_engine(pid, uid):
    proc = Path('/proc', str(pid))
    need(proc.stat().st_uid == uid and listener(pid, 8080))
    args = (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
    need(os.readlink(proc / 'exe') == os.path.realpath(ENGINE / '.venv/bin/python') and
         args[:5] == [str(ENGINE / '.venv/bin/python'), '-I', '-B', '-X', 'pycache_prefix=/dev/null'])
    script = Path(args[5]).resolve(strict=True)
    releases = BASE / 'releases'
    rel = script.relative_to(releases).parts
    need(len(rel) == 4 and re.fullmatch('[0-9a-f]{40}', rel[0]) and rel[1:] == ('experiments','basalt-inkling','idle-engine.py'))
    for parent in [releases, *list(script.parents)[:3]]:
        s = parent.lstat()
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022)
    need(hashlib.sha256(protected(script, {0o444,0o555,0o644,0o755}, 65536)).digest() ==
         hashlib.sha256(protected(SERVICE / 'idle-engine.py', {0o444,0o555,0o644,0o755}, 65536)).digest())
    need(args[6:] == ['--engine-bin', str(ENGINE / 'bin/basalt'), '--model', str(BASE / 'state/engine/Inkling-2-Mini-NVFP4-MX8.basalt'),
                      '--alias','inkling-2-mini','--host','127.0.0.1','--port','8080','--gpu','0','--parallel','1',
                      '--max-context','131072','--kv','fp8','--vision','dynamic','--image-remote-only'])


def control(which, req):
    is_engine = which == 'engine'
    endpoint = GATE if is_engine else NATIVE
    lab_uid = pwd.getpwnam('basaltlab').pw_uid
    uid = lab_uid if is_engine else 0
    directory(endpoint.parent, uid)
    s = endpoint.lstat()
    need(stat.S_ISSOCK(s.st_mode) and s.st_uid == uid and stat.S_IMODE(s.st_mode) == 0o600)
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(4)
        client.connect(str(endpoint))
        pid, peer, _ = struct.unpack('iII', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        need(peer == uid)
        ticks = procstat(pid)[1]
        if is_engine:
            verify_engine(pid, uid)
        else:
            argv = Path('/proc',str(pid),'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            need(os.readlink(f'/proc/{pid}/exe') == os.path.realpath('/usr/bin/python3') and
                 argv == [b'/usr/bin/python3',b'-I',os.fsencode(SERVICE / 'native-idle-bridge.py')])
        client.sendall(json.dumps(req).encode() + b'\n')
        with client.makefile('rb') as stream:
            line = stream.readline(2049)
        need(len(line) <= 2048 and line.endswith(b'\n') and procstat(pid)[1] == ticks)
        value = json.loads(line)
        need(value.get('ok') is True and str(uuid.UUID(value['epoch'])) == value['epoch'] and
             type(value['revision']) is int and value['revision'] >= 0)
        if is_engine:
            need(type(value['active']) is int and value['active'] >= 0 and type(value['drained']) is bool)
            value.update(pid=pid, startTicks=ticks)
        else:
            who = value['pid']
            need(type(who) is int and who > 1 and value['bootId'] == incarnation().split('_')[0] and
                 procstat(who)[1] == value['startTicks'] and stat.S_ISDIR(os.stat(f'/proc/{who}').st_mode) and
                 os.stat(f'/proc/{who}').st_uid == lab_uid and os.readlink(f'/proc/{who}/exe') == os.path.realpath(NODE) and listener(who,8787))
            argv = Path('/proc',str(who),'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            need(any(argv[i:i+2] == [os.fsencode(CLI), b'web'] for i in range(len(argv)-1)))
            need(type(value['busy']) is bool and type(value['frozen']) is bool and (procstat(who)[0] == 'T') == value['frozen'])
        return value


def snapshot(lease=None):
    need(enabled())
    host = incarnation()
    native = control('native', {'op':'status'})
    engine = control('engine', {'op':'status'})
    need(native['frozen'] == (lease is not None) and engine['drained'] == (lease is not None)
         and native['lease'] == lease and engine['lease'] == lease and incarnation() == host)
    conn = http.client.HTTPConnection('127.0.0.1', 8080, timeout=2)
    try:
        conn.request('GET','/v1/models')
        response = conn.getresponse()
        body = response.read(131073)
        need(response.status == 200 and len(body) <= 131072)
        models = json.loads(body)['data']
        need(len(models) == 1 and models[0]['id'] == 'inkling-2-mini' and models[0]['status']['value'] == 'loaded')
    finally:
        conn.close()
    for row, port in [(native,8787),(engine,8080)]:
        need(procstat(row['pid'])[1] == row['startTicks'] and listener(row['pid'], port))
    return {'host':host, 'native':native, 'engine':engine}


def proof(s):
    return [s['host'], *[[s[k][f] for f in ('pid','startTicks','epoch','revision')] for k in ('native','engine')]]


def sync_dir():
    fd = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save(j):
    j['updatedAt'] = datetime.now(timezone.utc).isoformat()
    tmp = STATE / ('.attempt-' + str(uuid.uuid4()))
    with tmp.open('x') as f:
        json.dump(j, f, separators=(',',':'))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp,JOURNAL)
    sync_dir()


def record():
    try:
        j = json.loads(protected(JOURNAL,{0o600},8192))
    except FileNotFoundError:
        return None
    need(j['id'] == ID and str(uuid.UUID(j['lease'])) == j['lease'] and
         re.fullmatch('[0-9a-f-]{36}_[0-9]+', j['host']) and j['phase'] in
         ('preparing','held','uncertain','acknowledged','refused','reopening','retired','stopping'))
    return j


def drop_or_archive(j):
    if j['submitted']:
        os.replace(JOURNAL, STATE / ('attempt-' + j['host'] + '.json'))
    else:
        JOURNAL.unlink()
    sync_dir()


def reopen(j):
    # Engine admission must be open before Native can resume queued work.
    for which, flag, op in [('engine','drained','reopen'), ('native','frozen','thaw')]:
        try:
            s = control(which, {'op':'status'})
        except (OSError, ValueError, KeyError):
            if which != 'native':
                raise
            # A broker may have durably recorded intent and stopped the PID before returning frozen=true.
            control(which, {'op':op, 'lease':j['lease']})
            s = control(which, {'op':'status'})
        if s[flag]:
            need(s['lease'] == j['lease'])
            args = {'op':op, 'lease':j['lease']}
            if which == 'engine':
                args['epoch'] = s['epoch']
            control(which,args)
        verify = control(which, {'op':'status'})
        need(verify[flag] is False and verify['lease'] is None)


def provider_key():
    directory(Path('/root'))
    key = protected(Path('/root/.vast_api_key'), {0o400,0o600,0o640,0o644}, 4096).strip()
    need(0 < len(key) <= 4096 and re.fullmatch(rb'[!-~]+', key))
    return key


def provider(method, key):
    conn = http.client.HTTPSConnection('console.vast.ai', timeout=5)
    try:
        conn.request(method,'/api/v0/instances/'+ID+'/',body=b'{"state":"stopped"}' if method == 'PUT' else None,
                     headers={'Authorization':'Bearer '+key.decode('ascii'), 'Content-Type':'application/json', 'Cache-Control':'no-cache'})
        response = conn.getresponse()
        data = response.read(262145)
        need(len(data) <= 262144)
        if method == 'PUT':
            if response.status in (400,401,403,404,405,422):
                return 'refused'
            need(200 <= response.status < 300)
            result = json.loads(data)
            if result.get('success') is True:
                return 'acknowledged'
            # Vast can return success:false *and* queue a state change. Treat only a
            # specific permission/validation denial as definitive; expose no provider text.
            reason = str(result.get('error','')) + ' ' + str(result.get('msg',''))
            if (result.get('success') is False and not re.search(r'queued|pending|timeout',reason,re.I)
                    and re.search(r'forbidden|unauthori[sz]ed|permission denied|invalid instance|instance not found', reason, re.I)):
                return 'refused'
            return 'uncertain'
        need(response.status == 200)
        row = json.loads(data)['instances']
        need(str(row['id']) == ID)
        return row['actual_status'], row['intended_status']
    finally:
        conn.close()


def reconcile(j, manual=False):
    if not j:
        return 'idle'
    same = j['host'] == incarnation()
    phase = j['phase']
    if phase == 'retired' and same:
        return 'retired'
    if j['submitted'] and phase not in ('reopening','retired'):
        if not enabled():
            return 'pending-policy-disabled'
        try:
            actual, intended = provider('GET', provider_key())
        except (ValueError, OSError, KeyError, http.client.HTTPException):
            return 'pending-provider-unconfirmed'
        if intended == 'stopped' or actual in ('exited','stopped'):
            if phase != 'stopping':
                j['phase'] = 'stopping'
                save(j)
            return 'stopping'
        if (actual, intended) != ('running','running') or (same and phase != 'refused' and not manual):
            return 'pending'
        j['phase'] = 'reopening'
        save(j)
    reopen(j)
    if j['submitted'] and same:
        j['phase'] = 'retired'
        save(j)
        return 'retired'
    drop_or_archive(j)
    return 'idle'


def dispatch(q):
    op = q['op']
    if op == 'init':
        STATE.mkdir(mode=0o700, exist_ok=True)
    directory(STATE)
    if op == 'init':
        return 'ready'
    if op == 'lock':
        s = os.fstat(3)
        need(os.path.samestat(s, (STATE / 'supervisor.lock').lstat()) and stat.S_ISREG(s.st_mode) and
             s.st_uid == 0 and s.st_nlink == 1 and stat.S_IMODE(s.st_mode) == 0o600)
        fcntl.flock(3,fcntl.LOCK_EX | fcntl.LOCK_NB)
        return 'locked'
    j = record()
    if op == 'reconcile':
        return 'disabled' if not j and not enabled() else reconcile(j, q.get('manual') is True)
    if op == 'observe':
        s = snapshot(j['lease'] if j and j['phase'] == 'held' else None)
        return {'identity':proof(s), 'nativeBusy':s['native']['busy'], 'engineBusy': s['engine']['active'] != 0}
    if op == 'fence':
        need(j is None)
        s = snapshot()
        need(not s['native']['busy'] and s['engine']['active'] == 0 and proof(s) == q['identity'])
        j = {'id':ID, 'host':s['host'], 'identity':proof(s), 'lease':str(uuid.uuid4()), 'phase':'preparing','submitted':False}
        save(j)
        for which, name in [('native','freeze'),('engine','drain')]:
            control(which, {'op':name, 'lease':j['lease'], 'epoch':s[which]['epoch'], 'revision':s[which]['revision']})
        reread = snapshot(j['lease'])
        need(proof(reread) == j['identity'] and not reread['native']['busy'] and reread['engine']['active'] == 0)
        j['phase'] = 'held'
        save(j)
        return 'held'
    if op == 'abort':
        need(j and not j['submitted'])
        return reconcile(j)
    if op == 'commit':
        need(j and j['phase'] == 'held' and not j['submitted'] and j['host'] == incarnation())
        need(enabled())
        key = provider_key()
        need(provider('GET', key) == ('running','running'))
        s = snapshot(j['lease'])
        need(proof(s) == j['identity'] and not s['native']['busy'] and s['engine']['active'] == 0 and enabled())
        j.update(phase='uncertain', submitted=True, submittedAt=datetime.now(timezone.utc).isoformat())
        save(j)  # A crash from this point onwards permits only GET reconciliation.
        if not enabled():
            j.update(phase='preparing', submitted=False)
            save(j)
            return 'policy-changed-before-send'
        j['phase'] = provider('PUT', key)
        save(j)
        return 'submitted'
    raise ValueError('unsupported')


if __name__ == '__main__':
    try:
        need(os.geteuid() == 0)
        os.umask(0o077)
        req = sys.stdin.buffer.readline(8193)
        need(len(req) <= 8192 and req.endswith(b'\n'))
        print(json.dumps({'ok':True,'value':dispatch(json.loads(req))}, separators=(',',':')))
    except Exception:
        print('{"ok":false,"code":"UNCONFIRMED"}')
