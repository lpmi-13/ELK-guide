# Adaptive Kibana learning lab

A self-contained Docker Compose curriculum, pinned to Elastic Stack 9.5.2, for production-style investigation and analysis in the Kibana UI. Its catalog contains 22 core scenarios across Discover/KQL, ES|QL, supplied dashboards, APM and traces, infrastructure metrics, and alert triage. Every scenario uses only free, open-source Basic-tier Kibana features — no Platinum, Enterprise, or subscription-gated surface is required. The original live `slow-payments` exercise remains available as a legacy pack.

The interactive experience runs directly in the learner's Kibana tab. A local same-origin gateway injects the coach runtime and proxies its authenticated learning WebSocket, so Chrome, Vivaldi, Firefox, and other modern browsers need no extension or other installation. Playwright is limited to headless reference recordings and compatibility checks; it is not a streamed learner browser. See [PLAN.md](PLAN.md) for the larger scenario catalog and delivery roadmap.

## What is implemented

- A catalog-driven launcher scoped to the server's active scenario track, with capability-aware scenario cards.
- Twenty-two core scenario packs, all using free Basic-tier Kibana features only.
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
- A controller-provisioned no-action alert rule, using only the alerting features available on the free Kibana 9.5.2 Basic license. Payment-gated surfaces (the APM service map, SLOs, and machine learning) are intentionally excluded so the lab runs entirely on free, open-source features.
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
./build-all.sh
```

The script builds and starts the stack in the background, waits for it to be ready, removes the Kibana Spaces and data left by earlier lab runs, then prints `Lab ready. Open http://localhost:8090/ in your browser.` If you prefer attached logs, `docker compose up --build` prints the same URL when the browser service starts.

Open <http://localhost:8090>, select a scenario, choose an assistance mode, accept or change the suggested scenario key, and start the run. A preparation tab opens immediately and moves into the connected Kibana investigation only after the run reaches `READY`; if the tab cannot be opened, the launcher reveals a manual fallback link. No manual Kibana content creation is required.

Learners may change ephemeral view state—time, queries, filters, controls, sorting, selections, and drilldowns—but every curriculum workflow is read-only with respect to saved Kibana content. Cluster administration, Dev Tools, content authoring, and system repair are outside the learner scope.

### Open the built-in learner experience

1. Open the launcher at <http://localhost:8090> and confirm its header says **built-in Kibana coach 1.0.0 ready**.
2. Choose an assistance mode and start a scenario. A preparation tab opens while its evidence becomes ready.
3. When readiness is confirmed, that tab continues into Kibana and automatically starts the assistance mode you chose.

The automatic handoff is scoped to the local Kibana gateway. Its session token is removed from the address bar before Kibana starts and retained only for reloads in that tab. Every mode opens with a production-style incident briefing before the first investigation step. The briefing varies its alert origin and incident age reproducibly with the scenario key, renders the raised time in the learner's local clock, and advances after 30 seconds or when **Begin** is selected. Guided practice keeps the briefing available through **Incident info** and omits the demonstration-only pause control. The coach always shows when automation is active, and **Stop** immediately disconnects it and forgets the handoff. Demonstration mode includes an **Advance** control that completes the reading pause on screen — the same effect as its countdown bar filling — or completes a value being typed before continuing the action. If pressed while the coach is acting, Advance waits for the action to finish and then continues past its learning card. The button shows that this request is queued and ignores further clicks until the action finishes. This also applies to a guided **Show me** walkthrough. The panel can be dragged by its header; it moves aside when it would cover the next highlighted control, a ringed result or an open flyout, and returns to the left when a new table column is shown as evidence. Every result card rings what it talks about, and a step that opens another page explains its result on that page. The demonstration injects the current scenario's finding, scope, query context, and expected evidence into its explanation, uses a 3× slower pace for reading and follow-up pauses while keeping cursor travel under 900 ms, types into form controls at a visible moderate pace, and ends with an evidence-and-conclusion summary. When a guided learner's change leaves the step unanswerable (a search with no results, an earned filter removed, or a window that no longer reaches the incident) the coach says why at once — naming a mistyped query such as `field is 503` and offering **Fix my query** — and restores the search if they don't. Wandering off the expected path is recorded silently; once a step has taken longer than its budget (at least 45 s of active time) the coach checks in gently with **Keep going**, **Give me a hint** or **Show me**, which never affects the score. Guided practice opens a debrief automatically after the last investigation step. It reports how many steps were completed without help, how often hints were requested, and how often **Show me** was used, with an unscored line per step for its time, check-ins and dead ends. Challenge retains the learner answer form and evidence-based score, and lists the dead ends and detours it recorded.

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

Run states follow `CREATED → ACTIVATING → WARMING → READY → INVESTIGATING → COMPLETED`, with `FAILED` and `ABORTED` terminal branches. Runs live only in the scenario controller's memory, so when it starts, and again each time `./build-all.sh` runs (`POST /api/orphans/reclaim` on the controller), it removes everything left by runs it no longer knows: their Spaces, their indices, aliases and data streams, and any fault a service still holds for them. Live runs are never touched (set `RECLAIM_ORPHANED_RUNS=false` to keep the leftovers). A run stopped while it is still being prepared does no further preparation steps, and is cleaned up again once the step in flight returns. The controller forgets an ended run (completed, aborted or failed), and its manifest file, `COMPLETED_RETENTION_SECONDS` (600) after it ends; the learning service drops a session that has been idle for `SESSION_RETENTION_SECONDS` (8 hours) with no coach connected. Kibana's own event log (its background-task and rule history, not lab data) is kept for `KIBANA_EVENT_LOG_RETENTION` (7 days, re-applied each time the controller starts) instead of Kibana's default 90 days. A Kibana tab still open on a forgotten run or session says its session has ended and links back to the launcher. Reset deletes the prior Space and run data, clears its fault, and creates a new isolated run ID:

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

