#!/usr/bin/env bash
# Invoked by the playground init task after vm.max_map_count is set.
set -euo pipefail
cd /home/laborant/ELK-guide

while IFS= read -r image; do
  if ! docker image inspect "${image}" >/dev/null 2>&1; then
    echo "Loading the prebuilt ELK stack images..."
    docker load -i /opt/elk-guide/images.tar
    break
  fi
done < <(docker compose config --images)

cat > .env <<'EOF'
STACK_VERSION=9.5.2
ELASTIC_PASSWORD=local-development-only
LOG_INTERVAL_SECONDS=2
SCENARIO=slow-payments
SCENARIO_SEED=20260822
SCENARIO_AUTO_START=true
SCENARIO_TRACK=mvp
KIBANA_GATEWAY_BIND=0.0.0.0
PUBLIC_KIBANA_URL=
PUBLIC_LAUNCHER_URL=/launcher
TELEMETRY_KIBANA_URL=same-origin
TELEMETRY_LEARNING_URL=same-origin
EOF

LAB_PREBUILT=1 ./build-all.sh
echo "Lab ready. Open the Lab launcher tab."
