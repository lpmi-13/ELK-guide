# Full Kibana Scenario Expansion Plan

## 1. Objective

Expand the lab from a single latency investigation into a broad, realistic Kibana learning environment. The finished lab should teach learners how production engineers use the Kibana user interface to explore data, investigate incidents, interpret existing visualizations and dashboards, work with traces and metrics, triage alerts, assess existing service objectives, and record incident evidence in their conclusions.

Every core scenario must run in all three existing modes:

- **Demonstration** — the coach performs the workflow, explains each decision, and validates every step.
- **Guided practice** — the learner performs the same workflow with progressive hints, target highlighting, and optional step demonstration.
- **Challenge** — the learner works independently, can request limited help, and receives an evidence-based score and debrief.

The three modes must use the same scenario data, starting state, goals, and reference solution. They are different levels of assistance, not separate exercises.

This plan targets **Kibana 9.5.2**.

**Curriculum decision:** every learner workflow is read-only with respect to Kibana content. Learners may change ephemeral view state—time ranges, queries, filters, controls, sorting, selected entities, and drilldowns—but they do not create, edit, configure, or save Kibana objects. Alert triage remains in scope because the lab can straightforwardly provision a real no-action Kibana alert before the exercise begins.

## 2. Scope boundary

“Kibana” in this plan means the full Kibana user interface, not only the Dashboard application. Discover, existing dashboards, APM, infrastructure views, Alerts, and other relevant read-only investigation surfaces that are available on the free Basic license are in scope. Payment-gated surfaces (the APM service map, SLOs, and machine learning) are out of scope.

The learner is here to become proficient in Kibana. The following are therefore explicitly out of scope as learning objectives:

- Operating Elasticsearch nodes, clusters, shards, or replicas.
- Diagnosing JVM, disk watermark, allocation, or cluster-health problems.
- Creating mappings, index templates, data streams, or lifecycle policies.
- Building or debugging Logstash pipelines.
- Installing or administering Beats, Elastic Agent, or Fleet integrations.
- Managing snapshots, restores, upgrades, certificates, users, or roles.
- Using Dev Tools to perform Elasticsearch administration.
- Editing Docker, Compose, or application configuration as part of a scenario.
- Repairing the simulated production system after identifying a problem.
- Creating, editing, arranging, or saving visualizations or dashboards.
- Creating or editing Discover sessions, alert rules, Cases, or other Kibana content.
- Configuring notification connectors, rule actions, maintenance windows, or alert suppression.

Backend code may seed data, create traces, import saved objects, prepare rules, or validate an answer. That machinery must remain invisible to the learner and exist only to support an authentic Kibana interaction. A realistic-looking, deterministic data pack is preferable to elaborate infrastructure when the infrastructure itself teaches no Kibana skill.

The existing example services should be retained where live traffic and connected traces materially improve a lesson. They should not be a prerequisite for every scenario.

## 3. Learning design principles

### 3.1 Teach decisions, not tours

Each scenario starts with a credible operational question and ends with a defensible conclusion supported by visible evidence. It should never amount to “click every item on this screen.” A learner must understand why a time range, filter, aggregation, trace, panel, or alert view is useful.

### 3.2 Use authentic ambiguity

Production data contains noise. Scenario packs should contain irrelevant services, normal errors, common log messages, healthy hosts, and plausible distractors. The evidence must still be deterministic and discoverable without guessing.

### 3.3 Teach transferable concepts

Instructions should name the concept and intended outcome, while selectors and automation handle the precise Kibana 9.5.2 controls. For example, teach “compare the affected and preceding periods,” not “click the third button from the left.”

### 3.4 Allow valid alternative paths

Kibana often offers more than one reasonable route to the same evidence. Challenge scoring should accept equivalent KQL filters, filter pills, dashboard interactions, drilldowns, or Discover investigations when they establish the required facts.

### 3.5 Keep results reproducible

Each run needs a fixed scenario seed, relative timestamps, known truth, deterministic distractors, and isolated controller-managed resources. Resetting a run must restore the exact starting state.

### 3.6 Increase difficulty through reasoning

Difficulty should progress from finding a known field, through comparing groups and time periods, to correlating several signals and constructing a defensible evidence chain. It should not be manufactured through obscure controls or brittle UI precision.

### 3.7 Use product capabilities honestly

Scenarios may use only free, open-source Basic-tier features verified in the clean local installation. Subscription-dependent or experimental capabilities (for example the APM service map, SLOs, and machine learning) are excluded from the curriculum entirely rather than gated behind a license check. A startup capability probe still confirms that the required free features are present before a scenario is offered.

## 4. Current architecture gaps

The existing three-mode coach is a strong base, but its data model and evaluator are specialized for `slow-payments`:

- The scenario schema requires a service fault, traffic generator, and one fixed root-cause shape.
- Readiness checks assume a slow APM transaction.
- The command vocabulary covers only a small Discover-to-trace workflow.
- Goal recognition is hard-coded to duration, `service.name`, route, and trace actions.
- The answer and demonstration summary require service, fault type, route, and trace ID.
- Scoring assumes that every scenario is an incident diagnosis.
- Random scenario selection resolves to the one existing scenario.
- Saved objects and investigation URLs are hard-coded around the current exercise.