The [local test plan](LOCAL_TEST_PLAN.md) sets out what end-to-end confidence requires; the checks below implement it, cheapest first.

**Without Docker.** The dependency-free suite checks pack contracts, selector parity, manifests, run isolation, goal alternatives, scoring, all 66 core scenario-mode combinations, the learning service's protocol (every WebSocket and REST variant, sampled from the real server code), public wording, and the session-ending paths of the real HTTP/WebSocket server:

```sh
python -m unittest discover -s tests -v
python scripts/validate-scenarios.py
python scripts/test-scenario-matrix.py --all
python scripts/generate-saved-objects.py --check
docker compose config -q
```

The coach's own tests and its protocol type check need Node 22 and, once, `npm ci` in `kibana-coach/`:

```sh
cd kibana-coach && npm ci
npm test                  # unit tests, including failed and delayed Kibana actions
npm run check:protocol    # samples from learning-service/server.py vs protocol/protocol.d.ts, and the coach's JSDoc
```

`check:protocol` regenerates `kibana-coach/protocol/generated/samples.ts` with `scripts/generate-protocol-samples.py`, then type-checks it and the coach against the strict declaration in `kibana-coach/protocol/protocol.d.ts`: a renamed or extra field, a wrong null, or a message variant the declaration or the coach lacks fails before any live run. Change the server, the declaration and the coach together. When TypeScript is installed, the Python suite runs this check too.

The dashboards and their Lens panels in `kibana/saved-objects.ndjson` are generated: edit them in `scripts/generate-saved-objects.py` and run it (no arguments) to rewrite the file.

**With the stack running.** Exercise the converted live investigation end to end, then provision every capability-available core pack and check that its fault really exists: declared readiness, decisive truth assertions in Elasticsearch, another variant's evidence absent, a representative distractor answer graded wrong and the run's own answer right. Parameterized packs run once per parameter choice, with fixed scenario keys. `--replay` adds the replay contract (a repeated key reproduces the incident in a new run and Space; a rejected replay leaves the run alone; a completed session's feedback survives a replay):

```sh
python tests/live_smoke.py
python tests/live_scenario_matrix.py --track mvp --replay        # the MVP packs, every variant
python tests/live_scenario_matrix.py --all --isolation --replay   # every available core pack
```

**In a browser.** `scenario-recorder/coach-audit.mjs` starts each case from the launcher, lets the built-in coach operate Kibana, and checks what a learner sees: every declared action visibly performed and then shown, the card off the control, rings, flyouts and notices, the pointer in view, the debrief matching the run's manifest (and dismissable and reopenable), and the controller run `COMPLETED`. It never drives the coach itself and never submits the reference answer. Each case writes `recordings/audit/<time>/<case>/` (summary, events, step screenshots; a DOM snapshot and trace on failure). It uses Playwright from `npm ci` in `scenario-recorder/`; `PW_CHANNEL=chrome` uses an installed Chrome instead of downloading Playwright's:

```sh
cd scenario-recorder && npm ci
PW_CHANNEL=chrome node coach-audit.mjs --mvp --mode demonstration --mode guided --mode challenge   # the first gate: both viewports, normal and Advance speed
PW_CHANNEL=chrome node coach-audit.mjs --mvp --case robustness --case recovery --case replay       # Pause/Advance/hidden tab/reload/outage/expired session; guided dead ends; tabs and keys
PW_CHANNEL=chrome node coach-audit.mjs --all --surface dashboard                                   # the manual catalog sweep, one surface at a time
```

The launcher lists only the MVP track; set `SCENARIO_TRACK=all` in `.env` (and recreate `scenario-controller`) to start every pack from it. Without that, the sweep starts other packs through the same API call and handoff the launcher makes, and notes it.

For a full smoke test, follow startup and ingestion with:

```sh
docker compose logs -f scenario-controller learning-service logstash
curl -sS 'http://localhost:9200/microservices-*/_count?pretty'
```

Stop the lab with `docker compose down`. Logstash keeps service-log read positions in the `logstash-state` named volume, so the next start skips logs it has already ingested. The seeder replaces its previous batch in `seed.json`; Logstash reads that small file from the beginning on each container start. Add `--volumes` only when you intentionally want to delete Elasticsearch data, generated service logs, and Logstash's read positions together.

The five application logs each keep a 100 MiB active file and one backup. Browser telemetry, the scenario controller, and the learning service each keep a 10 MiB active file and one backup. With the default 500-event seed batch, these files use roughly 1.1 GB at most, apart from unusually large single events. Rotated backups are outside Logstash's input pattern, so events can be lost if Logstash stays behind through a rollover. The `logstash-state` volume is expected to stay small, but it has no fixed byte quota.

This stack disables authentication and uses development-sized JVM heaps. It is designed for a local, single-learner lab—not for production or untrusted networks.

## Maintainer references

- [Scenario pack guide](docs/SCENARIO_PACK_GUIDE.md)
- [Kibana 9.5.2 compatibility baseline](docs/KIBANA_9_5_COMPATIBILITY.md)
- [Semantic command and observation reference](docs/SEMANTIC_ACTIONS.md)
- [Validator reference](docs/VALIDATORS.md)
- [Selector maintenance](docs/SELECTOR_MAINTENANCE.md)
- [Fixture generation](docs/FIXTURE_GENERATION.md)
