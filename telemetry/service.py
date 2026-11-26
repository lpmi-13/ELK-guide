"""HTTP dashboard shell and dependency-free WebSocket telemetry collector."""

import base64
import hashlib
import json
import logging
import os
import re
import struct
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path

PORT = int(os.getenv("PORT", "8090"))
KIBANA_URL = os.getenv("KIBANA_URL", "http://localhost:5601")
LEARNING_URL = os.getenv("LEARNING_URL", "http://localhost:8091")
LOG_FILE = Path(os.getenv("LOG_DIR", "/tmp")) / "browser-telemetry.json"
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
_log_writer = logging.getLogger("browser-telemetry")
_log_writer.setLevel(logging.INFO)
_log_writer.propagate = False
_log_handler = RotatingFileHandler(
    LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=1, encoding="utf-8", delay=True
)
_log_handler.setFormatter(logging.Formatter("%(message)s"))
_log_writer.addHandler(_log_handler)
INDEX = Path(__file__).with_name("index.html")
PREPARING = Path(__file__).with_name("preparing.html")
FAVICONS = {
    "/favicon.svg": (Path(__file__).with_name("favicon.svg"), "image/svg+xml"),
    "/favicon.png": (Path(__file__).with_name("favicon.png"), "image/png"),
    "/favicon.ico": (Path(__file__).with_name("favicon.ico"), "image/x-icon"),
    "/apple-touch-icon.png": (Path(__file__).with_name("apple-touch-icon.png"), "image/png"),
}
lock = threading.Lock()

# Launch handoff. Start opens /preparing#<launch id> in a new tab and later posts the outcome here (the
# Kibana URL, or why preparation stopped); the preparation page polls for it. The launcher can't always
# reach that tab directly: on iximiuz it runs in a pane inside a page with Cross-Origin-Opener-Policy:
# same-origin, so the browser opens its popup as noopener (window.open returns null, the tab has no opener
# and its own sessionStorage). Outcomes are small, kept briefly, and readable only by their unguessable id.
HANDOFF_PATH = re.compile(r"^/preparing/handoff/([A-Za-z0-9-]{16,64})$")
HANDOFF_TTL_SECONDS = 900
HANDOFF_LIMIT = 200
HANDOFF_MAX_BYTES = 8192
handoffs = {}  # launch id -> (stored at, outcome JSON bytes)
handoff_lock = threading.Lock()


def valid_outcome(outcome):
    if not isinstance(outcome, dict):
        return False
    if "url" in outcome:
        return isinstance(outcome["url"], str) and outcome["url"].startswith(("http://", "https://"))
    halt = outcome.get("halt")
    return isinstance(halt, dict) and all(isinstance(value, str) for value in halt.values())


def store_handoff(launch_id, body):
    now = time.monotonic()
    with handoff_lock:
        for key in [key for key, (at, _) in handoffs.items() if now - at > HANDOFF_TTL_SECONDS]:
            del handoffs[key]
        while len(handoffs) >= HANDOFF_LIMIT:
            del handoffs[next(iter(handoffs))]
        handoffs.pop(launch_id, None)
        handoffs[launch_id] = (now, body)


def read_handoff(launch_id):
    with handoff_lock:
        entry = handoffs.get(launch_id)
    if entry and time.monotonic() - entry[0] <= HANDOFF_TTL_SECONDS:
        return entry[1]
    return b'{"pending":true}'


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
    # Whether Start found the scenario prepared ahead (the launcher prepares the selected card).
    if isinstance(payload.get("prepared_ahead"), bool):
        event["labels.prepared_ahead"] = payload["prepared_ahead"]
    line = json.dumps(event, separators=(",", ":"))
    with lock:
        _log_writer.info(line)
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
        elif self.path == "/preparing":
            self.respond(PREPARING.read_bytes(), "text/html; charset=utf-8")
        elif handoff := HANDOFF_PATH.match(self.path):
            self.respond(read_handoff(handoff.group(1)), "application/json")
        elif self.path in FAVICONS:
            path, content_type = FAVICONS[self.path]
            self.respond(path.read_bytes(), content_type)
        else:
            self.send_error(404)

    def do_POST(self):
        handoff = HANDOFF_PATH.match(self.path)
        if not handoff:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if not 0 < length <= HANDOFF_MAX_BYTES:
            self.send_error(413 if length > HANDOFF_MAX_BYTES else 400)
            return
        try:
            outcome = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            outcome = None
        if not valid_outcome(outcome):
            self.send_error(400)
            return
        store_handoff(handoff.group(1), json.dumps(outcome, separators=(",", ":")).encode())
        self.send_response(204)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

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
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"\nLab ready. Open http://localhost:{PORT}/ in your browser.\n", flush=True)
    server.serve_forever()
