# Adaptive Kibana incident lab

A self-contained Docker Compose lab that turns a five-service request path into a reproducible Kibana investigation. The initial `slow-payments` scenario injects real latency into checkout calls, generates correlated transactions and downstream spans, waits for Elasticsearch evidence, and then guides or observes the learner in Kibana.

The interactive experience runs in the learner's explicitly opted-in Kibana tab through the extension in `browser-extension/`. Playwright is limited to headless reference recordings and selector compatibility checks; it is not a streamed learner browser. See [PLAN.md](PLAN.md) for the larger scenario catalog and delivery roadmap.

## What is implemented

- A seeded slow-payments scenario with a unique run ID.
- Runtime fault APIs on every microservice: `POST`, `GET`, and `DELETE /_control/fault`/`/_control/state`.
- A real gateway → orders → payments checkout path with shared scenario, trace, transaction, span, and parent IDs.
- Targeted incident traffic plus bounded background noise.
- An Elasticsearch readiness predicate requiring ten affected payment traces before `READY`.
- Automatic Kibana data-view, Discover search, and overview-dashboard provisioning.
- Demonstration, guided-practice, and challenge policies driven by one semantic playbook.
- Short-lived, single-controller browser pairing and an immediate visible stop control.
- Normalized investigation actions, state/evidence validation, structured diagnosis submission, and component scoring.
- Separate `tutorial-*` and `scenario-*` indices so learning/control telemetry does not contaminate `microservices-*` evidence.
- A profile-gated Playwright recorder with video metadata and failure screenshots/DOM snapshots.

## Architecture

| Component | Purpose | Host port |
| --- | --- | --- |
| Elasticsearch | Stores incident, tutorial, and control events | `9200` |
| Logstash | Tails JSON events and routes them by dataset | `5044`, `9600` |
| Kibana | Provisioned investigation surface | `5601` |
| API gateway | Calls auth, catalog, and orders | `8080` |
| Auth | Simulates identity work | internal `8081` |
| Catalog | Simulates product work | internal `8082` |
| Orders | Calls catalog and payments | internal `8083` |
| Payments | Receives the initial latency fault | internal `8084` |
| Scenario controller | Activates faults, generates traffic, and gates readiness | internal `8092` |
| Learning service | Owns sessions, semantic commands, validation, and debriefs | `8091` |
| Lab launcher | Starts runs, shows readiness, pairing details, and telemetry state | `8090` |

The scenario controller writes an immutable manifest for every run. The launcher turns a memorable three-word scenario key into the manifest's numeric seed; reusing the key reproduces the allowed variation, while a unique run ID prevents historical evidence from leaking into a replay. Existing automation can continue to supply numeric seeds directly.

## Run the lab

Docker Engine with Compose v2 and roughly 3 GB of available memory are required.

```sh
cp .env.example .env
docker compose up --build -d
docker compose ps
```

Open <http://localhost:8090>, choose an assistance mode, accept or change the suggested scenario key, and activate the incident. The launcher shows evidence progress and enables the Kibana link only after the run reaches `READY`. No manual Kibana data-view creation is required.

### Install and pair the learner extension

The local prototype is an unpacked Manifest V3 extension:

1. Open your browser's extension-management page and enable developer mode.
2. Choose **Load unpacked** and select this repository's `browser-extension/` directory.
3. Open the ready investigation link from the launcher in its own Kibana tab.
4. Click the extension and enter the session ID and six-digit code shown by the launcher.

Pairing is scoped to the configured local Kibana and learning-service origins. The coach always shows when automation is active, and **Stop** immediately disconnects it. Demonstration mode performs semantic actions visibly; guided and challenge modes observe the learner's normalized Kibana actions.

## Reproduce or reset a run

Set the default startup scenario in `.env`:

```dotenv
SCENARIO=slow-payments
SCENARIO_SEED=20260822
SCENARIO_AUTO_START=true
```

The launcher suggests a fresh three-word key. Reuse a key to replay the same incident parameters, or choose **New key** for a fresh variation. The HTTP entry point accepts either `scenario_key` or the existing numeric `seed`:

```sh
curl -sS http://localhost:8091/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"slow-payments","scenario_key":"quiet-river-signal","mode":"guided"}'
```

Poll the returned run ID until its state is `READY`:

```sh
curl -sS http://localhost:8091/api/runs/RUN_ID
```

Run states follow `CREATED → ACTIVATING → WARMING → READY → INVESTIGATING → COMPLETED`, with `FAILED` and `ABORTED` terminal branches. Reset creates a new run ID, clears the previous fault, and retains old documents safely:

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

Output is written to `recordings/` as a WebM video plus a JSON sidecar containing the run, seed, playbook, Kibana/Playwright versions, viewport, locale, timezone, timestamps, and outcome. Selector failures additionally capture a screenshot and DOM snapshot.

## Verify locally

The dependency-free unit suite checks fixtures, selector parity, seeded manifests, fault validation, goal equivalence, and scoring:

```sh
python -m unittest discover -s tests -v
docker compose config -q
```

With the stack running, exercise run creation, readiness, pairing, all five goals, diagnosis, and debrief:

```sh
python tests/live_smoke.py
```

For a full smoke test, follow startup and ingestion with:

```sh
docker compose logs -f scenario-controller learning-service logstash
curl -sS 'http://localhost:9200/microservices-*/_count?pretty'
```

Stop the lab with `docker compose down`. Add `--volumes` only when you intentionally want to delete Elasticsearch data and generated service logs.

This stack disables authentication and uses development-sized JVM heaps. It is designed for a local, single-learner lab—not for production or untrusted networks.
