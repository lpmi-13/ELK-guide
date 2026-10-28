#!/usr/bin/env python3
"""Generate kibana/saved-objects.ndjson: the data view, the Discover search, Lens panels and the
supplied dashboards.

Legacy aggregation-based XY visualizations throw in Kibana 9.5.2 and offer no Inspect / Explore in
Discover actions, so every panel is a Lens visualization. The data view and the Discover search are
kept from the existing file; everything else is rebuilt, so edit panels and dashboards here rather
than in the ndjson. `--check` exits non-zero when the file differs from what this script writes.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SAVED_OBJECTS = ROOT / "kibana" / "saved-objects.ndjson"
DATA_VIEW = "microservices"
DURATION = {"id": "duration", "params": {"decimals": 0, "fromUnit": "nanoseconds", "toUnit": "asMilliseconds", "useShortSuffix": True}}


def count(label):
    return {"label": label, "customLabel": True, "dataType": "number", "operationType": "count", "isBucketed": False, "scale": "ratio", "sourceField": "___records___", "params": {"emptyAsNull": True}}


def average(field, label, fmt=DURATION):
    return {"label": label, "customLabel": True, "dataType": "number", "operationType": "average", "isBucketed": False, "scale": "ratio", "sourceField": field, "params": {"emptyAsNull": True, "format": fmt}}


def percentile(field, value):
    return {"label": f"p{value}", "customLabel": True, "dataType": "number", "operationType": "percentile", "isBucketed": False, "scale": "ratio", "sourceField": field, "params": {"percentile": value, "format": DURATION}}


def terms(field, label, order_by, size=8, data_type="string"):
    return {"label": label, "customLabel": True, "dataType": data_type, "operationType": "terms", "scale": "ordinal", "sourceField": field, "isBucketed": True,
            "params": {"size": size, "orderBy": {"type": "column", "columnId": order_by}, "orderDirection": "desc", "otherBucket": False, "missingBucket": False, "parentFormat": {"id": "terms"}}}


def over_time():
    return {"label": "@timestamp", "dataType": "date", "operationType": "date_histogram", "sourceField": "@timestamp", "isBucketed": True, "scale": "interval", "params": {"interval": "auto", "includeEmptyRows": True, "dropPartials": False}}


def lens(identifier, title, description, query, columns, order, visualization, visualization_type="lnsXY"):
    return {
        "type": "lens", "id": identifier, "coreMigrationVersion": "8.8.0", "typeMigrationVersion": "8.9.0",
        "attributes": {
            "title": title, "description": description, "visualizationType": visualization_type,
            "state": {
                "datasourceStates": {"formBased": {"layers": {"layer": {"columns": columns, "columnOrder": order, "incompleteColumns": {}}}}},
                "visualization": visualization,
                "query": {"query": query, "language": "kuery"}, "filters": [], "adHocDataViews": {}, "internalReferences": [],
            },
        },
        "references": [{"type": "index-pattern", "id": DATA_VIEW, "name": "indexpattern-datasource-layer-layer"}],
    }


def xy(series_type, accessors, x, split=None, legend=True):
    layer = {"layerId": "layer", "accessors": accessors, "position": "top", "seriesType": series_type, "showGridlines": False, "layerType": "data", "xAccessor": x}
    if split:
        layer["splitAccessor"] = split
    return {"legend": {"isVisible": legend, "position": "right", "showSingleSeries": legend}, "valueLabels": "hide", "fittingFunction": "None", "preferredSeriesType": series_type, "layers": [layer]}


def breakdown(identifier, title, description, query, field, label, metric, data_type="string"):
    """A bar per value of `field`, coloured by that same value so the legend lists each one: clicking a
    bar or a legend entry's "Filter for" filters every panel to it."""
    columns = {"value": terms(field, label, "metric", data_type=data_type), "series": terms(field, label, "metric", data_type=data_type), "metric": metric}
    return lens(identifier, title, description, query, columns, ["value", "series", "metric"], xy("bar_stacked", ["metric"], "value", "series"))


def timeline(identifier, title, description, query, metrics, series_type="bar_stacked"):
    columns = {"time": over_time(), **metrics}
    return lens(identifier, title, description, query, columns, ["time", *metrics], xy(series_type, list(metrics), "time", legend=len(metrics) > 1))


def table(identifier, title, description, query, field, label, metric):
    columns = {"value": terms(field, label, "metric", size=10), "metric": metric}
    visualization = {"layerId": "layer", "layerType": "data", "columns": [{"columnId": "value"}, {"columnId": "metric"}], "sorting": {"columnId": "metric", "direction": "desc"}}
    return lens(identifier, title, description, query, columns, ["value", "metric"], visualization, "lnsDatatable")


