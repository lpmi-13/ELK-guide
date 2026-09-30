"""Generic goal-graph evaluation and scenario-type scoring.

The evaluator deliberately knows nothing about individual scenario IDs. Packs
describe accepted observations and validators; this module applies the same
rules to every Kibana application used by the curriculum.
"""

from __future__ import annotations

import math
import re


# Coach bookkeeping, not investigation: never evidence, never scored for relevance or efficiency.
# ``check_in_answered`` records how the learner replied to a guided check-in, which costs nothing.
IGNORED_ACTIONS = {"hint_requested", "command_acknowledged", "step_demonstrated", "check_in_answered"}

# Actions that reshape what the learner is looking at. When the browser reports that one left
# zero matching documents (``state_after.result_count == 0``) it is a dead end, not evidence: a
# query that merely *mentions* the right field and value (``status_code is 503``) must not
# complete a step while Discover shows "No results".
SEARCH_ACTIONS = {"query_submitted", "esql_submitted", "filter_added", "filter_changed"}

# A window is accepted when its look-back reaches within this many minutes of when the incident
# was first noticed, so a 15-minute window still covers an incident reported 13 minutes ago while a
# 10-minute one (which would miss it) does not.
TIME_WINDOW_TOLERANCE_MINUTES = 1.0


def _details(action):
    return action.get("details") or {}


def _after(action):
    return action.get("state_after") or {}


def _lookup(source, dotted, default=None):
    current = source
    for part in str(dotted).split("."):
        if not isinstance(current, dict) or part not in current:
            return default
        current = current[part]
    return current


def _truth(session, key, default=None):
    truth = session.get("manifest", {}).get("scenario", {}).get("truth", {})
    value = _lookup(truth, key, default)
    if value is default:
        value = _lookup(session.get("manifest", {}).get("truth", {}), key, default)
    return value


def _expected_values(session, validator):
    if "value" in validator:
        value = validator["value"]
    elif "values" in validator:
        value = validator["values"]
    elif "value_from_expected" in validator:
        value = _lookup(session.get("manifest", {}).get("expected", {}), validator["value_from_expected"], [])
    else:
        value = _truth(session, validator.get("values_from_truth") or validator.get("value_from_truth"), [])
    return value if isinstance(value, list) else [value]


def action_text(action):
    details = _details(action)
    after = _after(action)
    return str(details.get("query") or details.get("value") or after.get("query") or "")


def _filters(action):
    details = _details(action)
    after = _after(action)
    values = after.get("filters") or details.get("filters") or []
    if details.get("field"):
        values = [*values, details]
    return values


def _same(left, right, case_sensitive=False):
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if case_sensitive:
        return str(left) == str(right)
    return str(left).casefold() == str(right).casefold()


def _assertion(evidence, assertion_id):
    assertions = evidence.get("assertions") or {}
    return bool(assertions.get(assertion_id, evidence.get(assertion_id, False)))


def validate_always(_session, _action, _evidence, _validator):
    return True


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def window_reaches_incident(details):
    """Whether a window's look-back includes when the incident was noticed; None when unknown.

    Either value missing (an unparseable or historical window) is unknown rather than a failure,
    so detection never regresses to "the correct action does nothing".
    """
    look_back = _number(details.get("from_minutes"))
    incident_offset = _number(details.get("incident_offset_minutes"))
    if look_back is None or incident_offset is None:
        return None
    return look_back + TIME_WINDOW_TOLERANCE_MINUTES >= incident_offset


def validate_time_range(session, action, _evidence, validator):
    details, after = _details(action), _after(action)
    time_from = str(details.get("from") or after.get("time_from") or "")
    time_to = str(details.get("to") or after.get("time_to") or "")
    if validator.get("any_valid", False):
        if not time_from:
            return False
        # When both the learner's window and the reported incident offset are known, require the
        # window to reach back far enough to include when the incident was noticed.
        return window_reaches_incident(details) is not False
    expected_from = str(validator.get("from") or _truth(session, validator.get("from_truth"), ""))
    expected_to = str(validator.get("to") or _truth(session, validator.get("to_truth"), ""))
    return (not expected_from or time_from == expected_from) and (not expected_to or time_to == expected_to)


