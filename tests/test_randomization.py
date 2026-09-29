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

    def test_version_rollout_shows_mixed_http_outcomes_before_comparing_versions(self):
        for seed in range(20):
            manifest = self.materialize("deployment-version-regression", seed)
            incident = manifest["parameters"]["incident"]
            documents = self.controller.generate_seeded_events(manifest)
            rows = sorted(
                (document for document in documents
                 if document["service"]["name"] == incident["service"]
                 and document["service"]["version"] in {incident["bad_version"], incident["good_version"]}),
                key=lambda document: document["@timestamp"], reverse=True,
            )
            with self.subTest(seed=seed):
                service_rows = [document for document in documents if document["service"]["name"] == incident["service"]]
                self.assertEqual({row["service"]["version"] for row in service_rows},
                                 {incident["bad_version"], incident["good_version"]})
                # The first visible Discover page must show both outcomes after the service/all-
                # versions query. Otherwise the next comparison looks decided before it begins.
                self.assertTrue({200, incident["status"]}.issubset(
                    {row["http"]["response"]["status_code"] for row in rows[:10]}))
                for row in rows:
                    expected = incident["status"] if row["service"]["version"] == incident["bad_version"] else 200
                    self.assertEqual(row["http"]["response"]["status_code"], expected)
                    self.assertEqual(row["transaction"]["result"], "HTTP 5xx" if expected >= 500 else "HTTP 2xx")

            session = self.server.create_session({"manifest": manifest}, "demonstration")
            session["run_ready"] = True
            goals = session["playbook"]["goals"]
            for goal_id, expected_focus in (
                ("isolate", ["http.response.status_code"]),
                ("inspect", ["service.version", "http.response.status_code"]),
            ):
                session["completed_goals"] = {goal["id"] for goal in goals[:next(
                    index for index, goal in enumerate(goals) if goal["id"] == goal_id)]}
                session["pending_command"] = None
                command = self.server.next_command(session)
                explanation = " ".join(command[field] for field in ("reasoning", "evidence"))
                with self.subTest(seed=seed, goal=goal_id):
                    self.assertEqual(command["learning_focus"], expected_focus)
                    self.assertIn("http.response.status_code", explanation)
                    self.assertIn(str(incident["status"]), explanation)
                    self.assertIn("200", explanation)

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

    def test_demonstration_copy_is_scenario_specific_and_fully_resolved(self):
        catalog = json.loads((ROOT / "learning/catalog.json").read_text())
        for offset, entry in enumerate(catalog["scenarios"]):
            manifest = self.materialize(entry["id"], 135 + offset)
            session = self.server.create_session({"manifest": manifest}, "demonstration")
            session["run_ready"] = True
            goals = session["playbook"]["goals"]
            finding = manifest["scenario"]["truth"]["answers"]["finding"]

            for index, goal in enumerate(goals):
                session["completed_goals"] = {item["id"] for item in goals[:index]}
                session["pending_command"] = None
                command = self.server.next_command(session)
                with self.subTest(scenario=entry["id"], goal=goal["id"]):
                    self.assertNotIn("${", json.dumps(command))
                    if command["type"] == "show_debrief":
                        summary = command["value"]
                        demonstrated = [
                            item for item in goals
                            if item["reference_action"]["command"] not in {"request_answer", "request_diagnosis"}
                        ]
                        answer = summary.get("answer", {})
                        # The debrief is a compact recap: one terse line per step plus the graded
                        # answer (shown as "Problem found"). There is no intro sentence and no
                        # evidence/conclusion prose — the steps themselves carried the reasoning.
                        summary_copy = " ".join([
                            answer.get("conclusion", ""), answer.get("evidence", ""),
                            *(check["detail"] for check in summary["checks"]),
                        ])
                        self.assertIn(finding, summary_copy)
                        self.assertEqual(len(summary["checks"]), len(demonstrated))
                        self.assertEqual(summary["answer"]["conclusion"], manifest["scenario"]["truth"]["answers"]["conclusion"])
                        self.assertLessEqual(len(summary["answer"]["conclusion"].split()), 25)
                        # Each check is a real one-line recap, not a stub — but no longer an essay.
                        self.assertTrue(all(len(check["detail"].split()) >= 4 for check in summary["checks"]))
                        if entry["id"] == "discover-time-window":
                            # The debrief still walks the derive-don't-presume flow: survey the status
                            # codes, filter to the observed one, then isolate the endpoint. The lines
                            # are plain language now, so assert the concept and the observed values
                            # rather than the raw field ids.
                            titles = [check["title"] for check in summary["checks"]]
                            self.assertEqual(titles, ["Time range", "Status codes", "Filtering", "Affected endpoint", "Confirming"])
                            status_check = next(check for check in summary["checks"] if check["title"] == "Status codes")
                            self.assertIn("status", status_check["detail"].lower())
                            endpoint_check = next(check for check in summary["checks"] if check["title"] == "Affected endpoint")
                            self.assertIn("endpoint", endpoint_check["detail"].lower())
                            self.assertIn(f"spiked during the {finding}", summary["answer"]["conclusion"])
                    else:
                        explanation = " ".join(command[key] for key in ("narration", "reasoning", "evidence"))
                        if command["type"] != "set_time_range":
                            self.assertIn(finding, explanation)
                        self.assertGreater(len(command["narration"].split()), 20)
                        if command["type"] == "set_time_range":
                            # Its opening card already explains the chosen range, so there is no
                            # second reading card before the picker action.
                            self.assertEqual(command["reasoning"], "")
                        else:
                            self.assertGreater(len(command["reasoning"].split()), 20)
                        self.assertGreater(len(command["evidence"].split()), 20)

            guided = self.server.create_session({"manifest": manifest}, "guided")
            guided["run_ready"] = True
            guided_command = self.server.next_command(guided)
            self.assertEqual(guided_command["narration"], self.server.substitute(goals[0]["narration"], guided))
            self.assertEqual(guided_command["reasoning"], "")
            self.assertEqual(guided_command["evidence"], "")

    def test_scope_window_tracks_the_noticed_offset_in_demonstration_and_guided_modes(self):
        """The coach must not pair a recent report with an independently randomized long range.

        Exercise the real session path across every Discover-template pack and both coached modes.
        The selected action must be the incident age rounded up to a five-minute boundary; the
        demonstration and guided hints must describe that same age and range.
        """
        catalog = json.loads((ROOT / "learning/catalog.json").read_text())["scenarios"]
        discover_packs = [
            entry["id"] for entry in catalog
            if json.loads((ROOT / "learning/scenarios" / entry["id"] / "playbook.json").read_text()).get("extends") == "discover.json"
        ]
        self.assertIn("discover-time-window", discover_packs)
        self.assertIn("slow-payments", discover_packs)
        for pack in discover_packs:
            for seed in range(40):
                for mode in ("demonstration", "guided"):
                    session = self.server.create_session({"manifest": self.materialize(pack, seed)}, mode)
                    session["run_ready"] = True
                    scope = next(goal for goal in session["playbook"]["goals"] if goal["id"] == "scope")
                    command = self.server.next_command(session)
                    offset = session["detected_offset_minutes"]
                    expected_minutes = self.server.recommended_window_minutes(offset)
                    expected_from = f"now-{expected_minutes}m"
                    expected_words = self.server.spell_duration(f"{expected_minutes}m")
                    rendered_hints = self.server.substitute(scope["hints"], session)

                    with self.subTest(pack=pack, seed=seed, mode=mode):
                        self.assertEqual(scope["reference_action"]["arguments"]["from"], expected_from)
                        self.assertEqual(command["value"]["from"], expected_from)
                        self.assertIn(str(offset), rendered_hints[0])
                        self.assertIn(expected_words, rendered_hints[-1])
                        if mode == "demonstration":
                            self.assertIn(str(offset), command["narration"])
                            self.assertIn(expected_words, command["narration"])
                            self.assertIn("five-minute boundary", command["narration"])
                            self.assertEqual(command["reasoning"], "")
                        else:
                            self.assertIn(str(offset), command["narration"])
                            self.assertIn(expected_words, command["narration"])
                            self.assertIn("five-minute boundary", command["narration"])
                            self.assertEqual(command["walkthrough"]["reasoning"], "")
                            self.assertEqual(command["walkthrough"]["narration"],
                                             self.server.substitute(scope["demonstration"]["narration"], session))

    def test_time_window_copy_uses_grammar_aware_finding_for_every_variant(self):
        window_options = self.template("discover-time-window")["parameters"]["window"]["choose"]

        def strings(value, path=()):
            if isinstance(value, str):
                yield path, value
            elif isinstance(value, dict):
                for key, item in value.items():
                    yield from strings(item, path + (key,))
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    yield from strings(item, path + (index,))

        for seed, option in enumerate(window_options):
            template = self.template("discover-time-window")
            template["parameters"]["window"]["choose"] = [option]
            manifest = self.controller.materialize(template, seed, run_id=f"run-window-{seed:05d}")
            playbook = self.server.load_manifest_definition(manifest, "playbook")
            rendered = self.server.substitute(
                playbook,
                {"run_id": manifest["run_id"], "manifest": manifest, "actions": [], "detected_offset_minutes": 13},
            )
            finding = option["label"]
            phrase = f"the {finding}"
            matching_copy = []

            for path, value in strings(rendered):
                if finding not in value or path == ("demonstration_summary", "answer", "finding"):
                    continue
                matching_copy.append(value)
                with self.subTest(finding=finding, path=path):
                    self.assertIn(phrase, value)
                    self.assertNotIn(finding, value.replace(phrase, ""))

            # The isolate step now filters on the OBSERVED status code and cites the graded
            # conclusion, which spells the window as "the <finding>".
            isolate = next(goal for goal in rendered["goals"] if goal["id"] == "isolate")
            self.assertIn(f"spiked during the {finding}", isolate["demonstration"]["evidence"])
            # The finding is still woven through the copy (goal steps + the graded answer), and every
            # occurrence stays grammar-aware ("the <finding>"); the concise debrief no longer repeats
            # it at essay length, so this is a breadth floor, not a verbosity one.
            self.assertGreaterEqual(len(matching_copy), 6)

    def test_every_mode_receives_the_same_seeded_incident_briefing(self):
        manifest = self.materialize("slow-payments", 424242)
        briefings = []
        for mode in ("demonstration", "guided", "challenge"):
            session = self.server.create_session({"manifest": manifest}, mode)
            briefing = self.server.build_incident_briefing(session)
            briefings.append(briefing)
            with self.subTest(mode=mode):
                self.assertEqual(briefing["message_type"], "incident_briefing")
                self.assertEqual(briefing["mode"], mode)
                self.assertEqual(briefing["duration_ms"], 30_000)
                self.assertIn(briefing["detected_offset_minutes"], [4, 6, 8])
                self.assertIn(briefing["source"]["key"], {"support", "pager", "synthetics", "monitoring"})
                self.assertEqual(len(briefing["signals"]), 3)
                self.assertNotIn("${", json.dumps(briefing))
        for key in ("headline", "summary", "impact", "signals", "source", "detected_offset_minutes"):
            self.assertEqual(briefings[0][key], briefings[1][key])
            self.assertEqual(briefings[1][key], briefings[2][key])

        sources = set()
        offsets = set()
        for seed in range(30):
            varied = self.server.build_incident_briefing(
                self.server.create_session({"manifest": self.materialize("slow-payments", seed)}, "guided")
            )
            sources.add(varied["source"]["key"])
            offsets.add(varied["detected_offset_minutes"])
        self.assertGreater(len(sources), 1)
        self.assertGreater(len(offsets), 1)


if __name__ == "__main__":
    unittest.main()
