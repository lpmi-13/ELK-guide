"""Learning-session HTTP/WebSocket service for the adaptive incident lab."""

import base64
import hashlib
import json
import os
import secrets
import struct
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

from engine.evaluator import evaluate_action, score_session

PORT = int(os.getenv("PORT", "8091"))
CONTROLLER_URL = os.getenv("SCENARIO_CONTROLLER_URL", "http://scenario-controller:8092").rstrip("/")
ELASTICSEARCH_URL = os.getenv("ELASTICSEARCH_URL", "http://elasticsearch:9200").rstrip("/")
LEARNING_DIR = Path(os.getenv("LEARNING_DIR", "/app/learning"))
LOG_FILE = Path(os.getenv("LOG_DIR", "/tmp")) / "learning-service.json"
PAIR_TTL_SECONDS = int(os.getenv("PAIR_TTL_SECONDS", "600"))
ALLOWED_ORIGINS = {value.rstrip("/") for value in os.getenv("ALLOWED_ORIGINS", "http://localhost:5601,http://127.0.0.1:5601,http://localhost:8090").split(",")}

sessions = {}
sessions_lock = threading.RLock()
write_lock = threading.Lock()

MODE_POLICIES = {
    "demonstration": {"action_actor": "tutorial", "show_narration": True, "highlight_target": True, "validate_timing": "immediate", "allow_demonstrate_step": True},
    "guided": {"action_actor": "learner", "show_narration": True, "highlight_target": True, "validate_timing": "immediate", "allow_demonstrate_step": True},
    "challenge": {"action_actor": "learner", "show_narration": False, "highlight_target": False, "validate_timing": "debrief", "allow_demonstrate_step": False},
}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def load_definition(folder, identifier):
    path = LEARNING_DIR / folder / f"{identifier}.json"
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def http_json(url, method="GET", payload=None, timeout=10):
    data = json.dumps(payload).encode() if payload is not None else None
    request = Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as error:
        raw = error.read()
        return error.code, json.loads(raw) if raw else {"error": str(error)}


def emit(session, action, evaluation=None):
    event = {
        "@timestamp": now_iso(),
        "log": {"level": "INFO"},
        "message": "semantic tutorial action",
        "service": {"name": "learning-service", "environment": "demo"},
        "event": {"dataset": "learning.tutorial", "action": action.get("type", "unknown"), "sequence": action.get("sequence")},
        "scenario": {"id": session["run_id"]},
        "session": {"id": session["id"]},
        "tutorial": {"id": session["playbook"]["id"], "mode": session["mode"], "outcome": (evaluation or {}).get("outcome", "observed")},
        "actor": {"type": action.get("actor", "learner")},
        "action": action,
        "validation": evaluation or {},
    }
    line = json.dumps(event, separators=(",", ":"))
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with write_lock, LOG_FILE.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")
    print(line, flush=True)


def create_session(run_response, mode):
    manifest = run_response["manifest"]
    playbook = load_definition("playbooks", manifest["playbook"])
    rubric = load_definition("rubrics", manifest["rubric"])
    session_id = f"session-{uuid.uuid4().hex[:12]}"
    pairing_code = f"{secrets.randbelow(1_000_000):06d}"
    session = {
        "id": session_id,
        "run_id": manifest["run_id"],
        "manifest": manifest,
        "mode": mode,
        "policy": MODE_POLICIES[mode],
        "playbook": playbook,
        "rubric": rubric,
        "pairing_code": pairing_code,
        "pair_expires": time.time() + PAIR_TTL_SECONDS,
        "controller_token": None,
        "claimed": False,
        "last_action_sequence": 0,
        "last_command_sequence": 0,
        "completed_goals": set(),
        "actions": [],
        "assistance": {"hints": 0, "demonstrated_steps": 0},
        "hint_level": {},
        "answer": None,
        "feedback": None,
        "pending_command": None,
        "paused": False,
        "run_ready": False,
        "created_at": now_iso(),
    }
    with sessions_lock:
        sessions[session_id] = session
    return session


def session_public(session, include_pairing=False):
    result = {
        "session_id": session["id"],
        "run_id": session["run_id"],
        "mode": session["mode"],
        "policy": session["policy"],
        "brief": session["manifest"]["scenario"]["brief"],
        "investigation_url": "http://localhost:5601/app/discover#/view/incident-investigation",
        "completed_goals": sorted(session["completed_goals"]),
        "step": current_step_index(session),
        "step_count": len(session["playbook"]["steps"]),
        "claimed": session["claimed"],
    }
    if include_pairing:
        result["pairing_code"] = session["pairing_code"]
        result["pairing_expires_at"] = datetime.fromtimestamp(session["pair_expires"], timezone.utc).isoformat()
    return result


