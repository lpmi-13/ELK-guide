import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "learning-service" / "engine"))
from contracts import expand_descriptor, validate_catalog


class ScenarioV2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads((ROOT / "learning/catalog.json").read_text())

    def test_catalog_has_the_target_core_and_extension_counts(self):
        core = [item for item in self.catalog["scenarios"] if item["classification"] == "core"]
        extensions = [item for item in self.catalog["scenarios"] if item["classification"] == "extension"]
        self.assertEqual(len(core), 22)
        self.assertEqual(len(extensions), 0)
        self.assertEqual({item["type"] for item in core}, {"investigation", "analysis", "triage"})

    def test_all_pack_contracts_are_valid(self):
        self.assertEqual(validate_catalog(ROOT / "learning"), [])

    def test_every_catalog_entry_has_a_v2_pack(self):
        for entry in self.catalog["scenarios"]:
            pack = ROOT / "learning" / entry["pack"]
            with self.subTest(scenario=entry["id"]):
                for filename in ("scenario.json", "playbook.json", "rubric.json"):
                    document = json.loads((pack / filename).read_text())
                    self.assertEqual(document["schema_version"], 2)

    def test_every_catalog_entry_has_an_incident_briefing(self):
        definitions = json.loads((ROOT / "learning/incident-briefings.json").read_text())
        catalog_ids = {entry["id"] for entry in self.catalog["scenarios"]}
        self.assertEqual(set(definitions["scenarios"]), catalog_ids)
        for scenario_id, briefing in definitions["scenarios"].items():
            with self.subTest(scenario=scenario_id):
                self.assertGreaterEqual(len(briefing["channels"]), 3)
                self.assertTrue(set(briefing["channels"]) <= set(definitions["sources"]))
                self.assertEqual(len(briefing["signals"]), 3)
                self.assertTrue(all(set(signal) == {"label", "value"} for signal in briefing["signals"]))
                self.assertGreaterEqual(min(briefing["observed_minutes_ago"]), 4)

    def test_expanded_playbooks_share_the_three_mode_contract(self):
        for entry in self.catalog["scenarios"]:
            pack = ROOT / "learning" / entry["pack"]
            playbook = expand_descriptor(ROOT / "learning", "playbook", json.loads((pack / "playbook.json").read_text()))
            with self.subTest(scenario=entry["id"]):
                self.assertTrue(playbook["demonstration_summary"]["checks"])
                self.assertTrue(all(len(goal["hints"]) >= 3 for goal in playbook["goals"]))
                self.assertTrue(all(goal["accepts"] and goal["reference_action"] for goal in playbook["goals"]))
                demonstrated = [goal for goal in playbook["goals"] if goal["reference_action"]["command"] not in {"request_answer", "request_diagnosis"}]
                self.assertTrue(all(set(goal.get("demonstration", {})) >= {"narration", "reasoning", "evidence"} for goal in demonstrated))
                self.assertTrue(all("${truth." in json.dumps(goal["demonstration"]) for goal in demonstrated))
                summary = playbook["demonstration_summary"]
                self.assertEqual(len(summary["checks"]), len(demonstrated))
                # Each check is a concise recap of one step — a real sentence, not a stub — but the
                # debrief is a summary, so it is no longer required to restate the step's reasoning at
                # essay length. Evidence/conclusion prose is likewise optional (the steps carried it).
                self.assertTrue(all(len(check["detail"].split()) >= 4 for check in summary["checks"]))

    def test_goal_inserts_splice_new_goals_relative_to_the_template(self):
        from contracts import expand_descriptor as expand
        template = {"schema_version": 2, "id": "t", "goals": [{"id": "a"}, {"id": "b"}, {"id": "c"}]}
        (ROOT / "learning/templates/playbooks/_insert_probe.json").write_text(json.dumps(template))
        try:
            descriptor = {
                "extends": "_insert_probe.json",
                "goal_inserts": [
                    {"after": "a", "goal": {"id": "a2"}},
                    {"before": "c", "goal": {"id": "b2"}},
                    {"goal": {"id": "z"}},
                ],
            }
            result = expand(ROOT / "learning", "playbook", descriptor)
            self.assertEqual([goal["id"] for goal in result["goals"]], ["a", "a2", "b", "b2", "c", "z"])
        finally:
            (ROOT / "learning/templates/playbooks/_insert_probe.json").unlink()

    def test_incident_window_survey_flow_derives_status_then_endpoint(self):
        from contracts import expand_descriptor as expand
        pack = ROOT / "learning/scenarios/discover-time-window"
        playbook = expand(ROOT / "learning", "playbook", json.loads((pack / "playbook.json").read_text()))
        goals = {goal["id"]: goal for goal in playbook["goals"]}
        # The single presuming isolate step is replaced by a survey -> isolate -> endpoints chain.
        self.assertEqual([goal["id"] for goal in playbook["goals"]], ["scope", "survey", "isolate", "endpoints", "inspect", "submit"])
        self.assertEqual(goals["survey"]["requires"], ["scope"])
        self.assertEqual(goals["isolate"]["requires"], ["survey"])
        self.assertEqual(goals["endpoints"]["requires"], ["isolate"])
        self.assertEqual(goals["inspect"]["requires"], ["endpoints"])
        # The surveys read a field's distribution; the isolate filters on the OBSERVED value.
        self.assertEqual(goals["survey"]["reference_action"]["command"], "open_field_statistics")
        self.assertEqual(goals["survey"]["reference_action"]["arguments"]["field"], "http.response.status_code")
        self.assertEqual(goals["isolate"]["reference_action"]["command"], "add_filter")
        self.assertEqual(goals["endpoints"]["reference_action"]["arguments"]["field"], "url.path")
        # No goal presumes the status code or endpoint via a hard-coded compound query anymore.
        self.assertNotIn("url.path:", json.dumps(playbook["goals"]))
        # The debrief has one check per demonstrated (non-answer) step.
        demonstrated = [goal for goal in playbook["goals"] if goal["reference_action"]["command"] not in {"request_answer", "request_diagnosis"}]
        self.assertEqual(len(playbook["demonstration_summary"]["checks"]), len(demonstrated))

    def test_evaluator_has_no_scenario_id_branches(self):
        source = (ROOT / "learning-service/engine/evaluator.py").read_text()
        for entry in self.catalog["scenarios"]:
            self.assertNotIn(entry["id"], source)

    def test_alerting_is_configured_without_connectors(self):
        compose = (ROOT / "docker-compose.yml").read_text()
        alert = json.loads((ROOT / "learning/scenarios/active-alert-triage/scenario.json").read_text())
        self.assertIn("XPACK_ENCRYPTEDSAVEDOBJECTS_ENCRYPTIONKEY", compose)
        self.assertGreaterEqual(len("incident-lab-only-encryption-key-9-5-2"), 32)
        self.assertEqual(alert["provisioning"]["managed_resources"][0]["kind"], "alert_rule")
        controller = (ROOT / "scenario-controller/controller.py").read_text()
        self.assertIn('"actions": []', controller)
        self.assertNotIn(".alerts-", controller)

    def test_application_adapters_are_split(self):
        adapters = ROOT / "kibana-coach/src/adapters"
        expected = {"common.js", "discover.js", "dashboard.js", "apm.js", "infrastructure.js", "alerts.js"}
        self.assertEqual({path.name for path in adapters.glob("*.js")}, expected)

    def test_launcher_is_catalog_driven(self):
        launcher = (ROOT / "telemetry/index.html").read_text()
        self.assertIn('id="scenario-catalog"', launcher)
        self.assertIn("/api/catalog", launcher)
        self.assertIn("catalogEntries = catalog.scenarios", launcher)
        self.assertIn("for (const item of catalogEntries)", launcher)
        self.assertIn("scenario:selectedScenario", launcher)
        for entry in self.catalog["scenarios"]:
            self.assertNotIn(f'value="{entry["id"]}"', launcher)


if __name__ == "__main__":
    unittest.main()
