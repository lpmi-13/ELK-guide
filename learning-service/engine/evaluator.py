"""Goal-graph evaluation and evidence-based scoring for incident sessions."""

import math


ACTION_TO_GOAL = {
    "time_range_changed": "scope_incident_window",
    "query_submitted": "identify_slow_transactions",
    "filter_added": "compare_services",
    "trace_opened": "inspect_representative_trace",
    "diagnosis_submitted": "submit_supported_diagnosis",
}


def action_text(action):
    details = action.get("details") or {}
    after = action.get("state_after") or {}
    return str(details.get("query") or details.get("value") or after.get("query") or "")


def evaluate_action(session, action, evidence=None):
    """Return goals progressed by a normalized action and a reviewable outcome."""
    evidence = evidence or {}
    action_type = action.get("type")
    expected = session["manifest"]["expected"]
    details = action.get("details") or {}
    after = action.get("state_after") or {}
    progressed = []
    reason = "Action did not satisfy an unsatisfied investigation goal."

    if action_type == "time_range_changed":
        time_from = str(details.get("from") or after.get("time_from") or "")
        if time_from.startswith("now-") or time_from:
            progressed = ["scope_incident_window"]
            reason = "The incident window was scoped."
    elif action_type == "query_submitted":
        query = action_text(action).lower().replace(" ", "")
        result_count = after.get("result_count", details.get("result_count", 0))
        if "event.duration" in query and any(operator in query for operator in (">=", ">")) and (evidence.get("slow_events") or result_count):
            progressed.append("identify_slow_transactions")
            reason = "The query retained indexed slow events from this run."
        if "service.name" in query and expected["service"].lower() in query and evidence.get("service_events"):
            progressed.append("compare_services")
            reason = "The query isolated the expected slow service."
    elif action_type in {"filter_added", "filter_changed"}:
        field = str(details.get("field", ""))
        value = str(details.get("value", ""))
        if field == "service.name" and value == expected["service"] and evidence.get("service_events"):
            progressed = ["compare_services"]
            reason = "The filter isolated the service with slow local operations."
    elif action_type in {"trace_opened", "document_expanded"}:
        trace_id = str(details.get("trace_id") or after.get("trace_id") or "")
        if trace_id and evidence.get("trace_services", 0) >= 3:
            progressed = ["inspect_representative_trace"]
            reason = "The selected trace contains the incident path across at least three services."
    elif action_type == "diagnosis_submitted":
        progressed = ["submit_supported_diagnosis"]
        reason = "A structured diagnosis was submitted."

    new_goals = [goal for goal in progressed if goal not in session["completed_goals"]]
    session["completed_goals"].update(new_goals)
    meaningful = bool(progressed)
    return {"outcome": "accepted" if meaningful else "observed", "goals_progressed": new_goals, "meaningful": meaningful, "reason": reason}


def score_session(session, trace_is_valid=False):
    manifest = session["manifest"]
    expected = manifest["expected"]
    answer = session.get("answer") or {}
    rubric = session["rubric"]

    diagnosis = 0
    supported = []
    if str(answer.get("service", "")).lower() == expected["service"].lower():
        diagnosis += 20
        supported.append("faulty service")
    if str(answer.get("fault_type", "")).lower() == expected["fault_type"].lower():
        diagnosis += 10
        supported.append("failure type")
    if str(answer.get("affected_route", "")) == expected["route"]:
        diagnosis += 10
        supported.append("affected route")

    cited_trace = str(answer.get("trace_id", ""))
    explanation = str(answer.get("evidence", "")).strip()
    evidence_score = (12 if cited_trace and trace_is_valid else 0) + (8 if explanation else 0)
    goals = {goal["id"] for goal in rubric["goals"]}
    coverage = round(20 * len(session["completed_goals"] & goals) / len(goals), 1)
    semantic = [item for item in session["actions"] if item["action"].get("type") not in {"hint_requested", "command_acknowledged"}]
    meaningful = sum(1 for item in semantic if item["evaluation"]["meaningful"])
    relevance = round(10 * meaningful / max(1, len(semantic)), 1)
    costs = rubric.get("action_costs", {})
    actual_cost = sum(float(costs.get(item["action"].get("type"), 1)) for item in semantic)
    efficiency = round(10 * min(1, rubric["reference_action_cost"] / max(1, actual_cost)), 1)
    assistance = session["assistance"]
    total = round(diagnosis + evidence_score + coverage + relevance + efficiency, 1)

    correct = diagnosis == 40
    route = [item["action"].get("type") for item in semantic if item["evaluation"]["meaningful"]]
    detours = [item["action"].get("type") for item in semantic if not item["evaluation"]["meaningful"]]
    if correct:
        summary = f"You identified {expected['service']} latency on {expected['route']}."
    else:
        summary = f"The evidence identifies {expected['service']} latency on {expected['route']}."
    if trace_is_valid:
        summary += f" Trace {cited_trace} connects the slow dependency to its upstream callers."
    else:
        summary += " A full-strength conclusion also needs a trace from the current run."

    return {
        "total": total,
        "components": {
            "diagnosis_correctness": diagnosis,
            "evidence_quality": evidence_score,
            "goal_coverage": coverage,
            "investigation_relevance": relevance,
            "efficiency": efficiency,
        },
        "diagnosis_correct": correct,
        "supported_parts": supported,
        "assistance": {"hints": assistance["hints"], "demonstrated_steps": assistance["demonstrated_steps"]},
        "decisive_route": route,
        "detours": detours,
        "reference_route": ["time_range_changed", "query_submitted", "filter_added", "trace_opened", "diagnosis_submitted"],
        "summary": summary,
        "replay": {"same_seed": manifest["seed"], "new_seed": None, "modes": ["demonstration", "guided", "challenge"]},
    }
