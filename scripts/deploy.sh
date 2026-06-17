#!/usr/bin/env bash
# EREBUS v2 deploy — builds and (re)starts the production stack via Docker Compose.
# Run from the repo root on the VPS. Requires a populated .env (see .env.example).
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

echo "[deploy] building images ..."
docker compose -f docker-compose.prod.yml --env-file .env build

echo "[deploy] starting stack ..."
docker compose -f docker-compose.prod.yml --env-file .env up -d

echo "[deploy] waiting for Postgres ..."
sleep 8

echo "[deploy] applying schema + seeding sources ..."
docker compose -f docker-compose.prod.yml --env-file .env exec -T api pnpm --filter @erebus/db push || true
docker compose -f docker-compose.prod.yml --env-file .env exec -T api pnpm --filter @erebus/db seed || true

echo ""
echo "[deploy] done."
echo "  Web : http://$(curl -s ifconfig.me 2>/dev/null || echo SERVER_IP):4000"
echo "  API : http://$(curl -s ifconfig.me 2>/dev/null || echo SERVER_IP):4001/health"
docker compose -f docker-compose.prod.yml ps
