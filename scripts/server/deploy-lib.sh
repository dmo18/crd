#!/usr/bin/env bash
# Shared helpers for install.sh, update.sh and rollback.sh.
# Sourced, not run. Works without root on a Cloudways Flexible server.

CV_HOME="${CV_HOME:-$HOME/cardvault}"
CV_REPO="${CV_REPO:-https://github.com/dmo18/crd.git}"
CV_BRANCH="${CV_BRANCH:-main}"
CV_KEEP_RELEASES="${CV_KEEP_RELEASES:-3}"
RELEASES="$CV_HOME/releases"
SHARED="$CV_HOME/shared"
CURRENT="$CV_HOME/current"

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }

deploy_log() {
  mkdir -p "$SHARED/logs"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$SHARED/logs/ops.log"
}

load_node() {
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  command -v nvm >/dev/null 2>&1 || die "nvm is not installed. Run install.sh first."
  nvm use 22 >/dev/null || die "Node 22 is not installed. Run install.sh first."
}

read_port() {
  local port
  port="$(sed -n 's/^PORT=\([0-9]\{2,5\}\)[[:space:]]*$/\1/p' "$SHARED/.env.local" 2>/dev/null | tail -n 1)"
  printf '%s' "${port:-3210}"
}

health_ok() {
  curl -fsS -m 5 "http://127.0.0.1:$(read_port)/api/health" >/dev/null 2>&1
}

wait_healthy() {

  for _ in $(seq 1 30); do
    health_ok && return 0
    sleep 2
  done
  return 1
}

# Downloads and builds one release. Prints its folder on the last line.
build_release() {
  local stamp dir sha
  stamp="$(date -u +%Y%m%d%H%M%S)"
  dir="$RELEASES/$stamp"
  mkdir -p "$RELEASES"
  git clone --quiet --depth 1 --branch "$CV_BRANCH" "$CV_REPO" "$dir" >&2 || die "Could not download the code. Nothing was changed."
  sha="$(git -C "$dir" rev-parse --short HEAD)"
  mv "$dir" "$dir-$sha"
  dir="$dir-$sha"
  ln -s "$SHARED/.env.local" "$dir/.env.local"
  # set -e does not apply inside $(...), so every failure is checked by hand,
  # and a release without a finished build is never handed back.
  if ! (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error >&2); then
    rm -rf -- "$dir"; die "Installing packages failed. Nothing was changed."
  fi
  if ! (cd "$dir" && NODE_OPTIONS="--max-old-space-size=1024" npm run build >&2) || [ ! -f "$dir/.next/BUILD_ID" ]; then
    rm -rf -- "$dir"; die "Building the app failed. Nothing was changed."
  fi
  printf '%s\n' "$dir"
}

# Points "current" at a release in one step, so there is never a half state.
switch_to() {
  local target="$1"
  ln -sfn "$target" "$CV_HOME/current.next"
  mv -T "$CV_HOME/current.next" "$CURRENT"
}

restart_app() {
  "$CURRENT/scripts/server/stop.sh" >/dev/null 2>&1 || true
  "$CURRENT/scripts/server/start.sh"
}

prune_releases() {
  local keep="$CV_KEEP_RELEASES" active old
  active="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  # Oldest first; keep the newest $keep and never remove the active one.
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    [ "$(readlink -f "$old")" = "$active" ] && continue
    rm -rf -- "$old"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | sort | head -n "-$keep")
}
