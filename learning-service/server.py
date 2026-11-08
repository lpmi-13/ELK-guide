"""Learning-session HTTP/WebSocket service for the adaptive incident lab."""

import base64
import hashlib
import json
import logging
import math
import os
import re
import secrets
import struct
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

from engine.evaluator import IGNORED_ACTIONS, TIME_WINDOW_TOLERANCE_MINUTES, answer_phrases, current_goal, evaluate_action, guided_feedback, incident_moments, incident_timing, parse_instant, playbook_goals, recommended_window_start, relative_window, reveals_answer, score_session, scope_complete, window_miss, window_reaches_incident, window_reference, window_start
from engine.contracts import assert_catalog_valid, insert_goals
from engine.kql import view_query

PORT = int(os.getenv("PORT", "8091"))
CONTROLLER_URL = os.getenv("SCENARIO_CONTROLLER_URL", "http://scenario-controller:8092").rstrip("/")
ELASTICSEARCH_URL = os.getenv("ELASTICSEARCH_URL", "http://elasticsearch:9200").rstrip("/")
LEARNING_DIR = Path(os.getenv("LEARNING_DIR", "/app/learning"))
LOG_FILE = Path(os.getenv("LOG_DIR", "/tmp")) / "learning-service.json"
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
_log_writer = logging.getLogger("learning-service")
_log_writer.setLevel(logging.INFO)
_log_writer.propagate = False
_log_handler = RotatingFileHandler(
    LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=1, encoding="utf-8", delay=True
)
_log_handler.setFormatter(logging.Formatter("%(message)s"))
_log_writer.addHandler(_log_handler)
ALLOWED_ORIGINS = {value.rstrip("/") for value in os.getenv("ALLOWED_ORIGINS", "http://localhost:5601,http://127.0.0.1:5601,http://localhost:8090").split(",")}

sessions = {}
sessions_lock = threading.RLock()
write_lock = threading.Lock()

MODE_POLICIES = {
    "demonstration": {"action_actor": "tutorial", "show_narration": True, "highlight_target": True, "validate_timing": "immediate", "allow_demonstrate_step": True},
    "guided": {"action_actor": "learner", "show_narration": True, "highlight_target": True, "validate_timing": "immediate", "allow_demonstrate_step": True},
    "challenge": {"action_actor": "learner", "show_narration": False, "highlight_target": False, "validate_timing": "debrief", "allow_demonstrate_step": False, "allow_hints": False},
}


# Guided step clock: active seconds a step may take before the coach gently checks in. Flat per
# reference command (never scaled by difficulty); a playbook step may override it with
# ``pace.expected_seconds``, but no budget is ever below MINIMUM_PACE_SECONDS.
MINIMUM_PACE_SECONDS = 45
PACE_DEFAULTS = {
    "set_time_range": 45,
    "open_field_statistics": 45,
    "inspect_field": 45,
    "add_filter": 60,
    "enter_kql": 60,
    "expand_document": 45,
}


def pace_seconds(step):
    override = (step.get("pace") or {}).get("expected_seconds")
    command = step.get("reference_action", {}).get("command")
    budget = override if isinstance(override, (int, float)) else PACE_DEFAULTS.get(command, MINIMUM_PACE_SECONDS)
    return int(max(MINIMUM_PACE_SECONDS, budget))


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


def emit(session, action, evaluation=None, evidence=None):
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
    if evidence:
        # Whether the assertions were checked inside the learner's view, and what they found.
        event["evidence"] = {"view_scoped": bool(evidence.get("view_scoped")), "assertions": evidence.get("assertions", {}),
                             "esql_rows": len((evidence.get("esql_result") or {}).get("values") or []) if "esql_result" in evidence else None}
    line = json.dumps(event, separators=(",", ":"))
    with write_lock:
        _log_writer.info(line)
    print(line, flush=True)


def create_session(run_response, mode):
    manifest = run_response["manifest"]
    # Decide when the incident was noticed. Its clock time, the window the coach recommends and the
    # graded truth all derive from that one moment (see incident_clock).
    detected_offset_minutes = select_detected_offset(manifest)
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
        # Steps whose served hint named the answer (scored like Show me).
        "hint_revealed": {},
        # Per-step drift notes still open (cleared when the step completes) and the permanent
        # per-step record behind the debrief: active time, check-ins, dead ends and drift.
        "drift": {},
        "step_log": {},
        "answer": None,
        "feedback": None,
        "pending_command": None,
        "detected_offset_minutes": detected_offset_minutes,
        "incident_onset_minutes": incident_timing(manifest).get("onset"),
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


