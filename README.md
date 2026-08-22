# ELK microservices observability demo

A self-contained Docker Compose lab with Elasticsearch, Logstash, Kibana, five small HTTP microservices, and a browser telemetry service. It creates 500 historical events on first start and then continuously produces structured, correlated JSON logs.

## Architecture

| Component | Purpose | Host port |
| --- | --- | --- |
| Elasticsearch | Stores and searches the events | `9200` |
| Logstash | Tails JSON files and indexes events | `5044`, `9600` |
| Kibana | Explore and visualize the logs | `5601` |
| API gateway | Calls auth, catalog, and orders | `8080` |
| Auth | Simulates identity work | internal `8081` |
| Catalog | Simulates product work | internal `8082` |
| Orders | Calls catalog and payments | internal `8083` |
| Payments | Simulates payment work | internal `8084` |
| Browser telemetry | WebSocket collector and Kibana workspace | `8090` |

Every service is a real, dependency-free Python HTTP server. Background jobs generate activity even when no requests arrive. Gateway and order calls propagate a `trace.id`, making distributed request flows discoverable.

## Run it

Docker Engine with Compose v2 and roughly 2 GB of available memory are required.

```sh
cp .env.example .env
docker compose up --build -d
docker compose ps
```

Wait until Kibana is healthy, then open the instrumented workspace at <http://localhost:8090>. It embeds Kibana and sends dashboard session, focus, visibility, pointer, resize, and active-session events over a bidirectional WebSocket. Server acknowledgements are displayed through the connection indicator. Because browser cross-origin isolation prevents inspecting Kibana's internal DOM, a focused click after the pointer enters the dashboard is recorded as `dashboard_interaction` without capturing private click content.

In Kibana, open **Management → Stack Management → Data Views**, create a data view named `microservices-*`, and select `@timestamp` as its time field. Use **Discover** to inspect both application events and the telemetry events in the `kibana.browser` dataset.

Try generating a request and an intentional error:

```sh
curl http://localhost:8080/items
curl http://localhost:8080/error
curl 'http://localhost:9200/microservices-*/_count?pretty'
```

Useful Kibana queries include:

```text
service.name: orders
log.level: ERROR
http.response.status_code >= 500
labels.seeded: true
event.dataset: kibana.browser
```

Change `SEED_COUNT` in `docker-compose.yml` or `LOG_INTERVAL_SECONDS` in `.env` to control volume. Re-run the one-shot seed job with `docker compose run --rm log-seeder`.

## Operations

Follow ingestion with `docker compose logs -f logstash` and application traffic with `docker compose logs -f api-gateway orders`. Stop the lab with `docker compose down`; add `--volumes` to also delete Elasticsearch data and all generated logs.

This configuration disables authentication and uses development-sized JVM heaps. It is intentionally suitable only for a local learning environment, not production.
