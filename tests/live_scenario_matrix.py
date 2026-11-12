#!/usr/bin/env python3
"""Provision catalog packs against a running stack and check that each run's fault really exists.

For every capability-available core pack (or the ones selected), each run is created as the launcher
creates it — from a scenario key — and then checked against its own manifest:

* readiness: every declared readiness validator was met, and still is when re-evaluated;
* truth: every decisive truth assertion holds in Elasticsearch, evaluated by the learning service's own
  evidence code (learning-service/server.py action_evidence), as a demonstration sees it;
* distractor: the evidence of another variant of the pack is absent from this run, and an answer naming
  a representative distractor is graded wrong while the run's own answer is graded right, by the live
  learning service;
* isolation and cleanup: the run has its own Space and data, and deleting it removes both.

Parameterized packs are run once per variant needed to cover every choice of every parameter (the
service, error, route and window the incident uses), with fixed, reproducible scenario keys. `--replay`
adds the replay contract: a repeated key reproduces the parameters with a new run and Space, a different
key changes them, a rejected replay leaves the existing run alone, and a completed session's feedback
survives a replay. Needs the stack (`./build-all.sh`) and docker compose, to read run manifests.

    python tests/live_scenario_matrix.py                         # discover-time-window, one key
    python tests/live_scenario_matrix.py --track mvp --replay    # the MVP log-hunt packs, every variant
    python tests/live_scenario_matrix.py --all --isolation       # every available core pack
"""

import argparse
import copy
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("LOG_DIR", tempfile.gettempdir())
os.environ["LEARNING_DIR"] = str(ROOT / "learning")
sys.path.insert(0, str(ROOT / "learning-service"))

# The classic wrong answer for packs whose distractor can't be read off their parameters or seeded
# distractor events: what a learner who stopped one step short would name.
DECLARED_DISTRACTORS = {
    "dashboard-drilldown-to-evidence": "payments",
    "dashboard-panel-inspection": "all events panel",
    "slow-dependency-trace": "catalog — GET /items",
    "trace-error-propagation": "api-gateway — POST /checkout",
    "retry-amplification": "1 payment attempt per request",
    "trace-log-correlation": "card declined by the issuer",
    "cpu-saturation": "checkout-01",
    "capacity-throughput-saturation": "120 requests/second",
    "active-alert-triage": "recovered",
}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server = load_module("live_matrix_server", ROOT / "learning-service" / "server.py")
controller = load_module("live_matrix_controller", ROOT / "scenario-controller" / "controller.py")
server.LEARNING_DIR = controller.LEARNING_DIR = ROOT / "learning"
server.emit = lambda *_args, **_kwargs: None


class Failure(AssertionError):
    pass


def request_json(url, method="GET", payload=None, headers=None, timeout=30):
    request = Request(
        url,
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw) if raw else {"error": str(error)}
        except json.JSONDecodeError:
            return error.code, {"error": raw.decode(errors="replace")[:500]}