def validate_query_contains(session, action, _evidence, validator):
    query = re.sub(r"\s+", "", action_text(action)).casefold()
    fields = validator.get("fields", [])
    has_values = any(key in validator for key in ("value", "values", "values_from_truth", "value_from_truth", "value_from_expected"))
    values = _expected_values(session, validator) if has_values else []
    return all(str(field).casefold() in query for field in fields) and all(str(value).casefold().replace(" ", "") in query for value in values)


def validate_query_language(_session, action, _evidence, validator):
    language = str(_details(action).get("language") or _after(action).get("query_language") or "").casefold()
    return language == str(validator.get("language", "")).casefold()


def validate_filter_contains(session, action, _evidence, validator):
    expected_values = _expected_values(session, validator)
    expected_field = validator.get("field")
    negate = bool(validator.get("negate", False))
    for item in _filters(action):
        field = item.get("field") or _lookup(item, "meta.key")
        value = item.get("value", _lookup(item, "meta.params.query"))
        item_negate = bool(item.get("negate", _lookup(item, "meta.negate", False)))
        if field == expected_field and item_negate == negate and any(_same(value, expected, validator.get("case_sensitive", False)) for expected in expected_values):
            return True
    return False


def validate_filter_excludes(session, action, evidence, validator):
    return validate_filter_contains(session, action, evidence, {**validator, "negate": True})


def validate_result_assertion(_session, _action, evidence, validator):
    return _assertion(evidence, validator.get("assertion"))


def validate_result_count(_session, action, _evidence, validator):
    count = _after(action).get("result_count", _details(action).get("result_count", 0))
    try:
        return float(count) >= float(validator.get("minimum", 1))
    except (TypeError, ValueError):
        return False


def validate_evidence_minimum(_session, _action, evidence, validator):
    try:
        return float(_lookup(evidence, validator.get("path"), 0)) >= float(validator.get("minimum", 1))
    except (TypeError, ValueError):
        return False


def validate_detail_equals(session, action, _evidence, validator):
    actual = _lookup(_details(action), validator.get("path") or validator.get("field"))
    return any(_same(actual, item, validator.get("case_sensitive", False)) for item in _expected_values(session, validator))


def validate_state_equals(session, action, _evidence, validator):
    actual = _lookup(_after(action), validator.get("path") or validator.get("field"))
    return any(_same(actual, item, validator.get("case_sensitive", False)) for item in _expected_values(session, validator))


def validate_inspected(session, action, _evidence, validator):
    required_type = validator.get("entity_type")
    actual_type = _details(action).get("entity_type") or action.get("type", "").removesuffix("_opened").removesuffix("_inspected")
    if required_type and not _same(actual_type, required_type):
        return False
    path = validator.get("field") or "id"
    actual = _lookup(_details(action), path) or _lookup(_after(action), path)
    if not any(key in validator for key in ("value", "values", "values_from_truth", "value_from_truth")):
        return bool(actual) or not path
    return any(_same(actual, item, validator.get("case_sensitive", False)) for item in _expected_values(session, validator))


def _base_field(field):
    return re.sub(r"\.(keyword|text)$", "", str(field or ""))


def _added_filter(action):
    """The filter an action applied: its details when they name one, else the last pill after it."""
    details = _details(action)
    if details.get("field"):
        return details
    filters = _after(action).get("filters") or []
    return filters[-1] if filters else {}


def validate_filter_field(_session, action, _evidence, validator):
    """The filter the action applied is on this field, whatever its value."""
    item = _added_filter(action)
    field = item.get("field") or _lookup(item, "meta.key")
    return bool(field) and _same(_base_field(field), _base_field(validator.get("field")))


def validate_value_not(session, action, _evidence, validator):
    """The action's value (the filter it applied, or a detail) is known and is not the expected one."""
    item = _added_filter(action)
    actual = item.get("value", _lookup(item, "meta.params.query"))
    if actual is None or actual == "":
        return False
    return not any(_same(actual, expected, validator.get("case_sensitive", False)) for expected in _expected_values(session, validator))


