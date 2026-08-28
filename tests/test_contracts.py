import hashlib
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
    def test_all_json_documents_parse(self):
        documents = list((ROOT / "learning").rglob("*.json")) + list((ROOT / "browser-extension").rglob("*.json")) + list((ROOT / "scenario-controller" / "scenarios").glob("*.json"))
        self.assertGreater(len(documents), 8)
        for path in documents:
            with self.subTest(path=path.relative_to(ROOT)):
                json.loads(path.read_text(encoding="utf-8"))

    def test_fixture_hash_matches_versioned_template(self):
        template = json.loads((ROOT / "scenario-controller/scenarios/slow-payments.json").read_text())
        fixture = json.loads((ROOT / "learning/fixtures/slow-payments-run.json").read_text())
        canonical = json.dumps(template, sort_keys=True, separators=(",", ":")).encode()
        self.assertEqual(hashlib.sha256(canonical).hexdigest(), fixture["template_hash"])
        self.assertEqual(template["id"], fixture["template_id"])

    def test_playbook_goals_match_rubric(self):
        playbook = json.loads((ROOT / "learning/playbooks/slow-service-investigation.json").read_text())
        rubric = json.loads((ROOT / "learning/rubrics/slow-service-beginner.json").read_text())
        self.assertEqual({step["goal"] for step in playbook["steps"]}, {goal["id"] for goal in rubric["goals"]})
        self.assertEqual(sum(rubric["weights"].values()), 100)

    def test_saved_objects_are_ndjson_with_stable_ids(self):
        objects = [json.loads(line) for line in (ROOT / "kibana/saved-objects.ndjson").read_text().splitlines() if line]
        identities = {(item["type"], item["id"]) for item in objects}
        self.assertIn(("index-pattern", "microservices"), identities)
        self.assertIn(("search", "incident-investigation"), identities)
        self.assertIn(("dashboard", "incident-overview"), identities)
        visualization_ids = {identifier for object_type, identifier in identities if object_type == "visualization"}
        self.assertEqual(visualization_ids, {"request-duration-percentiles", "error-rate-over-time", "events-by-service", "slowest-endpoints", "common-error-types", "active-scenario-events"})
        dashboard = next(item for item in objects if item["type"] == "dashboard")
        self.assertEqual(len(json.loads(dashboard["attributes"]["panelsJSON"])), 6)

    def test_extension_and_shared_selectors_stay_identical(self):
        shared = json.loads((ROOT / "learning/selectors/kibana-8.15.json").read_text())
        extension = json.loads((ROOT / "browser-extension/selectors/kibana-8.15.json").read_text())
        self.assertEqual(shared, extension)
        for target in ("kibana.time_picker", "kibana.time_value", "kibana.time_unit", "kibana.time_apply", "kibana.query_bar", "kibana.add_filter", "kibana.first_result", "kibana.first_trace_value", "kibana.trace_field"):
            self.assertTrue(shared["targets"][target])

    def test_launcher_uses_scenario_keys_and_unambiguous_evidence_progress(self):
        launcher = (ROOT / "telemetry/index.html").read_text(encoding="utf-8")
        self.assertIn('id="scenario-key"', launcher)
        self.assertIn('minlength="10" maxlength="40"', launcher)
        self.assertNotIn('id="scenario-key" type="text" value="quiet-river-signal" pattern=', launcher)
        self.assertIn("scenario_key:scenarioKey.value", launcher)
        self.assertIn("minimum of ${required} met", launcher)
        self.assertNotIn("${count} of ${required} affected traces", launcher)

        manifest_schema = json.loads((ROOT / "learning/schemas/run-manifest.schema.json").read_text())
        scenario_key = manifest_schema["properties"]["scenario_key"]
        self.assertEqual(scenario_key, {"type": "string", "minLength": 10, "maxLength": 40})


if __name__ == "__main__":
    unittest.main()
