"""Learning-session HTTP/WebSocket service for the adaptive incident lab."""

import base64
import hashlib
import json
import math
import os
import re
import secrets
import struct
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

from engine.evaluator import evaluate_action, playbook_goals, score_session
from engine.contracts import assert_catalog_valid, insert_goals

PORT = int(os.getenv("PORT", "8091"))
CONTROLLER_URL = os.getenv("SCENARIO_CONTROLLER_URL", "http://scenario-controller:8092").rstrip("/")
ELASTICSEARCH_URL = os.getenv("ELASTICSEARCH_URL", "http://elasticsearch:9200").rstrip("/")
LEARNING_DIR = Path(os.getenv("LEARNING_DIR", "/app/learning"))
LOG_FILE = Path(os.getenv("LOG_DIR", "/tmp")) / "learning-service.json"
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


PARAM_TOKEN = re.compile(r"\$\{param\.([A-Za-z0-9_.]+)\}")


def _param_lookup(parameters, dotted):
    current = parameters
    for part in dotted.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None
    return current


def resolve_parameters(value, parameters):
    """Resolve ``${param.<path>}`` tokens using the run's chosen parameters.

    Playbook and rubric templates are expanded from a pack's static ``variables``,
    but those variables can reference per-run parameters (for example the KQL that
    isolates the run's decisive signal). Resolving them here keeps the demonstrated
    query, accepted filters, validators, and hints aligned with the seeded data.
    """
    if not parameters:
        return value
    if isinstance(value, str):
        whole = PARAM_TOKEN.fullmatch(value)
        if whole:
            resolved = _param_lookup(parameters, whole.group(1))
            return resolved if resolved is not None else value

        def replace(match):
            resolved = _param_lookup(parameters, match.group(1))
            return match.group(0) if resolved is None else str(resolved)

        return PARAM_TOKEN.sub(replace, value)
    if isinstance(value, dict):
        return {key: resolve_parameters(item, parameters) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_parameters(item, parameters) for item in value]
    return value


def load_definition(folder, identifier):
    path = LEARNING_DIR / folder / f"{identifier}.json"
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def spell_duration(value):
    """Render a compact window such as ``15m`` or ``1h`` as prose (``15 minutes``, ``1 hour``).

    Coach copy spells the duration out in full; only the literal value the picker itself takes
    (``now-15m``) stays compact. Numbers are kept (matching Kibana's own "Last 15 minutes" /
    "Last 1 hour" quick ranges); unrecognized values pass through unchanged.
    """
    match = re.fullmatch(r"\s*(\d+)\s*([mh])\s*", str(value))
    if not match:
        return str(value)
    amount = int(match.group(1))
    noun = "minute" if match.group(2) == "m" else "hour"
    return f"{amount} {noun}" if amount == 1 else f"{amount} {noun}s"


