# Autonomous Incident-Learning System Plan

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

## 3. How to Drive the Cursor

### Recommended Approach: Playwright-Controlled Browser

Use a dedicated `tutorial-runner` based on Playwright or another browser automation framework.

It would open Kibana itself, not try to manipulate Kibana through the current cross-origin iframe. This provides:

- reliable DOM selectors;
- actual pointer movement;
- actual keyboard input;
- visibility checks;
- screenshots on failure;
- the ability to inspect Kibana URL and application state;
- deterministic control over time-picker and query-bar actions.

The runner could launch a browser in either of two modes.

#### Kiosk Mode

A container launches Chromium and exposes it over noVNC to the learner.

Advantages:

- Fully autonomous.
- The runner owns the browser.
- Exact viewport and Kibana version can be controlled.
- Cursor animation is genuinely visible.
- Great for workshops and hosted demos.

Disadvantages:

- More infrastructure.
- Browser video streaming can feel less native.
- Clipboard and accessibility require additional work.

#### Learner Browser with Extension or Injected Script

The learner opens Kibana normally, and an approved browser extension or same-origin script displays the guide and performs actions.

Advantages:

- Native local browser experience.
- Better rendering and input latency.

Disadvantages:

- Installation and permission friction.
- Harder to support consistently.
- Injecting code into Kibana is version-sensitive.
- Security policies and content-security policy must be handled carefully.

#### Recommendation

Start with **Playwright plus a containerized Chromium/noVNC session**. It gives the project control over Kibana version, selectors, viewport, and pointer movement. Once the learning flow is proven, a browser-extension mode can be considered.

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
Tutorial runner starts
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
- one Playwright tutorial;
- a five-step guided investigation;
- final diagnosis.

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
- Guided learner-controlled mode.
- Independent mode with hints.
- Step validation.
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

## 10. Suggested New Services and Directories

```text
scenario-controller/
├── Dockerfile
├── controller.py
├── scenarios/
│   ├── slow-payments.yaml
│   ├── auth-failures.yaml
│   └── catalog-outage.yaml
└── playbooks/
    ├── slow-service.yaml
    ├── elevated-errors.yaml
    └── dependency-outage.yaml

tutorial-runner/
├── Dockerfile
├── package.json
├── runner.ts
├── selectors/
│   └── kibana-8.15.json
└── ui/
    ├── cursor.ts
    ├── spotlight.ts
    └── narration.ts

kibana/
├── setup.sh
└── saved-objects.ndjson
```

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

tutorial-runner:
  build: ./tutorial-runner
  depends_on:
    scenario-controller:
      condition: service_healthy
  ports:
    - "7900:7900"
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

- Have Playwright own the Kibana page directly.
- Use the telemetry workspace as the session launcher/control surface, rather than as the automation boundary.

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

> Start the stack, activate a reproducible slow-payments scenario, wait until at least ten affected traces have been indexed, open a provisioned Kibana investigation view, and run a visible guided tutorial that narrows the time range, applies a slow-duration filter, isolates the payments service, opens a trace, and explains why payments is the bottleneck.

That milestone exercises all essential capabilities without prematurely building a large scenario catalog.

Define success as:

- One command starts the complete experience.
- No manual Kibana data-view creation is required.
- The learner is not told the culprit in advance.
- The tutorial never begins before evidence is available.
- Every tutorial step is state-validated.
- The final diagnosis is supported by correlated trace evidence.
- The same scenario can be reset and replayed.
- An end-to-end test completes the investigation automatically.