def current_step_index(session):
    for index, step in enumerate(session["playbook"]["steps"]):
        if step["goal"] not in session["completed_goals"]:
            return index
    return len(session["playbook"]["steps"])


def substitute(value, session):
    replacements = {
        "${run_id}": session["run_id"],
        "${expected_service}": session["manifest"]["expected"]["service"],
    }
    if isinstance(value, str):
        for source, replacement in replacements.items():
            value = value.replace(source, str(replacement))
        return value
    if isinstance(value, dict):
        return {key: substitute(item, session) for key, item in value.items()}
    if isinstance(value, list):
        return [substitute(item, session) for item in value]
    return value


def next_command(session):
    if not session["run_ready"] or session["paused"]:
        return None
    index = current_step_index(session)
    if index >= len(session["playbook"]["steps"]):
        return None
    if session["pending_command"] and session["pending_command"]["step_index"] == index:
        return session["pending_command"]
    step = session["playbook"]["steps"][index]
    session["last_command_sequence"] += 1
    command_type = step["action"]
    if session["mode"] == "challenge" and command_type != "request_diagnosis":
        command_type = "orient"
    command = {
        "protocol_version": 1,
        "message_type": "command",
        "command_id": f"{session['id']}-{step['id']}-{session['last_command_sequence']}",
        "run_id": session["run_id"],
        "session_id": session["id"],
        "sequence": session["last_command_sequence"],
        "step_id": step["id"],
        "step_index": index,
        "step_count": len(session["playbook"]["steps"]),
        "type": command_type,
        "target": step["target"],
        "value": substitute(step.get("value"), session),
        "expected_page": "discover",
        "mode": session["mode"],
        "narration": step["narration"] if session["policy"]["show_narration"] else session["manifest"]["scenario"]["brief"],
    }
    session["pending_command"] = command
    return command


def refresh_run_ready(session):
    status, run = http_json(f"{CONTROLLER_URL}/api/runs/{session['run_id']}")
    session["run_ready"] = status == 200 and run.get("state") in {"READY", "INVESTIGATING"}
    return session["run_ready"]


def transition_run(session, state):
    status, result = http_json(f"{CONTROLLER_URL}/api/runs/{session['run_id']}/state", "POST", {"state": state})
    if status not in {200, 409}:
        raise RuntimeError(result.get("error", f"run transition failed ({status})"))
    return result


def wait_run_ready(session):
    deadline = time.monotonic() + session["manifest"]["scenario"]["readiness"]["timeout_seconds"] + 30
    while time.monotonic() < deadline:
        if refresh_run_ready(session):
            return True
        time.sleep(2)
    return False


def elastic_search(query):
    status, result = http_json(f"{ELASTICSEARCH_URL}/microservices-*/_search?allow_no_indices=true", "POST", query)
    return result if status < 400 else {}


def action_evidence(session, action):
    expected = session["manifest"]["expected"]
    base_filters = [{"match_phrase": {"scenario.id": session["run_id"]}}]
    slow_query = {"size": 0, "query": {"bool": {"filter": base_filters + [{"range": {"event.duration": {"gte": 2_000_000_000}}}]}}}
    service_query = {"size": 0, "query": {"bool": {"filter": base_filters + [{"match_phrase": {"service.name": expected["service"]}}, {"range": {"event.duration": {"gte": expected["minimum_duration_ns"]}}}]}}}
    evidence = {
        "slow_events": elastic_search(slow_query).get("hits", {}).get("total", {}).get("value", 0) > 0,
        "service_events": elastic_search(service_query).get("hits", {}).get("total", {}).get("value", 0) > 0,
        "trace_services": 0,
    }
    details = action.get("details") or {}
    trace_id = details.get("trace_id") or (action.get("state_after") or {}).get("trace_id")
    if trace_id:
        trace_query = {
            "size": 0,
            "query": {"bool": {"filter": base_filters + [{"match_phrase": {"trace.id": str(trace_id)}}]}},
            "aggs": {"services": {"cardinality": {"field": "service.name.keyword"}}},
        }
        evidence["trace_services"] = elastic_search(trace_query).get("aggregations", {}).get("services", {}).get("value", 0)
    return evidence