def load_manifest_definition(manifest, kind):
    parameters = manifest.get("parameters", {})
    identifier = manifest[kind]
    if manifest.get("schema_version") == 2:
        path = LEARNING_DIR / "scenarios" / identifier
        if path.is_file():
            with path.open(encoding="utf-8") as stream:
                definition = json.load(stream)
            if definition.get("extends"):
                template_path = LEARNING_DIR / "templates" / f"{kind}s" / definition["extends"]
                with template_path.open(encoding="utf-8") as stream:
                    template = json.load(stream)
                variables = definition.get("variables", {})
                # Session creation may derive a tighter Discover window from the incident age.
                # Let that runtime value override both parameter-backed and fixed playbook defaults
                # so demonstration, guided hints, and "Show me" all use the same range.
                if definition.get("extends") == "discover.json" and "window" in parameters:
                    runtime_window = parameters["window"]
                    if isinstance(runtime_window, dict):
                        runtime_window = runtime_window.get("value", variables.get("window"))
                    variables = {**variables, "window": runtime_window}
                # Offer a spelled-out companion to any compact window variable so coach copy can
                # read "the last 15 minutes" while the picker action keeps "now-15m".
                if "window" in variables and "window_spelled" not in variables:
                    resolved_window = resolve_parameters(variables["window"], parameters)
                    variables = {**variables, "window_spelled": spell_duration(resolved_window)}

                def expand(value):
                    if isinstance(value, str):
                        for key, item in variables.items():
                            value = value.replace(f"${{var.{key}}}", str(item))
                        return value
                    if isinstance(value, list):
                        return [expand(item) for item in value]
                    if isinstance(value, dict):
                        return {key: expand(item) for key, item in value.items()}
                    return value

                result = expand(template)
                goal_overrides = {goal_id: expand(patch) for goal_id, patch in definition.get("goal_overrides", {}).items()}
                for goal in result.get("goals", []):
                    if goal["id"] in goal_overrides:
                        goal.update(goal_overrides[goal["id"]])
                insert_goals(result, definition.get("goal_inserts", []), expand)
                result.update(expand(definition.get("overrides", {})))
                result["id"] = definition.get("id", result["id"])
                return resolve_parameters(result, parameters)
            return resolve_parameters(definition, parameters)
    return resolve_parameters(load_definition(f"{kind}s", identifier), parameters)


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
    # Decide when the incident was noticed, then tie the recommended window to it before the
    # playbook is expanded so the coach's copy, its reference action, and the graded truth all match.
    detected_offset_minutes = select_detected_offset(manifest)
    apply_incident_window(manifest, detected_offset_minutes)
    playbook = load_manifest_definition(manifest, "playbook")
    rubric = load_manifest_definition(manifest, "rubric")
    session_id = f"session-{uuid.uuid4().hex[:12]}"
    session = {
        "id": session_id,
        "run_id": manifest["run_id"],
        "manifest": manifest,
        "mode": mode,
        "policy": MODE_POLICIES[mode],
        "playbook": playbook,
        "rubric": rubric,
        "controller_token": secrets.token_urlsafe(24),
        "last_action_sequence": 0,
        "last_command_sequence": 0,
        "completed_goals": set(),
        "actions": [],
        "assistance": {"hints": 0, "demonstrated_steps": 0},
        "hint_level": {},
        "answer": None,
        "feedback": None,
        "pending_command": None,
        "detected_offset_minutes": detected_offset_minutes,
        "briefing_acknowledged": False,
        "paused": False,
        "run_ready": False,
        "created_at": now_iso(),
    }
    with sessions_lock:
        sessions[session_id] = session
    return session


def session_public(session, include_connection=False):
    scenario = session["manifest"]["scenario"]
    result = {
        "session_id": session["id"],
        "run_id": session["run_id"],
        "mode": session["mode"],
        "policy": session["policy"],
        "brief": scenario["brief"],
        "scenario": {key: scenario.get(key) for key in ("id", "title", "type", "difficulty", "estimated_minutes", "skills")},
        "answer_schema": scenario.get("answer_schema", {"type": "diagnosis", "fields": []}),
        "investigation_url": run_investigation_url(session["manifest"]),
        "completed_goals": sorted(session["completed_goals"]),
        "step": current_step_index(session),
        "step_count": len(playbook_goals(session)),
    }
    if include_connection:
        result["connection_token"] = session["controller_token"]
        result["websocket_path"] = f"/api/sessions/{session['id']}/events"
    return result


def current_step_index(session):
    for index, goal in enumerate(playbook_goals(session)):
        if goal["id"] not in session["completed_goals"]:
            return index
    return len(playbook_goals(session))


def run_investigation_url(manifest):
    space_id = manifest.get("space_id")
    starting = manifest["scenario"].get("starting_view", {})
    path = starting.get("path") or f"/app/{starting.get('app', 'discover')}"
    path = path.replace("${run_id}", manifest["run_id"]).replace("${space_id}", space_id or "")
    if starting.get("app") == "apm" and "environment=" not in path:
        separator = "&" if "?" in path else "?"
        path = f"{path}{separator}environment={quote(manifest['run_id'], safe='')}&rangeFrom=now-1h&rangeTo=now"
    prefix = f"/s/{space_id}" if space_id else ""
    return f"http://localhost:5601{prefix}{path}"