Adding dozens of scenarios directly to this structure would create a growing collection of special cases. The first implementation step must therefore be a generic scenario engine rather than more conditionals in the existing evaluator and controller.

## 5. Target architecture

The expanded lab should be organized around five concepts:

1. **Scenario catalog** — metadata used by the launcher to list, filter, and select scenarios.
2. **Scenario pack** — everything required to provision, teach, validate, and reset one scenario.
3. **Semantic Kibana actions** — stable learner intentions such as `add_filter`, `inspect_panel`, or `open_trace`, separated from Kibana's current DOM.
4. **Goal graph** — ordered or partially ordered outcomes that can be satisfied by one or more valid actions.
5. **Kibana application adapters** — small modules that execute and observe semantic actions in Discover, Dashboard, APM, and other read-only investigation surfaces.

Recommended pack layout:

```text
learning/
  catalog.json
  scenarios/
    <scenario-id>/
      scenario.json
      playbook.json
      rubric.json
      data/
      saved-objects.ndjson
      expected/
```

Not every directory needs every optional file. Most investigations need only seeded events and baseline saved objects; alert scenarios may also declare controller-provisioned Kibana resources.

### 5.1 Scenario types

The engine must support these scenario types:

- `investigation` — determine what happened and support the answer with evidence.
- `analysis` — answer a quantitative question or comparison.
- `triage` — assess an alert or service condition and choose a justified response.

Scenario type controls the answer form and scoring details; it must not fork the three-mode framework. No scenario type permits learners to create or modify Kibana content.

### 5.2 Provisioning strategies

Each pack declares one of these hidden provisioning strategies:

- `seeded-events` for logs, metrics, or historical traces.
- `live-traffic` for scenarios where a running trace and correlated telemetry improve authenticity.
- `saved-objects` for prebuilt data views, dashboards, or visualization panels.
- `managed-resource` for controller-created alerting rules provisioned through public Kibana APIs.
- A composition of the above.

All data must include a private run/scenario discriminator so validation is isolated even if two learners run the same exercise concurrently.

### 5.3 Run isolation

Use a per-run Kibana Space unless an early feasibility spike exposes a material Kibana 9.5.2 limitation. At run creation, the controller should:

1. Create a namespaced Space.
2. Import the scenario's baseline saved objects.
3. Create any required alerting rule through supported Kibana APIs.
4. Seed or start the required telemetry.
5. launch the learner at `/s/<run-space>/app/...`.
6. Delete the Space and expire scenario data during reset or cleanup.

This prevents controller-created resources from leaking between runs and makes “start again” deterministic. If Spaces cannot isolate a particular resource, that resource must use an explicit run prefix and have a tested cleanup routine.

## 6. Three-mode contract

Every enabled scenario pack must pass the following mode contract.

### Demonstration

- Start from the same initial Kibana page and data as the other modes.
- Execute the reference route using semantic commands.
- Explain the question being answered before each action.
- Show the visible result and identify the evidence it contributes.
- Pause at important interpretation points rather than replaying a rapid macro.
- End with an unscored summary that connects the evidence to the conclusion.

### Guided practice

- Present one outcome at a time without prescribing unnecessary click-level details.
- Detect valid completion from browser state, Kibana object state, or results—not from a single expected click sequence.
- Offer progressive hints: conceptual hint, UI-location hint, then optional demonstration.
- Mark a goal complete when the evidence is established by an accepted alternative route.
- Record demonstrated goals for the debrief without punishing exploration.

### Challenge

- Provide only the operational brief, permitted deliverable, and time context.
- Keep truth, expected queries, and goal labels out of learner-visible data.
- Allow free navigation across in-scope Kibana applications.
- Offer on-demand hints with an explicit score consequence.
- Score correctness, evidence, goal coverage, relevance, and efficiency.
- Give a replayable debrief that maps the learner's actions to missed and completed goals.

### Shared invariant

No mode may require terminal commands, source edits, service restarts, direct API calls, or a second administrative interface from the learner. Learners may filter, inspect, compare, and drill down, but must never enter a Kibana create, edit, configure, or save workflow.

## 7. Competency map and scenario catalog

The following catalog is the target. All scenarios are **Core** and must support Demonstration, Guided, and Challenge modes. Every scenario uses only free, open-source Basic-tier Kibana features; no scenario depends on a Platinum, Enterprise, or subscription-gated capability.

### 7.1 Discover and KQL foundations

