#!/usr/bin/env python3
"""Install the repo's boot hook for an already-enrolled Basalt SSH instance."""

import os
from pathlib import Path
import stat
import tempfile


SERVICE = Path('/usr/local/libexec/homeai-basalt')
LOGS = Path('/var/log/basalt-lab-control')
ONSTART = Path('/root/onstart.sh')
BACKUP = Path('/root/onstart.before-homeai-basalt.sh')
MARK = b'# homeai-basalt cold boot v1'
CMD = (b'/usr/bin/nohup /usr/bin/setsid /usr/bin/python3 -I /usr/local/libexec/homeai-basalt/cold-boot.py '
       b'</dev/null >>/var/log/basalt-lab-control/boot.log 2>&1 &')


def check_private(path, *, directory=False):
    st = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError(f'expected a protected root-owned path: {path}')
    return st


def replace(path, data, mode):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.basalt-boot-', delete=False) as f:
        try:
            f.write(data)
            f.flush()
            os.fchmod(f.fileno(), mode)
            os.fsync(f.fileno())
            os.replace(f.name, path)
        finally:
            Path(f.name).unlink(missing_ok=True)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('installation requires root on the Basalt lab')
    if not Path('/etc/basalt-pair-owner').is_file():
        raise RuntimeError('install the enrolled owner pairing before the cold-boot hook')
    scripts = [Path(__file__).with_name(name) for name in (
        'cold-boot.py', 'serve-ready-image.py', 'native-idle-bridge.py', 'idle-supervisor.mjs',
        'idle-supervisor-host.py', 'idle-guard.mjs', 'idle-engine.py')]
    for script in scripts:
        check_private(script)
    original = check_private(ONSTART)
    current = ONSTART.read_bytes()
    hook = MARK + b'\n' + CMD + b'\n'
    if MARK in current and (current.count(MARK) != 1 or hook not in current):
        raise RuntimeError('unrecognized existing Basalt startup hook')
    if MARK not in current and any(l.strip() and not l.lstrip().startswith(b'#') for l in current.splitlines()):
        raise RuntimeError('review the existing executable onstart commands before adding the hook')
    SERVICE.mkdir(mode=0o755, parents=True, exist_ok=True)
    LOGS.mkdir(mode=0o700, exist_ok=True)
    check_private(SERVICE, directory=True)
    check_private(LOGS, directory=True)
    for script in scripts:
        destination = SERVICE / script.name
        data = script.read_bytes()
        if destination.exists():
            check_private(destination)
        if not destination.exists() or destination.read_bytes() != data:
            replace(destination, data, 0o755)
    if MARK not in current:
        try:
            with BACKUP.open('xb') as backup:
                os.fchmod(backup.fileno(), 0o600)
                backup.write(current)
        except FileExistsError:
            check_private(BACKUP)
            if BACKUP.read_bytes() != current:
                raise RuntimeError('a different original onstart backup already exists')
        replace(ONSTART, current.rstrip(b'\n') + b'\n' + hook, stat.S_IMODE(original.st_mode))
    print('Cold-boot hook installed. The previous onstart file remains in /root/onstart.before-homeai-basalt.sh.')


if __name__ == '__main__':
    main()
