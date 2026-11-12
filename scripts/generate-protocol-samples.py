#!/usr/bin/env python3
"""Generate the learning-service protocol samples the coach is type-checked against.

The samples come from the real code: runs are materialized by scenario-controller/controller.py, and
every REST body and WebSocket message is built by learning-service/server.py and its engine. Only the
network is replaced — the controller's run state and Elasticsearch's answers are in-process fakes — so
this needs neither Docker nor a running stack.

It walks every core pack in every mode through its reference route, and drives the guided dead ends,
hints, check-ins, window slides, failures and completions, so each message variant and each optional
field the server can send is sampled. The output is a TypeScript module whose samples must satisfy
kibana-coach/protocol/protocol.d.ts (`npm run check:protocol` in kibana-coach/). A renamed field, an
extra field, a null where the declaration has none, or a variant the declaration lacks fails there.

    python scripts/generate-protocol-samples.py            # write kibana-coach/protocol/generated/samples.ts
    python scripts/generate-protocol-samples.py --json     # print the samples as JSON instead
"""

import argparse
import copy
import importlib.util
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "kibana-coach" / "protocol" / "generated" / "samples.ts"
os.environ.setdefault("LOG_DIR", tempfile.gettempdir())
os.environ["LEARNING_DIR"] = str(ROOT / "learning")
sys.path.insert(0, str(ROOT / "learning-service"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server = load_module("protocol_server", ROOT / "learning-service" / "server.py")
controller = load_module("protocol_controller", ROOT / "scenario-controller" / "controller.py")
matrix = load_module("protocol_matrix", ROOT / "scripts" / "test-scenario-matrix.py")
server.LEARNING_DIR = ROOT / "learning"
controller.LEARNING_DIR = ROOT / "learning"
# Their event logs are not protocol; keep them off stdout (and out of the log file).
server.emit = lambda *_args, **_kwargs: None
controller.emit = lambda *_args, **_kwargs: None

# Every message type server.py can put on the socket, read from its source: a variant added there and
# not sampled here (and so not declared) fails the generator.
SOURCE_MESSAGE_TYPES = set(re.findall(r'"message_type":\s*"([a-z_]+)"', (ROOT / "learning-service" / "server.py").read_text(encoding="utf-8")))


class FakeNetwork:
    """The controller's run registry and Elasticsearch, as far as the learning service asks them."""

    def __init__(self):
        self.runs = {}
        self.hits = 500

    def http_json(self, url, method="GET", payload=None, timeout=10):
        if url.startswith(server.CONTROLLER_URL):
            path = url[len(server.CONTROLLER_URL):]
            match = re.fullmatch(r"/api/runs/([^/?]+)(/state)?", path)
            if not match or match.group(1) not in self.runs:
                return 404, {"error": "run not found"}
            run = self.runs[match.group(1)]
            if match.group(2):
                run["state"] = payload["state"]
            return 200, controller.public_state(run)
        if url.startswith(server.ELASTICSEARCH_URL):
            if "/_query" in url:
                return 200, {"columns": [{"name": "url.path", "type": "keyword"}, {"name": "failures", "type": "long"}], "values": [["/checkout", 42], ["/cart", 3]]}
            return 200, {"hits": {"total": {"value": self.hits, "relation": "eq"}, "hits": []},
                         "aggregations": {"value": {"value": 4}, "services": {"value": 4}}}
        raise AssertionError(f"unexpected request {method} {url}")


network = FakeNetwork()
server.http_json = network.http_json


class Samples:
    def __init__(self):
        self.messages = {}
        self.rest = {}
        self.seen = set()

    def message(self, payload):
        if payload is None:
            return
        payload = json.loads(json.dumps(payload))
        key = json.dumps(shape(payload), sort_keys=True)
        if (payload["message_type"], key) in self.seen:
            return
        self.seen.add((payload["message_type"], key))
        self.messages.setdefault(payload["message_type"], []).append(payload)

    def body(self, group, payload, name=None):
        payload = json.loads(json.dumps(payload))
        key = json.dumps(shape(payload), sort_keys=True)
        if (group, name, key) in self.seen:
            return
        self.seen.add((group, name, key))
        bucket = self.rest.setdefault(group, {} if name else [])
        if name:
            bucket.setdefault(name, []).append(payload)
        else:
            bucket.append(payload)


# Values that select a variant: samples that differ in one of these are kept even when their shapes match.
DISCRIMINANTS = {"message_type", "type", "mode", "outcome", "reason_code", "reason", "state", "run_state", "kind", "command", "relative"}


def shape(value):
    """A value's structure — keys, value kinds and nulls, and the discriminating values — so samples
    that differ only in content aren't repeated."""
    if isinstance(value, dict):
        return {key: (item if key in DISCRIMINANTS and isinstance(item, (str, bool)) else shape(item)) for key, item in value.items()}
    if isinstance(value, list):
        shapes = []
        for item in value:
            item_shape = shape(item)
            if item_shape not in shapes:
                shapes.append(item_shape)
        return shapes
    return type(value).__name__


def materialize(pack, seed):
    template = controller.load_template(pack)
    manifest = controller.materialize(template, seed, scenario_key=f"protocol-sample-{seed}")
    # The incident happened a few minutes before the run was made, as it does live.
    return manifest


def new_session(pack, mode, seed=20261112, state="READY"):
    manifest = materialize(pack, seed)
    run = {"manifest": manifest, "state": "CREATED", "evidence": {"completed": 0, "required": max(1, len(manifest["scenario"]["provisioning"].get("readiness_validators", [])))}}
    network.runs[manifest["run_id"]] = run
    created = controller.public_state(run, include_manifest=True)
    session = server.create_session(created, mode)
    public_run = {key: value for key, value in created.items() if key != "manifest"}
    samples.body("create_run", {"run": public_run, "session": server.session_public(session, include_connection=True)})
    run.update(state=state, ready_at=server.now_iso(), evidence={"completed": run["evidence"]["required"], "required": run["evidence"]["required"], "validators": {
        item["id"]: {"ready": True, "value": 42, "minimum": item.get("minimum")} for item in manifest["scenario"]["provisioning"].get("readiness_validators", [])}})
    session["utc_offset_minutes"] = -60
    server.refresh_run_ready(session)
    return session


def action(session, action_type, details=None, state_after=None, actor=None, view=None):
    message = {"protocol_version": 2, "run_id": session["run_id"], "session_id": session["id"], "sequence": session["last_action_sequence"] + 1,
               "type": action_type, "actor": actor or ("tutorial" if session["mode"] == "demonstration" else "learner"),
               "observed_at": server.now_iso(), "details": details or {}, "state_before": {}, "state_after": state_after or {}}
    if view:
        message["view"] = view
    return message


def send_action(session, observed):
    """What the WebSocket loop does with an action: record it, reply, and send the next command."""
    try:
        evaluation = server.record_action(session, observed)
    except ValueError as error:
        samples.message(server.error_message(error))
        return None
    samples.message(server.action_result_message(session, observed, evaluation))
    samples.body("action_response", {"evaluation": server.learner_evaluation(session, evaluation), "session": server.learner_session(session)})
    if evaluation["goals_progressed"] and session["mode"] != "challenge":
        command = server.next_command(session)
        if command:
            samples.message(command)
        elif session["mode"] == "guided" and session["feedback"]:
            samples.message(server.complete_message(session))
    return evaluation


def reference_action(session, goal):
    """The browser's report of the goal's reference route: the matrix's accepted action, with a time
    window taken from the step's own (substituted) arguments so the absolute-time judge accepts it."""
    scenario = session["manifest"]["scenario"]
    observed = matrix.action_for(goal, scenario)
    reference = goal.get("reference_action", {})
    if reference.get("command") == "set_time_range":
        arguments = server.substitute(reference.get("arguments") or {}, session)
        if isinstance(arguments, dict) and arguments.get("from"):
            observed["details"].update({"from": arguments["from"], "to": arguments.get("to", "now")})
    if observed["type"] in server.IGNORED_ACTIONS or observed["type"] == "answer_submitted":
        return None
    return action(session, observed["type"], observed["details"], observed["state_after"])


def walk(session, extras=None):
    """Brief, then run the reference route step by step, sampling each command on the way."""
    samples.message(server.build_incident_briefing(session))
    session["briefing_acknowledged"] = True
    session["briefing_read_at"] = server.now_iso()
    server.transition_run(session, "INVESTIGATING")
    samples.message(server.next_command(session) or server.complete_message(session))
    for goal in server.playbook_goals(session):
        if goal["id"] in session["completed_goals"]:
            continue
        if goal.get("reference_action", {}).get("command") in {"request_answer", "request_diagnosis"}:
            break
        if extras:
            extras(session, goal)
        if session["mode"] == "guided":
            samples.message(server.next_hint(session))
            samples.message(server.check_in_reply(session, goal["id"]))
        observed = reference_action(session, goal)
        evaluation = send_action(session, observed) if observed else None
        if goal["id"] not in session["completed_goals"]:
            # The sampler only needs the commands that follow; a route the fakes can't satisfy moves on.
            session["completed_goals"].add(goal["id"])
            session["pending_command"] = None
            samples.message(server.next_command(session))
        if evaluation is None and observed is None:
            continue


def answer_for(session):
    truth = server.substitute(session["manifest"]["scenario"]["truth"], session)
    return {**truth.get("answers", {}), "evidence": "The reference route established every declared assertion.", "client_utc_offset_minutes": -60}


def finish(session):
    """Complete the session as its mode does, and sample its feedback and what follows."""
    if session["mode"] == "guided":
        if session["feedback"]:
            samples.body("feedback", session["feedback"], "guided")
        return
    command = server.next_command(session)
    samples.message(command)
    feedback = server.submit_answer(session, answer_for(session))
    samples.body("feedback", feedback, session["mode"])
    samples.message(server.complete_message(session))


def detours(session, goal):
    """The dead ends a learner can reach on the way, each where it can happen, then put right so the
    reference route carries on: a window that misses the incident, a later window that leaves it out,
    an earned filter removed, a search with no results, a stray column, and a relative window that
    slides past the incident while the learner works."""
    restore = server.restore_state(session)
    window = restore["time"] or restore["baseline_time"] or {"from": "now-1h", "to": "now"}
    send_action(session, action(session, "time_range_changed", {"from": "now-1m", "to": "now"}, {"time_from": "now-1m", "time_to": "now"}))
    if not server.scope_complete(session):
        ended = server.iso_instant(datetime.now(timezone.utc) - timedelta(hours=3))
        send_action(session, action(session, "time_range_changed", {"from": "now-15m", "to": ended}))
    else:
        send_action(session, action(session, "time_range_changed", dict(window)))
    if restore["filters"]:
        lost = dict(restore["filters"][0])
        send_action(session, action(session, "filter_removed", lost, {"filters": [], "query": ""}))
        send_action(session, action(session, "filter_added", lost, {"filters": restore["filters"], "query": restore["query"] or ""}))
    send_action(session, action(session, "query_submitted", {"query": "http.response.status_code is 999", "language": "kql"},
                                {"query": "http.response.status_code is 999", "query_language": "kql", "result_count": 0, "filters": restore["filters"]},
                                view={"app": "discover", "time_from": window["from"], "time_to": window.get("to", "now"), "language": "kql",
                                      "query": "http.response.status_code is 999", "filters": restore["filters"]}))
    send_action(session, action(session, "column_added", {"field": "host.name"}))
    if goal.get("reference_action", {}).get("command") == "expand_document" and server.scope_complete(session):
        # The coach's watch on a relative window, then the service's reply once it has slid.
        send_action(session, action(session, "time_range_changed", {"from": "now-20m", "to": "now"}))
        created = datetime.fromisoformat(session["manifest"]["created_at"])
        session["manifest"]["created_at"] = (created - timedelta(minutes=45)).isoformat()
        samples.message(server.window_check_reply(session))
        send_action(session, action(session, "column_added", {"field": "trace.id"}))
        session["manifest"]["created_at"] = created.isoformat()
        send_action(session, action(session, "time_range_changed", dict(window)))


def build():
    catalog = json.loads((ROOT / "learning" / "catalog.json").read_text(encoding="utf-8"))
    packs = [entry["id"] for entry in catalog["scenarios"] if entry["classification"] == "core"]
    for pack in packs:
        for mode in ("demonstration", "guided", "challenge"):
            session = new_session(pack, mode)
            walk(session, detours if mode != "demonstration" else None)
            finish(session)
            samples.body("session_status", server.session_status(session))
            # A reload after completion: the service says the session is complete.
            samples.message(server.complete_message(session))
            samples.body("run", controller.public_state(network.runs[session["run_id"]]))
    # Hints: none for the step, and hints off in a challenge.
    session = new_session("http-error-regression", "guided")
    goals = server.playbook_goals(session)
    hinted = copy.deepcopy(goals[0])
    hinted["hints"] = []
    session["playbook"]["goals"] = [hinted, *goals[1:]]
    samples.message(server.next_hint(session))
    challenge = new_session("http-error-regression", "challenge")
    samples.message(server.next_hint(challenge))
    # A briefing before the browser's offset is known, and a stale action the service rejects.
    briefed = new_session("discover-time-window", "demonstration")
    briefed.pop("utc_offset_minutes", None)
    samples.message(server.build_incident_briefing(briefed))
    send_action(briefed, {**action(briefed, "column_added", {"field": "x"}), "sequence": 0})
    # Pause and resume, and a command acknowledgement.
    samples.message(server.status_message(True))
    samples.message(server.status_message(False))
    samples.message(server.acknowledged_message(server.next_command(briefed)["command_id"]))
    # Runs in every state the launcher and the coach may meet, and the runs that can't be investigated.
    for state, extra in (("CREATED", {}), ("ACTIVATING", {}), ("WARMING", {"evidence": {"completed": 1, "required": 3, "validators": {"signal": {"ready": True, "value": 42, "minimum": 20}}}}),
                         ("READY", {"ready_at": server.now_iso()}), ("INVESTIGATING", {}), ("COMPLETED", {"completed_at": server.now_iso()}),
                         ("FAILED", {"error": "scenario readiness timed out: {}"}), ("ABORTED", {"completed_at": server.now_iso()})):
        doomed = new_session("rare-error-signature", "guided", state=state)
        network.runs[doomed["run_id"]].update(state=state, **extra)
        samples.body("run", controller.public_state(network.runs[doomed["run_id"]]))
        server.refresh_run_ready(doomed)
        samples.body("session_status", server.session_status(doomed))
        reason = server.run_unavailable(doomed)
        if reason:
            samples.message(server.failed_message(doomed, reason))
    missing = new_session("rare-error-signature", "challenge")
    del network.runs[missing["run_id"]]
    server.refresh_run_ready(missing)
    samples.message(server.failed_message(missing, server.run_unavailable(missing)))
    samples.message(server.failed_message(missing, "timeout"))
    samples.body("session_status", server.session_status(missing))
    for error in ("run not found", "session not found", "invalid controller token", "feedback is not available yet",
                  "finish the guided investigation steps first", "run evidence is not ready", "mode must be demonstration, guided, or challenge"):
        samples.body("error", {"error": error})
    samples.body("error", {"error": "session not found", "launcher_url": server.LAUNCHER_URL})

    missing_types = SOURCE_MESSAGE_TYPES - set(samples.messages)
    if missing_types:
        raise SystemExit(f"server.py can send message types the generator never sampled: {sorted(missing_types)}")
    return {"server_messages": samples.messages, "rest": samples.rest}


samples = Samples()


def render(data):
    body = json.dumps(data, indent=1, ensure_ascii=False)
    return ("// Generated by scripts/generate-protocol-samples.py from learning-service/server.py. Do not edit.\n"
            "import type {ProtocolSamples} from '../protocol';\n\n"
            f"export const samples = {body} satisfies ProtocolSamples;\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--json", action="store_true", help="print the samples as JSON instead of writing the TypeScript module")
    parser.add_argument("--out", type=Path, default=OUTPUT)
    args = parser.parse_args()
    data = build()
    if args.json:
        print(json.dumps(data, indent=1))
        return
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render(data), encoding="utf-8")
    counts = {key: len(value) for key, value in data["server_messages"].items()}
    print(f"wrote {args.out.relative_to(ROOT)}: {sum(counts.values())} WebSocket samples {counts}, REST groups {sorted(data['rest'])}")


if __name__ == "__main__":
    main()
