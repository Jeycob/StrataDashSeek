#!/usr/bin/env python3
"""Restore the Andorra lab's existing services and private tailnet after Vast starts it."""

import fcntl
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import subprocess
import time


BASE = Path('/workspace/homeai-basalt')
HOST = 'basalt-inkling.tail9a42c6.ts.net'
USER = 'basaltlab'
TS_STATE = Path('/var/lib/basalt-tailscale')
TS_RUN = Path('/run/basalt-tailscale')
TS_SOCKET = TS_RUN / 'tailscaled.sock'
PAIR_RUN = Path('/run/basalt-pairing')
PAIR_SOCKET = PAIR_RUN / 'owner.sock'
READY_SOCKET = PAIR_RUN / 'ready.sock'
ROOT_RUN = Path('/run/basalt-lab-control')
LOGS = Path('/var/log/basalt-lab-control')
TOOLS = ['/usr/bin/tailscale', '--socket=' + str(TS_SOCKET)]
CLEAN_ENV = {'PATH': '/opt/basalt-node-v24.22.3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
             'HOME': '/home/basaltlab', 'LANG': 'C.UTF-8'}


def directory(path, uid, gid, mode):
    try:
        path.mkdir(mode=mode)
    except FileExistsError:
        st = path.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or stat.S_IMODE(st.st_mode) != mode:
            raise RuntimeError(f'unexpected owner, type or mode: {path}')
    else:
        os.chown(path, uid, gid)
        os.chmod(path, mode)


def private_process(args, log_name):
    with (LOGS / log_name).open('ab', buffering=0) as log:
        return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True, cwd='/', close_fds=True, env=CLEAN_ENV)


def process_start(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()[19]
    except FileNotFoundError:
        return None


def root_service(name, args):
    record = ROOT_RUN / (name + '.json')
    if record.is_file():
        old = json.loads(record.read_text())
        if process_start(old['pid']) == old['start'] and old['start'] is not None:
            actual = Path(f'/proc/{old["pid"]}/cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            if actual == [os.fsencode(x) for x in args]:
                return
            raise RuntimeError(f'unexpected live {name} process')
    child = private_process(args, name + '.log')
    for _ in range(10):
        if child.poll() is not None:
            raise RuntimeError(f'{name} exited during startup')
        time.sleep(.05)
    staged = record.with_suffix('.tmp')
    staged.write_text(json.dumps({'pid': child.pid, 'start': process_start(child.pid)}))
    staged.replace(record)


def socket_listens(path, uid):
    try:
        item = path.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISSOCK(item.st_mode) or item.st_uid != uid:
        raise RuntimeError(f'unexpected socket: {path}')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(2)
        try:
            client.connect(str(path))
        except ConnectionRefusedError:
            path.unlink()
            return False
    return True


def as_lab(*command):
    return ['/usr/sbin/runuser', '-u', USER, '--', '/usr/bin/env', '-i',
            *[name + '=' + value for name, value in CLEAN_ENV.items()], *map(str, command)]


def restore_tailnet():
    directory(TS_RUN, 0, 0, 0o700)
    # Reuse the enrolled node. Starting with an empty directory would create another device.
    node_state = TS_STATE / 'tailscaled.state'
    st = node_state.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid or st.st_mode & 0o077 or not st.st_size:
        raise RuntimeError('expected private persistent tailscaled state')
    if not socket_listens(TS_SOCKET, 0):
        private_process(['/usr/sbin/tailscaled', '--tun=userspace-networking', '--statedir=' + str(TS_STATE),
                         '--state=' + str(node_state), '--socket=' + str(TS_SOCKET)], 'tailscaled.log')


def verify_private_routes():
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        status = subprocess.run(TOOLS + ['status', '--peers=false', '--json'], capture_output=True, timeout=6)
        if status.returncode == 0:
            info = json.loads(status.stdout)
            if info.get('BackendState') == 'Running':
                if info['Self']['DNSName'].rstrip('.') != HOST:
                    raise RuntimeError('unexpected Tailscale node identity')
                break
        time.sleep(2)
    else:
        raise RuntimeError('timed out waiting for the enrolled Tailscale node')
    def current_routes():
        return json.loads(subprocess.check_output(TOOLS + ['serve', 'status', '--json'], timeout=6))

    routes = current_routes()
    handlers = routes.get('Web', {}).get(HOST + ':443', {}).get('Handlers', {})
    if (routes.get('TCP', {}).get('443', {}).get('HTTPS') is not True or
            handlers.get('/', {}).get('Proxy') != 'http://127.0.0.1:8787' or
            handlers.get('/pair', {}).get('Proxy') != 'unix:' + str(PAIR_SOCKET) or
            any((routes.get('AllowFunnel') or {}).values())):
        raise RuntimeError('expected persisted private Serve routes for Native and pairing')
    ready_proxy = 'unix:' + str(READY_SOCKET)
    if '/phone/icon.png' not in handlers:
        subprocess.run(TOOLS + ['serve', '--bg', '--https=443', '--set-path=/phone/icon.png', ready_proxy],
                       stdout=subprocess.DEVNULL, check=True, timeout=10)
        routes = current_routes()
        handlers = routes.get('Web', {}).get(HOST + ':443', {}).get('Handlers', {})
    if handlers.get('/phone/icon.png', {}).get('Proxy') != ready_proxy:
        raise RuntimeError('readiness route has an unexpected destination')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('run from the root-owned Vast startup hook')
    os.umask(0o077)
    directory(ROOT_RUN, 0, 0, 0o700)
    directory(LOGS, 0, 0, 0o700)
    user = pwd.getpwnam(USER)
    with (ROOT_RUN / 'boot.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        managing = (BASE / 'managed-release').is_symlink()
        here = Path(__file__).parent
        if managing:
            directory(Path('/etc/basalt-idle'), 0, 0, 0o700)
            root_service('native-idle-bridge', ['/usr/bin/python3', '-I', str(here / 'native-idle-bridge.py')])
        restore_tailnet()
        directory(PAIR_RUN, user.pw_uid, user.pw_gid, 0o700)
        if not socket_listens(PAIR_SOCKET, user.pw_uid):
            private_process(as_lab('/usr/bin/python3', BASE / 'tailnet-pair.py'), 'pairing.log')
        if not socket_listens(READY_SOCKET, user.pw_uid):
            private_process(as_lab('/usr/bin/python3', '-I', Path(__file__).with_name('serve-ready-image.py')),
                            'readiness.log')
        # The existing launcher verifies the recorded weights and starts only missing services.
        subprocess.run(as_lab('/usr/bin/bash', BASE / 'start-lab.sh'), cwd='/', check=True, timeout=660)
        verify_private_routes()
        if not all(socket_listens(p, user.pw_uid) for p in (PAIR_SOCKET, READY_SOCKET)):
            raise RuntimeError('owner pairing or readiness socket unavailable')
        if managing:
            root_service('idle-supervisor', ['/opt/basalt-node-v24.22.3/bin/node', str(here / 'idle-supervisor.mjs')])
        print('Basalt, Native and the private owner entry are ready.', flush=True)


if __name__ == '__main__':
    main()
