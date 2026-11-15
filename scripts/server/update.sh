#!/usr/bin/env bash
# Downloads the latest Card Vault from GitHub, builds it next to the running
# copy, backs up your data, switches over, and goes back to the previous
# version by itself if the new one does not start.
# Usage: scripts/server/update.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy-lib.sh
. "$here/deploy-lib.sh"

[ -f "$SHARED/.env.local" ] || die "Settings not found. Run install.sh first."
load_node

previous="$(readlink -f "$CURRENT" 2>/dev/null || true)"

step "Downloading and building the new version (this can take a few minutes)"
new="$(build_release | tail -n 1)"
say "Built: $(basename "$new")"

if [ -n "$previous" ] && [ -x "$previous/scripts/server/backup.sh" ]; then
  step "Backing up your data first"
  "$previous/scripts/server/backup.sh" || die "Backup failed, so nothing was changed."
fi

step "Switching to the new version"
switch_to "$new"
if restart_app && wait_healthy; then
  deploy_log "update ok $(basename "$new")"
  prune_releases
  step "Done. Card Vault is running the new version."
  exit 0
fi

deploy_log "update failed $(basename "$new"), rolling back"
if [ -n "$previous" ]; then
  step "The new version did not start. Going back to the previous one"
  switch_to "$previous"
  if restart_app && wait_healthy; then die "Back on the previous version. The new one is kept in $new for a look."; fi
fi
die "The app is not running. See $SHARED/logs/app.log"