def validate_detail_not(session, action, _evidence, validator):
    """A detail is present and differs from the expected value (an unreported detail is not drift)."""
    actual = _lookup(_details(action), validator.get("path") or validator.get("field"))
    if actual is None or actual == "":
        return False
    return not any(_same(actual, item, validator.get("case_sensitive", False)) for item in _expected_values(session, validator))


def validate_app(_session, action, _evidence, validator):
    app = _details(action).get("app") or _after(action).get("app")
    return _same(app, validator.get("app"))


def validate_answer_submitted(_session, action, _evidence, _validator):
    return action.get("type") in {"answer_submitted", "diagnosis_submitted", "comparison_submitted", "triage_decision_submitted"}


VALIDATORS = {
    "always": validate_always,
    "time_range_contains": validate_time_range,
    "time_range_overlaps": validate_time_range,
    "query_contains": validate_query_contains,
    "query_language": validate_query_language,
    "filter_contains": validate_filter_contains,
    "filter_excludes": validate_filter_excludes,
    "result_assertion": validate_result_assertion,
    "result_count": validate_result_count,
    "evidence_minimum": validate_evidence_minimum,
    "detail_equals": validate_detail_equals,
    "detail_not": validate_detail_not,
    "filter_field": validate_filter_field,
    "value_not": validate_value_not,
    "state_equals": validate_state_equals,
    "inspected": validate_inspected,
    "selected_entity": validate_inspected,
    "app_is": validate_app,
    "answer_submitted": validate_answer_submitted,
    "resource_isolated": validate_result_assertion,
}


def _legacy_observation(command):
    return {
        "set_time_range": "time_range_changed",
        "enter_query": "query_submitted",
        "add_filter": "filter_added",
        "open_trace": "trace_opened",
        "request_diagnosis": "diagnosis_submitted",
    }.get(command, command)


def _legacy_validators(step):
    validation = step.get("validation", {})
    kind = validation.get("type")
    if kind == "browser_state":
        return [{"kind": "time_range_contains", "from": validation.get("time_from"), "any_valid": not validation.get("time_from")}]
    if kind == "elasticsearch_count":
        return [{"kind": "result_assertion", "assertion": "slow_events"}]
    if kind == "browser_and_elasticsearch":
        return [
            {"kind": "filter_contains", "field": validation.get("field"), "value": validation.get("value")},
            {"kind": "result_assertion", "assertion": "service_events"},
        ]
    if kind == "selected_trace":
        return [{"kind": "result_assertion", "assertion": "representative_trace"}]
    return [{"kind": "answer_submitted"}]


def playbook_goals(session):
    playbook = session.get("playbook")
    if not playbook:
        legacy = {
            "scope_incident_window": [{"action": "time_range_changed", "validators": [{"kind": "time_range_contains", "any_valid": True}]}],
            "identify_slow_transactions": [{"action": "query_submitted", "validators": [{"kind": "result_assertion", "assertion": "slow_events"}]}],
            "compare_services": [
                {"action": "query_submitted", "validators": [{"kind": "query_contains", "fields": ["service.name"], "value_from_expected": "service"}, {"kind": "result_assertion", "assertion": "service_events"}]},
                {"action": ["filter_added", "filter_changed"], "validators": [{"kind": "filter_contains", "field": "service.name", "value_from_expected": "service"}, {"kind": "result_assertion", "assertion": "service_events"}]},
            ],
            "inspect_representative_trace": [{"action": ["trace_opened", "document_expanded"], "validators": [{"kind": "evidence_minimum", "path": "trace_services", "minimum": 3}]}],
            "submit_supported_diagnosis": [{"action": ["diagnosis_submitted", "answer_submitted"], "validators": [{"kind": "answer_submitted"}]}],
        }
        return [{**goal, "title": goal["id"], "requires": [], "accepts": legacy.get(goal["id"], [])} for goal in session.get("rubric", {}).get("goals", [])]
    if playbook.get("schema_version") == 2:
        return playbook.get("goals", [])
    return [
        {
            "id": step["goal"],
            "title": step["id"],
            "requires": [],
            "accepts": [{"action": _legacy_observation(step["action"]), "validators": _legacy_validators(step)}],
            "reference_action": {"command": step["action"], "arguments": step.get("value")},
            **{key: step.get(key, "") for key in ("narration", "reasoning", "evidence", "concept", "target", "hints")},
        }
        for step in playbook.get("steps", [])
    ]


