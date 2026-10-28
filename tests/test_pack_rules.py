"""Rules every scenario pack follows, MVP or not, so a pack is ready whenever its surface is.

The coach never gives an answer away before the learner's screen shows it, a step that picks
something checks what was picked, and answers are graded on the facts they state.
"""

import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "learning-service"))
sys.path.insert(0, str(ROOT / "learning-service" / "engine"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CATALOG = json.loads((ROOT / "learning/catalog.json").read_text())["scenarios"]

# Opening something (a document, a trace, the records behind a chart, an alert's reason) is the
# step itself; there is no value to get wrong. Every other observation picks something.
VALUE_FREE_ACTIONS = {
    "document_expanded", "trace_opened", "trace_sample_selected", "surrounding_documents_opened", "column_added",
    "panel_underlying_data_opened", "panel_drilldown_opened", "panel_inspected", "error_details_opened",
    "correlated_logs_opened", "metrics_logs_opened", "metric_period_compared", "alert_reason_inspected",
    "alert_history_inspected", "alert_source_opened", "answer_submitted", "auto_refresh_changed",
}
VALUE_CHECKS = {"query_contains", "filter_contains", "filter_excludes", "selected_value", "detail_equals", "result_contains",
                "time_range_contains", "query_language", "state_equals"}


class PackRuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_module("scenario_controller_rules", ROOT / "scenario-controller/controller.py")
        cls.server = load_module("learning_server_rules", ROOT / "learning-service/server.py")
        cls.server.LEARNING_DIR = ROOT / "learning"
        cls.matrix = load_module("scenario_matrix_rules", ROOT / "scripts/test-scenario-matrix.py")
        cls.evaluator = sys.modules["engine.evaluator"]

    def session(self, entry, seed, mode="guided"):
        template = json.loads((ROOT / "learning" / entry["pack"] / "scenario.json").read_text())
        manifest = self.controller.materialize(template, seed, run_id=f"run-{seed:012d}")
        return self.server.create_session({"manifest": manifest}, mode)

    def test_guided_copy_and_early_hints_never_name_the_answer(self):
        for entry in CATALOG:
            for seed in range(1, 6):
                session = self.session(entry, seed)
                truth = session["manifest"]["scenario"]["truth"]
                for goal in session["playbook"]["goals"]:
                    phrases = self.evaluator.answer_phrases(truth, self.server.substitute(goal.get("reference_action", {}).get("arguments"), session))
                    shown = [goal.get("title"), goal.get("narration"), goal.get("concept"), *goal.get("hints", [])[:-1]]
                    with self.subTest(pack=entry["id"], seed=seed, goal=goal["id"]):
                        for text in shown:
                            self.assertFalse(self.evaluator.reveals_answer(self.server.substitute(text or "", session), phrases), text)
                        # A demonstration says what it will do before it does it, never what it will find.
                        before = self.server.substitute((goal.get("demonstration") or {}).get("narration", ""), session)
                        self.assertFalse(self.evaluator.reveals_answer(before, self.evaluator.answer_phrases(truth, None)), before)

    def test_every_step_that_picks_something_checks_what_was_picked(self):
        for entry in CATALOG:
            session = self.session(entry, 3)
            for goal in session["playbook"]["goals"]:
                for route in goal["accepts"]:
                    actions = route["action"] if isinstance(route["action"], list) else [route["action"]]
                    if set(actions) <= VALUE_FREE_ACTIONS:
                        continue
                    with self.subTest(pack=entry["id"], goal=goal["id"], actions=actions):
                        self.assertTrue({validator["kind"] for validator in route["validators"]} & VALUE_CHECKS)

    def test_a_value_check_rejects_a_wrong_value(self):
        def wrong(route):
            mutated = copy.deepcopy(route)
            for validator in mutated["validators"]:
                if validator["kind"] in {"filter_contains", "filter_excludes", "selected_value", "detail_equals"} or (
                        validator["kind"] == "query_contains" and any(key in validator for key in ("value", "values", "value_from_truth", "values_from_truth"))):
                    for key in ("value", "values", "value_from_truth", "values_from_truth"):
                        validator.pop(key, None)
                    validator["value"] = "something-else"
            return mutated

        checked = 0
        for entry in CATALOG:
            session = self.session(entry, 4)
            scenario = session["manifest"]["scenario"]
            evidence = {"assertions": {item["id"]: True for item in scenario["truth"]["assertions"]}}
            goals = session["playbook"]["goals"]
            for index, goal in enumerate(goals):
                for route in goal["accepts"]:
                    kinds = {validator["kind"] for validator in route["validators"]}
                    if not kinds & {"filter_contains", "filter_excludes", "selected_value", "detail_equals", "query_contains", "result_contains"}:
                        continue
                    trial = {**session, "completed_goals": {item["id"] for item in goals[:index]}}
                    right = self.matrix.action_for({**goal, "accepts": [route]}, scenario)
                    right_evidence, wrong_evidence = evidence, evidence
                    if "result_contains" in kinds:
                        column = next(validator.get("column") for validator in route["validators"] if validator["kind"] == "result_contains")
                        right_evidence = {**evidence, "esql_result": {"columns": [column], "values": [[scenario["truth"]["answers"]["finding"]]]}}
                        wrong_evidence = {**evidence, "esql_result": {"columns": [column], "values": [["something-else"]]}}
                    mistaken = self.matrix.action_for({**goal, "accepts": [wrong(route)]}, scenario)
                    with self.subTest(pack=entry["id"], goal=goal["id"], route=route["action"]):
                        progressed = self.server.evaluate_action({**trial, "completed_goals": set(trial["completed_goals"])}, right, right_evidence)["goals_progressed"]
                        self.assertIn(goal["id"], progressed)
                        if mistaken != right or wrong_evidence is not evidence:
                            progressed = self.server.evaluate_action({**trial, "completed_goals": set(trial["completed_goals"])}, mistaken, wrong_evidence)["goals_progressed"]
                            self.assertNotIn(goal["id"], progressed, mistaken)
                            checked += 1
        self.assertGreater(checked, 30)

    def test_no_pack_asks_for_internal_evidence_ids(self):
        for path in [*(ROOT / "learning/scenarios").glob("*/*.json"), *(ROOT / "learning/templates").glob("*/*.json")]:
            with self.subTest(path=path.name):
                text = path.read_text()
                self.assertNotIn("evidence_refs", text)
                self.assertNotIn("evidence references", text)

    def test_dashboards_scope_a_window_from_when_the_problem_was_noticed(self):
        for entry in [item for item in CATALOG if item["surface"] == "dashboard"]:
            session = self.session(entry, 6)
            scope = session["playbook"]["goals"][0]
            expected = f"now-{self.server.recommended_window_minutes(session['detected_offset_minutes'])}m"
            with self.subTest(pack=entry["id"]):
                self.assertEqual(scope["reference_action"]["command"], "set_time_range")
                self.assertEqual(self.server.substitute(scope["reference_action"]["arguments"], session)["from"], expected)


class NonMvpAnswerTests(unittest.TestCase):
    """Every pack's answers are graded on the facts they state, in the learner's own words."""

    # (pack, an answer a reviewer would accept, the fields a plausible mistake gets wrong)
    CASES = [
        ("esql-top-failing-routes",
         {"finding": "/api/orders/confirm", "scope": "42 failed requests, a 93.3% failure rate", "conclusion": "/api/orders/confirm leads on both count and rate"},
         {"finding": "/api/orders", "scope": "42 failures at 72%"}),
        ("esql-before-after-deploy",
         {"finding": "v5.1.0", "scope": "p95 went from 180 ms to 980ms and errors from 0% to 100%", "conclusion": "5.1.0 made requests slower and every one failed"},
         {"finding": "5.0.9", "scope": "p95 210ms to 980ms"}),
        ("esql-cross-service-summary",
         {"finding": "payments", "scope": "45 failures, p95 of 1.4s", "conclusion": "Payments is the worst service"},
         {"finding": "orders", "scope": "45 failures"}),
        ("dashboard-incident-triage",
         {"finding": "eu-west-2", "scope": "checkout", "conclusion": "Checkout is failing in eu-west-2 right now"},
         {"finding": "eu-west-1", "conclusion": "Checkout is failing everywhere"}),
        ("dashboard-drilldown-to-evidence",
         {"finding": "orders", "scope": "/checkout", "conclusion": "The orders spike is CheckoutStateConflict failures"},
         {"finding": "checkout", "conclusion": "The spike is real"}),
        ("dashboard-panel-inspection",
         {"finding": "the failed transactions panel", "scope": "only transactions", "conclusion": "One counts all events including spans; failed transactions is the one to trust"},
         {"finding": "the all events panel", "conclusion": "The panels are both wrong"}),
        ("capacity-throughput-saturation",
         {"finding": "about 230 rps", "scope": "checkout", "conclusion": "Latency jumps once traffic passes ~220 rps"},
         {"finding": "around 120", "conclusion": "Checkout is slow at 120 rps"}),
        ("slow-dependency-trace",
         {"finding": "payments POST payments/authorize", "scope": "POST /checkout", "conclusion": "The payments call dominates checkout"},
         {"finding": "checkout", "conclusion": "Checkout itself is slow"}),
        ("trace-error-propagation",
         {"finding": "inventory, reserve stock span", "scope": "inventory -> orders -> api-gateway", "conclusion": "InventoryReservationRace in inventory surfaced as a gateway 502"},
         {"finding": "api-gateway", "conclusion": "The gateway is failing"}),
        ("retry-amplification",
         {"finding": "three attempts per request", "scope": "orders to payments", "conclusion": "Each checkout calls payments 3 times"},
         {"finding": "1 attempt", "scope": "orders to catalog"}),
        ("trace-log-correlation",
         {"finding": "IssuerTimeout", "scope": "payments authorize card", "conclusion": "The log shows the issuer timed out"},
         {"finding": "PaymentDeclined", "conclusion": "The card was declined"}),
        ("cpu-saturation",
         {"finding": "checkout-03", "scope": "checkout", "conclusion": "checkout-03 hit 97% CPU while latency rose"},
         {"finding": "checkout-01", "conclusion": "Memory on checkout-01 caused it"}),
        ("memory-leak-and-restarts",
         {"finding": "catalog-7d8f", "scope": "memory climbed to 94%", "conclusion": "catalog-7d8f memory rose until it restarted"},
         {"finding": "catalog-1a2b", "conclusion": "CPU spiked"}),
        ("hot-instance-imbalance",
         {"finding": "orders-04", "scope": "the other instances stayed under 40% CPU", "conclusion": "orders-04 runs hot while its peers are fine"},
         {"finding": "orders-01", "conclusion": "All orders instances are hot"}),
        ("active-alert-triage",
         {"finding": "active", "scope": "high priority, fulfilment /shipments", "conclusion": "Still active: customers' shipment requests are failing now"},
         {"finding": "resolved", "conclusion": "It is noise"}),
        ("slow-payments",
         {"finding": "payments", "scope": "/checkout", "conclusion": "Payments latency slows the checkout path"},
         {"finding": "checkout", "conclusion": "Checkout is broken"}),
    ]

    @classmethod
    def setUpClass(cls):
        cls.controller = load_module("scenario_controller_answers", ROOT / "scenario-controller/controller.py")
        cls.server = load_module("learning_server_answers", ROOT / "learning-service/server.py")
        cls.server.LEARNING_DIR = ROOT / "learning"

    def grade(self, pack, answer):
        template = json.loads((ROOT / "learning/scenarios" / pack / "scenario.json").read_text())
        manifest = self.controller.materialize(template, 2, run_id="run-000000000002")
        session = self.server.create_session({"manifest": manifest}, "challenge")
        session["completed_goals"] = {goal["id"] for goal in session["playbook"]["goals"]}
        session["answer"] = answer
        evidence = {"assertions": {item["id"]: True for item in manifest["scenario"]["truth"]["assertions"]}}
        return {item["id"]: item["correct"] for item in self.server.score_session(session, evidence=evidence)["answer_review"]}

    def test_paraphrased_facts_pass_and_wrong_facts_fail(self):
        for pack, answer, mistakes in self.CASES:
            with self.subTest(pack=pack):
                self.assertTrue(all(self.grade(pack, answer).values()), self.grade(pack, answer))
                review = self.grade(pack, {**answer, **mistakes})
                for field in mistakes:
                    self.assertFalse(review[field], field)


class ViewScopedEvidenceTests(unittest.TestCase):
    """Evidence counts only when it is in the learner's own view: their window, query and pills."""

    @classmethod
    def setUpClass(cls):
        cls.server = load_module("learning_server_view", ROOT / "learning-service/server.py")
        cls.server.LEARNING_DIR = ROOT / "learning"
        cls.kql = sys.modules["engine.kql"]
        cls.controller = load_module("scenario_controller_view", ROOT / "scenario-controller/controller.py")

    def test_kql_is_translated_the_way_discover_runs_it(self):
        kql = self.kql.kql_query
        self.assertEqual(kql(""), {"match_all": {}})
        self.assertEqual(kql('url.path: "/api/orders"'), {"match_phrase": {"url.path": "/api/orders"}})
        self.assertEqual(kql("service.name: payments"), {"match": {"service.name": "payments"}})
        self.assertEqual(kql("http.response.status_code >= 500"), {"range": {"http.response.status_code": {"gte": "500"}}})
        self.assertEqual(kql("error.type: *"), {"exists": {"field": "error.type"}})
        self.assertEqual(kql('not message: "heartbeat ok" and event.outcome: failure'),
                         {"bool": {"filter": [{"bool": {"must_not": [{"match_phrase": {"message": "heartbeat ok"}}]}}, {"match": {"event.outcome": "failure"}}]}})
        self.assertEqual(kql("service.name: (orders or payments)"),
                         {"bool": {"should": [{"match": {"service.name": "orders"}}, {"match": {"service.name": "payments"}}], "minimum_should_match": 1}})
        self.assertEqual(kql("order validation failed"), {"multi_match": {"type": "best_fields", "query": "order validation failed", "lenient": True}})
        # Syntax outside the subset is unknown, never a guess.
        for text in ("url.*: x", "a: (b", "service.name: {x}", "and"):
            self.assertIsNone(kql(text), text)

    def test_a_view_combines_window_query_and_pills(self):
        view = {"time_from": "now-15m", "time_to": "now", "language": "kql", "query": "event.outcome: failure",
                "filters": [{"field": "service.name", "value": "auth", "negate": True}, {"field": "url.path", "value": "/x", "disabled": True},
                            {"field": "http.response.status_code", "type": "phrases", "value": [500, 503]}]}
        self.assertEqual(self.kql.view_query(view), {"bool": {
            "filter": [{"range": {"@timestamp": {"gte": "now-15m", "lte": "now"}}}, {"match": {"event.outcome": "failure"}},
                       {"bool": {"should": [{"match_phrase": {"http.response.status_code": 500}}, {"match_phrase": {"http.response.status_code": 503}}], "minimum_should_match": 1}}],
            "must_not": [{"match_phrase": {"service.name": "auth"}}]}})
        self.assertIsNone(self.kql.view_query({**view, "language": "esql"}))
        self.assertIsNone(self.kql.view_query({**view, "filters": [{"type": "custom", "field": None}]}))

    def session(self):
        template = json.loads((ROOT / "learning/scenarios/http-error-regression/scenario.json").read_text())
        manifest = self.controller.materialize(template, 3, run_id="run-000000000003")
        return self.server.create_session({"manifest": manifest}, "guided")

    def test_the_view_follows_the_learner_and_the_coach_report_wins(self):
        session = self.session()
        self.server.track_view(session, {"type": "time_range_changed", "details": {"from": "now-15m", "to": "now"}})
        self.server.track_view(session, {"type": "filter_added", "details": {"field": "url.path", "value": "/api/orders", "operator": "is"}})
        self.assertEqual(session["view"]["filters"], [{"field": "url.path", "value": "/api/orders", "operator": "is"}])
        self.server.track_view(session, {"type": "query_submitted", "details": {"query": "event.outcome: failure"}, "state_after": {"filters": []}})
        self.assertEqual((session["view"]["query"], session["view"]["filters"]), ("event.outcome: failure", []))
        # After a restore the coach's report (read from Kibana's URL) puts the view right again.
        reported = {"time_from": "now-30m", "time_to": "now", "language": "kql", "query": "", "filters": [{"field": "url.path", "value": "/api/orders", "type": "phrase"}]}
        self.server.track_view(session, {"type": "document_expanded", "details": {}, "view": reported})
        self.assertEqual(session["view"], reported)

    def test_evidence_is_counted_inside_the_view_and_falls_back_when_it_cannot_be_read(self):
        from unittest import mock
        session = self.session()
        session["view"] = {"time_from": "now-15m", "time_to": "now", "language": "kql", "query": 'url.path: "/somewhere-else"', "filters": []}
        calls = []

        def http_json(url, method="GET", payload=None, timeout=10):
            calls.append(payload)
            scoped = "bool" in payload["query"] and len(payload["query"]["bool"].get("filter", [])) == 2
            return 200, {"hits": {"total": {"value": 0 if scoped else 50}}}

        with mock.patch.object(self.server, "http_json", side_effect=http_json):
            evidence = self.server.action_evidence(session, {"type": "document_expanded", "details": {}})
            self.assertTrue(evidence["view_scoped"])
            self.assertFalse(evidence["assertions"]["signal"])
            self.assertIn({"match_phrase": {"url.path": "/somewhere-else"}}, json.loads(json.dumps(calls[0]))["query"]["bool"]["filter"][1]["bool"]["filter"])
            # A query the translator can't read is checked against the whole run instead.
            session["view"]["query"] = "url.*: x"
            evidence = self.server.action_evidence(session, {"type": "document_expanded", "details": {}})
            self.assertFalse(evidence["view_scoped"])
            self.assertTrue(evidence["assertions"]["signal"])

    def test_esql_only_runs_against_lab_data(self):
        from unittest import mock
        with mock.patch.object(self.server, "http_json", return_value=(200, {"columns": [{"name": "url.path"}], "values": [["/api/orders"]]})) as call:
            table = self.server.esql_result({}, "FROM lab-run-000000000003 | STATS c = COUNT(*) BY url.path", {"time_from": "now-15m", "time_to": "now"})
            self.assertEqual(table, {"columns": ["url.path"], "values": [["/api/orders"]]})
            self.assertEqual(call.call_args.args[2]["filter"], {"range": {"@timestamp": {"gte": "now-15m", "lte": "now"}}})
            for query in ("FROM .kibana | LIMIT 1", "FROM lab-x, .security | LIMIT 1", "ROW a = 1"):
                self.assertIsNone(self.server.esql_result({}, query, {}), query)
        # A query Elasticsearch rejects left the learner looking at an error: an empty table, not unknown.
        with mock.patch.object(self.server, "http_json", return_value=(400, {"error": {"type": "parsing_exception"}})):
            table = self.server.esql_result({}, "FROM lab-run-000000000003 | STATS BY", {})
        self.assertEqual(table["values"], [])
        self.assertFalse(sys.modules["engine.evaluator"].validate_result_contains({}, {}, {"esql_result": table}, {"value": "x"}))


if __name__ == "__main__":
    unittest.main()
