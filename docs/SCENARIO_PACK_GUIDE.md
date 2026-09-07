# Scenario pack development guide

Kibana 9.5.2 scenarios live under `learning/scenarios/<scenario-id>/` and contain `scenario.json`, `playbook.json`, and `rubric.json`. Add the pack to `learning/catalog.json`; the launcher and controller do not contain scenario-ID branches.

`scenario.json` declares the production brief, type, capabilities, provisioning strategies, starting view, hidden truth assertions, answer fields, and cleanup. Learner steps may target Kibana only. Shells, Dev Tools, external applications, create/edit/save flows, and Elasticsearch administration are rejected by contract checks.

Playbooks are goal graphs. A goal has dependencies, one or more accepted normalized observations, reusable validators, a demonstration reference action, and at least three progressive hints. A pack may extend a versioned application template in `learning/templates/playbooks/`; descriptor variables configure the reusable graph without changing evaluation semantics. Rubrics can likewise extend a scenario-type template.

Minimal workflow:

1. Copy the nearest existing pack.
2. Give the scenario a unique catalog ID and declare every required capability.
3. Define a deterministic signal, realistic noise, and at least one corroborating event.
4. Add truth assertions and ensure playbook validators reference each assertion.
5. Define answer fields appropriate to `diagnosis`, `comparison`, or `triage_decision`.
6. Run `python scripts/validate-scenarios.py`.
7. Run `python scripts/test-scenario-matrix.py --scenario <id>`.
8. With the stack running, run `python tests/live_scenario_matrix.py --scenario <id>` and exercise its three UI modes before classifying the pack as core.

The controller shifts event timestamps to run creation, creates a run Space, imports baseline objects, points the Space-local data view at the run index, and removes the Space and data on cleanup. Managed resources must use supported Kibana APIs and be scoped to the run Space.
