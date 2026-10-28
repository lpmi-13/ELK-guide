"""The log-hunt packs must randomize their specifics per run while staying consistent.

These checks exercise the real materialize -> playbook-resolution path (not just the
static matrix) so that a seeded run's brief, seeded signal, truth, and demonstrated KQL
all agree, and the same seed is reproducible. A fixed symptom can use the same first
filter across seeds while the producer and version found in its results vary.
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
                with self.subTest(seed=seed, goal=goal_id):
                    self.assertEqual(command["learning_focus"], expected_focus)
                    self.assertIn("http.response.status_code", command["reasoning"] + command["evidence"])
                    self.assertIn(str(incident["status"]), command["evidence"])
                    self.assertIn("200", command["evidence"])
                    if goal_id == "inspect":
                        self.assertNotIn(incident["bad_version"], command["reasoning"])
                        self.assertNotIn(incident["good_version"], command["reasoning"])
                        self.assertIn(incident["bad_version"], command["evidence"])
                        self.assertIn(incident["good_version"], command["evidence"])

    def test_specifics_and_required_filters_vary_across_seeds(self):
        for pack in LOG_HUNT_PACKS:
            findings, queries = set(), set()
            for seed in range(60):
                manifest = self.materialize(pack, seed)
                # What the learner must find: the time-window lesson's window is always "the last 15
                # minutes" around a randomized onset, so its run-specific facts are in the scope.
                answers = manifest["scenario"]["truth"]["answers"]
                findings.add((answers["finding"], answers["scope"]))
                playbook = self.server.load_manifest_definition(manifest, "playbook")
                isolate = next(goal for goal in playbook["goals"] if goal["id"] == "isolate")
                _, signature = self._isolate_target(isolate)
                queries.add(signature)
            with self.subTest(pack=pack):
                self.assertGreater(len(findings), 1, "findings should differ across seeds")
                if pack == "schema-drift-data-quality":
                    self.assertEqual(queries, {"schema.route_present: false"})
                else:
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

    def test_demonstration_copy_is_resolved_and_staged(self):
        catalog = json.loads((ROOT / "learning/catalog.json").read_text())
        for offset, entry in enumerate(catalog["scenarios"]):
            manifest = self.materialize(entry["id"], 135 + offset)
            session = self.server.create_session({"manifest": manifest}, "demonstration")
            session["run_ready"] = True
            goals = session["playbook"]["goals"]
            finding = manifest["scenario"]["truth"]["answers"]["finding"]
            demonstrated = [
                item for item in goals
                if item["reference_action"]["command"] not in {"request_answer", "request_diagnosis"}
            ]

            for index, goal in enumerate(goals):
                session["completed_goals"] = {item["id"] for item in goals[:index]}
                session["pending_command"] = None
                command = self.server.next_command(session)
                with self.subTest(scenario=entry["id"], goal=goal["id"]):
                    self.assertNotIn("${", json.dumps(command))
                    if command["type"] == "show_debrief":
                        summary = command["value"]
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
                        self.assertGreaterEqual(len(command["narration"].split()), 12)
                        if command["type"] == "set_time_range" or (
                            entry["id"] == "schema-drift-data-quality" and goal["id"] in {"isolate", "inspect"}
                        ):
                            # These opening cards include the motivation directly before the action.
                            self.assertEqual(command["reasoning"], "")
                        else:
                            self.assertGreaterEqual(len(command["reasoning"].split()), 12)
                        self.assertGreaterEqual(len(command["evidence"].split()), 12)

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
                    onset = session["incident_onset_minutes"]
                    # A pack that seeds a visible onset is windowed from that rise as it stands now,
                    # not from the report.
                    age = self.server.incident_onset_age_minutes(session["manifest"])
                    expected_minutes = self.server.recommended_window_minutes(
                        offset if onset is None else age + self.server.ONSET_LEAD_MINUTES)
                    expected_from = f"now-{expected_minutes}m"
                    expected_words = self.server.spell_duration(f"{expected_minutes}m")
                    rendered_hints = self.server.substitute(scope["hints"], session)

                    with self.subTest(pack=pack, seed=seed, mode=mode):
                        self.assertEqual(self.server.substitute(scope["reference_action"]["arguments"], session)["from"], expected_from)
                        self.assertEqual(command["value"]["from"], expected_from)
                        self.assertIn(str(offset), rendered_hints[0])
                        self.assertIn(expected_words, rendered_hints[-1])
                        if onset is not None:
                            # The copy sends the learner to the histogram's rise; the report only says
                            # when the failures were noticed, which is after they began.
                            self.assertGreater(onset, offset)
                            self.assertIn(str(offset), command["narration"])
                            self.assertIn("histogram", command["narration"])
                            self.assertIn("histogram", rendered_hints[0])
                            self.assertNotIn("five-minute boundary", command["narration"])
                            if mode == "guided":
                                self.assertEqual(command["walkthrough"]["narration"],
                                                 self.server.substitute(scope["demonstration"]["narration"], session))
                            else:
                                self.assertEqual(command["goal_focus"], {"kind": "histogram"})
                        elif mode == "demonstration":
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

    def test_the_recommended_window_keeps_reaching_the_onset_as_the_run_ages(self):
        from datetime import datetime, timedelta, timezone
        manifest = self.materialize("discover-time-window", 3)
        onset = manifest["parameters"]["timing"]["onset"]
        for mode in ("demonstration", "guided"):
            for minutes_later in (0, 4, 25):
                manifest["created_at"] = (datetime.now(timezone.utc) - timedelta(minutes=minutes_later)).isoformat()
                session = self.server.create_session({"manifest": manifest}, mode)
                session["run_ready"] = True
                command = self.server.next_command(session)
                window = int(command["value"]["from"].removeprefix("now-").removesuffix("m"))
                with self.subTest(mode=mode, minutes_later=minutes_later):
                    self.assertGreaterEqual(window, onset + minutes_later + self.server.ONSET_LEAD_MINUTES)
                    self.assertLess(window, onset + minutes_later + self.server.ONSET_LEAD_MINUTES + 5)
                    if mode == "guided":
                        hints = self.server.substitute(session["playbook"]["goals"][0]["hints"], session)
                        self.assertIn(f"last {self.server.spell_duration(f'{window}m')}", hints[-1])
                    # A learner's window is judged against the onset as it stands now, too.
                    action = {"type": "time_range_changed", "sequence": 1, "run_id": session["run_id"], "session_id": session["id"],
                              "protocol_version": 2, "details": {"from": "now-15m", "to": "now", "from_minutes": 15, "incident_offset_minutes": 8}}
                    from unittest import mock
                    with mock.patch.object(self.server, "action_evidence", return_value={"assertions": {}, "trace_services": 0}):
                        accepted = bool(self.server.record_action(session, action)["goals_progressed"])
                    self.assertEqual(accepted, 15 + 1 >= onset + minutes_later)

    def test_incident_window_is_a_bounded_rise_the_histogram_can_date(self):
        """The time-window lesson's answer must be in the data, not derived from the report.

        Its failures start before support noticed them and stop before seeding, so the histogram shows
        normal traffic either side of a rise; the recommended window opens a few minutes before that
        rise. The briefing names the user-facing symptom of the run's service, so a catalog incident
        is not reported as checkout.
        """
        from datetime import datetime, timezone
        for seed in range(30):
            manifest = self.materialize("discover-time-window", seed)
            session = self.server.create_session({"manifest": manifest}, "demonstration")
            incident, timing = manifest["parameters"]["incident"], manifest["parameters"]["timing"]
            seeded_at = datetime.now(timezone.utc)
            documents = self.controller.generate_seeded_events(manifest)
            failing = [document for document in documents if document["http"]["response"]["status_code"] == incident["status"]]
            ages = [(seeded_at - datetime.fromisoformat(document["@timestamp"])).total_seconds() / 60 for document in failing]
            scope = session["playbook"]["goals"][0]
            window = int(self.server.substitute(scope["reference_action"]["arguments"], session)["from"].removeprefix("now-").removesuffix("m"))
            briefing = self.server.build_incident_briefing(session)
            with self.subTest(seed=seed):
                self.assertEqual(session["detected_offset_minutes"], timing["noticed"])
                self.assertTrue(timing["end"] < timing["noticed"] < timing["onset"])
                self.assertLessEqual(max(ages), timing["onset"])
                self.assertGreaterEqual(min(ages), timing["end"] - 0.1)
                self.assertGreaterEqual(window - timing["onset"], 2)
                self.assertIn(incident["headline"], briefing["headline"])
                self.assertIn(incident["journey"], briefing["summary"])
                self.assertNotIn("checkout", manifest["scenario"]["title"].lower())
                self.assertNotIn("${", json.dumps(briefing))

    def test_every_log_hunt_filter_comes_from_a_value_a_survey_revealed(self):
        """No demonstrated filter may name a value the learner hasn't been shown on screen.

        Each pack reads a field's Top values before its first filter, and that filter (or the phrase
        it excludes) is the value the survey step rings — never one taken from the answer key.
        """
        for pack in ("discover-time-window", "http-error-regression", "rare-error-signature", "auth-rejection-surge",
                     "log-pattern-noise-reduction", "deployment-version-regression"):
            for seed in range(12):
                manifest = self.materialize(pack, seed)
                playbook = self.server.load_manifest_definition(manifest, "playbook")
                goals = {goal["id"]: goal for goal in playbook["goals"]}
                survey, isolate = goals["survey"], goals["isolate"]
                focus = survey["demonstration"]["evidence_focus"]
                arguments = isolate["reference_action"]["arguments"]
                with self.subTest(pack=pack, seed=seed):
                    self.assertEqual([goal["id"] for goal in playbook["goals"]][:3], ["scope", "survey", "isolate"])
                    self.assertEqual(isolate["requires"], ["survey"])
                    self.assertEqual(survey["reference_action"], {"command": "open_field_statistics", "target": "kibana.field_list", "arguments": {"field": focus["field"]}})
                    if isinstance(arguments, dict):
                        self.assertEqual((arguments["field"], str(arguments["value"])), (focus["field"], str(focus["value"])))
                    else:
                        # A query may only name what was on screen: the surveyed value, or a phrase of the
                        # ringed line when it excludes noise.
                        fragment = manifest["parameters"]["incident"].get("exclude_fragment")
                        if fragment:
                            self.assertIn(fragment, focus["value"])
                            self.assertIn(f'not {focus["field"]}: "{fragment}"', arguments)
                        else:
                            self.assertIn(f'{focus["field"]}: {focus["value"]}', arguments)
                    for phase in ("narration", "reasoning"):
                        self.assertNotIn(str(focus["value"]), survey["demonstration"][phase])

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

            # The isolate step filters on the observed status code. The full conclusion is
            # reserved for the event-inspection evidence card.
            isolate = next(goal for goal in rendered["goals"] if goal["id"] == "isolate")
            inspect = next(goal for goal in rendered["goals"] if goal["id"] == "inspect")
            self.assertNotIn(f"spiked during the {finding}", isolate["demonstration"]["evidence"])
            self.assertIn(f"spiked during the {finding}", inspect["demonstration"]["evidence"])
            # The finding is still woven through the copy (goal steps + the graded answer), and every
            # occurrence stays grammar-aware ("the <finding>"); the concise debrief no longer repeats
            # it at essay length, so this is a breadth floor, not a verbosity one.
            self.assertGreaterEqual(len(matching_copy), 3)

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


class AnswerGradingTests(unittest.TestCase):
    """Challenge answers are graded on the facts they state, the way a reviewer would read them."""

    @classmethod
    def setUpClass(cls):
        cls.controller = load_module("scenario_controller_grading", ROOT / "scenario-controller/controller.py")
        cls.server = load_module("learning_server_grading", ROOT / "learning-service/server.py")
        cls.server.LEARNING_DIR = ROOT / "learning"
        cls.evaluator = sys.modules["engine.evaluator"]

    def session(self, pack, seed, created_minutes_ago=0):
        from datetime import datetime, timedelta, timezone
        manifest = self.controller.materialize(json.loads((ROOT / "learning/scenarios" / pack / "scenario.json").read_text()), seed, run_id=f"run-{seed:012d}")
        manifest["created_at"] = (datetime.now(timezone.utc) - timedelta(minutes=created_minutes_ago)).isoformat()
        session = self.server.create_session({"manifest": manifest}, "challenge")
        session["completed_goals"] = {goal["id"] for goal in session["playbook"]["goals"]}
        return session

    def grade(self, session, **answer):
        session["answer"] = answer
        evidence = {"assertions": {item["id"]: True for item in session["manifest"]["scenario"]["truth"]["assertions"]}}
        feedback = self.server.score_session(session, evidence=evidence)
        return {item["id"]: item["correct"] for item in feedback["answer_review"]}, feedback

    def clock(self, moment, minutes=0):
        from datetime import timedelta
        return f"{moment + timedelta(minutes=minutes):%H:%M}"

    def test_incident_window_is_graded_against_when_the_rise_happened(self):
        session = self.session("discover-time-window", 3)
        incident = session["manifest"]["parameters"]["incident"]
        start, end = self.evaluator.incident_bounds(session["manifest"])
        conclusion = f"{incident['service']} errors spiked from {self.clock(start)} to {self.clock(end)}"
        results, feedback = self.grade(session, finding=f"{self.clock(start, 1)}–{self.clock(end, 1)}", status=f"HTTP {incident['status']}",
                                       route=incident["route"], scope=f"the {incident['service']} service", conclusion=conclusion,
                                       evidence="Top values and one expanded request.", client_utc_offset_minutes=0)
        self.assertTrue(all(results.values()), results)
        self.assertTrue(feedback["task_correct"])
        # No internal assertion ids were cited: evidence the learner reached in Kibana still counts.
        self.assertEqual(feedback["components"]["evidence_quality"], 20)
        self.assertEqual(next(item for item in feedback["answer_review"] if item["id"] == "finding")["expected"],
                         f"{self.clock(start)}–{self.clock(end)}")
        for wrong in (f"{self.clock(start, -6)}–{self.clock(end)}", f"{self.clock(start)}–{self.clock(end, -4)}", "recently"):
            with self.subTest(finding=wrong):
                self.assertFalse(self.grade(session, finding=wrong, client_utc_offset_minutes=0)[0]["finding"])
        # Discover shows local time: the same instant read in UTC+2 is a different clock reading.
        self.assertTrue(self.grade(session, finding=f"{self.clock(start, 120)} to {self.clock(end, 120)}", client_utc_offset_minutes=-120)[0]["finding"])
        self.assertTrue(self.grade(session, finding="the last 15 minutes")[0]["finding"])
        self.assertFalse(self.grade(session, finding="the last hour")[0]["finding"])

    def test_a_relative_window_is_judged_when_it_is_submitted(self):
        # Twenty minutes later "the last 15 minutes" no longer reaches back to the onset.
        session = self.session("discover-time-window", 3, created_minutes_ago=20)
        onset = session["manifest"]["parameters"]["timing"]["onset"]
        self.assertFalse(self.grade(session, finding="last 15 minutes")[0]["finding"])
        self.assertTrue(self.grade(session, finding=f"last {onset + 21} minutes")[0]["finding"])

    def test_values_are_matched_as_words_and_conclusions_by_the_facts_they_state(self):
        for seed in range(40):
            session = self.session("http-error-regression", seed)
            incident = session["manifest"]["parameters"]["incident"]
            if incident["finding"] == "/api/orders/refund":
                break
        results, _ = self.grade(session, finding="the /api/orders/refund endpoint", scope=f"{incident['status']}s",
                                conclusion=f"Refund calls fail with {incident['error_type']} on /api/orders/refund since the release.")
        self.assertTrue(all(results.values()), results)
        self.assertFalse(self.grade(session, finding="/api/orders")[0]["finding"])
        self.assertFalse(self.grade(session, finding="/api/orders, /api/orders/refund or /checkout")[0]["finding"])
        self.assertFalse(self.grade(session, conclusion="Something regressed after the release.")[0]["conclusion"])
        self.assertFalse(self.grade(session, conclusion=f"{incident['error_type']} is failing.")[0]["conclusion"])


class StepCheckTests(unittest.TestCase):
    """A step completes on the right evidence, not on any action that touches the right field."""

    @classmethod
    def setUpClass(cls):
        cls.controller = load_module("scenario_controller_checks", ROOT / "scenario-controller/controller.py")
        cls.server = load_module("learning_server_checks", ROOT / "learning-service/server.py")
        cls.server.LEARNING_DIR = ROOT / "learning"
        cls.matrix = load_module("scenario_matrix_checks", ROOT / "scripts/test-scenario-matrix.py")

    def at_step(self, pack, seed, step_id):
        manifest = self.controller.materialize(json.loads((ROOT / "learning/scenarios" / pack / "scenario.json").read_text()), seed, run_id=f"run-{seed:012d}")
        session = self.server.create_session({"manifest": manifest}, "guided")
        goals = session["playbook"]["goals"]
        session["completed_goals"] = {goal["id"] for goal in goals[:[goal["id"] for goal in goals].index(step_id)]}
        evidence = {"assertions": {item["id"]: True for item in manifest["scenario"]["truth"]["assertions"]}}
        return session, next(goal for goal in goals if goal["id"] == step_id), evidence

    def completes(self, session, evidence, step_id, action):
        trial = {**session, "completed_goals": set(session["completed_goals"])}
        return step_id in self.server.evaluate_action(trial, action, evidence)["goals_progressed"]

    def test_a_filter_step_needs_the_observed_value_not_just_the_field(self):
        for pack in LOG_HUNT_PACKS:
            for seed in (2, 9):
                session, isolate, evidence = self.at_step(pack, seed, "isolate")
                reference = self.matrix.action_for(isolate, session["manifest"]["scenario"])
                field = next(validator for route in isolate["accepts"] for validator in route["validators"]
                             if validator["kind"] in {"query_contains", "filter_contains", "filter_excludes"})
                field = (field.get("fields") or [field.get("field")])[0]
                with self.subTest(pack=pack, seed=seed):
                    self.assertTrue(self.completes(session, evidence, "isolate", reference))
                    for wrong in ({"type": "query_submitted", "details": {"query": f'{field}: "something-else"'}},
                                  {"type": "filter_added", "details": {"field": field, "value": "something-else", "negate": False}},
                                  {"type": "filter_added", "details": {"field": "event.outcome", "value": "success", "negate": True}}):
                        self.assertFalse(self.completes(session, evidence, "isolate", wrong), wrong)

    def test_checking_one_event_means_opening_one(self):
        for pack in LOG_HUNT_PACKS:
            session, _inspect, evidence = self.at_step(pack, 4, "inspect")
            with self.subTest(pack=pack):
                for action_type in ("column_removed", "field_statistics_opened", "field_inspected"):
                    self.assertFalse(self.completes(session, evidence, "inspect", {"type": action_type, "details": {"field": "message"}}))
                self.assertTrue(self.completes(session, evidence, "inspect", {"type": "document_expanded", "details": {}})
                                or pack == "deployment-version-regression")


class ChallengeModeTests(unittest.TestCase):
    """A challenge is the learner's own investigation, scored only in its debrief."""

    @classmethod
    def setUpClass(cls):
        cls.controller = load_module("scenario_controller_challenge", ROOT / "scenario-controller/controller.py")
        cls.server = load_module("learning_server_challenge", ROOT / "learning-service/server.py")
        cls.server.LEARNING_DIR = ROOT / "learning"

    def test_the_answer_form_is_open_from_the_start_and_progress_stays_private(self):
        from unittest import mock
        for pack in LOG_HUNT_PACKS:
            manifest = self.controller.materialize(json.loads((ROOT / "learning/scenarios" / pack / "scenario.json").read_text()), 5, run_id="run-000000000005")
            session = self.server.create_session({"manifest": manifest}, "challenge")
            session["run_ready"] = True
            command = self.server.next_command(session)
            with self.subTest(pack=pack):
                self.assertIn(command["type"], {"request_answer", "request_diagnosis"})
                self.assertFalse(session["completed_goals"])
                self.assertFalse(session["policy"]["allow_hints"])
                scope = session["playbook"]["goals"][0]
                action = {"type": "time_range_changed", "sequence": 1, "run_id": session["run_id"], "session_id": session["id"],
                          "protocol_version": 2, "details": {**self.server.substitute(scope["reference_action"]["arguments"], session), "from_minutes": 60}}
                with mock.patch.object(self.server, "action_evidence", return_value={"assertions": {}, "trace_services": 0}):
                    evaluation = self.server.record_action(session, action)
                # The step is recorded for the debrief, but the coach is told nothing about it.
                self.assertEqual(evaluation["goals_progressed"], ["scope"])
                self.assertEqual(self.server.learner_evaluation(session, evaluation), {"outcome": "recorded", "goals_progressed": [], "meaningful": False})
                self.assertFalse({"completed_goals", "step", "step_count"} & set(self.server.learner_session(session)))
                self.assertEqual(self.server.next_command(session)["command_id"], command["command_id"])
