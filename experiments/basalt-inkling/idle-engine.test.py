import http.client
import importlib.util
import json
import os
import socket
import socketserver
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


spec = importlib.util.spec_from_file_location("idle_engine", Path(__file__).with_name("idle-engine.py"))
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class EngineDrain(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.gate = engine.Admission(self.dir)
        self.lease = "test-operator-lease-0001"

    def state(self):
        return self.gate.control({"op": "status"})

    def change(self, op, state):
        return self.gate.control({"op": op, "epoch": state["epoch"], "revision": state["revision"], "lease": self.lease})

    def test_stream_and_queued_request_hold_the_fence(self):
        one, two, finish = (threading.Event() for _ in range(3))
        calls = []

        class Stock(BaseHTTPRequestHandler):
            def _json(self, code, value):
                body = json.dumps(value).encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                calls.append(self.path)
                self.rfile.read(int(self.headers["Content-Length"]))
                if self.path.startswith("/v1/messages"):
                    two.set()  # Simulate a request queued for the occupied slot, without response headers.
                    finish.wait(5)
                    self._json(200, {})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b"data: first\n\n")
                self.wfile.flush()
                one.set()
                finish.wait(5)
                self.wfile.write(b"data: [DONE]\n\n")

            def do_GET(self):
                self._json(200, {})

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), engine.gated_handler(Stock, self.gate)) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            address = server.server_address
            try:
                start = self.state()
                stream = http.client.HTTPConnection(*address, timeout=5)
                queued = http.client.HTTPConnection(*address, timeout=5)
                self.addCleanup(stream.close)
                self.addCleanup(queued.close)
                stream.request("POST", "/v1/chat/completions", b"{}")
                response = stream.getresponse()
                self.assertEqual(response.readline(), b"data: first\n")
                self.assertTrue(one.wait(2))
                queued.request("POST", "/v1/messages?beta=true", b"{}")
                self.assertTrue(two.wait(2))
                self.assertEqual(self.state()["active"], 2)
                self.assertFalse(self.change("drain", self.state())["ok"])
                finish.set()
                self.assertIn(b"[DONE]", response.read())
                self.assertEqual(queued.getresponse().read(), b"{}")
                # For the queued HTTP/1.0 request wait for the handler's teardown as well.
                queued.close()
                for _ in range(100):
                    if not self.state()["active"]:
                        break
                    threading.Event().wait(.01)
                self.assertFalse(self.change("drain", start)["ok"])  # Both completed between guard polls.
                idle = self.state()
                self.assertEqual((idle["active"], idle["revision"]), (0, 4))
                self.assertTrue(self.change("drain", idle)["drained"])
                for route in ["/v1/responses", "/v1/v1/messages", "/v1/chat/completions"]:
                    with self.subTest(route=route):
                        conn = http.client.HTTPConnection(*address, timeout=2)
                        try:
                            conn.request("POST", route, b"{}")
                            denied = conn.getresponse()
                            self.assertEqual(denied.status, 503)
                            self.assertNotIn(self.lease.encode(), denied.read())
                        finally:
                            conn.close()
                for route in ["/metrics?format=prometheus", "/v1/models", "/health"]:
                    conn = http.client.HTTPConnection(*address, timeout=2)
                    try:
                        conn.request("GET", route)
                        self.assertEqual(conn.getresponse().read(), b"{}")
                    finally:
                        conn.close()
                self.assertEqual(self.state()["revision"], idle["revision"])
                self.assertEqual(calls, ["/v1/chat/completions", "/v1/messages?beta=true"])
            finally:
                finish.set()
                server.shutdown()

    def test_restart_retains_lease_and_requires_current_epoch(self):
        prev = self.state()
        self.assertTrue(self.change("drain", prev)["ok"])
        self.gate = engine.Admission(self.dir)
        self.assertNotEqual(self.gate.epoch, prev["epoch"])
        self.assertFalse(self.gate.enter())
        self.assertFalse(self.change("reopen", prev)["ok"])
        self.assertFalse(self.gate.control({"op": "reopen", "epoch": self.gate.epoch,
                                           "lease": "another-operator-lease"})["ok"])
        self.assertTrue(self.change("reopen", self.state())["ok"])
        self.assertTrue(self.gate.enter())
        self.gate.leave()

    def test_control_uses_linux_peer_credentials(self):
        address = str(self.dir / "control.sock")
        with socketserver.UnixStreamServer(address, engine.ControlRequest) as server:
            server.gate = self.gate
            threading.Thread(target=server.handle_request, daemon=True).start()
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(2)
                client.connect(address)
                if os.geteuid() == 0:
                    client.sendall(b'{"op":"status"}\n')
                with client.makefile("rb") as stream:
                    reply = json.loads(stream.readline())
                if os.geteuid() == 0:
                    self.assertEqual(reply, self.state())
                else:
                    self.assertEqual(reply, {"ok": False, "code": "FORBIDDEN"})


if __name__ == "__main__":
    unittest.main()
