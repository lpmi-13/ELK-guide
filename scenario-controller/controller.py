"""Catalog-driven lifecycle controller for isolated Kibana learning scenarios."""

from __future__ import annotations

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
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

PORT = int(os.getenv("PORT", "8092"))
ELASTICSEARCH_URL = os.getenv("ELASTICSEARCH_URL", "http://elasticsearch:9200").rstrip("/")
KIBANA_URL = os.getenv("KIBANA_URL", "http://kibana:5601").rstrip("/")
PUBLIC_KIBANA_URL = os.getenv("PUBLIC_KIBANA_URL", "http://localhost:5601").rstrip("/")
SCENARIO_NAME = os.getenv("SCENARIO", "slow-payments")
SCENARIO_SEED = os.getenv("SCENARIO_SEED", "")
AUTO_START = os.getenv("SCENARIO_AUTO_START", "true").lower() in {"1", "true", "yes"}
LEARNING_DIR = Path(os.getenv("LEARNING_DIR", "/app/learning"))
LEGACY_SCENARIO_DIR = Path(os.getenv("SCENARIO_DIR", "/app/scenarios"))
MANIFEST_DIR = Path(os.getenv("MANIFEST_DIR", "/tmp/scenario-manifests"))
SAVED_OBJECTS_FILE = Path(os.getenv("KIBANA_SAVED_OBJECTS", "/app/kibana/saved-objects.ndjson"))
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
runs = {}
current_run_id = None
SCENARIO_KEY_MIN_LENGTH = 10
SCENARIO_KEY_MAX_LENGTH = 40
SCENARIO_KEY_UNSET = object()
PROHIBITED_LEARNER_TARGETS = {"shell", "terminal", "dev_tools", "elasticsearch_admin", "external_application"}


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


