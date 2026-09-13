"""The log-hunt packs must randomize their specifics per run while staying consistent.

These checks exercise the real materialize -> playbook-resolution path (not just the
static matrix) so that a seeded run's brief, seeded signal, truth, and demonstrated KQL
all agree, two seeds require different filters, and the same seed is reproducible.
"""

import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Importing server.py pulls in the engine package; the matrix script imports the engine
# modules top-level. Put both directories on the path so either import style resolves.
sys.path.insert(0, str(ROOT / "learning-service"))
sys.path.insert(0, str(ROOT / "learning-service" / "engine"))

LOG_HUNT_PACKS = (
    "http-error-regression",
    "rare-error-signature",
    "auth-rejection-surge",
    "deployment-version-regression",
    "log-pattern-noise-reduction",
    "discover-time-window",
    "schema-drift-data-quality",
)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RandomizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_module("scenario_controller", ROOT / "scenario-controller/controller.py")
        cls.server = load_module("learning_server", ROOT / "learning-service/server.py")
        cls.matrix = load_module("scenario_matrix", ROOT / "scripts/test-scenario-matrix.py")
        cls.server.LEARNING_DIR = ROOT / "learning"

    def template(self, pack):
        return json.loads((ROOT / "learning/scenarios" / pack / "scenario.json").read_text())

    def materialize(self, pack, seed):
        return self.controller.materialize(self.template(pack), seed, run_id=f"run-{seed:012d}")

    @staticmethod
    def _isolate_target(isolate):
        """Return (targeted_text, signature) for the isolate demo action, whether the
        pack demonstrates a filter (add_filter dict arguments) or a query (enter_kql
        string arguments). ``targeted_text`` contains the decisive field and value;
        ``signature`` is a hashable form that differs when the demonstrated narrowing does."""
        arguments = isolate["reference_action"]["arguments"]
        if isinstance(arguments, dict):
            return " ".join(str(value) for value in arguments.values()), json.dumps(arguments, sort_keys=True)
        return arguments, arguments

    def test_same_seed_is_reproducible_but_independent_of_run_identity(self):
        for pack in LOG_HUNT_PACKS:
            first = self.controller.materialize(self.template(pack), 424242, run_id="run-aaaaaaaaaaaa")
            second = self.controller.materialize(self.template(pack), 424242, run_id="run-bbbbbbbbbbbb")
            with self.subTest(pack=pack):
                self.assertNotEqual(first["run_id"], second["run_id"])
                self.assertEqual(first["parameters"], second["parameters"])
                self.assertEqual(first["scenario"], second["scenario"])

    def test_nothing_ships_with_unresolved_parameter_tokens(self):
        for pack in LOG_HUNT_PACKS:
            manifest = self.materialize(pack, 97531)
            playbook = self.server.load_manifest_definition(manifest, "playbook")
            with self.subTest(pack=pack):
                self.assertNotIn("${param", json.dumps(manifest["scenario"]))
                self.assertNotIn("parameters", manifest["scenario"])  # specs are popped, not leaked
                self.assertNotIn("${param", json.dumps(playbook))

    def test_seeded_signal_truth_and_query_agree(self):
        manifest = self.materialize("http-error-regression", 135)
        incident = manifest["parameters"]["incident"]
        signal = manifest["scenario"]["provisioning"]["seeded_events"]["signal"]
        playbook = self.server.load_manifest_definition(manifest, "playbook")
        isolate = next(goal for goal in playbook["goals"] if goal["id"] == "isolate")
        targeted, _ = self._isolate_target(isolate)

        self.assertEqual(signal["service"]["name"], incident["service"])
        self.assertEqual(signal["error"]["type"], incident["error_type"])
        # A whole-token substitution keeps the native int type for the status code.
        self.assertEqual(signal["http"]["response"]["status_code"], incident["status"])
        self.assertIsInstance(signal["http"]["response"]["status_code"], int)
        self.assertEqual(manifest["scenario"]["truth"]["answers"]["finding"], incident["finding"])
        # The demonstrated isolate action (here a filter) targets this run's decisive field and value.
        self.assertIn(incident["signal_field"], targeted)
        self.assertIn(incident["finding"], targeted)
        self.assertEqual(isolate["accepts"][0]["validators"][0].get("fields"), [incident["signal_field"]])

    def test_specifics_and_required_filters_vary_across_seeds(self):
        for pack in LOG_HUNT_PACKS:
            findings, queries = set(), set()
            for seed in range(60):
                manifest = self.materialize(pack, seed)
                findings.add(manifest["scenario"]["truth"]["answers"]["finding"])
                playbook = self.server.load_manifest_definition(manifest, "playbook")
                isolate = next(goal for goal in playbook["goals"] if goal["id"] == "isolate")
                _, signature = self._isolate_target(isolate)
                queries.add(signature)
            with self.subTest(pack=pack):
                self.assertGreater(len(findings), 1, "findings should differ across seeds")
                self.assertGreater(len(queries), 1, "the demonstrated narrowing should differ across seeds")

    def test_a_randomized_run_is_internally_consistent_and_solvable(self):
        # Drive the resolved playbook against the materialized (concrete) truth the way the
        # matrix drives static packs: the reference route must complete and score 100.
        for pack in LOG_HUNT_PACKS:
            for seed in (1, 7, 20260909):
                manifest = self.materialize(pack, seed)
                scenario = manifest["scenario"]
                playbook = self.server.load_manifest_definition(manifest, "playbook")
                rubric = self.server.load_manifest_definition(manifest, "rubric")
                session = {"manifest": manifest, "playbook": playbook, "rubric": rubric, "mode": "challenge",
                           "completed_goals": set(), "actions": [], "assistance": {"hints": 0, "demonstrated_steps": 0}}
                evidence = {"assertions": {item["id"]: True for item in scenario["truth"]["assertions"]}, "trace_services": 4}
                with self.subTest(pack=pack, seed=seed):
                    for goal in playbook["goals"]:
                        action = self.matrix.action_for(goal, scenario)
                        self.matrix.evaluate_action(session, action, evidence)
                        session["actions"].append({"action": action, "evaluation": {"meaningful": True}})
                        self.assertIn(goal["id"], session["completed_goals"])
                    session["answer"] = {**scenario["truth"]["answers"],
                                         "evidence_refs": [item["id"] for item in scenario["truth"]["assertions"]],
                                         "evidence": "The reference route established every declared assertion."}
                    feedback = self.matrix.score_session(session, evidence=evidence)
                    self.assertTrue(feedback["task_correct"])
                    self.assertEqual(feedback["total"], 100)


if __name__ == "__main__":
    unittest.main()
