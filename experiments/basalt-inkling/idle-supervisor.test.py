import copy
import importlib.util
import json
import stat
import tempfile
import unittest
import uuid
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("supervisor", Path(__file__).with_name("idle-supervisor-host.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class SupervisorAttestation(unittest.TestCase):
    account = SimpleNamespace(pw_uid=1011, pw_gid=1012)

    def test_service_proof_is_bound_to_role_owner_and_both_start_tick_reads(self):
        for service in ('native', 'engine'):
            with self.subTest(service=service), ExitStack() as stack:
                proc = SimpleNamespace(st_mode=stat.S_IFDIR | 0o555, st_uid=self.account.pw_uid)
                stack.enter_context(patch.object(mod.os, 'stat', return_value=proc))
                denied = stack.enter_context(patch.object(mod.os, 'readlink', side_effect=PermissionError))
                ticks = stack.enter_context(patch.object(mod, 'procstat', return_value=('S', '290')))
                attest = stack.enter_context(patch.object(mod._bridge, 'attest_listener', return_value=True))
                mod.verify_listener(service, 99, '290', self.account)
                attest.assert_called_once_with(service, 99, '290', 1011, 1012)
                denied.assert_not_called()
                attest.return_value = False
                with self.assertRaises(ValueError):
                    mod.verify_listener(service, 99, '290', self.account)
                attest.return_value = True
                ticks.side_effect = [('S', '290'), ('S', '291')]
                with self.assertRaises(ValueError):
                    mod.verify_listener(service, 99, '290', self.account)

    def test_model_readback_rechecks_both_processes_and_fails_if_the_last_listener_changed(self):
        native = {'pid': 48, 'startTicks': '220', 'frozen': False, 'lease': None}
        engine = {'pid': 49, 'startTicks': '240', 'drained': False, 'lease': None}
        with ExitStack() as stack:
            stack.enter_context(patch.object(mod, 'enabled', return_value=True))
            stack.enter_context(patch.object(mod, 'incarnation', return_value='fixed'))
            stack.enter_context(patch.object(mod, 'control', side_effect=[native, engine]))
            stack.enter_context(patch.object(mod.pwd, 'getpwnam', return_value=self.account))
            conn = stack.enter_context(patch.object(mod.http.client, 'HTTPConnection')).return_value
            response = conn.getresponse.return_value
            response.status = 200
            response.read.return_value = b'{"data":[{"id":"inkling-2-mini","status":{"value":"loaded"}}]}'
            attest = stack.enter_context(patch.object(mod, 'verify_listener', side_effect=[None, ValueError('changed')]))
            with self.assertRaises(ValueError):
                mod.snapshot()
            self.assertEqual([c.args for c in attest.call_args_list],
                             [('native', 48, '220', self.account), ('engine', 49, '240', self.account)])


class StopProtocol(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        self.boot = str(uuid.uuid4()) + '_140'
        self.enabled = True
        self.steps = []
        self.vast = ('running', 'running')
        self.outcome = 'acknowledged'
        self.engine = dict(pid=42, startTicks='111', epoch=str(uuid.uuid4()), revision=7, active=0, drained=False, lease=None)
        self.native = dict(pid=43, startTicks='112', epoch=str(uuid.uuid4()), revision=9, busy=False, frozen=False, lease=None)
        self.abort_drain = False
        def provider(method, key):
            self.steps.append(method)
            if method == 'GET':
                return self.vast
            self.assertEqual(method, 'PUT')
            durable = json.loads(mod.JOURNAL.read_bytes())
            self.assertEqual(durable['phase'], 'uncertain')
            self.assertTrue(durable['submitted'])
            self.assertTrue(self.native['frozen'] and self.engine['drained'])
            if self.outcome == 'timeout':
                raise TimeoutError()
            return self.outcome
        def control(which, req):
            unit, flag = (self.engine, 'drained') if which == 'engine' else (self.native, 'frozen')
            op = req['op']
            if op in ('freeze','drain'):
                if self.abort_drain and op == 'drain':
                    raise ValueError('new engine work')
                self.assertEqual(req['revision'],unit['revision'])
                self.assertEqual(req['epoch'],unit['epoch'])
                unit[flag], unit['lease'] = True, req['lease']
                self.steps.append(op)
            elif op in ('thaw','reopen'):
                self.assertEqual(req['lease'],unit['lease'])
                if op == 'thaw':
                    self.assertFalse(self.engine['drained'])
                unit[flag], unit['lease'] = False, None
                self.steps.append(op)
            return copy.deepcopy(unit)
        def snapshot(lease=None):
            self.assertEqual(self.native['lease'],lease)
            self.assertEqual(self.engine['lease'],lease)
            return copy.deepcopy(dict(host=self.boot,native=self.native,engine=self.engine))
        self.snapshot = snapshot
        for name, value in dict(STATE=root,JOURNAL=root/'attempt.json', directory=lambda *args: None,
                                protected=lambda p,*args: p.read_bytes(), enabled=lambda: self.enabled,
                                provider_key=lambda: b'fixture', provider=provider, control=control,
                                snapshot=snapshot, incarnation=lambda: self.boot).items():
            stack.enter_context(patch.object(mod, name, value))

    def fence(self):
        return mod.dispatch({'op':'fence', 'identity':mod.proof(self.snapshot())})

    def test_partial_fence_rolls_back_on_restart_without_provider_access(self):
        self.abort_drain = True
        with self.assertRaises(ValueError):
            self.fence()
        self.assertEqual(mod.record()['phase'], 'preparing')
        self.assertEqual(mod.dispatch({'op':'reconcile'}),'idle')
        self.assertEqual(self.steps,['freeze','thaw'])
        self.assertIsNone(mod.record())

    def test_lost_ack_does_not_send_again_and_operator_readback_releases_both(self):
        self.fence()
        self.outcome = 'timeout'
        with self.assertRaises(TimeoutError):
            mod.dispatch({'op':'commit'})
        self.assertEqual(mod.dispatch({'op':'reconcile'}),'pending')
        self.enabled = False
        before = self.steps.copy()
        self.assertEqual(mod.dispatch({'op':'reconcile'}),'pending-policy-disabled')
        self.assertEqual(self.steps,before)
        self.enabled = True
        self.assertEqual(mod.dispatch({'op':'reconcile','manual':True}),'retired')
        self.assertEqual(self.steps[-3:], ['GET','reopen','thaw'])
        self.assertEqual(mod.dispatch({'op':'reconcile'}),'retired')
        self.assertEqual(self.steps.count('PUT'),1)
        self.assertTrue(mod.record()['submitted'])

    def test_definite_refusal_requires_running_readback_and_suppresses_further_stops(self):
        self.fence()
        self.outcome = 'refused'
        mod.dispatch({'op':'commit'})
        self.assertEqual(mod.dispatch({'op':'reconcile'}),'retired')
        self.assertEqual(self.steps, ['freeze','drain','GET','PUT','GET','reopen','thaw'])
        with self.assertRaises(ValueError):
            mod.dispatch({'op':'commit'})

    def test_new_container_incarnation_recovers_old_lease_and_archives_attempt(self):
        self.fence()
        mod.dispatch({'op':'commit'})
        self.vast = ('running','stopped')
        self.assertEqual(mod.dispatch({'op':'reconcile'}),'stopping')
        old = self.boot
        self.boot = old.split('_')[0] + '_560'
        self.vast = ('running','running')
        self.assertEqual(mod.dispatch({'op':'reconcile'}),'idle')
        self.assertIsNone(mod.record())
        self.assertTrue((mod.STATE / ('attempt-' + old + '.json')).is_file())
        self.assertEqual(self.steps.count('PUT'),1)


if __name__ == '__main__':
    unittest.main()
