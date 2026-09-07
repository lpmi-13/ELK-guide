"""Dependency-free static contract checks for scenario packs."""

from __future__ import annotations

import json
from pathlib import Path

try:
    from .evaluator import VALIDATORS
except ImportError:  # direct script/test loading
    from evaluator import VALIDATORS

PROHIBITED_COMMANDS = {"shell", "terminal", "dev_tools", "elasticsearch_admin", "external_application", "save", "edit_dashboard", "create_rule", "create_slo"}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def expand_descriptor(learning_dir, kind, descriptor):
    if not descriptor.get("extends"):
        return descriptor
    template = read_json(Path(learning_dir) / "templates" / f"{kind}s" / descriptor["extends"])
    variables = descriptor.get("variables", {})

    def expand(value):
        if isinstance(value, str):
            for key, item in variables.items():
                value = value.replace(f"${{var.{key}}}", str(item))
            return value
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, dict):
            return {key: expand(item) for key, item in value.items()}
        return value

    result = expand(template)
    result.update(descriptor.get("overrides", {}))
    result["id"] = descriptor.get("id", result["id"])
    return result


def goal_cycles(goals):
    dependencies = {goal["id"]: set(goal.get("requires", [])) for goal in goals}
    visiting, visited = set(), set()

    def visit(goal_id):
        if goal_id in visiting:
            return True
        if goal_id in visited:
            return False
        visiting.add(goal_id)
        if any(visit(required) for required in dependencies.get(goal_id, ())):
            return True
        visiting.remove(goal_id)
        visited.add(goal_id)
        return False

    return any(visit(goal_id) for goal_id in dependencies)


def validate_catalog(learning_dir):
    learning_dir = Path(learning_dir)
    catalog = read_json(learning_dir / "catalog.json")
    compatibility = read_json(learning_dir / "compatibility" / "kibana-9.5.2.json")
    capabilities = set(compatibility["capabilities"])
    command_types = set(read_json(learning_dir / "schemas" / "command.schema.json")["properties"]["type"]["enum"])
    entries = catalog["scenarios"]
    errors = []
    identifiers = [entry["id"] for entry in entries]
    if len(identifiers) != len(set(identifiers)):
        errors.append("catalog contains duplicate scenario IDs")
    if len([entry for entry in entries if entry["classification"] == "core"]) != 24:
        errors.append("catalog must contain exactly 24 core scenarios")

    for entry in entries:
        pack = learning_dir / entry["pack"].removeprefix("scenarios/")
        if not pack.is_dir():
            pack = learning_dir / entry["pack"]
        required_files = [pack / name for name in ("scenario.json", "playbook.json", "rubric.json")]
        for path in required_files:
            if not path.is_file():
                errors.append(f"{entry['id']}: missing {path.name}")
        if any(not path.is_file() for path in required_files):
            continue
        scenario = read_json(pack / "scenario.json")
        playbook = expand_descriptor(learning_dir, "playbook", read_json(pack / "playbook.json"))
        rubric = expand_descriptor(learning_dir, "rubric", read_json(pack / "rubric.json"))
        if scenario["id"] != entry["id"]:
            errors.append(f"{entry['id']}: scenario ID does not match catalog")
        undeclared = set(scenario.get("required_capabilities", [])) - capabilities
        if undeclared:
            errors.append(f"{entry['id']}: unknown capabilities {sorted(undeclared)}")
        goals = playbook.get("goals", [])
        goal_ids = {goal["id"] for goal in goals}
        if goal_cycles(goals):
            errors.append(f"{entry['id']}: goal graph contains a cycle")
        if {goal["id"] for goal in rubric.get("goals", [])} != goal_ids:
            errors.append(f"{entry['id']}: rubric and playbook goals differ")
        assertions = {item["id"] for item in scenario.get("truth", {}).get("assertions", [])}
        referenced_assertions = set()
        for goal in goals:
            if not goal.get("accepts"):
                errors.append(f"{entry['id']}/{goal['id']}: no accepted route")
            missing_requirements = set(goal.get("requires", [])) - goal_ids
            if missing_requirements:
                errors.append(f"{entry['id']}/{goal['id']}: missing dependencies {sorted(missing_requirements)}")
            reference = goal.get("reference_action", {})
            command = reference.get("command")
            if command not in command_types:
                errors.append(f"{entry['id']}/{goal['id']}: unknown command {command}")
            if command in PROHIBITED_COMMANDS or reference.get("target") in PROHIBITED_COMMANDS:
                errors.append(f"{entry['id']}/{goal['id']}: prohibited learner action")
            if len(goal.get("hints", [])) < 3:
                errors.append(f"{entry['id']}/{goal['id']}: fewer than three progressive hints")
            for route in goal.get("accepts", []):
                for validator in route.get("validators", []):
                    kind = validator.get("kind")
                    if kind not in VALIDATORS:
                        errors.append(f"{entry['id']}/{goal['id']}: unknown validator {kind}")
                    if kind in {"result_assertion", "resource_isolated"}:
                        referenced_assertions.add(validator.get("assertion"))
        missing_validation = assertions - referenced_assertions
        # Resource-isolation assertions are controller invariants and do not need a learner goal.
        missing_validation -= {item["id"] for item in scenario["truth"]["assertions"] if item.get("kind") == "resource_isolated"}
        if missing_validation:
            errors.append(f"{entry['id']}: truth assertions lack goal validators {sorted(missing_validation)}")
        if sum(rubric["weights"].values()) != 100:
            errors.append(f"{entry['id']}: rubric weights do not total 100")
    return errors


def assert_catalog_valid(learning_dir):
    errors = validate_catalog(learning_dir)
    if errors:
        raise ValueError("scenario catalog contract failed:\n- " + "\n- ".join(errors))
