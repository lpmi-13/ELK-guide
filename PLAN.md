# Adaptive Kibana Incident-Learning System Plan

This project should evolve into an **interactive incident lab**, rather than merely adding cursor animation to the current dashboard.

The system should:

1. Select and activate an authentic failure scenario.
2. Generate realistic traffic, logs, and traces affected by that failure.
3. Wait until Elasticsearch has ingested enough evidence.
4. Open a known, provisioned Kibana view.
5. Guide the learner through a deterministic investigation.
6. Confirm that each investigative step produced the expected result.
7. Explain the diagnosis and optionally let the learner try again independently.

The important distinction is that the tutorial should be driven by the **state of the incident and Kibana**, not by a fixed sequence of screen coordinates.

## 1. Current Foundation

The project already has several useful building blocks:

- Five services with gateway-to-service and service-to-service dependencies are available for injecting failures at different points in a request path. For example, the gateway calls auth, catalog, and orders, while orders calls catalog and payments.
- Services already propagate a shared trace identifier across downstream requests, which provides the foundation for moving from a slow log entry to the rest of the request flow.
- The telemetry workspace already detects when Kibana loads and sends browser activity over a WebSocket.
- The telemetry server already supports bidirectional messages, which can evolve from simple acknowledgements into commands such as `start_tour`, `advance_step`, and `pause_tour`.
- Logstash currently sends all structured service and browser events into the same daily index family, making it possible to correlate scenario, application, and tutorial activity by scenario or session identifiers.

That said, the current browser workspace cannot inspect or operate Kibana's internal DOM because Kibana is inside a cross-origin iframe. It can infer that the user entered or focused the dashboard, but it cannot reliably find Kibana controls, type a KQL query, or verify the selected time range.

Resolving that boundary is the first architectural decision.

## 2. Recommended Architecture

I recommend adding four logical capabilities.

### A. Scenario Controller

Add a dedicated `scenario-controller` service responsible for selecting, activating, observing, and eventually stopping a scenario.

A scenario definition could look like this:

```yaml
id: slow-payments
title: Checkout requests are suddenly slow
difficulty: beginner

fault:
  service: payments
  type: latency
  delay_ms: 3500
  probability: 0.85
  endpoints:
    - /checkout

traffic:
  entrypoint: api-gateway
  path: /checkout
  requests_per_second: 3

evidence:
  warmup_seconds: 30
  expected_service: payments
  expected_log_level: WARN
  expected_min_duration_ms: 3000

tutorial:
  playbook: slow-service-investigation
```

At startup, the controller would:

1. Load all scenario definitions.
2. Choose one randomly.
3. Create a unique `scenario.id`.
4. Tell the selected service to activate its fault.
5. Start targeted traffic through the API gateway.
6. Wait for enough evidence to appear in Elasticsearch.
7. Publish `scenario_ready`.
8. Tell the browser tutorial that it can begin.

#### Reproducibility

Random scenarios should still be reproducible.

Support environment variables such as:

```dotenv
SCENARIO=random
SCENARIO_SEED=20260822
SCENARIO_AUTO_START=true
```

The chosen scenario, random seed, start time, and expected diagnosis should be written to logs. That permits an instructor to reproduce a learner's exact run.

### B. Runtime Fault Injection

The microservices currently generate generic traffic, but they do not expose runtime controls for realistic scenarios. The server presently treats `/error` as an error and all other requests as successful, while background activity is chosen randomly.

Add a small internal control API to every service:

```text
POST /_control/fault
DELETE /_control/fault
GET /_control/state
```

Example activation payload:

```json
{
  "scenario_id": "scenario-7c9812",
  "fault": "latency",
  "delay_ms": 3500,
  "probability": 0.85,
  "paths": ["/checkout"]
}
```

The following initial fault types would provide good investigative variety:

| Fault | Observable symptoms | Likely investigation |
| --- | --- | --- |
| Service latency | High request duration and downstream latency | Time range → duration filter → service → trace |
| Elevated 5xx errors | Error-rate spike | Status filter → service grouping → error details |
| Dependency unavailable | Timeouts and connection failures | Gateway errors → destination → downstream service |
| Database slowdown | Slow spans with otherwise successful HTTP responses | Duration → event type → trace waterfall |
| Cache failure | Higher latency and cache-miss warnings | Compare before/after period and filter event action |
| Authentication rejection | Increased 401/403 responses | Status → endpoint → auth service |
| Queue backlog | Growing processing lag | Time series → lag field → worker/service |
| Memory pressure | Periodic pauses or simulated restarts | Host/service metrics and restart logs |

For authenticity, faults should affect the actual request path rather than merely producing fabricated error messages. A latency scenario should really sleep before responding, causing the caller's measured duration to increase and potentially triggering upstream timeouts.

### C. Kibana Provisioning

The autonomous guide must always know what page and controls exist. Requiring the learner to manually create a data view makes automation fragile.

Add a `kibana-setup` initialization container that waits for Kibana and imports version-controlled saved objects:

```text
kibana/
├── saved-objects.ndjson
├── setup.sh
└── dashboards/
    ├── incident-overview.ndjson
    ├── service-health.ndjson
    └── trace-investigation.ndjson
```

Provision at least:

- A `microservices-*` data view.
- An incident overview dashboard.
- A log exploration or Discover saved search.
- Visualizations for:
  - request duration percentiles;
  - error rate over time;
  - events grouped by `service.name`;
  - slowest endpoints;
  - most common error types;
  - active scenario markers.
- A saved investigation starting point with a predictable URL.

Every scenario should identify:

- its initial saved view;
- the expected time window;
- the query to isolate the symptom;
- the field/value pair identifying the responsible service;
- the trace identifier or evidence the learner should eventually inspect.

This gives the tutorial a stable contract and prevents arbitrary Kibana landing-page differences from breaking it.

### D. Tutorial Orchestrator

The tutorial should be represented as data, not hard-coded browser actions.

For example:

```yaml
id: slow-service-investigation
starting_view: incident-overview

steps:
  - id: notice-latency-spike
    narration: >
      Request duration increased recently. First narrow the time range
      around the spike.
    target: kibana.time_picker
    action: set_time_range
    value: now-10m
    validation:
      type: kibana_state
      time_from: now-10m

  - id: find-slowest-service
    narration: >
      Filter for requests taking more than two seconds.
    target: kibana.query_bar
    action: enter_query
    value: event.duration >= 2000000000
    validation:
      type: elasticsearch_count
      minimum: 1

  - id: isolate-payments
    narration: >
      Payments has the largest duration. Add it as a service filter.
    target:
      field: service.name
      value_from: scenario.expected_service
    action: add_filter
    validation:
      type: kibana_filter
      field: service.name
      value: payments

  - id: inspect-trace
    narration: >
      Open one slow event and use its trace ID to inspect the full request.
    target: kibana.first_result
    action: expand_row
    validation:
      type: selected_trace
      scenario_id: current

  - id: diagnosis
    narration: >
      The payments service added approximately 3.5 seconds to checkout.
      This caused upstream order requests to slow down.
    action: explain
```

This structure lets the same browser runner execute multiple incident tutorials without custom code for each one.

## 3. Browser Ownership and Cursor Control

The tutorial engine should not be coupled to one browser-control technique. It should issue semantic commands such as `set_time_range`, `enter_query`, `add_filter`, and `open_trace`. A browser adapter resolves those commands into the controls for the pinned Kibana version.

Two adapters are useful, but only one is a learner-facing experience.

### Headless Recording and Verification Adapter

A dedicated `scenario-recorder` uses Playwright to launch Chromium, opens Kibana directly, and replays a materialized scenario and playbook without presenting that browser as the learner interface.

This provides:

- reliable DOM selectors;
- real pointer and keyboard events;
- visibility and focus checks;
- screenshots and DOM snapshots on failure;
- a controlled Kibana version and viewport;
- deterministic control of the time picker, query bar, filters, and result rows;
- headless video capture for a specific scenario template, seed, playbook, and assistance mode;
- automated regression evidence that the provisioned Kibana UI still supports each semantic command.

Playwright recordings can be used as instructor previews, reference demonstrations, documentation assets, and CI artifacts. Each recording should carry metadata for the scenario template version, seed, generated run ID, playbook version, Kibana version, viewport, and recording timestamp so it can be reproduced.

Use a fixed viewport, locale, timezone, color scheme, animation policy, and known data-ready checkpoint before recording. Video generation must run only after the scenario readiness predicates pass; fixed sleeps would produce blank searches or misleading timelines.

This adapter is not a noVNC or streamed-browser product mode. Learners should not be asked to interact with the Playwright-owned browser.

### Learner Browser Adapter

This is the primary interactive path. A local gateway serves Kibana and injects the versioned coach runtime as same-origin scripts. The same gateway proxies the authenticated learning WebSocket, so the browser requires no extension, userscript, or remote-debugging access.

The injected coach should:

1. Treat opening the launcher-generated Kibana URL as opt-in for that tab.
2. Consume the session-scoped token from the URL and remove it before Kibana starts.
3. Open an outbound authenticated WebSocket to the session service.
4. Resolve semantic targets in the Kibana DOM.
5. Draw the tutorial cursor, spotlight, hints, toasts, and panels.
6. Perform clicks and typing only in demonstration mode.
7. Observe and normalize learner actions in guided and challenge modes.
8. Show a persistent "automation active" indicator and an immediate stop-control button.

The service should send semantic commands, never screen coordinates. Example:

```json
{
  "command_id": "cmd-018",
  "type": "enter_query",
  "target": "kibana.query_bar",
  "value": "event.duration >= 2000000000",
  "expected_page": "discover",
  "mode": "demonstrate"
}
```

The coach should acknowledge `started`, `completed`, or `failed` and return the observed post-action state. Commands must be idempotent so reconnecting a session cannot type a query twice or add duplicate filters.

Do not expose a remote-debugging port from the learner's everyday browser. Opening the launcher-generated URL is the explicit opt-in boundary, and the persistent coach panel and stop control keep automation visible.

### Recommendation

Build the semantic command protocol and the **injected Kibana coach adapter first**. It is the product surface for demonstrations, guided practice, and challenge mode. Retain a smaller **headless Playwright adapter** solely to replay the same semantic playbooks for video production and automated compatibility checks. Both adapters should share target selectors and validation contracts, but Playwright does not need the learner session handoff, take-control, accessibility-overlay, or scoring UI.

## 4. Cursor and Narration UX

The cursor should teach rather than merely perform actions.

