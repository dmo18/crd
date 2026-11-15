#!/bin/sh
# Card Vault backup inside the container: database (online copy) plus photos.
# Run by a Coolify Scheduled Task: sh scripts/container/backup.sh
# Writes DATA_DIR/backups/cardvault-<date>-<time>.tar.gz and keeps the newest 14.
# Never includes settings or secrets: those live only in Coolify, not on disk.
set -eu

KEEP=14
DATA="${DATA_DIR:-/data}"
BACKUPS="$DATA/backups"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$DATA/crd.db" ]; then
  echo "No database at $DATA/crd.db yet. Backup skipped."
  exit 1
fi

umask 077
mkdir -p "$BACKUPS"
stamp="$(date -u '+%Y%m%d-%H%M%S')"
final="$BACKUPS/cardvault-$stamp.tar.gz"
stage="$(mktemp -d "$BACKUPS/.stage-XXXXXX")"
trap 'rm -rf "$stage"' EXIT INT TERM

# SQLite's own backup, safe while the app is running.
node "$HERE/../backup-db.mjs" "$DATA/crd.db" "$stage/crd.db" >/dev/null

tar -cf "$stage/backup.tar" -C "$stage" crd.db
if [ -d "$DATA/uploads" ]; then
  tar -rf "$stage/backup.tar" -C "$DATA" uploads
fi
gzip -1 -c "$stage/backup.tar" >"$stage/backup.tar.gz"
mv "$stage/backup.tar.gz" "$final"

# Keep the newest $KEEP. Names are generated above, so they hold no spaces.
ls -1t "$BACKUPS"/cardvault-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r old; do
  rm -f -- "$old"
done

size="$(du -h "$final" | cut -f1)"
echo "Backup saved: $final ($size)"
