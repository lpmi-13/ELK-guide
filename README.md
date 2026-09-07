# Adaptive Kibana learning lab

A self-contained Docker Compose curriculum, pinned to Elastic Stack 9.5.2, for production-style investigation and analysis in the Kibana UI. Its catalog contains 24 core scenarios across Discover/KQL, ES|QL, supplied dashboards, APM and traces, infrastructure metrics, alert triage, and SLO interpretation, plus three capability-gated extensions. The original live `slow-payments` exercise remains available as a legacy pack.

The interactive experience runs directly in the learner's Kibana tab. A local same-origin gateway injects the coach runtime and proxies its authenticated learning WebSocket, so Chrome, Vivaldi, Firefox, and other modern browsers need no extension or other installation. Playwright is limited to headless reference recordings and compatibility checks; it is not a streamed learner browser. See [PLAN.md](PLAN.md) for the larger scenario catalog and delivery roadmap.

## What is implemented

- A catalog-driven launcher with surface, skill, difficulty, signal, and scenario-type filters.
- Twenty-four core and three capability-gated extension scenario packs.
- Generic v2 scenario, goal-graph, command/observation, rubric, and run-manifest contracts.
- Per-run Kibana Spaces, Space-local saved objects, deterministic seeded telemetry, and cleanup.
- Concurrent run state with isolated live fault configurations.
- Runtime fault APIs on every microservice: `POST`, `GET`, and `DELETE /_control/fault`/`/_control/state`.
- A real gateway → orders → payments checkout path with shared scenario, trace, transaction, span, and parent IDs.
- Targeted incident traffic plus bounded background noise.
- Reusable declared readiness validators for indexed evidence and managed Kibana resources.
- Automatic Kibana data-view, Discover search, and overview-dashboard provisioning.
- Demonstration, guided-practice, and challenge policies driven by one goal graph per scenario.
- Automatic authenticated WebSocket handoff from the launcher to Kibana, plus an immediate visible stop control.
- Application-specific Kibana adapters, normalized observations, alternative-path validation, flexible answers, and scenario-type scoring.
- A controller-provisioned no-action alert rule and read-only SLO lifecycle, gated by runtime capability and license probes. Kibana 9.5.2 Basic enables alerting but gates the APM service map and SLO API behind Platinum or higher.
- Separate `tutorial-*` and `scenario-*` indices so learning/control telemetry does not contaminate `microservices-*` evidence.
- A profile-gated Playwright recorder with video metadata and failure screenshots/DOM snapshots.

## Architecture

| Component | Purpose | Host port |
| --- | --- | --- |
| Elasticsearch | Stores incident, tutorial, and control events | `9200` |
| Logstash | Tails JSON events and routes them by dataset | `5044`, `9600` |
| Kibana | Provisioned investigation surface behind the gateway | internal `5601` |
| Kibana gateway | Serves Kibana with the built-in coach runtime | `5601` |
| API gateway | Calls auth, catalog, and orders | `8080` |
| Auth | Simulates identity work | internal `8081` |
| Catalog | Simulates product work | internal `8082` |
| Orders | Calls catalog and payments | internal `8083` |
| Payments | Receives the initial latency fault | internal `8084` |
| Scenario controller | Activates faults, generates traffic, and gates readiness | internal `8092` |
| Learning service | Owns sessions, semantic commands, validation, and debriefs | `8091` |
| Lab launcher | Starts runs, shows readiness, opens the connected Kibana session, and reports telemetry state | `8090` |

The scenario controller writes an immutable manifest for every run. The launcher turns a 10–40 character scenario key into the manifest's numeric seed; reusing the exact key reproduces the allowed variation, while a unique run ID prevents historical evidence from leaking into a replay. The launcher generates clean three-word examples, but user-entered keys may contain any characters. Existing automation can continue to supply numeric seeds directly.

## Run the lab

Docker Engine with Compose v2 and roughly 3 GB of available memory are required.

```sh
cp .env.example .env
docker compose up --build -d
docker compose ps
```

Open <http://localhost:8090>, filter and select a scenario, choose an assistance mode, accept or change the suggested scenario key, and start the run. The launcher shows evidence progress and enables the Kibana link only after the run reaches `READY`. No manual Kibana content creation is required.

Learners may change ephemeral view state—time, queries, filters, controls, sorting, selections, and drilldowns—but every curriculum workflow is read-only with respect to saved Kibana content. Cluster administration, Dev Tools, content authoring, and system repair are outside the learner scope.

### Open the built-in learner experience