| ID | Level | Authentic brief | Kibana skills | Decisive outcome |
|---|---:|---|---|---|
| `discover-time-window` | 1 | Support reports a brief checkout problem around a known time. Establish whether the report aligns with observable activity. | Open Discover, choose data view, set absolute/relative time, zoom histogram, inspect event counts | Identify the correct incident window and show the traffic/error change |
| `http-error-regression` | 1 | HTTP 5xx responses increased after a release. Find the affected endpoint and representative error. | KQL, filter pills, useful columns, sorting, field inspection, document expansion | Name the route, status family, and example error document |
| `auth-rejection-surge` | 1 | Sign-in failures have risen, but several normal rejection types are mixed together. | Boolean KQL, existence tests, include/exclude filters, top values, compare fields | Distinguish the abnormal rejection reason and affected client/application |
| `deployment-version-regression` | 2 | Only part of the fleet appears unhealthy after a rolling deployment. Determine whether version is the differentiator. | Multi-value filtering, compare versions, split results, sort by first occurrence | Show that one `service.version` has the regression and identify its first appearance |
| `rare-error-signature` | 2 | A high-volume service contains one rare exception associated with failed requests. | Field statistics, value distributions, cardinality, sort, document details, surrounding documents | Isolate the rare error type and a representative correlated request |
| `schema-drift-data-quality` | 2 | A dashboard count dropped even though traffic did not. Investigate a suspected telemetry field change. | Missing-field queries, field statistics, inspect field metadata exposed in Discover, compare producers/versions | Prove which producer/version stopped populating the expected field; no pipeline repair is required |
| `log-pattern-noise-reduction` | 2 | A service emits thousands of repetitive warnings. Find the pattern that actually correlates with failures. | Message filtering, include/exclude filters, patterns/top values where available, compare rates | Separate background warning noise from the failure-associated signature |

### 7.2 ES|QL analysis in Discover

| ID | Level | Authentic brief | Kibana skills | Decisive outcome |
|---|---:|---|---|---|
| `esql-top-failing-routes` | 2 | Rank endpoints by failed request count and failure rate during the incident. | Switch to ES|QL, `FROM`, `WHERE`, `STATS`, calculated fields, `SORT`, `LIMIT` | Produce a ranked result with the true worst route |
| `esql-before-after-deploy` | 3 | Quantify whether a release materially changed latency and errors. | Time bucketing, conditional aggregation, grouping by version, result table interpretation | Give before/after figures that support or reject the regression hypothesis |
| `esql-cross-service-summary` | 3 | An incident spans several services. Produce a concise result table showing volume, failures, and high-percentile latency. | Aggregate by service, calculate rates/percentiles, rename columns, sort and interpret the result table | Correctly rank the affected services and report the decisive values |

Field-statistics lessons must use standard Discover mode because that panel is not available in ES|QL mode. ES|QL scenarios should explicitly teach that the query selects the data rather than a data view and that switching modes changes the available analysis tools.

### 7.3 Dashboard investigation and interpretation

All dashboards and panels in these scenarios are supplied by the lab. Learners interact with them in view mode only; Lens, dashboard edit mode, and saved-object creation are never part of a learner workflow.

| ID | Level | Authentic brief | Kibana skills | Decisive outcome |
|---|---:|---|---|---|
| `dashboard-incident-triage` | 1 | An on-call engineer opens the service overview during an incident and must rapidly narrow scope. | Dashboard time range, global filters, options/range controls, legend filtering, panel focus | Identify the affected region, service, and interval without leaving the dashboard |
| `dashboard-drilldown-to-evidence` | 2 | A chart spike needs document-level confirmation. | Interact with a chart, preserve filter/time context, follow drilldown, inspect underlying events in Discover | Reach representative events with the dashboard context intact |
| `dashboard-panel-inspection` | 2 | Two panels seem to contradict one another. Determine how each metric is calculated. | Inspect panel configuration/request, view underlying data, understand aggregation and filter scope | Explain the difference and identify which panel answers the incident question |

### 7.4 APM and distributed tracing

| ID | Level | Authentic brief | Kibana skills | Decisive outcome |
|---|---:|---|---|---|
| `slow-dependency-trace` | 1 | Checkout latency is high. Find the downstream dependency and operation responsible. | Service overview, transaction selection, trace sample, waterfall, span details | Identify the slow dependency, affected transaction, and representative trace |
| `trace-error-propagation` | 2 | The edge service reports a generic failure. Find where the exception originated and how it propagated. | Trace overview, error markers, span/exception details, parent-child path | Identify the originating service/span and the downstream-to-upstream failure path |
| `retry-amplification` | 3 | Latency and dependency traffic increased without a matching rise in user traffic. | Compare traces, repeated spans, critical path, span duration, destination context | Prove that retries amplify calls and quantify a representative request's retry count |
| `trace-log-correlation` | 2 | A failing trace contains insufficient error context. Find the exact application log for the failing request. | Navigate from trace/span to correlated logs, preserve trace ID/time, inspect log details | Link one trace to the decisive log event and error message |

### 7.5 Metrics and infrastructure views

These exercises teach Kibana's infrastructure and metric exploration views, not infrastructure administration.

