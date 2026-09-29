import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "learning-service"))

spec = importlib.util.spec_from_file_location("guided_learning_server", ROOT / "learning-service/server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
from engine.contracts import expand_descriptor


def guided_session():
    manifest = json.loads((ROOT / "learning/fixtures/slow-payments-run.json").read_text())
    goals = [
        {"id": "scope", "requires": [], "accepts": [], "reference_action": {"command": "set_time_range"}},
        {"id": "inspect", "requires": ["scope"], "accepts": [{"action": "document_expanded", "validators": []}], "reference_action": {"command": "expand_document"}},
        {"id": "submit", "requires": ["inspect"], "accepts": [{"action": "answer_submitted", "validators": [{"kind": "answer_submitted"}]}], "reference_action": {"command": "request_answer"}},
    ]
    return {
        "id": "guided-test-session", "run_id": manifest["run_id"], "manifest": manifest,
        "mode": "guided", "playbook": {"id": "guided-test", "schema_version": 2, "goals": goals},
        "rubric": {}, "controller_token": "test-token", "run_ready": True,
        "completed_goals": {"scope", "inspect"}, "actions": [], "last_action_sequence": 0,
        "assistance": {"hints": 3, "demonstrated_steps": 2},
        "hint_level": {"scope": 2, "inspect": 1}, "answer": None, "feedback": None,
        "pending_command": None,
    }


class FakeHandler:
    do_POST = server.Handler.do_POST

    def __init__(self):
        self.path = "/api/sessions/guided-test-session/answer"
        self.headers = {"Authorization": "Bearer test-token"}
        self.response = None

    def read_json(self):
        return {}

    def respond(self, status, payload):
        self.response = status, payload


class GuidedFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.session = guided_session()
        server.sessions[self.session["id"]] = self.session

    def tearDown(self):
        server.sessions.pop(self.session["id"], None)

    def test_feedback_lists_each_practice_step_with_the_help_it_took(self):
        self.session["hint_level"] = {"scope": 1}
        self.session["actions"] = [{"action": {"type": "step_demonstrated", "details": {"step_id": "inspect"}}}]
        steps = server.guided_feedback(self.session)["steps"]
        self.assertEqual([(step["id"], step["outcome"]) for step in steps], [("scope", "hinted"), ("inspect", "shown")])
        self.session["completed_goals"] = {"scope"}
        self.session["hint_level"] = {}
        self.session["actions"] = []
        steps = server.guided_feedback(self.session)["steps"]
        self.assertEqual([step["outcome"] for step in steps], ["independent", "incomplete"])

    def test_guided_commands_carry_the_search_state_earned_so_far(self):
        goals = self.session["playbook"]["goals"]
        goals[0]["reference_action"] = {"command": "set_time_range", "arguments": {"from": "now-10m", "to": "now"}}
        goals.insert(1, {"id": "isolate", "requires": ["scope"], "accepts": [], "reference_action": {"command": "add_filter", "arguments": {"field": "http.response.status_code", "operator": "is", "value": "503"}}})
        self.session["manifest"]["scenario"]["starting_view"] = {"path": "/app/discover#/view/x?_g=(time:(from:now-1h,to:now))"}
        self.session.update({"paused": False, "last_command_sequence": 0, "policy": {"show_narration": True}})
        self.session["completed_goals"] = {"scope"}
        state = server.next_command(self.session)["restore_state"]
        self.assertEqual(state, {"baseline_time": {"from": "now-1h", "to": "now"}, "time": {"from": "now-10m", "to": "now"}, "filters": [], "query": None})
        self.session["completed_goals"] = {"scope", "isolate"}
        self.session["pending_command"] = None
        state = server.next_command(self.session)["restore_state"]
        self.assertEqual(state["filters"], [{"field": "http.response.status_code", "value": "503", "negate": False}])

    def test_feedback_counts_requests_and_distinct_helped_steps(self):
        self.session["actions"] = [
            {"action": {"type": "step_demonstrated", "details": {"step_id": "inspect"}}},
            {"action": {"type": "step_demonstrated", "details": {"step_id": "inspect"}}},
        ]
        feedback = server.guided_feedback(self.session)
        self.assertTrue(feedback["scored"])
        self.assertEqual(feedback["total"], 25)
        self.assertEqual(feedback["completion"], 100)
        self.assertEqual(feedback["assistance"], {
            "hints": 3, "demonstrated_steps": 2, "hinted_steps": 2,
            "shown_steps": 1, "independent_steps": 0, "step_count": 2,
        })

    def test_feedback_counts_all_steps_as_independent_without_help(self):
        self.session["assistance"] = {"hints": 0, "demonstrated_steps": 0}
        self.session["hint_level"] = {}
        self.assertEqual(server.guided_feedback(self.session)["assistance"]["independent_steps"], 2)
        self.assertEqual(server.guided_feedback(self.session)["total"], 100)
        self.assertEqual(server.score_session(self.session), server.guided_feedback(self.session))

    def test_hint_only_earns_half_credit_and_show_me_overrides_hints(self):
        self.session["hint_level"] = {"scope": 1, "inspect": 2}
        self.assertEqual(server.guided_feedback(self.session)["total"], 50)
        self.session["actions"] = [
            {"action": {"type": "step_demonstrated", "details": {"step_id": "inspect"}}},
        ]
        self.assertEqual(server.guided_feedback(self.session)["total"], 25)

    def test_credit_scales_with_practice_step_count(self):
        for step_count, expected in ((3, 83.3), (4, 87.5), (5, 90)):
            with self.subTest(step_count=step_count):
                practice_ids = [f"phase-{index}" for index in range(step_count)]
                self.session["playbook"]["goals"] = [
                    {"id": step_id, "reference_action": {"command": "set_time_range"}}
                    for step_id in practice_ids
                ] + [{"id": "submit", "reference_action": {"command": "request_answer"}}]
                self.session["completed_goals"] = set(practice_ids)
                self.session["hint_level"] = {practice_ids[0]: 1}
                self.session["actions"] = []
                feedback = server.guided_feedback(self.session)
                self.assertEqual(feedback["total"], expected)
                self.assertEqual(feedback["completion"], 100)

    def test_every_catalog_playbook_has_a_terminal_answer_goal(self):
        catalog = json.loads((ROOT / "learning/catalog.json").read_text())
        for entry in catalog["scenarios"]:
            descriptor = json.loads((ROOT / "learning" / entry["pack"] / "playbook.json").read_text())
            goals = expand_descriptor(ROOT / "learning", "playbook", descriptor)["goals"]
            commands = [goal["reference_action"]["command"] for goal in goals]
            with self.subTest(scenario=entry["id"]):
                self.assertGreater(len(commands), 1)
                self.assertTrue(all(command not in {"request_answer", "request_diagnosis"} for command in commands[:-1]))
                self.assertIn(commands[-1], {"request_answer", "request_diagnosis"})
                session = {"playbook": {"schema_version": 2, "goals": goals}, "completed_goals": {goal["id"] for goal in goals[:-1]}}
                completion = server.evaluate_action(session, {"type": "answer_submitted", "details": {}}, {})
                self.assertIn(goals[-1]["id"], completion["goals_progressed"])

    def test_finish_requires_all_investigation_goals(self):
        self.session["completed_goals"].remove("inspect")
        handler = FakeHandler()
        handler.do_POST()
        self.assertEqual(handler.response[0], 409)
        self.assertIsNone(self.session["feedback"])
        self.assertNotIn("submit", self.session["completed_goals"])

    def test_last_investigation_action_completes_without_answer(self):
        self.session["completed_goals"].remove("inspect")
        action = {
            "protocol_version": 2, "run_id": self.session["run_id"],
            "session_id": self.session["id"], "sequence": 1,
            "type": "document_expanded", "actor": "learner", "details": {},
        }
        with patch.object(server, "action_evidence", return_value={}), patch.object(server, "emit"), patch.object(server, "transition_run") as transition:
            evaluation = server.record_action(self.session, action)
            self.assertEqual(evaluation["goals_progressed"], ["inspect"])
            self.assertEqual(self.session["completed_goals"], {"scope", "inspect", "submit"})
            self.assertIsNone(self.session["answer"])
            self.assertEqual([item["action"]["type"] for item in self.session["actions"]], ["document_expanded"])
            self.assertEqual(self.session["feedback"]["assistance"]["hints"], 3)
            self.assertEqual(self.session["last_action_sequence"], 1)
            transition.assert_called_once_with(self.session, "COMPLETED")

            handler = FakeHandler()
            handler.do_POST()
            self.assertEqual(handler.response[0], 200)
            self.assertEqual(self.session["last_action_sequence"], 1)
            transition.assert_called_once_with(self.session, "COMPLETED")

    def test_completed_run_is_ready_for_feedback_reconnect(self):
        self.session["feedback"] = {"scored": False}
        with patch.object(server, "http_json", return_value=(200, {"state": "COMPLETED"})):
            self.assertTrue(server.refresh_run_ready(self.session))


if __name__ == "__main__":
    unittest.main()
