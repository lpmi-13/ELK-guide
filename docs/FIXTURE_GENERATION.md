# Fixture and telemetry guide

Seed profiles are declared in scenario packs and expanded by the controller with a fixed numeric seed. Timestamps are offsets from run creation; run IDs and Space IDs remain unique. Every document receives private `lab.run_id` and `lab.scenario_id` discriminators, while the Space-local data view points at the run index.

Use ECS and OpenTelemetry field conventions where practical: `@timestamp`, service identity/version/environment, event category/type/outcome/duration, HTTP fields, trace/transaction/span IDs, error fields, and infrastructure dimensions. A signal needs enough volume to produce a visible distribution, realistic background noise, plausible distractors, and at least one stable corroborating event.

Do not put expected answers in learner-facing titles, URLs, messages, saved-object names, or prefilled queries. Truth belongs in controller-only assertions and answer mappings. A reset must recreate equivalent seeded content for the same scenario key while using a new run identity.

Validate fixtures with `python scripts/validate-scenarios.py`; validate reference routes with `python scripts/test-scenario-matrix.py --scenario <id>`; and validate real Space, data, readiness, and cleanup lifecycles with `python tests/live_scenario_matrix.py --scenario <id>`.
