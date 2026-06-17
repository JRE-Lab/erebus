#!/usr/bin/env bash
# EREBUS v2 deploy — build, migrate, seed, run. From repo root on the VPS.
# Requires a populated .env (see .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "ERROR: .env missing (copy .env.example)"; exit 1; }
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env"

echo "[deploy] building images ..."
$COMPOSE build

echo "[deploy] starting data layer ..."
$COMPOSE up -d postgres redis
sleep 8

echo "[deploy] migrating + seeding ..."
$COMPOSE run --rm worker pnpm --filter @erebus/db migrate
$COMPOSE run --rm worker pnpm --filter @erebus/db seed

echo "[deploy] starting web + worker ..."
$COMPOSE up -d web worker

echo ""
echo "[deploy] done."
echo "  Web/API : http://159.203.86.148:4000  (API at /api)"
$COMPOSE ps
