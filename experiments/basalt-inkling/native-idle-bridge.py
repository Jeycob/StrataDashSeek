#!/usr/bin/env python3
"""Root local adapter for the supervised Native process on the Basalt lab."""
import asyncio
import fcntl
import json
import os
from pathlib import Path
import pwd
import signal
import socket
import stat
import struct
import uuid

CONTROL = Path('/run/basalt-lab-control')
BRIDGE = Path('/run/basalt-idle-bridge')
LEASE = CONTROL / 'native-idle-lease.json'
BOOT = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
LIMIT = 1024
NODE = '/opt/basalt-node-v24.22.3/bin/node'
CLI = '/workspace/homeai-basalt/state/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'


class Declined(Exception):
    """The Native peer confirmed that admission is open."""


def require(check):
    if not check:
        raise ValueError('invalid state')


def encode(value):
    return json.dumps(value, separators=(',', ':')).encode() + b'\n'


def uuid4(value):
    return isinstance(value, str) and str(uuid.UUID(value, version=4)) == value


def process_stat(path):
    fields = path.read_text().rsplit(') ', 1)[1].split()
    return fields[0], fields[19]


def init_ticks():
    return process_stat(Path('/proc/1/stat'))[1]


def listener(pid):
    inodes = set()
    proc = Path('/proc') / str(pid)
    for line in (proc / 'net/tcp').read_text().splitlines()[1:]:
        row = line.split()
        if row[1] == '0100007F:2253' and row[3] == '0A':
            inodes.add('socket:[' + row[9] + ']')
    for entry in (proc / 'fd').iterdir():
        try:
            if os.readlink(entry) in inodes:
                return True
        except FileNotFoundError:
            continue
    return False


def all_stopped(pid):
    states = [process_stat(entry / 'stat')[0] for entry in (Path('/proc') / str(pid) / 'task').iterdir()]
    return bool(states) and all(state == 'T' for state in states)


def save(record):
    tmp = LEASE.with_suffix('.new')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(encode(record))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, LEASE)
    directory = os.open(CONTROL, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def peer(writer):
    return struct.unpack('3i', writer.get_extra_info('socket').getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))


async def read(reader, timeout=5):
    row = await asyncio.wait_for(reader.readline(), timeout)
    require(0 < len(row) <= LIMIT and row.endswith(b'\n'))
    value = json.loads(row)
    require(isinstance(value, dict))
    return value


