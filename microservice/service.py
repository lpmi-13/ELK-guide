"""Dependency-free HTTP service with correlated logs and runtime fault injection."""

import json
import os
import random
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

SERVICE = os.getenv("SERVICE_NAME", "unknown-service")
PORT = int(os.getenv("PORT", "8080"))
INTERVAL = float(os.getenv("LOG_INTERVAL_SECONDS", "2"))
DEPENDENCIES = [value.rstrip("/") for value in os.getenv("DEPENDENCIES", "").split(",") if value]
LOG_FILE = Path(os.getenv("LOG_DIR", "/tmp")) / f"{SERVICE}.json"
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
write_lock = threading.Lock()
fault_lock = threading.Lock()
fault_states = {}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def emit(message, level="INFO", **fields):
    event = {
        "@timestamp": now_iso(),
        "log.level": level,
        "message": message,
        "service.name": SERVICE,
        "service.environment": "demo",
        "event.dataset": "microservices.application",
        **{key: value for key, value in fields.items() if value is not None},
    }
    line = json.dumps(event, separators=(",", ":"))
    with write_lock, LOG_FILE.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")
    print(line, flush=True)


def trace_id_from_headers(headers):
    explicit = headers.get("X-Trace-Id")
    if explicit:
        return explicit[:64]
    traceparent = headers.get("traceparent", "")
    parts = traceparent.split("-")
    if len(parts) >= 4 and len(parts[1]) == 32:
        return parts[1]
    if traceparent:
        return traceparent[:64]
    return uuid.uuid4().hex


def normalize_fault(payload):
    if not isinstance(payload, dict):
        raise ValueError("fault payload must be an object")
    fault_type = payload.get("fault", payload.get("type"))
    if fault_type not in {"latency", "error", "unavailable"}:
        raise ValueError("fault must be latency, error, or unavailable")
    delay_ms = int(payload.get("delay_ms", 0))
    probability = float(payload.get("probability", 1))
    paths = payload.get("paths", ["/"])
    if not 0 <= delay_ms <= 30000:
        raise ValueError("delay_ms must be between 0 and 30000")
    if not 0 <= probability <= 1:
        raise ValueError("probability must be between 0 and 1")
    if not isinstance(paths, list) or not paths or any(not isinstance(path, str) or not path.startswith("/") for path in paths):
        raise ValueError("paths must be a non-empty list of absolute paths")
    return {
        "scenario_id": str(payload.get("scenario_id", ""))[:128],
        "scenario_name": str(payload.get("scenario_name", ""))[:128],
        "fault": fault_type,
        "delay_ms": delay_ms,
        "probability": probability,
        "paths": paths,
        "activated_at": now_iso(),
    }


def set_fault(payload):
    normalized = normalize_fault(payload)
    key = normalized["scenario_id"] or "default"
    with fault_lock:
        fault_states[key] = normalized
    return normalized.copy()


def clear_fault(scenario_id=None):
    with fault_lock:
        if scenario_id:
            previous = fault_states.pop(scenario_id, None)
            return previous.copy() if previous else None
        previous = next(iter(fault_states.values()), None)
        fault_states.clear()
        return previous.copy() if previous else None


def get_fault(scenario_id=None):
    with fault_lock:
        if scenario_id:
            configured = fault_states.get(scenario_id)
            return configured.copy() if configured else None
        configured = next(iter(fault_states.values()), None)
        return configured.copy() if configured else None


def get_faults():
    with fault_lock:
        return {key: value.copy() for key, value in fault_states.items()}


def matching_fault(path, scenario_id):
    configured = get_fault(scenario_id or "default")
    if not configured or path not in configured["paths"]:
        return None
    if configured["scenario_id"] and configured["scenario_id"] != scenario_id:
        return None
    if random.random() > configured["probability"]:
        return None
    return configured