def record_action(session, action):
    sequence = int(action.get("sequence", 0))
    if sequence <= session["last_action_sequence"]:
        raise ValueError("action sequence must increase monotonically")
    if action.get("run_id") != session["run_id"] or action.get("session_id") != session["id"]:
        raise ValueError("action run_id and session_id must match the paired session")
    if int(action.get("protocol_version", 0)) != 1:
        raise ValueError("unsupported protocol version")
    session["last_action_sequence"] = sequence
    if action.get("type") == "hint_requested":
        session["assistance"]["hints"] += 1
    if action.get("type") == "step_demonstrated":
        session["assistance"]["demonstrated_steps"] += 1
    evidence = action_evidence(session, action)
    evaluation = evaluate_action(session, action, evidence)
    if evaluation["goals_progressed"]:
        session["pending_command"] = None
    session["actions"].append({"action": action, "evaluation": evaluation})
    emit(session, action, evaluation)
    return evaluation


def claim_session(session, code, existing_token=None):
    if existing_token and secrets.compare_digest(existing_token, session.get("controller_token") or ""):
        return existing_token
    if session["claimed"]:
        raise ValueError("session is already controlled by another browser")
    if time.time() > session["pair_expires"]:
        raise ValueError("pairing code expired")
    if not secrets.compare_digest(str(code), session["pairing_code"]):
        raise ValueError("invalid pairing code")
    session["claimed"] = True
    session["controller_token"] = secrets.token_urlsafe(24)
    return session["controller_token"]


def authorized(handler, session, query=None):
    header = handler.headers.get("Authorization", "")
    token = header.removeprefix("Bearer ") if header.startswith("Bearer ") else (query or {}).get("token", [""])[0]
    return bool(session.get("controller_token") and secrets.compare_digest(token, session["controller_token"]))


def send_frame(connection, payload, opcode=1):
    data = payload.encode() if isinstance(payload, str) else payload
    prefix = bytes([0x80 | opcode])
    if len(data) < 126:
        header = prefix + bytes([len(data)])
    elif len(data) <= 65535:
        header = prefix + bytes([126]) + struct.pack("!H", len(data))
    else:
        header = prefix + bytes([127]) + struct.pack("!Q", len(data))
    connection.sendall(header + data)


def read_exact(connection, length):
    data = bytearray()
    while len(data) < length:
        chunk = connection.recv(length - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)


def read_frame(connection):
    header = read_exact(connection, 2)
    if not header:
        return None, None
    opcode = header[0] & 0x0F
    masked = bool(header[1] & 0x80)
    length = header[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", read_exact(connection, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", read_exact(connection, 8))[0]
    if length > 256 * 1024:
        raise ValueError("WebSocket message too large")
    mask = read_exact(connection, 4) if masked else b""
    payload = read_exact(connection, length)
    if payload is None:
        return None, None
    if masked:
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return opcode, payload


