"""Lifecycle controller for reproducible, evidence-gated incident scenarios."""

import copy
import hashlib
import json
import os
import random
import secrets
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

PORT = int(os.getenv("PORT", "8092"))
ELASTICSEARCH_URL = os.getenv("ELASTICSEARCH_URL", "http://elasticsearch:9200").rstrip("/")
SCENARIO_NAME = os.getenv("SCENARIO", "slow-payments")
SCENARIO_SEED = os.getenv("SCENARIO_SEED", "")
AUTO_START = os.getenv("SCENARIO_AUTO_START", "true").lower() in {"1", "true", "yes"}
SCENARIO_DIR = Path(os.getenv("SCENARIO_DIR", "/app/scenarios"))
MANIFEST_DIR = Path(os.getenv("MANIFEST_DIR", "/tmp/scenario-manifests"))
LOG_FILE = Path(os.getenv("LOG_DIR", "/tmp")) / "scenario-controller.json"
SERVICE_URLS = {
    "api-gateway": os.getenv("API_GATEWAY_URL", "http://api-gateway:8080").rstrip("/"),
    "auth": os.getenv("AUTH_URL", "http://auth:8081").rstrip("/"),
    "catalog": os.getenv("CATALOG_URL", "http://catalog:8082").rstrip("/"),
    "orders": os.getenv("ORDERS_URL", "http://orders:8083").rstrip("/"),
    "payments": os.getenv("PAYMENTS_URL", "http://payments:8084").rstrip("/"),
}

state_lock = threading.RLock()
write_lock = threading.Lock()
current_run = None
cancel_event = threading.Event()
SCENARIO_KEY_MIN_LENGTH = 10
SCENARIO_KEY_MAX_LENGTH = 40
SCENARIO_KEY_UNSET = object()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def emit(message, level="INFO", run_id=None, **fields):
    event = {
        "@timestamp": now_iso(),
        "log": {"level": level},
        "message": message,
        "service": {"name": "scenario-controller", "environment": "demo"},
        "event": {"dataset": "scenario.control", "action": fields.pop("action", "lifecycle")},
        **fields,
    }
    if run_id:
        event["scenario"] = {"id": run_id, "phase": fields.get("state", "active")}
    line = json.dumps(event, separators=(",", ":"))
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with write_lock, LOG_FILE.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")
    print(line, flush=True)


def http_json(url, method="GET", payload=None, timeout=10):
    body = json.dumps(payload).encode() if payload is not None else None
    request = Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            data = response.read()
            return response.status, json.loads(data) if data else {}
    except HTTPError as error:
        data = error.read()
        detail = json.loads(data) if data else {"error": str(error)}
        return error.code, detail


def load_template(name):
    selected = "slow-payments" if name == "random" else name
    path = SCENARIO_DIR / f"{selected}.json"
    if not path.is_file():
        raise ValueError(f"unknown scenario: {name}")
    with path.open(encoding="utf-8") as stream:
        template = json.load(stream)
    required = {"schema_version", "id", "version", "fault", "traffic", "readiness", "truth", "playbook", "rubric"}
    missing = sorted(required - template.keys())
    if missing:
        raise ValueError(f"scenario is missing: {', '.join(missing)}")
    return template


def scenario_key_seed(value):
    """Map an exact, user-visible scenario key to its internal numeric seed."""
    if not isinstance(value, str):
        raise ValueError("scenario key must be a string between 10 and 40 characters")
    if not SCENARIO_KEY_MIN_LENGTH <= len(value) <= SCENARIO_KEY_MAX_LENGTH:
        raise ValueError("scenario key must be between 10 and 40 characters")
    digest = hashlib.sha256(f"scenario-key:v1:{value}".encode()).digest()
    return int.from_bytes(digest[:8], "big") & ((1 << 63) - 1), value


def normalize_seed(value=None):
    """Return an internal numeric seed, accepting legacy string keys as input."""
    selected = value
    if selected is None or selected == "":
        selected = SCENARIO_SEED or secrets.randbits(63)
    if isinstance(selected, bool):
        raise ValueError("seed must be a non-negative integer or a 10-40 character scenario key")
    if isinstance(selected, int):
        seed = selected
        scenario_key = None
    elif isinstance(selected, float):
        if not selected.is_integer():
            raise ValueError("seed must be a non-negative integer or a 10-40 character scenario key")
        seed = int(selected)
        scenario_key = None
    else:
        candidate = str(selected).strip()
        if candidate.isdecimal():
            seed = int(candidate)
            scenario_key = None
        else:
            return scenario_key_seed(candidate)
    if seed < 0:
        raise ValueError("seed must be a non-negative integer")
    return seed, scenario_key


