# Validator reference

Validators are registered in `learning-service/engine/evaluator.py` and composed inside playbook accepted routes.

- `time_range_contains` / `time_range_overlaps`: validates selected time context.
- `query_contains` / `query_language`: validates important fields, values, and KQL/ES|QL mode without requiring exact formatting.
- `filter_contains` / `filter_excludes`: accepts filter pills and equivalent normalized filter state.
- `result_assertion`: connects current investigation state to a hidden evidence query.
- `result_count`: checks a visible result threshold.
- `detail_equals` / `state_equals`: checks normalized observation or application state.
- `inspected` / `selected_entity`: verifies a document, field, trace element, service, or alert was inspected.
- `app_is`: verifies application context.
- `resource_isolated`: verifies the controller-managed resource belongs to the run.
- `answer_submitted`: completes the structured deliverable goal.

Routes are alternatives: a goal can accept KQL, filters, ES|QL, a dashboard interaction, or another semantically equivalent path. Dependencies prevent one click from completing a later interpretation goal before its prerequisite is established.
