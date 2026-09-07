# Kibana 9.5.2 compatibility baseline

The machine-readable baseline is `learning/compatibility/kibana-9.5.2.json`. At runtime the controller also probes Kibana status, Spaces, alerting rule types, SLO APIs, and the Elasticsearch license for service-map access. A catalog entry is launchable only when all declared capabilities are available.

The Basic-license baseline covers Discover, ES|QL, Dashboard view mode, APM traces, infrastructure views, Spaces, saved-object import, and no-action alerting. The target catalog still includes `service-map-bottleneck` and `slo-budget-burn`, but Kibana 9.5.2 gates both surfaces behind Platinum or higher on the local installation; the launcher therefore marks them unavailable unless their runtime probes succeed. Maps, Synthetics, and machine learning remain capability-gated extensions.

Spaces are created with `POST /api/spaces/space`; saved objects are imported through the Space-aware import API. Alert triage uses a Space-scoped `.es-query` rule with `actions: []`, and waits for a successful rule execution. SLOs are created in the run Space through the Observability SLO API. The controller never writes to Kibana internal indices.

When changing the Stack version, update the compatibility manifest only after the application adapter contracts, managed-resource lifecycle, and complete scenario-mode matrix pass.