Each step should have four phases:

1. **Orient**  
   Dim unrelated areas and show a short explanation.

2. **Demonstrate**  
   Move a clearly visible tutorial cursor to the target over approximately 500–900 ms.

3. **Act or invite**  
   Either:
   - automatically click/type in "demonstration mode"; or
   - pause and ask the learner to perform the action in "guided mode."

4. **Validate**  
   Confirm the expected Kibana or Elasticsearch state before continuing.

Recommended controls:

- Pause/resume.
- Replay step.
- Previous/next step.
- "Let me do it" toggle.
- "Why are we doing this?" explanation.
- Skip tutorial and investigate independently.
- Reset scenario.
- Show final root cause only after the investigation.
- Reduced-motion mode.
- Keyboard-accessible alternatives to pointer animation.

The tutorial should avoid instantly entering a complete diagnostic query. A useful learning sequence is:

1. Observe the symptom.
2. Narrow the time range.
3. Filter by slow duration or error status.
4. Group or filter by service.
5. Inspect an individual event.
6. Pivot using `trace.id`.
7. Compare upstream and downstream timings.
8. Formulate the diagnosis.

## 5. Scenario Lifecycle

A robust startup sequence would be:

```text
Elasticsearch healthy
        ↓
Kibana healthy
        ↓
Kibana saved objects imported
        ↓
Microservices healthy
        ↓
Scenario selected and recorded
        ↓
Fault activated
        ↓
Targeted traffic begins
        ↓
Scenario controller queries Elasticsearch
        ↓
Minimum evidence threshold reached
        ↓
Browser/tutorial becomes available
        ↓
Learner loads the incident workspace
        ↓
Learner browser automatically connects to learning session
        ↓
Investigation steps are validated
        ↓
Diagnosis and remediation explained
        ↓
Fault disabled and scenario can reset
```

The "minimum evidence threshold" matters. The tour should not say "click the spike" before Logstash has indexed a visible spike.

For a slow endpoint scenario, readiness might require:

```json
{
  "scenario.id": "scenario-7c9812",
  "service.name": "payments",
  "event.duration": {
    "gte": 3000000000
  },
  "minimum_matching_events": 10
}
```

## 6. Event Model Improvements

Every event related to an active exercise should carry:

```json
{
  "scenario.id": "scenario-7c9812",
  "scenario.name": "slow-payments",
  "scenario.phase": "active",
  "trace.id": "…",
  "transaction.id": "…",
  "service.name": "payments",
  "event.duration": 3512000000
}
```

Browser tutorial events should additionally include:

```json
{
  "tutorial.id": "slow-service-investigation",
  "tutorial.step.id": "isolate-payments",
  "tutorial.mode": "guided",
  "tutorial.outcome": "completed",
  "session.id": "…"
}
```

The current telemetry collector already records session, action, viewport, client address, and URL fields, so it can be extended rather than replaced.

This creates three useful categories of observability:

1. **System telemetry** — what the simulated services did.
2. **Scenario telemetry** — what fault was active and when.
3. **Learning telemetry** — what step the learner reached or struggled with.

Tutorial telemetry should be stored separately or clearly marked so it does not contaminate the incident being investigated. Although all data can still reside in `microservices-*`, a dedicated `tutorial-*` index or data stream would make filtering safer.

## 7. Validation Strategy

Avoid validating progress solely from mouse clicks. A click does not prove that the desired investigation state was reached.

Use layered validation.

### Browser-State Validation

Examples:

- Is the time picker set to the expected range?
- Does the KQL bar contain the intended expression?
- Is the `service.name` filter pill present?
- Is an event row expanded?
- Is the trace identifier visible?

### Elasticsearch Validation

Examples:

- Does the current query return active-scenario events?
- Are at least ten slow payment events present?
- Does the selected trace contain gateway, orders, and payments events?
- Is the payment duration the dominant contributor?

### Scenario Validation

Examples:

- Is the intended fault still active?
- Is traffic still flowing?
- Has the scenario accidentally healed?
- Did another random failure obscure the intended signal?

The tutorial should only advance when the relevant state is satisfied.

## 8. Authenticity Requirements

To feel like a real incident rather than a canned animation:

- Normal background noise must continue.
- The faulty service should not be explicitly named at the start.
- Several services should emit plausible but irrelevant warnings.
- The incident should emerge after a baseline period.
- The fault should affect upstream timings.
- Shared trace identifiers should connect the affected services.
- The answer should be discoverable through evidence, not hidden metadata.
- The same scenario should vary slightly in timing, affected endpoint, and event volume.
- Random variation should not alter the fundamental expected diagnosis.
- The final explanation should cite the evidence the learner found.

For example:

> Checkout latency increased at 14:32. Requests through `api-gateway` and `orders` were slow, but their local work remained short. The shared traces show approximately 3.5 seconds spent waiting for `payments`, identifying the payment dependency as the bottleneck.

## 9. Suggested Implementation Phases

### Phase 1 — Deterministic Vertical Slice

Implement one scenario only:

- `slow-payments`;
- fault-control endpoint;
- targeted checkout traffic;
- `scenario.id` propagation;
- Kibana saved data view and dashboard;
- one semantic playbook executed in the learner's Kibana tab by the built-in coach adapter;
- a five-step investigation that can demonstrate actions or wait for the learner;
- normalized learner-action telemetry;
- a structured diagnosis submission and basic evidence-based debrief;
- one reproducible headless Playwright recording of the same scenario as a reference artifact.