def _route_matches(session, action, evidence, route):
    accepted_action = route.get("action")
    action_matches = action.get("type") in accepted_action if isinstance(accepted_action, list) else action.get("type") == accepted_action
    if not action_matches:
        return False
    for validator in route.get("validators", []):
        implementation = VALIDATORS.get(validator.get("kind"))
        if not implementation or not implementation(session, action, evidence, validator):
            return False
    return True


def returned_no_results(action):
    """True only when the browser explicitly measured an empty result for a search action."""
    if action.get("type") not in SEARCH_ACTIONS:
        return False
    count = _after(action).get("result_count", _details(action).get("result_count"))
    return count is not None and _number(count) == 0


def _holds_filter(filters, query, earned):
    """An earned filter is still in force: as an enabled pill, or named with its value in the query."""
    for item in filters:
        field = item.get("field") or _lookup(item, "meta.key")
        value = item.get("value", _lookup(item, "meta.params.query"))
        negate = bool(item.get("negate", _lookup(item, "meta.negate", False)))
        if item.get("disabled") or _lookup(item, "meta.disabled"):
            continue
        if _same(_base_field(field), _base_field(earned.get("field"))) and _same(value, earned.get("value")) and negate == bool(earned.get("negate")):
            return True
    compact = re.sub(r"\s+", "", str(query or "")).casefold()
    return not earned.get("negate") and bool(compact) and str(earned.get("field", "")).casefold() in compact \
        and str(earned.get("value", "")).casefold().replace(" ", "") in compact


def lost_earned_filters(action, earned_state):
    """Earned filters (restore_state) the search no longer holds. Only judged when the browser
    reported the pills applied after the action; a report without them says nothing about pills."""
    after = _after(action)
    if not earned_state or "filters" not in after:
        return []
    filters, query = after.get("filters") or [], after.get("query", "")
    return [earned for earned in earned_state.get("filters") or [] if not _holds_filter(filters, query, earned)]


def _scope_complete(session):
    return any(
        goal["id"] in session.get("completed_goals", set()) and goal.get("reference_action", {}).get("command") == "set_time_range"
        for goal in playbook_goals(session)
    )


def dead_end(session, action, earned_state=None):
    """Why the view can no longer answer the current step, or None.

    ``empty_result``: the search left nothing to read. ``lost_earned_state``: a filter a completed step
    earned is gone. ``window_excludes_incident``: once the window was scoped, a new one no longer
    reaches back to when the incident was noticed (before scoping, the scope step handles windows).
    The last two judge the learner's own changes only; the coach's performed actions are trusted.
    """
    if returned_no_results(action):
        return {"reason_code": "empty_result", "reason": "That search returned no results, so it cannot establish a goal."}
    if action.get("actor") == "tutorial":
        return None
    lost = lost_earned_filters(action, earned_state)
    if lost:
        names = ", ".join(f"{item['field']}: {item['value']}" for item in lost)
        return {"reason_code": "lost_earned_state", "lost": lost,
                "reason": f"The search no longer holds {names}, which an earlier step established."}
    if action.get("type") == "time_range_changed" and _scope_complete(session) and window_reaches_incident(_details(action)) is False:
        details = _details(action)
        return {"reason_code": "window_excludes_incident",
                "from_minutes": _number(details.get("from_minutes")),
                "incident_offset_minutes": _number(details.get("incident_offset_minutes")),
                "reason": "The window no longer reaches back to when the incident was noticed."}
    return None


def current_goal(session):
    """The step the learner is on: the first unfinished goal, as the coach presents them."""
    completed = session.get("completed_goals", set())
    return next((goal for goal in playbook_goals(session) if goal["id"] not in completed), None)


ACTION_TOKEN = re.compile(r"\$\{action\.([A-Za-z0-9_.]+)\}")


def drift_note(session, action):
    """The note of the current step's first drift rule this action matches, or None."""
    goal = current_goal(session)
    if not goal:
        return None
    for route in goal.get("drifts", []):
        if _route_matches(session, action, {}, route):
            return goal["id"], ACTION_TOKEN.sub(lambda match: str(_lookup(_details(action), match.group(1), "") or match.group(0)), route.get("note", ""))
    return None


