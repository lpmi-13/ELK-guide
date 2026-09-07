#!/usr/bin/env python3
"""Exercise a complete learning session against a running Compose stack."""

import argparse
import json
import time
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def request_json(url, method="GET", payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, data=json.dumps(payload).encode() if payload is not None else None, method=method, headers=headers)
    try:
        with urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        try:
            detail = json.load(error)
        except json.JSONDecodeError:
            detail = {"error": str(error)}
        return error.code, detail


def expect(status, payload, expected=(200, 202)):
    if status not in expected:
        raise RuntimeError(f"HTTP {status}: {payload}")
    return payload


def wait_ready(learning_url, run_id, timeout=150):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, run = request_json(f"{learning_url}/api/runs/{run_id}")
        expect(status, run, (200,))
        if run["state"] == "READY":
            return run
        if run["state"] == "FAILED":
            raise RuntimeError(run.get("error") or "scenario failed")
        time.sleep(2)
    raise TimeoutError("scenario did not become READY")


def find_trace(elasticsearch_url, run_id):
    query = {
        "size": 1,
        "_source": ["trace.id"],
        "query": {"bool": {"filter": [
            {"match_phrase": {"scenario.id": run_id}},
            {"match_phrase": {"service.name": "payments"}},
            {"range": {"event.duration": {"gte": 2_000_000_000}}},
        ]}},
    }
    status, result = request_json(f"{elasticsearch_url}/microservices-*/_search", "POST", query)
    expect(status, result, (200,))
    source = result["hits"]["hits"][0]["_source"]
    return source.get("trace.id") or source["trace"]["id"]


def action(run_id, session_id, sequence, action_type, details=None, state_after=None):
    return {
        "protocol_version": 1,
        "run_id": run_id,
        "session_id": session_id,
        "sequence": sequence,
        "type": action_type,
        "actor": "learner",
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "details": details or {},
        "state_before": {},
        "state_after": state_after or {},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--learning-url", default="http://localhost:8091")
    parser.add_argument("--elasticsearch-url", default="http://localhost:9200")
    parser.add_argument("--seed", type=int, default=20260822)
    args = parser.parse_args()
    learning = args.learning_url.rstrip("/")
    elasticsearch = args.elasticsearch_url.rstrip("/")

    status, created = request_json(f"{learning}/api/runs", "POST", {"scenario": "slow-payments", "seed": args.seed, "mode": "challenge"})
    expect(status, created)
    run_id = created["run"]["run_id"]
    session_id = created["session"]["session_id"]
    ready = wait_ready(learning, run_id)

    token = created["session"]["connection_token"]
    trace_id = find_trace(elasticsearch, run_id)
    actions = [
        action(run_id, session_id, 1, "time_range_changed", {"from": "now-10m", "to": "now"}, {"time_from": "now-10m"}),
        action(run_id, session_id, 2, "query_submitted", {"query": f'scenario.id: "{run_id}" and event.duration >= 2000000000'}),
        action(run_id, session_id, 3, "document_expanded", {"trace_id": trace_id}),
    ]
    for observed in actions:
        status, result = request_json(f"{learning}/api/sessions/{session_id}/actions", "POST", observed, token)
        expect(status, result)
        if result["evaluation"]["outcome"] != "accepted":
            raise RuntimeError(f"action was not accepted: {result}")

    answer = {
        "finding": "payments",
        "scope": "/checkout",
        "conclusion": "Payments latency is the bottleneck propagating through the checkout request.",
        "trace_id": trace_id,
        "evidence_refs": ["signal", "corroboration"],
        "evidence": "The payment transaction dominates the correlated checkout trace.",
    }
    status, feedback = request_json(f"{learning}/api/sessions/{session_id}/answer", "POST", answer, token)
    expect(status, feedback, (200,))
    if not feedback["diagnosis_correct"] or feedback["total"] != 100:
        raise RuntimeError(f"unexpected feedback: {feedback}")
    status, completed = request_json(f"{learning}/api/runs/{run_id}")
    expect(status, completed, (200,))
    if completed["state"] != "COMPLETED":
        raise RuntimeError(f"run did not complete: {completed}")
    status, cleaned = request_json(f"{learning}/api/runs/{run_id}", "DELETE")
    expect(status, cleaned, (200,))
    if not cleaned.get("aborted"):
        raise RuntimeError(f"run cleanup failed: {cleaned}")
    status, remaining = request_json(
        f"{elasticsearch}/microservices-*/_count?allow_no_indices=true",
        "POST",
        {"query": {"term": {"scenario.id.keyword": run_id}}},
    )
    expect(status, remaining, (200,))
    if remaining.get("count"):
        raise RuntimeError(f"run telemetry was not cleaned: {remaining}")
    validators = ready["evidence"].get("validators", {})
    print(json.dumps({"run_id": run_id, "ready_state": ready["state"], "final_state": completed["state"], "readiness": validators, "trace_id": trace_id, "score": feedback["total"], "cleaned": True}, indent=2))


if __name__ == "__main__":
    main()