This proves the entire architecture before introducing randomness.

### Phase 2 — Scenario Framework

- YAML/JSON scenario definitions.
- Random selection with reproducible seed.
- Scenario lifecycle API.
- Evidence-readiness queries.
- Reset and replay.
- Two additional scenarios:
  - elevated auth failures;
  - catalog dependency unavailable.

### Phase 3 — Learning Modes

- Fully automatic demonstration.
- Guided learner-controlled mode with progressive hints.
- Independent challenge mode with on-demand help.
- Shared step validation across all browser adapters.
- Reference-path scoring and evidence-based feedback.
- Accessibility and reduced motion.
- Progress telemetry.

### Phase 4 — Richer Observability

- Proper OpenTelemetry traces.
- Trace-to-log correlation.
- Metrics such as error rate and latency percentiles.
- Service maps.
- Multi-signal investigations.
- Optional APM integration.

### Phase 5 — Resilience

- Kibana selector compatibility tests.
- Version-pinned dashboard fixtures.
- Screenshots and DOM snapshots on tutorial failure.
- Browser reconnection and resume.
- Scenario timeout and automatic recovery.
- CI end-to-end test for every playbook.
- Deterministic headless video generation for selected scenario seeds.

## 10. Suggested New Services and Directories

```text
scenario-controller/
├── Dockerfile
├── controller.py
├── scenarios/
│   ├── slow-dependency.yaml
│   ├── auth-failures.yaml
│   └── catalog-outage.yaml
└── topology-catalog.yaml

learning/
├── schemas/
│   ├── scenario.schema.json
│   ├── playbook.schema.json
│   ├── command.schema.json
│   └── action.schema.json
├── selectors/
│   └── kibana-9.5.json
├── playbooks/
│   ├── slow-service.yaml
│   ├── elevated-errors.yaml
│   └── dependency-outage.yaml
└── rubrics/
    ├── slow-service-beginner.yaml
    ├── elevated-errors-beginner.yaml
    └── dependency-outage-beginner.yaml

learning-service/
├── Dockerfile
├── package.json
├── server.ts
├── engine/
│   ├── session.ts
│   ├── playbook.ts
│   └── evaluator.ts
└── protocol/
    └── websocket.ts

kibana-coach/
└── src/
    ├── session-client.ts
    ├── kibana-adapter.ts
    ├── action-observer.ts
    └── ui/
        ├── cursor.ts
        ├── spotlight.ts
        ├── coach-panel.ts
        └── debrief.ts

kibana-gateway/
├── Dockerfile
├── nginx.conf
└── runtime.json

scenario-recorder/
├── Dockerfile
├── package.json
├── recorder.ts
├── playwright-adapter.ts
└── video-metadata.ts

kibana/
├── setup.sh
└── saved-objects.ndjson
```

The learning service exposes the learning-session HTTP and WebSocket APIs. The Kibana gateway packages and injects the learner client while proxying its WebSocket on the Kibana origin. The scenario recorder is an optional build/CI tool; it does not host learner sessions or contain a second copy of the tutorial UI.

The Docker Compose additions would roughly be:

```yaml
scenario-controller:
  build: ./scenario-controller
  depends_on:
    kibana-setup:
      condition: service_completed_successfully
  environment:
    SCENARIO: ${SCENARIO:-random}
    SCENARIO_SEED: ${SCENARIO_SEED:-}
    ELASTICSEARCH_URL: http://elasticsearch:9200

kibana-setup:
  image: curlimages/curl
  depends_on:
    kibana:
      condition: service_healthy
  volumes:
    - ./kibana:/setup:ro

learning-service:
  build: ./learning-service
  depends_on:
    scenario-controller:
      condition: service_healthy
  ports:
    - "8091:8091"

scenario-recorder:
  profiles: [recording]
  build: ./scenario-recorder
  depends_on:
    scenario-controller:
      condition: service_healthy
  volumes:
    - ./recordings:/recordings
```

## 11. Major Risks

### Kibana DOM Stability

Kibana's internal markup can change between versions.

Mitigations:

- Pin the Elastic stack version.
- Prefer accessible roles, labels, and stable test attributes over CSS structure.
- Centralize selectors in a versioned selector map.
- Add a smoke test for every tutorial step.
- Capture screenshots when selectors fail.

### Cross-Origin Isolation

The existing iframe cannot deeply automate Kibana.

Mitigation:

- Serve Kibana through a local same-origin gateway that injects the constrained coach runtime.
- Use the telemetry workspace to launch Kibana with an automatic session handoff.
- Let Playwright own a separate Kibana page only while producing headless recordings or running compatibility checks.

### Timing and Ingestion Delays

Logstash ingestion and Kibana refreshes are asynchronous.

Mitigation:

- Gate tutorial start on Elasticsearch evidence.
- Use condition-based waits, never fixed sleeps.
- Display "Preparing incident evidence" while warming up.

### Automation That Teaches Nothing

A cursor that completes the investigation too quickly becomes a product tour rather than a learning experience.

Mitigation:

- Support guided mode.
- Explain why every filter is useful.
- Ask the learner to predict the next step.
- Validate learner actions before revealing the next hint.
- Offer a second run without automation.

