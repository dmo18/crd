#!/usr/bin/env bash
# Stop Card Vault using the pid file.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

if [ ! -f "$CV_PID_FILE" ]; then
  log "No pid file. Nothing to stop."
  exit 0
fi
pid="$(tr -d '[:space:]' <"$CV_PID_FILE")"
if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
  log "Pid file is not valid. Removing it."
  rm -f "$CV_PID_FILE"
  exit 0
fi

cmdline="$(ps -p "$pid" -o args= 2>/dev/null || true)"
if [ -z "$cmdline" ]; then
  log "Process $pid is not running."
  rm -f "$CV_PID_FILE"
  exit 0
fi
if [[ "$cmdline" != *"next start -p $PORT"* ]]; then
  log "Process $pid is not Card Vault. Leaving it alone and removing the stale pid file."
  rm -f "$CV_PID_FILE"
  exit 0
fi

kill -TERM "$pid" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
  log "Did not stop in 20 seconds. Forcing."
  kill -KILL "$pid" 2>/dev/null || true
  sleep 1
fi
rm -f "$CV_PID_FILE"
log "Stopped (pid $pid)."