PANELS = [
    timeline("requests-over-time", "Requests over time", "Every request in the run, over time.", "", {"metric": count("Requests")}),
    timeline("error-rate-over-time", "5xx events over time", "Requests that returned a server error, over time.", "http.response.status_code >= 500", {"metric": count("5xx events")}),
    timeline("request-duration-percentiles", "Request duration percentiles", "Median, p95 and p99 request duration over time.", "event.duration:*",
             {"p50": percentile("event.duration", 50), "p95": percentile("event.duration", 95), "p99": percentile("event.duration", 99)}, "line"),
    breakdown("failures-by-service", "Failures by service", "Failed requests, split by the service that served them.", "event.outcome:failure", "service.name.keyword", "Service", count("Failed requests")),
    table("slowest-endpoints", "Slowest endpoints", "Endpoints ranked by average request duration.", "event.duration:* and url.path:*", "url.path.keyword", "Endpoint", average("event.duration", "Average duration")),
    table("common-error-types", "Common error types", "Error documents grouped by error type.", "error.type:*", "error.type.keyword", "Error type", count("Errors")),
    breakdown("failures-by-region", "Failures by region", "Failed requests, split by the cloud region that served them.", "event.outcome:failure", "cloud.region.keyword", "Region", count("Failed requests")),
    breakdown("latency-by-throughput", "Latency by throughput level", "Average request duration at each sustained request rate (requests/second).", "throughput.requests_per_second:*",
              "throughput.requests_per_second", "Requests/second", average("event.duration", "Average duration"), data_type="number"),
    timeline("payment-errors-all-events", "Payment errors (all events)", "Every payments event with a failure outcome, over time.", "service.name:payments and event.outcome:failure", {"metric": count("Payment errors")}),
    breakdown("failed-payment-transactions", "Failed payment transactions", "Failed payments transactions, by the metric they report.", "service.name:payments and processor.event:transaction and event.outcome:failure",
              "panel.metric.keyword", "Metric", count("Failed transactions")),
]

# Each dashboard pack opens its own dashboard (its scenario's starting_view.saved_object), and the panel
# its playbook names in `variables.panel` must be on it; tests/test_contracts.py checks both.
GENERIC = ["failures-by-service", "requests-over-time", "error-rate-over-time", "request-duration-percentiles", "slowest-endpoints", "common-error-types"]
DASHBOARDS = [
    ("incident-overview", "Incident overview", "Starting dashboard for the adaptive incident lab.", GENERIC),
    ("checkout-regional-overview", "Checkout regional overview", "Request health across services and the cloud regions that serve them.",
     ["failures-by-region", "failures-by-service", "requests-over-time", "error-rate-over-time", "request-duration-percentiles", "common-error-types"]),
    ("checkout-capacity-overview", "Checkout capacity overview", "Request rate, latency and errors for capacity reviews.",
     ["latency-by-throughput", "request-duration-percentiles", "requests-over-time", "error-rate-over-time", "slowest-endpoints", "failures-by-service"]),
    ("payments-overview", "Payments overview", "Payments failures as two teams chart them.",
     ["payment-errors-all-events", "failed-payment-transactions", "requests-over-time", "failures-by-service", "request-duration-percentiles", "common-error-types"]),
]


def dashboard(identifier, title, description, panel_ids):
    panels, references = [], []
    for index, panel_id in enumerate(panel_ids):
        panels.append({"version": "9.5.2", "type": "lens", "gridData": {"x": (index % 2) * 24, "y": (index // 2) * 15, "w": 24, "h": 15, "i": str(index + 1)},
                       "panelIndex": str(index + 1), "embeddableConfig": {}, "panelRefName": f"panel_{index}"})
        references.append({"name": f"panel_{index}", "type": "lens", "id": panel_id})
    return {
        "type": "dashboard", "id": identifier, "coreMigrationVersion": "8.8.0", "typeMigrationVersion": "8.9.0",
        "attributes": {
            "title": title, "description": description, "panelsJSON": json.dumps(panels, separators=(",", ":")),
            "optionsJSON": json.dumps({"useMargins": True, "syncColors": False, "syncCursor": True, "syncTooltips": False, "hidePanelTitles": False}, separators=(",", ":")),
            "timeRestore": True, "timeFrom": "now-10m", "timeTo": "now",
            "kibanaSavedObjectMeta": {"searchSourceJSON": json.dumps({"query": {"query": "", "language": "kuery"}, "filter": []}, separators=(",", ":"))},
        },
        "references": references,
    }


def render(existing):
    """The ndjson for `existing` (the current file's text): its data view and search, then the panels
    and dashboards defined above."""
    keep = [item for item in (json.loads(line) for line in existing.splitlines() if line.strip()) if item["type"] in {"index-pattern", "search"}]
    objects = keep + PANELS + [dashboard(*spec) for spec in DASHBOARDS]
    return "".join(json.dumps(item, separators=(",", ":")) + "\n" for item in objects)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("path", nargs="?", type=Path, default=SAVED_OBJECTS)
    parser.add_argument("--check", action="store_true", help="report whether the file is up to date without writing it")
    args = parser.parse_args()
    existing = args.path.read_text(encoding="utf-8")
    generated = render(existing)
    if args.check:
        if generated != existing:
            raise SystemExit(f"{args.path} is out of date: run python scripts/generate-saved-objects.py")
        print(f"{args.path} is up to date")
        return
    args.path.write_text(generated, encoding="utf-8")
    print(f"wrote {generated.count(chr(10))} objects to {args.path}")


if __name__ == "__main__":
    main()