def evaluate_action(session, action, evidence=None, earned_state=None):
    """Progress every eligible goal satisfied by this normalized observation.

    ``earned_state`` is the search the completed steps established (the service's restore_state);
    with it, losing an earned filter or narrowing the window off the incident is a dead end too.
    """
    evidence = evidence or {}
    ignored = action.get("type") in IGNORED_ACTIONS
    blocked = None if ignored else dead_end(session, action, earned_state)
    if blocked:
        goal = current_goal(session)
        return {"outcome": "dead_end", "goals_progressed": [], "meaningful": False,
                "step_id": goal["id"] if goal else None, **blocked}
    completed = session["completed_goals"]
    progressed, matching_titles = [], []
    # A single observation may establish multiple independent outcomes, but it
    # cannot satisfy a dependent goal by using a prerequisite completed by that
    # same observation. This preserves meaningful interpretation pauses.
    for goal in playbook_goals(session):
        goal_id = goal["id"]
        if goal_id in completed or not set(goal.get("requires", [])).issubset(completed):
            continue
        if any(_route_matches(session, action, evidence, route) for route in goal.get("accepts", [])):
            progressed.append(goal_id)
            matching_titles.append(goal.get("title", goal_id))
    if not progressed and not ignored and session.get("mode") in {"guided", "challenge"}:
        drift = drift_note(session, action)
        if drift:
            return {"outcome": "drift", "goals_progressed": [], "meaningful": False, "step_id": drift[0], "note": drift[1],
                    "reason": "The observation was recorded; it moves away from what this step needs."}
    completed.update(progressed)
    meaningful = bool(progressed)
    reason = "Completed: " + ", ".join(matching_titles) if meaningful else "The observation was recorded but did not yet establish an unfinished goal."
    return {"outcome": "accepted" if meaningful else "observed", "goals_progressed": progressed, "meaningful": meaningful, "reason": reason}


def _answer_matches(actual, expected, field):
    kind = field.get("kind", "string")
    if kind == "number":
        try:
            return math.isclose(float(actual), float(expected), abs_tol=float(field.get("tolerance", 0)), rel_tol=0)
        except (TypeError, ValueError):
            return False
    if kind == "string_list":
        actual_values = actual if isinstance(actual, list) else re.split(r"\s*,\s*", str(actual or ""))
        expected_values = expected if isinstance(expected, list) else [expected]
        return {str(item).casefold() for item in actual_values} == {str(item).casefold() for item in expected_values}
    return _same(actual, expected, field.get("case_sensitive", False))


