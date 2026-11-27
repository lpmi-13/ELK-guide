"""A search step is judged on the records it leaves on screen, not on the form the search took.

A pill, a query or Add filter that keep the same records all finish the step; a search that keeps more
(``status_code >= 450`` where 4xx responses exist) or fewer does not, however its text reads. The
learning service measures both searches in the learner's own window (``outcome_evidence``); the
evaluator lets that measurement decide.
"""

import importlib.util
import io
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "learning-service"))
sys.path.insert(0, str(ROOT / "learning-service" / "engine"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


controller = load_module("scenario_controller_outcome", ROOT / "scenario-controller/controller.py")
server = load_module("learning_server_outcome", ROOT / "learning-service/server.py")
server.LEARNING_DIR = ROOT / "learning"
evaluator = sys.modules["engine.evaluator"]


def session_at(pack, step_id, seed=4, mode="guided"):
    template = json.loads((ROOT / "learning/scenarios" / pack / "scenario.json").read_text())
    manifest = controller.materialize(template, seed, run_id=f"run-{seed:012d}")
    session = server.create_session({"manifest": manifest}, mode)
    goals = session["playbook"]["goals"]
    session["completed_goals"] = {goal["id"] for goal in goals[:[goal["id"] for goal in goals].index(step_id)]}
    return session


class FakeSearch:
    """Stands in for Elasticsearch's _msearch: answers the three counts and keeps what was asked."""

    def __init__(self, counts):
        self.counts = counts
        self.requests = []

    def __call__(self, request, timeout=None):
        lines = [json.loads(line) for line in request.data.decode().splitlines() if line]
        self.requests.append(lines)
        body = json.dumps({"responses": [{"hits": {"total": {"value": count}}} for count in self.counts]}).encode()
        response = io.BytesIO(body)
        response.__enter__ = lambda *_: response
        response.__exit__ = lambda *_: None
        return response


class OutcomeEvaluationTests(unittest.TestCase):
    def evaluate(self, session, action, outcome):
        evidence = {"assertions": {item["id"]: True for item in session["manifest"]["scenario"]["truth"]["assertions"]}, "outcome": outcome}
        return evaluator.evaluate_action({**session, "completed_goals": set(session["completed_goals"])}, action, evidence)

    def test_the_same_records_finish_the_step_whatever_the_method(self):
        session = session_at("log-pattern-noise-reduction", "warning")
        match = {"goal": "warning", "match": True, "learner": 64, "expected": 64, "both": 64}
        # A pill on the warning's .keyword field, which no form validator of this step names.
        pill = {"type": "filter_added", "actor": "learner", "details": {"field": "message.keyword", "value": "x", "negate": False}}
        self.assertEqual(self.evaluate(session, pill, match)["goals_progressed"], ["warning"])
        removed = {"type": "filter_removed", "actor": "learner", "details": {"field": "event.outcome", "value": "failure"}}
        self.assertEqual(self.evaluate(session, removed, match)["goals_progressed"], ["warning"])

    def test_a_wider_search_does_not_finish_the_step_however_it_reads(self):
        session = session_at("http-error-regression", "errors")
        wider = {"type": "query_submitted", "actor": "learner", "details": {"query": "http.response.status_code >= 450"}}
        result = self.evaluate(session, wider, {"goal": "errors", "match": False, "learner": 46, "expected": 40, "both": 40})
        self.assertEqual(result["goals_progressed"], [])
        self.assertEqual(result["outcome"], "drift")
        self.assertIn("6 records this step should leave out", result["note"])

    def test_a_narrower_search_is_told_what_it_left_out(self):
        session = session_at("log-pattern-noise-reduction", "failures")
        narrower = {"type": "query_submitted", "actor": "learner", "details": {"query": "event.outcome: failure and service.name: auth"}}
        result = self.evaluate(session, narrower, {"goal": "failures", "match": False, "learner": 20, "expected": 87, "both": 20})
        self.assertEqual(result["goals_progressed"], [])
        self.assertIn("keeps 20 of the 87 records", result["note"])

    def test_without_a_measurement_the_steps_own_checks_decide(self):
        session = session_at("log-pattern-noise-reduction", "failures")
        query = {"type": "query_submitted", "actor": "learner", "details": {"query": "event.outcome: failure"}}
        self.assertEqual(self.evaluate(session, query, None)["goals_progressed"], ["failures"])


class OutcomeMeasurementTests(unittest.TestCase):
    def measure(self, session, view, action, counts=(10, 10, 10)):
        session["view"] = view
        fake = FakeSearch(counts)
        original = server.urlopen
        server.urlopen = fake
        try:
            return server.outcome_evidence(session, action), fake
        finally:
            server.urlopen = original

    def test_the_reference_search_is_the_earned_search_with_the_steps_own_change(self):
        # The warning step's reference replaces the failures query with the warning's phrase: no pills,
        # so a learner's leftover failures pill makes their records differ.
        session = session_at("log-pattern-noise-reduction", "warning")
        fragment = session["manifest"]["parameters"]["incident"]["exclude_fragment"]
        view = {"time_from": "now-15m", "time_to": "now", "language": "kql", "query": "",
                "filters": [{"field": "event.outcome.keyword", "value": "failure", "negate": False}, {"field": "message.keyword", "value": "x", "negate": False}]}
        outcome, fake = self.measure(session, view, {"type": "filter_added", "actor": "learner"}, counts=(5, 64, 5))
        self.assertEqual(outcome, {"goal": "warning", "learner": 5, "expected": 64, "both": 5, "match": False})
        learner, reference = fake.requests[0][1]["query"], fake.requests[0][3]["query"]
        self.assertIn({"match_phrase": {"event.outcome.keyword": "failure"}}, learner["bool"]["filter"])
        self.assertIn({"match_phrase": {"message": fragment}}, json.loads(json.dumps(reference["bool"]["filter"])))
        self.assertIn({"range": {"@timestamp": {"gte": "now-15m", "lte": "now"}}}, reference["bool"]["filter"])
        self.assertEqual(fake.requests[0][0]["index"], f"lab-{session['run_id']}")

    def test_equal_counts_everywhere_are_a_match_and_an_empty_reference_never_is(self):
        session = session_at("deployment-version-regression", "failures")
        view = {"time_from": "now-20m", "time_to": "now", "language": "kql", "query": "event.outcome: failure", "filters": [{"field": "service.name", "value": "x", "negate": False}]}
        self.assertTrue(self.measure(session, view, {"type": "query_submitted", "actor": "learner"})[0]["match"])
        self.assertFalse(self.measure(session, view, {"type": "query_submitted", "actor": "learner"}, counts=(0, 0, 0))[0]["match"])

    def test_steps_that_are_not_searches_and_the_coachs_own_actions_are_not_measured(self):
        session = session_at("log-pattern-noise-reduction", "survey")
        view = {"time_from": "now-15m", "time_to": "now", "language": "kql", "query": "", "filters": []}
        self.assertIsNone(self.measure(session, view, {"type": "query_submitted", "actor": "learner"})[0])
        session = session_at("log-pattern-noise-reduction", "warning")
        self.assertIsNone(self.measure(session, view, {"type": "query_submitted", "actor": "tutorial"})[0])
        # An answer that is an empty search: every empty search would "match", so its own checks decide.
        session = session_at("auth-rejection-surge", "confined")
        self.assertIsNone(self.measure(session, view, {"type": "query_submitted", "actor": "learner"})[0])


class ClientErrorDataTests(unittest.TestCase):
    def test_the_server_errors_pack_has_client_errors_that_a_search_from_450_would_keep(self):
        """`status_code >= 450` and `>= 500` differ only if there are 4xx responses where the step looks:
        after the first guess is left out, inside the window the coach recommends."""
        for seed in range(12):
            template = json.loads((ROOT / "learning/scenarios/http-error-regression/scenario.json").read_text())
            manifest = controller.materialize(template, seed, run_id=f"run-{seed:012d}")
            incident = manifest["parameters"]["incident"]
            created = datetime.fromisoformat(manifest["created_at"])
            documents = controller.generate_seeded_events(manifest)
            field = incident["signal_field"]
            client_errors = [document for document in documents
                             if 450 <= int(controller._lookup_nested(document, "http.response.status_code") or 0) < 500
                             and str(controller._lookup_nested(document, field)) not in {str(incident["decoy"]), str(incident["finding"])}
                             and created - datetime.fromisoformat(document["@timestamp"]) <= timedelta(minutes=9)]
            with self.subTest(seed=seed):
                self.assertGreaterEqual(len(client_errors), 2)


if __name__ == "__main__":
    unittest.main()