class Broker:
    def __init__(self, uid):
        self.uid = uid
        self.lock = asyncio.Lock()
        self.native = None
        try:
            self.record = json.loads(LEASE.read_bytes())
        except FileNotFoundError:
            self.record = None
        if self.record and (self.record['bootId'] != BOOT or self.record.get('initTicks') != init_ticks()):
            self.record = None
            save(None)

    def check_identity(self, record):
        pid = record['pid']
        require(record['bootId'] == BOOT and record.get('initTicks') == init_ticks() and os.stat(f'/proc/{pid}').st_uid == self.uid)
        require(process_stat(Path(f'/proc/{pid}/stat'))[1] == record['startTicks'] and listener(pid))
        require(os.readlink(f'/proc/{pid}/exe') == os.path.realpath(NODE))
        argv = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        require(any(argv[i:i + 2] == [os.fsencode(CLI), b'web'] for i in range(len(argv) - 1)))

    def connect(self, reader, writer, hello):
        pid, uid, _ = peer(writer)
        require(uid == self.uid and hello.get('op') == 'hello' and uuid4(hello.get('epoch')))
        # Bind the peer to the actual lab listener and its Linux process incarnation.
        fd = os.pidfd_open(pid)
        try:
            identity = dict(bootId=BOOT, initTicks=init_ticks(), pid=pid,
                            startTicks=process_stat(Path(f'/proc/{pid}/stat'))[1], epoch=hello['epoch'])
            self.check_identity(identity)
            if self.record and (self.record['pid'], self.record['startTicks']) != (pid, identity['startTicks']):
                try:
                    old = process_stat(Path(f'/proc/{self.record["pid"]}/stat'))[1]
                except (FileNotFoundError, ProcessLookupError):
                    old = None
                require(old != self.record['startTicks'])
                save(None)
                self.record = None
            self.disconnect()
            done = asyncio.Event()
            self.native = reader, writer, identity, fd, done
            return done
        except BaseException:
            os.close(fd)
            raise

    def disconnect(self):
        if self.native:
            _, writer, _, fd, done = self.native
            self.native = None
            writer.close()
            os.close(fd)
            done.set()

    async def send(self, command):
        require(self.native)
        reader, writer, identity, _, _ = self.native
        self.check_identity(identity)
        rid = str(uuid.uuid4())
        writer.write(encode(dict(command, rid=rid)))
        try:
            await asyncio.wait_for(writer.drain(), 2)
            reply = await read(reader, 10)
            require(reply.get('rid') == rid and reply.get('epoch') == identity['epoch'])
        except BaseException:
            self.disconnect()
            raise
        if reply.get('ok') is False and reply.get('open') is True:
            raise Declined()
        require(reply.get('ok') is True and type(reply.get('busy')) is bool and
                type(reply.get('revision')) is int and reply['revision'] >= 0)
        if command['op'] in ('freeze', 'thaw'):
            require(reply.get('lease') == command['lease'])
        return dict(identity, revision=reply['revision'], busy=reply['busy'])

    async def run(self, req):
        op = req.get('op')
        if op == 'status' and set(req) == {'op'}:
            if self.record:
                self.check_identity(self.record)
                require(self.record['frozen'] and all_stopped(self.record['pid']))
                return self.record
            return dict(await self.send({'op': 'status'}), frozen=False, lease=None)
        if op == 'freeze' and set(req) == {'op', 'epoch', 'revision', 'lease'}:
            require(uuid4(req['lease']) and uuid4(req['epoch']) and type(req['revision']) is int and req['revision'] >= 0)
            if self.record:
                require(all(self.record[key] == req[key] for key in ('lease', 'epoch', 'revision')))
                return await self.run({'op': 'status'})
            require(self.native and self.native[2]['epoch'] == req['epoch'])
            identity = self.native[2]
            self.check_identity(identity)
            self.record = dict(identity, revision=req['revision'], lease=req['lease'], busy=False, frozen=False)
            save(self.record)  # intent precedes any possible SIGSTOP
            try:
                result = await self.send(req)
                require(not result['busy'] and result['revision'] == req['revision'])
                for _ in range(60):
                    self.check_identity(identity)
                    if all_stopped(identity['pid']):
                        self.record = dict(self.record, frozen=True)
                        save(self.record)
                        return self.record
                    await asyncio.sleep(.05)
                raise ValueError('freeze unconfirmed')
            except Declined:
                save(None)
                self.record = None
                raise
        if op == 'thaw' and set(req) == {'op', 'lease'}:
            require(uuid4(req['lease']))
            if not self.record:
                return await self.run({'op': 'status'})
            require(self.record['lease'] == req['lease'])
            identity = self.record
            fd = os.pidfd_open(identity['pid'])
            try:
                self.check_identity(identity)
                signal.pidfd_send_signal(fd, signal.SIGCONT)
            finally:
                os.close(fd)
            if not self.native:
                # Reconnecting after this broker restarted requires relinquishing the lock.
                # Retrying the same THAW is safe; the durable lease remains closed meanwhile.
                raise ValueError('await Native reconnect')
            require(self.native[2]['epoch'] == identity['epoch'])
            result = await self.send({'op': 'thaw', 'lease': req['lease']})
            self.record = None
            save(None)
            return dict(result, frozen=False, lease=None)
        raise ValueError('unknown operation')


def directory(path, mode):
    path.mkdir(mode=mode, exist_ok=True)
    item = path.lstat()
    require(stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and not item.st_mode & 0o022)
    os.chmod(path, mode)


async def serve():
    require(os.geteuid() == 0)
    os.umask(0o077)
    directory(CONTROL, 0o700)
    directory(BRIDGE, 0o711)
    user = pwd.getpwnam('basaltlab')
    lock = (CONTROL / 'native-idle-bridge.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    broker = Broker(user.pw_uid)

    async def native(reader, writer):
        try:
            hello = await read(reader)
            async with broker.lock:
                done = broker.connect(reader, writer, hello)
            await done.wait()
        except Exception:
            pass
        finally:
            writer.close()

    async def control(reader, writer):
        try:
            require(peer(writer)[1] == 0)
            command = await read(reader)
            async with broker.lock:
                result = await broker.run(command)
            writer.write(encode(dict(ok=True, **result)))
        except Exception:
            writer.write(encode(dict(ok=False, reason='unconfirmed')))
        finally:
            try:
                await writer.drain()
            finally:
                writer.close()

    def clear_socket(path):
        if path.exists():
            item = path.lstat()
            require(stat.S_ISSOCK(item.st_mode) and item.st_uid == 0)
            path.unlink()

    back, front = BRIDGE / 'native.sock', CONTROL / 'native-idle.sock'
    for path in (back, front):
        clear_socket(path)
    native_server = await asyncio.start_unix_server(native, path=back, limit=LIMIT)
    os.chown(back, 0, user.pw_gid)
    os.chmod(back, 0o660)
    root_server = await asyncio.start_unix_server(control, path=front, limit=LIMIT)
    os.chmod(front, 0o600)
    async with native_server, root_server:
        await asyncio.gather(native_server.serve_forever(), root_server.serve_forever())


if __name__ == '__main__':
    asyncio.run(serve())