def score_session(session, trace_is_valid=False, evidence=None):
    """Score diagnosis, comparison, and triage answers using the pack schema."""
    if session.get("mode") == "guided":
        return guided_feedback(session)
    manifest = session["manifest"]
    scenario = manifest.get("scenario", {})
    truth = scenario.get("truth", manifest.get("truth", {}))
    answer_schema = scenario.get("answer_schema") or manifest.get("answer_schema") or {}
    answer = session.get("answer") or {}
    rubric = session["rubric"]
    weights = rubric.get("weights", {"correctness": 40, "evidence": 20, "coverage": 20, "relevance": 10, "efficiency": 10})
    correctness_weight = weights.get("correctness", weights.get("diagnosis", 40))

    fields = [field for field in answer_schema.get("fields", []) if field.get("scored", True)]
    supported = []
    if fields:
        total_field_weight = sum(float(field.get("weight", 1)) for field in fields) or 1
        correctness = 0.0
        for field in fields:
            expected = _lookup(truth, field.get("answer_from_truth", f"answers.{field['id']}"))
            if _answer_matches(answer.get(field["id"]), expected, field):
                correctness += correctness_weight * float(field.get("weight", 1)) / total_field_weight
                supported.append(field.get("label", field["id"]))
    else:
        expected = manifest.get("expected", {})
        checks = [("service", expected.get("service"), 20), ("fault_type", expected.get("fault_type"), 10), ("affected_route", expected.get("route"), 10)]
        correctness = sum(points for key, value, points in checks if _same(answer.get(key, ""), value))
        supported = [key.replace("_", " ") for key, value, _points in checks if _same(answer.get(key, ""), value)]

    evidence = evidence or {}
    evidence_refs = answer.get("evidence_refs") or []
    if isinstance(evidence_refs, str):
        evidence_refs = [item.strip() for item in evidence_refs.split(",") if item.strip()]
    declared_assertions = {item.get("id") for item in truth.get("assertions", [])}
    valid_refs = [item for item in evidence_refs if item in declared_assertions and _assertion(evidence, item)]
    cited_trace = str(answer.get("trace_id", ""))
    reference_credit = bool(valid_refs) or (bool(cited_trace) and trace_is_valid)
    explanation = str(answer.get("evidence") or answer.get("reasoning") or answer.get("conclusion") or "").strip()
    evidence_score = weights.get("evidence", 20) * ((0.6 if reference_credit else 0) + (0.4 if explanation else 0))

    rubric_goals = rubric.get("goals") or playbook_goals(session)
    goals = {goal["id"] for goal in rubric_goals if goal.get("scored", True)}
    coverage = weights.get("coverage", 20) * len(session["completed_goals"] & goals) / max(1, len(goals))
    semantic = [item for item in session.get("actions", []) if item["action"].get("type") not in IGNORED_ACTIONS]
    meaningful = sum(1 for item in semantic if item.get("evaluation", {}).get("meaningful"))
    relevance = weights.get("relevance", 10) * meaningful / max(1, len(semantic))
    costs = rubric.get("action_costs", {})
    actual_cost = sum(float(costs.get(item["action"].get("type"), 1)) for item in semantic)
    efficiency = weights.get("efficiency", 10) * min(1, float(rubric.get("reference_action_cost", 1)) / max(1, actual_cost))

    assistance = session.get("assistance", {"hints": 0, "demonstrated_steps": 0})
    penalty = 0
    if session.get("mode") == "challenge":
        penalty = min(float(rubric.get("maximum_assistance_penalty", 20)), assistance.get("hints", 0) * float(rubric.get("hint_penalty", 2)) + assistance.get("demonstrated_steps", 0) * float(rubric.get("demonstration_penalty", 5)))
    total = round(max(0, correctness + evidence_score + coverage + relevance + efficiency - penalty), 1)
    components = {
        "task_correctness": round(correctness, 1),
        "evidence_quality": round(evidence_score, 1),
        "goal_coverage": round(coverage, 1),
        "relevance": round(relevance, 1),
        "efficiency": round(efficiency, 1),
    }
    components["diagnosis_correctness"] = components["task_correctness"]
    components["investigation_relevance"] = components["relevance"]
    correct = math.isclose(correctness, correctness_weight)
    scenario_type = scenario.get("type", "investigation")
    answer_name = {"analysis": "comparison", "triage": "triage decision"}.get(scenario_type, "diagnosis")
    summary = f"Your {answer_name} matches the scenario truth and is supported by the recorded Kibana evidence." if correct else f"The submitted {answer_name} does not yet match every decisive fact in the scenario evidence."
    route = [item["action"].get("type") for item in semantic if item.get("evaluation", {}).get("meaningful")]
    detours = [item["action"].get("type") for item in semantic if not item.get("evaluation", {}).get("meaningful")]
    feedback = {
        "total": total,
        "components": components,
        "task_correct": correct,
        "diagnosis_correct": correct,
        "supported_parts": supported,
        "assistance": {**assistance, "score_penalty": penalty},
        "decisive_route": route,
        "detours": detours,
        "step_detours": step_detours(session),
        "reference_route": [goal.get("reference_action", {}).get("command") for goal in playbook_goals(session)],
        "summary": summary,
        "replay": {"same_seed": manifest["seed"], "new_seed": None, "modes": ["demonstration", "guided", "challenge"]},
    }
    if session.get("mode") == "demonstration":
        feedback.update({"scored": False, "total": None, "summary": scenario.get("demonstration_conclusion", summary)})
    else:
        feedback["scored"] = True
    return feedback


