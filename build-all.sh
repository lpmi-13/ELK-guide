#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
docker compose up --build -d --wait

# Runs live only in the scenario controller's memory, so whatever a run it no longer knows left
# behind (an earlier controller's runs, abandoned or completed) can never be reached again: its Kibana
# Space, its indices, aliases and data streams, a fault still held by a service. The controller
# removes them when it starts; ask again here because `up` leaves an unchanged controller running.
# Live runs are never touched. RECLAIM_ORPHANED_RUNS=false keeps them.
printf '\nRemoving Spaces, data and faults left by earlier lab runs...\n'
if ! docker compose exec -T scenario-controller python - <<'PY'
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

if os.getenv("RECLAIM_ORPHANED_RUNS", "true").lower() == "false":
    print("Skipped: RECLAIM_ORPHANED_RUNS=false.")
    sys.exit(0)
request = Request(f"http://localhost:{os.getenv('PORT', '8092')}/api/orphans/reclaim", data=b"{}", method="POST",
                  headers={"Content-Type": "application/json"})
try:
    with urlopen(request, timeout=1800) as response:
        reclaimed = json.load(response)["reclaimed"]
except HTTPError as error:
    sys.exit(f"The scenario controller could not remove them: {error.read().decode(errors='replace')}")
except (OSError, URLError) as error:
    sys.exit(f"The scenario controller did not answer: {error}")
print(f"Removed {len(reclaimed)} left-over lab run(s)." if reclaimed else "No left-over lab runs remain.")
PY
then
    printf 'Warning: left-over lab runs were not removed; the lab still works. Rerun ./build-all.sh to retry.\n' >&2
fi

printf '\nLab ready. Open http://localhost:8090/ in your browser.\n'