1. Open the launcher at <http://localhost:8090> and confirm its header says **built-in Kibana coach 1.0.0 ready**.
2. Choose an assistance mode, start a scenario, and wait for its evidence to become ready.
3. Select **Open the ready investigation in Kibana**. The new tab connects automatically and immediately starts the assistance mode you chose.

The automatic handoff is scoped to the local Kibana gateway. Its session token is removed from the address bar before Kibana starts and retained only for reloads in that tab. The coach always shows when automation is active, and **Stop** immediately disconnects it and forgets the handoff. Demonstration mode explains the action and its reasoning, positions the coach away from each active target, uses extended reading and follow-up pauses while keeping cursor travel under 900 ms, types into form controls at a visible moderate pace, and ends with an evidence-and-conclusion summary. Guided and challenge modes retain the learner diagnosis form and observe the learner's normalized Kibana actions.

The lab suppresses Kibana's insecure-cluster and public-URL warnings, plus the Discover first-run tour callouts.

## Reproduce or reset a run

Set the default startup scenario in `.env`:

```dotenv
SCENARIO=slow-payments
SCENARIO_SEED=20260822
SCENARIO_AUTO_START=true
```

The launcher suggests a fresh three-word key, but accepts any string from 10 to 40 characters. Reuse an exact key to replay the same scenario parameters, or choose **New key** for a fresh variation. The HTTP entry point accepts either `scenario_key` or a numeric `seed`:

```sh
curl -sS http://localhost:8091/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"deployment-version-regression","scenario_key":"quiet-river-signal","mode":"guided"}'
```

Poll the returned run ID until its state is `READY`:

```sh
curl -sS http://localhost:8091/api/runs/RUN_ID
```

Run states follow `CREATED → ACTIVATING → WARMING → READY → INVESTIGATING → COMPLETED`, with `FAILED` and `ABORTED` terminal branches. Reset deletes the prior Space and run data, clears its fault, and creates a new isolated run ID:

```sh
curl -sS -X POST http://localhost:8091/api/runs/RUN_ID/reset \
  -H 'Content-Type: application/json' \
  -d '{"scenario_key":"quiet-river-signal","mode":"guided"}'
```

## Inspect the evidence

Useful KQL expressions include:

```text
scenario.id: "RUN_ID"
scenario.id: "RUN_ID" and event.duration >= 2000000000
scenario.id: "RUN_ID" and service.name: "payments"
trace.id: "TRACE_ID"
```

Durations use ECS nanoseconds. Incident documents include local transactions and outbound spans, so upstream duration includes time spent waiting for downstream services. Tutorial actions live under `tutorial-*`; scenario lifecycle events live under `scenario-*`.

## Headless reference recording

The optional recording profile waits on the same readiness checkpoint and replays the shared semantic targets in a fixed Chromium environment:

```sh
docker compose --profile recording run --rm scenario-recorder
```

Set `SCENARIO=<catalog-id>` to record another available pack.

Output is written to `recordings/` as a WebM video plus a JSON sidecar containing the run, seed, playbook, Kibana/Playwright versions, viewport, locale, timezone, timestamps, and outcome. Selector failures additionally capture a screenshot and DOM snapshot.

## Verify locally

The dependency-free suite checks pack contracts, selector parity, manifests, run isolation, goal alternatives, scoring, and all 72 core scenario-mode combinations:

```sh
python -m unittest discover -s tests -v
python scripts/validate-scenarios.py
python scripts/test-scenario-matrix.py --all
docker compose config -q
```

With the stack running, exercise the converted live investigation end to end, then provision and clean every capability-available core pack:

```sh
python tests/live_smoke.py
python tests/live_scenario_matrix.py --all --isolation
```

For a full smoke test, follow startup and ingestion with:

```sh
docker compose logs -f scenario-controller learning-service logstash
curl -sS 'http://localhost:9200/microservices-*/_count?pretty'
```

Stop the lab with `docker compose down`. Add `--volumes` only when you intentionally want to delete Elasticsearch data and generated service logs.

This stack disables authentication and uses development-sized JVM heaps. It is designed for a local, single-learner lab—not for production or untrusted networks.

## Maintainer references

- [Scenario pack guide](docs/SCENARIO_PACK_GUIDE.md)
- [Kibana 9.5.2 compatibility baseline](docs/KIBANA_9_5_COMPATIBILITY.md)
- [Semantic command and observation reference](docs/SEMANTIC_ACTIONS.md)
- [Validator reference](docs/VALIDATORS.md)
- [Selector maintenance](docs/SELECTOR_MAINTENANCE.md)
- [Fixture generation](docs/FIXTURE_GENERATION.md)
