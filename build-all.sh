#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
docker compose up --build -d --wait

printf '\nLab ready. Open http://localhost:8090/ in your browser.\n'