| ID | Level | Authentic brief | Kibana skills | Decisive outcome |
|---|---:|---|---|---|
| `cpu-saturation` | 1 | One service slows during a traffic peak. Determine whether compute saturation aligns with the event. | Infrastructure inventory, host/container filtering, metric charts, time correlation, pivot to logs | Identify the saturated instance and correlate it with the latency interval |
| `memory-leak-and-restarts` | 2 | A workload becomes unstable over several hours. Find the resource trend and restart evidence. | Longer time range, compare metrics, memory/GC/restart fields, annotations or event correlation | Demonstrate the rising memory pattern and identify the first restart |
| `hot-instance-imbalance` | 2 | Aggregate service health hides an outlier instance. | Grouping, sorting, instance/pod filtering, compare peer metrics | Identify the outlier and show that peers remain healthy |
| `capacity-throughput-saturation` | 3 | Latency rises only above a traffic threshold. Establish the capacity relationship. | Interpret existing throughput and latency panels, dashboard filtering, metric comparison across periods | Estimate the saturation point and provide the supporting chart evidence |

### 7.6 Alert triage

| ID | Level | Authentic brief | Kibana skills | Decisive outcome |
|---|---:|---|---|---|
| `active-alert-triage` | 1 | An alert has fired for an unfamiliar service. Decide whether it represents an active customer issue. | Alert table, status/reason, time context, alert details, pivot to source evidence | Classify the alert correctly and cite the event/trace/metric that supports the decision |

The alert is prepared by the lab, not the learner. The current Compose stack already contains Kibana's alerting and alert-index plugins; its alerting APIs are blocked only because `xpack.encryptedSavedObjects.encryptionKey` is unset. Add one stable lab-only key of at least 32 characters, create a run-scoped Elasticsearch query or index-threshold rule through Kibana's supported API with `actions: []`, seed a matching event, and wait until the alert is visible before marking the scenario ready. No connector or notification action is required. This is sufficiently small and deterministic to keep `triage` as a core scenario type. Kibana's rule framework and alert views are available on the free Basic license.

### 7.7 Coverage summary

The target catalog contains **22 core scenarios**. Every scenario has a clear investigative outcome, uses only free open-source Basic-tier Kibana features, and requires no learner to author Kibana content or operate Elasticsearch and the surrounding stack. Payment-gated surfaces (the APM service map, SLOs, machine learning) and the previously proposed Maps and Synthetics extensions are intentionally excluded.

## 8. Semantic command and observation model

The current command schema must be expanded into a versioned vocabulary. Commands describe intent and adapters translate intent into the Kibana 9.5.2 UI.

### 8.1 Common navigation and time

- `navigate_to_app`
- `open_saved_object`
- `set_time_range`
- `shift_time_range`
- `refresh_data`
- `set_auto_refresh`

### 8.2 Discover and query actions

- `select_data_view`
- `enter_kql`
- `switch_query_language`
- `enter_esql`
- `add_filter`
- `edit_filter`
- `remove_filter`
- `disable_filter`
- `add_column`
- `remove_column`
- `sort_column`
- `expand_document`
- `inspect_field`
- `open_field_statistics`
- `open_surrounding_documents`

### 8.3 Dashboard actions

- `set_dashboard_control`
- `interact_with_panel_value`
- `open_panel_drilldown`
- `inspect_panel`
- `view_panel_underlying_data`

### 8.4 APM and trace actions

- `select_apm_service`
- `select_apm_environment`
- `open_transaction_group`
- `select_trace_sample`
- `open_trace`
- `select_span`
- `open_error_details`
- `navigate_to_correlated_logs`

### 8.5 Metrics and infrastructure actions

- `select_inventory_type`
- `select_infrastructure_entity`
- `filter_infrastructure_entities`
- `group_infrastructure_entities`
- `select_metric`
- `compare_metric_period`
- `navigate_from_metrics_to_logs`

### 8.6 Alert actions

- `open_alert`
- `filter_alerts`
- `inspect_alert_reason`
- `inspect_alert_history`
- `navigate_from_alert_to_source`

### 8.8 Normalized observations

Browser listeners must publish normalized actions independently of mode, including:

- Query submitted, filter state changed, time range changed, data view selected.
- Document, field statistics, trace, span, service, or alert opened.
- Dashboard control changed, chart value selected, drilldown followed, panel inspected.
- Alert reason/history details inspected.

Goal evaluation consumes these observations plus resulting Kibana state. It must not depend on raw CSS selectors or coordinates.

## 9. Scenario schema version 2

Replace the fault-specific required fields with a general contract. A scenario should declare:

```yaml
schema_version: 2
id: deployment-version-regression
title: Deployment version regression
type: investigation
difficulty: 2
estimated_minutes: 15
skills:
  - discover
  - kql
  - field-comparison
required_capabilities:
  - discover
provisioning:
  strategies:
    - seeded-events
    - saved-objects
  readiness_validators: []
starting_view:
  app: discover
  saved_object: deployment-regression-start
truth:
  assertions: []
answer_schema:
  fields: []
playbook: playbook.json
rubric: rubric.json
```

Important schema changes:

- `fault`, `traffic`, and fixed `root_service` fields become optional provisioning details rather than universal requirements.
- `readiness_validators` is a list of reusable checks, not a controller branch keyed by scenario ID.
- `truth.assertions` can express field values, comparisons, time bounds, trace paths, and alert state.
- `answer_schema` defines the response appropriate to the scenario type.
- `required_capabilities` controls launcher visibility and provisioning.
- `starting_view` resolves the initial Kibana application and saved object without hard-coded controller URLs.
- `cleanup` declares all controller-created resources that must be removed.

Schema validation should reject any learner step targeting a shell, Elasticsearch administration, Dev Tools, or an external application.

## 10. Playbook and goal graph version 2

A playbook remains the single source for all three modes, but each step should be expressed as a goal rather than one exact action:

```yaml
goals:
  - id: isolate-new-version
    title: Compare deployed versions
    concept: Segmenting telemetry can expose a partial rollout regression.
    requires:
      - establish-incident-window
    accepts:
      - action: filter_changed
        validators:
          - kind: filter_contains
            field: service.version
            values_from_truth: affected_versions
          - kind: result_assertion
            assertion: affected_version_has_higher_error_rate
      - action: esql_submitted
        validators:
          - kind: result_assertion
            assertion: result_groups_by_version
          - kind: result_assertion
            assertion: affected_version_has_higher_error_rate
    reference_action:
      command: add_filter
      arguments: {}
    hints: []
```

This model supports:

- Dependencies between goals without forcing a fully linear route.
- Several acceptable Kibana techniques for the same outcome.
- A stable reference action for Demonstration and optional Guided help.
- Validators based on query state, visible results, selected entities, and inspected evidence.
- Scenario-specific explanations and hints without scenario-specific evaluator code.

Playbooks must not contain learner-visible truth in titles, narration shown before discovery, saved object names, or URLs.

## 11. Generic validation and scoring

### 11.1 Validation sources

Use the least invasive reliable source for each goal:

1. **Browser/Kibana state** — query text, filters, time range, selected entity, current app, or visible result.
2. **Public Kibana API state** — verify that the controller-provisioned alert, rule, or baseline saved object is ready and matches the scenario declaration.
3. **Hidden evidence query** — verify that the current filter/result actually contains the scenario evidence.
4. **Baseline saved-object inspection** — understand the supplied dashboard's panels, controls, and drilldowns so learner interactions can be validated semantically.

Validation must grade the semantic result. It should not require a particular button order, panel position, generated object ID, or exact query formatting.

### 11.2 Validator library

Build reusable validators for:

- Time range contains/overlaps truth interval.
- KQL/ES|QL is syntactically valid and produces a required subset or aggregation.
- Filter contains/excludes expected fields and values.
- Result set contains a truth document, trace, group, or comparison.
- A required document, field, trace, span, service, or alert was inspected.
- An existing dashboard was narrowed with the expected controls/filters and a relevant panel value, drilldown, inspection view, or underlying result was opened.
- A pre-generated alert was found with the expected status, reason, time, and source evidence.
- Resource state is isolated to the learner's run.

### 11.3 Answer types

Support structured answers for:

- `diagnosis` — affected component, symptom, scope, cause, and evidence references.
- `comparison` — groups/periods compared, computed values, and conclusion.
- `triage_decision` — active/resolved/noise classification, priority, and evidence.

### 11.4 Scoring

Keep a familiar 100-point structure while adapting its details to scenario type:

| Category | Points | Meaning |
|---|---:|---|
| Task correctness | 40 | Diagnosis, quantitative answer, or triage decision is correct |
| Evidence quality | 20 | The conclusion cites decisive Kibana evidence |
| Goal coverage | 20 | Required investigation and interpretation goals were completed |
| Relevance | 10 | Actions remained focused on useful signals and appropriate Kibana surfaces |
| Efficiency | 10 | The route avoided excessive repetition; requested hints/demonstrations apply transparent deductions |

Demonstration remains unscored. Guided practice reports completion, help used, and evidence quality; Challenge reports the full score. Efficiency thresholds must be calibrated by scenario and must never punish reasonable exploration or accessibility-driven navigation.

## 12. Data and telemetry design

### 12.1 Shared field conventions

Use ECS-compatible and OpenTelemetry-compatible fields wherever practical so that skills transfer to real systems. Scenario data should consistently support:

- `@timestamp`
- `service.name`, `service.version`, `service.environment`, `service.node.name`
- `event.dataset`, `event.outcome`, `event.category`
- HTTP request/response fields and URL/route fields
- `trace.id`, `transaction.id`, `span.id`, `parent.id`
- Host, container, Kubernetes, cloud, and region dimensions where relevant
- Error type, message, stack-trace summary, and log level
- Duration and metric values in the units expected by Kibana applications
- A hidden run/scenario discriminator excluded from ordinary learner-facing views

### 12.2 Scenario signal design

Each scenario pack defines:

- The incident or analytical truth.
- Decisive evidence and at least one corroborating signal for intermediate/advanced scenarios.
- Normal background data and plausible distractors.
- Relative timing, shifted to the run's start time.
- Data volume sufficient for realistic distributions and visualizations.
- A stable representative document, trace, or entity for demonstrations.
- A solvability query used only by automated readiness tests.