def guided_practice_complete(session):
    """Every guided investigation goal before the answer card is complete."""
    goals = playbook_goals(session)
    return (
        session["mode"] == "guided"
        and bool(goals)
        and goals[-1].get("reference_action", {}).get("command") in {"request_answer", "request_diagnosis"}
        and all(goal["id"] in session["completed_goals"] for goal in goals[:-1])
    )


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
        "${detected_offset_minutes}": session.get("detected_offset_minutes", ""),
        **incident_clock(session),
    }
    # Truth answers go first, so a clock token inside one ("${incident.first_clock}") is resolved too.
    replacements = {**{f"${{truth.{key}}}": item for key, item in truth.get("answers", {}).items()}, **replacements}
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
    timing = incident_timing(manifest)
    if "noticed" in timing:
        return int(timing["noticed"])
    definitions = load_incident_briefings()
    profile = definitions.get("scenarios", {}).get(manifest["scenario"]["id"], {})
    values = profile.get("observed_minutes_ago") or [8, 10, 12]
    return stable_briefing_choice(values, {"manifest": manifest}, "observed_minutes_ago")


def clock_text(moment, session):
    """A moment as the learner's clock shows it ("14:03"), as Discover's times do. The coach reports the
    browser's UTC offset when it connects; until it has, the time is given in UTC and says so."""
    offset = session.get("utc_offset_minutes")
    if offset is None:
        return f"{moment:%H:%M} UTC"
    return f"{moment - timedelta(minutes=offset):%H:%M}"


def typed_start(moment, session):
    """A start a learner can type into Kibana's date picker as is ("Nov 7 14:00"); a bare time is not
    accepted there (verified 9.5.2: "14:00 to now" leaves the window unchanged)."""
    local = moment - timedelta(minutes=session.get("utc_offset_minutes") or 0)
    return f"{local:%b} {local.day} {local:%H:%M}"


def ago_text(moment, now=None):
    """How long ago a moment was, as the briefing says it: "12 minutes ago"."""
    minutes = round(((now or datetime.now(timezone.utc)) - moment).total_seconds() / 60)
    if minutes < 1:
        return "just now"
    return "1 minute ago" if minutes == 1 else f"{minutes} minutes ago"


