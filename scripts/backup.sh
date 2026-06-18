#!/usr/bin/env bash
# Nightly Postgres backup for EREBUS. Dumps the DB to /opt/erebus-backups,
# gzip'd + timestamped, keeping the most recent 14. Install via cron (see below).
#   0 4 * * * /opt/erebus/scripts/backup.sh >> /var/log/erebus-backup.log 2>&1
set -euo pipefail

DIR=/opt/erebus-backups
KEEP=14
mkdir -p "$DIR"
TS=$(date +%Y%m%d_%H%M%S)
OUT="$DIR/erebus_${TS}.sql.gz"

cd "$(dirname "$0")/.."
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U erebus -d erebus | gzip > "$OUT"

# prune all but the newest $KEEP
ls -1t "$DIR"/erebus_*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "$(date -Is) backup ok -> $OUT ($(du -h "$OUT" | cut -f1))"