### Contaminated Evidence

Tutorial telemetry might appear in the same searches as incident logs.

Mitigation:

- Use a distinct dataset and preferably a separate data stream.
- Automatically exclude `event.dataset: kibana.browser` from the incident saved views.
- Keep scenario-control logs in another dataset as well.

## 12. Recommended First Milestone

The best next milestone is:

> Start the stack, activate a reproducible slow-payments scenario, wait until at least ten affected traces have been indexed, open a provisioned Kibana investigation view, and use one semantic playbook to either demonstrate or guide an investigation that narrows the time range, applies a slow-duration filter, isolates the payments service, opens a trace, accepts a diagnosis, and explains why payments is the bottleneck.

That milestone exercises all essential capabilities without prematurely building a large scenario catalog.

Define success as:

- One command starts the complete experience.
- No manual Kibana data-view creation is required.
- The learner is not told the culprit in advance.
- The tutorial never begins before evidence is available.
- Every tutorial step is state-validated.
- The final diagnosis is supported by correlated trace evidence.
- Meaningful learner actions are recorded independently of raw mouse movement.
- The debrief distinguishes diagnosis correctness from investigation efficiency.
- The same scenario can be reset and replayed.
- An end-to-end test completes the investigation automatically.

## 13. Learner Experience Contract

Every run should follow the same top-level learning loop, regardless of assistance level:

1. **Brief** — present the symptom and operational context without naming the root cause.
2. **Investigate** — let the learner or tutorial engine interact with the same live Kibana evidence.
3. **Conclude** — ask the learner to identify the cause, impact, and supporting evidence.
4. **Debrief** — explain the diagnosis, show the route taken, identify avoidable detours, and offer a replay.

The scenario and expected evidence remain the same when the learner changes mode. A mode changes who performs an action, when help appears, and when validation is disclosed; it must not select a different, easier data set.

### Assistance Modes

Use one playbook with a configurable assistance policy rather than maintaining three separate tutorials.

| Product mode | Who acts | Guidance | Validation and feedback |
| --- | --- | --- | --- |
| Demonstration (fully driven or "shadow") | Tutorial engine clicks and types while the learner watches | Narration, visible cursor, and explanation before each action | Validate after every action; no learner-efficiency score |
| Guided practice | Learner acts; the engine can demonstrate a requested step | Target highlight, short instructions, progressive KQL hints | Validate each goal and correct locally useful mistakes |
| Challenge | Learner acts | Initial incident brief only; hints are on demand | Observe silently, then score the conclusion and investigation path |

Keep assistance as explicit capabilities so mixed experiences are possible:

```json
{
  "action_actor": "learner",
  "show_narration": true,
  "highlight_target": true,
  "offer_syntax_template": true,
  "validate_timing": "immediate",
  "allow_demonstrate_step": true,
  "reveal_root_cause": "after_submission"
}
```

If the learner requests a hint or asks the engine to complete a step, record that help transparently. Report assistance separately in the debrief instead of silently turning it into a punitive score deduction.

### Guidance Surfaces

Use each UI surface for a distinct purpose:

- A persistent, docked coach panel holds the incident brief, current objective, progress, pause control, and hint button.
- An anchored callout and optional spotlight identify a control the learner should use next.
- A virtual cursor shows movement and clicks during demonstrations without taking over the learner's operating-system cursor.
- A toast confirms short-lived outcomes such as "filter applied" or reports recoverable syntax errors.
- A modal is reserved for the initial briefing, an explicit learner choice, a major investigation checkpoint, or the final debrief. Routine instructions should not repeatedly block Kibana.

The overlay must not cover the control being taught. It needs keyboard navigation, screen-reader announcements, a reduced-motion option, and high-contrast styling. In every mode the learner must be able to pause automation and take control immediately.

Hints should use a consistent ladder so the learner receives the smallest useful intervention first:

1. Restate the investigative objective, such as narrowing the time window around the symptom.
2. Identify the relevant Kibana control without supplying the value.
3. Explain the KQL concept or field that would help.
4. Show a partial query template with the run-specific value omitted.
5. Offer the complete action or demonstrate it after explicit confirmation.

Reset the hint ladder when the learner reaches the next goal. This preserves productive struggle while preventing a beginner from getting stuck on syntax indefinitely.

## 14. Parameterized Scenario Contract

A scenario should separate stable investigative logic from randomized presentation values. Stable logical roles such as `entrypoint`, `upstream`, and `faulty_dependency` let one playbook work when the rendered service name, route, fault duration, port, traffic volume, and start time vary.

An expanded definition could look like:

