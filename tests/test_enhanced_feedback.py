"""Guided enhanced feedback: dead ends, drift, the step clock budget, check-ins and their record."""

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "learning-service"))

spec = importlib.util.spec_from_file_location("enhanced_feedback_server", ROOT / "learning-service/server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
from engine import evaluator  # noqa: E402
from engine.contracts import expand_descriptor, validate_catalog  # noqa: E402

STATUS = "http.response.status_code"


def goals():
    return [
        {"id": "scope", "title": "Set the time window", "requires": [],
         "accepts": [{"action": "time_range_changed", "validators": [{"kind": "time_range_contains", "any_valid": True}]}],
         "reference_action": {"command": "set_time_range", "arguments": {"from": "now-15m", "to": "now"}}},
        {"id": "isolate", "title": "Filter to the failing status code", "requires": ["scope"],
         "accepts": [{"action": ["filter_added"], "validators": [{"kind": "filter_contains", "field": STATUS, "value": 503}]}],
         "drifts": [
             {"action": ["filter_added"], "validators": [{"kind": "filter_field", "field": STATUS}, {"kind": "value_not", "value": 503},
                                                         {"kind": "detail_equals", "field": "negate", "value": False}],
              "note": "You filtered on a status code, but not the one that stood out in the top values."},
             {"action": ["field_statistics_opened"], "validators": [{"kind": "detail_not", "field": "field", "value": STATUS}],
              "note": "You opened ${action.field}; this step is about the status codes."},
         ],
         "reference_action": {"command": "add_filter", "arguments": {"field": STATUS, "operator": "is", "value": 503}}},
        {"id": "inspect", "title": "Check one event", "requires": ["isolate"],
         "accepts": [{"action": "document_expanded", "validators": []}],
         "pace": {"expected_seconds": 30},
         "reference_action": {"command": "expand_document"}},
        {"id": "submit", "title": "Submit", "requires": ["inspect"],
         "accepts": [{"action": "answer_submitted", "validators": [{"kind": "answer_submitted"}]}],
         "reference_action": {"command": "request_answer"}},
    ]


def session(mode="guided", completed=()):
    manifest = json.loads((ROOT / "learning/fixtures/slow-payments-run.json").read_text())
    manifest["scenario"]["starting_view"] = {"app": "discover", "path": "/app/discover#/view/x?_g=(time:(from:now-1h,to:now))"}
    return {
        "id": "feedback-test-session", "run_id": manifest["run_id"], "manifest": manifest, "mode": mode,
        "policy": {"show_narration": True}, "playbook": {"id": "feedback-test", "schema_version": 2, "goals": goals()},
        "rubric": {}, "controller_token": "t", "run_ready": True, "paused": False,
        "completed_goals": set(completed), "actions": [], "last_action_sequence": 0, "last_command_sequence": 0,
        "assistance": {"hints": 0, "demonstrated_steps": 0}, "hint_level": {}, "answer": None, "feedback": None,
        "pending_command": None, "drift": {}, "step_log": {},
    }


def action(session_, type_, details=None, state_after=None, actor="learner", **extra):
    sequence = len(session_["actions"]) + 1
    return {"protocol_version": 2, "run_id": session_["run_id"], "session_id": session_["id"], "sequence": sequence,
            "type": type_, "actor": actor, "details": details or {}, "state_after": state_after or {}, **extra}


def record(session_, type_, details=None, state_after=None, **extra):
    with patch.object(server, "action_evidence", return_value={"assertions": {}}), patch.object(server, "transition_run"):
        return server.record_action(session_, action(session_, type_, details, state_after, **extra))


class DeadEndTests(unittest.TestCase):
    def test_empty_result_is_a_dead_end(self):
        s = session(completed={"scope"})
        result = record(s, "query_submitted", {"query": f"{STATUS} is 503"}, {"result_count": 0})
        self.assertEqual((result["outcome"], result["reason_code"], result["step_id"]), ("dead_end", "empty_result", "isolate"))
        self.assertEqual([entry["reason_code"] for entry in s["step_log"]["isolate"]["dead_ends"]], ["empty_result"])

    def test_removing_an_earned_filter_is_a_dead_end(self):
        s = session(completed={"scope", "isolate"})
        earned = server.restore_state(s)
        removed = {"type": "filter_removed", "actor": "learner", "details": {}, "state_after": {"filters": [], "query": ""}}
        result = evaluator.evaluate_action(s, removed, {}, earned_state=earned)
        self.assertEqual(result["reason_code"], "lost_earned_state")
        self.assertEqual(result["lost"], [{"field": STATUS, "value": 503, "negate": False}])
        self.assertEqual(result["step_id"], "inspect")

    def test_an_earned_filter_held_by_pill_or_query_is_not_lost(self):
        s = session(completed={"scope", "isolate"})
        earned = server.restore_state(s)
        held = [
            {"filters": [{"field": f"{STATUS}.keyword", "value": "503", "negate": False}, {"field": "url.path", "value": "/x", "negate": False}]},
            {"filters": [], "query": f"{STATUS}: 503"},
        ]
        for state_after in held:
            result = evaluator.evaluate_action(s, {"type": "filter_added", "actor": "learner", "state_after": state_after}, {}, earned_state=earned)
            self.assertNotEqual(result["outcome"], "dead_end", state_after)
        # A disabled pill no longer holds it; a report without pills says nothing about them.
        disabled = {"filters": [{"field": STATUS, "value": "503", "negate": False, "disabled": True}]}
        self.assertEqual(evaluator.evaluate_action(s, {"type": "filter_disabled", "actor": "learner", "state_after": disabled}, {}, earned_state=earned)["outcome"], "dead_end")
        self.assertEqual(evaluator.evaluate_action(s, {"type": "column_added", "actor": "learner", "details": {"field": "x"}}, {}, earned_state=earned)["outcome"], "observed")
        # The coach's own performed actions are trusted.
        self.assertNotEqual(evaluator.evaluate_action(s, {"type": "filter_removed", "actor": "tutorial", "state_after": {"filters": []}}, {}, earned_state=earned)["outcome"], "dead_end")

    def test_a_window_that_misses_the_incident_is_a_dead_end_on_the_scope_step_and_after_it(self):
        narrow = {"from": "now-5m", "to": "now", "from_minutes": 5, "incident_offset_minutes": 12}
        before = session()
        result = evaluator.evaluate_action(before, {"type": "time_range_changed", "actor": "learner", "details": narrow}, {}, server.restore_state(before))
        self.assertEqual((result["outcome"], result["reason_code"], result["step_id"]), ("dead_end", "window_misses_incident", "scope"))
        # The coach's own windows are trusted.
        self.assertEqual(evaluator.evaluate_action(before, {"type": "time_range_changed", "actor": "tutorial", "details": narrow}, {}, server.restore_state(before))["outcome"], "observed")
        after = session(completed={"scope"})
        result = evaluator.evaluate_action(after, {"type": "time_range_changed", "actor": "learner", "details": narrow}, {}, server.restore_state(after))
        self.assertEqual((result["outcome"], result["reason_code"]), ("dead_end", "window_excludes_incident"))
        wide = {**narrow, "from": "now-30m", "from_minutes": 30}
        self.assertEqual(evaluator.evaluate_action(after, {"type": "time_range_changed", "details": wide}, {}, server.restore_state(after))["outcome"], "observed")

    def test_dead_ends_never_progress_a_goal(self):
        s = session(completed={"scope"})
        result = record(s, "filter_added", {"field": STATUS, "value": "503", "negate": False}, {"filters": [{"field": STATUS, "value": "503", "negate": False}], "result_count": 0})
        self.assertEqual(result["outcome"], "dead_end")
        self.assertNotIn("isolate", s["completed_goals"])


def timed_session(mode="guided", completed=(), timing=None, created_minutes_ago=2, noticed=10):
    """A session whose incident is in real time: created a couple of minutes ago, noticed ``noticed``
    minutes before that, read by a learner in Kolkata (UTC+5:30)."""
    from datetime import datetime, timedelta, timezone
    s = session(mode, completed)
    s["manifest"]["created_at"] = (datetime.now(timezone.utc) - timedelta(minutes=created_minutes_ago)).isoformat()
    s["manifest"].setdefault("parameters", {})["timing"] = timing or {}
    s["detected_offset_minutes"] = noticed
    s["utc_offset_minutes"] = -330
    # The learner began straight after the run was created: the report was then `noticed` minutes old.
    s["briefing_read_at"] = s["manifest"]["created_at"]
    return s


def moments(s):
    return evaluator.incident_moments(s["manifest"], s.get("detected_offset_minutes"))


def move_incident_back(s, minutes):
    """As if ``minutes`` had passed: the incident (and the run) moves that much further into the past."""
    from datetime import datetime, timedelta
    s["manifest"]["created_at"] = (datetime.fromisoformat(s["manifest"]["created_at"]) - timedelta(minutes=minutes)).isoformat()


class WindowFeedbackTests(unittest.TestCase):
    def test_relative_windows_are_named_as_the_picker_names_them(self):
        names = {"now-15m": "the last 15 minutes", "now-1h": "the last hour", "now-24h": "the last 24 hours",
                 "now-7d": "the last 7 days", "now/d": None, "2026-11-07T14:00:00.000Z": None}
        for time_from, name in names.items():
            self.assertEqual(server.relative_window_name(time_from), name, time_from)

    def test_a_relative_window_from_a_stale_briefing_is_explained_at_once_in_clock_time(self):
        s = timed_session()
        noticed = moments(s)["noticed"]
        result = record(s, "time_range_changed", {"from": "now-10m", "to": "now"}, actor="learner")
        self.assertEqual((result["outcome"], result["reason_code"], result["step_id"]), ("dead_end", "window_misses_incident", "scope"))
        start = server.clock_text(evaluator.parse_instant(result["window_start_at"]), s)
        clock = server.clock_text(noticed, s)
        self.assertEqual(clock, (noticed + __import__("datetime").timedelta(minutes=330)).strftime("%H:%M"))
        self.assertEqual(result["headline"], f"Your window, the last 10 minutes, starts at {start}, after the report at {clock}.")
        self.assertEqual(result["detail"], f"The report came in 12 minutes ago: time kept moving while you read. "
                                           f"Choose a longer window, or type a start before {clock} so it stays put.")
        self.assertNotIn("restore_time", result)  # on the scope step the learner chooses again
        self.assertIn("time kept moving while you read", s["step_log"]["scope"]["dead_ends"][0]["note"])
        # Choosing a longer relative window completes the step.
        self.assertEqual(record(s, "time_range_changed", {"from": "now-30m", "to": "now"}, actor="learner")["goals_progressed"], ["scope"])

    def test_time_moving_on_is_only_blamed_when_the_window_reached_the_moment_at_the_start(self):
        # The report was 10 minutes old when the briefing was read; the last 5 minutes never reached it.
        s = timed_session()
        result = record(s, "time_range_changed", {"from": "now-5m", "to": "now"}, actor="learner")
        clock = server.clock_text(moments(s)["noticed"], s)
        self.assertEqual(result["detail"], f"The report came in 12 minutes ago. Choose a longer window, or type a start before {clock} so it stays put.")
        self.assertNotIn("time kept moving", result["note"])

    def test_a_fixed_start_that_misses_says_where_to_start(self):
        s = timed_session()
        late = server.iso_instant(moments(s)["noticed"] + __import__("datetime").timedelta(minutes=3))
        result = record(s, "time_range_changed", {"from": late, "to": "now"}, actor="learner")
        clock = server.clock_text(moments(s)["noticed"], s)
        self.assertTrue(result["headline"].startswith("Your window starts at "))
        self.assertEqual(result["detail"], f"Start it before {clock}.")

    def test_a_challenge_explains_the_miss_only_in_its_debrief(self):
        s = timed_session(mode="challenge")
        s["policy"] = {"validate_timing": "debrief"}
        result = record(s, "time_range_changed", {"from": "now-10m", "to": "now"}, actor="learner")
        self.assertEqual(server.learner_evaluation(s, result), {"outcome": "recorded", "goals_progressed": [], "meaningful": False})
        [detour] = evaluator.step_detours(s)
        self.assertEqual((detour["id"], detour["dead_ends"]), ("scope", ["window missed the incident"]))
        self.assertTrue(detour["notes"][0].startswith("Your window, the last 10 minutes, started at "))
        self.assertIn("12 minutes earlier by then", detour["notes"][0])

    def test_the_rise_is_not_dated_on_the_scope_card_but_is_in_the_debrief(self):
        s = timed_session(timing={"noticed": 8, "onset": 11, "end": 5})
        result = record(s, "time_range_changed", {"from": "now-10m", "to": "now"}, actor="learner")
        self.assertEqual(result["reason_code"], "window_misses_incident")
        self.assertTrue(result["headline"].endswith("after the rise in failures."), result["headline"])
        self.assertEqual(result["detail"], "Find where the histogram rises, and start the window before it.")
        self.assertIn(f"after the rise in failures at {server.clock_text(moments(s)['onset'], s)}", result["note"])

    def test_a_relative_window_that_slides_past_the_incident_is_a_dead_end_once(self):
        s = timed_session(completed={"scope"})
        self.assertEqual(record(s, "time_range_changed", {"from": "now-15m", "to": "now"}, actor="learner")["outcome"], "observed")
        self.assertEqual(record(s, "column_added", {"field": "x"}, actor="learner")["outcome"], "observed")
        move_incident_back(s, 10)
        result = record(s, "column_added", {"field": "y"}, actor="learner")
        self.assertEqual((result["outcome"], result["reason_code"], result["step_id"]), ("dead_end", "window_slid_past_incident", "isolate"))
        fixed = server.recommended_window_start(moments(s))
        clock = server.clock_text(moments(s)["noticed"], s)
        self.assertTrue(result["headline"].startswith("Your window, the last 15 minutes, now starts at "), result["headline"])
        self.assertTrue(result["headline"].endswith(f"after the report at {clock}."))
        self.assertIn(f"I'll set a fixed start of {server.clock_text(fixed, s)} so it stays put.", result["detail"])
        self.assertEqual(result["restore_time"], {"from": server.iso_instant(fixed), "to": "now"})
        self.assertEqual(evaluator.dead_end_labels(s["step_log"]["isolate"]), ["window slid past the incident"])
        # Once per window: the next action isn't flagged again; a new window starts afresh.
        self.assertEqual(record(s, "column_added", {"field": "z"}, actor="learner")["outcome"], "observed")
        record(s, "time_range_changed", {"from": "now-20m", "to": "now"}, actor="learner")
        move_incident_back(s, 10)
        self.assertEqual(record(s, "column_added", {"field": "w"}, actor="learner")["reason_code"], "window_slid_past_incident")

    def test_a_slide_does_not_matter_for_a_fixed_start_or_once_the_investigation_is_done(self):
        fixed = timed_session(completed={"scope"})
        record(fixed, "time_range_changed", {"from": server.iso_instant(moments(fixed)["noticed"] - __import__("datetime").timedelta(minutes=2)), "to": "now"}, actor="learner")
        move_incident_back(fixed, 30)
        self.assertEqual(record(fixed, "column_added", {"field": "x"}, actor="learner")["outcome"], "observed")
        done = timed_session(completed={"scope", "isolate", "inspect"})
        record(done, "time_range_changed", {"from": "now-15m", "to": "now"}, actor="learner")
        move_incident_back(done, 10)
        self.assertEqual(record(done, "column_added", {"field": "x"}, actor="learner")["outcome"], "observed")

    def test_the_coach_is_told_when_a_relative_window_will_slide(self):
        from datetime import timedelta
        s = timed_session(completed={"scope"})
        changed = action(s, "time_range_changed", {"from": "now-15m", "to": "now"})
        with patch.object(server, "action_evidence", return_value={"assertions": {}}):
            server.record_action(s, changed)
        watch = server.window_watch(s, changed)
        noticed = moments(s)["noticed"]
        self.assertEqual(watch["from"], "now-15m")
        self.assertAlmostEqual((evaluator.parse_instant(watch["slides_at"]) - (noticed + timedelta(minutes=16))).total_seconds(), 0, delta=1)
        # Nothing to watch for a fixed start, or in a challenge.
        self.assertIsNone(server.window_watch(s, {"type": "time_range_changed", "details": {"from": "2026-11-07T14:00:00.000Z", "to": "now"}}))
        self.assertIsNone(server.window_watch({**s, "mode": "challenge"}, changed))
        # When the watch goes off, the service confirms the slide, records it, and only once.
        self.assertIsNone(server.window_check_reply(s))
        move_incident_back(s, 10)
        reply = server.window_check_reply(s)
        self.assertEqual((reply["message_type"], reply["evaluation"]["reason_code"]), ("window_slid", "window_slid_past_incident"))
        self.assertIn("restore_time", reply["evaluation"])
        self.assertEqual(s["step_log"]["isolate"]["dead_ends"][0]["reason_code"], "window_slid_past_incident")
        self.assertIsNone(server.window_check_reply(s))

    def test_a_later_window_that_misses_puts_back_a_fixed_start(self):
        s = timed_session(completed={"scope"})
        result = record(s, "time_range_changed", {"from": "now-5m", "to": "now"}, actor="learner")
        fixed = server.recommended_window_start(moments(s))
        self.assertEqual(result["reason_code"], "window_excludes_incident")
        self.assertEqual(result["restore_time"]["from"], server.iso_instant(fixed))
        self.assertTrue(result["detail"].startswith(f"I'll set the window to start at {server.clock_text(fixed, s)}, before it."))


class DriftTests(unittest.TestCase):
    def test_drift_validators(self):
        s = session()
        other = {"type": "filter_added", "details": {"field": STATUS, "value": "500", "negate": False}}
        self.assertTrue(evaluator.validate_filter_field(s, other, {}, {"field": f"{STATUS}.keyword"}))
        self.assertFalse(evaluator.validate_filter_field(s, other, {}, {"field": "url.path"}))
        self.assertTrue(evaluator.validate_value_not(s, other, {}, {"value": 503}))
        self.assertFalse(evaluator.validate_value_not(s, other, {}, {"value": 500}))
        self.assertFalse(evaluator.validate_value_not(s, {"type": "filter_added", "details": {}}, {}, {"value": 503}))
        opened = {"type": "field_statistics_opened", "details": {"field": "service.name"}}
        self.assertTrue(evaluator.validate_detail_not(s, opened, {}, {"field": "field", "value": STATUS}))
        self.assertFalse(evaluator.validate_detail_not(s, opened, {}, {"field": "field", "value": "service.name"}))
        # An unreported detail is not drift.
        self.assertFalse(evaluator.validate_detail_not(s, {"details": {}}, {}, {"field": "field", "value": STATUS}))

    def test_drift_is_logged_silently_deduplicated_and_cleared_on_completion(self):
        s = session(completed={"scope"})
        wrong = {"field": STATUS, "value": "500", "negate": False}
        result = record(s, "filter_added", wrong, {"filters": [wrong]})
        self.assertEqual(result["outcome"], "drift")
        self.assertFalse(result["goals_progressed"])
        record(s, "field_statistics_opened", {"field": "service.name"})
        record(s, "filter_added", wrong, {"filters": [wrong]})
        self.assertEqual(s["drift"]["isolate"], [
            "You opened service.name; this step is about the status codes.",
            "You filtered on a status code, but not the one that stood out in the top values.",
        ])
        # Filtering out a code, or opening the step's own field, is exploration, not drift.
        self.assertEqual(record(s, "filter_added", {**wrong, "negate": True}, {"filters": [wrong]})["outcome"], "observed")
        self.assertEqual(record(s, "field_statistics_opened", {"field": STATUS})["outcome"], "observed")
        right = {"field": STATUS, "value": "503", "negate": False}
        self.assertEqual(record(s, "filter_added", right, {"filters": [right]})["outcome"], "accepted")
        self.assertNotIn("isolate", s["drift"])
        self.assertEqual(len(s["step_log"]["isolate"]["drift"]), 2)

    def test_demonstrations_record_no_drift(self):
        s = session(mode="demonstration", completed={"scope"})
        wrong = {"field": STATUS, "value": "500", "negate": False}
        self.assertEqual(record(s, "filter_added", wrong, {"filters": [wrong]})["outcome"], "observed")

    def test_discover_time_window_drifts_expand_with_valid_validators(self):
        descriptor = json.loads((ROOT / "learning/scenarios/discover-time-window/playbook.json").read_text())
        playbook = server.resolve_parameters(expand_descriptor(ROOT / "learning", "playbook", descriptor),
                                             {"incident": {"status": 503, "route": "/api/payments/authorize"}, "window": {"value": "15m"}})
        by_id = {goal["id"]: goal for goal in playbook["goals"]}
        for step in ("scope", "survey", "isolate", "endpoints"):
            self.assertTrue(by_id[step].get("drifts"), step)
        s = session(completed={"scope", "survey"})
        s["playbook"] = playbook
        wrong = {"type": "filter_added", "details": {"field": STATUS, "value": "500", "negate": False}}
        self.assertEqual(evaluator.drift_note(s, wrong), ("isolate", "You filtered on a status code, but not the one that stood out in the top values."))
        opened = {"type": "field_statistics_opened", "details": {"field": "url.path"}}
        self.assertEqual(evaluator.drift_note(s, opened)[1], "You opened url.path; this step is about the status codes.")


class ClockAndCheckInTests(unittest.TestCase):
    def test_guided_commands_carry_a_flat_budget_never_below_45_seconds(self):
        self.assertEqual(server.pace_seconds({"reference_action": {"command": "set_time_range"}}), 45)
        self.assertEqual(server.pace_seconds({"reference_action": {"command": "add_filter"}}), 60)
        self.assertEqual(server.pace_seconds({"reference_action": {"command": "enter_kql"}}), 60)
        self.assertEqual(server.pace_seconds({"reference_action": {"command": "something_else"}}), 45)
        self.assertEqual(server.pace_seconds({"reference_action": {"command": "add_filter"}, "pace": {"expected_seconds": 90}}), 90)
        self.assertEqual(server.pace_seconds({"reference_action": {"command": "expand_document"}, "pace": {"expected_seconds": 30}}), 45)
        s = session(completed={"scope"})
        self.assertEqual(server.next_command(s)["pace_seconds"], 60)
        s = session(mode="challenge")
        self.assertNotIn("pace_seconds", server.next_command(s))

    def test_contracts_reject_a_pace_under_45_seconds(self):
        with tempfile.TemporaryDirectory() as folder:
            learning = Path(folder) / "learning"
            shutil.copytree(ROOT / "learning", learning)
            path = learning / "scenarios/discover-time-window/playbook.json"
            descriptor = json.loads(path.read_text())
            descriptor["goal_overrides"]["isolate"]["pace"] = {"expected_seconds": 30}
            descriptor["goal_overrides"]["isolate"]["drifts"].append({"action": "filter_added", "validators": [{"kind": "no_such_validator"}], "note": "x"})
            path.write_text(json.dumps(descriptor))
            errors = validate_catalog(learning)
        self.assertIn("discover-time-window/isolate: pace.expected_seconds must be an integer of at least 45", errors)
        self.assertIn("discover-time-window/isolate: unknown drift validator no_such_validator", errors)

    def test_check_in_reply_names_the_step_and_its_drift(self):
        s = session(completed={"scope"})
        self.assertEqual(server.check_in_reply(s, "isolate"),
                         {"message_type": "check_in", "step_id": "isolate", "step_title": "Filter to the failing status code", "drift": []})
        server.record_drift(s, "isolate", "You filtered on a status code, but not the one that stood out in the top values.")
        self.assertEqual(server.check_in_reply(s, "isolate")["drift"], ["You filtered on a status code, but not the one that stood out in the top values."])
        # A check-in for a step the learner already left is not answered.
        self.assertIsNone(server.check_in_reply(s, "scope"))
        self.assertIsNone(server.check_in_reply(session(mode="challenge"), "scope"))
        self.assertEqual(len(s["step_log"]["isolate"]["check_ins"]), 2)

    def test_answering_a_check_in_costs_nothing(self):
        helped = session(completed={"scope"})
        server.check_in_reply(helped, "isolate")
        record(helped, "check_in_answered", {"step_id": "isolate", "choice": "keep_going"})
        self.assertEqual(helped["step_log"]["isolate"]["check_ins"][-1]["choice"], "keep_going")
        plain = session(completed={"scope"})
        for s in (helped, plain):
            right = {"field": STATUS, "value": "503", "negate": False}
            record(s, "filter_added", right, {"filters": [right]})
            record(s, "document_expanded")
        self.assertEqual(helped["feedback"]["total"], plain["feedback"]["total"])
        self.assertEqual(helped["feedback"]["assistance"], plain["feedback"]["assistance"])
        challenge = session(mode="challenge")
        challenge["actions"] = [{"action": {"type": "check_in_answered"}, "evaluation": {"meaningful": False}},
                                {"action": {"type": "time_range_changed"}, "evaluation": {"meaningful": True}}]
        challenge["answer"] = {}
        self.assertEqual(evaluator.score_session(challenge)["components"]["relevance"], 10)


class RecordingTests(unittest.TestCase):
    def test_guided_debrief_rows_gain_an_unscored_detail_line(self):
        s = session(completed={"scope"})
        record(s, "query_submitted", {"query": f"{STATUS} is 503"}, {"result_count": 0}, step_clock={"step_id": "isolate", "seconds_active": 40})
        server.record_recovery(s, {"step_id": "isolate", "reason_code": "empty_result", "diagnosis": "missing_colon"})
        server.check_in_reply(s, "isolate")
        right = {"field": STATUS, "value": "503", "negate": False}
        record(s, "filter_added", right, {"filters": [right]}, step_clock={"step_id": "isolate", "seconds_active": 65.4})
        record(s, "document_expanded", step_clock={"step_id": "inspect", "seconds_active": 12})
        steps = {step["id"]: step for step in s["feedback"]["steps"]}
        self.assertEqual(steps["isolate"]["detail"], "1m 05s · needed a check-in · recovered from a dead end: missing colon")
        self.assertEqual(steps["isolate"]["seconds_active"], 65.4)
        self.assertEqual(steps["inspect"]["detail"], "12s")
        self.assertNotIn("detail", steps["scope"])
        self.assertEqual(s["feedback"]["total"], 100)

    def test_a_recovery_the_browser_found_alone_is_recorded(self):
        s = session(completed={"scope"})
        server.record_recovery(s, {"step_id": "isolate", "reason_code": "empty_result"})
        self.assertEqual(len(s["step_log"]["isolate"]["dead_ends"]), 1)
        self.assertEqual(evaluator.step_detail(s["step_log"]["isolate"]), "recovered from a dead end: search with no results")

    def test_challenge_debrief_lists_detours(self):
        s = session(mode="challenge", completed={"scope"})
        wrong = {"field": STATUS, "value": "500", "negate": False}
        record(s, "filter_added", wrong, {"filters": [wrong]})
        record(s, "query_submitted", {"query": "x"}, {"result_count": 0})
        s["answer"] = {}
        feedback = evaluator.score_session(s)
        self.assertEqual(feedback["step_detours"], [{"id": "isolate", "title": "Filter to the failing status code",
                                                     "dead_ends": ["search with no results"], "notes": [],
                                                     "drift": ["You filtered on a status code, but not the one that stood out in the top values."]}])


if __name__ == "__main__":
    unittest.main()