def materialize(template, seed, run_id=None, scenario_key=None):
    """Create an immutable manifest; seeded values are stable, while run IDs stay unique."""
    canonical = json.dumps(template, sort_keys=True, separators=(",", ":")).encode()
    generator = random.Random(seed)
    scenario = copy.deepcopy(template)
    base_delay = scenario["fault"]["delay_ms"]
    scenario["fault"]["delay_ms"] = generator.choice(
        sorted({max(3000, base_delay - 300), base_delay, base_delay + 300})
    )
    scenario["fault"]["probability"] = generator.choice([0.85, 0.9, 0.95])
    scenario["readiness"]["minimum_duration_ms"] = min(
        scenario["readiness"]["minimum_duration_ms"], scenario["fault"]["delay_ms"] - 100
    )
    manifest = {
        "schema_version": 1,
        "run_id": run_id or f"run-{uuid.uuid4().hex[:12]}",
        "template_id": template["id"],
        "template_version": template["version"],
        "template_hash": hashlib.sha256(canonical).hexdigest(),
        "seed": seed,
        "generator_version": 1,
        "created_at": now_iso(),
        "scenario": scenario,
        "expected": {
            "service": scenario["truth"]["root_cause_service"],
            "fault_type": scenario["truth"]["fault_type"],
            "route": scenario["truth"]["affected_route"],
            "minimum_duration_ns": scenario["readiness"]["minimum_duration_ms"] * 1_000_000,
            "evidence": scenario["truth"]["evidence"],
        },
        "playbook": scenario["playbook"],
        "rubric": scenario["rubric"],
    }
    if scenario_key:
        manifest["scenario_key"] = scenario_key
    return manifest


def public_state(run, include_manifest=False):
    if not run:
        return {"state": "CREATED", "run_id": None}
    response = {
        "run_id": run["manifest"]["run_id"],
        "state": run["state"],
        "seed": run["manifest"]["seed"],
        "scenario_key": run["manifest"].get("scenario_key"),
        "template_id": run["manifest"]["template_id"],
        "title": run["manifest"]["scenario"]["title"],
        "brief": run["manifest"]["scenario"]["brief"],
        "created_at": run["manifest"]["created_at"],
        "ready_at": run.get("ready_at"),
        "completed_at": run.get("completed_at"),
        "evidence": run.get("evidence", {"affected_traces": 0}),
        "error": run.get("error"),
        "investigation_url": "http://localhost:5601/app/discover#/view/incident-investigation",
    }
    if include_manifest:
        response["manifest"] = run["manifest"]
    return response


def update_run(run_id, **updates):
    with state_lock:
        if current_run and current_run["manifest"]["run_id"] == run_id:
            current_run.update(updates)
            return True
    return False


def activate_fault(manifest):
    scenario = manifest["scenario"]
    fault = scenario["fault"]
    service_url = SERVICE_URLS.get(fault["service"])
    if not service_url:
        raise RuntimeError(f"no URL configured for {fault['service']}")
    payload = {
        "scenario_id": manifest["run_id"],
        "scenario_name": manifest["template_id"],
        "fault": fault["type"],
        "delay_ms": fault["delay_ms"],
        "probability": fault["probability"],
        "paths": fault["paths"],
    }
    status, response = http_json(f"{service_url}/_control/fault", "POST", payload)
    if status != 200:
        raise RuntimeError(f"fault activation failed ({status}): {response}")


def clear_active_fault(run):
    if not run:
        return
    service = run["manifest"]["scenario"]["fault"]["service"]
    service_url = SERVICE_URLS.get(service)
    if not service_url:
        return
    try:
        http_json(f"{service_url}/_control/fault", "DELETE", timeout=5)
    except (OSError, URLError):
        pass