class Lab:
    def __init__(self, args):
        self.learning = args.learning_url.rstrip("/")
        self.elasticsearch = args.elasticsearch_url.rstrip("/")
        self.kibana = args.kibana_url.rstrip("/")
        server.ELASTICSEARCH_URL = controller.ELASTICSEARCH_URL = self.elasticsearch

    def create(self, scenario_id, key, mode="challenge"):
        status, created = request_json(f"{self.learning}/api/runs", "POST", {"scenario": scenario_id, "scenario_key": key, "mode": mode})
        if status != 202:
            raise Failure(f"{scenario_id}: create failed ({status}): {created}")
        return created

    def wait_ready(self, run_id, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status, run = request_json(f"{self.learning}/api/runs/{run_id}")
            if status != 200:
                raise Failure(f"{run_id}: status lookup failed ({status}): {run}")
            if run["state"] == "READY":
                return run
            if run["state"] in {"FAILED", "ABORTED"}:
                raise Failure(f"{run_id}: {run['state']}: {run.get('error')}")
            time.sleep(1)
        raise Failure(f"{run_id}: readiness timed out")

    def manifest(self, run_id):
        """The controller's manifest for the run (it is not exposed over HTTP: it holds the answers)."""
        result = subprocess.run(["docker", "compose", "exec", "-T", "scenario-controller", "cat", f"/tmp/scenario-manifests/{run_id}.json"],
                                cwd=ROOT, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise Failure(f"{run_id}: manifest unavailable: {result.stderr.strip()[:300]}")
        return json.loads(result.stdout)

    def answer(self, created, payload):
        session = created["session"]
        status, feedback = request_json(f"{self.learning}/api/sessions/{session['session_id']}/answer", "POST", payload,
                                        {"Authorization": f"Bearer {session['connection_token']}"})
        if status != 200:
            raise Failure(f"{session['run_id']}: answer failed ({status}): {feedback}")
        return feedback

    def session_status(self, created):
        session = created["session"]
        return request_json(f"{self.learning}/api/sessions/{session['session_id']}", headers={"Authorization": f"Bearer {session['connection_token']}"})

    def cleanup(self, run_id):
        status, result = request_json(f"{self.learning}/api/runs/{run_id}", "DELETE")
        if status != 200 or not result.get("aborted"):
            raise Failure(f"{run_id}: cleanup failed ({status}): {result}")

    def assert_space(self, space_id):
        status, result = request_json(f"{self.kibana}/api/spaces/space/{space_id}", headers={"kbn-xsrf": "live-scenario-matrix"})
        if status != 200 or result.get("id") != space_id:
            raise Failure(f"{space_id}: Space lookup failed ({status}): {result}")

    def assert_cleaned(self, run):
        status, _ = request_json(f"{self.kibana}/api/spaces/space/{run['space_id']}", headers={"kbn-xsrf": "live-scenario-matrix"})
        if status != 404:
            raise Failure(f"{run['run_id']}: Space still exists after cleanup")
        for index in (f"lab-{run['run_id']}", f"traces-apm.lab-{run['run_id']}"):
            status, _ = request_json(f"{self.elasticsearch}/{index}/_count")
            if status != 404:
                raise Failure(f"{run['run_id']}: index {index} still exists after cleanup")
        namespace = f"lab{run['run_id'].removeprefix('run-')}"
        status, result = request_json(f"{self.elasticsearch}/_data_stream")
        remaining = [item["name"] for item in result.get("data_streams", []) if item["name"].endswith(f"-{namespace}")]
        if status == 200 and remaining:
            raise Failure(f"{run['run_id']}: data streams still exist after cleanup: {remaining}")
        status, result = request_json(f"{self.elasticsearch}/microservices-*/_count?allow_no_indices=true", "POST",
                                      {"query": {"term": {"scenario.id.keyword": run["run_id"]}}})
        if status == 200 and result.get("count"):
            raise Failure(f"{run['run_id']}: live telemetry still exists after cleanup")


# ------------------------------------------------------------------------------------------------
# Variants and distractors


def template(scenario_id):
    return controller.load_template(scenario_id)


def choices(scenario_id):
    specs = template(scenario_id).get("parameters") or {}
    return {name: spec["choose"] for name, spec in specs.items() if isinstance(spec, dict) and "choose" in spec}


def chosen_indices(scenario_id, key):
    seed, _ = controller.scenario_key_seed(key)
    parameters = controller.choose_parameters(template(scenario_id).get("parameters") or {}, seed)
    return {(name, options.index(parameters[name])) for name, options in choices(scenario_id).items()}


def variant_keys(scenario_id, cover=True):
    """Fixed scenario keys whose runs together use every choice of every parameter (one key for a pack
    without choices, or with cover=False). Chosen greedily from a fixed candidate list, so reproducible."""
    prefix = re.sub(r"[^a-z0-9]", "", scenario_id)[:14]
    candidates = [f"matrix-{prefix}-{number:03d}" for number in range(400)]
    options = choices(scenario_id)
    if not options or not cover:
        return candidates[:1]
    needed = {(name, index) for name, values in options.items() for index in range(len(values))}
    picked = []
    covers = {key: chosen_indices(scenario_id, key) for key in candidates}
    while needed:
        key = max(candidates, key=lambda candidate: (len(covers[candidate] & needed), -candidates.index(candidate)))
        if not covers[key] & needed:
            raise Failure(f"{scenario_id}: no candidate key covers {sorted(needed)}")
        picked.append(key)
        needed -= covers[key]
    return picked


def leaves(value, path=()):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from leaves(item, path + (key,))
    elif not isinstance(value, list):
        yield path, value


def lookup(value, path):
    for part in path:
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def distractor_values(manifest, finding):
    """Values that stand where the finding does in another variant of the pack, or in its seeded
    distractor events, or the pack's declared classic wrong answer."""
    values = []
    parameters = manifest.get("parameters") or {}
    for name, options in choices(manifest["template_id"]).items():
        for path, value in leaves(parameters.get(name) if isinstance(parameters.get(name), dict) else {}):
            if str(value) == str(finding):
                values += [str(other) for option in options if (other := lookup(option, path)) is not None and str(other) != str(finding)]
    seeded = manifest["scenario"]["provisioning"].get("seeded_events") or {}
    for path, value in leaves(seeded.get("signal") or {}):
        if str(value) == str(finding):
            values += [str(other) for event in seeded.get("distractors") or [] if (other := lookup(event, path)) is not None and str(other) != str(finding)]
    if manifest["template_id"] in DECLARED_DISTRACTORS:
        values.append(DECLARED_DISTRACTORS[manifest["template_id"]])
    return list(dict.fromkeys(values))


def shifted(text, minutes):
    """A clock or a clock window moved by `minutes` ("16:24–16:30" → "16:39–16:45")."""
    def move(match):
        moment = datetime(2000, 1, 1, int(match.group(1)), int(match.group(2))) + timedelta(minutes=minutes)
        return f"{moment:%H:%M}"
    return re.sub(r"\b(\d{1,2}):(\d{2})\b", move, text)


def variant_manifest(manifest, parameters):
    """The run's manifest as another variant would have it: same run, another choice of parameters."""
    scenario = copy.deepcopy(template(manifest["template_id"]))
    scenario.pop("parameters", None)
    return {**manifest, "scenario": controller._apply_parameters(scenario, parameters), "parameters": parameters}


def evidence(manifest):
    """Each truth assertion as the learning service evaluates it for this run (unscoped, as in a
    demonstration)."""
    session = server.create_session({"manifest": manifest}, "demonstration")
    try:
        return server.action_evidence(session, {"details": {}, "actor": "tutorial"})["assertions"]
    finally:
        server.sessions.pop(session["id"], None)


# ------------------------------------------------------------------------------------------------
# Checks


def check_readiness(ready, manifest):
    declared = manifest["scenario"]["provisioning"].get("readiness_validators", [])
    readings = ready["evidence"].get("validators", {})
    if ready["evidence"]["completed"] != ready["evidence"]["required"]:
        raise Failure(f"incomplete readiness evidence: {ready['evidence']}")
    for validator in declared:
        reading = readings.get(validator["id"])
        if not reading or not reading.get("ready"):
            raise Failure(f"readiness validator {validator['id']} was not met: {reading}")
        if validator["kind"] in {"es_count", "es_cardinality"}:
            met, value = controller.evaluate_es_validator(manifest, validator)
            if not met:
                raise Failure(f"readiness validator {validator['id']} no longer holds: {value} < {validator.get('minimum', 1)}")
    return {validator["id"]: readings[validator["id"]]["value"] for validator in declared}


def check_truth(manifest):
    assertions = evidence(manifest)
    checked = {item["id"] for item in manifest["scenario"]["truth"].get("assertions", []) if item["kind"] != "trace_from_action"}
    failing = sorted(item for item in checked if not assertions.get(item))
    if failing:
        raise Failure(f"decisive truth assertions do not hold in the run: {failing} ({assertions})")
    return assertions


def check_distractor_evidence(manifest):
    """Another variant's decisive evidence must be absent from this run."""
    parameters = manifest.get("parameters") or {}
    results = {}
    for name, options in choices(manifest["template_id"]).items():
        other = next((option for option in options if option != parameters.get(name)), None)
        if other is None:
            continue
        variant = variant_manifest(manifest, {**parameters, name: other})
        own = {item["id"]: item.get("query") for item in manifest["scenario"]["truth"]["assertions"]}
        theirs = {item["id"]: item.get("query") for item in variant["scenario"]["truth"]["assertions"]}
        differing = [assertion for assertion in own if own[assertion] != theirs.get(assertion)]
        if not differing:
            continue
        held = evidence(variant)
        wrongly = [assertion for assertion in differing if held.get(assertion)]
        if wrongly:
            raise Failure(f"another {name} variant's evidence also holds in this run: {wrongly}")
        results[name] = differing
    return results


def check_answers(lab, created, manifest):
    """Grade a blank answer (for what the run expects), a distractor (wrong) and the run's own (right)."""
    offset = {"client_utc_offset_minutes": 0}
    blank = lab.answer(created, offset)
    expected = {item["id"]: item["expected"] for item in blank["answer_review"]}
    if "finding" not in expected:
        raise Failure(f"answer schema has no graded finding: {sorted(expected)}")
    kinds = {field["id"]: field.get("kind") for field in created["session"]["answer_schema"]["fields"]}
    if kinds.get("finding") in {"window", "clock"}:
        candidates = [shifted(expected["finding"], 15)]
    else:
        candidates = distractor_values(manifest, expected["finding"])
    if not candidates:
        raise Failure("no representative distractor for this pack (add one to DECLARED_DISTRACTORS)")
    distractor = candidates[0]
    wrong = lab.answer(created, {**expected, "finding": distractor, **offset})
    review = {item["id"]: item["correct"] for item in wrong["answer_review"]}
    if review.get("finding") or wrong["diagnosis_correct"]:
        raise Failure(f"the distractor {distractor!r} was graded correct: {wrong['answer_review']}")
    right = lab.answer(created, {**expected, **offset})
    if not right["diagnosis_correct"]:
        raise Failure(f"the run's own answer was graded wrong: {right['answer_review']}")
    return {"distractor": distractor, "expected_finding": expected["finding"]}


def run_pack(lab, entry, key):
    created = lab.create(entry["id"], key)
    run_id = created["run"]["run_id"]
    report = {"scenario": entry["id"], "key": key, "run_id": run_id}
    ready = None
    try:
        ready = lab.wait_ready(run_id)
        if f"/s/{ready['space_id']}/" not in ready["investigation_url"]:
            raise Failure("starting URL is not Space-scoped")
        lab.assert_space(ready["space_id"])
        manifest = lab.manifest(run_id)
        report["parameters"] = sorted(f"{name}#{index}" for name, index in chosen_indices(entry["id"], key))
        report["readiness"] = check_readiness(ready, manifest)
        report["truth"] = check_truth(manifest)
        report["distractor_evidence"] = check_distractor_evidence(manifest)
        report["answers"] = check_answers(lab, created, manifest)
        status, run = request_json(f"{lab.learning}/api/runs/{run_id}")
        if run.get("state") != "COMPLETED":
            raise Failure(f"run is {run.get('state')} after its answer, not COMPLETED")
    finally:
        lab.cleanup(run_id)
        if ready:
            lab.assert_cleaned(ready)
    return report


def check_replay(lab, entry):
    """A repeated key reproduces the incident in a new run and Space; another key changes it; a rejected
    replay leaves the run alone; a completed session's feedback survives a replay."""
    keys = variant_keys(entry["id"])
    if len(keys) < 2:
        raise Failure(f"{entry['id']} has no variants to replay")
    first, again, other = lab.create(entry["id"], keys[0]), lab.create(entry["id"], keys[0]), lab.create(entry["id"], keys[1])
    runs = [first, again, other]
    replacement = None
    try:
        for created in runs:
            lab.wait_ready(created["run"]["run_id"])
        manifests = [lab.manifest(created["run"]["run_id"]) for created in runs]
        if manifests[0]["parameters"] != manifests[1]["parameters"]:
            raise Failure("a repeated scenario key did not reproduce the incident's parameters")
        if len({item["run_id"] for item in manifests[:2]}) != 2 or len({item["space_id"] for item in manifests[:2]}) != 2:
            raise Failure("a repeated scenario key reused a run id or Space")
        if manifests[2]["parameters"] == manifests[0]["parameters"]:
            raise Failure("a different scenario key produced the same parameters")
        run_id = first["run"]["run_id"]
        status, body = request_json(f"{lab.learning}/api/runs/{run_id}/reset", "POST", {"scenario_key": "short", "mode": "challenge"})
        if status != 400:
            raise Failure(f"a replay with an invalid key was not rejected ({status}): {body}")
        status, body = request_json(f"{lab.learning}/api/runs/{run_id}/reset", "POST", {"scenario_key": keys[0], "mode": "solo"})
        if status != 400:
            raise Failure(f"a replay with an invalid mode was not rejected ({status}): {body}")
        status, run = request_json(f"{lab.learning}/api/runs/{run_id}")
        if run.get("state") != "READY":
            raise Failure(f"a rejected replay changed the run to {run.get('state')}")
        lab.answer(first, {"client_utc_offset_minutes": 0})
        status, replayed = request_json(f"{lab.learning}/api/runs/{run_id}/reset", "POST", {"scenario_key": keys[0], "mode": "challenge"})
        if status != 202:
            raise Failure(f"replay failed ({status}): {replayed}")
        replacement = replayed
        lab.wait_ready(replayed["run"]["run_id"])
        if lab.manifest(replayed["run"]["run_id"])["parameters"] != manifests[0]["parameters"]:
            raise Failure("a replay with the same key changed the incident's parameters")
        session = first["session"]
        status, feedback = request_json(f"{lab.learning}/api/sessions/{session['session_id']}/feedback")
        if status != 200:
            raise Failure(f"the replayed session's feedback was lost ({status}): {feedback}")
        status, state = lab.session_status(first)
        if status != 200 or not state.get("available") or not state.get("feedback_available"):
            raise Failure(f"the replayed session is no longer reviewable ({status}): {state}")
        return {"scenario": entry["id"], "keys": keys[:2], "parameters_reproduced": True}
    finally:
        for created in [*runs, *([replacement] if replacement else [])]:
            request_json(f"{lab.learning}/api/runs/{created['run']['run_id']}", "DELETE")


def check_isolation(lab, entry):
    key = variant_keys(entry["id"], cover=False)[0]
    first, second = lab.create(entry["id"], key), lab.create(entry["id"], key)
    try:
        ready = [lab.wait_ready(created["run"]["run_id"]) for created in (first, second)]
        if ready[0]["space_id"] == ready[1]["space_id"] or ready[0]["run_id"] == ready[1]["run_id"]:
            raise Failure("concurrent runs did not receive distinct identities")
        for item in ready:
            check_truth(lab.manifest(item["run_id"]))
    finally:
        for created in (first, second):
            lab.cleanup(created["run"]["run_id"])
    return {"scenario": entry["id"], "isolated": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--learning-url", default="http://localhost:8091")
    parser.add_argument("--elasticsearch-url", default="http://localhost:9200")
    parser.add_argument("--kibana-url", default="http://localhost:5601")
    parser.add_argument("--scenario", action="append", help="a pack to run (repeatable)")
    parser.add_argument("--surface")
    parser.add_argument("--track", help="the catalog track to run, e.g. mvp")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--variants", choices=["one", "cover"], default="cover", help="one key per pack, or enough to cover every parameter choice")
    parser.add_argument("--isolation", action="store_true")
    parser.add_argument("--replay", action="store_true")
    parser.add_argument("--keep-going", action="store_true", help="report every failure instead of stopping at the first")
    parser.add_argument("--report", type=Path, help="write the results as JSON here")
    args = parser.parse_args()
    lab = Lab(args)
    catalog = json.loads((ROOT / "learning" / "catalog.json").read_text(encoding="utf-8"))
    status, available = request_json(f"{lab.learning}/api/capabilities")
    if status != 200:
        raise SystemExit(f"capabilities unavailable ({status}): {available}")
    capabilities = available["capabilities"]
    entries = [item for item in catalog["scenarios"] if item["classification"] == "core"
               and all(capabilities.get(capability) for capability in item.get("required_capabilities", []))]
    if args.scenario:
        entries = [item for item in entries if item["id"] in args.scenario]
    if args.surface:
        entries = [item for item in entries if item["surface"] == args.surface]
    if args.track:
        entries = [item for item in entries if item.get("track") == args.track]
    if not (args.all or args.scenario or args.surface or args.track):
        entries = [item for item in entries if item["id"] == "discover-time-window"]
    if not entries:
        raise SystemExit("no available core scenarios matched")

    results, failures = {"runs": [], "replay": [], "isolation": []}, []

    def attempt(label, kind, check):
        started = time.monotonic()
        try:
            outcome = check()
            outcome["seconds"] = round(time.monotonic() - started, 1)
            results[kind].append(outcome)
            print(f"PASS {label} ({outcome['seconds']}s)", flush=True)
        except (Failure, URLError, OSError, ValueError) as error:
            failures.append({"check": label, "error": str(error)})
            print(f"FAIL {label}: {error}", flush=True)
            if not args.keep_going:
                raise

    try:
        for entry in entries:
            for key in variant_keys(entry["id"], cover=args.variants == "cover"):
                attempt(f"{entry['id']} [{key}]", "runs", lambda entry=entry, key=key: run_pack(lab, entry, key))
        if args.replay:
            parameterized = [item for item in entries if choices(item["id"])] or entries
            attempt(f"replay {parameterized[0]['id']}", "replay", lambda: check_replay(lab, parameterized[0]))
        if args.isolation:
            target = next((item for item in entries if "saved_objects" in item.get("required_capabilities", [])), entries[0])
            attempt(f"isolation {target['id']}", "isolation", lambda: check_isolation(lab, target))
    except (Failure, URLError, OSError, ValueError):
        pass
    unavailable = [item["id"] for item in catalog["scenarios"] if item["classification"] == "core" and item not in entries
                   and not all(capabilities.get(capability) for capability in item.get("required_capabilities", []))]
    summary = {**results, "failures": failures, "unavailable_core": unavailable,
               "passed": len(results["runs"]) + len(results["replay"]) + len(results["isolation"])}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps({"passed": summary["passed"], "failed": len(failures), "failures": failures, "unavailable_core": unavailable}, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
