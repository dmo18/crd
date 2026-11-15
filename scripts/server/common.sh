#!/usr/bin/env bash
# Shared settings and helpers. Source this file; do not run it.
set -euo pipefail

CV_HOME="${CV_HOME:-$HOME/cardvault}"
export CV_HOME
CV_CURRENT="$CV_HOME/current"
CV_SHARED="$CV_HOME/shared"
CV_ENV_FILE="$CV_SHARED/.env.local"
CV_DATA="$CV_SHARED/data"
export CV_DATA
CV_LOGS="$CV_SHARED/logs"
CV_BACKUPS="$CV_SHARED/backups"
CV_PID_FILE="$CV_SHARED/app.pid"
export CV_PID_FILE
CV_OPS_LOG="$CV_LOGS/ops.log"
CV_APP_LOG="$CV_LOGS/app.log"
export CV_APP_LOG

mkdir -p "$CV_LOGS" "$CV_BACKUPS"

# Make Node available (cron has a bare environment).
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  if [ -f "$CV_CURRENT/.nvmrc" ]; then
    (cd "$CV_CURRENT" && nvm use >/dev/null 2>&1) || true
    nvm use "$(tr -d '[:space:]' <"$CV_CURRENT/.nvmrc")" >/dev/null 2>&1 || true
  fi
  set -u
fi

# Read only the PORT line from the env file (the file is never sourced).
read_port() {
  local line="" value=""
  if [ -f "$CV_ENV_FILE" ]; then
    line="$(grep -E '^[[:space:]]*PORT=' "$CV_ENV_FILE" | tail -n 1 || true)"
    value="${line#*=}"
    value="${value%%#*}"
    value="$(printf '%s' "$value" | tr -d '"'"'"'[:space:]')"
  fi
  if [[ "$value" =~ ^[0-9]{2,5}$ ]]; then
    printf '%s' "$value"
  else
    printf '3210'
  fi
}
PORT="$(read_port)"

log() {
  printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$*" >>"$CV_OPS_LOG"
  printf '%s\n' "$*" >&2
}

health_ok() {
  curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
}