### 12.3 Live versus seeded telemetry

Use live application traffic for trace topology, waterfall behavior, retry relationships, and trace/log correlation. Use seeded telemetry for longer time histories, cardinality exercises, alert history, and resource trends. Hybrid packs may combine a live trace with seeded historical context.

Do not simulate operational complexity merely to claim that a dataset is “live.” Learner-visible authenticity and determinism are the deciding criteria.

### 12.4 Time handling

Store fixtures with offsets from a scenario epoch and shift timestamps at provisioning. Saved objects must use relative or run-derived absolute windows. Assertions must tolerate ingestion delay but not expand the time range so far that the answer becomes obvious.

## 13. Read-only Kibana content

Baseline objects should use current Kibana 9.5.2 formats. Maintainers may use Lens to prepare panels, but Lens itself is never a learner surface. Packs may provide:

- Data views with a learner-friendly default field list.
- Discover sessions that establish a starting point without revealing the answer.
- Dashboards with intentional but realistic investigation affordances.
- Prebuilt visualization panels used only through Dashboard view mode.
- Dashboard controls, links, drilldowns, and annotations.
- Run-scoped alerting rules created through supported APIs by the controller where applicable.

The coach must not direct learners into edit mode or expose create, configure, clone, save, delete, mute, snooze, acknowledge, or reset operations. The lab validates filters, selections, drilldowns, inspected evidence, and submitted conclusions. Reset removes controller-created resources and recreates the baseline; there should be no learner-created content to clean up.

## 14. Kibana UI adapter work

Split the current monolithic UI automation into adapters by Kibana application:

```text
coach/adapters/
  common.ts
  discover.ts
  dashboard.ts
  apm.ts
  infrastructure.ts
  alerts.ts
```

Each adapter owns:

- Semantic command execution.
- Observation of relevant learner actions.
- Stable selectors and fallback selectors.
- Readiness checks for its surface.
- Human-readable failure diagnostics.

Maintain selectors in a versioned registry with contract tests against Kibana 9.5.2. Prefer accessible roles, labels, test subjects, URLs, and public application state over visual position or fragile CSS hierarchy.

The coach overlay must remain same-origin, avoid covering required controls, preserve keyboard navigation, and reposition itself for narrow views and flyouts.

## 15. Launcher and learner progression

Replace the single/random scenario choice with a catalog-driven launcher. It should allow filtering by:

- Kibana surface.
- Skill, such as KQL, dashboard interpretation, trace analysis, or alert triage.
- Difficulty.
- Signal type: logs, traces, metrics, alerts, or mixed.
- Scenario type: investigation, analysis, or triage.

Each card should show title, realistic brief, skills, difficulty, estimated duration, and availability. The learner then selects Demonstration, Guided, or Challenge. Capability-gated scenarios should either be hidden or clearly marked unavailable with a concise reason; they must never start and fail halfway through.

A later progress view may summarize competency coverage, but it is secondary to building and validating the scenario catalog.

## 16. Capability handling

Add a startup probe that records which free Basic-tier Kibana applications, alerting rule types, and Spaces features are usable in the running 9.5.2 installation.

Rules:

- The catalog must pass on the free Basic license with the project's documented default configuration; no scenario may depend on a paid or subscription-gated feature.
- Feature availability must be determined programmatically, not assumed from navigation labels.
- A pack declares every required capability and is enabled only when all are present.
- Payment-gated surfaces (the APM service map, SLOs, and machine learning) are excluded from the curriculum, so no progression path can require them.
- Alert triage must not depend on an external connector. The controller creates a conventional Kibana alerting rule with an empty actions list; action configuration is outside the curriculum.
- Set one stable, lab-only `xpack.encryptedSavedObjects.encryptionKey` value of at least 32 characters in the Kibana service. A generated startup key is insufficient because Kibana blocks alerting functions when no explicit key is configured.
- Provision the alert rule inside the run's Space through `POST /s/<space-id>/api/alerting/rule/<rule-id>`, using an Elasticsearch query or index-threshold rule and `actions: []`. Seed a uniquely tagged matching event, then poll until the rule succeeds and its alert is visible through the supported Kibana alert view/API.
- Delete the run-scoped rule and Space during cleanup. Do not write directly to Kibana's internal alert indices.
- Experimental UIs, including any trace-explorer functionality marked experimental in 9.5.2, should not be required by core scenarios.

Before implementation, run focused feasibility spikes for Spaces isolation, APM seeded/live data, infrastructure views, and pre-generated alerts. Record the actual API result in a compatibility manifest. The current running stack has already established that the alerting plugins are present and that the missing encryption key is the only reported alerting API blocker; the spike must confirm the complete create-match-display-cleanup cycle after that key is configured.

## 17. Implementation phases

### Phase 0 — Freeze scope and establish the compatibility baseline

