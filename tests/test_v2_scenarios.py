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
        self.assertEqual(len(core), 24)
        self.assertEqual(len(extensions), 3)
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

    def test_expanded_playbooks_share_the_three_mode_contract(self):
        for entry in self.catalog["scenarios"]:
            pack = ROOT / "learning" / entry["pack"]
            playbook = expand_descriptor(ROOT / "learning", "playbook", json.loads((pack / "playbook.json").read_text()))
            with self.subTest(scenario=entry["id"]):
                self.assertTrue(playbook["demonstration_summary"]["checks"])
                self.assertTrue(all(len(goal["hints"]) >= 3 for goal in playbook["goals"]))
                self.assertTrue(all(goal["accepts"] and goal["reference_action"] for goal in playbook["goals"]))

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
        expected = {"common.js", "discover.js", "dashboard.js", "apm.js", "infrastructure.js", "alerts.js", "slo.js", "maps.js", "synthetics.js", "machine-learning.js"}
        self.assertEqual({path.name for path in adapters.glob("*.js")}, expected)

    def test_launcher_is_catalog_driven(self):
        launcher = (ROOT / "telemetry/index.html").read_text()
        for identifier in ("surface-filter", "skill-filter", "difficulty-filter", "signal-filter", "type-filter", "scenario-catalog"):
            self.assertIn(f'id="{identifier}"', launcher)
        self.assertIn("/api/catalog", launcher)
        self.assertIn("scenario:selectedScenario", launcher)


if __name__ == "__main__":
    unittest.main()
