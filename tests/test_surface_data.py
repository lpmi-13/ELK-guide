"""The data the non-Discover packs seed must be readable by the Kibana view each one starts in.

APM, the Infrastructure inventory and the dashboards each read specific shapes; these checks pin the
shapes verified live against Kibana 9.5.2, so a pack keeps working when the generator changes.
"""

import importlib.util
import json
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "learning-service"))
sys.path.insert(0, str(ROOT / "learning-service" / "engine"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SurfaceDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_module("scenario_controller_surfaces", ROOT / "scenario-controller/controller.py")
        cls.evaluator = load_module("evaluator_surfaces", ROOT / "learning-service/engine/evaluator.py")

    def documents(self, pack, seed=7):
        template = json.loads((ROOT / "learning/scenarios" / pack / "scenario.json").read_text())
        manifest = self.controller.materialize(template, seed, run_id=f"run-{seed:012d}")
        application = manifest["scenario"]["starting_view"]["app"]
        documents = self.controller.generate_seeded_events(manifest)
        streams = [self.controller._application_document(document, application, manifest) for document in documents]
        return documents, streams

    def test_apm_errors_carry_a_grouping_key_and_transactions_drop_their_span(self):
        # APM's trace API rejects an error without error.grouping_key, and a transaction that still
        # carries its dependency's `span` is drawn as that span.
        _documents, streams = self.documents("trace-error-propagation")
        errors = [document for _stream, document in streams if document.get("processor", {}).get("event") == "error"]
        transactions = [document for stream, document in streams if stream and document.get("processor", {}).get("event") == "transaction"]
        self.assertTrue(errors)
        for error in errors:
            self.assertTrue(error["error"]["grouping_key"])
            self.assertEqual(error["error"]["exception"][0]["type"], error["error"]["type"])
        self.assertTrue(transactions)
        self.assertFalse([document for document in transactions if "span" in document])

    def test_every_failing_trace_carries_the_whole_call_chain(self):
        documents, _streams = self.documents("trace-error-propagation")
        edge = [document for document in documents if document["service"]["name"] == "api-gateway" and document.get("message") == "edge returned generic downstream failure" and document["processor"]["event"] == "transaction"]
        self.assertEqual(len(edge), 34)
        by_parent = {}
        for document in documents:
            if document["processor"]["event"] == "transaction" and document.get("parent"):
                by_parent.setdefault((document["trace"]["id"], document["parent"]["id"]), []).append(document)
        for request in edge:
            orders = by_parent[(request["trace"]["id"], request["transaction"]["id"])]
            self.assertEqual([item["service"]["name"] for item in orders], ["orders"])
            inventory = by_parent[(request["trace"]["id"], orders[0]["span"]["id"])]
            self.assertEqual([(item["service"]["name"], item["span"]["name"], item["error"]["type"]) for item in inventory],
                             [("inventory", "reserve stock", "InventoryReservationRace")])

    def test_every_failing_payment_trace_has_its_application_log(self):
        documents, streams = self.documents("trace-log-correlation")
        failing = {document["trace"]["id"] for document in documents if document.get("message") == "trace span failed without full context"}
        logs = [(stream, document) for stream, document in streams if document.get("message") == "issuer timed out after authorization deadline"]
        self.assertEqual({document["trace"]["id"] for _stream, document in logs}, failing)
        self.assertTrue(all(stream.startswith("logs-") for stream, _document in logs))

    def test_a_failed_request_reports_its_http_result(self):
        documents, _streams = self.documents("trace-error-propagation")
        edge = next(document for document in documents if document["service"]["name"] == "api-gateway" and document["processor"]["event"] == "transaction")
        self.assertEqual(edge["transaction"]["result"], "HTTP 5xx")

    def test_host_metrics_are_system_module_samples_with_healthy_peers(self):
        documents, streams = self.documents("cpu-saturation")
        metrics = [document for stream, document in streams if stream and stream.startswith("metrics-")]
        self.assertTrue(metrics)
        self.assertEqual({document["event"]["module"] for document in metrics}, {"system"})
        peers = [document["system"]["cpu"]["total"]["norm"]["pct"] for document in metrics if document["host"]["name"].startswith("instance-")]
        self.assertTrue(peers)
        self.assertTrue(all(0.12 <= value <= 0.42 for value in peers))
        outlier = {document["system"]["cpu"]["total"]["norm"]["pct"] for document in metrics if document["host"]["name"] == "checkout-03"}
        self.assertEqual(outlier, {0.97})
        # The queueing warning is the host's log line, not a metric sample.
        warnings = [stream for stream, document in streams if document.get("message") == "request queueing aligned with CPU peak"]
        self.assertTrue(warnings)
        self.assertTrue(all(stream.startswith("logs-") for stream in warnings))

    def test_pod_metrics_are_the_kubernetes_pod_metricset(self):
        # The pods view needs kubernetes.pod.uid, and reads memory against the pod's limit only when
        # usage against its node is reported too.
        documents, streams = self.documents("memory-leak-and-restarts")
        pods = [document for stream, document in streams if stream and stream.startswith("metrics-kubernetes.pod-")]
        self.assertEqual({document["kubernetes"]["pod"]["name"] for document in pods}, {"catalog-7d8f", "catalog-5c2a", "catalog-9b1e", "orders-3f6c"})
        for document in pods:
            self.assertEqual((document["event"]["module"], document["metricset"]["name"]), ("kubernetes", "pod"))
            self.assertEqual(document["kubernetes"]["pod"]["uid"], document["kubernetes"]["pod"]["name"])
            self.assertIn("pct", document["kubernetes"]["pod"]["memory"]["usage"]["limit"])
            self.assertIn("pct", document["kubernetes"]["pod"]["memory"]["usage"]["node"])
        leaking = {document["kubernetes"]["pod"]["memory"]["usage"]["limit"]["pct"] for document in pods if document["kubernetes"]["pod"]["name"] == "catalog-7d8f"}
        self.assertEqual(leaking, {0.94})
        restarts = [(stream, document) for stream, document in streams if document.get("message") == "first catalog pod restart"]
        self.assertTrue(restarts)
        self.assertTrue(all(stream.startswith("logs-") and document["kubernetes"]["pod"]["uid"] == "catalog-7d8f" for stream, document in restarts))

    def test_a_validator_value_naming_the_answer_resolves_to_it(self):
        # Playbooks are stored unsubstituted, so "${truth.finding}" must resolve when the evaluator
        # compares; otherwise the step could never be satisfied.
        session = {"manifest": {"scenario": {"truth": {"answers": {"finding": "eu-west-2"}}}}}
        selected = {"kind": "selected_value", "value": "${truth.finding}"}
        filtered = {"kind": "filter_contains", "field": "cloud.region", "value": "${truth.finding}"}
        self.assertTrue(self.evaluator.validate_selected_value(session, {"details": {"value": "eu-west-2"}}, {}, selected))
        self.assertFalse(self.evaluator.validate_selected_value(session, {"details": {"value": "us-east-1"}}, {}, selected))
        self.assertTrue(self.evaluator.validate_filter_contains(session, {"details": {"field": "cloud.region", "value": "eu-west-2"}}, {}, filtered))

    def test_a_completed_run_is_reclaimed_after_its_retention_unless_stopped_first(self):
        run = {"manifest": {}, "reclaimed": threading.Event()}
        with patch.object(self.controller, "COMPLETED_RETENTION_SECONDS", 0), patch.object(self.controller, "cleanup_run") as cleanup:
            self.controller.reclaim_after_retention(run)
            cleanup.assert_called_once_with(run)
        run["reclaimed"].set()
        with patch.object(self.controller, "COMPLETED_RETENTION_SECONDS", 0), patch.object(self.controller, "cleanup_run") as cleanup:
            self.controller.reclaim_after_retention(run)
            cleanup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