1. Document Kibana 9.5.2 as the tested UI contract.
2. Inventory enabled applications, licenses, public APIs, and current saved-object versions.
3. Verify the feasibility spikes listed above.
4. Add the explicit learner-scope boundary to project documentation.
5. Confirm all planned scenarios rely only on free Basic-tier capabilities verified in the local stack.

Exit criteria: the compatibility manifest identifies every required capability, and no scenario relies on an unverified or paid-only feature.

### Phase 1 — Generalize the scenario engine

1. Add catalog, scenario v2, playbook v2, rubric v2, and command v2 schemas.
2. Implement scenario-pack loading and generic provisioning hooks.
3. Replace hard-coded readiness logic with declared validators.
4. Replace `ACTION_TO_GOAL` and latency-specific scoring with the goal graph and validator registry.
5. Add flexible answer schemas and scenario-type scoring.
6. Implement per-run Space lifecycle and controller-managed resource cleanup.
7. Convert `slow-payments` into the first v2 pack without changing its learner behavior.
8. Add catalog selection to the launcher.

Exit criteria: converted `slow-payments` passes all three modes through generic code, and the evaluator contains no scenario-ID branches.

### Phase 2 — Build the Discover/KQL foundation

Implement the seven Discover/KQL scenarios and their data packs. Expand the Discover adapter to cover time, data views, KQL, filters, columns, sorting, documents, field statistics, and surrounding documents.

Exit criteria: each scenario has a solvability test, complete demonstration, guided validation with progressive hints, and challenge path accepting at least one alternative valid approach.

### Phase 3 — Add ES|QL analysis

Implement the three ES|QL scenarios, query/result validators, and ES|QL-aware Discover observations. Ensure the coach explains the behavioral difference between data-view mode and ES|QL mode.

Exit criteria: queries are validated by their result semantics rather than exact source text, and switching query modes leaves no cross-scenario state behind.

### Phase 4 — Add read-only Dashboard workflows

Implement the three Dashboard scenarios plus adapters for filtering, controls, panel interaction, inspection, drilldowns, and underlying-data views. Every dashboard and panel is prebuilt by the lab.

Exit criteria: the learner can answer questions by interpreting and drilling through supplied dashboards, while tests prove that no playbook enters edit mode or saves content.

### Phase 5 — Expand traces and metrics

Implement the five APM/trace and four metrics/infrastructure scenarios. Reuse live services only where needed and add seeded history for slow trends or comparisons.

Exit criteria: correlation paths preserve time and identifying context; all packs have representative deterministic traces/entities; no learner task asks for service or cluster repair.

### Phase 6 — Add alert triage

Add the stable encrypted-saved-objects key, implement the controller's run-scoped no-action alert rule lifecycle, and prove that a matching event produces a visible alert. Then implement active alert triage, with the alert prepared before the learner enters Kibana. This uses only the free Basic-tier alerting framework.

Exit criteria: the scenario works without external connectors, the learner never sees a creation or configuration task, controller-created resources cannot leak between runs, and reset restores the baseline state.

### Phase 7 — Hardening and curriculum release

1. Run the complete scenario-by-mode test matrix.
2. Review difficulty, hints, scoring thresholds, and debrief clarity with novice users.
3. Remove answer leakage and scenario-specific code paths.
4. Add failure diagnostics, screenshots, videos, and run export for maintainers.
5. Document development guidance for future scenario packs.
6. Freeze a Kibana 9.5.2 selector and compatibility baseline.

Exit criteria: all core scenarios meet the definition of done below and can be run repeatedly from a clean checkout.

## 18. Test strategy

### 18.1 Static and unit tests

- Validate every catalog entry, scenario, playbook, rubric, and command against its schema.
- Reject duplicate IDs, missing files, goal cycles, unknown validators, and undeclared capabilities.
- Verify every reference action is supported by the declared Kibana adapter.
- Verify every truth assertion has at least one validator and every scored goal has an accepted route.
- Scan learner-facing fixtures and saved-object titles for answer leakage.
- Assert that no scenario action targets terminal, Dev Tools, Elasticsearch administration, or an external application.

### 18.2 Provisioning and solvability tests

- Provision each pack with a fixed seed.
- Wait on its declared readiness checks.
- Run hidden evidence queries and assert the truth is uniquely supported.
- Verify distractors exist but cannot satisfy the complete truth.
- Reset and reprovision, then compare expected counts and object inventory.
- Run two instances concurrently and prove resource/data isolation.

### 18.3 Kibana adapter contract tests

- Exercise each semantic command against Kibana 9.5.2.
- Confirm each learner action produces the expected normalized observation.
- Test primary and fallback selectors.
- Capture clear diagnostics when a target is missing or ambiguous.
- Cover keyboard navigation and coach-overlay placement for critical workflows.

### 18.4 End-to-end mode tests

For every core scenario:

- **Demonstration:** execute the complete reference path and validate every narrated result.
- **Guided:** use normalized learner actions to complete the reference route; request each hint tier in at least one test.
- **Challenge:** complete one accepted alternative route where applicable, submit the correct conclusion, and verify scoring/debrief.