DEAD_END_LABELS = {
    "missing_colon": "missing colon",
    "unknown_field": "unknown field",
    "value_absent": "value not in the data",
    "empty_result": "search with no results",
    "lost_earned_state": "removed an earned filter",
    "window_excludes_incident": "window missed the incident",
}


def dead_end_labels(log):
    labels = []
    for entry in log.get("dead_ends") or []:
        label = DEAD_END_LABELS.get(entry.get("diagnosis") or entry.get("reason_code"), "search with no results")
        if label not in labels:
            labels.append(label)
    return labels


def _duration(seconds):
    seconds = int(round(float(seconds)))
    return f"{seconds // 60}m {seconds % 60:02d}s" if seconds >= 60 else f"{seconds}s"


def step_detail(log):
    """One short line such as "1m 05s · needed a check-in · recovered from a dead end: missing colon"."""
    parts = []
    if log.get("seconds_active") is not None:
        parts.append(_duration(log["seconds_active"]))
    check_ins = len(log.get("check_ins") or [])
    if check_ins:
        parts.append("needed a check-in" if check_ins == 1 else f"needed {check_ins} check-ins")
    dead_ends = len(log.get("dead_ends") or [])
    if dead_ends:
        prefix = "recovered from a dead end" if dead_ends == 1 else f"recovered from {dead_ends} dead ends"
        parts.append(f"{prefix}: {', '.join(dead_end_labels(log))}")
    return " · ".join(parts)


def step_detours(session):
    """Per-step dead ends and drift, for a challenge debrief (no clock, no live feedback)."""
    detours = []
    for goal in playbook_goals(session):
        log = (session.get("step_log") or {}).get(goal["id"]) or {}
        dead_ends, drift = dead_end_labels(log), list(log.get("drift") or [])
        if dead_ends or drift:
            detours.append({"id": goal["id"], "title": goal.get("title", goal["id"]), "dead_ends": dead_ends, "drift": drift})
    return detours


def guided_feedback(session):
    """Score completed guided steps by the most assistance used on each one."""
    goals = playbook_goals(session)
    practice_ids = {
        goal["id"] for goal in goals
        if goal.get("reference_action", {}).get("command") not in {"request_answer", "request_diagnosis"}
    }
    hinted_ids = {step_id for step_id, count in session.get("hint_level", {}).items() if count and step_id in practice_ids}
    shown_ids = {
        (item.get("action", {}).get("details") or {}).get("step_id")
        for item in session.get("actions", [])
        if item.get("action", {}).get("type") == "step_demonstrated"
    } & practice_ids
    assistance = session.get("assistance", {})
    step_count = len(practice_ids)
    completed_ids = session["completed_goals"] & practice_ids
    helped_ids = hinted_ids | shown_ids
    independent_ids = completed_ids - helped_ids
    hint_only_ids = (completed_ids & hinted_ids) - shown_ids
    total = round(100 * (len(independent_ids) + 0.5 * len(hint_only_ids)) / max(1, step_count), 1)

    def outcome(goal_id):
        if goal_id not in completed_ids:
            return "incomplete"
        if goal_id in shown_ids:
            return "shown"
        return "hinted" if goal_id in hinted_ids else "independent"

    steps = []
    for goal in goals:
        if goal["id"] not in practice_ids:
            continue
        log = (session.get("step_log") or {}).get(goal["id"]) or {}
        step = {"id": goal["id"], "title": goal.get("title", goal["id"]), "outcome": outcome(goal["id"])}
        # Unscored context for the step row: how long it took and what it took to get through it.
        detail = step_detail(log)
        if detail:
            step["detail"] = detail
        if log.get("seconds_active") is not None:
            step["seconds_active"] = log["seconds_active"]
        steps.append(step)
    return {
        "scored": True,
        "total": total,
        "completion": round(100 * len(completed_ids) / max(1, step_count), 1),
        "summary": "Your score reflects the help you used in each phase.",
        "assistance": {
            "hints": assistance.get("hints", 0),
            "demonstrated_steps": assistance.get("demonstrated_steps", 0),
            "hinted_steps": len(hinted_ids),
            "shown_steps": len(shown_ids),
            "independent_steps": len(independent_ids),
            "step_count": step_count,
        },
        "steps": steps,
    }
