#!/usr/bin/env python3
"""Provision and clean catalog packs against a running Kibana 9.5.2 stack."""

import argparse
import json
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def request_json(url, method="GET", payload=None, headers=None, timeout=30):
    request = Request(
        url,
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as error:
        raw = error.read()
        return error.code, json.loads(raw) if raw else {"error": str(error)}


def wait_ready(learning_url, run_id, timeout=150):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, run = request_json(f"{learning_url}/api/runs/{run_id}")
        if status != 200:
            raise AssertionError(f"{run_id}: status lookup failed ({status}): {run}")
        if run["state"] == "READY":
            return run
        if run["state"] == "FAILED":
            raise AssertionError(f"{run_id}: {run.get('error')}")
        time.sleep(1)
    raise TimeoutError(f"{run_id}: readiness timed out")


def provision(learning_url, scenario_id, seed):
    status, created = request_json(
        f"{learning_url}/api/runs",
        "POST",
        {"scenario": scenario_id, "seed": seed, "mode": "challenge"},
    )
    if status != 202:
        raise AssertionError(f"{scenario_id}: create failed ({status}): {created}")
    ready = wait_ready(learning_url, created["run"]["run_id"])
    if ready["evidence"]["completed"] != ready["evidence"]["required"]:
        raise AssertionError(f"{scenario_id}: incomplete readiness evidence: {ready['evidence']}")
    if f"/s/{ready['space_id']}/" not in ready["investigation_url"]:
        raise AssertionError(f"{scenario_id}: starting URL is not Space-scoped")
    return ready


def assert_seeded_data(elasticsearch_url, scenario_id, run_id):
    scenario = json.loads((ROOT / "learning" / "scenarios" / scenario_id / "scenario.json").read_text(encoding="utf-8"))
    if "seeded-events" not in scenario["provisioning"]["strategies"]:
        return
    status, result = request_json(
        f"{elasticsearch_url}/lab-{run_id}/_count",
        "POST",
        {"query": {"term": {"lab.run_id.keyword": run_id}}},
    )
    if status != 200 or result.get("count", 0) < 2:
        raise AssertionError(f"{scenario_id}: isolated seeded data missing ({status}): {result}")


def assert_space(kibana_url, space_id):
    status, result = request_json(
        f"{kibana_url}/api/spaces/space/{space_id}",
        headers={"kbn-xsrf": "live-scenario-matrix"},
    )
    if status != 200 or result.get("id") != space_id:
        raise AssertionError(f"{space_id}: Space lookup failed ({status}): {result}")


def cleanup(learning_url, run_id):
    status, result = request_json(f"{learning_url}/api/runs/{run_id}", "DELETE")
    if status != 200 or not result.get("aborted"):
        raise AssertionError(f"{run_id}: cleanup failed ({status}): {result}")


def assert_cleaned(kibana_url, elasticsearch_url, run):
    status, _ = request_json(
        f"{kibana_url}/api/spaces/space/{run['space_id']}",
        headers={"kbn-xsrf": "live-scenario-matrix"},
    )
    if status != 404:
        raise AssertionError(f"{run['run_id']}: Space still exists after cleanup")
    for index in (f"lab-{run['run_id']}", f"traces-apm.lab-{run['run_id']}"):
        status, _ = request_json(f"{elasticsearch_url}/{index}/_count")
        if status != 404:
            raise AssertionError(f"{run['run_id']}: index {index} still exists after cleanup")
    namespace = f"lab{run['run_id'].removeprefix('run-')}"
    status, result = request_json(f"{elasticsearch_url}/_data_stream")
    remaining_streams = [item["name"] for item in result.get("data_streams", []) if item["name"].endswith(f"-{namespace}")]
    if status == 200 and remaining_streams:
        raise AssertionError(f"{run['run_id']}: data streams still exist after cleanup: {remaining_streams}")
    status, result = request_json(
        f"{elasticsearch_url}/microservices-*/_count?allow_no_indices=true",
        "POST",
        {"query": {"term": {"scenario.id.keyword": run["run_id"]}}},
    )
    if status == 200 and result.get("count"):
        raise AssertionError(f"{run['run_id']}: live telemetry still exists after cleanup")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--learning-url", default="http://localhost:8091")
    parser.add_argument("--elasticsearch-url", default="http://localhost:9200")
    parser.add_argument("--kibana-url", default="http://localhost:5601")
    parser.add_argument("--scenario")
    parser.add_argument("--surface")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--isolation", action="store_true")
    args = parser.parse_args()
    learning_url = args.learning_url.rstrip("/")
    elasticsearch_url = args.elasticsearch_url.rstrip("/")
    kibana_url = args.kibana_url.rstrip("/")

    status, catalog = request_json(f"{learning_url}/api/catalog")
    if status != 200:
        raise SystemExit(f"catalog unavailable ({status}): {catalog}")
    entries = [item for item in catalog["scenarios"] if item["classification"] == "core" and item["available"]]
    if args.scenario:
        entries = [item for item in entries if item["id"] == args.scenario]
    if args.surface:
        entries = [item for item in entries if item["surface"] == args.surface]
    if not args.all and not args.scenario and not args.surface:
        entries = [item for item in entries if item["id"] == "discover-time-window"]
    if not entries:
        raise SystemExit("no available core scenarios matched")

    passed = []
    for offset, entry in enumerate(entries):
        run = provision(learning_url, entry["id"], 20260830 + offset)
        try:
            assert_space(kibana_url, run["space_id"])
            assert_seeded_data(elasticsearch_url, entry["id"], run["run_id"])
            passed.append(entry["id"])
        finally:
            cleanup(learning_url, run["run_id"])
            assert_cleaned(kibana_url, elasticsearch_url, run)

    if args.isolation:
        target = next((item for item in entries if "saved_objects" in item.get("required_capabilities", [])), entries[0])
        first = provision(learning_url, target["id"], 73001)
        second = provision(learning_url, target["id"], 73001)
        try:
            if first["space_id"] == second["space_id"] or first["run_id"] == second["run_id"]:
                raise AssertionError("concurrent runs did not receive distinct identities")
            assert_seeded_data(elasticsearch_url, target["id"], first["run_id"])
            assert_seeded_data(elasticsearch_url, target["id"], second["run_id"])
        finally:
            cleanup(learning_url, first["run_id"])
            cleanup(learning_url, second["run_id"])
            assert_cleaned(kibana_url, elasticsearch_url, first)
            assert_cleaned(kibana_url, elasticsearch_url, second)

    unavailable = [item["id"] for item in catalog["scenarios"] if item["classification"] == "core" and not item["available"]]
    print(json.dumps({"passed": passed, "count": len(passed), "unavailable_core": unavailable, "isolation": args.isolation}, indent=2))


if __name__ == "__main__":
    main()
