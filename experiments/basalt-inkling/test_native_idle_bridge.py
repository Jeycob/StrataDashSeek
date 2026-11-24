import asyncio
import importlib.util
import json
import os
from pathlib import Path
import pwd
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch
import uuid

spec = importlib.util.spec_from_file_location('idle_bridge', Path(__file__).with_name('native-idle-bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class NativeLeaseTest(unittest.TestCase):
    @unittest.skipUnless(os.geteuid() == 0, 'requires Linux UID switching')
    def test_cross_uid_proc_links_are_attested_only_as_the_listener_owner(self):
        owner, other = pwd.getpwnam('nobody'), pwd.getpwnam('daemon')
        self.assertNotEqual(owner.pw_uid, other.pw_uid)
        with tempfile.TemporaryDirectory() as root, socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            port = listener.getsockname()[1]
            proc = subprocess.Popen(['/usr/bin/python3', '-I', '-S', '-c',
                                     'import sys; print("ready", flush=True); sys.stdin.buffer.read(1)'],
                                    user=owner.pw_uid, group=owner.pw_gid, extra_groups=(), env={},
                                    pass_fds=(listener.fileno(),), stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            try:
                self.assertTrue(select.select([proc.stdout], [], [], 3)[0])
                self.assertEqual(proc.stdout.readline(), b'ready\n')
                ticks = bridge.process_stat(Path(f'/proc/{proc.pid}/stat'))[1]
                # Exercise the real kernel denial irrespective of the test runner's root capabilities.
                denied = """
import errno, os, sys
for operation, path in [(os.readlink, sys.argv[1]), (os.stat, sys.argv[2])]:
    try:
        operation(path)
    except PermissionError as error:
        if error.errno == errno.EACCES:
            continue
    sys.exit(1)
"""
                result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-c', denied,
                                         f'/proc/{proc.pid}/exe', f'/proc/{proc.pid}/fd/{listener.fileno()}'],
                                        user=other.pw_uid, group=other.pw_gid, extra_groups=(), env={}, timeout=3)
                self.assertEqual(result.returncode, 0)
                # The trusted test entry replaces only the installed binary/port with this fixture.
                directory = Path(root)
                directory.chmod(0o755)
                library = directory / 'bridge.py'
                shutil.copyfile(bridge.__file__, library)
                library.chmod(0o644)
                entry = directory / 'fixture.py'
                entry.write_text(f"import runpy, sys\nbridge = runpy.run_path({str(library)!r})\n"
                                 f"bridge['LISTENERS']['native'] = ('/usr/bin/python3', {port})\n"
                                 "sys.exit(bridge['main']())\n")
                entry.chmod(0o644)
                with patch.object(bridge, '__file__', str(entry)):
                    self.assertTrue(bridge.attest_listener('native', proc.pid, ticks, owner.pw_uid, owner.pw_gid))
                    self.assertFalse(bridge.attest_listener('native', proc.pid, ticks, other.pw_uid, other.pw_gid))
                    self.assertFalse(bridge.attest_listener('native', proc.pid, '0', owner.pw_uid, owner.pw_gid))
            finally:
                proc.stdin.close()
                try:
                    proc.wait(3)
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait(3)
                    proc.stdout.close()

    def test_native_proof_precedes_real_process_stop_and_pidfd_thaw(self):
        module = Path(__file__).with_name('idle-native-control.mjs').resolve().as_uri()
        fixture = """
import { writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const { createNativeControl } = await import(process.argv[1]);
const epoch = randomUUID(), lease = randomUUID();
let open = true;
const activity = { epoch, revision: () => 0, flush: async () => {},
  read: async () => ({epoch, revision: 0, busy: false}) };
const gate = { revision: () => 0, healthy: () => true, busy: () => false,
  open: () => open, close() { open = false; return true; }, reopen() { open = true; } };
const control = createNativeControl(activity, gate, () => process.kill(process.pid, 'SIGSTOP'));
const write = value => writeSync(1, JSON.stringify(value) + '\\n');
await control.request({ op: 'freeze', rid: randomUUID(), lease, epoch, revision: 0 }, write);
await control.request({ op: 'thaw', rid: randomUUID(), lease }, write);
if (!open) process.exitCode = 1;
"""
        child = subprocess.Popen(['node', '--input-type=module', '-e', fixture, module],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
        fd = os.pidfd_open(child.pid)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 5)[0])
            proof = json.loads(child.stdout.readline())
            self.assertTrue(proof['ok'])
            deadline = time.monotonic() + 2
            while not bridge.all_stopped(child.pid) and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(bridge.all_stopped(child.pid))
            signal.pidfd_send_signal(fd, signal.SIGCONT)
            self.assertEqual(child.wait(3), 0)
            self.assertEqual(json.loads(child.stdout.readline())['lease'], proof['lease'])
        finally:
            if child.poll() is None:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                child.wait(3)
            os.close(fd)
            child.stdout.close()

    def test_lost_freeze_reply_never_becomes_a_proof_after_restart(self):
        async def scenario(directory):
            epoch, lease = str(uuid.uuid4()), str(uuid.uuid4())
            identity = dict(bootId=bridge.BOOT, initTicks=bridge.init_ticks(), pid=100, startTicks='200', epoch=epoch)
            command = dict(op='freeze', epoch=epoch, revision=3, lease=lease)
            with patch.object(bridge, 'CONTROL', directory), patch.object(bridge, 'LEASE', directory / 'lease'):
                owner = bridge.Broker(1000, 1000)
                owner.native = None, None, identity, None, None
                owner.check_identity = lambda _: None
                owner.send = AsyncMock(side_effect=TimeoutError())
                with self.assertRaises(TimeoutError):
                    await owner.run(command)
                self.assertFalse(owner.record['frozen'])
                recovered = bridge.Broker(1000, 1000)
                recovered.check_identity = lambda _: None
                with patch.object(bridge, 'all_stopped', return_value=True):
                    with self.assertRaises(ValueError):
                        await recovered.run({'op': 'status'})
                    with self.assertRaises(ValueError):
                        await recovered.run(dict(command, lease=str(uuid.uuid4())))
                with patch.object(bridge, 'init_ticks', return_value='new-container-init'):
                    self.assertIsNone(bridge.Broker(1000, 1000).record)
        with tempfile.TemporaryDirectory() as root:
            asyncio.run(scenario(Path(root)))

    def test_ack_and_all_threads_stopped_required_and_same_lease_is_idempotent(self):
        async def scenario(directory):
            identity = dict(bootId=bridge.BOOT, initTicks=bridge.init_ticks(), pid=100, startTicks='200', epoch=str(uuid.uuid4()))
            command = dict(op='freeze', epoch=identity['epoch'], revision=3, lease=str(uuid.uuid4()))
            with patch.object(bridge, 'CONTROL', directory), patch.object(bridge, 'LEASE', directory / 'lease'):
                owner = bridge.Broker(1000, 1000)
                owner.native = None, None, identity, None, None
                owner.check_identity = lambda _: None
                owner.send = AsyncMock(return_value=dict(identity, revision=3, busy=False))
                with patch.object(bridge, 'all_stopped', return_value=True):
                    self.assertTrue((await owner.run(command))['frozen'])
                    self.assertEqual(await owner.run(command), await owner.run({'op': 'status'}))
                    self.assertEqual(owner.send.await_count, 1)
                with patch.object(bridge, 'all_stopped', return_value=False):
                    with self.assertRaises(ValueError):
                        await owner.run({'op': 'status'})
        with tempfile.TemporaryDirectory() as root:
            asyncio.run(scenario(Path(root)))


if __name__ == '__main__':
    unittest.main()
