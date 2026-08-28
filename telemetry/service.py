"""HTTP dashboard shell and dependency-free WebSocket telemetry collector."""

import base64
import hashlib
import json
import os
import struct
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.getenv("PORT", "8090"))
KIBANA_URL = os.getenv("KIBANA_URL", "http://localhost:5601")
LEARNING_URL = os.getenv("LEARNING_URL", "http://localhost:8091")
LOG_FILE = Path(os.getenv("LOG_DIR", "/tmp")) / "browser-telemetry.json"
INDEX = Path(__file__).with_name("index.html")
lock = threading.Lock()


def emit(payload, client):
    event = {
        "@timestamp": datetime.now(timezone.utc).isoformat(),
        "log.level": "INFO",
        "message": "kibana browser interaction",
        "service.name": "browser-telemetry",
        "service.environment": "demo",
        "event.dataset": "kibana.browser",
        "event.action": str(payload.get("type", "unknown"))[:64],
        "session.id": str(payload.get("session_id", "unknown"))[:128],
        "client.address": client,
        "browser.viewport": str(payload.get("viewport", ""))[:32],
        "url.path": str(payload.get("path", ""))[:512],
    }
    line = json.dumps(event, separators=(",", ":"))
    with lock, LOG_FILE.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")
    print(line, flush=True)


def read_frame(connection):
    header = connection.recv(2)
    if len(header) != 2:
        return None, None
    opcode = header[0] & 0x0F
    masked, length = bool(header[1] & 0x80), header[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", connection.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", connection.recv(8))[0]
    if length > 64 * 1024:
        raise ValueError("WebSocket message is too large")
    mask = connection.recv(4) if masked else b""
    data = bytearray()
    while len(data) < length:
        chunk = connection.recv(length - len(data))
        if not chunk:
            return None, None
        data.extend(chunk)
    if masked:
        data = bytearray(value ^ mask[index % 4] for index, value in enumerate(data))
    return opcode, bytes(data)


def send_frame(connection, payload, opcode=1):
    data = payload.encode() if isinstance(payload, str) else payload
    prefix = bytes([0x80 | opcode])
    if len(data) < 126:
        header = prefix + bytes([len(data)])
    else:
        header = prefix + bytes([126]) + struct.pack("!H", len(data))
    connection.sendall(header + data)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.respond(b'{"status":"ok"}', "application/json")
        elif self.path == "/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
            self.websocket()
        elif self.path in ("/", "/index.html"):
            page = (
                INDEX.read_text(encoding="utf-8")
                .replace("__KIBANA_URL__", json.dumps(KIBANA_URL))
                .replace("__LEARNING_URL__", json.dumps(LEARNING_URL))
            )
            self.respond(page.encode(), "text/html; charset=utf-8")
        else:
            self.send_error(404)

    def respond(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self.send_error(400, "Missing WebSocket key")
            return
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        connection = self.connection
        connection.settimeout(45)
        send_frame(connection, json.dumps({"type": "connected", "connection_id": uuid.uuid4().hex}))
        try:
            while True:
                opcode, data = read_frame(connection)
                if opcode in (None, 8):
                    break
                if opcode == 9:
                    send_frame(connection, data, 10)
                elif opcode == 1:
                    payload = json.loads(data.decode("utf-8"))
                    emit(payload, self.client_address[0])
                    send_frame(connection, json.dumps({"type": "accepted", "event": payload.get("type")}))
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