def http_json(url, method="GET", payload=None, timeout=10, headers=None):
    body = json.dumps(payload).encode() if payload is not None else None
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    request = Request(url, data=body, method=method, headers=request_headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            data = response.read()
            return response.status, json.loads(data) if data else {}
    except HTTPError as error:
        data = error.read()
        try:
            detail = json.loads(data) if data else {"error": str(error)}
        except json.JSONDecodeError:
            detail = {"error": data.decode(errors="replace") or str(error)}
        return error.code, detail


def kibana_json(path, method="GET", payload=None, timeout=20):
    return http_json(f"{KIBANA_URL}{path}", method, payload, timeout, {"kbn-xsrf": "kibana-scenario-controller"})


def load_catalog():
    path = LEARNING_DIR / "catalog.json"
    if not path.is_file():
        return {"schema_version": 2, "scenarios": []}
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def catalog_entry(identifier):
    return next((item for item in load_catalog().get("scenarios", []) if item["id"] == identifier), None)


def load_template(name):
    selected = name
    catalog = load_catalog().get("scenarios", [])
    if name == "random":
        available = [item for item in catalog if item.get("classification") == "core" and scenario_availability(item)["available"]]
        if not available:
            raise ValueError("no enabled core scenarios are available")
        selected = random.SystemRandom().choice(available)["id"]
    pack_path = LEARNING_DIR / "scenarios" / selected / "scenario.json"
    path = pack_path if pack_path.is_file() else LEGACY_SCENARIO_DIR / f"{selected}.json"
    if not path.is_file():
        raise ValueError(f"unknown scenario: {name}")
    with path.open(encoding="utf-8") as stream:
        template = json.load(stream)
    if template.get("schema_version") == 2:
        required = {"id", "title", "type", "brief", "required_capabilities", "provisioning", "starting_view", "truth", "answer_schema", "playbook", "rubric"}
    else:
        required = {"id", "version", "fault", "traffic", "readiness", "truth", "playbook", "rubric"}
    missing = sorted(required - template.keys())
    if missing:
        raise ValueError(f"scenario is missing: {', '.join(missing)}")
    _validate_learner_scope(template)
    return template


def _validate_learner_scope(template):
    serialized = json.dumps(template).casefold()
    for target in PROHIBITED_LEARNER_TARGETS:
        if f'"target":"{target}"' in serialized.replace(" ", ""):
            raise ValueError(f"learner workflow targets prohibited surface: {target}")


def scenario_key_seed(value):
    if not isinstance(value, str) or not SCENARIO_KEY_MIN_LENGTH <= len(value) <= SCENARIO_KEY_MAX_LENGTH:
        raise ValueError("scenario key must be a string between 10 and 40 characters")
    digest = hashlib.sha256(f"scenario-key:v1:{value}".encode()).digest()
    return int.from_bytes(digest[:8], "big") & ((1 << 63) - 1), value


def normalize_seed(value=None):
    selected = value
    if selected is None or selected == "":
        selected = SCENARIO_SEED or secrets.randbits(63)
    if isinstance(selected, bool):
        raise ValueError("seed must be a non-negative integer or a 10-40 character scenario key")
    if isinstance(selected, int):
        seed, scenario_key = selected, None
    elif isinstance(selected, float) and selected.is_integer():
        seed, scenario_key = int(selected), None
    else:
        candidate = str(selected).strip()
        if candidate.isdecimal():
            seed, scenario_key = int(candidate), None
        else:
            return scenario_key_seed(candidate)
    if seed < 0:
        raise ValueError("seed must be a non-negative integer")
    return seed, scenario_key


def _legacy_to_v2(scenario):
    fault, readiness, truth = scenario["fault"], scenario["readiness"], scenario["truth"]
    scenario.update({
        "schema_version": 2,
        "type": "investigation",
        "classification": "legacy",
        "difficulty": 1,
        "estimated_minutes": 12,
        "skills": ["discover", "kql", "trace-correlation"],
        "required_capabilities": ["discover", "spaces"],
        "provisioning": {
            "strategies": ["live-traffic", "saved-objects"],
            "live_traffic": {"fault": fault, "traffic": scenario["traffic"]},
            "readiness_validators": [{
                "id": "affected-traces", "kind": "es_cardinality", "index": "microservices-*", "field": "trace.id.keyword",
                "minimum": readiness["minimum_affected_traces"], "timeout_seconds": readiness["timeout_seconds"],
                "query": {"bool": {"filter": [
                    {"match_phrase": {"scenario.id": "${run_id}"}}, {"match_phrase": {"service.name": readiness["expected_service"]}},
                    {"match_phrase": {"event.type": "transaction"}}, {"range": {"event.duration": {"gte": readiness["minimum_duration_ms"] * 1_000_000}}},
                ]}},
            }],
        },
        "starting_view": {"app": "discover", "saved_object": "incident-investigation", "path": "/app/discover#/view/incident-investigation"},
        "truth": {
            "answers": {"service": truth["root_cause_service"], "fault_type": truth["fault_type"], "affected_route": truth["affected_route"]},
            "assertions": [
                {"id": "slow_events", "kind": "es_count", "minimum": 1, "index": "microservices-*", "query": {"bool": {"filter": [{"match_phrase": {"scenario.id": "${run_id}"}}, {"range": {"event.duration": {"gte": 2_000_000_000}}}]}}},
                {"id": "service_events", "kind": "es_count", "minimum": 1, "index": "microservices-*", "query": {"bool": {"filter": [{"match_phrase": {"scenario.id": "${run_id}"}}, {"match_phrase": {"service.name": truth["root_cause_service"]}}, {"range": {"event.duration": {"gte": readiness["minimum_duration_ms"] * 1_000_000}}}]}}},
                {"id": "representative_trace", "kind": "trace_from_action", "minimum": 3, "index": "microservices-*"},
            ],
        },
        "answer_schema": {"type": "diagnosis", "fields": [
            {"id": "service", "label": "Affected service", "kind": "string", "weight": 2, "answer_from_truth": "answers.service"},
            {"id": "fault_type", "label": "Failure type", "kind": "string", "weight": 1, "answer_from_truth": "answers.fault_type"},
            {"id": "affected_route", "label": "Affected route", "kind": "string", "weight": 1, "answer_from_truth": "answers.affected_route"},
            {"id": "trace_id", "label": "Trace ID", "kind": "string", "scored": False},
            {"id": "evidence", "label": "Evidence", "kind": "text", "scored": False},
        ]},
        "cleanup": {"delete_space": True, "delete_run_data": True, "managed_resources": []},
    })
    # Keep the legacy fault alias for callers that materialize a v1 template
    # directly. Runtime provisioning uses the normalized v2 copy above.
    for obsolete in ("traffic", "readiness"):
        scenario.pop(obsolete, None)
    return scenario


def materialize(template, seed, run_id=None, scenario_key=None):
    canonical = json.dumps(template, sort_keys=True, separators=(",", ":")).encode()
    generator = random.Random(seed)
    scenario = copy.deepcopy(template)
    if scenario.get("schema_version") == 1:
        base_delay = scenario["fault"]["delay_ms"]
        scenario["fault"]["delay_ms"] = generator.choice(sorted({max(3000, base_delay - 300), base_delay, base_delay + 300}))
        scenario["fault"]["probability"] = generator.choice([0.85, 0.9, 0.95])
        scenario["readiness"]["minimum_duration_ms"] = min(scenario["readiness"]["minimum_duration_ms"], scenario["fault"]["delay_ms"] - 100)
        scenario = _legacy_to_v2(scenario)
    identifier = run_id or f"run-{uuid.uuid4().hex[:12]}"
    space_id = f"lab-{identifier.removeprefix('run-')}"
    manifest = {
        "schema_version": 2,
        "run_id": identifier,
        "space_id": space_id,
        "template_id": template["id"],
        "template_version": template.get("version", 1),
        "template_hash": hashlib.sha256(canonical).hexdigest(),
        "seed": seed,
        "generator_version": 2,
        "created_at": now_iso(),
        "scenario": scenario,
        "playbook": f"{scenario['id']}/{scenario['playbook']}" if "/" not in scenario["playbook"] else scenario["playbook"],
        "rubric": f"{scenario['id']}/{scenario['rubric']}" if "/" not in scenario["rubric"] else scenario["rubric"],
    }
    answers = scenario.get("truth", {}).get("answers", {})
    manifest["expected"] = {
        "service": answers.get("service", ""), "fault_type": answers.get("fault_type", ""), "route": answers.get("affected_route", ""),
        "minimum_duration_ns": int(answers.get("minimum_duration_ns", 0)), "evidence": [item.get("id") for item in scenario.get("truth", {}).get("assertions", [])],
    }
    if scenario_key:
        manifest["scenario_key"] = scenario_key
    return manifest


def _substitute(value, manifest):
    truth = manifest["scenario"].get("truth", {})
    replacements = {"${run_id}": manifest["run_id"], "${space_id}": manifest["space_id"], "${scenario_id}": manifest["template_id"]}
    for key, item in truth.get("answers", {}).items():
        replacements[f"${{truth.{key}}}"] = item
    if isinstance(value, str):
        for source, replacement in replacements.items():
            value = value.replace(source, str(replacement))
        return value
    if isinstance(value, dict):
        return {key: _substitute(item, manifest) for key, item in value.items()}
    if isinstance(value, list):
        return [_substitute(item, manifest) for item in value]
    return value


def starting_url(manifest):
    path = manifest["scenario"]["starting_view"].get("path") or f"/app/{manifest['scenario']['starting_view']['app']}"
    path = _substitute(path, manifest)
    if manifest["scenario"]["starting_view"].get("app") == "apm" and "environment=" not in path:
        separator = "&" if "?" in path else "?"
        path = f"{path}{separator}environment={quote(manifest['run_id'], safe='')}&rangeFrom=now-1h&rangeTo=now"
    return f"{PUBLIC_KIBANA_URL}/s/{manifest['space_id']}{path}"


def public_state(run, include_manifest=False):
    if not run:
        return {"state": "CREATED", "run_id": None}
    manifest = run["manifest"]
    response = {
        "run_id": manifest["run_id"], "space_id": manifest["space_id"], "state": run["state"], "seed": manifest["seed"],
        "scenario_key": manifest.get("scenario_key"), "template_id": manifest["template_id"], "title": manifest["scenario"]["title"],
        "brief": manifest["scenario"]["brief"], "scenario_type": manifest["scenario"]["type"], "created_at": manifest["created_at"],
        "ready_at": run.get("ready_at"), "completed_at": run.get("completed_at"), "evidence": run.get("evidence", {}),
        "error": run.get("error"), "investigation_url": starting_url(manifest),
    }
    if include_manifest:
        response["manifest"] = manifest
    return response


def get_run(run_id):
    with state_lock:
        return runs.get(run_id)


def update_run(run_id, **updates):
    with state_lock:
        run = runs.get(run_id)
        if run:
            run.update(updates)
            return True
    return False


def load_compatibility():
    path = LEARNING_DIR / "compatibility" / "kibana-9.5.2.json"
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"kibana_version": "9.5.2", "capabilities": {"discover": {"supported": True}, "spaces": {"supported": True}}}