```yaml
schema_version: 1
id: slow-dependency
title: A user-facing endpoint is responding slowly
difficulty: beginner

parameters:
  entrypoint_service:
    choose: [edge-api, public-gateway, web-api]
  upstream_service:
    choose: [orders, booking, checkout]
  dependency_service:
    choose: [payments, pricing, inventory]
  entrypoint_route:
    choose: [/checkout, /search, /book]
  dependency_route:
    choose: [/authorize, /quote, /reserve]
  dependency_port:
    integer: {min: 8081, max: 8099}
  delay_ms:
    integer: {min: 2200, max: 4200, step: 100}
  fault_probability:
    decimal: {min: 0.75, max: 0.95, step: 0.05}

constraints:
  - entrypoint_service != upstream_service
  - upstream_service != dependency_service

fault:
  target_role: dependency_service
  type: latency
  path: "${dependency_route}"
  delay_ms: "${delay_ms}"
  probability: "${fault_probability}"

traffic:
  entrypoint_role: entrypoint_service
  path: "${entrypoint_route}"
  requests_per_second: 3
  background_noise_profile: normal-with-distractors

readiness:
  timeout_seconds: 90
  minimum_affected_traces: 10
  predicates:
    - field: scenario.id
      equals: "${run.id}"
    - field: service.name
      equals: "${dependency_service}"
    - field: event.duration
      greater_than: "${delay_ms * 1000000}"

brief: >
  Users report that ${entrypoint_route} became slow in the last few minutes.
  Identify the bottleneck and support your conclusion with trace evidence.

truth:
  root_cause_service: "${dependency_service}"
  affected_route: "${entrypoint_route}"
  fault_type: latency
  evidence:
    - slow_transaction
    - dominant_dependency_span
    - shared_trace

playbook: slow-dependency-investigation
rubric: slow-dependency-beginner
```

At run creation, materialize this template into an immutable run manifest containing:

- the template version and content hash;
- the random seed and generator version;
- every chosen parameter;
- the generated service topology and ports;
- the scenario start and evidence window;
- the expected diagnosis and validation predicates;
- the playbook and rubric versions.

The run ID, rather than time alone, must isolate exercise evidence. Old runs may remain in Elasticsearch without leaking into the current investigation.

### Randomization Rules

Randomization must preserve the lesson being assessed.

- Use a seeded pseudo-random generator; the same template version and seed must create the same manifest.
- Generate the brief, fault configuration, traffic, validation queries, hints, and expected answer from the same manifest. Do not repeat hard-coded service names elsewhere.
- Keep ranges pedagogically meaningful. A latency value must remain visible against normal noise and the current Kibana time bucket.
- Randomize ports only when they appear in evidence or teach a networking lesson; otherwise they add configuration variability without learner value.
- Keep distractors plausible but bounded so they cannot become a second valid root cause.
- Run a preflight check for unique service names, valid routes, reachable dependencies, satisfiable evidence predicates, and non-empty expected queries.
- Allow an instructor to supply an exact seed and export the run manifest for replay.

Service-name randomization should initially choose from a fixed catalog of topologies rather than renaming containers ad hoc. This avoids generating broken dependency graphs while still requiring the learner to inspect the evidence instead of memorizing `payments` as the answer.

## 15. Learner Action Model and Path Evaluation

The system cannot judge investigation quality from raw clicks. Browser adapters should normalize Kibana activity into semantic actions and include the relevant state before and after each action.

Initial action types should include:

- `navigate_to_view`;
- `time_range_changed`;
- `query_submitted`;
- `query_rejected`;
- `filter_added`, `filter_changed`, and `filter_removed`;
- `sort_changed`;
- `field_inspected`;
- `document_expanded`;
- `trace_opened`;
- `visualization_drilled_down`;
- `hint_requested` and `step_demonstrated`;
- `diagnosis_submitted`.

Example event:

```json
{
  "@timestamp": "2026-08-28T14:32:18Z",
  "session.id": "session-4f2a",
  "scenario.id": "run-7c9812",
  "event.sequence": 12,
  "event.action": "query_submitted",
  "tutorial.mode": "challenge",
  "actor": "learner",
  "ui.view": "discover",
  "query.language": "kuery",
  "query.text": "event.duration >= 2000000000",
  "state.before.result_count": 487,
  "state.after.result_count": 19,
  "goal.progressed": ["isolate_slow_requests"],
  "validation.outcome": "accepted"
}
```

Pointer movement, scrolling, focus changes, and repeated rendering events can remain diagnostic telemetry but should not affect the learner's score.

### Goal Graph, Not One Exact Sequence

Each rubric should define a graph of investigation goals and acceptable transitions. For a slow dependency, goals might be:

```text
scope incident window
        ↓
identify slow transactions
        ↓
compare services or spans
        ↓
inspect a representative trace
        ↓
submit root cause with evidence
```

The learner might filter by duration before service name, drill down from a visualization, sort Discover by duration, or open a trace from an individual log. These should all be accepted if they satisfy equivalent evidence predicates.

For every action, the evaluator should ask:

1. Did it satisfy or make progress toward an unsatisfied goal?
2. Did it test a reasonable hypothesis using current evidence?
3. Did it retain relevant scenario evidence in the result set?
4. Was it a no-op, a repeated action, an unrelated pivot, or a reversal with no clear purpose?

Use the recorded state to evaluate those questions after the run. Avoid trying to infer intent from a CSS selector alone.

### Scoring Model

Keep outcome quality and process quality visible as separate scores.

| Category | Weight | Evidence |
| --- | ---: | --- |
| Diagnosis correctness | 40 | Correct faulty component, failure type, and affected user operation |
| Evidence quality | 20 | Cites a relevant time window, trace, slow span, error, or comparison |
| Goal coverage | 20 | Satisfies the scenario's required investigation predicates |
| Investigation relevance | 10 | Meaningful actions are connected to plausible hypotheses |
| Efficiency | 10 | Weighted semantic-action cost relative to a reference path |

