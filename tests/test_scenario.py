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

    def test_seeded_scenarios_use_real_event_fields_for_evidence(self):
        for path in sorted((ROOT / "learning/scenarios").glob("*/scenario.json")):
            scenario = json.loads(path.read_text())
            if "seeded_events" not in scenario.get("provisioning", {}):
                continue
            for seed in (42, 117):
                with self.subTest(scenario=scenario["id"], seed=seed):
                    manifest = self.controller.materialize(scenario, seed, run_id="run-abcdefghijkl")
                    documents = self.controller.generate_seeded_events(manifest)
                    self.assertTrue(documents)
                    for document in documents:
                        self.assertNotIn("lab", document)
                        self.assertNotIn("labels", document)
                        self.assertEqual(document["host"]["os"]["platform"], "linux")
                    checks = (manifest["scenario"]["provisioning"]["readiness_validators"]
                              + manifest["scenario"]["truth"]["assertions"])
                    self.assertTrue({"seeded-signal", "signal", "corroboration"}.issubset(
                        {check["id"] for check in checks}))
                    for check in checks:
                        if check["id"] not in {"seeded-signal", "signal", "corroboration"}:
                            continue
                        matching = sum(self.matches(document, check["query"]) for document in documents)
                        self.assertGreaterEqual(matching, check["minimum"], check["id"])

    @classmethod
    def matches(cls, document, query):
        """Whether a seeded document matches an evidence query's terms (a term, or a bool of them)."""
        if "bool" in query:
            return all(cls.matches(document, clause) for clause in query["bool"].get("filter", []))
        field, value = next(iter(query["term"].items()))
        actual = document
        for part in field.removesuffix(".keyword").split("."):
            actual = actual.get(part) if isinstance(actual, dict) else None
        return actual == value or str(actual) == str(value)

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


class SeedingMechanicsTests(unittest.TestCase):
    """The controller pieces that let a pack draw which field holds its answer."""

    @classmethod
    def setUpClass(cls):
        cls.controller = load_module("scenario_controller_mechanics", ROOT / "scenario-controller/controller.py")

    def template(self, parameters, seeded_events):
        return {"schema_version": 2, "id": "mechanics-probe", "title": "Probe", "type": "investigation", "brief": "Probe.",
                "required_capabilities": [], "parameters": parameters,
                "provisioning": {"strategies": ["seeded-events"], "seeded_events": seeded_events, "readiness_validators": []},
                "starting_view": {"app": "discover"}, "truth": {"answers": {}, "assertions": []}, "answer_schema": {"fields": []},
                "playbook": "playbook.json", "rubric": "rubric.json"}

    def test_a_drawn_value_can_name_another_drawn_value(self):
        parameters = {"release": {"release": {"major": [2, 2], "minor": [4, 4], "patch": [1, 1]}},
                      "facet": {"choose": [{"field": "service.version", "value": "v${param.release.new}"}]}}
        chosen = self.controller.choose_parameters(parameters, 7)
        self.assertEqual(chosen["facet"]["value"], "v2.4.0")

    def test_the_set_overlay_writes_the_drawn_field_last_and_keys_take_tokens(self):
        parameters = {"facet": {"choose": [{"field": "host.name", "value": "web-7"}]}}
        seeded = {"signal_count": 6, "noise_count": 0,
                  "signal": {"message": "probe", "set": {"${param.facet.field}": "${param.facet.value}", "labels.drawn": "yes"}},
                  # Two cycles of different lengths spread two fields on their own; the drawn one still has one value.
                  "signal_cycles": [[{"host": {"name": "a"}}, {"host": {"name": "b"}}],
                                    [{"url": {"path": "/x"}}, {"url": {"path": "/y"}}, {"url": {"path": "/z"}}]]}
        manifest = self.controller.materialize(self.template(parameters, seeded), 3, run_id="run-000000000003")
        documents = self.controller.generate_seeded_events(manifest)
        self.assertEqual({document["host"]["name"] for document in documents}, {"web-7"})
        self.assertEqual({document["url"]["path"] for document in documents}, {"/x", "/y", "/z"})
        self.assertTrue(all(document["labels"]["drawn"] == "yes" and "set" not in document for document in documents))

    def test_groups_make_each_group_equally_likely(self):
        from collections import Counter
        spec = {"pick": {"groups": [[{"kind": "big"}] * 9, [{"kind": "small"}]]}}
        drawn = Counter(self.controller.choose_parameters(spec, seed)["pick"]["kind"] for seed in range(400))
        self.assertGreater(drawn["small"], 140)
        self.assertGreater(drawn["big"], 140)

    def test_a_drawn_switch_can_leave_a_companion_out(self):
        parameters = {"retry": {"choose": [{"attempts": 2, "third": False}, {"attempts": 3, "third": True}]}}
        seeded = {"signal_count": 1, "noise_count": 0, "signal": {"message": "probe"},
                  "companions": [{"count": 2, "event": {"message": "always"}},
                                 {"enabled": "${param.retry.third}", "count": 2, "event": {"message": "third"}}]}
        seen = set()
        for seed in range(20):
            manifest = self.controller.materialize(self.template(parameters, seeded), seed, run_id=f"run-{seed:012d}")
            messages = {document["message"] for document in self.controller.generate_seeded_events(manifest)}
            self.assertEqual("third" in messages, manifest["parameters"]["retry"]["third"])
            seen.add(manifest["parameters"]["retry"]["attempts"])
        self.assertEqual(seen, {2, 3})
        # A switch is not a value a learner reads, so a fresh run need not flip it.
        self.assertEqual(set(self.controller.drawn_values(parameters, "quiet-river-signal-11")), {"retry.attempts"})