def iso_instant(moment):
    """A UTC moment the way Kibana writes a time range's absolute ends ('2026-11-07T14:00:00.000Z')."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def incident_clock(session):
    """Copy tokens for the incident's moments, worked out when the copy is used.

    Each named moment (``noticed``, and a pack's ``onset``, ``end``, ``rollout``, ``first``) gives
    ``${incident.<name>_clock}`` ("14:03", the learner's local time) and ``${incident.<name>_ago}``
    ("12 minutes ago", as of now), and ``${incident.<name>_at}`` is the instant itself for an evidence
    query. The recommended window starts at ``${incident.window_start}`` (the
    instant the coach sets), read as ``${incident.window_start_clock}`` and typed as
    ``${incident.window_start_typed}``. Because the start is a fixed time, it reaches the incident
    however long the learner takes, where "the last 15 minutes" slid off it.
    """
    moments = incident_moments(session.get("manifest", {}), session.get("detected_offset_minutes"))
    tokens = {}
    for key, moment in moments.items():
        tokens[f"${{incident.{key}_at}}"] = iso_instant(moment)
        tokens[f"${{incident.{key}_clock}}"] = clock_text(moment, session)
        tokens[f"${{incident.{key}_ago}}"] = ago_text(moment)
    start = recommended_window_start(moments)
    if start is not None:
        tokens["${incident.window_start}"] = iso_instant(start)
        tokens["${incident.window_start_clock}"] = clock_text(start, session)
        tokens["${incident.window_start_typed}"] = typed_start(start, session)
    return tokens


def judged_window(session, details, now=None):
    """A window in absolute time: when it starts and the moment it must reach, as instants on the
    service's clock, and their ages now. A start date stays put; a "now-15m" start is counted back
    from ``now``. The evaluator reads the ages; the instants say which moments were compared."""
    now = now or datetime.now(timezone.utc)
    details = dict(details or {})
    start = window_start(details, now)
    end = parse_instant(details.get("to"))
    reference = window_reference(incident_moments(session["manifest"], session.get("detected_offset_minutes")))
    if start is not None:
        details["window_start_at"] = iso_instant(start)
        details["from_minutes"] = round((now - start).total_seconds() / 60, 2)
    if end is not None:
        details["window_end_at"] = iso_instant(end)
    if reference is not None:
        details["incident_reference"] = reference["key"]
        details["incident_reference_at"] = iso_instant(reference["at"])
        details["incident_offset_minutes"] = round((now - reference["at"]).total_seconds() / 60, 2)
    return details


def judge_window(session, action, now=None):
    """Put a window change in absolute time before it is judged, as of when it arrived."""
    action["details"] = judged_window(session, action.get("details"), now)


# How feedback names the moment a window has to reach: as a noun, and as a sentence opening.
WINDOW_MOMENTS = {
    "noticed": ("the report", "The report came in"),
    "rollout": ("the rollout", "The rollout began"),
    "onset": ("the rise in failures", "The failures began rising"),
}
RELATIVE_UNITS = {"s": "second", "m": "minute", "h": "hour", "d": "day", "w": "week", "M": "month", "y": "year"}


def relative_window_name(time_from):
    """A start counted back from now as Kibana's picker names it ("now-15m" is "the last 15 minutes"),
    or None for any other start."""
    match = re.fullmatch(r"now-(\d+)([smhdwMy])(?:/[smhdwMy])?", str(time_from or "").strip())
    if not match:
        return None
    amount, unit = int(match.group(1)), RELATIVE_UNITS[match.group(2)]
    return f"the last {unit}" if amount == 1 else f"the last {amount} {unit}s"


def minutes_text(minutes):
    minutes = round(float(minutes))
    return "1 minute" if minutes == 1 else f"{minutes} minutes"


def window_feedback(session, reason):
    """What a window that misses the incident says, in the learner's own clock time.

    ``headline`` and ``detail`` are the guided coach's card; ``note`` is the challenge debrief's line,
    shown only at the end. Three cases: a scope step's window that doesn't reach the moment
    (``window_misses_incident``; a relative window picked from a briefing read minutes ago, say), a
    later change that leaves it out (``window_excludes_incident``), and a relative window that has
    since moved past it (``window_slid_past_incident``). The latter two put back a fixed start,
    ``restore_time``. On a scope step whose moment is the onset, finding the rise is the lesson, so
    the card doesn't date it.
    """
    code = reason.get("reason_code")
    moment = parse_instant(reason.get("incident_reference_at"))
    start, end = parse_instant(reason.get("window_start_at")), parse_instant(reason.get("window_end_at"))
    if moment is None:
        return {}
    name, opening = WINDOW_MOMENTS.get(reason.get("incident_reference"), ("the incident", "The incident began"))
    clock = clock_text(moment, session)
    dated = "" if code == "window_misses_incident" and reason.get("incident_reference") == "onset" else f" at {clock}"
    relative = relative_window_name(reason.get("from")) if reason.get("relative") else None
    window = f"Your window, {relative}," if relative else "Your window"
    restart = recommended_window_start(incident_moments(session["manifest"], session.get("detected_offset_minutes")))
    feedback = {}
    if code != "window_misses_incident" and restart is not None:
        feedback["restore_time"] = {"from": iso_instant(restart), "to": "now"}
    put_back = f"I'll set the window to start at {clock_text(restart, session)}, before it." if restart is not None else "I'll put the window back."
    if end is not None and end < moment:
        feedback["headline"] = f"Your window ends at {clock_text(end, session)}, before {name}{dated}."
        feedback["detail"] = ("End it at now, or later." if code == "window_misses_incident"
                              else f"{put_back} Or change it yourself — I'll step aside.")
        feedback["note"] = f"Your window ended at {clock_text(end, session)}, before {name} at {clock}."
        return feedback
    started = clock_text(start, session) if start is not None else None
    if code == "window_slid_past_incident":
        fixed = clock_text(restart, session) if restart is not None else None
        feedback["headline"] = f"{window} now starts at {started}, after {name} at {clock}."
        # Kibana re-reads "now" when the search runs, so the screen still shows the last search's window.
        feedback["detail"] = (f"A window counted back from now moves with the clock, so your next search leaves {name} out. "
                              + (f"I'll set a fixed start of {fixed} so it stays put." if fixed else "I'll put the window back.")
                              + " Or change it yourself — I'll step aside.")
        feedback["note"] = (f"{window} moved with the clock and slid past {name} at {clock} while you investigated."
                            + (f" A fixed start, such as {fixed}, would have kept it in view." if fixed else ""))
        return feedback
    feedback["headline"] = f"{window} starts at {started}, after {name}{dated}."
    elapsed = minutes_text(reason["incident_offset_minutes"]) if reason.get("incident_offset_minutes") is not None else None
    # Say time moved on only when it did: the same window would have reached the moment when the
    # learner finished reading the briefing.
    read_at = parse_instant(session.get("briefing_read_at"))
    look_back = reason.get("from_minutes")
    drifted = bool(relative and read_at and look_back is not None
                   and float(look_back) + TIME_WINDOW_TOLERANCE_MINUTES >= (read_at - moment).total_seconds() / 60)
    moved = ": time kept moving while you read" if drifted else ""
    if code == "window_misses_incident":
        if relative and dated and elapsed:
            feedback["detail"] = (f"{opening} {elapsed} ago{moved}. "
                                  f"Choose a longer window, or type a start before {clock} so it stays put.")
        elif dated:
            feedback["detail"] = f"Start it before {clock}."
        else:
            feedback["detail"] = "Find where the histogram rises, and start the window before it."
        if relative and elapsed:
            feedback["note"] = (f"{window} started at {started} when you chose it, after {name} at {clock}, {elapsed} earlier by then{moved}. "
                                f"A longer window, or a fixed start before {clock}, would have reached it.")
        else:
            feedback["note"] = f"Your window started at {started}, after {name} at {clock}. A start before {clock} would have reached it."
        return feedback
    feedback["detail"] = f"{put_back} Or widen it yourself — I'll step aside."
    feedback["note"] = f"You changed the window to start at {started}, after {name} at {clock}, so the evidence was out of view."
    return feedback


def practice_remaining(session):
    """Whether any investigation step (not the answer) is still open, so the view still matters."""
    return any(goal["id"] not in session["completed_goals"]
               and goal.get("reference_action", {}).get("command") not in {"request_diagnosis", "request_answer"}
               for goal in playbook_goals(session))


def slid_window(session, now=None):
    """The learner's relative window, judged now, once it no longer reaches the incident: it moved with
    the clock after it was set. Reported once per window (``slid_window``)."""
    view = session.get("view") or {}
    time_from = view.get("time_from")
    if not str(time_from or "").strip().lower().startswith("now"):
        return None
    if session.get("slid_window") == time_from:
        return None
    details = judged_window(session, {"from": time_from, "to": view.get("time_to")}, now)
    if window_reaches_incident(details) is not False:
        return None
    return window_miss("window_slid_past_incident", {"details": details}, "The window has moved past the incident.")


def window_watch(session, action):
    """When a guided learner's relative window will slide past the incident, so the coach can say so
    then rather than at their next action. None for a fixed start, or once the view no longer matters."""
    if session["mode"] != "guided" or action.get("type") != "time_range_changed" or not relative_window(action):
        return None
    details = action.get("details") or {}
    moment, look_back = parse_instant(details.get("incident_reference_at")), details.get("from_minutes")
    if moment is None or look_back is None or window_reaches_incident(details) is not True:
        return None
    if not scope_complete(session) or not practice_remaining(session):
        return None
    return {"from": details.get("from"), "slides_at": iso_instant(moment + timedelta(minutes=float(look_back) + TIME_WINDOW_TOLERANCE_MINUTES))}


def window_check_reply(session):
    """The coach's watch on a relative window went off: if it has slid past the incident, record the dead
    end and say what happened (the coach puts back a fixed start)."""
    if session["mode"] != "guided" or not scope_complete(session) or not practice_remaining(session):
        return None
    slid = slid_window(session)
    if not slid:
        return None
    session["slid_window"] = slid["from"]
    goal = current_goal(session)
    evaluation = {"outcome": "dead_end", "goals_progressed": [], "meaningful": False, "step_id": goal["id"] if goal else None,
                  **slid, **window_feedback(session, slid)}
    log_dead_end(session, evaluation)
    return {"message_type": "window_slid", "evaluation": evaluation}


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
    # The briefing states each moment as a clock time beside how long ago it was, so the report stays
    # true however long it is read (the coach formats both in the learner's own time).
    moments = incident_moments(session["manifest"], observed_minutes_ago)
    timed_facts = [{"text": fact["text"], "at": iso_instant(moments[fact["at"]])}
                   for fact in profile.pop("timed_facts", []) if fact.get("at") in moments]
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
        "noticed_at": iso_instant(moments["noticed"]) if "noticed" in moments else None,
        "timed_facts": timed_facts,
        "source": source,
        "graphic": "/incident-coach/assets/assets/incident-signal.webp",
        **profile,
    }


def opening_time(session):
    """The window the scenario's starting view opens on (``_g=(time:...)`` in its path), or None."""
    starting_path = session["manifest"]["scenario"].get("starting_view", {}).get("path", "")
    opening = re.search(r"time:\(from:([^,)]+),to:([^,)]+)\)", starting_path)
    return {"from": opening.group(1).strip("'"), "to": opening.group(2).strip("'")} if opening else None


def track_view(session, action):
    """The search on the learner's screen after this action: time range, query and its language,
    and filter pills. The coach reports it with each action (read from Kibana's URL state, so a
    restore or a reload is covered too); without that report the service carries the last view
    forward. Either way the action's own facts win — the window it set, the query it ran, the
    pills it read — since the URL can lag the action by a moment."""
    opening = opening_time(session) or {}
    previous = session.get("view") or {"time_from": opening.get("from"), "time_to": opening.get("to"), "language": "kql", "query": "", "filters": []}
    reported = action.get("view") if isinstance(action.get("view"), dict) else {}
    view = {**previous, **{key: reported[key] for key in ("time_from", "time_to", "language", "query", "filters") if key in reported}}
    details, after = action.get("details") or {}, action.get("state_after") or {}
    kind = action.get("type")
    if kind == "time_range_changed":
        view["time_from"] = details.get("from") or after.get("time_from") or view.get("time_from")
        view["time_to"] = details.get("to") or after.get("time_to") or view.get("time_to")
    language = after.get("query_language") or (details.get("language") if kind in {"query_submitted", "esql_submitted", "query_language_changed"} else None)
    if language:
        view["language"] = "esql" if str(language).casefold() == "esql" else "kql"
    if kind in {"query_submitted", "esql_submitted"}:
        view["query"] = details.get("query", after.get("query", view.get("query", "")))
    if isinstance(after.get("filters"), list):
        view["filters"] = after["filters"]
    elif kind == "filter_added" and details.get("field") and not reported.get("filters"):
        view["filters"] = [*(view.get("filters") or []), details]
    session["view"] = view
    return view


def restore_state(session):
    """The search state the investigation should hold before the current step.

    Replays the reference action of every completed goal that shapes the result set (time window,
    filter pills, query) on top of the scenario's opening window. The guided coach applies it when
    the learner's own input leaves Discover with no results, so they are put back on the path they
    had already earned instead of being stranded in an empty view.
    """
    state = {
        "baseline_time": opening_time(session),
        "time": None,
        "filters": [],
        "query": None,
    }
    for goal in playbook_goals(session):
        if goal["id"] not in session["completed_goals"]:
            continue
        reference = goal.get("reference_action", {})
        command = reference.get("command")
        value = substitute(reference.get("arguments"), session)
        if command == "set_time_range" and isinstance(value, dict):
            state["time"] = {"from": value.get("from"), "to": value.get("to", "now")}
        elif command == "add_filter" and isinstance(value, dict) and value.get("field"):
            operator = str(value.get("operator", "is"))
            state["filters"].append({
                "field": value["field"],
                "value": value.get("value"),
                "negate": operator.lower() in {"is not", "not"} or bool(value.get("negate")),
            })
        elif command in {"enter_kql", "enter_query"}:
            state["query"] = value.get("query", "") if isinstance(value, dict) else str(value or "")
    return state


def next_command(session):
    if not session["run_ready"] or session["paused"]:
        return None
    index = current_step_index(session)
    goals = playbook_goals(session)
    if session["mode"] == "challenge" and index < len(goals):
        # A challenge is the learner's own investigation: the answer form is open from the start, and
        # nothing the coach sends reveals the reference route's steps or which of them are done.
        index = next((position for position, goal in enumerate(goals)
                      if goal.get("reference_action", {}).get("command") in {"request_diagnosis", "request_answer"}), index)
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
        # What the demonstration's "What this shows" beat rings on the page once the action is done
        # (a Top values row, document fields...). Absent, the coach derives it from the command type.
        "evidence_focus": substitute(explanation.get("evidence_focus"), session) if session["mode"] == "demonstration" else None,
        # What the opening goal card rings before the action, when the step starts by reading the
        # page (e.g. where the histogram rises) rather than from a fact in the brief.
        "goal_focus": substitute(explanation.get("goal_focus"), session) if session["mode"] == "demonstration" else None,
        "concept": explanation_text("concept") if session["mode"] == "demonstration" else "",
        "answer_schema": session["manifest"]["scenario"].get("answer_schema", {}),
    }
    if session["mode"] == "guided" and command_type not in {"request_diagnosis", "request_answer"}:
        # "Show me" performs this step immediately, then explains its scenario-specific reasoning
        # and result (e.g. why the range reaches back N minutes).
        walkthrough = step.get("demonstration", {})
        command["walkthrough"] = {
            field: substitute(walkthrough.get(field, step.get(field, "")), session)
            for field in ("narration", "reasoning", "evidence", "learning_focus", "evidence_focus")
        }
    if session["mode"] == "guided":
        command["restore_state"] = restore_state(session)
        if command_type not in {"request_diagnosis", "request_answer"}:
            command["pace_seconds"] = pace_seconds(step)
    session["pending_command"] = command
    return command


def next_hint(session):
    """The current step's next hint, one level deeper each time. A hint that names the step's answer
    (the bottom-out level usually does) is recorded, so the step scores like Show me."""
    if not session["policy"].get("allow_hints", True):
        return {"message_type": "hint", "step_id": None, "level": 0, "text": "Hints are off in challenge mode. The debrief shows the reference route afterwards."}
    index = current_step_index(session)
    goals = playbook_goals(session)
    if index >= len(goals):
        return None
    step = goals[index]
    hints = step.get("hints", [])
    if not hints:
        return {"message_type": "hint", "step_id": step["id"], "level": 0, "text": "No additional hint is available for this goal."}
    level = min(session["hint_level"].get(step["id"], 0), len(hints) - 1)
    session["hint_level"][step["id"]] = level + 1
    session["assistance"]["hints"] += 1
    text = substitute(hints[level], session)
    truth = substitute(session["manifest"]["scenario"].get("truth", {}), session)
    arguments = substitute(step.get("reference_action", {}).get("arguments"), session)
    phrases = answer_phrases(truth, arguments)
    # A window's answer is its start time, which hint copy reads as a clock time.
    start = parse_instant(arguments.get("from")) if isinstance(arguments, dict) else None
    if start is not None:
        phrases += [clock_text(start, session), typed_start(start, session)]
    if reveals_answer(text, phrases):
        session["hint_revealed"][step["id"]] = True
    return {"message_type": "hint", "step_id": step["id"], "level": level + 1, "text": text}


def learner_evaluation(session, evaluation):
    """The evaluation as the coach may show it. A challenge is scored in its debrief, so mid-run the
    coach learns only that an action was recorded — not which step it completed or missed."""
    if session["policy"]["validate_timing"] != "debrief":
        return evaluation
    return {"outcome": "recorded", "goals_progressed": [], "meaningful": False}


def learner_session(session):
    """session_public for replies to the learner's own actions, without a challenge's progress."""
    public = session_public(session)
    if session["policy"]["validate_timing"] == "debrief":
        for key in ("completed_goals", "step", "step_count"):
            public.pop(key, None)
    return public


def refresh_run_ready(session):
    status, run = http_json(f"{CONTROLLER_URL}/api/runs/{session['run_id']}")
    state = run.get("state")
    session["run_ready"] = status == 200 and (
        state in {"READY", "INVESTIGATING"} or (state == "COMPLETED" and bool(session["feedback"]))
    )
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


def hit_total(result):
    total = (result or {}).get("hits", {}).get("total", 0)
    return total.get("value", 0) if isinstance(total, dict) else total


# ES|QL the service runs for the learner must read this run's lab data, nothing else.
ESQL_SOURCE = re.compile(r"^\s*FROM\s+([^|]+?)(?:\s+METADATA\b[^|]*)?\s*(?:\||$)", re.IGNORECASE)


def esql_result(session, query, view):
    """The table an ES|QL query shows the learner: its rows, run over the view's time range. A query
    Elasticsearch rejects shows the learner an error, not a table, so it comes back empty. None —
    unknown — when the query reads anything but lab data or Elasticsearch can't be reached."""
    match = ESQL_SOURCE.match(str(query or ""))
    sources = [item.strip().strip('"') for item in match.group(1).split(",")] if match else []
    if not sources or not all(source.startswith("lab-") for source in sources):
        return None
    payload = {"query": query}
    bounds = {key: value for key, value in (("gte", (view or {}).get("time_from")), ("lte", (view or {}).get("time_to"))) if value}
    if bounds:
        payload["filter"] = {"range": {"@timestamp": bounds}}
    try:
        status, result = http_json(f"{ELASTICSEARCH_URL}/_query", "POST", payload, timeout=15)
    except (OSError, ValueError):
        return None
    if status >= 400:
        return {"columns": [], "values": [], "rejected": True}
    if not isinstance(result.get("values"), list):
        return None
    return {"columns": [column.get("name") for column in result.get("columns", [])], "values": result["values"][:1000]}


def action_evidence(session, action):
    """What the evidence assertions say for this action. In guided practice and challenges a count
    assertion is checked inside the learner's own view (window, query, pills) when that view is known
    and translatable — the evidence has to be on their screen, not merely somewhere in the run — and
    against the whole run otherwise. An ES|QL search also returns the result table it showed."""
    evidence = {"assertions": {}, "trace_services": 0, "view_scoped": False}
    details = action.get("details") or {}
    trace_id = details.get("trace_id") or (action.get("state_after") or {}).get("trace_id")
    view = session.get("view")
    # A demonstration is the coach performing the reference route, which it is trusted to do, and so
    # is a guided "Show me" (refusing it would leave the learner with no coach on screen); the
    # learner's view only matters where the learner's own work is judged.
    learner_judged = session["mode"] != "demonstration"
    scope = view_query(view) if view and learner_judged and action.get("actor") != "tutorial" else None
    if action.get("type") == "esql_submitted" and learner_judged:
        evidence["esql_result"] = esql_result(session, details.get("query") or (view or {}).get("query"), view)
    for assertion in session["manifest"]["scenario"].get("truth", {}).get("assertions", []):
        kind = assertion.get("kind")
        index = substitute(assertion.get("index", f"lab-{session['run_id']}"), session)
        if kind in {"es_count", "es_cardinality"}:
            assertion_query = substitute(assertion.get("query", {"match_all": {}}), session)
            query = {"size": 0, "query": assertion_query}
            if kind == "es_cardinality":
                query["aggs"] = {"value": {"cardinality": {"field": assertion["field"]}}}
                value = elastic_search(query, index).get("aggregations", {}).get("value", {}).get("value", 0)
            else:
                value = None
                # A pack's minimum says how much the whole run holds. A learner's window can rightly
                # hold less (the last 5 minutes of a 10-minute incident), so inside a view the question
                # is only whether the evidence is on their screen at all.
                minimum = assertion.get("minimum", 1)
                if scope is not None:
                    status, result = http_json(f"{ELASTICSEARCH_URL}/{index}/_search?allow_no_indices=true", "POST",
                                               {"size": 0, "query": {"bool": {"filter": [assertion_query, scope]}}})
                    if status < 400:
                        value, evidence["view_scoped"], minimum = hit_total(result), True, 1
                if value is None:
                    value = hit_total(elastic_search(query, index))
                evidence["assertions"][assertion["id"]] = value >= minimum
                continue
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


def step_log(session, step_id):
    return session.setdefault("step_log", {}).setdefault(step_id, {"seconds_active": None, "check_ins": [], "dead_ends": [], "drift": []})


def record_step_clock(session, clock):
    """Keep the browser's active-time reading for a step (it only grows while the step is open)."""
    if not isinstance(clock, dict) or not clock.get("step_id"):
        return
    try:
        seconds = round(float(clock.get("seconds_active")), 1)
    except (TypeError, ValueError):
        return
    log = step_log(session, clock["step_id"])
    log["seconds_active"] = max(seconds, log["seconds_active"] or 0)


def record_drift(session, step_id, note):
    """Note a drift for the step, de-duplicated, in both the open log and the step's record."""
    if not note:
        return
    for notes in (session.setdefault("drift", {}).setdefault(step_id, []), step_log(session, step_id)["drift"]):
        if note in notes:
            notes.remove(note)
        notes.append(note)  # most recent last


def record_check_in_answer(session, details):
    check_ins = step_log(session, details.get("step_id", ""))["check_ins"]
    if check_ins and check_ins[-1].get("choice") is None:
        check_ins[-1]["choice"] = details.get("choice")


def log_dead_end(session, evaluation):
    """Keep a dead end in its step's record, with the explanation a challenge debrief shows."""
    entry = {"reason_code": evaluation["reason_code"], "at": now_iso()}
    if evaluation.get("note"):
        entry["note"] = evaluation["note"]
    step_log(session, evaluation["step_id"])["dead_ends"].append(entry)


def record_recovery(session, message):
    """The coach showed a recovery card. Annotate the dead end the service already recorded with the
    browser's diagnosis (e.g. missing_colon), or record one the browser found on its own."""
    step_id = message.get("step_id")
    if not step_id:
        return
    dead_ends = step_log(session, step_id)["dead_ends"]
    reason_code = message.get("reason_code") or "empty_result"
    diagnosis = message.get("diagnosis")
    entry = next((item for item in reversed(dead_ends) if item["reason_code"] == reason_code and not item.get("shown")), None)
    if entry is None:
        entry = {"reason_code": reason_code, "at": now_iso()}
        dead_ends.append(entry)
    entry["shown"] = True
    if diagnosis:
        entry["diagnosis"] = diagnosis


def check_in_reply(session, step_id):
    """The gentle check-in for the learner's current step, or None if they have moved on."""
    goal = current_goal(session)
    if not goal or goal["id"] != step_id or session["mode"] != "guided":
        return None
    step_log(session, step_id)["check_ins"].append({"at": now_iso(), "choice": None})
    return {
        "message_type": "check_in",
        "step_id": step_id,
        "step_title": goal.get("title", step_id),
        "drift": list(session.get("drift", {}).get(step_id, [])),
    }


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
    record_step_clock(session, action.get("step_clock"))
    if action.get("type") == "time_range_changed":
        judge_window(session, action)
        session.pop("slid_window", None)
    if action.get("type") == "check_in_answered":
        record_check_in_answer(session, action.get("details") or {})
    if action.get("type") not in IGNORED_ACTIONS:
        track_view(session, action)
    evidence = action_evidence(session, action)
    earned = restore_state(session) if session["mode"] in {"guided", "challenge"} else None
    evaluation = evaluate_action(session, action, evidence, earned_state=earned)
    # An action that found nothing while a relative window had moved past the incident: say why.
    if (evaluation["outcome"] == "observed" and action.get("actor") != "tutorial"
            and action.get("type") not in IGNORED_ACTIONS | {"time_range_changed"}
            and scope_complete(session) and practice_remaining(session)):
        slid = slid_window(session)
        if slid:
            session["slid_window"] = slid["from"]
            goal = current_goal(session)
            evaluation = {"outcome": "dead_end", "goals_progressed": [], "meaningful": False, "step_id": goal["id"] if goal else None, **slid}
    if str(evaluation.get("reason_code") or "").startswith("window_"):
        evaluation.update(window_feedback(session, evaluation))
    if evaluation["outcome"] == "dead_end" and evaluation.get("step_id"):
        log_dead_end(session, evaluation)
    elif evaluation["outcome"] == "drift":
        record_drift(session, evaluation["step_id"], evaluation["note"])
    for goal_id in evaluation["goals_progressed"]:
        session.setdefault("drift", {}).pop(goal_id, None)
    # The command on screen is spent once its own step completes. A challenge's answer form stays
    # put while the investigation behind it progresses, so a reconnect doesn't reset it.
    if (session["pending_command"] or {}).get("step_id") in evaluation["goals_progressed"]:
        session["pending_command"] = None
    session["actions"].append({"action": action, "evaluation": evaluation})
    emit(session, action, evaluation, evidence)
    if guided_practice_complete(session) and not session["feedback"]:
        # The answer goal is a terminal marker in guided practice. Close it without recording an
        # answer that the learner never submitted.
        session["completed_goals"].add(playbook_goals(session)[-1]["id"])
        session["pending_command"] = None
        session["feedback"] = guided_feedback(session)
        transition_run(session, "COMPLETED")
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
                    self.respond(409, {"error": "feedback is not available yet"})
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
                    self.respond(202, {"evaluation": learner_evaluation(session, evaluation), "session": learner_session(session)})
                    return
                if action == "answer":
                    if not session["run_ready"] and not refresh_run_ready(session):
                        self.respond(409, {"error": "run evidence is not ready"})
                        return
                    if session["mode"] == "guided":
                        if session["feedback"]:
                            self.respond(200, session["feedback"])
                        else:
                            self.respond(409, {"error": "finish the guided investigation steps first"})
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
        # The browser's UTC offset (minutes, as getTimezoneOffset gives it), so clock times in the coach's
        # copy read as Discover shows them.
        try:
            offset = int((query.get("utc_offset") or [""])[0])
            if -840 <= offset <= 840:
                session["utc_offset_minutes"] = offset
        except ValueError:
            pass
        if not wait_run_ready(session):
            send_frame(connection, json.dumps({"message_type": "failed", "error": "run evidence did not become ready"}))
            return
        if session["briefing_acknowledged"]:
            if not session["feedback"]:
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
                    reply = {"message_type": "action_result", "evaluation": learner_evaluation(session, evaluation), "session": learner_session(session),
                             "action": {"type": message["action"].get("type"), "sequence": message["action"].get("sequence")}}
                    if message["action"].get("type") == "time_range_changed":
                        reply["window_watch"] = window_watch(session, message["action"])
                    send_frame(connection, json.dumps(reply))
                    # A challenge's answer form is already open; re-sending it would reset what the learner typed.
                    if evaluation["goals_progressed"] and not session["paused"] and session["mode"] != "challenge":
                        command = next_command(session)
                        if command:
                            send_frame(connection, json.dumps(command))
                        elif session["mode"] == "guided" and session["feedback"]:
                            send_frame(connection, json.dumps({"message_type": "complete", "session_id": session_id}))
                elif message_type == "check_in":
                    reply = check_in_reply(session, message.get("step_id"))
                    if reply:
                        send_frame(connection, json.dumps(reply))
                elif message_type == "recovery_shown":
                    record_recovery(session, message)
                elif message_type == "window_check":
                    reply = window_check_reply(session)
                    if reply:
                        send_frame(connection, json.dumps(reply))
                elif message_type == "ack":
                    send_frame(connection, json.dumps({"message_type": "acknowledged", "command_id": message.get("command_id")}))
                elif message_type == "briefing_ack":
                    if session["briefing_acknowledged"]:
                        continue
                    session["briefing_acknowledged"] = True
                    # When the learner finished reading it: a window that reached the moment then, but
                    # not when it was set, missed it because time kept moving.
                    session["briefing_read_at"] = now_iso()
                    transition_run(session, "INVESTIGATING")
                    command = next_command(session)
                    send_frame(connection, json.dumps(command or {"message_type": "complete", "session_id": session_id}))
                elif message_type == "hint":
                    hint = next_hint(session)
                    if hint:
                        send_frame(connection, json.dumps(hint))
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
