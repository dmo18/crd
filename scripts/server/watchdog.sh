#!/usr/bin/env bash
# Run by cron every minute. Restarts the app if it stops answering.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

LOCK="$CV_SHARED/watchdog.lock"
use_mkdir=0
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK.flock"
  flock -n 9 || exit 0
else
  use_mkdir=1
  if ! mkdir "$LOCK.d" 2>/dev/null; then
    # Stale if older than 10 minutes.
    if [ -n "$(find "$LOCK.d" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      rmdir "$LOCK.d" 2>/dev/null || true
      mkdir "$LOCK.d" 2>/dev/null || exit 0
    else
      exit 0
    fi
  fi
  trap 'rmdir "$LOCK.d" 2>/dev/null || true' EXIT
fi
: "$use_mkdir"

# Keep app.log small: copy then empty (the app keeps its file open), keep 3 old.
max_bytes=$((20 * 1024 * 1024))
if [ -f "$CV_APP_LOG" ]; then
  size="$(wc -c <"$CV_APP_LOG" | tr -d '[:space:]')"
  if [ "$size" -gt "$max_bytes" ]; then
    rm -f "$CV_APP_LOG.3"
    [ -f "$CV_APP_LOG.2" ] && mv "$CV_APP_LOG.2" "$CV_APP_LOG.3"
    [ -f "$CV_APP_LOG.1" ] && mv "$CV_APP_LOG.1" "$CV_APP_LOG.2"
    cp "$CV_APP_LOG" "$CV_APP_LOG.1"
    : >"$CV_APP_LOG"
    log "Rotated app.log (was $size bytes)."
  fi
fi

if health_ok; then
  exit 0
fi
sleep 5
if health_ok; then
  exit 0
fi

log "Health check failed twice. Restarting."
"$HERE/stop.sh" || log "stop.sh reported a problem."
if "$HERE/start.sh"; then
  log "Restart succeeded."
else
  log "Restart failed."
  exit 1
fi