Pull requests may shard this matrix by application adapter. A scheduled run should execute every scenario in every mode. Failures should retain coach events, browser console output, DOM snapshot, screenshot, video, Kibana version, scenario seed, and provisioner logs.

### 18.5 Baseline content and managed-resource tests

Read-only scenarios still need structural assertions for the content prepared by the lab, including:

- Supplied dashboard panels, controls, links, drilldowns, and expected underlying data.
- Starting Discover view query, columns, sort, and data view.
- Controller-created rule query/condition, lookback, interval, successful execution, and resulting visible alert.
- Absence of learner-created or learner-modified Kibana content after every mode run.

## 19. Acceptance criteria

The expansion is accepted when:

1. All 22 core scenarios appear in the catalog and run in Demonstration, Guided, and Challenge modes.
2. Each scenario starts and finishes entirely within the Kibana UI from the learner's perspective.
3. No learner objective concerns cluster, index, ingestion-pipeline, agent, snapshot, upgrade, or security administration.
4. Each scenario has deterministic provisioning, readiness, reset, and cleanup.
5. Demonstration can complete every reference path without manual intervention.
6. Guided mode validates semantic outcomes and provides three useful levels of help.
7. Challenge scoring accepts documented alternative valid paths and produces an evidence-based debrief.
8. Every scenario is read-only from the learner's perspective and contains realistic distractors; no playbook enters a create, edit, configure, or save workflow.
9. Concurrent runs cannot see each other's controller-created Kibana resources.
10. A scenario cannot launch when its declared free-tier capabilities are unavailable in the running installation.
11. The full core matrix passes against the pinned Kibana 9.5.2 environment.
12. A new scenario can be added as a pack plus reusable validators/adapters, without adding scenario-ID conditionals to the controller or evaluator.

## 20. Definition of done for one scenario

A scenario is not complete until it has:

- A credible production brief and an explicit Kibana competency outcome.
- Core classification and declared free-tier capabilities.
- Scenario, playbook, rubric, truth assertions, and answer schema.
- Seeded/live telemetry with realistic noise and relative timestamps.
- Starting saved objects that do not reveal the answer.
- Generic readiness and cleanup declarations.
- A complete narrated demonstration.
- Guided goals with progressive hints and optional demonstrations.
- Challenge scoring and a useful debrief.
- At least one accepted alternative route when Kibana offers one.
- Solvability, reset, isolation, adapter, and three-mode end-to-end tests.
- No learner-facing action outside Kibana and no hidden dependency on stack administration.

## 21. Recommended delivery order

The most efficient implementation order is:

1. Generalize the engine and convert the existing latency scenario.
2. Deliver Discover/KQL and ES|QL, because they establish query, filter, time, evidence, and validator primitives used everywhere else.
3. Deliver read-only Dashboard scenarios, because they introduce controls, panel interpretation, inspection, and drilldowns into reusable analysis views.
4. Deliver APM and metrics, reusing the query, time, drilldown, and evidence foundations.
5. Deliver alert triage once per-run controller-resource isolation is proven.

This order produces useful learner breadth early while avoiding a proliferation of hard-coded scenarios.

## 22. Maintainer deliverables

In addition to the scenario packs, implementation should produce:

- A scenario-pack development guide with a minimal template.
- A Kibana 9.5.2 capability/compatibility manifest.
- A semantic command and observation reference.
- A validator reference with examples of accepted alternatives.
- A selector maintenance guide for each Kibana adapter.
- A fixture-generation guide covering timestamps, run isolation, ECS/OTel conventions, distractors, and answer leakage.
- A test-matrix command for one pack, one application family, and the complete catalog.

## 23. Primary Kibana references

Implementation details should be checked against the pinned 9.5.2 UI and the current official documentation:

- [Discover](https://www.elastic.co/docs/explore-analyze/discover)
- [Getting started with Discover and ES|QL](https://www.elastic.co/docs/explore-analyze/discover/discover-get-started)
- [Field statistics in Discover](https://www.elastic.co/docs/explore-analyze/discover/show-field-statistics)
- [Panels and visualizations](https://www.elastic.co/docs/explore-analyze/visualize)
- [Explore dashboards](https://www.elastic.co/docs/explore-analyze/dashboards/using)
- [APM service overview](https://www.elastic.co/docs/solutions/observability/apm/service-overview)
- [APM traces](https://www.elastic.co/docs/solutions/observability/apm/traces-ui)
- [Alerting](https://www.elastic.co/docs/explore-analyze/alerts-cases/alerts/alerting-getting-started)
- [View alerts](https://www.elastic.co/docs/explore-analyze/alerting/alerts/view-alerts)
- [Create a rule API](https://www.elastic.co/docs/api/doc/kibana/operation/operation-post-alerting-rule-id)
- [Alerting configuration](https://www.elastic.co/docs/reference/kibana/configuration-reference/alerting-settings)

The documentation is guidance; the automated adapter contract tests against Kibana 9.5.2 are the final authority for the lab.