The reference path is a benchmark, not a claim that only one sequence is optimal. Calculate efficiency using weighted semantic actions, not raw click count. Ignore harmless exploration and accessibility-driven interaction. Penalize only clear waste such as repeated no-op queries, filter thrashing, long unrelated pivots, or repeatedly widening the search after relevant evidence was already isolated.

Hints and demonstrated steps should be reported as an assistance summary, for example `2 hints; 1 demonstrated step`. If a course requires an independence grade, make that an explicit separate policy rather than hiding it inside correctness.

### Debrief Output

The debrief should be concrete and evidence-based:

- Restate the learner's conclusion and whether each part was supported.
- Show the decisive actions that narrowed the incident correctly.
- Highlight avoidable detours and explain why they were low value.
- Show one concise reference route using the values from this run.
- Point out useful KQL syntax, including any equivalent query the learner used.
- Offer a replay with the same seed, a new seed, or less assistance.

Example feedback:

> You correctly identified `pricing` as the bottleneck and supported it with trace `8b7…`. Filtering to the incident window and sorting by duration were both effective. You then switched to authentication failures for four actions even though the result set contained no events from this run. A more direct route would have been to pivot from the slow transaction to its shared trace before changing datasets.

## 16. Logs, Transactions, and Slow Spans

The current services emit one request-completion log with a shared `trace.id`. That is sufficient for a log investigation but not enough to identify a slow child span reliably.

Use two incremental fidelity levels.

### Initial Correlated-Log Model

For the first vertical slice, emit a document for each local operation and downstream call with at least:

```json
{
  "scenario.id": "run-7c9812",
  "trace.id": "...",
  "transaction.id": "...",
  "span.id": "...",
  "parent.id": "...",
  "service.name": "pricing",
  "transaction.name": "GET /search",
  "span.name": "GET inventory:8087/quote",
  "span.type": "external",
  "event.duration": 3100000000,
  "http.response.status_code": 200
}
```

`event.duration` remains in nanoseconds. A generated trace must form a valid parent-child tree, and upstream durations must include the time spent waiting for downstream calls. This allows a beginner to find the dominant operation in Discover even before a dedicated trace waterfall exists.

### OpenTelemetry/APM Model

Add real spans through OpenTelemetry and an Elastic-compatible ingestion path once the learning loop is proven. This enables Kibana's trace waterfall and service views and supports scenarios such as:

- one slow database span inside an otherwise successful request;
- repeated outbound retries;
- fan-out where one dependency dominates the critical path;
- a cache miss that exposes a slow data-store call;
- a service that is locally fast but waits on a downstream timeout.

Do not present a "find the slow span" exercise until the UI contains genuine span-level evidence and the validator can confirm that the selected span belongs to the current run and dominates its trace.

## 17. Session, Run, and Command APIs

Add a learning service alongside the scenario controller. It owns learner sessions, playbook progress, command delivery, normalized action history, answers, and debriefs. Keep its contracts explicit even if an early prototype temporarily shares a process with the telemetry collector.

Minimum HTTP surface:

```text
POST /api/runs                    create a run from template, seed, and mode
GET  /api/runs/{run_id}           return lifecycle, manifest summary, and readiness
POST /api/runs/{run_id}/reset     stop traffic and create a clean replay
POST /api/sessions/{id}/answer    submit diagnosis and cited evidence
GET  /api/sessions/{id}/feedback return score, route summary, and debrief
WS   /api/sessions/{id}/events    commands, acknowledgements, observed state, and actions
```

Use these run states:

```text
CREATED → ACTIVATING → WARMING → READY → INVESTIGATING → COMPLETED
                         ↘ FAILED             ↘ ABORTED
```

Important invariants:

- A browser cannot begin until the run is `READY`.
- Only one browser is the active controller for a learner session.
- Every command and action carries a run ID, session ID, monotonically increasing sequence number, and protocol version.
- Reconnection resumes from the last acknowledged command and observed playbook state.
- Reset stops targeted traffic and clears the active fault before activating the next run.
- Reset does not need to delete historical data because every query and validator scopes by the new run ID.
- The learner can always pause, abort, or take control without leaving a fault active indefinitely.

## 18. Actionable Delivery Backlog

The earlier phases describe the broad sequence. The following backlog makes the next work independently testable.

### Milestone A — Contracts and Provisioning

- Pin the supported Elastic and browser versions.
- Define versioned schemas for scenario templates, run manifests, playbooks, semantic actions, browser commands, and rubrics.
- Add a `microservices-*` data view and a predictable Discover saved view through `kibana-setup`.
- Add a selector registry for the pinned Kibana version.
- Add contract fixtures for one materialized `slow-dependency` run.

Exit criteria: a fresh stack creates the saved objects automatically, the scenario fixture validates, and the query bar, time picker, filter controls, results table, and trace field can all be resolved by semantic name.

### Milestone B — Deterministic Incident

- Implement runtime latency-fault controls and cleanup.
- Propagate `scenario.id`, transaction IDs, span IDs, and parent IDs through the request path.
- Generate targeted traffic plus bounded background noise.
- Wait for evidence using Elasticsearch predicates.
- Support fixed seed creation, manifest export, reset, and replay.

Exit criteria: the same seed creates the same logical incident, ten affected traces become queryable before `READY`, and the correct dependency is the dominant duration in those traces.