def scenario_fields(scenario_id, scenario_name=""):
    if not scenario_id:
        return {}
    return {
        "scenario.id": scenario_id,
        "scenario.name": scenario_name or "active-incident",
        "scenario.phase": "active",
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "incident-lab-service/1"

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self.respond_json(200, {"status": "ok", "service": SERVICE})
            return
        if path == "/_control/state":
            self.respond_json(200, {"service": SERVICE, "fault": get_fault(), "faults": get_faults()})
            return
        if path.startswith("/_control/"):
            self.respond_json(404, {"error": "unknown control endpoint"})
            return
        self.handle_application_request(path)

    def do_POST(self):
        if urlparse(self.path).path != "/_control/fault":
            self.respond_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 16 * 1024:
                raise ValueError("fault payload must be between 1 and 16384 bytes")
            configured = set_fault(json.loads(self.rfile.read(length)))
        except (ValueError, json.JSONDecodeError) as error:
            self.respond_json(400, {"error": str(error)})
            return
        emit("runtime fault activated", "WARN", **scenario_fields(configured["scenario_id"], configured["scenario_name"]), **{"event.action": "fault_activated", "fault.type": configured["fault"]})
        self.respond_json(200, {"service": SERVICE, "fault": configured})

    def do_DELETE(self):
        if urlparse(self.path).path != "/_control/fault":
            self.respond_json(404, {"error": "not found"})
            return
        scenario_id = parse_qs(urlparse(self.path).query).get("scenario_id", [None])[0]
        previous = clear_fault(scenario_id)
        if previous:
            emit("runtime fault cleared", **scenario_fields(previous["scenario_id"], previous["scenario_name"]), **{"event.action": "fault_cleared", "fault.type": previous["fault"]})
        self.respond_json(200, {"service": SERVICE, "cleared": previous is not None})

    def handle_application_request(self, path):
        started = time.monotonic()
        trace_id = trace_id_from_headers(self.headers)
        transaction_id = uuid.uuid4().hex[:16]
        parent_id = self.headers.get("X-Parent-Id")
        scenario_id = self.headers.get("X-Scenario-Id", "")[:128]
        scenario_name = self.headers.get("X-Scenario-Name", "")[:128]
        applied_fault = matching_fault(path, scenario_id)
        status = 500 if path == "/error" else 200
        error_type = None

        if applied_fault:
            if applied_fault["fault"] == "latency":
                time.sleep(applied_fault["delay_ms"] / 1000)
            elif applied_fault["fault"] == "error":
                status = 500
                error_type = "InjectedServiceError"
            elif applied_fault["fault"] == "unavailable":
                status = 503
                error_type = "InjectedDependencyUnavailable"

        if status < 500:
            for dependency in DEPENDENCIES:
                downstream_status = self.call_dependency(dependency, path, trace_id, transaction_id, scenario_id, scenario_name)
                if downstream_status >= 500:
                    status = 502
                    error_type = "DownstreamRequestFailed"

        duration_ns = int((time.monotonic() - started) * 1_000_000_000)
        event_fields = {
            "event.kind": "event",
            "event.category": "web",
            "event.type": "transaction",
            "event.outcome": "failure" if status >= 500 else "success",
            "event.duration": duration_ns,
            "http.request.method": "GET",
            "http.response.status_code": status,
            "url.path": path,
            "trace.id": trace_id,
            "transaction.id": transaction_id,
            "transaction.name": f"GET {path}",
            "parent.id": parent_id,
            "fault.applied": bool(applied_fault),
            "fault.type": applied_fault["fault"] if applied_fault else None,
            "error.type": error_type,
            **scenario_fields(scenario_id, scenario_name),
        }
        emit("request completed", "ERROR" if status >= 500 else ("WARN" if applied_fault else "INFO"), **event_fields)
        self.respond_json(status, {"service": SERVICE, "status": "error" if status >= 500 else "ok", "trace_id": trace_id, "transaction_id": transaction_id, "duration_ns": duration_ns})

    def call_dependency(self, dependency, path, trace_id, transaction_id, scenario_id, scenario_name):
        target = dependency + path
        span_id = uuid.uuid4().hex[:16]
        started = time.monotonic()
        status = 503
        error_type = None
        try:
            request = Request(target, headers={"X-Trace-Id": trace_id, "X-Parent-Id": span_id, "X-Scenario-Id": scenario_id, "X-Scenario-Name": scenario_name})
            with urlopen(request, timeout=12) as response:
                status = response.status
        except HTTPError as error:
            status = error.code
            error_type = type(error).__name__
        except Exception as error:  # a downstream failure is expected incident evidence
            error_type = type(error).__name__
        duration_ns = int((time.monotonic() - started) * 1_000_000_000)
        destination = urlparse(dependency)
        emit(
            "downstream request completed" if status < 500 else "downstream request failed",
            "ERROR" if status >= 500 else "INFO",
            **{
                "event.kind": "event",
                "event.category": "network",
                "event.type": "span",
                "event.outcome": "failure" if status >= 500 else "success",
                "event.duration": duration_ns,
                "http.request.method": "GET",
                "http.response.status_code": status,
                "url.path": path,
                "destination.address": destination.hostname,
                "destination.port": destination.port,
                "trace.id": trace_id,
                "transaction.id": transaction_id,
                "span.id": span_id,
                "span.name": f"GET {destination.hostname}:{destination.port}{path}",
                "span.type": "external",
                "parent.id": transaction_id,
                "error.type": error_type,
                **scenario_fields(scenario_id, scenario_name),
            },
        )
        return status

    def respond_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def log_message(self, *_args):
        return


def generate_activity():
    paths = ["/items", "/users/me", "/healthcheck"]
    actions = ["cache_refresh", "reconcile", "heartbeat"]
    while True:
        time.sleep(INTERVAL * random.uniform(0.5, 1.5))
        trace_id = uuid.uuid4().hex
        transaction_id = uuid.uuid4().hex[:16]
        if DEPENDENCIES:
            dependency = random.choice(DEPENDENCIES)
            target = dependency + random.choice(paths)
            started = time.monotonic()
            status = 503
            error_type = None
            try:
                request = Request(target, headers={"X-Trace-Id": trace_id, "X-Parent-Id": transaction_id})
                with urlopen(request, timeout=4) as response:
                    status = response.status
            except Exception as error:
                error_type = type(error).__name__
            emit(
                "background downstream request completed" if status < 500 else "background downstream request failed",
                "INFO" if status < 500 else "ERROR",
                **{
                    "event.type": "span",
                    "event.duration": int((time.monotonic() - started) * 1_000_000_000),
                    "destination.address": target,
                    "http.response.status_code": status,
                    "trace.id": trace_id,
                    "transaction.id": transaction_id,
                    "span.id": uuid.uuid4().hex[:16],
                    "error.type": error_type,
                },
            )
        else:
            level = "WARN" if random.random() < 0.05 else "INFO"
            emit("background task completed", level, **{"event.action": random.choice(actions), "trace.id": trace_id, "transaction.id": transaction_id})


if __name__ == "__main__":
    emit("service started", **{"server.port": PORT})
    threading.Thread(target=generate_activity, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
