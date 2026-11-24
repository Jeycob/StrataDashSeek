#!/usr/bin/env python3
"""Serve the wake portal's private, uncached readiness image on a Unix socket."""

import http.client
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import pwd
import socketserver
import struct
import zlib


HOST = 'basalt-inkling.tail9a42c6.ts.net'
SOCKET = Path('/run/basalt-pairing/ready.sock')


def png_chunk(name, payload):
    return struct.pack('>I', len(payload)) + name + payload + struct.pack('>I', zlib.crc32(name + payload))


# A real one-pixel RGB image, decoded by the existing portal's Image.onload handler.
PNG = (b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>2I5B', 1, 1, 8, 2, 0, 0, 0)) +
       png_chunk(b'IDAT', zlib.compress(b'\0\x2d\x89\x59')) + png_chunk(b'IEND', b''))


def ready():
    native = http.client.HTTPConnection('127.0.0.1', 8787, timeout=1.5)
    engine = http.client.HTTPConnection('127.0.0.1', 8080, timeout=1.5)
    try:
        # Anonymous status on the authenticated app. Neither endpoint submits work.
        native.request('GET', '/', headers={'Host': HOST, 'Connection': 'close'})
        if native.getresponse().status != 401:
            return False
        engine.request('GET', '/v1/models', headers={'Connection': 'close'})
        response = engine.getresponse()
        if response.status != 200:
            return False
        data = response.read(65537)
        if len(data) > 65536:
            return False
        return any(model.get('id') == 'inkling-2-mini' and model.get('status', {}).get('value') == 'loaded'
                   for model in json.loads(data)['data'])
    except (OSError, http.client.HTTPException, ValueError, TypeError, KeyError, AttributeError):
        return False
    finally:
        native.close()
        engine.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, head):
        route = self.path.partition('?')[0]
        code = 404 if route not in ('/', '/phone/icon.png') else (200 if ready() else 503)
        body = PNG if code == 200 else b''
        self.send_response(code)
        self.send_header('Cache-Control', 'private, no-store')
        self.send_header('Content-Type', 'image/png' if code == 200 else 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def do_GET(self):
        self.respond(False)

    def do_HEAD(self):
        self.respond(True)


if __name__ == '__main__':
    if os.geteuid() != pwd.getpwnam('basaltlab').pw_uid:
        raise SystemExit('run as basaltlab')
    os.umask(0o177)
    with socketserver.UnixStreamServer(str(SOCKET), Handler) as server:
        try:
            server.serve_forever()
        finally:
            SOCKET.unlink(missing_ok=True)
