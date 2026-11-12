"""The learning service's protocol with the coach and the launcher, checked without Docker.

Samples come from the real server code (scripts/generate-protocol-samples.py). These tests check that
every message type the server sends is declared in kibana-coach/protocol/protocol.d.ts and handled by
the coach, that the launcher reads only fields the server sends, and — when kibana-coach's TypeScript
is installed (`npm ci` in kibana-coach/) — that every sample satisfies the strict declaration. They
also drive the real HTTP/WebSocket server in-process for the session-ending and replay paths.
"""

import base64
import importlib.util
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
COACH = ROOT / "kibana-coach"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


generator = load_module("protocol_sample_generator", ROOT / "scripts" / "generate-protocol-samples.py")
SAMPLES = generator.build()
server = generator.server
controller = generator.controller
DECLARATION = (COACH / "protocol" / "protocol.d.ts").read_text(encoding="utf-8")


def declared_message_types():
    """The message_type of every ServerMessage member in protocol.d.ts."""
    union = re.search(r"export type ServerMessage =([^;]+);", DECLARATION).group(1)
    members = re.findall(r"\b([A-Z]\w+)\b", union)
    types = set()
    for member in members:
        alias = re.search(rf"export type {member} = ([^;]+);", DECLARATION)
        names = re.findall(r"\b([A-Z]\w+)\b", alias.group(1)) if alias else [member]
        for name in names:
            body = re.search(rf"interface {name}\b[^{{]*\{{(.*?)\n\}}", DECLARATION, re.S)
            if body:
                types.update(re.findall(r"message_type: '([a-z_]+)'", body.group(1)))
            base = re.search(rf"interface {name} extends (\w+)", DECLARATION)
            if base:
                parent = re.search(rf"interface {base.group(1)}\b[^{{]*\{{(.*?)\n\}}", DECLARATION, re.S)
                types.update(re.findall(r"message_type: '([a-z_]+)'", parent.group(1)) if parent else [])
    return types


class ProtocolSampleTests(unittest.TestCase):
    def test_every_message_the_server_sends_is_sampled_and_declared(self):
        sent = generator.SOURCE_MESSAGE_TYPES
        self.assertEqual(set(SAMPLES["server_messages"]), sent)
        self.assertEqual(declared_message_types(), sent)

    def test_the_coach_handles_every_declared_message(self):
        client = (COACH / "src" / "session-client.js").read_text(encoding="utf-8")
        for message_type in generator.SOURCE_MESSAGE_TYPES:
            self.assertIn(f"case '{message_type}':", client, message_type)
        # The switch is exhaustive: a declared variant it lacks is a type error (see test below).
        self.assertIn("/** @type {never} */", client)

    def test_samples_cover_each_mode_and_the_session_lifecycle(self):
        commands = SAMPLES["server_messages"]["command"]
        self.assertEqual({command["mode"] for command in commands}, {"demonstration", "guided", "challenge"})
        self.assertIn("show_debrief", {command["type"] for command in commands})
        self.assertTrue(any(command.get("walkthrough") for command in commands))
        results = SAMPLES["server_messages"]["action_result"]
        self.assertTrue({"accepted", "observed", "drift", "dead_end", "recorded"} <= {result["evaluation"]["outcome"] for result in results})
        reasons = {result["evaluation"].get("reason_code") for result in results}
        self.assertTrue({"empty_result", "lost_earned_state", "window_misses_incident", "window_excludes_incident"} <= reasons)
        self.assertTrue(any("window_watch" in result for result in results))
        self.assertEqual({item["reason"] for item in SAMPLES["server_messages"]["failed"]}, {"failed", "aborted", "missing", "timeout"})
        self.assertEqual({run["state"] for run in SAMPLES["rest"]["run"]},
                         {"CREATED", "ACTIVATING", "WARMING", "READY", "INVESTIGATING", "COMPLETED", "FAILED", "ABORTED"})
        self.assertEqual(set(SAMPLES["rest"]["feedback"]), {"guided", "challenge", "demonstration"})

    def test_a_guided_walkthrough_without_a_focus_sends_null_not_an_empty_string(self):
        for command in SAMPLES["server_messages"]["command"]:
            walkthrough = command.get("walkthrough")
            if walkthrough:
                self.assertTrue(walkthrough["evidence_focus"] is None or isinstance(walkthrough["evidence_focus"], dict), command["command_id"])
                self.assertIsInstance(walkthrough["learning_focus"], list, command["command_id"])

    def test_the_launcher_reads_only_fields_the_server_sends(self):
        launcher = (ROOT / "telemetry" / "index.html").read_text(encoding="utf-8")
        run_fields = set(SAMPLES["rest"]["run"][0])
        for field in set(re.findall(r"\brun\.(\w+)", launcher)):
            self.assertIn(field, run_fields, f"launcher reads run.{field}")
        session_fields = set(SAMPLES["rest"]["create_run"][0]["session"])
        for field in set(re.findall(r"sessionConnection\.(\w+)", launcher)) | set(re.findall(r"result\.session\.(\w+)", launcher)):
            self.assertIn(field, session_fields, f"launcher reads session.{field}")

    @unittest.skipUnless((COACH / "node_modules" / ".bin" / "tsc").exists() and shutil.which("node"),
                         "kibana-coach's TypeScript is not installed (run `npm ci` in kibana-coach/)")
    def test_samples_and_coach_satisfy_the_strict_declaration(self):
        result = subprocess.run(["npm", "run", "-s", "check:protocol"], cwd=COACH, capture_output=True, text=True, timeout=600)
        self.assertEqual(result.returncode, 0, result.stdout[-4000:] + result.stderr[-2000:])