def probe_capabilities():
    baseline = load_compatibility()
    result = {key: bool(value.get("supported", value)) for key, value in baseline.get("capabilities", {}).items()}
    status, _body = kibana_json("/api/status", timeout=5)
    if status >= 400:
        return {key: False for key in result}
    probes = {
        "spaces": "/api/spaces/space",
        "alerting": "/api/alerting/rule_types",
    }
    for capability, path in probes.items():
        probe_status, _ = kibana_json(path, timeout=8)
        result[capability] = probe_status < 400
    return result


def scenario_availability(entry, capabilities=None):
    capabilities = capabilities or probe_capabilities()
    missing = [item for item in entry.get("required_capabilities", []) if not capabilities.get(item, False)]
    return {"available": not missing, "reason": "" if not missing else "Unavailable capabilities: " + ", ".join(missing), "missing_capabilities": missing}


def catalog_public():
    capabilities = probe_capabilities()
    entries = []
    for item in load_catalog().get("scenarios", []):
        availability = scenario_availability(item, capabilities)
        entries.append({**item, **availability})
    return {"schema_version": 2, "kibana_version": "9.5.2", "capabilities": capabilities, "scenarios": entries}


def create_space(manifest):
    space_id = manifest["space_id"]
    status, response = kibana_json("/api/spaces/space", "POST", {
        "id": space_id, "name": f"Lab {manifest['template_id']} {manifest['run_id'][-6:]}",
        "description": "Controller-managed, isolated learner space", "initials": "LB", "disabledFeatures": [], "solution": "classic",
    })
    if status not in {200, 409}:
        raise RuntimeError(f"space creation failed ({status}): {response}")


