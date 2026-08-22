"""Tiny dependency-free HTTP service which produces ECS-like JSON logs."""

import json
import os
import random
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

SERVICE = os.getenv("SERVICE_NAME", "unknown-service")
PORT = int(os.getenv("PORT", "8080"))
INTERVAL = float(os.getenv("LOG_INTERVAL_SECONDS", "2"))
DEPENDENCIES = [value for value in os.getenv("DEPENDENCIES", "").split(",") if value]
LOG_FILE = Path(os.getenv("LOG_DIR", "/tmp")) / f"{SERVICE}.json"
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
write_lock = threading.Lock()


def emit(message, level="INFO", **fields):
    event = {
        "@timestamp": datetime.now(timezone.utc).isoformat(),
        "log.level": level,
        "message": message,
        "service.name": SERVICE,
        "service.environment": "demo",
        **fields,
    }
    line = json.dumps(event, separators=(",", ":"))
    with write_lock, LOG_FILE.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")
    print(line, flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        started = time.monotonic()
        trace_id = self.headers.get("traceparent", uuid.uuid4().hex)
        status = 500 if self.path == "/error" else 200
        body = json.dumps({"service": SERVICE, "status": "ok", "trace_id": trace_id}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        emit(
            "request completed",
            "ERROR" if status >= 500 else "INFO",
            **{
                "http.request.method": "GET",
                "http.response.status_code": status,
                "url.path": self.path,
                "event.duration": int((time.monotonic() - started) * 1_000_000_000),
                "trace.id": trace_id,
            },
        )

    def log_message(self, *_args):
        return


def generate_activity():
    paths = ["/health", "/items", "/checkout", "/users/me"]
    while True:
        time.sleep(INTERVAL * random.uniform(0.5, 1.5))
        trace_id = uuid.uuid4().hex
        if DEPENDENCIES:
            target = random.choice(DEPENDENCIES) + random.choice(paths)
            try:
                request = Request(target, headers={"traceparent": trace_id})
                with urlopen(request, timeout=2) as response:
                    status = response.status
                emit("downstream request completed", **{"destination.address": target, "http.response.status_code": status, "trace.id": trace_id})
            except Exception as error:  # the failure is part of the observable demo
                emit("downstream request failed", "ERROR", **{"destination.address": target, "error.type": type(error).__name__, "trace.id": trace_id})
        else:
            emit("background task completed", **{"event.action": random.choice(["cache_refresh", "reconcile", "heartbeat"]), "trace.id": trace_id})


if __name__ == "__main__":
    emit("service started", **{"server.port": PORT})
    threading.Thread(target=generate_activity, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