class FakeController:
    """The scenario controller's HTTP API, as far as the learning service calls it."""

    def __init__(self):
        self.calls = []
        self.network = generator.FakeNetwork()

    def http_json(self, url, method="GET", payload=None, timeout=10):
        self.calls.append((method, url))
        if url.endswith("/reset"):
            return 400, {"error": "should not be reached"}
        return self.network.http_json(url, method, payload, timeout)


class LiveServer:
    """learning-service/server.py's real handler on an ephemeral port."""

    def __enter__(self):
        self.fake = FakeController()
        self.patch = patch.object(server, "http_json", self.fake.http_json)
        self.patch.start()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *_exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.patch.stop()

    def session(self, pack="http-error-regression", mode="guided", state="READY"):
        manifest = generator.materialize(pack, 4242)
        run = {"manifest": manifest, "state": state, "evidence": {"completed": 1, "required": 1}}
        self.fake.network.runs[manifest["run_id"]] = run
        return server.create_session(controller.public_state(run, include_manifest=True), mode)

    def request(self, path, method="GET", payload=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(payload).encode() if payload is not None else None, method=method, headers=headers)
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def websocket(self, session):
        connection = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        connection.sendall((f"GET /api/sessions/{session['id']}/events?token={session['controller_token']}&utc_offset=0 HTTP/1.1\r\n"
                            f"Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                            "Sec-WebSocket-Version: 13\r\n\r\n").encode())
        response = b""
        while b"\r\n\r\n" not in response:
            response += connection.recv(1)
        assert b" 101 " in response.split(b"\r\n")[0], response
        return WebSocket(connection)


class WebSocket:
    def __init__(self, connection):
        self.connection = connection

    def send(self, payload):
        data = json.dumps(payload).encode()
        mask = os.urandom(4)
        header = bytes([0x81]) + (bytes([0x80 | len(data)]) if len(data) < 126 else bytes([0x80 | 126]) + struct.pack("!H", len(data)))
        self.connection.sendall(header + mask + bytes(byte ^ mask[index % 4] for index, byte in enumerate(data)))

    def receive(self):
        opcode, data = server.read_frame(self.connection)
        if opcode is None:
            return None
        return json.loads(data)

    def close(self):
        self.connection.close()


class SessionEndingTests(unittest.TestCase):
    def test_an_aborted_run_fails_at_once_with_the_way_back(self):
        with LiveServer() as live:
            session = live.session(state="ABORTED")
            socket_ = live.websocket(session)
            message = socket_.receive()
            socket_.close()
        self.assertEqual((message["message_type"], message["reason"]), ("failed", "aborted"))
        self.assertTrue(message["launcher_url"].startswith("http"))

    def test_a_completed_session_stays_reviewable_after_its_run_is_replayed(self):
        with LiveServer() as live:
            session = live.session(mode="challenge")
            session["briefing_acknowledged"] = True
            server.refresh_run_ready(session)
            server.submit_answer(session, {"finding": "x"})
            live.fake.network.runs[session["run_id"]]["state"] = "ABORTED"
            socket_ = live.websocket(session)
            message = socket_.receive()
            socket_.close()
            status, body = live.request(f"/api/sessions/{session['id']}", token=session["controller_token"])
        self.assertEqual(message, {"message_type": "complete", "session_id": session["id"]})
        self.assertEqual((status, body["available"], body["feedback_available"]), (200, True, True))

    def test_a_rejected_action_is_reported_and_the_session_carries_on(self):
        with LiveServer() as live:
            session = live.session()
            socket_ = live.websocket(session)
            briefing = socket_.receive()
            socket_.send({"message_type": "briefing_ack", "briefing_id": briefing["briefing_id"]})
            command = socket_.receive()
            stale = {"protocol_version": 2, "run_id": session["run_id"], "session_id": session["id"], "sequence": 0,
                     "type": "column_added", "actor": "learner", "details": {"field": "x"}, "state_after": {}}
            socket_.send({"message_type": "action", "action": stale})
            error = socket_.receive()
            socket_.send({"message_type": "ack", "command_id": command["command_id"]})
            acknowledged = socket_.receive()
            socket_.close()
        self.assertEqual(briefing["message_type"], "incident_briefing")
        self.assertEqual(command["message_type"], "command")
        self.assertEqual(error, {"message_type": "error", "error": "action sequence must increase monotonically"})
        self.assertEqual(acknowledged, {"message_type": "acknowledged", "command_id": command["command_id"]})

    def test_an_unknown_session_answers_404_with_the_launcher_and_a_wrong_token_401(self):
        with LiveServer() as live:
            session = live.session()
            missing = live.request("/api/sessions/session-unknown", token="x")
            wrong = live.request(f"/api/sessions/{session['id']}", token="not-the-token")
            right = live.request(f"/api/sessions/{session['id']}", token=session["controller_token"])
        self.assertEqual(missing[0], 404)
        self.assertIn("launcher_url", missing[1])
        self.assertEqual(wrong[0], 401)
        self.assertEqual((right[0], right[1]["available"], right[1]["run_state"]), (200, True, "READY"))

    def test_a_replay_with_an_invalid_mode_never_reaches_the_controller(self):
        with LiveServer() as live:
            session = live.session()
            status, body = live.request(f"/api/runs/{session['run_id']}/reset", "POST", {"mode": "solo", "scenario_key": "quiet-river-signal"})
        self.assertEqual(status, 400)
        self.assertNotIn(("POST", f"{server.CONTROLLER_URL}/api/runs/{session['run_id']}/reset"), live.fake.calls)


class ControllerReplayTests(unittest.TestCase):
    def test_a_rejected_replay_key_leaves_the_existing_run_untouched(self):
        manifest = generator.materialize("http-error-regression", 777)
        run = {"manifest": manifest, "state": "COMPLETED", "evidence": {}, "stop": threading.Event()}
        controller.runs[manifest["run_id"]] = run
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), controller.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            with patch.object(controller, "stop_run") as stop_run:
                request = Request(f"http://127.0.0.1:{httpd.server_address[1]}/api/runs/{manifest['run_id']}/reset",
                                  data=json.dumps({"scenario_key": "short"}).encode(), method="POST", headers={"Content-Type": "application/json"})
                with self.assertRaises(HTTPError) as rejected:
                    urlopen(request, timeout=10)
            self.assertEqual(rejected.exception.code, 400)
            stop_run.assert_not_called()
            self.assertEqual(run["state"], "COMPLETED")
        finally:
            httpd.shutdown()
            httpd.server_close()
            controller.runs.pop(manifest["run_id"], None)


class SettlementTests(unittest.TestCase):
    """The observer marks a search whose results it never saw (result_settled: false); such an action
    is recorded but completes nothing, while the same action once settled does."""

    def session_at_isolate(self):
        session = generator.new_session("http-error-regression", "guided")
        session["briefing_acknowledged"] = True
        isolate = next(goal for goal in server.playbook_goals(session) if goal.get("reference_action", {}).get("command") in {"add_filter", "enter_kql"})
        for goal in server.playbook_goals(session):
            if goal["id"] == isolate["id"]:
                break
            session["completed_goals"].add(goal["id"])
        return session, isolate

    def test_an_unsettled_search_completes_nothing_and_a_settled_one_does(self):
        session, isolate = self.session_at_isolate()
        observed = generator.reference_action(session, isolate)
        observed["state_after"] = {**observed["state_after"], "result_settled": False}
        with patch.object(server, "transition_run"):
            evaluation = server.record_action(session, observed)
        self.assertEqual((evaluation["outcome"], evaluation["goals_progressed"]), ("observed", []))
        self.assertNotIn(isolate["id"], session["completed_goals"])
        settled = generator.reference_action(session, isolate)
        settled["state_after"] = {**settled["state_after"], "result_count": 12}
        with patch.object(server, "transition_run"):
            evaluation = server.record_action(session, settled)
        self.assertIn(isolate["id"], evaluation["goals_progressed"])


class CoachIsolationTests(unittest.TestCase):
    def test_presses_on_the_coach_do_not_close_kibanas_popovers(self):
        # Kibana closes an open popover on any mouse event reaching the document from outside it; the
        # browser audit caught Advance closing the date box mid-step. The coach stops its own presses.
        panel = (COACH / "src" / "ui" / "coach-panel.js").read_text(encoding="utf-8")
        isolation = re.search(r"for \(const type of \[([^\]]+)\]\) \{\s*this\.root\.addEventListener\(type, event => event\.stopPropagation\(\)\);", panel)
        self.assertIsNotNone(isolation)
        for event_type in ("mousedown", "mouseup", "pointerdown", "pointerup", "click"):
            self.assertIn(f"'{event_type}'", isolation.group(1))


def ended(run_id, state="COMPLETED"):
    return {"manifest": {"run_id": run_id}, "state": state, "stop": threading.Event()}


class FakeLabStack:
    """Kibana Spaces, Elasticsearch run data and service faults as the reclaim pass reads them."""

    def __init__(self, spaces=(), indices=(), aliases=(), data_streams=(), faults=None):
        self.spaces = [{"id": space} for space in spaces]
        self.resolved = {"indices": [{"name": name} for name in indices], "aliases": [{"name": name} for name in aliases],
                         "data_streams": [{"name": name} for name in data_streams]}
        self.faults = faults or {}
        self.cleared = []
        self.cleaned = {}

    def kibana_json(self, path, *args, **kwargs):
        return 200, self.spaces

    def http_json(self, url, method="GET", *args, **kwargs):
        if "/_resolve/index/" in url:
            return 200, self.resolved
        service = next(name for name, base in controller.SERVICE_URLS.items() if url.startswith(base))
        if url.endswith("/_control/state"):
            return 200, {"faults": {key: {} for key in self.faults.get(service, ())}}
        self.cleared.append((service, url.rsplit("scenario_id=", 1)[1]))
        return 200, {"cleared": True}

    def cleanup_run(self, run, delete_data=True):
        self.cleaned[run["manifest"]["run_id"]] = run

    def patches(self):
        return (patch.object(controller, "kibana_json", side_effect=self.kibana_json),
                patch.object(controller, "http_json", side_effect=self.http_json),
                patch.object(controller, "cleanup_run", side_effect=self.cleanup_run))


class OrphanReclaimTests(unittest.TestCase):
    def reclaim(self, stack, live):
        kibana, http, cleanup = stack.patches()
        with patch.dict(controller.runs, live, clear=True), kibana, http, cleanup:
            return controller.reclaim_orphaned_runs()

    def test_a_pass_removes_spaces_data_and_faults_no_live_run_owns(self):
        manifest = generator.materialize("http-error-regression", 99)
        live_id = manifest["run_id"]
        live_hex = live_id.removeprefix("run-")
        live = {"manifest": manifest, "state": "READY", "evidence": {}, "stop": threading.Event()}
        stack = FakeLabStack(
            spaces=["default", "team-space", manifest["space_id"], "lab-0123456789ab", "lab-notarunspace"],
            indices=[f"lab-{live_id}", "lab-run-00000000000d", "traces-apm.lab-run-00000000000d", "lab-run-notarun"],
            aliases=["lab-run-00000000000e", f"lab-{live_id}"],
            data_streams=["logs-apm.app.payments-lab00000000000d", f"metrics-system.cpu-lab{live_hex}", "logs-apm.lab-run-00000000000d", "logs-generic-default"],
            faults={"payments": ["run-00000000000f", live_id, "default"], "orders": ["run-0123456789ab"]},
        )
        reclaimed = self.reclaim(stack, {live_id: live})
        self.assertEqual(reclaimed, ["run-00000000000d", "run-00000000000e", "run-00000000000f", "run-0123456789ab"])
        self.assertEqual(sorted(stack.cleaned), reclaimed)
        self.assertNotIn(live_id, stack.cleaned)
        self.assertEqual(stack.cleaned["run-0123456789ab"]["manifest"]["space_id"], "lab-0123456789ab")
        self.assertEqual(stack.cleaned["run-00000000000d"]["data_streams"], ["logs-apm.app.payments-lab00000000000d", "logs-apm.lab-run-00000000000d"])
        self.assertEqual(sorted(stack.cleared), [("orders", "run-0123456789ab"), ("payments", "run-00000000000f")])

    def test_an_unreadable_space_list_is_an_error_not_an_empty_result(self):
        with patch.object(controller, "kibana_json", return_value=(503, {"error": "unavailable"})), \
                patch.object(controller, "cleanup_run") as cleanup:
            with self.assertRaises(RuntimeError):
                controller.reclaim_orphaned_runs()
        cleanup.assert_not_called()

    def test_a_caller_arriving_during_a_pass_gets_that_pass_instead_of_listing_again(self):
        listing_started, release = threading.Event(), threading.Event()
        listings = []

        def slow_listing(path, *args, **kwargs):
            listings.append(path)
            listing_started.set()
            release.wait(10)
            return 200, [{"id": "lab-00000000000a"}, {"id": "lab-00000000000b"}]

        results = {}
        with patch.dict(controller.runs, {}, clear=True), \
                patch.object(controller, "kibana_json", side_effect=slow_listing), \
                patch.object(controller, "runs_with_data", return_value={}), \
                patch.object(controller, "runs_with_faults", return_value={}), \
                patch.object(controller, "cleanup_run"):
            boot = threading.Thread(target=lambda: results.setdefault("boot", controller.reclaim_orphaned_runs()))
            boot.start()
            self.assertTrue(listing_started.wait(10))
            asked = threading.Thread(target=lambda: results.setdefault("asked", controller.reclaim_orphaned_runs()))
            asked.start()
            release.set()
            boot.join(10)
            asked.join(10)
        self.assertEqual(len(listings), 1)
        self.assertEqual(results["asked"], ["run-00000000000a", "run-00000000000b"])
        self.assertEqual(results["asked"], results["boot"])

    def test_the_reclaim_endpoint_reports_what_it_removed_and_fails_loudly(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), controller.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{httpd.server_address[1]}/api/orphans/reclaim"
        request = lambda: Request(url, data=b"{}", method="POST", headers={"Content-Type": "application/json"})
        try:
            with patch.object(controller, "reclaim_orphaned_runs", return_value=["run-0123456789ab"]):
                with urlopen(request(), timeout=10) as response:
                    self.assertEqual(json.load(response), {"reclaimed": ["run-0123456789ab"]})
            with patch.object(controller, "reclaim_orphaned_runs", side_effect=RuntimeError("Kibana did not list its Spaces (HTTP 503)")):
                with self.assertRaises(HTTPError) as failed:
                    urlopen(request(), timeout=10)
                self.assertEqual(failed.exception.code, 502)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_build_all_asks_the_controller_to_reclaim_after_starting_the_stack(self):
        script = (ROOT / "build-all.sh").read_text(encoding="utf-8")
        self.assertLess(script.index("docker compose up"), script.index("/api/orphans/reclaim"))
        self.assertIn("docker compose exec -T scenario-controller", script)
        self.assertIn("RECLAIM_ORPHANED_RUNS", script)


class RunLifecycleTests(unittest.TestCase):
    """A run stopped while it is being prepared ends with nothing of it left, and is never reported FAILED."""

    STEPS = ("create_space", "create_live_data_alias", "import_saved_objects", "bulk_seed", "activate_fault", "provision_managed_resources", "readiness")

    def prepare(self, stop_during=None, fail_during=None):
        manifest = generator.materialize("http-error-regression", 4242)
        manifest["scenario"]["provisioning"]["strategies"] = ["live-traffic", "saved-objects", "seeded-events", "managed-resource"]
        stop = threading.Event()
        run = {"manifest": manifest, "state": "CREATED", "evidence": {}, "stop": stop}
        calls, cleaned = [], []

        def step(name, result=None):
            def run_step(*args, **kwargs):
                calls.append(name)
                if name == stop_during:
                    stop.set()
                if name == fail_during:
                    raise RuntimeError(f"{name} failed")
                if name == "readiness" and stop.is_set():
                    return False, {}
                return result
            return run_step

        results = {"bulk_seed": {"documents": 1, "data_streams": []}, "provision_managed_resources": [], "readiness": (True, {"completed": 1})}
        patches = [patch.object(controller, name, side_effect=step(name, results.get(name))) for name in self.STEPS]
        patches += [patch.object(controller, "cleanup_run", side_effect=lambda run, delete_data=True: cleaned.append(run)),
                    patch.object(controller, "traffic_loop"),
                    patch.object(controller, "forget_after_retention")]
        with patch.dict(controller.runs, {manifest["run_id"]: run}, clear=True):
            for item in patches:
                item.start()
            try:
                controller.lifecycle(manifest, stop)
            finally:
                for item in reversed(patches):
                    item.stop()
        return run, calls, cleaned

    def test_a_run_stopped_mid_preparation_does_no_further_steps_and_is_cleaned_again(self):
        for step in self.STEPS[:-1]:
            with self.subTest(stopped_during=step):
                run, calls, cleaned = self.prepare(stop_during=step)
                self.assertEqual(calls[-1], step, "no step may start after the run was stopped")
                self.assertEqual(len(cleaned), 1, "what the step in flight created must be removed")
                self.assertNotIn(run["state"], {"WARMING", "READY", "FAILED"})

    def test_a_run_stopped_while_warming_is_not_reported_failed(self):
        run, calls, cleaned = self.prepare(stop_during="readiness")
        self.assertEqual(run["state"], "WARMING")
        self.assertNotIn("error", run)
        self.assertEqual(len(cleaned), 1)

    def test_a_real_failure_still_fails_cleans_up_and_is_forgotten_later(self):
        with patch.object(controller, "emit"):
            run, calls, cleaned = self.prepare(fail_during="bulk_seed")
        self.assertEqual(run["state"], "FAILED")
        self.assertIn("bulk_seed failed", run["error"])
        self.assertTrue(run["stop"].is_set())
        self.assertEqual(len(cleaned), 1)

    def test_an_unstopped_run_reaches_ready(self):
        with patch.object(controller, "emit"):
            run, calls, cleaned = self.prepare()
        self.assertEqual(run["state"], "READY")
        self.assertEqual(calls, list(self.STEPS))
        self.assertEqual(cleaned, [])


class ForgetRunTests(unittest.TestCase):
    def test_an_ended_run_and_its_manifest_are_forgotten_and_a_live_run_is_kept(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(controller, "MANIFEST_DIR", Path(directory)):
            for run_id in ("run-00000000000a", "run-00000000000b"):
                (Path(directory) / f"{run_id}.json").write_text("{}", encoding="utf-8")
            live = ended("run-00000000000b", state="READY")
            with patch.dict(controller.runs, {"run-00000000000a": ended("run-00000000000a", "ABORTED"), "run-00000000000b": live}, clear=True):
                self.assertTrue(controller.forget_run("run-00000000000a"))
                self.assertFalse(controller.forget_run("run-00000000000b"))
                self.assertFalse(controller.forget_run("run-00000000000c"))
                self.assertEqual(list(controller.runs), ["run-00000000000b"])
            self.assertEqual(sorted(path.name for path in Path(directory).iterdir()), ["run-00000000000b.json"])

    def test_stopping_or_completing_a_run_schedules_forgetting_it(self):
        run = ended("run-00000000000a", "READY")
        with patch.dict(controller.runs, {"run-00000000000a": run}, clear=True), \
                patch.object(controller, "cleanup_run"), patch.object(controller, "emit"), \
                patch.object(controller, "forget_after_retention") as forget:
            controller.stop_run("run-00000000000a")
        forget.assert_called_once_with("run-00000000000a")
        completed = ended("run-00000000000c")
        completed["manifest"] = {"run_id": "run-00000000000c"}
        with patch.dict(controller.runs, {"run-00000000000c": completed}, clear=True), \
                patch.object(controller, "COMPLETED_RETENTION_SECONDS", 0), patch.object(controller, "cleanup_run") as cleanup:
            controller.reclaim_after_retention(completed)
            self.assertNotIn("run-00000000000c", controller.runs)
        cleanup.assert_called_once()


class SessionRetentionTests(unittest.TestCase):
    def test_idle_sessions_without_a_coach_connected_are_dropped(self):
        now = server.time.monotonic()
        old = now - server.SESSION_RETENTION_SECONDS - 60
        sessions = {
            "session-idle": {"last_active": old, "open_sockets": 0},
            "session-connected": {"last_active": old, "open_sockets": 1},
            "session-recent": {"last_active": now, "open_sockets": 0},
            "session-untracked": {},
        }
        with patch.dict(server.sessions, sessions, clear=True):
            self.assertEqual(server.prune_sessions(), ["session-idle"])
            self.assertEqual(sorted(server.sessions), ["session-connected", "session-recent", "session-untracked"])

    def test_looking_a_session_up_marks_it_used(self):
        session = {"last_active": 0.0, "open_sockets": 0}
        with patch.dict(server.sessions, {"session-a": session}, clear=True):
            self.assertIs(server.lookup_session("session-a"), session)
            self.assertIsNone(server.lookup_session("session-gone"))
        self.assertGreater(session["last_active"], 0.0)

    def test_creating_a_session_prunes_idle_ones(self):
        with patch.object(server, "prune_sessions") as prune:
            session = server.create_session(generator.run_response("http-error-regression", 7) if hasattr(generator, "run_response") else {"manifest": generator.materialize("http-error-regression", 7)}, "guided")
        prune.assert_called_once()
        self.assertEqual(session["open_sockets"], 0)
        server.sessions.pop(session["id"], None)


class KibanaEventLogRetentionTests(unittest.TestCase):
    def test_each_boot_sets_the_event_log_retention_on_the_data_stream(self):
        calls = []
        with patch.object(controller, "http_json", side_effect=lambda url, method="GET", payload=None, **kwargs: calls.append((method, url, payload)) or (200, {})), \
                patch.object(controller, "emit"), patch.object(controller, "KIBANA_EVENT_LOG_RETENTION", "7d"):
            controller.ensure_lifecycle_management()
        self.assertIn(("PUT", f"{controller.ELASTICSEARCH_URL}/_data_stream/.kibana-event-log-ds/_lifecycle", {"data_retention": "7d"}), calls)
        self.assertFalse(any("_index_template/.kibana-event-log" in url for _, url, _ in calls), "Kibana's managed template is left alone")


if __name__ == "__main__":
    unittest.main()
