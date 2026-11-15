#!/usr/bin/env bash
# Goes back to the version that ran before the current one.
# Your cards and photos are not touched.
# Usage: scripts/server/rollback.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy-lib.sh
. "$here/deploy-lib.sh"
load_node

active="$(readlink -f "$CURRENT" 2>/dev/null || true)"
[ -n "$active" ] || die "No version is active yet."
previous=""
while IFS= read -r dir; do
  [ "$(readlink -f "$dir")" = "$active" ] && break
  previous="$dir"
done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | sort)
[ -n "$previous" ] || die "There is no older version to go back to."

step "Going back to $(basename "$previous")"
switch_to "$previous"
if ! { restart_app && wait_healthy; }; then die "The older version did not start. See $SHARED/logs/app.log"; fi
deploy_log "rollback to $(basename "$previous")"
step "Done."
