"""Runs the launcher prepares while the learner is still choosing (learning-service/server.py).

The launcher prepares the selected card with the key on screen, so Start only attaches a session. These
tests drive the learning service's real HTTP handler against a fake scenario controller.
"""

import importlib.util
import json
import sys
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "learning-service"))
sys.path.insert(0, str(ROOT / "learning-service" / "engine"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


controller = load_module("prepared_runs_controller", ROOT / "scenario-controller/controller.py")
server = load_module("prepared_runs_server", ROOT / "learning-service/server.py")
server.LEARNING_DIR = ROOT / "learning"


class FakeController:
    """The controller's run endpoints: create, read state, delete."""

    def __init__(self):
        self.created = []
        self.deleted = []
        self.states = {}
        self.lock = threading.Lock()

    def http_json(self, url, method="GET", payload=None, timeout=10):
        path = url.removeprefix(server.CONTROLLER_URL)
        if path == "/api/runs" and method == "POST":
            with self.lock:
                number = len(self.created)
                run_id = f"run-{number:012x}"
                self.created.append((run_id, payload))
            template = json.loads((ROOT / "learning/scenarios" / payload["scenario"] / "scenario.json").read_text())
            manifest = controller.materialize(template, 4242 + number, run_id=run_id)
            return 202, {"run_id": run_id, "state": "CREATED", "manifest": manifest}
        if path.startswith("/api/runs/") and method == "DELETE":
            with self.lock:
                self.deleted.append(path.rsplit("/", 1)[1])
            return 200, {"deleted": True}
        if path.startswith("/api/runs/"):
            return 200, {"state": self.states.get(path.rsplit("/", 1)[1], "READY")}
        return 404, {"error": "not found"}

    def wait_deleted(self, run_id, timeout=2.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if run_id in self.deleted:
                    return True
            time.sleep(0.01)
        return False


class PreparedRunTests(unittest.TestCase):
    def setUp(self):
        server.prepared_runs.clear()
        self.fake = FakeController()
        self.patch = mock.patch.object(server, "http_json", self.fake.http_json)
        self.patch.start()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.patch.stop()
        server.prepared_runs.clear()

    def post(self, path, payload):
        request = Request(f"http://127.0.0.1:{self.httpd.server_address[1]}{path}", data=json.dumps(payload).encode(),
                          method="POST", headers={"Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def prepare(self, scenario="http-error-regression", key="quiet-river-signal"):
        status, body = self.post("/api/runs", {"scenario": scenario, "scenario_key": key, "prepare": True})
        self.assertEqual(status, 202, body)
        self.assertTrue(body["prepared"])
        self.assertNotIn("session", body)
        self.assertNotIn("manifest", body["run"])
        return body["run"]["run_id"]

    def test_start_takes_the_run_prepared_for_its_card_and_key(self):
        run_id = self.prepare()
        status, body = self.post("/api/runs", {"scenario": "http-error-regression", "scenario_key": "quiet-river-signal",
                                               "mode": "demonstration", "prepared_run_id": run_id})
        self.assertEqual(status, 202, body)
        self.assertTrue(body["prepared"])
        self.assertEqual(body["run"]["run_id"], run_id)
        self.assertEqual(body["session"]["mode"], "demonstration")
        self.assertEqual(len(self.fake.created), 1)  # no second run was made
        self.assertNotIn(run_id, server.prepared_runs)  # a claimed run is never handed out twice
        self.assertEqual(self.fake.deleted, [])

    def test_a_run_prepared_for_another_card_or_key_is_let_go_and_start_prepares_afresh(self):
        for change in ({"scenario": "auth-rejection-surge", "scenario_key": "quiet-river-signal"},
                       {"scenario": "http-error-regression", "scenario_key": "bright-garden-otter"}):
            run_id = self.prepare()
            with self.subTest(change=change):
                status, body = self.post("/api/runs", {**change, "mode": "guided", "prepared_run_id": run_id})
                self.assertEqual(status, 202, body)
                self.assertFalse(body["prepared"])
                self.assertNotEqual(body["run"]["run_id"], run_id)
                self.assertTrue(self.fake.wait_deleted(run_id))

    def test_a_stale_or_failed_prepared_run_is_never_handed_out(self):
        run_id = self.prepare()
        server.prepared_runs[run_id]["at"] -= server.PREPARED_RUN_MAX_AGE_SECONDS + 1
        status, body = self.post("/api/runs", {"scenario": "http-error-regression", "scenario_key": "quiet-river-signal", "mode": "guided", "prepared_run_id": run_id})
        self.assertFalse(body["prepared"])
        self.assertTrue(self.fake.wait_deleted(run_id))

        run_id = self.prepare()
        self.fake.states[run_id] = "FAILED"
        status, body = self.post("/api/runs", {"scenario": "http-error-regression", "scenario_key": "quiet-river-signal", "mode": "guided", "prepared_run_id": run_id})
        self.assertEqual(status, 202, body)
        self.assertFalse(body["prepared"])
        self.assertTrue(self.fake.wait_deleted(run_id))

    def test_the_launcher_can_discard_only_a_run_still_waiting_unclaimed(self):
        run_id = self.prepare()
        status, _body = self.post(f"/api/runs/{run_id}/discard", {})
        self.assertEqual(status, 202)
        self.assertTrue(self.fake.wait_deleted(run_id))
        # Claimed (or never prepared) runs are not the launcher's to discard.
        claimed = self.prepare()
        self.post("/api/runs", {"scenario": "http-error-regression", "scenario_key": "quiet-river-signal", "mode": "guided", "prepared_run_id": claimed})
        status, _body = self.post(f"/api/runs/{claimed}/discard", {})
        self.assertEqual(status, 404)
        self.assertFalse(self.fake.wait_deleted(claimed, timeout=0.3))

    def test_waiting_runs_are_capped_and_expire(self):
        ids = [self.prepare(key=f"quiet-river-signal-{index}") for index in range(server.MAX_PREPARED_RUNS + 1)]
        self.assertTrue(self.fake.wait_deleted(ids[0]))  # the oldest made room
        self.assertEqual(set(server.prepared_runs), set(ids[1:]))
        later = time.monotonic() + server.PREPARED_RUN_MAX_AGE_SECONDS + 1
        self.assertEqual(set(server.expired_prepared(later)), set(ids[1:]))
        self.assertEqual(server.prepared_runs, {})

    def test_only_scenarios_that_write_nothing_shared_are_prepared_ahead(self):
        catalog = json.loads((ROOT / "learning/catalog.json").read_text())
        for entry in catalog["scenarios"]:
            if entry.get("track") == "mvp":
                self.assertTrue(server.preparable(entry["id"]), entry["id"])
        # A live fault (slow-payments) or a managed alert rule (active-alert-triage) touches other runs.
        for scenario in ("slow-payments", "active-alert-triage", "no-such-scenario"):
            self.assertFalse(server.preparable(scenario), scenario)
            status, _body = self.post("/api/runs", {"scenario": scenario, "scenario_key": "quiet-river-signal", "prepare": True})
            self.assertEqual(status, 422)
        self.assertEqual(self.fake.created, [])


if __name__ == "__main__":
    unittest.main()