class Handler(BaseHTTPRequestHandler):
    server_version = "learning-service/1"

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.respond(200, {"status": "ok", "sessions": len(sessions)})
            return
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "runs"]:
            status, run = http_json(f"{CONTROLLER_URL}/api/runs/{parts[2]}")
            self.respond(status, run)
            return
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "feedback":
            with sessions_lock:
                session = sessions.get(parts[2])
                if not session:
                    self.respond(404, {"error": "session not found"})
                elif not session["feedback"]:
                    self.respond(409, {"error": "diagnosis has not been submitted"})
                else:
                    self.respond(200, session["feedback"])
            return
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events" and self.headers.get("Upgrade", "").lower() == "websocket":
            self.websocket(parts[2], parse_qs(parsed.query))
            return
        self.respond(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        try:
            payload = self.read_json()
        except (ValueError, json.JSONDecodeError) as error:
            self.respond(400, {"error": str(error)})
            return

        if parsed.path == "/api/runs":
            mode = payload.get("mode", "guided")
            if mode not in MODE_POLICIES:
                self.respond(400, {"error": "mode must be demonstration, guided, or challenge"})
                return
            run_request = {"scenario": payload.get("scenario", "slow-payments")}
            if "scenario_key" in payload:
                run_request["scenario_key"] = payload["scenario_key"]
            elif "seed" in payload:
                run_request["seed"] = payload["seed"]
            status, run = http_json(f"{CONTROLLER_URL}/api/runs", "POST", run_request, timeout=20)
            if status >= 400:
                self.respond(status, run)
                return
            session = create_session(run, mode)
            public_run = {key: value for key, value in run.items() if key != "manifest"}
            self.respond(202, {"run": public_run, "session": session_public(session, include_pairing=True)})
            return

        if len(parts) == 4 and parts[:2] == ["api", "runs"] and parts[3] == "reset":
            status, run = http_json(f"{CONTROLLER_URL}/api/runs/{parts[2]}/reset", "POST", payload, timeout=20)
            if status >= 400:
                self.respond(status, run)
                return
            mode = payload.get("mode", "guided")
            if mode not in MODE_POLICIES:
                self.respond(400, {"error": "invalid mode"})
                return
            session = create_session(run, mode)
            self.respond(202, {"run": {key: value for key, value in run.items() if key != "manifest"}, "session": session_public(session, include_pairing=True)})
            return

        if len(parts) == 4 and parts[:2] == ["api", "sessions"]:
            with sessions_lock:
                session = sessions.get(parts[2])
                if not session:
                    self.respond(404, {"error": "session not found"})
                    return
                action = parts[3]
                if action == "claim":
                    try:
                        token = claim_session(session, payload.get("code", ""), payload.get("token"))
                    except ValueError as error:
                        self.respond(409, {"error": str(error)})
                        return
                    self.respond(200, {"token": token, "session": session_public(session), "websocket_path": f"/api/sessions/{session['id']}/events"})
                    return
                if not authorized(self, session):
                    self.respond(401, {"error": "invalid controller token"})
                    return
                if action == "actions":
                    if not session["run_ready"] and not refresh_run_ready(session):
                        self.respond(409, {"error": "run evidence is not ready"})
                        return
                    transition_run(session, "INVESTIGATING")
                    try:
                        evaluation = record_action(session, payload)
                    except ValueError as error:
                        self.respond(409, {"error": str(error)})
                        return
                    self.respond(202, {"evaluation": evaluation, "session": session_public(session)})
                    return
                if action == "answer":
                    if not session["run_ready"] and not refresh_run_ready(session):
                        self.respond(409, {"error": "run evidence is not ready"})
                        return
                    session["answer"] = payload
                    synthetic = {"protocol_version": 1, "run_id": session["run_id"], "session_id": session["id"], "sequence": session["last_action_sequence"] + 1, "type": "diagnosis_submitted", "actor": "learner", "observed_at": now_iso(), "details": payload}
                    record_action(session, synthetic)
                    trace_valid = action_evidence(session, {"details": {"trace_id": payload.get("trace_id")}})["trace_services"] >= 3
                    session["feedback"] = score_session(session, trace_is_valid=trace_valid)
                    transition_run(session, "COMPLETED")
                    self.respond(200, session["feedback"])
                    return
        self.respond(404, {"error": "not found"})

    def websocket(self, session_id, query):
        with sessions_lock:
            session = sessions.get(session_id)
            if not session:
                self.respond(404, {"error": "session not found"})
                return
            if not authorized(self, session, query):
                self.respond(401, {"error": "invalid controller token"})
                return
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self.respond(400, {"error": "missing WebSocket key"})
            return
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        connection = self.connection
        connection.settimeout(60)
        if not wait_run_ready(session):
            send_frame(connection, json.dumps({"message_type": "failed", "error": "run evidence did not become ready"}))
            return
        transition_run(session, "INVESTIGATING")
        initial = next_command(session)
        send_frame(connection, json.dumps(initial or {"message_type": "complete", "session_id": session_id}))
        try:
            while True:
                opcode, data = read_frame(connection)
                if opcode in (None, 8):
                    break
                if opcode == 9:
                    send_frame(connection, data, 10)
                    continue
                if opcode != 1:
                    continue
                message = json.loads(data)
                message_type = message.get("message_type")
                if message_type == "action":
                    evaluation = record_action(session, message["action"])
                    reply = {"message_type": "action_result", "evaluation": evaluation, "session": session_public(session)}
                    send_frame(connection, json.dumps(reply))
                    if evaluation["goals_progressed"] and not session["paused"]:
                        command = next_command(session)
                        if command:
                            send_frame(connection, json.dumps(command))
                elif message_type == "ack":
                    send_frame(connection, json.dumps({"message_type": "acknowledged", "command_id": message.get("command_id")}))
                elif message_type == "hint":
                    index = current_step_index(session)
                    if index < len(session["playbook"]["steps"]):
                        step = session["playbook"]["steps"][index]
                        level = min(session["hint_level"].get(step["id"], 0), len(step["hints"]) - 1)
                        session["hint_level"][step["id"]] = level + 1
                        session["assistance"]["hints"] += 1
                        send_frame(connection, json.dumps({"message_type": "hint", "step_id": step["id"], "level": level + 1, "text": substitute(step["hints"][level], session)}))
                elif message_type == "pause":
                    session["paused"] = True
                    send_frame(connection, json.dumps({"message_type": "status", "paused": True}))
                elif message_type == "resume":
                    session["paused"] = False
                    send_frame(connection, json.dumps({"message_type": "status", "paused": False}))
                    command = next_command(session)
                    if command:
                        send_frame(connection, json.dumps(command))
        except (OSError, TimeoutError, ValueError, KeyError, json.JSONDecodeError):
            pass

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 256 * 1024:
            raise ValueError("request body is too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def cors_headers(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS or origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def respond(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
