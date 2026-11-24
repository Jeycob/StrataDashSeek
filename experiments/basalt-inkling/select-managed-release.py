#!/usr/bin/env python3
"""Select a root-owned lab release while preserving the original two service entrypoints."""

import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile


BASE = Path('/workspace/homeai-basalt')
SOURCE = BASE / 'source' / 'experiments' / 'basalt-inkling'
BACKUPS = Path('/root/basalt-entrypoints-before-idle')
MANAGED = BASE / 'managed-release'
ENTRIES = {'engine.sh': ('BASALT_IDLE_ENGINE=1', 'engine.sh'),
           'harness-tailnet.sh': ('BASALT_ANDORRA_TAILNET=1 BASALT_IDLE_BRIDGE=1', 'harness.sh')}


def root_path(path, directory=False):
    s = path.lstat()
    if not (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)) or s.st_uid != 0 or s.st_mode & 0o022:
        raise RuntimeError(f'unprotected or unexpected path {path}')


def write_entry(dest, data):
    with tempfile.NamedTemporaryFile('w', dir=dest.parent, prefix='.basalt-entry-', delete=False) as f:
        try:
            f.write(data)
            f.flush()
            os.fchmod(f.fileno(), 0o755)
            os.fsync(f.fileno())
            os.replace(f.name, dest)
        finally:
            Path(f.name).unlink(missing_ok=True)


def main():
    if os.geteuid() or len(sys.argv) != 2 or not re.fullmatch(r'[a-f0-9]{40}', sys.argv[1]):
        raise RuntimeError('run as root with the verified full commit SHA')
    release = BASE / 'releases' / sys.argv[1]
    if release.resolve() != release:
        raise RuntimeError('unexpected release path')
    for directory in (BASE, BASE / 'releases', release, release / 'experiments' / 'basalt-inkling', SOURCE):
        root_path(directory, directory=True)
    for file in ('engine.sh', 'harness.sh', 'profile.mjs', 'idle-native.mjs', 'idle-preload.mjs', 'idle-engine.py'):
        root_path(release / 'experiments' / 'basalt-inkling' / file)
    root_path(release / 'runtime/output-continuation/index.mjs')
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    root_path(BACKUPS, directory=True)
    # Preserve the first lab launcher before changing any selection. Repeating this command retains the backup.
    for name in ENTRIES:
        entry = SOURCE / name
        root_path(entry)
        saved = BACKUPS / name
        if not saved.exists():
            if b'/managed-release/' in entry.read_bytes():
                raise RuntimeError('missing original launcher backup')
            with saved.open('xb') as f:
                os.fchmod(f.fileno(), 0o600)
                with entry.open('rb') as original:
                    shutil.copyfileobj(original, f)
        root_path(saved)
    if MANAGED.exists() or MANAGED.is_symlink():
        if not MANAGED.is_symlink() or MANAGED.lstat().st_uid != 0 or MANAGED.resolve().parent != BASE / 'releases':
            raise RuntimeError('unexpected existing managed release')
    tmp = MANAGED.with_name('.managed-release-' + str(os.getpid()))
    tmp.symlink_to(release, target_is_directory=True)
    try:
        os.replace(tmp, MANAGED)
    finally:
        tmp.unlink(missing_ok=True)
    for name, (env, script) in ENTRIES.items():
        dest = SOURCE / name
        command = f'#!/bin/bash\nset -eu\nexport {env}\nexec /usr/bin/bash {MANAGED}/experiments/basalt-inkling/{script} "$@"\n'
        if dest.read_text() != command:
            write_entry(dest, command)
    print(f'Selected {release.name} for future lab service starts.')


if __name__ == '__main__':
    main()
