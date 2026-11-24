import asyncio
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
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
                owner = bridge.Broker(1000)
                owner.native = None, None, identity, None, None
                owner.check_identity = lambda _: None
                owner.send = AsyncMock(side_effect=TimeoutError())
                with self.assertRaises(TimeoutError):
                    await owner.run(command)
                self.assertFalse(owner.record['frozen'])
                recovered = bridge.Broker(1000)
                recovered.check_identity = lambda _: None
                with patch.object(bridge, 'all_stopped', return_value=True):
                    with self.assertRaises(ValueError):
                        await recovered.run({'op': 'status'})
                    with self.assertRaises(ValueError):
                        await recovered.run(dict(command, lease=str(uuid.uuid4())))
                with patch.object(bridge, 'init_ticks', return_value='new-container-init'):
                    self.assertIsNone(bridge.Broker(1000).record)
        with tempfile.TemporaryDirectory() as root:
            asyncio.run(scenario(Path(root)))

    def test_ack_and_all_threads_stopped_required_and_same_lease_is_idempotent(self):
        async def scenario(directory):
            identity = dict(bootId=bridge.BOOT, initTicks=bridge.init_ticks(), pid=100, startTicks='200', epoch=str(uuid.uuid4()))
            command = dict(op='freeze', epoch=identity['epoch'], revision=3, lease=str(uuid.uuid4()))
            with patch.object(bridge, 'CONTROL', directory), patch.object(bridge, 'LEASE', directory / 'lease'):
                owner = bridge.Broker(1000)
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