def substitute(value, session):
    trace_id = next(
        (
            str((item["action"].get("details") or {}).get("trace_id") or (item["action"].get("state_after") or {}).get("trace_id"))
            for item in reversed(session["actions"])
            if (item["action"].get("details") or {}).get("trace_id") or (item["action"].get("state_after") or {}).get("trace_id")
        ),
        "the selected trace",
    )
    expected = session["manifest"].get("expected", {})
    scenario = session["manifest"]["scenario"]
    truth = scenario.get("truth", {})
    replacements = {
        "${run_id}": session["run_id"],
        "${space_id}": session["manifest"].get("space_id", ""),
        "${scenario.title}": scenario.get("title", ""),
        "${scenario.brief}": scenario.get("brief", ""),
        "${scenario.type}": scenario.get("type", ""),
        "${expected_service}": expected.get("service", ""),
        "${expected_fault_type}": expected.get("fault_type", ""),
        "${expected_route}": expected.get("route", ""),
        "${minimum_duration_ns}": expected.get("minimum_duration_ns", 0),
        "${trace_id}": trace_id,
        # The "Noticed N minutes ago" fact the intake modal shows. Exposed here so demonstration
        # copy can name the same number as the briefing when it justifies the investigation window.
        "${detected_offset_minutes}": session.get("detected_offset_minutes", ""),
    }
    for key, item in truth.get("answers", {}).items():
        replacements[f"${{truth.{key}}}"] = item
    if isinstance(value, str):
        for source, replacement in replacements.items():
            value = value.replace(source, str(replacement))
        return value
    if isinstance(value, dict):
        return {key: substitute(item, session) for key, item in value.items()}
    if isinstance(value, list):
        return [substitute(item, session) for item in value]
    return value


def stable_briefing_choice(values, session, field):
    """Pick a briefing variant reproducibly for a seeded scenario run."""
    if not values:
        raise ValueError(f"incident briefing has no {field} choices")
    manifest = session["manifest"]
    identity = f"{manifest.get('seed', 0)}:{manifest.get('template_id', '')}:{field}"
    digest = hashlib.sha256(f"incident-briefing:v1:{identity}".encode()).digest()
    return values[int.from_bytes(digest[:8], "big") % len(values)]


def load_incident_briefings():
    with (LEARNING_DIR / "incident-briefings.json").open(encoding="utf-8") as stream:
        return json.load(stream)


def select_detected_offset(manifest):
    """Pick, reproducibly, how many minutes ago this run's incident was first noticed.

    This is the ``Noticed N minutes ago`` fact the intake modal shows, and it is chosen
    here (once, at session creation) so the recommended investigation window can be derived
    from the same value the learner reads in the briefing.
    """
    definitions = load_incident_briefings()
    profile = definitions.get("scenarios", {}).get(manifest["scenario"]["id"], {})
    values = profile.get("observed_minutes_ago") or [8, 10, 12]
    return stable_briefing_choice(values, {"manifest": manifest}, "observed_minutes_ago")


def recommended_window_minutes(offset_minutes):
    """Round the noticed-offset up to the next 5-minute mark (6->10, 13->15, 26->30).

    Rounding up (never down) keeps the window reaching back past the moment the incident was
    noticed, which is exactly what the evaluator requires (see ``TIME_WINDOW_TOLERANCE_MINUTES``),
    while snapping to a clean 5-minute value a learner would actually type into the time picker.
    """
    return max(5, math.ceil(offset_minutes / 5) * 5)


