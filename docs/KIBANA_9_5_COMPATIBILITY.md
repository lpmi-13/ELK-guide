# Kibana 9.5.2 compatibility baseline

The machine-readable baseline is `learning/compatibility/kibana-9.5.2.json`. At runtime the controller also probes Kibana status, Spaces, and alerting rule types. A catalog entry is launchable only when all declared capabilities are available.

Every catalog scenario uses only free, open-source Basic-tier Kibana features. The Basic-license baseline covers Discover, ES|QL, Dashboard view mode, APM traces, infrastructure views, Spaces, saved-object import, and no-action alerting — and the catalog requires nothing beyond it. Payment-gated surfaces that Kibana 9.5.2 restricts to Platinum or higher (the APM service map, SLOs) and the machine-learning subscription surface were removed, along with the unverified Maps and Synthetics extensions, so no scenario depends on a licensed capability.

Spaces are created with `POST /api/spaces/space`; saved objects are imported through the Space-aware import API. Alert triage uses a Space-scoped `.es-query` rule with `actions: []`, and waits for a successful rule execution. The controller never writes to Kibana internal indices.

When changing the Stack version, update the compatibility manifest only after the application adapter contracts, managed-resource lifecycle, and complete scenario-mode matrix pass.
