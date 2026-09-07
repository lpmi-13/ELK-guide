import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ScenarioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_module("scenario_controller", ROOT / "scenario-controller/controller.py")
        cls.service = load_module("microservice_service", ROOT / "microservice/service.py")
        cls.template = json.loads((ROOT / "scenario-controller/scenarios/slow-payments.json").read_text())

    def tearDown(self):
        self.service.clear_fault()

    def test_materialization_is_seeded_but_run_identity_is_separate(self):
        first = self.controller.materialize(self.template, 20260822, run_id="run-aaaaaaaaaaaa")
        second = self.controller.materialize(self.template, 20260822, run_id="run-bbbbbbbbbbbb")
        self.assertNotEqual(first["run_id"], second["run_id"])
        first_without_identity = {key: value for key, value in first.items() if key not in {"run_id", "space_id", "created_at"}}
        second_without_identity = {key: value for key, value in second.items() if key not in {"run_id", "space_id", "created_at"}}
        self.assertNotEqual(first["space_id"], second["space_id"])
        self.assertEqual(first_without_identity, second_without_identity)
        self.assertGreaterEqual(first["scenario"]["fault"]["delay_ms"], 3000)

    def test_negative_seed_is_not_a_valid_run_seed(self):
        with self.assertRaisesRegex(ValueError, "non-negative"):
            self.controller.create_run(seed=-1, scenario_name="slow-payments")

    def test_arbitrary_scenario_key_maps_to_a_stable_numeric_seed(self):
        value = "My custom key! #42"
        first_seed, first_key = self.controller.scenario_key_seed(value)
        second_seed, second_key = self.controller.scenario_key_seed(value)
        self.assertEqual(first_seed, second_seed)
        self.assertEqual(first_key, value)
        self.assertEqual(second_key, value)
        self.assertNotEqual(first_seed, self.controller.scenario_key_seed(value.lower())[0])
        for boundary_value in ("x" * 10, "x" * 40):
            self.assertEqual(self.controller.scenario_key_seed(boundary_value)[1], boundary_value)

        manifest = self.controller.materialize(self.template, first_seed, scenario_key=first_key)
        self.assertEqual(manifest["seed"], first_seed)
        self.assertEqual(manifest["scenario_key"], value)

    def test_invalid_scenario_key_is_rejected(self):
        for value in ("short-key", "x" * 41, 1234567890):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "between 10 and 40"):
                self.controller.scenario_key_seed(value)

    def test_fault_configuration_validates_and_scopes_to_run_and_path(self):
        configured = self.service.set_fault({"scenario_id": "run-test", "scenario_name": "slow-payments", "fault": "latency", "delay_ms": 25, "probability": 1, "paths": ["/checkout"]})
        self.assertEqual(configured["fault"], "latency")
        self.assertIsNone(self.service.matching_fault("/items", "run-test"))
        self.assertIsNone(self.service.matching_fault("/checkout", "another-run"))
        self.assertEqual(self.service.matching_fault("/checkout", "run-test")["delay_ms"], 25)

    def test_invalid_fault_is_rejected(self):
        with self.assertRaises(ValueError):
            self.service.normalize_fault({"fault": "latency", "delay_ms": -1, "paths": ["checkout"]})
        with self.assertRaises(ValueError):
            self.service.normalize_fault({"fault": "unknown", "paths": ["/"]})

    def test_traceparent_parser_accepts_w3c_context(self):
        trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
        headers = {"traceparent": f"00-{trace_id}-00f067aa0ba902b7-01"}
        self.assertEqual(self.service.trace_id_from_headers(headers), trace_id)


if __name__ == "__main__":
    unittest.main()
