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
        debrief = (ROOT / "kibana-coach/src/ui/debrief.js").read_text(encoding="utf-8")
        self.assertIn('command_type = "show_debrief"', learning_service)
        self.assertIn('explanation = step.get("demonstration", {})', learning_service)
        self.assertIn('"evidence": explanation_text("evidence")', learning_service)
        self.assertIn('"concept": explanation_text("concept")', learning_service)
        self.assertIn("command.mode === 'demonstration'", coach)
        self.assertIn('const demonstrationSlowdown = 3', content)
        self.assertIn('const demonstrationTimingScale = 10 * demonstrationSlowdown', content)
        self.assertIn('readingPause(text) * demonstrationSlowdown', content)
        self.assertNotIn("readBeat(command.reasoning)", content)
        self.assertIn('placeAwayFrom(target)', coach)
        self.assertIn("max-height:calc(100vh - 48px);overflow:auto", coach)
        self.assertIn("<strong>Problem found</strong>", debrief)
        self.assertIn("summary.answer?.conclusion || summary.conclusion", debrief)

    def test_guided_show_me_starts_with_the_action_and_explains_it_afterward(self):
        learning_service = (ROOT / "learning-service/server.py").read_text(encoding="utf-8")
        coach = (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8")
        content = (ROOT / "kibana-coach/src/content-script.js").read_text(encoding="utf-8")
        self.assertIn('command["walkthrough"]', learning_service)
        self.assertIn("beginWalkthrough(command)", coach)
        self.assertIn("this.enterPhase('action', command)", coach)
        self.assertIn("coach.beginWalkthrough(walkthrough)", content)
        self.assertNotIn("await readBeat(walkthrough.narration)", content)
        self.assertNotIn("await readBeat(walkthrough.reasoning)", content)
        self.assertIn("[walkthrough.reasoning, walkthrough.evidence]", content)

    def test_demonstration_step_is_goal_then_action_then_a_learner_paced_result(self):
        learning_service = (ROOT / "learning-service/server.py").read_text(encoding="utf-8")
        coach = (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8")
        content = (ROOT / "kibana-coach/src/content-script.js").read_text(encoding="utf-8")
        adapter = (ROOT / "kibana-coach/src/kibana-adapter.js").read_text(encoding="utf-8")
        # A short goal card, not a long countdown, before the action.
        self.assertIn("Math.min(8000, Math.max(5000, wordCount(text) * 300))", content)
        self.assertIn("const pause = goalPause(command.narration);", content)
        # The result beat rings the evidence and waits for Continue; only then is the step reported,
        # so neither the next step nor the debrief can cover a result the learner is still reading.
        self.assertIn("if (command.mode === 'demonstration' && action) await showResult(command, controller.signal);", content)
        self.assertLess(content.index("await showResult(command, controller.signal)"), content.index("client.sendAction(action, 'tutorial')"))
        self.assertIn("await coach.waitForAdvance(signal);", content)
        self.assertIn("adapter.closeTransientPopovers();", content)
        self.assertIn("if (executionController && currentCommand?.mode === 'demonstration') return;", content)
        self.assertIn("advance.textContent = 'Continue';", coach)
        self.assertIn('"evidence_focus": substitute(explanation.get("evidence_focus"), session)', learning_service)
        for kind in ("histogram", "query", "filter", "top_values", "document"):
            self.assertIn(f"kind === '{kind}'", adapter)
        # A goal that starts by reading the page (where the histogram rises) rings that while its line
        # is up, instead of dimming it behind the control's spotlight; the action phase clears the ring.
        self.assertIn('"goal_focus": substitute(explanation.get("goal_focus"), session)', learning_service)
        self.assertIn("coach.showCommand(command, command.goal_focus ? null : target);", content)
        self.assertIn("coach.showGoalFocus(await adapter.findEvidence({...command, evidence_focus: command.goal_focus}, controller.signal));", content)
        self.assertLess(content.index("coach.showGoalFocus("), content.index("const pause = goalPause(command.narration);"))
        self.assertIn("if (phase !== 'learning') this.clearEvidenceHighlights();", coach)

    def test_challenge_mode_shows_no_route_and_no_live_feedback(self):
        coach = (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8")
        content = (ROOT / "kibana-coach/src/content-script.js").read_text(encoding="utf-8")
        debrief = (ROOT / "kibana-coach/src/ui/debrief.js").read_text(encoding="utf-8")
        server = (ROOT / "learning-service/server.py").read_text(encoding="utf-8")
        self.assertIn("challenge ? 'challenge' : `${command.mode} · step ${command.step_index + 1} of ${command.step_count}`", coach)
        self.assertIn("this.root.querySelector('.progress').hidden = challenge;", coach)
        self.assertIn("this.root.querySelector('#hint').hidden = command.mode !== 'guided';", coach)
        self.assertIn('if not session["policy"].get("allow_hints", True):', server)
        self.assertIn('"evaluation": learner_evaluation(session, evaluation), "session": learner_session(session),', server)
        self.assertIn('and session["mode"] != "challenge":', server)
        # The debrief puts each answer beside what the evidence showed, as text, and names the route's steps.
        self.assertIn("item.querySelector('.answer-given').textContent = `You: ${field.submitted || '(blank)'}`;", debrief)
        self.assertIn("(feedback.reference_steps || feedback.reference_route || []).join(' → ')", debrief)
        self.assertIn("client_utc_offset_minutes: new Date().getTimezoneOffset()", content)

    def test_an_idle_learner_stays_connected_and_keeps_a_typed_answer(self):
        import re
        client = (ROOT / "kibana-coach/src/session-client.js").read_text(encoding="utf-8")
        content = (ROOT / "kibana-coach/src/content-script.js").read_text(encoding="utf-8")
        server = (ROOT / "learning-service/server.py").read_text(encoding="utf-8")
        idle_timeout = int(re.search(r"connection\.settimeout\((\d+)\)", server).group(1))
        heartbeat = int(re.search(r"message_type: 'heartbeat'\}\)\);\n\s*\}, (\d+)\);", client).group(1))
        self.assertLess(heartbeat, idle_timeout * 1000 / 2)
        self.assertIn("clearInterval(this.heartbeat);", client)
        self.assertIn("currentCommand?.command_id === command.command_id) return;\n      // A reconnect", content)
        self.assertIn("if (['request_answer', 'request_diagnosis'].includes(command.type) && command.mode !== 'demonstration' &&", content)

    def test_expand_document_is_reported_only_once_the_document_is_open(self):
        discover = (ROOT / "kibana-coach/src/adapters/discover.js").read_text(encoding="utf-8")
        wait = discover.index("await host.waitFor('kibana.doc_viewer', 8000, signal)")
        self.assertLess(discover.index("await host.pointAt(target, coach, timingScale, signal, activity, {activate: true});"), wait)
        self.assertLess(wait, discover.index("expand_document: 'document_expanded'"))
        self.assertIn("throw new Error('The document did not open. Try expanding the first result again.');", discover)

    def test_demonstration_cursor_is_snappy_and_form_values_are_typed(self):
        cursor = (ROOT / "kibana-coach/src/ui/cursor.js").read_text(encoding="utf-8")
        coach = (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8")
        adapter = (ROOT / "kibana-coach/src/kibana-adapter.js").read_text(encoding="utf-8")

        self.assertIn("Math.min(900, 650 * timingScale)", cursor)
        self.assertIn("cubic-bezier(.4,.1,.6,.9)", coach)
        self.assertIn("this.typingIntervalMs = 70", adapter)
        self.assertIn("const range = this.relativeTimeRange(command.value)", adapter)
        self.assertIn("await this.typeValue(number, range.amount, signal, coach)", adapter)
        self.assertIn("await this.typeValue(input, query, signal, coach)", adapter)
        self.assertIn("this.pointAt(number", adapter)
        self.assertIn("this.pointAt(unit", adapter)
        self.assertIn("this.pointAt(apply", adapter)

    def test_demonstration_steps_can_be_advanced(self):
        coach = (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8")
        content = (ROOT / "kibana-coach/src/content-script.js").read_text(encoding="utf-8")
        client = (ROOT / "kibana-coach/src/session-client.js").read_text(encoding="utf-8")
        learning_service = (ROOT / "learning-service/server.py").read_text(encoding="utf-8")

        # Advance replaces Skip: it performs the step's real action instead of jumping past it.
        self.assertIn('<button id="advance"', coach)
        self.assertIn("advance.hidden = command.mode !== 'demonstration'", coach)
        self.assertIn("coach.onAdvance = () =>", content)
        # Advance completes a reading pause on screen. During an action it waits for the action to
        # finish, then continues past the learning card; it never skips the Kibana action itself.
        self.assertIn("completeReadingBeat", content)
        self.assertIn("await readingBeatWait(pause, controller.signal)", content)
        # The un-performed skip pathway is gone from both the client and the service.
        self.assertNotIn("onSkip", content)
        self.assertNotIn("message_type: 'skip'", client)
        self.assertNotIn('message_type == "skip"', learning_service)
        self.assertNotIn("skip_pending_command", learning_service)

    def test_each_mode_waits_for_the_timed_incident_briefing(self):
        briefing = (ROOT / "kibana-coach/src/ui/incident-briefing.js").read_text(encoding="utf-8")
        client = (ROOT / "kibana-coach/src/session-client.js").read_text(encoding="utf-8")
        content = (ROOT / "kibana-coach/src/content-script.js").read_text(encoding="utf-8")
        learning_service = (ROOT / "learning-service/server.py").read_text(encoding="utf-8")
        gateway = (ROOT / "kibana-gateway/nginx.conf").read_text(encoding="utf-8")

        self.assertIn("Date.now() - Number(minutesAgo || 0) * 60_000", briefing)
        self.assertIn("setTimeout(dismiss, duration)", briefing)
        self.assertIn("dialog.showModal()", briefing)
        self.assertIn("briefing.summary", briefing)
        self.assertIn("Noticed ${briefing.detected_offset_minutes} minutes ago", briefing)
        self.assertIn("briefing.impact", briefing)
        self.assertNotIn("briefing.environment", briefing)
        self.assertNotIn("briefing.owner", briefing)
        self.assertIn("image.src = briefing.graphic", briefing)
        self.assertIn("briefing.source.label", briefing)
        self.assertIn("briefing-source-icon", briefing)
        self.assertIn("transform:scaleX(0)", briefing)
        self.assertIn("fill.style.transform = 'scaleX(1)'", briefing)
        for mode in ("demonstration", "guided", "challenge"):
            self.assertIn(f"{mode}:", briefing)
        self.assertIn("message.message_type === 'incident_briefing'", client)
        self.assertIn("message_type: 'briefing_ack'", client)
        self.assertIn("await coach.showBriefing(briefing)", content)
        self.assertIn('elif message_type == "briefing_ack":', learning_service)
        self.assertIn("build_incident_briefing(session)", learning_service)
        self.assertIn("/incident-coach/assets/src/ui/incident-briefing.js", gateway)
        self.assertTrue((ROOT / "kibana-coach/assets/incident-signal.webp").is_file())

    def test_guided_mode_can_reopen_the_incident_briefing_without_a_pause_control(self):
        coach = (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8")
        briefing = (ROOT / "kibana-coach/src/ui/incident-briefing.js").read_text(encoding="utf-8")

        self.assertIn('<button id="incident-info"', coach)
        self.assertIn("this.currentBriefing = briefing", coach)
        self.assertIn("this.briefing.show(this.currentBriefing, {review: true})", coach)
        self.assertIn("command.mode === 'demonstration' || !this.currentBriefing", coach)
        self.assertIn("command.mode !== 'demonstration'", coach)
        self.assertIn("show(briefing, {review = false} = {})", briefing)
        self.assertIn("review ? this.modeCopy(briefing.mode).back", briefing)
        self.assertIn("back: 'Return to guided practice'", briefing)
        self.assertIn("if (!review) {", briefing)

    def test_demonstration_explains_and_visibly_performs_the_trace_pivot(self):
        playbook = json.loads((ROOT / "learning/playbooks/slow-service-investigation.json").read_text())
        trace_step = next(step for step in playbook["steps"] if step["id"] == "inspect-correlated-trace")
        adapter = (ROOT / "kibana-coach/src/kibana-adapter.js").read_text(encoding="utf-8")
        coach = (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8")

        self.assertIn("To “pivot” means", trace_step["concept"])
        self.assertIn("trace.id", trace_step["narration"])
        self.assertIn('const traceQuery = `scenario.id:', adapter)
        self.assertIn("replace the service filter with this trace ID", adapter)
        # The demonstration explains its motive before acting; guided Show me can still
        # use the learning card when the learner starts its action immediately.
        for beat in ("beginActionPhase", "showLearning", "showResult", "Doing it now", "What this shows"):
            self.assertIn(beat, coach)
        content = (ROOT / "kibana-coach/src/content-script.js").read_text(encoding="utf-8")
        self.assertNotIn("coach.showWhy(command)", content)
        self.assertIn("if (walkthrough && learning.evidence)", content)

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

    def test_launcher_uses_scenario_keys_and_new_tab_handoff(self):
        launcher = (ROOT / "telemetry/index.html").read_text(encoding="utf-8")
        self.assertIn('id="scenario-key"', launcher)
        self.assertIn('minlength="10" maxlength="40"', launcher)
        self.assertNotIn('id="scenario-key" type="text" value="quiet-river-signal" pattern=', launcher)
        self.assertIn("scenario_key:scenarioKey.value", launcher)
        self.assertNotIn('id="session-card"', launcher)
        self.assertNotIn('id="evidence-progress"', launcher)
        self.assertNotIn("Incident evidence is ready", launcher)
        self.assertIn('id="launch-status" role="status" aria-live="polite" hidden', launcher)
        self.assertIn("investigationTab = openPrepTab()", launcher)
        self.assertIn("return window.open('/preparing', '_blank')", launcher)
        self.assertIn("signalTab({__url: investigationUrl, __done: true})", launcher)
        self.assertIn("if (!investigationTab) setLaunchStatus", launcher)
        self.assertIn("revealManualOpen('Investigation ready.')", launcher)
        preparing = (ROOT / "telemetry/preparing.html").read_text(encoding="utf-8")
        telemetry_service = (ROOT / "telemetry/service.py").read_text(encoding="utf-8")
        telemetry_image = (ROOT / "telemetry/Dockerfile").read_text(encoding="utf-8")
        self.assertIn("<title>Preparing investigation…</title>", preparing)
        self.assertIn("location.replace(window.__url)", preparing)
        self.assertIn('self.path == "/preparing"', telemetry_service)
        self.assertIn("preparing.html", telemetry_image)

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
        self.assertNotIn("host.hidden = session.mode === 'demonstration'", content_script)
        self.assertIn('<aside class="panel" aria-label="Incident coach" hidden>', (ROOT / "kibana-coach/src/ui/coach-panel.js").read_text(encoding="utf-8"))
        self.assertNotIn("incident-coach-pair", content_script)
        self.assertNotIn("/claim", session_client)
        self.assertNotIn("pairing_code", learning_service)
        self.assertIn('"connection_token"', learning_service)
        self.assertIn("kibana-gateway:", compose)
        self.assertIn("location /incident-coach/learning/", gateway)
        self.assertIn("sub_filter '</head>'", gateway)
        self.assertIn("there is nothing to install in your browser", launcher)
        self.assertIn("if (coachRuntimeReady)", launcher)
        self.assertIn("launchWhenReady()", launcher)
        self.assertIn("investigationTab = openPrepTab()", launcher)
        self.assertIn("${target.origin}/incident-coach/learning", launcher)
        self.assertIn("target.hash = `${route}?${parameters}`", launcher)
        self.assertIn("const hashParameters = new URLSearchParams", bootstrap)
        self.assertIn("access_log off", gateway)


if __name__ == "__main__":
    unittest.main()