def send_target_request(manifest):
    traffic = manifest["scenario"]["traffic"]
    entrypoint = SERVICE_URLS[traffic["entrypoint"]]
    trace_id = uuid.uuid4().hex
    request = Request(
        entrypoint + traffic["path"],
        headers={
            "X-Trace-Id": trace_id,
            "X-Scenario-Id": manifest["run_id"],
            "X-Scenario-Name": manifest["template_id"],
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            response.read()
    except HTTPError as error:
        error.read()
    except (OSError, URLError) as error:
        emit("target request failed", "ERROR", manifest["run_id"], action="traffic_error", error={"type": type(error).__name__})


def traffic_loop(manifest, stop):
    rate = manifest["scenario"]["traffic"]["requests_per_second"]
    interval = 1 / rate
    with ThreadPoolExecutor(max_workers=max(8, int(rate * 6)), thread_name_prefix="scenario-traffic") as pool:
        while not stop.wait(interval):
            pool.submit(send_target_request, manifest)


def evidence_count(manifest):
    readiness = manifest["scenario"]["readiness"]
    query = {
        "size": 0,
        "query": {
            "bool": {
                "filter": [
                    {"match_phrase": {"scenario.id": manifest["run_id"]}},
                    {"match_phrase": {"service.name": readiness["expected_service"]}},
                    {"match_phrase": {"event.type": "transaction"}},
                    {"range": {"event.duration": {"gte": readiness["minimum_duration_ms"] * 1_000_000}}},
                ]
            }
        },
        "aggs": {"affected_traces": {"cardinality": {"field": "trace.id.keyword", "precision_threshold": 100}}},
    }
    status, result = http_json(f"{ELASTICSEARCH_URL}/microservices-*/_search?allow_no_indices=true", "POST", query)
    if status >= 400:
        return 0
    return int(result.get("aggregations", {}).get("affected_traces", {}).get("value", 0))


def lifecycle(manifest, stop):
    run_id = manifest["run_id"]
    try:
        update_run(run_id, state="ACTIVATING")
        emit("scenario activating", run_id=run_id, action="activating", state="ACTIVATING", seed=manifest["seed"], expected=manifest["expected"])
        activate_fault(manifest)
        if stop.is_set():
            return
        update_run(run_id, state="WARMING")
        emit("scenario warming", run_id=run_id, action="warming", state="WARMING")
        threading.Thread(target=traffic_loop, args=(manifest, stop), daemon=True).start()
        deadline = time.monotonic() + manifest["scenario"]["readiness"]["timeout_seconds"]
        minimum = manifest["scenario"]["readiness"]["minimum_affected_traces"]
        while not stop.wait(2):
            count = evidence_count(manifest)
            update_run(run_id, evidence={"affected_traces": count, "required": minimum})
            if count >= minimum:
                ready_at = now_iso()
                update_run(run_id, state="READY", ready_at=ready_at)
                emit("scenario ready", run_id=run_id, action="ready", state="READY", evidence={"affected_traces": count})
                return
            if time.monotonic() >= deadline:
                raise TimeoutError(f"only {count} of {minimum} affected traces were indexed")
    except Exception as error:
        if update_run(run_id, state="FAILED", error=str(error)):
            emit("scenario failed", "ERROR", run_id, action="failed", state="FAILED", error={"type": type(error).__name__, "message": str(error)})
        stop.set()
        clear_active_fault({"manifest": manifest})


def create_run(seed=None, scenario_name=None, scenario_key=SCENARIO_KEY_UNSET):
    global current_run, cancel_event
    if scenario_key is SCENARIO_KEY_UNSET:
        selected_seed, scenario_key = normalize_seed(seed)
    else:
        selected_seed, scenario_key = scenario_key_seed(scenario_key)
    template = load_template(scenario_name or SCENARIO_NAME)
    manifest = materialize(template, selected_seed, scenario_key=scenario_key)
    with state_lock:
        previous = current_run
        cancel_event.set()
        clear_active_fault(previous)
        cancel_event = threading.Event()
        current_run = {"manifest": manifest, "state": "CREATED", "evidence": {"affected_traces": 0}}
        MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
        with (MANIFEST_DIR / f"{manifest['run_id']}.json").open("w", encoding="utf-8") as stream:
            json.dump(manifest, stream, indent=2, sort_keys=True)
        snapshot = public_state(current_run, include_manifest=True)
    threading.Thread(target=lifecycle, args=(manifest, cancel_event), daemon=True).start()
    return snapshot


def stop_run(run_id):
    global current_run
    with state_lock:
        if not current_run or current_run["manifest"]["run_id"] != run_id:
            return False
        cancel_event.set()
        clear_active_fault(current_run)
        current_run["state"] = "ABORTED"
        emit("scenario aborted", run_id=run_id, action="aborted", state="ABORTED")
        return True


def transition_run(run_id, requested_state):
    allowed = {
        "READY": {"INVESTIGATING", "COMPLETED"},
        "INVESTIGATING": {"COMPLETED"},
    }
    with state_lock:
        if not current_run or current_run["manifest"]["run_id"] != run_id:
            raise KeyError("run not found")
        previous = current_run["state"]
        if requested_state == previous:
            return public_state(current_run)
        if requested_state not in allowed.get(previous, set()):
            raise ValueError(f"cannot transition run from {previous} to {requested_state}")
        current_run["state"] = requested_state
        if requested_state == "COMPLETED":
            cancel_event.set()
            clear_active_fault(current_run)
            current_run["completed_at"] = now_iso()
        emit(f"scenario {requested_state.lower()}", run_id=run_id, action=requested_state.lower(), state=requested_state)
        return public_state(current_run)


class Handler(BaseHTTPRequestHandler):
    server_version = "scenario-controller/1"

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            with state_lock:
                self.respond(200, {"status": "ok", "run": public_state(current_run)})
            return
        if parsed.path == "/ready":
            with state_lock:
                ready = bool(current_run and current_run["state"] == "READY")
                self.respond(200 if ready else 503, {"ready": ready, "run": public_state(current_run)})
            return
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "runs"]:
            with state_lock:
                if not current_run or current_run["manifest"]["run_id"] != parts[2]:
                    self.respond(404, {"error": "run not found"})
                else:
                    include = parse_qs(parsed.query).get("include_manifest") == ["true"]
                    self.respond(200, public_state(current_run, include_manifest=include))
            return
        self.respond(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            payload = self.read_json()
        except (ValueError, json.JSONDecodeError) as error:
            self.respond(400, {"error": str(error)})
            return
        parts = parsed.path.strip("/").split("/")
        try:
            if parsed.path == "/api/runs":
                if "scenario_key" in payload:
                    run = create_run(scenario_name=payload.get("scenario"), scenario_key=payload["scenario_key"])
                else:
                    run = create_run(payload.get("seed"), payload.get("scenario"))
                self.respond(202, run)
                return
            if len(parts) == 4 and parts[:2] == ["api", "runs"] and parts[3] == "reset":
                with state_lock:
                    if not current_run or current_run["manifest"]["run_id"] != parts[2]:
                        self.respond(404, {"error": "run not found"})
                        return
                    use_scenario_key = "scenario_key" in payload
                    seed = payload.get("seed")
                    scenario_key = payload.get("scenario_key")
                    if not use_scenario_key and seed is None:
                        scenario_key = current_run["manifest"].get("scenario_key")
                        use_scenario_key = scenario_key is not None
                        if not use_scenario_key:
                            seed = current_run["manifest"]["seed"]
                    scenario = current_run["manifest"]["template_id"]
                if use_scenario_key:
                    run = create_run(scenario_name=scenario, scenario_key=scenario_key)
                else:
                    run = create_run(seed, scenario)
                self.respond(202, run)
                return
            if len(parts) == 4 and parts[:2] == ["api", "runs"] and parts[3] == "state":
                try:
                    result = transition_run(parts[2], str(payload.get("state", "")).upper())
                except KeyError as error:
                    self.respond(404, {"error": str(error)})
                    return
                self.respond(200, result)
                return
        except (ValueError, RuntimeError) as error:
            self.respond(400, {"error": str(error)})
            return
        self.respond(404, {"error": "not found"})

    def do_DELETE(self):
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "runs"]:
            self.respond(200 if stop_run(parts[2]) else 404, {"aborted": True if current_run and current_run["manifest"]["run_id"] == parts[2] else False})
            return
        self.respond(404, {"error": "not found"})

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 64 * 1024:
            raise ValueError("request body is too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def respond(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    if AUTO_START:
        create_run()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
