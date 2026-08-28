#!/bin/sh
set -eu

KIBANA_INTERNAL_URL="${KIBANA_INTERNAL_URL:-http://kibana:5601}"
SETUP_FILE="${KIBANA_SAVED_OBJECTS:-/setup/saved-objects.ndjson}"

until curl --fail --silent "${KIBANA_INTERNAL_URL}/api/status" >/dev/null; do
  sleep 2
done

curl --fail --silent --show-error \
  -H 'kbn-xsrf: incident-lab-setup' \
  -F "file=@${SETUP_FILE};type=application/ndjson" \
  "${KIBANA_INTERNAL_URL}/api/saved_objects/_import?overwrite=true"

echo "Kibana incident-lab saved objects imported"