### Milestone C — Learner-Browser Learning Loop

- Implement the learning service, semantic playbook engine, built-in coach, and Kibana gateway.
- Add an authenticated launcher-to-Kibana handoff and proxy the learning WebSocket on the Kibana origin.
- Add the docked coach panel, virtual cursor, target spotlight, toasts, and debrief modal.
- Run the same five goals in demonstration and guided-practice policies.
- Normalize relevant Kibana actions and validate browser plus Elasticsearch state.
- Accept a structured diagnosis and produce a basic debrief.

Exit criteria: the playbook runs in the learner's opted-in Kibana tab, a learner can take over each step, and no step advances solely because a coordinate was clicked.

### Milestone D — Challenge and Evaluation

- Add silent challenge mode and on-demand progressive hints.
- Implement the goal-graph evaluator, weighted reference route, and assistance summary.
- Add fixtures for an efficient route, an alternate valid route, a detour-heavy route, an incorrect conclusion, and a correct conclusion with weak evidence.
- Display replay choices with the same seed, a new seed, or a different assistance policy.

Exit criteria: equivalent valid routes receive comparable goal coverage, irrelevant actions reduce only process quality, and a correct answer with no supporting evidence cannot receive full marks.

### Milestone E — Headless Recording and Compatibility Checks

- Implement the small Playwright adapter around the shared semantic target and validation contracts.
- Accept a scenario template, seed, playbook, and assistance policy as recording inputs.
- Wait for scenario readiness and capture the complete investigation as a headless video.
- Write a sidecar manifest containing all inputs, component versions, viewport settings, duration, and outcome.
- Capture screenshots and DOM snapshots on failure for Kibana compatibility diagnostics.
- Add selected scenario recordings and compatibility runs to CI or a release workflow.

Exit criteria: an instructor or CI job can reproduce a reference video from a known seed, and a failed semantic target or validation produces enough artifacts to diagnose a Kibana UI change. No Playwright browser is exposed as an interactive learner session.

### Milestone F — Scenario Catalog and Real Traces

- Add latency, elevated-error, dependency-unavailable, and slow-span templates.
- Add catalog-backed random service topologies and parameter constraints.
- Introduce OpenTelemetry/APM documents and a provisioned trace view.
- Add scenario-specific distractors and automated solvability checks.

Exit criteria: every template passes an automated readiness and solution test across a representative set of seeds, and the slow-span scenario is solvable from genuine span evidence.

## 19. Test Strategy

The most valuable tests exercise contracts rather than screenshots alone.

- **Schema tests:** invalid parameters, missing truth fields, unsatisfied variables, and incompatible template versions fail before a run starts.
- **Seed tests:** identical template version plus seed yields an identical manifest; different seeds vary only allowed fields.
- **Fault tests:** injected delay/error affects the real caller and disappears after cleanup.
- **Evidence tests:** every generated expected answer can be proven by the generated Elasticsearch predicates.
- **Coach contract tests:** the learner adapter can resolve targets, read state, perform semantic commands, observe learner actions, and recover after reconnect.
- **Recorder contract tests:** the Playwright adapter can resolve the same targets, perform demonstration commands, validate the result, capture video, and emit reproducibility metadata; it does not need learner-action observation or session-recovery behavior.
- **Playbook tests:** alternative valid routes satisfy the same goals; invalid KQL does not advance progress.
- **Scorer fixtures:** known action histories produce stable, reviewable score components and feedback.
- **End-to-end tests:** fresh start, readiness, each assistance mode, diagnosis, debrief, reset, replay, and selected headless recordings all complete for the pinned Kibana version.
- **Accessibility tests:** all guidance is reachable without a mouse, focus remains visible, and reduced-motion mode suppresses cursor animation without losing instructions.

Store screenshots and DOM snapshots only on failure in CI. Use semantic state and Elasticsearch evidence as the primary assertions.

## 20. Decision Register

These choices should be made explicitly as implementation begins:

| Decision | Recommendation | Reason |
| --- | --- | --- |
| Interactive browser surface | Built-in same-origin coach | Runs demonstrations and guidance in the learner's real Kibana tab without browser installation |
| Playwright scope | Headless recording and compatibility checks only | Produces reproducible scenario videos and validates selectors without creating a second learner experience |
| First investigation UI | Discover plus provisioned views | Smallest surface that teaches time range, KQL, fields, and trace correlation |
| First trace fidelity | Correlated operation documents | Avoids making APM setup block the initial learning loop |
| Later trace fidelity | OpenTelemetry into Elastic APM-compatible storage | Required for authentic slow-span and waterfall exercises |
| Scenario storage | Version-controlled YAML with materialized JSON manifests | Human-readable authoring plus reproducible execution |
| Scoring approach | Goal graph and weighted reference path | Accepts valid alternate investigations while detecting obvious detours |
| Assistance scoring | Report separately | Makes feedback understandable and avoids hidden penalties |
| Tutorial telemetry | Dedicated data stream/index | Prevents learner activity from polluting incident evidence |

Before multi-learner or hosted deployment, decide whether the primary target is a local single-learner lab, a hosted workshop, or both. That decision changes authentication, session tenancy, TLS, retention, and gateway isolation. It does not need to block the local same-origin vertical slice.
