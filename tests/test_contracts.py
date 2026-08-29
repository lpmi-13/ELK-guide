import hashlib
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
    def test_all_json_documents_parse(self):
        documents = list((ROOT / "learning").rglob("*.json")) + list((ROOT / "kibana-coach").rglob("*.json")) + list((ROOT / "scenario-controller" / "scenarios").glob("*.json"))
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

    def test_demonstration_has_reasoning_and_a_non_interactive_summary(self):
        playbook = json.loads((ROOT / "learning/playbooks/slow-service-investigation.json").read_text())
        for field in ("reasoning", "evidence", "concept"):
            self.assertTrue(all(step.get(field) for step in playbook["steps"]), field)
        self.assertGreaterEqual(len(playbook["demonstration_summary"]["checks"]), 4)

        learning_service = (ROOT / "learning-service/server.py").read_text(encoding="utf-8")
        coach = (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8")
        content = (ROOT / "kibana-coach/src/content-script.js").read_text(encoding="utf-8")
        self.assertIn('command_type = "show_debrief"', learning_service)
        self.assertIn('"evidence": step["evidence"]', learning_service)
        self.assertIn('"concept": step["concept"]', learning_service)
        self.assertIn("command.mode === 'demonstration'", coach)
        self.assertIn('const demonstrationTimingScale = 10', content)
        self.assertIn("demonstrationReadingPause(command)", content)
        self.assertIn('placeAwayFrom(target)', coach)

    def test_demonstration_cursor_is_snappy_and_form_values_are_typed(self):
        cursor = (ROOT / "kibana-coach/src/ui/cursor.js").read_text(encoding="utf-8")
        coach = (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8")
        adapter = (ROOT / "kibana-coach/src/kibana-adapter.js").read_text(encoding="utf-8")

        self.assertIn("Math.min(900, 650 * timingScale)", cursor)
        self.assertIn("cubic-bezier(.4,.1,.6,.9)", coach)
        self.assertIn("this.typingIntervalMs = 70", adapter)
        self.assertIn("await this.typeValue(number, '10', signal)", adapter)
        self.assertIn("await this.typeValue(input, query, signal)", adapter)
        self.assertIn("this.pointAt(number", adapter)
        self.assertIn("this.pointAt(unit", adapter)
        self.assertIn("this.pointAt(apply", adapter)

    def test_demonstration_explains_and_visibly_performs_the_trace_pivot(self):
        playbook = json.loads((ROOT / "learning/playbooks/slow-service-investigation.json").read_text())
        trace_step = next(step for step in playbook["steps"] if step["id"] == "inspect-correlated-trace")
        adapter = (ROOT / "kibana-coach/src/kibana-adapter.js").read_text(encoding="utf-8")
        coach = (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8")

        self.assertIn("To “pivot” means", trace_step["concept"])
        self.assertIn("trace.id", trace_step["narration"])
        self.assertIn('const traceQuery = `scenario.id:', adapter)
        self.assertIn("replace the service filter with this trace ID", adapter)
        for section in ("How to read the evidence", "In plain language", "Current action"):
            self.assertIn(section, coach)

    def test_saved_objects_are_ndjson_with_stable_ids(self):
        objects = [json.loads(line) for line in (ROOT / "kibana/saved-objects.ndjson").read_text().splitlines() if line]
        identities = {(item["type"], item["id"]) for item in objects}
        self.assertIn(("index-pattern", "microservices"), identities)
        self.assertIn(("search", "incident-investigation"), identities)
        self.assertIn(("dashboard", "incident-overview"), identities)
        visualization_ids = {identifier for object_type, identifier in identities if object_type == "visualization"}
        self.assertEqual(visualization_ids, {"request-duration-percentiles", "error-rate-over-time", "events-by-service", "slowest-endpoints", "common-error-types", "active-scenario-events"})
        dashboard = next(item for item in objects if item["type"] == "dashboard")
        panels = json.loads(dashboard["attributes"]["panelsJSON"])
        self.assertEqual(len(panels), 6)
        self.assertEqual({panel["version"] for panel in panels}, {"9.5.2"})

    def test_stack_is_pinned_to_elastic_9_5_2(self):
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        environment = (ROOT / ".env.example").read_text(encoding="utf-8")
        recorder = (ROOT / "scenario-recorder/recorder.mjs").read_text(encoding="utf-8")
        self.assertEqual(compose.count("${STACK_VERSION:-9.5.2}"), 3)
        self.assertIn("STACK_VERSION=9.5.2", environment)
        self.assertIn("kibana_version: '9.5.2'", recorder)

    def test_coach_and_shared_selectors_stay_identical(self):
        shared = json.loads((ROOT / "learning/selectors/kibana-9.5.json").read_text())
        coach = json.loads((ROOT / "kibana-coach/selectors/kibana-9.5.json").read_text())
        self.assertEqual(shared, coach)
        self.assertEqual(shared["kibana_version"], "9.5.2")
        for target in ("kibana.time_picker", "kibana.time_custom_range", "kibana.time_value", "kibana.time_unit", "kibana.time_apply", "kibana.query_bar", "kibana.add_filter", "kibana.first_result", "kibana.first_trace_value", "kibana.trace_field"):
            self.assertTrue(shared["targets"][target])

    def test_kibana_first_run_prompts_are_suppressed(self):
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        self.assertIn("SERVER_PUBLICBASEURL: http://localhost:5601", compose)
        self.assertIn('XPACK_SECURITY_SHOWINSECURECLUSTERWARNING: "false"', compose)

        gateway = (ROOT / "kibana-gateway/nginx.conf").read_text(encoding="utf-8")
        self.assertIn('<script src="/incident-coach/assets/src/kibana-bootstrap.js"></script>', gateway)

        bootstrap = (ROOT / "kibana-coach/src/kibana-bootstrap.js").read_text(encoding="utf-8")
        recorder = (ROOT / "scenario-recorder/recorder.mjs").read_text(encoding="utf-8")
        for key in (
            "discover:docExplorerCalloutClosed",
            "discover:docExplorerUpdateCalloutClosed",
        ):
            self.assertIn(key, bootstrap)
            self.assertIn(key, recorder)

    def test_launcher_uses_scenario_keys_and_unambiguous_evidence_progress(self):
        launcher = (ROOT / "telemetry/index.html").read_text(encoding="utf-8")
        self.assertIn('id="scenario-key"', launcher)
        self.assertIn('minlength="10" maxlength="40"', launcher)
        self.assertNotIn('id="scenario-key" type="text" value="quiet-river-signal" pattern=', launcher)
        self.assertIn("scenario_key:scenarioKey.value", launcher)
        self.assertIn('id="evidence-progress"', launcher)
        self.assertIn('id="open-kibana" class="button" type="button" disabled', launcher)
        self.assertIn("evidenceProgress.value = Math.min(indexed, threshold)", launcher)
        self.assertNotIn("minimum of ${required} met", launcher)
        self.assertNotIn("${count} of ${required} affected traces", launcher)

        manifest_schema = json.loads((ROOT / "learning/schemas/run-manifest.schema.json").read_text())
        scenario_key = manifest_schema["properties"]["scenario_key"]
        self.assertEqual(scenario_key, {"type": "string", "minLength": 10, "maxLength": 40})

    def test_launcher_defaults_to_demonstration_and_uses_dismissible_instructions_dialog(self):
        launcher = (ROOT / "telemetry/index.html").read_text(encoding="utf-8")
        demonstration = '<option value="demonstration" selected>Demonstration</option>'
        guided = '<option value="guided">Guided practice</option>'
        challenge = '<option value="challenge">Challenge</option>'

        self.assertLess(launcher.index(demonstration), launcher.index(guided))
        self.assertLess(launcher.index(guided), launcher.index(challenge))
        self.assertIn('<dialog id="instructions"', launcher)
        self.assertIn("instructions.showModal()", launcher)
        self.assertIn("localStorage.setItem(instructionsStorageKey, 'true')", launcher)
        self.assertIn("localStorage.getItem(instructionsStorageKey) !== 'true'", launcher)

    def test_launcher_assistance_options_match_the_closed_control_width(self):
        launcher = (ROOT / "telemetry/index.html").read_text(encoding="utf-8")

        self.assertIn(".select-options { position:absolute", launcher)
        self.assertIn("left:0;right:0;width:auto;box-sizing:border-box", launcher)
        self.assertIn("modeControl.classList.add('enhanced')", launcher)
        self.assertIn("modeTrigger.setAttribute('aria-haspopup', 'listbox')", launcher)
        self.assertIn("modeSelect.selectedIndex = index", launcher)

    def test_kibana_session_starts_automatically_without_browser_install(self):
        launcher = (ROOT / "telemetry/index.html").read_text(encoding="utf-8")
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        gateway = (ROOT / "kibana-gateway/nginx.conf").read_text(encoding="utf-8")
        bootstrap = (ROOT / "kibana-coach/src/kibana-bootstrap.js").read_text(encoding="utf-8")
        content_script = (ROOT / "kibana-coach/src/content-script.js").read_text(encoding="utf-8")
        session_client = (ROOT / "kibana-coach/src/session-client.js").read_text(encoding="utf-8")
        learning_service = (ROOT / "learning-service/server.py").read_text(encoding="utf-8")

        for parameter in ("incident_coach_server", "incident_coach_session", "incident_coach_token", "incident_coach_run", "incident_coach_mode"):
            self.assertIn(parameter, launcher)
            self.assertIn(parameter, bootstrap)
        self.assertIn("history.replaceState", bootstrap)
        self.assertIn("startSession(JSON.parse(savedConfig))", content_script)
        self.assertNotIn("incident-coach-pair", content_script)
        self.assertNotIn("/claim", session_client)
        self.assertNotIn("pairing_code", learning_service)
        self.assertIn('"connection_token"', learning_service)
        self.assertIn("kibana-gateway:", compose)
        self.assertIn("location /incident-coach/learning/", gateway)
        self.assertIn("sub_filter '</head>'", gateway)
        self.assertIn("there is nothing to install in your browser", launcher)
        self.assertIn("openKibana.disabled = !coachRuntimeReady", launcher)
        self.assertIn("${target.origin}/incident-coach/learning", launcher)
        self.assertIn("target.hash = `${route}?${parameters}`", launcher)
        self.assertIn("const hashParameters = new URLSearchParams", bootstrap)
        self.assertIn("access_log off", gateway)


if __name__ == "__main__":
    unittest.main()