def import_saved_objects(manifest):
    if not SAVED_OBJECTS_FILE.is_file():
        return
    boundary = f"scenario-{uuid.uuid4().hex}"
    content = SAVED_OBJECTS_FILE.read_bytes()
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"saved-objects.ndjson\"\r\n"
        "Content-Type: application/ndjson\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    path = f"/s/{manifest['space_id']}/api/saved_objects/_import?overwrite=true"
    request = Request(f"{KIBANA_URL}{path}", data=body, method="POST", headers={"kbn-xsrf": "scenario-controller", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urlopen(request, timeout=30) as response:
            result = json.loads(response.read() or b"{}")
    except HTTPError as error:
        raise RuntimeError(f"saved-object import failed ({error.code}): {error.read().decode(errors='replace')}") from error
    if not result.get("success", False):
        raise RuntimeError(f"saved-object import failed: {result.get('errors', result)}")
    imported_data_view = next((item for item in result.get("successResults", []) if item.get("type") == "index-pattern"), {})
    data_view_id = imported_data_view.get("destinationId") or imported_data_view.get("id")
    if not data_view_id:
        raise RuntimeError("saved-object import did not return the baseline data view ID")
    index_title = f"lab-{manifest['run_id']}"
    status, result = kibana_json(
        f"/s/{manifest['space_id']}/api/data_views/data_view/{quote(data_view_id)}",
        "POST",
        {"data_view": {"title": index_title, "timeFieldName": "@timestamp", "name": f"{manifest['scenario']['title']} data"}, "refresh_fields": True},
    )
    if status >= 400:
        raise RuntimeError(f"run data-view update failed ({status}): {result}")


def create_live_data_alias(manifest):
    alias = f"lab-{manifest['run_id']}"
    status, result = http_json(
        f"{ELASTICSEARCH_URL}/_aliases",
        "POST",
        {"actions": [{"add": {"index": "microservices-*", "alias": alias, "filter": {"term": {"scenario.id.keyword": manifest["run_id"]}}}}]},
        timeout=20,
    )
    if status >= 400:
        raise RuntimeError(f"run data alias creation failed ({status}): {result}")


def delete_space(space_id):
    try:
        kibana_json(f"/api/spaces/space/{quote(space_id)}", "DELETE", timeout=15)
    except (OSError, URLError):
        pass


def _deep_merge(base, overlay):
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _event_template(manifest, timestamp, trace_id, sequence):
    return {
        "@timestamp": timestamp.isoformat(),
        "message": "request completed",
        "service": {"name": "checkout", "version": "1.0.0", "environment": manifest["run_id"], "node": {"name": f"instance-{sequence % 4}"}},
        "event": {"dataset": "lab.scenario", "category": "web", "type": "transaction", "outcome": "success", "duration": 120_000_000},
        "http": {"request": {"method": "GET"}, "response": {"status_code": 200}},
        "url": {"path": "/checkout"},
        "trace": {"id": trace_id}, "transaction": {"id": uuid.uuid5(uuid.NAMESPACE_URL, f"{trace_id}:{sequence}").hex[:16], "name": "GET /checkout", "type": "request", "result": "HTTP 2xx", "sampled": True, "duration": {"us": 120_000}},
        "processor": {"event": "transaction"}, "agent": {"name": "opentelemetry/python", "version": "1.0.0"}, "observer": {"version": "9.5.2"},
        "host": {"name": f"instance-{sequence % 4}", "os": {"platform": "linux"}},
        "labels": {"scenario_template": manifest["template_id"], "run_id": manifest["run_id"]},
        "lab": {"run_id": manifest["run_id"], "scenario_id": manifest["template_id"]},
    }


def _prepare_application_event(event, application, template=None):
    """Normalize generated documents for the application that will read them."""
    template = template or {}
    prepared = copy.deepcopy(event)
    if application == "metrics":
        metric_name = _lookup_nested(prepared, "metricset.name") or "cpu"
        prepared["processor"] = {"event": "metric"}
        prepared["event"]["dataset"] = f"system.{metric_name}"
        prepared["metricset"] = {**prepared.get("metricset", {}), "period": 10_000}
        prepared["agent"] = {"name": "metricbeat", "type": "metricbeat", "version": "9.5.2"}
        prepared.pop("transaction", None)
    elif application == "apm" and _lookup_nested(template, "processor.event") == "log":
        prepared.pop("transaction", None)
    elif application == "apm" and "span" in template and "transaction" not in template:
        transaction_id = prepared.get("transaction", {}).get("id")
        prepared["processor"] = {"event": "span"}
        prepared["span"].setdefault("id", uuid.uuid5(uuid.NAMESPACE_URL, f"{prepared['trace']['id']}:{prepared['@timestamp']}:span").hex[:16])
        prepared["span"].setdefault("type", "external")
        prepared["parent"] = {"id": transaction_id}
        prepared["transaction"] = {"id": transaction_id}
    return prepared


def _lookup_nested(value, path, default=None):
    current = value
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return default
        current = current[part]
    return current


def _derived_apm_documents(event):
    """Split embedded span/error facts into documents understood by APM views."""
    derived = []
    if event.get("processor", {}).get("event") == "transaction" and event.get("span"):
        span_document = copy.deepcopy(event)
        transaction_id = event.get("transaction", {}).get("id")
        span_document["processor"] = {"event": "span"}
        span_document["span"].setdefault("id", uuid.uuid5(uuid.NAMESPACE_URL, f"{event['trace']['id']}:{event['@timestamp']}:span").hex[:16])
        span_document["span"].setdefault("type", "external")
        span_document["parent"] = {"id": transaction_id}
        span_document["transaction"] = {"id": transaction_id}
        derived.append(span_document)
    if event.get("error") and event.get("processor", {}).get("event") != "log":
        error_document = copy.deepcopy(event)
        error_document["processor"] = {"event": "error"}
        error_document["error"].setdefault("id", uuid.uuid5(uuid.NAMESPACE_URL, f"{event['trace']['id']}:{event['@timestamp']}:error").hex[:16])
        error_document["parent"] = {"id": event.get("span", {}).get("id") or event.get("transaction", {}).get("id")}
        derived.append(error_document)
    return derived


def _run_namespace(manifest):
    """Return a data-stream-safe namespace unique to this scenario run."""
    return f"lab{manifest['run_id'].removeprefix('run-')}"


def _application_document(document, application, manifest):
    """Add canonical data-stream metadata and return the concrete stream name."""
    prepared = copy.deepcopy(document)
    namespace = _run_namespace(manifest)
    processor_event = prepared.get("processor", {}).get("event")
    if application == "apm":
        prepared["timestamp"] = {"us": int(datetime.fromisoformat(prepared["@timestamp"]).timestamp() * 1_000_000)}
        if processor_event == "log":
            service = prepared.get("service", {}).get("name", "scenario").replace("-", "_")
            stream_type, dataset = "logs", f"apm.app.{service}"
            prepared.setdefault("event", {})["dataset"] = dataset
        elif processor_event == "error":
            stream_type, dataset = "logs", "apm.error"
            prepared.setdefault("event", {}).update({"dataset": dataset, "category": "error", "type": "error", "outcome": "failure"})
        else:
            stream_type, dataset = "traces", "apm"
    elif application == "metrics":
        stream_type = "metrics"
        dataset = prepared.get("event", {}).get("dataset", "system.cpu")
    else:
        return None, prepared
    prepared["data_stream"] = {"type": stream_type, "dataset": dataset, "namespace": namespace}
    return f"{stream_type}-{dataset}-{namespace}", prepared


def generate_seeded_events(manifest):
    profile = manifest["scenario"].get("provisioning", {}).get("seeded_events", {})
    generator = random.Random(manifest["seed"])
    now = datetime.now(timezone.utc)
    signal_count = int(profile.get("signal_count", 36))
    noise_count = int(profile.get("noise_count", 72))
    signal = _substitute(profile.get("signal", {}), manifest)
    distractors = [_substitute(item, manifest) for item in profile.get("distractors", [])]
    application = manifest["scenario"].get("starting_view", {}).get("app")
    documents = []
    for sequence in range(noise_count):
        timestamp = now - timedelta(seconds=generator.randint(90, 3600))
        trace_id = hashlib.md5(f"{manifest['run_id']}:noise:{sequence}".encode()).hexdigest()
        event = _event_template(manifest, timestamp, trace_id, sequence)
        event = _deep_merge(event, {"service": {"name": generator.choice(["checkout", "catalog", "auth", "orders"])}, "message": generator.choice(["request completed", "cache refreshed", "token accepted", "background reconciliation completed"])})
        if distractors and sequence % 5 == 0:
            event = _deep_merge(event, distractors[sequence % len(distractors)])
        documents.append(_prepare_application_event(event, application))
    representative_trace = hashlib.md5(f"{manifest['run_id']}:representative".encode()).hexdigest()
    for sequence in range(signal_count):
        timestamp = now - timedelta(seconds=generator.randint(10, 600))
        trace_id = representative_trace if sequence == 0 else hashlib.md5(f"{manifest['run_id']}:signal:{sequence // 2}".encode()).hexdigest()
        event = _deep_merge(_event_template(manifest, timestamp, trace_id, sequence), signal)
        prepared = _prepare_application_event(event, application, signal)
        documents.append(prepared)
        if application == "apm":
            documents.extend(_derived_apm_documents(prepared))
    for companion_index, companion in enumerate(profile.get("companions", [])):
        repeats = int(companion.get("count", 1))
        template = _substitute(companion.get("event", {}), manifest)
        for sequence in range(repeats):
            timestamp = now - timedelta(seconds=int(companion.get("offset_seconds", 120)) + sequence)
            event = _deep_merge(_event_template(manifest, timestamp, representative_trace, 1000 + companion_index * 100 + sequence), template)
            prepared = _prepare_application_event(event, application, template)
            documents.append(prepared)
            if application == "apm":
                documents.extend(_derived_apm_documents(prepared))
    return documents


def bulk_seed(manifest):
    documents = generate_seeded_events(manifest)
    index = f"lab-{manifest['run_id']}"
    application = manifest["scenario"].get("starting_view", {}).get("app")
    lines = []
    data_streams = set()
    for document in documents:
        lines.append(json.dumps({"index": {"_index": index}}))
        lines.append(json.dumps(document, separators=(",", ":")))
        application_index, application_document = _application_document(document, application, manifest)
        if application_index:
            data_streams.add(application_index)
            lines.append(json.dumps({"create": {"_index": application_index}}))
            lines.append(json.dumps(application_document, separators=(",", ":")))
    # Record these before indexing so lifecycle cleanup can also remove streams
    # created by a partially successful bulk request.
    update_run(manifest["run_id"], data_streams=sorted(data_streams))
    request = Request(f"{ELASTICSEARCH_URL}/_bulk?refresh=wait_for", data=("\n".join(lines) + "\n").encode(), method="POST", headers={"Content-Type": "application/x-ndjson"})
    with urlopen(request, timeout=30) as response:
        result = json.loads(response.read())
    if result.get("errors"):
        failures = [item for item in result.get("items", []) if any(operation.get("error") for operation in item.values())]
        raise RuntimeError(f"seeded event indexing failed: {failures[:2]}")
    return {"documents": len(documents), "data_streams": sorted(data_streams)}


def activate_fault(manifest):
    live = manifest["scenario"]["provisioning"].get("live_traffic", {})
    fault = live["fault"]
    service_url = SERVICE_URLS.get(fault["service"])
    if not service_url:
        raise RuntimeError(f"no URL configured for {fault['service']}")
    payload = {"scenario_id": manifest["run_id"], "scenario_name": manifest["template_id"], "fault": fault["type"], "delay_ms": fault["delay_ms"], "probability": fault["probability"], "paths": fault["paths"]}
    status, response = http_json(f"{service_url}/_control/fault", "POST", payload)
    if status != 200:
        raise RuntimeError(f"fault activation failed ({status}): {response}")


def clear_active_fault(run):
    if not run or "live-traffic" not in run["manifest"]["scenario"]["provisioning"].get("strategies", []):
        return
    fault = run["manifest"]["scenario"]["provisioning"].get("live_traffic", {}).get("fault", {})
    service_url = SERVICE_URLS.get(fault.get("service"))
    if service_url:
        try:
            http_json(f"{service_url}/_control/fault?scenario_id={quote(run['manifest']['run_id'])}", "DELETE", timeout=5)
        except (OSError, URLError):
            pass


def send_target_request(manifest):
    traffic = manifest["scenario"]["provisioning"]["live_traffic"]["traffic"]
    request = Request(SERVICE_URLS[traffic["entrypoint"]] + traffic["path"], headers={"X-Trace-Id": uuid.uuid4().hex, "X-Scenario-Id": manifest["run_id"], "X-Scenario-Name": manifest["template_id"]})
    try:
        with urlopen(request, timeout=20) as response:
            response.read()
    except HTTPError as error:
        error.read()
    except (OSError, URLError) as error:
        emit("target request failed", "ERROR", manifest["run_id"], action="traffic_error", error={"type": type(error).__name__})


def traffic_loop(manifest, stop):
    rate = float(manifest["scenario"]["provisioning"]["live_traffic"]["traffic"]["requests_per_second"])
    with ThreadPoolExecutor(max_workers=max(8, int(rate * 6)), thread_name_prefix="scenario-traffic") as pool:
        while not stop.wait(1 / rate):
            pool.submit(send_target_request, manifest)


def create_alert_rule(manifest, resource):
    rule_id = resource.get("id", f"lab-{manifest['run_id'][-12:]}")
    query = json.dumps({"query": {"bool": {"filter": [{"term": {"lab.run_id.keyword": manifest["run_id"]}}, {"term": {"event.outcome.keyword": "failure"}}]}}})
    payload = {
        "name": resource.get("name", "Active customer-impact signal"), "consumer": "stackAlerts", "rule_type_id": ".es-query", "enabled": True,
        "schedule": {"interval": resource.get("interval", "5s")}, "actions": [],
        "params": {"searchType": "esQuery", "esQuery": query, "index": [f"lab-{manifest['run_id']}"] , "timeField": "@timestamp", "timeWindowSize": 15, "timeWindowUnit": "m", "size": 100, "thresholdComparator": ">", "threshold": [0], "aggType": "count", "groupBy": "all", "excludeHitsFromPreviousRun": False},
    }
    status, response = kibana_json(f"/s/{manifest['space_id']}/api/alerting/rule/{quote(rule_id)}", "POST", payload, timeout=30)
    if status not in {200, 201, 409}:
        raise RuntimeError(f"alert rule creation failed ({status}): {response}")
    return {"kind": "alert_rule", "id": rule_id}


def provision_managed_resources(manifest):
    created = []
    for resource in manifest["scenario"].get("provisioning", {}).get("managed_resources", []):
        if resource["kind"] == "alert_rule":
            created.append(create_alert_rule(manifest, resource))
    return created


def evaluate_es_validator(manifest, validator):
    query = {"size": 0, "query": _substitute(validator.get("query", {"match_all": {}}), manifest)}
    if validator["kind"] == "es_cardinality":
        query["aggs"] = {"value": {"cardinality": {"field": validator["field"], "precision_threshold": 100}}}
    index = validator.get("index") or f"lab-{manifest['run_id']}"
    status, result = http_json(f"{ELASTICSEARCH_URL}/{index}/_search?allow_no_indices=true", "POST", query)
    if status >= 400:
        return False, 0
    if validator["kind"] == "es_cardinality":
        value = int(result.get("aggregations", {}).get("value", {}).get("value", 0))
    else:
        total = result.get("hits", {}).get("total", 0)
        value = int(total.get("value", 0) if isinstance(total, dict) else total)
    return value >= int(validator.get("minimum", 1)), value


def readiness(manifest, stop):
    validators = manifest["scenario"]["provisioning"].get("readiness_validators", [])
    if not validators:
        return True, {"completed": 1, "required": 1, "validators": {}}
    timeout = max(int(item.get("timeout_seconds", 90)) for item in validators)
    deadline = time.monotonic() + timeout
    latest = {}
    while not stop.wait(1):
        all_ready = True
        for validator in validators:
            if validator["kind"] in {"es_count", "es_cardinality"}:
                ready, value = evaluate_es_validator(manifest, validator)
            elif validator["kind"] in {"kibana_api", "kibana_rule_ready"}:
                status, body = kibana_json(_substitute(validator["path"], manifest), timeout=10)
                ready = status < 400
                if validator["kind"] == "kibana_rule_ready":
                    execution = body.get("execution_status", {}) if isinstance(body, dict) else {}
                    last_run = body.get("last_run", {}) if isinstance(body, dict) else {}
                    alert_counts = last_run.get("alerts_count", {})
                    visible_alerts = int(alert_counts.get("active", 0)) + int(alert_counts.get("new", 0))
                    ready = (
                        ready
                        and execution.get("status") in {"ok", "active"}
                        and bool(execution.get("last_execution_date"))
                        and last_run.get("outcome") == "succeeded"
                        and visible_alerts > 0
                    )
                value = body.get("execution_status", {}).get("status", status) if isinstance(body, dict) else status
            else:
                raise RuntimeError(f"unknown readiness validator: {validator['kind']}")
            latest[validator["id"]] = {"ready": ready, "value": value, "minimum": validator.get("minimum")}
            all_ready = all_ready and ready
        evidence = {"completed": sum(1 for value in latest.values() if value["ready"]), "required": len(validators), "validators": latest}
        update_run(manifest["run_id"], evidence=evidence)
        if all_ready:
            return True, evidence
        if time.monotonic() >= deadline:
            return False, evidence
    return False, {"completed": 0, "required": len(validators), "validators": latest}


def cleanup_run(run, delete_data=True):
    if not run:
        return
    manifest = run["manifest"]
    clear_active_fault(run)
    traffic_thread = run.get("traffic_thread")
    if traffic_thread and traffic_thread.is_alive() and traffic_thread is not threading.current_thread():
        traffic_thread.join(timeout=30)
    if manifest["scenario"].get("cleanup", {}).get("delete_space", True):
        delete_space(manifest["space_id"])
    if delete_data and manifest["scenario"].get("cleanup", {}).get("delete_run_data", True):
        regular_indices = [f"lab-{manifest['run_id']}", f"traces-apm.lab-{manifest['run_id']}"]
        data_streams = set(run.get("data_streams", [])) | {
            f"logs-apm.lab-{manifest['run_id']}",
            f"metrics-system.lab-{manifest['run_id']}",
        }
        for index in regular_indices:
            try:
                http_json(f"{ELASTICSEARCH_URL}/{quote(index)}?ignore_unavailable=true&allow_no_indices=true", "DELETE", timeout=15)
            except (OSError, URLError):
                pass
        live_alias = f"lab-{manifest['run_id']}"
        try:
            http_json(
                f"{ELASTICSEARCH_URL}/microservices-*/_alias/{quote(live_alias)}",
                "DELETE",
                timeout=15,
            )
        except (OSError, URLError):
            pass
        for data_stream in data_streams:
            try:
                http_json(f"{ELASTICSEARCH_URL}/_data_stream/{quote(data_stream)}", "DELETE", timeout=15)
                # If a future template resolves this name to an index instead,
                # retain a safe, exact-name fallback.
                http_json(f"{ELASTICSEARCH_URL}/{quote(data_stream)}?ignore_unavailable=true&allow_no_indices=true", "DELETE", timeout=15)
            except (OSError, URLError):
                pass
        if "live-traffic" in manifest["scenario"].get("provisioning", {}).get("strategies", []):
            # Requests have drained, but Logstash can still be flushing their
            # final file-backed events. Allow one ingest interval, then sweep
            # twice so cleanup cannot race a late bulk flush.
            threading.Event().wait(2)
            for attempt in range(2):
                if attempt:
                    threading.Event().wait(1)
                try:
                    http_json(
                        f"{ELASTICSEARCH_URL}/microservices-*/_delete_by_query?allow_no_indices=true&conflicts=proceed&refresh=true",
                        "POST",
                        {"query": {"term": {"scenario.id.keyword": manifest["run_id"]}}},
                        timeout=30,
                    )
                except (OSError, URLError):
                    pass


def lifecycle(manifest, stop):
    run_id = manifest["run_id"]
    try:
        update_run(run_id, state="ACTIVATING")
        emit("scenario activating", run_id=run_id, action="activating", state="ACTIVATING", seed=manifest["seed"])
        strategies = manifest["scenario"]["provisioning"].get("strategies", [])
        create_space(manifest)
        if "live-traffic" in strategies:
            create_live_data_alias(manifest)
        if "saved-objects" in strategies:
            import_saved_objects(manifest)
        if "seeded-events" in strategies:
            indexed = bulk_seed(manifest)
            update_run(run_id, indexed_documents=indexed["documents"], data_streams=indexed["data_streams"])
        if "live-traffic" in strategies:
            activate_fault(manifest)
            traffic_thread = threading.Thread(target=traffic_loop, args=(manifest, stop), daemon=True)
            update_run(run_id, traffic_thread=traffic_thread)
            traffic_thread.start()
        if "managed-resource" in strategies:
            update_run(run_id, managed_resources=provision_managed_resources(manifest))
        if stop.is_set():
            return
        update_run(run_id, state="WARMING")
        ready, evidence = readiness(manifest, stop)
        if not ready:
            raise TimeoutError(f"scenario readiness timed out: {evidence}")
        ready_at = now_iso()
        update_run(run_id, state="READY", ready_at=ready_at, evidence=evidence)
        emit("scenario ready", run_id=run_id, action="ready", state="READY", evidence=evidence)
    except Exception as error:
        if update_run(run_id, state="FAILED", error=str(error)):
            emit("scenario failed", "ERROR", run_id, action="failed", state="FAILED", error={"type": type(error).__name__, "message": str(error)})
        stop.set()
        cleanup_run(get_run(run_id), delete_data=True)


def create_run(seed=None, scenario_name=None, scenario_key=SCENARIO_KEY_UNSET):
    global current_run_id
    if scenario_key is SCENARIO_KEY_UNSET:
        selected_seed, scenario_key = normalize_seed(seed)
    else:
        selected_seed, scenario_key = scenario_key_seed(scenario_key)
    template = load_template(scenario_name or SCENARIO_NAME)
    entry = catalog_entry(template["id"])
    if entry:
        availability = scenario_availability(entry)
        if not availability["available"]:
            raise ValueError(availability["reason"])
    manifest = materialize(template, selected_seed, scenario_key=scenario_key)
    stop = threading.Event()
    run = {"manifest": manifest, "state": "CREATED", "evidence": {"completed": 0, "required": max(1, len(manifest["scenario"]["provisioning"].get("readiness_validators", [])))}, "stop": stop}
    with state_lock:
        runs[manifest["run_id"]] = run
        current_run_id = manifest["run_id"]
        MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
        with (MANIFEST_DIR / f"{manifest['run_id']}.json").open("w", encoding="utf-8") as stream:
            json.dump(manifest, stream, indent=2, sort_keys=True)
        snapshot = public_state(run, include_manifest=True)
    threading.Thread(target=lifecycle, args=(manifest, stop), daemon=True).start()
    return snapshot


def stop_run(run_id):
    run = get_run(run_id)
    if not run:
        return False
    run["stop"].set()
    cleanup_run(run)
    update_run(run_id, state="ABORTED", completed_at=now_iso())
    emit("scenario aborted", run_id=run_id, action="aborted", state="ABORTED")
    return True


def transition_run(run_id, requested_state):
    allowed = {"READY": {"INVESTIGATING", "COMPLETED"}, "INVESTIGATING": {"COMPLETED"}}
    with state_lock:
        run = runs.get(run_id)
        if not run:
            raise KeyError("run not found")
        previous = run["state"]
        if requested_state == previous:
            return public_state(run)
        if requested_state not in allowed.get(previous, set()):
            raise ValueError(f"cannot transition run from {previous} to {requested_state}")
        run["state"] = requested_state
        if requested_state == "COMPLETED":
            run["stop"].set()
            clear_active_fault(run)
            run["completed_at"] = now_iso()
        emit(f"scenario {requested_state.lower()}", run_id=run_id, action=requested_state.lower(), state=requested_state)
        return public_state(run)


class Handler(BaseHTTPRequestHandler):
    server_version = "scenario-controller/2"

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            with state_lock:
                self.respond(200, {"status": "ok", "runs": len(runs), "run": public_state(runs.get(current_run_id))})
            return
        if parsed.path == "/api/catalog":
            self.respond(200, catalog_public())
            return
        if parsed.path == "/api/capabilities":
            self.respond(200, {"kibana_version": "9.5.2", "capabilities": probe_capabilities()})
            return
        if parsed.path == "/ready":
            run = get_run(current_run_id)
            ready = bool(run and run["state"] == "READY")
            self.respond(200 if ready else 503, {"ready": ready, "run": public_state(run)})
            return
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "runs"]:
            run = get_run(parts[2])
            if not run:
                self.respond(404, {"error": "run not found"})
            else:
                include = parse_qs(parsed.query).get("include_manifest") == ["true"]
                self.respond(200, public_state(run, include_manifest=include))
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
                run = create_run(scenario_name=payload.get("scenario"), scenario_key=payload["scenario_key"]) if "scenario_key" in payload else create_run(payload.get("seed"), payload.get("scenario"))
                self.respond(202, run)
                return
            if len(parts) == 4 and parts[:2] == ["api", "runs"] and parts[3] == "reset":
                existing = get_run(parts[2])
                if not existing:
                    self.respond(404, {"error": "run not found"})
                    return
                stop_run(parts[2])
                scenario = existing["manifest"]["template_id"]
                if "scenario_key" in payload:
                    run = create_run(scenario_name=scenario, scenario_key=payload["scenario_key"])
                else:
                    seed = payload.get("seed", existing["manifest"]["seed"])
                    run = create_run(seed, scenario)
                self.respond(202, run)
                return
            if len(parts) == 4 and parts[:2] == ["api", "runs"] and parts[3] == "state":
                result = transition_run(parts[2], str(payload.get("state", "")).upper())
                self.respond(200, result)
                return
        except KeyError as error:
            self.respond(404, {"error": str(error)})
            return
        except (ValueError, RuntimeError, OSError, URLError) as error:
            self.respond(400, {"error": str(error)})
            return
        self.respond(404, {"error": "not found"})

    def do_DELETE(self):
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "runs"]:
            stopped = stop_run(parts[2])
            self.respond(200 if stopped else 404, {"aborted": stopped})
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