def apply_incident_window(manifest, offset_minutes):
    """Align this run's window (coach copy, reference action, and graded truth) with the offset.

    Every Discover scenario feeds a compact window into the shared scope step. Derive that runtime
    value from the same incident age shown in the briefing instead of leaving it as an independent
    random choice (for example, "noticed 12 minutes ago" paired with "last 1 hour"). Both compact
    string windows and the labelled value used by the dedicated time-window lesson are supported.
    The latter also appears in its already-resolved truth, so update that copy as well. Re-deriving
    from the same offset is idempotent.
    """
    scenario = manifest.get("scenario", {})
    if scenario.get("starting_view", {}).get("app") != "discover" or offset_minutes is None:
        return
    parameters = manifest.get("parameters") or {}
    window = parameters.get("window")
    if window is not None and not isinstance(window, (str, dict)):
        return
    minutes = recommended_window_minutes(offset_minutes)
    new_value = f"{minutes}m"
    new_label = f"last {spell_duration(new_value)}"
    old_label = None
    if isinstance(window, dict):
        if "value" not in window or "label" not in window:
            return
        old_label = window["label"]
        parameters["window"] = {**window, "value": new_value, "label": new_label}
    else:
        parameters["window"] = new_value
    manifest["parameters"] = parameters
    if old_label and old_label != new_label:
        answers = scenario.get("truth", {}).get("answers", {})
        for key, value in answers.items():
            if isinstance(value, str):
                answers[key] = value.replace(old_label, new_label)


def build_incident_briefing(session):
    """Build the non-spoiler incident intake shown before every assistance mode."""
    definitions = load_incident_briefings()
    scenario = session["manifest"]["scenario"]
    raw_profile = definitions.get("scenarios", {}).get(scenario["id"], {})
    fallback = {
        "severity": "SEV-3",
        "owner": "Service Operations",
        "environment": "Production",
        "observed_minutes_ago": [8, 10, 12],
        "channels": ["monitoring", "pager", "support"],
        "headline": scenario["title"],
        "summary": scenario["brief"],
        "impact": "Production behavior is outside its expected range. Establish the scope and collect decisive evidence before choosing a remediation.",
        "signals": [{"label": "Triage request", "value": scenario["brief"]}],
    }
    profile = {**fallback, **raw_profile}
    profile = resolve_parameters(profile, session["manifest"].get("parameters", {}))
    profile = substitute(profile, session)
    channel_key = stable_briefing_choice(profile.pop("channels"), session, "channel")
    # Reuse the offset chosen at session creation so the modal's "Noticed N minutes ago" and the
    # window the coach recommends are guaranteed to agree; recompute only if it was never stored.
    observed_minutes_ago = session.get("detected_offset_minutes")
    if observed_minutes_ago is None:
        observed_minutes_ago = stable_briefing_choice(profile["observed_minutes_ago"], session, "observed_minutes_ago")
    profile.pop("observed_minutes_ago", None)
    source = dict(definitions["sources"][channel_key])
    source["key"] = channel_key
    source["detail"] = source["detail"].replace("${owner}", profile["owner"]).replace("${channel_slug}", scenario["id"])
    return {
        "protocol_version": 2,
        "message_type": "incident_briefing",
        "briefing_id": f"{session['id']}-intake",
        "scenario_id": scenario["id"],
        "scenario_title": scenario["title"],
        "mode": session["mode"],
        "duration_ms": 30_000,
        "detected_offset_minutes": observed_minutes_ago,
        "source": source,
        "graphic": "/incident-coach/assets/assets/incident-signal.webp",
        **profile,
    }


