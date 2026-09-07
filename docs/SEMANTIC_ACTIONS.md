# Semantic command and observation reference

Protocol version 2 separates learner intent from Kibana DOM details. Commands are declared in `learning/schemas/command.schema.json`; normalized observations are declared in `learning/schemas/action.schema.json`.

Application families:

- Common: navigation, saved objects, time, refresh, auto-refresh.
- Discover: data views, KQL/ES|QL, filters, columns, sorting, documents, field statistics, surrounding documents.
- Dashboard: controls, panel values, drilldowns, inspection, underlying data.
- APM: services, environments, transaction groups, trace samples, spans, errors, correlated logs.
- Infrastructure: inventory, entities, grouping, metrics, period comparison, logs pivot.
- Alerts: open/filter/inspect and source-evidence pivots.

Adapters live in `kibana-coach/src/adapters/`. Observations describe semantic outcomes such as `panel_underlying_data_opened`; goal evaluation never consumes CSS selectors or screen coordinates.
