"""Private, bounded watcher cursor and retry state, with a persistent OS lock."""
import contextlib
import json
import os
import pathlib
import stat
import shutil
import uuid

MAX_BYTES = 8 * 1024 * 1024


class WatcherStateError(RuntimeError):
    pass


def validate(value):
    if not isinstance(value, dict) or value.get('version') != 1:
        raise WatcherStateError('Unsupported watcher state')
    if type(value.get('initializedAt')) is not int or value['initializedAt'] < 0:
        raise WatcherStateError('Invalid watcher epoch')
    cursors, pending = value.get('cursors'), value.get('pending')
    if not isinstance(cursors, dict) or len(cursors) > 10000 or not isinstance(pending, dict) or len(pending) > 2048:
        raise WatcherStateError('Watcher state limit')
    for key, sequence in cursors.items():
        if not isinstance(key, str) or len(key) > 2048 or type(sequence) is not int or sequence < 0:
            raise WatcherStateError('Invalid watcher cursor')
    for key, row in pending.items():
        if not isinstance(key, str) or len(key) > 256 or not isinstance(row, dict):
            raise WatcherStateError('Invalid pending event')
        if row.get('category') not in ('done', 'attention', 'error') or any(not isinstance(row.get(name), str) or len(row[name]) > 180 for name in ('sessionId', 'eventId')):
            raise WatcherStateError('Invalid pending identity')
        if any(type(row.get(name)) is not int or row[name] < 0 for name in ('dueAt', 'occurredAt', 'expiresAt')):
            raise WatcherStateError('Invalid pending deadline')
    return value


class WatcherStateStore:
    def __init__(self, file, *, min_free_bytes=2 * 1024 ** 3):
        self.file = pathlib.Path(file).absolute()
        self.fd = None
        if type(min_free_bytes) is not int or min_free_bytes < 0:
            raise ValueError('Invalid watcher reserve')
        self.min_free_bytes = min_free_bytes

    def _parent(self):
        self.file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.file.parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or os.name != 'nt' and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise WatcherStateError('Unsafe watcher state directory')

    @staticmethod
    def _check(info):
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or os.name != 'nt' and (info.st_uid != os.getuid() or info.st_mode & 0o022):
            raise WatcherStateError('Unsafe watcher state inode')

    def __enter__(self):
        self._parent()
        target = str(self.file) + '.lock'
        try:
            existing = os.lstat(target)
            self._check(existing)
        except FileNotFoundError:
            pass
        self.fd = os.open(target, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0), 0o600)
        try:
            self._check(os.fstat(self.fd))
            if os.name == 'nt':
                import msvcrt
                if os.fstat(self.fd).st_size == 0:
                    os.write(self.fd, b'0')
                    os.fsync(self.fd)
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise
        return self

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def load(self):
        if self.fd is None:
            raise WatcherStateError('Watcher state lock required')
        try:
            before = self.file.lstat()
        except FileNotFoundError:
            return None
        self._check(before)
        if before.st_size > MAX_BYTES:
            raise WatcherStateError('Watcher state exceeds limit')
        fd = os.open(self.file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        try:
            info = os.fstat(fd)
            self._check(info)
            if (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino):
                raise WatcherStateError('Watcher state changed')
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                data = stream.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise WatcherStateError('Watcher state exceeds limit')
            return validate(json.loads(data))
        finally:
            os.close(fd)

    def save(self, value):
        if self.fd is None:
            raise WatcherStateError('Watcher state lock required')
        data = json.dumps(validate(value), ensure_ascii=True, separators=(',', ':')).encode()
        if len(data) > MAX_BYTES:
            raise WatcherStateError('Watcher state exceeds limit')
        self._parent()
        if shutil.disk_usage(self.file.parent).free < self.min_free_bytes + len(data):
            raise WatcherStateError('Watcher state capacity')
        try:
            self._check(self.file.lstat())
        except FileNotFoundError:
            pass
        temporary = self.file.with_name('.' + self.file.name + '.' + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            try:
                with os.fdopen(fd, 'wb', closefd=False) as stream:
                    stream.write(data)
                    stream.flush()
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(temporary, self.file)
            if os.name != 'nt':
                parent = os.open(self.file.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(parent)
                finally:
                    os.close(parent)
        finally:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()
