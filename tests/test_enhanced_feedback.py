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

    def test_a_window_that_misses_the_incident_is_a_dead_end_only_after_scoping(self):
        narrow = {"from": "now-5m", "to": "now", "from_minutes": 5, "incident_offset_minutes": 12}
        before = session()
        self.assertEqual(evaluator.evaluate_action(before, {"type": "time_range_changed", "details": narrow}, {}, server.restore_state(before))["outcome"], "observed")
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
                                                     "dead_ends": ["search with no results"],
                                                     "drift": ["You filtered on a status code, but not the one that stood out in the top values."]}])


if __name__ == "__main__":
    unittest.main()
