#!/usr/bin/env bash
# Daily backup: database (online copy) plus photos. Never includes .env.local.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

KEEP=14
if [ ! -f "$CV_DATA/crd.db" ]; then
  log "No database at $CV_DATA/crd.db. Backup skipped."
  exit 1
fi

stamp="$(date '+%Y%m%d-%H%M%S')"
final="$CV_BACKUPS/cardvault-$stamp.tar.gz"
stage="$(mktemp -d "$CV_BACKUPS/.stage-XXXXXX")"
trap 'rm -rf "$stage"' EXIT

# The script lives in the release folder: scripts/server/ -> scripts/backup-db.mjs
node "$HERE/../backup-db.mjs" "$CV_DATA/crd.db" "$stage/crd.db" >/dev/null

tar -cf "$stage/backup.tar" -C "$stage" crd.db
if [ -d "$CV_DATA/uploads" ]; then
  tar -rf "$stage/backup.tar" -C "$CV_DATA" uploads
fi
gzip -1 -c "$stage/backup.tar" >"$stage/backup.tar.gz"
mv "$stage/backup.tar.gz" "$final"
chmod 600 "$final"

# Keep the newest $KEEP.
count=0
while IFS= read -r f; do
  count=$((count + 1))
  if [ "$count" -gt "$KEEP" ]; then
    rm -f -- "$f"
  fi
done < <(ls -1t "$CV_BACKUPS"/cardvault-*.tar.gz 2>/dev/null || true)

size="$(du -h "$final" | cut -f1)"
log "Backup saved: $final ($size)"
