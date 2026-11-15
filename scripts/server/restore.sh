#!/usr/bin/env bash
# Restore a backup made by backup.sh. Usage: restore.sh [--yes] <backup file>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

yes=0
file=""
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) file="$arg" ;;
  esac
done
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "Usage: restore.sh [--yes] <backup file>" >&2
  exit 2
fi

# Check the archive before touching anything.
if ! tar -tzf "$file" >/dev/null 2>&1; then
  log "That file is not a readable backup."
  exit 1
fi
if tar -tzf "$file" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  log "Backup contains unsafe paths. Refusing."
  exit 1
fi
if ! tar -tzf "$file" | grep -qx 'crd.db'; then
  log "Backup has no database (crd.db). Refusing."
  exit 1
fi

if [ "$yes" -ne 1 ]; then
  echo "This replaces all current data (database and photos) with the backup:"
  echo "  $file"
  echo "The current data is kept aside, not deleted."
  printf 'Type RESTORE to continue: '
  read -r answer
  if [ "$answer" != "RESTORE" ]; then
    echo "Cancelled."
    exit 1
  fi
fi

stamp="$(date '+%Y%m%d-%H%M%S')"
incoming="$CV_SHARED/data.restoring-$stamp"
aside="$CV_SHARED/data.before-restore-$stamp"
mkdir -p "$incoming"
if ! tar -xzf "$file" -C "$incoming"; then
  rm -rf "$incoming"
  log "Could not unpack the backup. Nothing was changed."
  exit 1
fi
mkdir -p "$incoming/uploads"

"$HERE/stop.sh"
if [ -e "$CV_DATA" ]; then
  mv "$CV_DATA" "$aside"
  log "Current data moved to $aside"
fi
mv "$incoming" "$CV_DATA"
log "Restored from $file"

if "$HERE/start.sh"; then
  log "Restore finished and the app is healthy."
else
  log "Restored, but the app did not become healthy. See $CV_APP_LOG"
  exit 1
fi
