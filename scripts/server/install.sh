#!/usr/bin/env bash
# First-time setup of Card Vault on a Cloudways Flexible server, as the
# master user, without root. Safe to run again: it never overwrites your
# settings, data or an .htaccess it did not write.
#
# Usage:
#   bash install.sh https://cards.example.com <app folder name>
#
# The first value is the web address you gave the Card Vault app in Cloudways.
# The second is that app's folder name (Cloudways: Application, Application
# Settings or Access Details), or the full path to its public_html folder.
set -euo pipefail

APP_ORIGIN_ARG="${1:-}"
APP_FOLDER="${2:-}"
[[ "$APP_ORIGIN_ARG" =~ ^https://[a-z0-9.-]+$ ]] || {
  echo "First value must look like https://cards.example.com (no slash at the end)."; exit 1; }
[[ "$APP_FOLDER" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Second value must be the app's folder name."; exit 1; }
PUBLIC_HTML=""
for candidate in "$APP_FOLDER" "$HOME/applications/$APP_FOLDER/public_html" "$HOME/$APP_FOLDER/public_html"; do
  if [ -d "$candidate" ] && [ "$(basename "$candidate")" = "public_html" ]; then PUBLIC_HTML="$candidate"; break; fi
done
[ -n "$PUBLIC_HTML" ] || { echo "Could not find public_html for '$APP_FOLDER'. Check the folder name in Cloudways."; exit 1; }
echo "Using $PUBLIC_HTML"

CV_HOME="${CV_HOME:-$HOME/cardvault}"
SHARED="$CV_HOME/shared"
NVM_VERSION="v0.40.3"

echo "== Checking memory"
if [ -r /proc/meminfo ]; then
  mem_mb=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 ))
  echo "This server has about ${mem_mb} MB of memory."
  if [ "$mem_mb" -lt 1800 ]; then
    echo "WARNING: under 2 GB. Building Card Vault next to your existing site may run out of memory."
    echo "Consider scaling the server to 2 GB in Cloudways first. Press Enter to continue anyway, or Ctrl+C to stop."
    read -r _
  fi
fi

echo "== Installing Node 22 for your user (no root needed)"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" -o /tmp/nvm-install.sh
  PROFILE=/dev/null bash /tmp/nvm-install.sh
  rm -f /tmp/nvm-install.sh
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 22 >/dev/null
nvm use 22 >/dev/null
echo "Node $(node -v) ready."

echo "== Creating folders in $CV_HOME"
mkdir -p "$CV_HOME/releases" "$SHARED/data" "$SHARED/logs" "$SHARED/backups"
chmod 700 "$SHARED" "$SHARED/data" "$SHARED/backups"

if [ ! -f "$SHARED/.env.local" ]; then
  echo "== Choosing your Card Vault password"
  echo "Use a long passphrase, at least 16 characters, that you do not use anywhere else."
  pw=""
  while [ "${#pw}" -lt 16 ]; do
    read -r -s -p "New password: " pw; echo
    read -r -s -p "Same password again: " pw2; echo
    [ "$pw" = "$pw2" ] || { echo "They did not match. Try again."; pw=""; continue; }
    [ "${#pw}" -ge 16 ] || echo "Too short. Use at least 16 characters."
  done
  secret="$(node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("base64url"))')"
  tmp_dir="$(mktemp -d)"
  ( cd "$tmp_dir" && npm init -y >/dev/null && npm install --no-audit --no-fund --loglevel=error bcryptjs@3.0.3 >/dev/null )
  hash_b64="$(CRD_PASSWORD="$pw" NODE_PATH="$tmp_dir/node_modules" node -e '
    const b = require("bcryptjs");
    process.stdout.write(Buffer.from(b.hashSync(process.env.CRD_PASSWORD, 12)).toString("base64"));')"
  rm -rf "$tmp_dir"
  unset pw pw2
  umask 077
  cat > "$SHARED/.env.local" <<ENV
# Card Vault settings. Keep this file private. It is never put in backups.
NODE_ENV=production
DATA_DIR=$SHARED/data
PORT=3210
APP_ORIGIN=$APP_ORIGIN_ARG
# How many proxies in front of the app add to X-Forwarded-For. Check
# More, Connection check after signing in, and adjust if needed.
TRUST_PROXY_HOPS=1
SESSION_SECRET=$secret
OWNER_PASSWORD_HASH_B64=$hash_b64
RECOGNITION_MODE=auto
ENV
  chmod 600 "$SHARED/.env.local"
  echo "Settings saved to $SHARED/.env.local"
else
  echo "== Settings already exist, keeping them."
fi

echo "== Downloading and building Card Vault (a few minutes)"
tmp_lib="$(mktemp -d)"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$here/deploy-lib.sh" ]; then
  cp "$here/deploy-lib.sh" "$tmp_lib/deploy-lib.sh"
else
  curl -fsSL "https://raw.githubusercontent.com/dmo18/crd/main/scripts/server/deploy-lib.sh" -o "$tmp_lib/deploy-lib.sh"
fi
# shellcheck disable=SC1091
. "$tmp_lib/deploy-lib.sh"
new="$(build_release | tail -n 1)"
rm -rf "$tmp_lib"
switch_to "$new"
restart_app
wait_healthy || die "Card Vault did not start. See $SHARED/logs/app.log"
deploy_log "install ok $(basename "$new")"

echo "== Connecting the web address to Card Vault"
marker="# Card Vault proxy"
if [ -f "$PUBLIC_HTML/.htaccess" ] && ! grep -q "$marker" "$PUBLIC_HTML/.htaccess"; then
  cp "$PUBLIC_HTML/.htaccess" "$PUBLIC_HTML/.htaccess.before-cardvault"
  echo "Your old .htaccess was saved as .htaccess.before-cardvault"
fi
cat > "$PUBLIC_HTML/.htaccess" <<HTA
$marker. Sends every request for this app to Card Vault on this server.
DirectoryIndex disabled
RewriteEngine On
RewriteBase /
RewriteRule ^(.*)?\$ http://127.0.0.1:$(read_port)/\$1 [P,L]
HTA

echo "== Scheduling the keep-alive check (every minute) and the daily backup"
cron_lines="* * * * * $CURRENT/scripts/server/watchdog.sh >/dev/null 2>&1 # cardvault
17 3 * * * $CURRENT/scripts/server/backup.sh >/dev/null 2>&1 # cardvault"
if command -v crontab >/dev/null 2>&1 && { crontab -l 2>/dev/null | grep -v '# cardvault$'; printf '%s\n' "$cron_lines"; } | crontab - 2>/dev/null; then
  echo "Scheduled."
  cron_note=""
else
  cron_note="
Add these two lines in Cloudways, Cron Job Management (Advanced):
$cron_lines
"
fi

cat <<DONE

== Card Vault is running.
$cron_note
Open $APP_ORIGIN_ARG on your phone and sign in.
DONE