def next_command(session):
    if not session["run_ready"] or session["paused"]:
        return None
    index = current_step_index(session)
    goals = playbook_goals(session)
    if index >= len(goals):
        return None
    if session["pending_command"] and session["pending_command"]["step_index"] == index:
        return session["pending_command"]
    step = goals[index]
    session["last_command_sequence"] += 1
    reference = step.get("reference_action", {})
    command_type = reference.get("command", step.get("action"))
    command_value = substitute(reference.get("arguments", step.get("value")), session)
    if session["mode"] == "demonstration" and command_type in {"request_diagnosis", "request_answer"}:
        command_type = "show_debrief"
        command_value = substitute(session["playbook"]["demonstration_summary"], session)
    if session["mode"] == "challenge" and command_type not in {"request_diagnosis", "request_answer"}:
        command_type = "orient"
        command_value = None
    explanation = step.get("demonstration", {}) if session["mode"] == "demonstration" else {}

    def explanation_text(field, default=""):
        return substitute(explanation.get(field, step.get(field, default)), session)

    command = {
        "protocol_version": 2,
        "message_type": "command",
        "command_id": f"{session['id']}-{step['id']}-{session['last_command_sequence']}",
        "run_id": session["run_id"],
        "session_id": session["id"],
        "sequence": session["last_command_sequence"],
        "step_id": step["id"],
        "step_index": index,
        "step_count": len(goals),
        "type": command_type,
        "target": reference.get("target", step.get("target", "coach.answer")),
        "value": command_value,
        "expected_page": session["manifest"]["scenario"].get("starting_view", {}).get("app", "discover"),
        "mode": session["mode"],
        "narration": explanation_text("narration", step.get("title", "")) if session["policy"]["show_narration"] else session["manifest"]["scenario"]["brief"],
        "reasoning": explanation_text("reasoning") if session["mode"] == "demonstration" else "",
        "evidence": explanation_text("evidence") if session["mode"] == "demonstration" else "",
        "learning_focus": substitute(explanation.get("learning_focus", []), session) if session["mode"] == "demonstration" else [],
        "concept": explanation_text("concept") if session["mode"] == "demonstration" else "",
        "answer_schema": session["manifest"]["scenario"].get("answer_schema", {}),
    }
    if session["mode"] == "guided" and command_type not in {"request_diagnosis", "request_answer"}:
        # "Show me" replays this step as a mini demonstration, so it carries the same scenario-specific
        # what/optional why/result the demonstration narrates (e.g. why the range reaches back N minutes).
        walkthrough = step.get("demonstration", {})
        command["walkthrough"] = {
            field: substitute(walkthrough.get(field, step.get(field, "")), session)
            for field in ("narration", "reasoning", "evidence", "learning_focus")
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
    validators = session["manifest"]["scenario"].get("provisioning", {}).get("readiness_validators", [])
    deadline = time.monotonic() + max([int(item.get("timeout_seconds", 90)) for item in validators] or [90]) + 30
    while time.monotonic() < deadline:
        if refresh_run_ready(session):
            return True
        time.sleep(2)
    return False


def elastic_search(query, index="microservices-*"):
    status, result = http_json(f"{ELASTICSEARCH_URL}/{index}/_search?allow_no_indices=true", "POST", query)
    return result if status < 400 else {}


def action_evidence(session, action):
    evidence = {"assertions": {}, "trace_services": 0}
    details = action.get("details") or {}
    trace_id = details.get("trace_id") or (action.get("state_after") or {}).get("trace_id")
    for assertion in session["manifest"]["scenario"].get("truth", {}).get("assertions", []):
        kind = assertion.get("kind")
        index = substitute(assertion.get("index", f"lab-{session['run_id']}"), session)
        if kind in {"es_count", "es_cardinality"}:
            query = {"size": 0, "query": substitute(assertion.get("query", {"match_all": {}}), session)}
            if kind == "es_cardinality":
                query["aggs"] = {"value": {"cardinality": {"field": assertion["field"]}}}
            result = elastic_search(query, index)
            if kind == "es_cardinality":
                value = result.get("aggregations", {}).get("value", {}).get("value", 0)
            else:
                total = result.get("hits", {}).get("total", 0)
                value = total.get("value", 0) if isinstance(total, dict) else total
            evidence["assertions"][assertion["id"]] = value >= assertion.get("minimum", 1)
        elif kind == "trace_from_action" and trace_id:
            trace_filter = [{"match_phrase": {"trace.id": str(trace_id)}}]
            if index.startswith("microservices"):
                trace_filter.append({"match_phrase": {"scenario.id": session["run_id"]}})
            trace_query = {"size": 0, "query": {"bool": {"filter": trace_filter}}, "aggs": {"services": {"cardinality": {"field": "service.name.keyword"}}}}
            count = elastic_search(trace_query, index).get("aggregations", {}).get("services", {}).get("value", 0)
            evidence["trace_services"] = count
            evidence["assertions"][assertion["id"]] = count >= assertion.get("minimum", 1)
        elif kind == "resource_isolated":
            evidence["assertions"][assertion["id"]] = bool(session["manifest"].get("space_id"))
    evidence.update(evidence["assertions"])
    return evidence


def record_action(session, action):
    sequence = int(action.get("sequence", 0))
    if sequence <= session["last_action_sequence"]:
        raise ValueError("action sequence must increase monotonically")
    if action.get("run_id") != session["run_id"] or action.get("session_id") != session["id"]:
        raise ValueError("action run_id and session_id must match the connected session")
    if int(action.get("protocol_version", 0)) not in {1, 2}:
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
        if parsed.path in {"/api/catalog", "/api/capabilities"}:
            status, result = http_json(f"{CONTROLLER_URL}{parsed.path}")
            self.respond(status, result)
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
            self.respond(202, {"run": public_run, "session": session_public(session, include_connection=True)})
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
            self.respond(202, {"run": {key: value for key, value in run.items() if key != "manifest"}, "session": session_public(session, include_connection=True)})
            return

        if len(parts) == 4 and parts[:2] == ["api", "sessions"]:
            with sessions_lock:
                session = sessions.get(parts[2])
                if not session:
                    self.respond(404, {"error": "session not found"})
                    return
                action = parts[3]
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
                    actor = "tutorial" if session["mode"] == "demonstration" else "learner"
                    synthetic = {"protocol_version": 2, "run_id": session["run_id"], "session_id": session["id"], "sequence": session["last_action_sequence"] + 1, "type": "answer_submitted", "actor": actor, "observed_at": now_iso(), "details": payload}
                    record_action(session, synthetic)
                    answer_evidence = action_evidence(session, {"details": {"trace_id": payload.get("trace_id")}})
                    trace_valid = answer_evidence["trace_services"] >= 3
                    session["feedback"] = score_session(session, trace_is_valid=trace_valid, evidence=answer_evidence)
                    transition_run(session, "COMPLETED")
                    self.respond(200, session["feedback"])
                    return
        self.respond(404, {"error": "not found"})

    def do_DELETE(self):
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "runs"]:
            status, result = http_json(f"{CONTROLLER_URL}/api/runs/{parts[2]}", "DELETE", timeout=30)
            self.respond(status, result)
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
        if session["briefing_acknowledged"]:
            transition_run(session, "INVESTIGATING")
            initial = next_command(session)
            send_frame(connection, json.dumps(initial or {"message_type": "complete", "session_id": session_id}))
        else:
            send_frame(connection, json.dumps(build_incident_briefing(session)))
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
                elif message_type == "briefing_ack":
                    if session["briefing_acknowledged"]:
                        continue
                    session["briefing_acknowledged"] = True
                    transition_run(session, "INVESTIGATING")
                    command = next_command(session)
                    send_frame(connection, json.dumps(command or {"message_type": "complete", "session_id": session_id}))
                elif message_type == "hint":
                    index = current_step_index(session)
                    goals = playbook_goals(session)
                    if index < len(goals):
                        step = goals[index]
                        hints = step.get("hints", [])
                        if not hints:
                            send_frame(connection, json.dumps({"message_type": "hint", "step_id": step["id"], "level": 0, "text": "No additional hint is available for this goal."}))
                            continue
                        level = min(session["hint_level"].get(step["id"], 0), len(hints) - 1)
                        session["hint_level"][step["id"]] = level + 1
                        session["assistance"]["hints"] += 1
                        send_frame(connection, json.dumps({"message_type": "hint", "step_id": step["id"], "level": level + 1, "text": substitute(hints[level], session)}))
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
        if origin in ALLOWED_ORIGINS:
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
    assert_catalog_valid(LEARNING_DIR)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
