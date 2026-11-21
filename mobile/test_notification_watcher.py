import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from notification_watcher_state import WatcherStateCapacityError, WatcherStateStore, WatcherStateError

try:
    import compression.zstd as zstd
except ImportError:
    import zstandard as zstd

spec = importlib.util.spec_from_file_location('notification_watcher', pathlib.Path(__file__).with_name('watch-harness-notifications.py'))
watcher_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watcher_module)


class WatcherPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='notification-watcher-'))
        self.sessions = self.root/'sessions'
        self.archive = self.sessions/'workspace'/'session-fixture'/'session.v4.jsonl.zstd'
        self.archive.parent.mkdir(parents=True)
        self.file = self.root/'private'/'watcher.json'
        self.now = 1700000000000
        self.rows = [{'type': 'session', 'seq': 0, 'delegationDepth': 0}]
        self.write()

    def tearDown(self):
        resolved = self.root.resolve()
        self.assertEqual(resolved.parent, pathlib.Path(tempfile.gettempdir()).resolve())
        self.assertTrue(resolved.name.startswith('notification-watcher-'))
        self.assertFalse(self.root.is_symlink())
        shutil.rmtree(resolved)

    def write(self):
        with zstd.open(self.archive, 'wt', encoding='utf-8') as output:
            for row in self.rows:
                output.write(json.dumps(row)+'\n')

    def store(self):
        return WatcherStateStore(self.file, min_free_bytes=0)

    def watcher(self, store, send):
        return watcher_module.NotificationWatcher(self.sessions, store, send, clock=lambda: self.now/1000)

    def event(self, sequence, kind='turn/end', data=None):
        self.rows.append({'type': kind, 'seq': sequence, 'time': self.now, 'data': data or {'reason': {'kind': 'completed'}, 'turn': 'turn-fixture'}})
        self.write()

    def test_compressed_downtime_completion_is_read_after_restart_without_replaying_initial_history(self):
        self.rows.append({'type': 'turn/end', 'seq': 1, 'time': self.now-1000, 'data': {'reason': 'completed'}})
        self.write()
        sent = []
        def send(route, body):
            if route == 'event': sent.append(body)
            return {'persisted': True}
        with self.store() as store:
            self.watcher(store, send).tick()
        self.assertEqual(sent, [])
        self.now += 1000
        self.event(2)
        with self.store() as store:
            self.watcher(store, send).tick()
        self.assertEqual([row['id'] for row in sent], ['session-fixture:2'])
        self.assertEqual(set(sent[0]), {'id', 'category', 'occurredAt'})
        with self.store() as store:
            self.watcher(store, send).tick()
        self.assertEqual(len(sent), 1)

    def test_cursor_and_pending_intent_are_durable_before_the_first_enqueue_request(self):
        with self.store() as store:
            watcher = self.watcher(store, lambda *_: {'persisted': True})
            self.event(1)
            def inspect(route, body):
                if route == 'event':
                    state = json.loads(self.file.read_text())
                    self.assertEqual(list(state['cursors'].values()), [1])
                    self.assertEqual(len(state['pending']), 1)
                    raise OSError('Fixture unavailable')
                return {}
            watcher.send = inspect
            watcher.tick()
            self.assertEqual(len(store.load()['pending']), 1)

    def test_capacity_pause_preserves_previous_state_and_retries_the_durable_intent_first(self):
        sent = []

        def send(route, body):
            if route == 'event':
                state = json.loads(self.file.read_text())
                self.assertEqual(list(state['cursors'].values()), [1])
                self.assertEqual(len(state['pending']), 1)
                sent.append(body['id'])
            return {'persisted': True}

        with self.store() as store:
            watcher = self.watcher(store, send)
            watcher.tick()
            previous = self.file.read_bytes()
            self.event(1)
            with mock.patch('notification_watcher_state.shutil.disk_usage', return_value=mock.Mock(free=0)):
                for _ in range(2):
                    with self.assertRaises(WatcherStateCapacityError):
                        watcher.tick()
                    self.assertEqual(self.file.read_bytes(), previous)
                    self.assertEqual(sent, [])
            watcher.tick()
            self.assertEqual(sent, ['session-fixture:1'])
            self.assertEqual(store.load()['pending'], {})

    def test_main_backs_off_on_low_capacity_then_returns_to_its_ordinary_poll(self):
        capacity = iter([0, 0])
        with mock.patch.object(watcher_module, 'WatcherStateStore', return_value=self.store()), \
                mock.patch.object(watcher_module, 'post', return_value={'persisted': True}), \
                mock.patch.object(watcher_module.time, 'sleep', side_effect=[None, None, KeyboardInterrupt]) as sleep, \
                mock.patch('notification_watcher_state.shutil.disk_usage', side_effect=lambda _: mock.Mock(free=next(capacity, 1024**4))):
            with self.assertRaises(KeyboardInterrupt):
                watcher_module.main(['--session-root', str(self.sessions), '--state-file', str(self.file)])
        self.assertEqual(sleep.call_args_list, [mock.call(4), mock.call(8), mock.call(2)])
        self.assertTrue(self.file.is_file())

    def test_lost_ack_reuses_the_same_event_id_after_restart_and_legacy_non_durable_receipts_are_not_accepted(self):
        accepted, attempts = set(), []
        def lost_ack(route, body):
            if route == 'event':
                accepted.add(body['id']); attempts.append(body['id'])
                raise OSError('Fixture receipt lost after durable enqueue')
            return {}
        with self.store() as store:
            watcher = self.watcher(store, lost_ack)
            self.event(1)
            watcher.tick()
        self.now += 10001
        def success(route, body):
            if route == 'event':
                attempts.append(body['id']); accepted.add(body['id'])
            return {'persisted': True}
        with self.store() as store:
            self.watcher(store, success).tick()
            self.assertEqual(store.load()['pending'], {})
        self.assertEqual(len(accepted), 1)
        self.assertEqual(attempts, ['session-fixture:1', 'session-fixture:1'])
        with self.store() as store:
            watcher = self.watcher(store, lambda *_: {'queued': True})
            self.event(2)
            watcher.tick()
            self.assertEqual(len(store.load()['pending']), 1)

    def test_pending_attention_survives_restart_but_a_resolution_prevents_sending(self):
        sent = []
        def send(route, body):
            if route == 'event': sent.append(body)
            return {'persisted': True}
        with self.store() as store:
            watcher = self.watcher(store, send)
            self.event(1, 'approval/asked', {'id': 'approval-fixture'})
            watcher.tick()
            self.assertEqual(len(store.load()['pending']), 1)
        self.now += 4000
        self.event(2, 'approval/decided', {'id': 'approval-fixture'})
        with self.store() as store:
            self.watcher(store, send).tick()
            self.assertEqual(store.load()['pending'], {})
        self.assertEqual(sent, [])

    def test_corrupt_or_linked_state_is_preserved_and_never_treated_as_a_new_baseline(self):
        with self.store() as store:
            self.file.write_text('{broken', encoding='utf-8')
            with self.assertRaises(ValueError): store.load()
            self.assertEqual(self.file.read_text(), '{broken')
            self.file.unlink()
            victim = self.root/'victim'
            victim.write_text('fixture-retained')
            os.link(victim, self.file)
            with self.assertRaises(WatcherStateError): store.load()
            self.assertEqual(victim.read_text(), 'fixture-retained')

    def test_failed_fsync_leaves_previous_state_and_no_temporary_payload(self):
        value = {'version': 1, 'initializedAt': self.now, 'cursors': {}, 'pending': {}}
        with self.store() as store:
            store.save(value)
            with mock.patch('notification_watcher_state.os.fsync', side_effect=OSError('Fixture disk failure')):
                with self.assertRaises(OSError): store.save({**value, 'cursors': {'fixture': 1}})
            self.assertEqual(store.load(), value)
            self.assertEqual(list(self.file.parent.glob('.watcher.json.*')), [])

    def test_live_os_lock_is_not_displaced_by_another_python_process(self):
        module_dir = str(pathlib.Path(__file__).parent)
        source = 'import sys;sys.path.insert(0,sys.argv[1]);from notification_watcher_state import WatcherStateStore;\ntry:\n with WatcherStateStore(sys.argv[2],min_free_bytes=0):sys.exit(7)\nexcept (OSError,RuntimeError):sys.exit(0)'
        with self.store():
            result = subprocess.run([sys.executable, '-c', source, module_dir, str(self.file)], timeout=5, capture_output=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
            self.assertEqual(result.returncode, 0)
        with self.store() as store:
            self.assertIsNone(store.load())


if __name__ == '__main__':
    unittest.main()
