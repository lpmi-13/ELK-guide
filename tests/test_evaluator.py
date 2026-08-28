import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("evaluator", ROOT / "learning-service/engine/evaluator.py")
evaluator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluator)


def new_session():
    manifest = json.loads((ROOT / "learning/fixtures/slow-payments-run.json").read_text())
    rubric = json.loads((ROOT / "learning/rubrics/slow-service-beginner.json").read_text())
    return {"manifest": manifest, "rubric": rubric, "completed_goals": set(), "actions": [], "assistance": {"hints": 0, "demonstrated_steps": 0}, "answer": None}


class EvaluatorTests(unittest.TestCase):
    def test_duration_and_service_query_can_progress_equivalent_goals(self):
        session = new_session()
        action = {"type": "query_submitted", "details": {"query": 'scenario.id: "run-7c9812" and event.duration >= 2000000000 and service.name: "payments"'}, "state_after": {}}
        result = evaluator.evaluate_action(session, action, {"slow_events": True, "service_events": True})
        self.assertEqual(set(result["goals_progressed"]), {"identify_slow_transactions", "compare_services"})

    def test_invalid_trace_does_not_progress(self):
        session = new_session()
        action = {"type": "trace_opened", "details": {"trace_id": "wrong"}}
        result = evaluator.evaluate_action(session, action, {"trace_services": 1})
        self.assertEqual(result["outcome"], "observed")
        self.assertFalse(result["goals_progressed"])

    def test_scores_correctness_and_process_separately(self):
        session = new_session()
        session["completed_goals"] = {goal["id"] for goal in session["rubric"]["goals"]}
        session["answer"] = {"service": "payments", "fault_type": "latency", "affected_route": "/checkout", "trace_id": "abc", "evidence": "Payment was the dominant local transaction."}
        for action_type in ("time_range_changed", "query_submitted", "filter_added", "trace_opened", "diagnosis_submitted"):
            session["actions"].append({"action": {"type": action_type}, "evaluation": {"meaningful": True}})
        feedback = evaluator.score_session(session, trace_is_valid=True)
        self.assertTrue(feedback["diagnosis_correct"])
        self.assertEqual(feedback["components"]["diagnosis_correctness"], 40)
        self.assertEqual(feedback["components"]["goal_coverage"], 20)
        self.assertEqual(feedback["total"], 100)

    def test_correct_answer_without_trace_cannot_receive_full_marks(self):
        session = new_session()
        session["answer"] = {"service": "payments", "fault_type": "latency", "affected_route": "/checkout", "evidence": "It was slow."}
        feedback = evaluator.score_session(session, trace_is_valid=False)
        self.assertTrue(feedback["diagnosis_correct"])
        self.assertLess(feedback["total"], 100)
        self.assertLess(feedback["components"]["evidence_quality"], 20)


if __name__ == "__main__":
    unittest.main()
