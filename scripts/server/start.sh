#!/usr/bin/env bash
# Start Card Vault in the background, bound to 127.0.0.1 only.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

if health_ok; then
  log "Already running and healthy on port $PORT. Nothing to do."
  exit 1
fi
if [ ! -d "$CV_CURRENT" ]; then
  log "No active release at $CV_CURRENT."
  exit 1
fi

cd "$CV_CURRENT"
export NODE_ENV=production
export NODE_OPTIONS="--max-old-space-size=512"

launcher=(nohup)
if command -v setsid >/dev/null 2>&1; then
  launcher=(setsid nohup)
fi

log "Starting on 127.0.0.1:$PORT from $(pwd -P)"
"${launcher[@]}" node node_modules/next/dist/bin/next start -p "$PORT" -H 127.0.0.1 \
  >>"$CV_APP_LOG" 2>&1 </dev/null &
pid=$!
printf '%s\n' "$pid" >"$CV_PID_FILE"

for _ in $(seq 1 60); do
  if health_ok; then
    log "Healthy (pid $pid)."
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    log "The app exited while starting. See $CV_APP_LOG"
    rm -f "$CV_PID_FILE"
    exit 1
  fi
  sleep 1
done
log "Not healthy after 60 seconds. See $CV_APP_LOG"
exit 1
