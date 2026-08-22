"""Create a useful historical data set before the live services start."""

import json
import os
import random
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

services = ["api-gateway", "auth", "catalog", "orders", "payments", "browser-telemetry"]
messages = ["request completed", "database query completed", "cache miss", "downstream request completed"]
levels = ["INFO"] * 17 + ["WARN"] * 2 + ["ERROR"]
count = int(os.getenv("SEED_COUNT", "500"))
destination = Path(os.getenv("LOG_DIR", "/tmp")) / "seed.json"
destination.parent.mkdir(parents=True, exist_ok=True)

with destination.open("w", encoding="utf-8") as output:
    for index in range(count):
        status = random.choice([200] * 14 + [201, 400, 404, 500])
        event = {
            "@timestamp": (datetime.now(timezone.utc) - timedelta(seconds=count - index)).isoformat(),
            "log.level": random.choice(levels),
            "message": random.choice(messages),
            "service.name": random.choice(services),
            "service.environment": "demo",
            "http.request.method": random.choice(["GET", "GET", "POST", "PUT"]),
            "http.response.status_code": status,
            "event.duration": random.randint(500_000, 800_000_000),
            "trace.id": uuid.uuid4().hex,
            "labels.seeded": True,
        }
        output.write(json.dumps(event, separators=(",", ":")) + "\n")
print(f"wrote {count} seed events to {destination}")
