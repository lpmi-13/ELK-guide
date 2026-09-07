#!/usr/bin/env python3
"""Run the dependency-free scenario-by-mode contract matrix."""

import argparse
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "learning-service" / "engine"
sys.path.insert(0, str(ENGINE))

from contracts import expand_descriptor, validate_catalog  # noqa: E402
from evaluator import evaluate_action, score_session  # noqa: E402


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


COMMAND_OBSERVATIONS = {
    "set_time_range":"time_range_changed", "enter_kql":"query_submitted", "switch_query_language":"query_language_changed", "enter_esql":"esql_submitted",
    "expand_document":"document_expanded", "inspect_field":"field_inspected", "set_dashboard_control":"dashboard_control_changed",
    "interact_with_panel_value":"panel_value_selected", "view_panel_underlying_data":"panel_underlying_data_opened", "select_apm_service":"apm_service_selected",
    "select_trace_sample":"trace_sample_selected", "select_span":"span_selected", "open_error_details":"error_details_opened", "navigate_to_correlated_logs":"correlated_logs_opened",
    "select_service_map_node":"service_map_node_selected", "select_inventory_type":"inventory_type_selected", "select_metric":"metric_selected",
    "navigate_from_metrics_to_logs":"metrics_logs_opened", "open_alert":"alert_opened", "inspect_alert_reason":"alert_reason_inspected",
    "navigate_from_alert_to_source":"alert_source_opened", "open_slo":"slo_opened", "inspect_slo_error_budget":"slo_error_budget_inspected",
    "inspect_slo_burn_rate":"slo_burn_rate_inspected", "select_map_region":"map_region_selected", "open_synthetics_step":"synthetics_step_opened",
    "open_ml_anomaly":"ml_anomaly_opened", "navigate_to_app":"app_navigated", "request_answer":"answer_submitted"
}


def action_for(goal, scenario):
    route = goal["accepts"][0]
    accepted = route["action"] if isinstance(route["action"], list) else [route["action"]]
    preferred = COMMAND_OBSERVATIONS.get(goal.get("reference_action", {}).get("command"))
    action_type = preferred if preferred in accepted else accepted[0]
    details, state_after = {}, {}
    for validator in route.get("validators", []):
        kind = validator["kind"]
        if kind.startswith("time_range"):
            details.update({"from": validator.get("from", "now-15m"), "to": validator.get("to", "now")})
        elif kind == "query_language":
            details["language"] = validator["language"]
            state_after["query_language"] = validator["language"]
        elif kind == "query_contains":
            values = validator.get("values", [])
            truth_key = validator.get("value_from_truth") or validator.get("values_from_truth")
            if truth_key:
                value = scenario["truth"]
                for part in truth_key.split("."):
                    value = value[part]
                values = value if isinstance(value, list) else [value]
            details["query"] = " ".join([*validator.get("fields", []), *map(str, values)])
        elif kind in {"filter_contains", "filter_excludes"}:
            value = validator.get("value")
            if validator.get("value_from_truth"):
                value = scenario["truth"]
                for part in validator["value_from_truth"].split("."):
                    value = value[part]
            details.update({"field": validator["field"], "value": value, "negate": kind == "filter_excludes"})
        elif kind in {"inspected", "selected_entity"}:
            details.update({"entity_type": validator.get("entity_type"), "id": validator.get("value", "representative")})
    return {"type": action_type, "details": details, "state_after": state_after}


def run_pack(entry, mode):
    pack = ROOT / "learning" / entry["pack"]
    scenario = read(pack / "scenario.json")
    playbook = expand_descriptor(ROOT / "learning", "playbook", read(pack / "playbook.json"))
    rubric = expand_descriptor(ROOT / "learning", "rubric", read(pack / "rubric.json"))
    manifest = {"schema_version": 2, "seed": 42, "scenario": scenario}
    session = {"manifest": manifest, "playbook": playbook, "rubric": rubric, "mode": mode, "completed_goals": set(), "actions": [], "assistance": {"hints": 0, "demonstrated_steps": 0}}
    evidence = {"assertions": {item["id"]: True for item in scenario["truth"]["assertions"]}, "trace_services": 4}
    for goal in playbook["goals"]:
        action = action_for(goal, scenario)
        evaluation = evaluate_action(session, action, evidence)
        session["actions"].append({"action": action, "evaluation": evaluation})
        if goal["id"] not in session["completed_goals"]:
            raise AssertionError(f"{entry['id']}/{mode}: reference route did not complete {goal['id']}")
    session["answer"] = {**scenario["truth"]["answers"], "evidence_refs": [item["id"] for item in scenario["truth"]["assertions"]], "evidence": "The reference route established every declared assertion."}
    feedback = score_session(session, evidence=evidence)
    if not feedback["task_correct"]:
        raise AssertionError(f"{entry['id']}/{mode}: reference answer rejected")
    if mode == "challenge" and feedback["total"] != 100:
        raise AssertionError(f"{entry['id']}/{mode}: expected score 100, got {feedback['total']}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario")
    parser.add_argument("--surface")
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()
    errors = validate_catalog(ROOT / "learning")
    if errors:
        raise SystemExit("\n".join(errors))
    entries = read(ROOT / "learning" / "catalog.json")["scenarios"]
    entries = [entry for entry in entries if entry["classification"] == "core"]
    if args.scenario:
        entries = [entry for entry in entries if entry["id"] == args.scenario]
    if args.surface:
        entries = [entry for entry in entries if entry["surface"] == args.surface]
    if not entries:
        raise SystemExit("no core scenarios matched")
    for entry in entries:
        for mode in ("demonstration", "guided", "challenge"):
            run_pack(entry, mode)
    print(f"passed {len(entries) * 3} scenario-mode contracts across {len(entries)} packs")


if __name__ == "__main__":
    main()
