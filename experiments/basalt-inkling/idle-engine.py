"""Root-controlled admission at the single HTTP handler in the pinned Basalt engine."""
import fcntl
import hashlib
import json
import os
import re
import socket
import socketserver
import stat
import struct
import sys
import threading
import uuid
from pathlib import Path


RUN = Path("/run/basalt-pairing")
PINS = {
    "handler": "5c0ff08e0b05f6d301a294c73feaa8a4474796167c2891ce86cf9d7f7c232bd4",
    "server": "1c4f02e4a2e87c0d47b56f209a3f333575d930b5d6d876b8708eaed844aa7598",
}


def valid_lease(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{16,128}", value) is not None


class Admission:
    def __init__(self, directory):
        self.file = directory / "idle-engine.lease"
        self.lock = threading.Lock()
        self.epoch = str(uuid.uuid4())
        self.revision = self.active = 0
        self.lease = None
        try:
            fd = os.open(self.file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return
        with os.fdopen(fd, "rb") as stream:
            st = os.fstat(fd)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or
                    st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600):
                raise RuntimeError("Invalid engine drain record")
            self.lease = stream.read(129).decode("ascii")
        if not valid_lease(self.lease):
            raise RuntimeError("Incomplete engine drain record")

    def enter(self):
        with self.lock:
            if self.lease is not None:
                return False
            self.active += 1
            self.revision += 1
            return True

    def leave(self):
        with self.lock:
            self.active -= 1
            self.revision += 1

    def control(self, req):
        with self.lock:
            op = req.get("op")
            if op == "status":
                pass
            elif req.get("epoch") != self.epoch or not valid_lease(req.get("lease")):
                return {"ok": False, "code": "STALE_OR_INVALID"}
            elif op == "drain":
                if (self.active or type(req.get("revision")) is not int or req["revision"] != self.revision
                        or self.lease not in (None, req["lease"])):
                    return {"ok": False, "code": "BUSY_OR_CHANGED"}
                if self.lease is None:
                    # Any partial record prevents reopening after a crash.
                    with os.fdopen(os.open(self.file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
                        stream.write(req["lease"].encode("ascii"))
                        stream.flush()
                        os.fsync(stream.fileno())
                    self.lease = req["lease"]
            elif op == "reopen" and self.lease == req["lease"]:
                self.file.unlink()
                self.lease = None
            else:
                return {"ok": False, "code": "NOT_HELD"}
            return {"ok": True, "epoch": self.epoch, "revision": self.revision,
                    "active": self.active, "drained": self.lease is not None, "lease": self.lease}


def gated_handler(base, gate):
    class Handler(base):
        def do_POST(self):
            if not gate.enter():
                self.close_connection = True
                self._json(503, {"error": {"type": "server_busy", "code": "BASALT_ENGINE_DRAINED",
                                           "message": "Engine admission is closed."}})
                return
            try:
                # Stock code owns body parsing, queue admission, streaming, disconnect and slot cleanup.
                return super().do_POST()
            finally:
                gate.leave()
    return Handler


class ControlRequest(socketserver.StreamRequestHandler):
    timeout = 1

    def handle(self):
        peer = self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("iII"))
        if struct.unpack("iII", peer)[1] != 0:
            reply = {"ok": False, "code": "FORBIDDEN"}
        else:
            try:
                line = self.rfile.readline(1025)
                if len(line) > 1024 or not line.endswith(b"\n"):
                    raise ValueError()
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError()
                gate = self.server.gate
                reply = gate.control(request) if gate is not None else {"ok": False, "code": "NOT_READY"}
            except (ValueError, OSError, RecursionError):
                reply = {"ok": False, "code": "CONTROL_FAILED"}
        self.wfile.write(json.dumps(reply, separators=(",", ":")).encode("ascii") + b"\n")


def serve_gated(runtime, directory):
    # engine.sh already verified the complete release manifest. Refuse a new routing implementation
    # until its request lifecycle has also been reviewed against this adapter.
    for name, digest in PINS.items():
        if hashlib.sha256((runtime / "serve" / (name + ".py")).read_bytes()).hexdigest() != digest:
            raise RuntimeError("Unexpected Basalt HTTP implementation")
    sys.path.insert(0, str(runtime))
    from serve import handler, server
    if (Path(handler.__file__).resolve() != runtime / "serve/handler.py" or
            Path(server.__file__).resolve() != runtime / "serve/server.py"):
        raise RuntimeError("Unexpected Basalt import path")
    st = directory.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise RuntimeError("Private Basalt runtime directory required")
    control_path = directory / "idle-engine.sock"
    # Serialize startup and stale socket recovery, including a restart after SIGKILL.
    with os.fdopen(os.open(directory / "idle-engine.lock", os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600), "rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        gate = Admission(directory)
        factory = handler.make_handler
        handler.make_handler = lambda router: gated_handler(factory(router), gate)
        try:
            stale = control_path.lstat()
        except FileNotFoundError:
            pass
        else:
            if not stat.S_ISSOCK(stale.st_mode) or stale.st_uid != os.geteuid():
                raise RuntimeError("Unexpected engine control path")
            control_path.unlink()
        os.umask(0o177)
        try:
            control = socketserver.UnixStreamServer(str(control_path), ControlRequest)
        finally:
            os.umask(0o077)
        with control:
            control.gate = None
            stock_serve = server.serve
            def start_http(*args, **kwargs):
                httpd = stock_serve(*args, **kwargs)
                # Prove that this process, with its gated handler, acquired the real listener.
                control.gate = gate
                return httpd
            server.serve = start_http
            threading.Thread(target=control.serve_forever, daemon=True, name="engine-idle-control").start()
            try:
                return server.main()
            finally:
                control.gate = None
                control.shutdown()
                control_path.unlink(missing_ok=True)


if __name__ == "__main__":
    if os.geteuid() == 0:
        raise SystemExit("Run the engine as the lab user")
    raise SystemExit(serve_gated(Path.cwd().resolve(), RUN))
