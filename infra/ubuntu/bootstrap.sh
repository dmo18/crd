#!/usr/bin/env bash
#
# bootstrap.sh: prepare a fresh Ubuntu 24.04 LTS server for Coolify v4.
#
# Usage (from the server console, as the user created during Ubuntu install;
# always with sudo from that account, never logged in as root):
#   sudo bash bootstrap.sh admin.example.com [you@example.com]
#   sudo bash bootstrap.sh --dry-run admin.example.com      (only print what would change)
#   sudo bash bootstrap.sh --cloudflare admin.example.com [you@example.com]
#
# Two modes:
#   direct (default)  the server answers web traffic itself on 80/443.
#   --cloudflare      everything comes in through a Cloudflare Tunnel: cloudflared
#                     on this server connects OUT to Cloudflare, so no port at all
#                     is open to the internet (not 22, not 80, not 443). The tunnel
#                     token is asked for with hidden typing, or read from a
#                     root-only file given with --token-file (never from the
#                     command line or the environment, which end up in the shell
#                     history or are visible to other programs).
#
# What it does, in order:
#   1. Preflight checks (Ubuntu 24.04, sudo from the owner's account, CPU/RAM/disk,
#      internet).
#   2. Updates the system and installs: ufw, fail2ban, unattended-upgrades, curl,
#      ca-certificates, jq, openssh-server, python3-systemd, lynis, auditd.
#   3. Automatic updates: ONLY Ubuntu security patches, daily, never a restart.
#      Everything else waits for the owner's "sudo server-update" (installed to
#      /usr/local/sbin), which backs up first and asks before restarting.
#   4. A 2 GB swap file if the server has no swap, and vm.swappiness=10.
#   5. SSH hardening: no passwords at all, root only with a key (Coolify needs
#      that), 3 tries. Cloudflare mode: Cloudflare's browser SSH terminal logs in
#      with a short-lived certificate signed by the account's SSH CA
#      (/etc/ssh/ca.pub, set with "sudo server-ssh-ca set"), only for the owner's
#      account (/etc/ssh/principals/<user>).
#   6. Firewall (ufw): only 80/tcp, 443/tcp and 443/udp from the internet (direct
#      mode) or nothing at all (Cloudflare mode). SSH (22) only from Docker's
#      private networks, so Coolify can manage this server.
#   7. docker-port-guard: Docker skips ufw for container ports, so a separate rule
#      set in the iptables DOCKER-USER chain blocks every container port from the
#      internet except 80/443 (Coolify's Traefik proxy; Cloudflare mode: none).
#      This covers Coolify's 8000/6001/6002 and Traefik's own 8080.
#   8. fail2ban for SSH.
#   9. Cloudflare mode only: cloudflared from Cloudflare's signed apt repository,
#      run as a locked down systemd service; the token is kept in a root-only file.
#  10. Coolify, with its official installer and an admin account created up front.
#      The installer's SHA-256 is printed and, if COOLIFY_INSTALLER_SHA256 is set
#      in /etc/default/server-setup, must match.
#  11. Docker's current major version is pinned (apt preferences), so even
#      server-update moves to a new major only with --allow-docker-major.
#  12. Logs: the system log (journald) is kept on disk, at most 1 GB and 90
#      days; container logs rotate (20 MB x 5 files, /etc/docker/daemon.json,
#      merged with what is there).
#  13. Server tools in /usr/local/sbin: server-alert (Telegram or Discord, a check
#      every 15 minutes), server-lynis (weekly read-only security audit),
#      server-support (diagnostics with secrets removed), server-check (check.sh),
#      server-logs, server-docker-logs, server-status, server-note.
#  14. The AI agent account ops-agent (--no-agent skips it): no password, no SSH,
#      no groups, a read-only sudo list, every sudo session recorded; changes only
#      with the owner's one-time permission (server-agent-grant). Its guide
#      (AGENT-GUIDE.md, next to this script) becomes /home/ops-agent/CLAUDE.md.
#  15. auditd: logs every command of ops-agent and changes to SSH, sudo, the
#      tunnel token and the port guard settings.
#  16. Direct mode only: a 30 minute "setup window" on ports 8000 and 6001 so the
#      owner can do the first login from a browser. It closes by itself. On a
#      later run it is only opened again after asking.
#
# check.sh and AGENT-GUIDE.md from the same release should sit next to this
# script; they are installed as server-check and the agent's guide.
#
# Safe to run again: every step checks the current state first. Coolify is only
# installed once; after that it updates itself.

set -euo pipefail
umask 022

readonly SCRIPT_VERSION="1.3.0"
readonly COOLIFY_INSTALLER_URL="https://cdn.coollabs.io/coolify/install.sh"
readonly COOLIFY_ENV="/data/coolify/source/.env"
readonly GUARD_BIN="/usr/local/sbin/docker-port-guard"
readonly GUARD_CONFIG="/etc/default/docker-port-guard"
readonly GUARD_UNIT="/etc/systemd/system/docker-port-guard.service"
readonly GUARD_DOCKER_DROPIN="/etc/systemd/system/docker.service.d/50-docker-port-guard.conf"
readonly SSHD_DROPIN="/etc/ssh/sshd_config.d/01-server-hardening.conf"
readonly F2B_JAIL="/etc/fail2ban/jail.d/90-sshd-server.local"
readonly UU_PERIODIC="/etc/apt/apt.conf.d/20auto-upgrades"
readonly UU_LOCAL="/etc/apt/apt.conf.d/52unattended-upgrades-server"
readonly SWAPFILE="/swapfile"
readonly SWAPPINESS_CONF="/etc/sysctl.d/99-server-swappiness.conf"
readonly FIRST_LOGIN_FILE="/root/coolify-first-login.txt"
readonly SETUP_WINDOW_MINUTES=30
# Docker's private address ranges. Coolify's container reaches this host's SSH from here.
readonly DOCKER_RANGES="172.16.0.0/12 10.0.0.0/8"
# Cloudflare mode. The signing key fingerprint is checked before the key is trusted:
# if Cloudflare ever changes its key, the script stops instead of trusting a new one.
# Current key and instructions: https://pkg.cloudflare.com/
readonly CF_KEY_URL="https://pkg.cloudflare.com/cloudflare-main.gpg"
readonly CF_KEY_FINGERPRINT="CC94B39C77AE7342A68B89628A682D308D4E5E73"
readonly CF_KEYRING="/usr/share/keyrings/cloudflare-main.gpg"
readonly CF_APT_LIST="/etc/apt/sources.list.d/cloudflared.list"
readonly CF_REPO_URL="https://pkg.cloudflare.com/cloudflared"
readonly CF_TOKEN_DIR="/etc/cloudflared"
readonly CF_TOKEN_FILE="/etc/cloudflared/tunnel-token"
readonly CF_UNIT="/etc/systemd/system/cloudflared.service"
readonly CF_METRICS="127.0.0.1:20241"
# Written by earlier versions (cloudflared automatic updates); removed now.
readonly UU_CLOUDFLARE="/etc/apt/apt.conf.d/53unattended-upgrades-cloudflared"
readonly UPDATE_BIN="/usr/local/sbin/server-update"
readonly SSH_CA_BIN="/usr/local/sbin/server-ssh-ca"
readonly SSH_CA_FILE="/etc/ssh/ca.pub"
readonly SSH_PRINCIPALS_DIR="/etc/ssh/principals"
readonly DOCKER_PIN_FILE="/etc/apt/preferences.d/docker-major-pin"
# Optional owner settings for this script, read as plain KEY=value lines (never
# run as a script). Known key: COOLIFY_INSTALLER_SHA256.
readonly SETUP_CONFIG="/etc/default/server-setup"
# Logs, alerts, audit, support and the AI agent account (steps 12 to 15).
readonly JOURNALD_DROPIN="/etc/systemd/journald.conf.d/60-server-retention.conf"
readonly DOCKER_DAEMON_JSON="/etc/docker/daemon.json"
readonly TOOLS_LIB="/usr/local/lib/server-tools"
readonly TOOLS_SHARE="/usr/local/share/server-tools"
readonly ALERT_BIN="/usr/local/sbin/server-alert"
readonly LYNIS_BIN="/usr/local/sbin/server-lynis"
readonly LOGS_BIN="/usr/local/sbin/server-logs"
readonly DOCKER_LOGS_BIN="/usr/local/sbin/server-docker-logs"
readonly STATUS_BIN="/usr/local/sbin/server-status"
readonly NOTE_BIN="/usr/local/sbin/server-note"
readonly SUPPORT_BIN="/usr/local/sbin/server-support"
readonly CHECK_BIN="/usr/local/sbin/server-check"
readonly GRANT_BIN="/usr/local/sbin/server-agent-grant"
readonly BACKUP_BIN="/usr/local/sbin/server-backup"
readonly AGENT_USER="ops-agent"
readonly AGENT_HOME="/home/ops-agent"
readonly AGENT_SUDOERS="/etc/sudoers.d/ops-agent"
readonly SUDO_IO_DIR="/var/log/sudo-io"
readonly AUDIT_RULES="/etc/audit/rules.d/60-server.rules"
# The folder this script is in: check.sh and AGENT-GUIDE.md are read from there.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

DRY_RUN=false
ASSUME_YES=false
NO_AGENT=false     # --no-agent: no ops-agent account
MODE=""            # direct or cloudflare, from --direct / --cloudflare or the earlier run
MODE_FROM_ARGS=""
CF_TOKEN=""        # the tunnel token, only in memory; never printed
CF_TOKEN_KEEP=false
TOKEN_FILE_ARG=""  # --token-file: a root-only file holding the token
OWNER_USER=""      # the Ubuntu account that ran sudo (SUDO_USER)
CF_EMAIL=""        # the email that signs in to Cloudflare Access
SSH_PRINCIPAL=""   # what Cloudflare puts in the certificate: CF_EMAIL before the @
SSH_CA_KEY=""      # the Cloudflare SSH CA public key line, if given in this run
COOLIFY_WAS_INSTALLED=false
DASHBOARD_HOST=""
ADMIN_EMAIL=""
PUBLIC_IP=""
PUBLIC_IF=""
PUBLIC_IF6=""
ADMIN_PASSWORD=""
SETUP_WINDOW_OPENED=false
WORKDIR=""
SUMMARY=()

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
    C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi

step() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %sOK%s   %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '    %sWARN%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '\n%sSTOPPED:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
done_item() { SUMMARY+=("$*"); }

cleanup() {
    if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
        rm -rf -- "$WORKDIR"
    fi
}
trap cleanup EXIT

# One private temporary folder per run, removed at the end.
ensure_workdir() {
    if [ -z "$WORKDIR" ] || [ ! -d "$WORKDIR" ]; then
        WORKDIR="$(mktemp -d)"
        chmod 700 "$WORKDIR"
    fi
}

# Run a command that changes the system. In dry-run mode only print it.
run() {
    if [ "$DRY_RUN" = true ]; then
        printf '    [dry-run] %s\n' "$(printf '%q ' "$@")"
    else
        "$@"
    fi
}

# Write stdin to a file atomically with the given mode. In dry-run mode print it.
write_file() {
    local path="$1" mode="$2" content tmp
    content="$(cat)"
    if [ "$DRY_RUN" = true ]; then
        printf '    [dry-run] write %s (mode %s):\n' "$path" "$mode"
        printf '%s\n' "$content" | sed 's/^/        | /'
        return 0
    fi
    local dir stage
    dir="$(dirname -- "$path")"
    mkdir -p -- "$dir"
    # The temporary copy goes in a private folder NEXT TO the target folder
    # (same file system, so the final mv is atomic), never inside it: programs
    # such as apt (apt.conf.d) and sshd (sshd_config.d) read every file there.
    stage="$(mktemp -d "$(dirname -- "$dir")/.bootstrap-stage.XXXXXX")"
    tmp="$stage/$(basename -- "$path")"
    if ! { printf '%s\n' "$content" >"$tmp" && chmod "$mode" "$tmp" && mv -f -- "$tmp" "$path"; }; then
        rm -rf -- "$stage"
        die "Could not write $path."
    fi
    rmdir -- "$stage"
}

# True when there is a console to ask on. Testing the file is not enough: without
# a controlling terminal /dev/tty exists but cannot be opened.
have_tty() {
    { : >/dev/tty; } 2>/dev/null
}

# Ask a yes/no question on the console. Default is "no".
ask_yes_no() {
    local answer=""
    if [ "$ASSUME_YES" = true ]; then
        return 0
    fi
    if ! have_tty; then
        warn "No console to ask on. Treating the answer as 'no'. Add --yes to skip this question."
        return 1
    fi
    printf '    %s [y/N] ' "$1" >/dev/tty
    read -r answer </dev/tty || answer=""
    case "$answer" in
        y | Y | yes | YES | Yes) return 0 ;;
        *) return 1 ;;
    esac
}

usage() {
    cat <<'EOF'
Prepare this Ubuntu 24.04 server for Coolify and lock it down.

Usage:
  sudo bash bootstrap.sh [options] <dashboard-host> [admin-email]

  dashboard-host  The web address for the Coolify dashboard, for example
                  admin.example.com (no https://, no slash).
  admin-email     The email you will log in to Coolify with. Asked for if
                  left out. Only needed the first time.

Options:
  --cloudflare    Cloudflare Tunnel mode: no port open to the internet at all.
                  You are asked for the tunnel token (typing stays hidden),
                  the email you sign in to Cloudflare with, and the SSH CA
                  public key for the browser terminal (can be added later
                  with: sudo server-ssh-ca set). Never type the token on the
                  command line.
  --token-file F  Read the tunnel token from file F instead of asking. F must
                  belong to root and be readable only by root (chmod 600).
  --direct        Direct mode (the default): this server answers 80/443 itself.
                  Only needed to switch back from Cloudflare mode.
  --no-agent      Do not create the AI agent account (ops-agent).
  --dry-run       Show every change without making it.
  --yes           Answer "yes" to the "continue anyway?" questions.
  --help          Show this help.
EOF
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
parse_args() {
    local positional=()
    while [ $# -gt 0 ]; do
        case "$1" in
            --dry-run) DRY_RUN=true ;;
            --yes | -y) ASSUME_YES=true ;;
            --no-agent) NO_AGENT=true ;;
            --cloudflare) MODE_FROM_ARGS="cloudflare" ;;
            --direct) MODE_FROM_ARGS="direct" ;;
            --token-file)
                [ $# -ge 2 ] || die "--token-file needs a file name, for example: --token-file /root/tunnel-token"
                TOKEN_FILE_ARG="$2"
                shift ;;
            --token-file=*) TOKEN_FILE_ARG="${1#--token-file=}" ;;
            --token | --token=* | --tunnel-token | --tunnel-token=*)
                die "Do not put the tunnel token on the command line (other users and the shell history can see it). Leave it out: the script asks for it." ;;
            --help | -h) usage; exit 0 ;;
            --*) usage >&2; die "Unknown option: $1" ;;
            *) positional+=("$1") ;;
        esac
        shift
    done
    if [ "${#positional[@]}" -lt 1 ] || [ "${#positional[@]}" -gt 2 ]; then
        usage >&2
        die "Please give the dashboard address, for example: sudo bash bootstrap.sh admin.example.com"
    fi
    DASHBOARD_HOST="${positional[0],,}"
    ADMIN_EMAIL="${positional[1]:-}"
}

valid_hostname() {
    local h="$1"
    [ "${#h}" -le 253 ] || return 1
    [[ $h =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
}

valid_email() {
    local e="$1"
    [ "${#e}" -le 255 ] || return 1
    [[ $e =~ ^[A-Za-z0-9._%+-]+@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]
}

validate_host_arg() {
    case "$DASHBOARD_HOST" in
        http://* | https://* | */* | *:*)
            die "Give only the address, like admin.example.com (no https://, no slash, no port). You gave: $DASHBOARD_HOST" ;;
    esac
    DASHBOARD_HOST="${DASHBOARD_HOST%.}"
    valid_hostname "$DASHBOARD_HOST" ||
        die "'$DASHBOARD_HOST' is not a valid web address. Example: admin.example.com"
}

# ---------------------------------------------------------------------------
# Mode (direct or Cloudflare Tunnel)
# ---------------------------------------------------------------------------
# The mode of an earlier run, as recorded in the port guard's settings file.
previous_mode() {
    if [ -r "$GUARD_CONFIG" ]; then
        sed -n 's/^MODE="\{0,1\}\([a-z]*\)"\{0,1\}[[:space:]]*$/\1/p' "$GUARD_CONFIG" | tail -n 1
    fi
}

resolve_mode() {
    local prev
    prev="$(previous_mode)"
    if [ -n "$MODE_FROM_ARGS" ]; then
        MODE="$MODE_FROM_ARGS"
    elif [ "$prev" = cloudflare ]; then
        die "This server was set up for Cloudflare Tunnel before. Run again with --cloudflare to keep that, or with --direct to open 80/443 to the internet instead."
    else
        MODE="direct"
    fi
    if [ -n "$prev" ] && [ "$prev" != "$MODE" ]; then
        warn "Switching this server from $prev mode to $MODE mode."
    fi
}

# Remove spaces and line breaks around the token, and anything pasted before it
# (for example "cloudflared service install" or "--token").
clean_token() {
    local t="$1"
    t="${t//$'\r'/}"
    t="${t#"${t%%[![:space:]]*}"}"
    t="${t%"${t##*[![:space:]]}"}"
    t="${t##*[[:space:]]}"
    t="${t#--token=}"
    printf '%s' "$t"
}

# A tunnel token is standard base64 of JSON {"a": account id (32 hex), "t":
# tunnel id (UUID), "s": base64 secret}, see TunnelToken and ParseToken in
# cloudflared's source. The token goes to python on stdin (printf is a shell
# builtin), so it never appears in a process list.
token_is_valid() {
    printf '%s' "$1" | python3 -I -c '
import base64, json, re, sys, uuid
t = sys.stdin.read()
try:
    assert 100 <= len(t) <= 4096 and len(t) % 4 == 0
    assert re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", t)
    d = json.loads(base64.b64decode(t, validate=True))
    assert isinstance(d, dict)
    a, tid, sec = d.get("a"), d.get("t"), d.get("s")
    assert isinstance(a, str) and re.fullmatch(r"[0-9a-f]{32}", a)
    assert isinstance(tid, str) and str(uuid.UUID(tid)) == tid.lower()
    assert isinstance(sec, str) and len(base64.b64decode(sec, validate=True)) >= 32
except Exception:
    sys.exit(1)
' 2>/dev/null
}

# A token file given with --token-file must be a regular file (not a link) that
# only root can read or change, so no other account can have seen or swapped it.
check_token_file() {
    local f="$1" perm
    [ -f "$f" ] && [ ! -L "$f" ] || die "--token-file: $f is not a regular file."
    perm="$(stat -c '%u %a' -- "$f")"
    case "$perm" in
        "0 400" | "0 600") ;;
        *) die "--token-file: $f must belong to root and be readable only by root. Fix: sudo chown root:root $f && sudo chmod 600 $f" ;;
    esac
}

read_tunnel_token() {
    local typed="" tries=0
    if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
        # Older versions read the token from this variable. Not any more: with
        # sudo it has to be typed on the command line, so it lands in the shell
        # history.
        unset CF_TUNNEL_TOKEN
        die "CF_TUNNEL_TOKEN is no longer read (it ends up in the shell history). Run without it: the script asks for the token with hidden typing, or use --token-file with a root-only file. To clear the history line: history -c"
    fi
    if [ -n "$TOKEN_FILE_ARG" ]; then
        if [ "$DRY_RUN" = true ] && [ "$(id -u)" -ne 0 ]; then
            info "Dry run: the real run reads the tunnel token from $TOKEN_FILE_ARG"
            return 0
        fi
        check_token_file "$TOKEN_FILE_ARG"
        CF_TOKEN="$(clean_token "$(cat -- "$TOKEN_FILE_ARG")")"
        token_is_valid "$CF_TOKEN" ||
            die "The tunnel token in $TOKEN_FILE_ARG does not look right. Copy it again from Cloudflare (it starts with eyJ and is one long line)."
        ok "Tunnel token read from $TOKEN_FILE_ARG (not shown). You can delete that file after this run."
        return 0
    fi
    if [ "$DRY_RUN" = true ]; then
        info "Dry run: the real run asks for the tunnel token here (typing hidden)"
        return 0
    fi
    if ! have_tty; then
        if [ -s "$CF_TOKEN_FILE" ]; then
            CF_TOKEN_KEEP=true
            ok "Keeping the tunnel token already saved on this server"
            return 0
        fi
        die "No console to ask for the tunnel token. Run it from the console, or use --token-file with a root-only file."
    fi
    while [ "$tries" -lt 3 ]; do
        tries=$((tries + 1))
        if [ -s "$CF_TOKEN_FILE" ]; then
            printf '    Paste the Cloudflare tunnel token and press Enter (what you type stays hidden).\n    Or press Enter alone to keep the token already saved on this server: ' >/dev/tty
        else
            printf '    Paste the Cloudflare tunnel token (it starts with eyJ) and press Enter.\n    What you type stays hidden: ' >/dev/tty
        fi
        typed=""
        IFS= read -rs typed </dev/tty || typed=""
        printf '\n' >/dev/tty
        typed="$(clean_token "$typed")"
        if [ -z "$typed" ] && [ -s "$CF_TOKEN_FILE" ]; then
            CF_TOKEN_KEEP=true
            ok "Keeping the tunnel token already saved on this server"
            return 0
        fi
        if token_is_valid "$typed"; then
            CF_TOKEN="$typed"
            ok "Tunnel token accepted (not shown)"
            return 0
        fi
        warn "That does not look like a tunnel token. It is one long line that starts with eyJ. Try again."
    done
    die "No valid tunnel token. Nothing was changed. In Cloudflare: Zero Trust, Networks, Tunnels, your tunnel, then copy the token."
}

# ---------------------------------------------------------------------------
# Browser SSH with Cloudflare short-lived certificates (Cloudflare mode)
# ---------------------------------------------------------------------------
# Cloudflare's browser SSH terminal signs a certificate that is valid for a few
# minutes, for the person who passed the Access sign-in. Its principal (the name
# it is issued to) is that person's email before the @, lowercased:
# jdoe@example.com -> jdoe. This server trusts certificates signed by the
# account's SSH CA (/etc/ssh/ca.pub) and maps that principal to the owner's
# Ubuntu account in /etc/ssh/principals/<user>. No password is involved.
principal_from_email() {
    local local_part="${1%@*}"
    printf '%s' "${local_part,,}"
}

current_principal() {
    if [ -n "$OWNER_USER" ] && [ -r "$SSH_PRINCIPALS_DIR/$OWNER_USER" ]; then
        grep -v '^[[:space:]]*\(#\|$\)' "$SSH_PRINCIPALS_DIR/$OWNER_USER" | head -n 1 | tr -d '[:space:]'
    fi
}

read_cloudflare_identity() {
    local typed="" tries=0 existing
    existing="$(current_principal)"
    if [ -n "$ADMIN_EMAIL" ]; then CF_EMAIL="$ADMIN_EMAIL"; fi
    if have_tty && [ "$DRY_RUN" = false ]; then
        while [ "$tries" -lt 3 ]; do
            tries=$((tries + 1))
            if [ -n "$CF_EMAIL" ]; then
                printf '    Type the email you sign in to Cloudflare with, or press Enter for %s: ' "$CF_EMAIL" >/dev/tty
            elif [ -n "$existing" ]; then
                printf '    Type the email you sign in to Cloudflare with, or press Enter to keep the\n    current browser SSH login name "%s": ' "$existing" >/dev/tty
            else
                printf '    Type the email you sign in to Cloudflare with, then press Enter: ' >/dev/tty
            fi
            typed=""
            read -r typed </dev/tty || typed=""
            typed="${typed//[[:space:]]/}"
            if [ -z "$typed" ] && { [ -n "$CF_EMAIL" ] || [ -n "$existing" ]; }; then
                break
            fi
            if valid_email "$typed"; then
                CF_EMAIL="$typed"
                break
            fi
            warn "That is not an email address. Try again."
            typed=""
        done
    fi
    if [ -n "$CF_EMAIL" ]; then
        SSH_PRINCIPAL="$(principal_from_email "$CF_EMAIL")"
    elif [ -n "$existing" ]; then
        SSH_PRINCIPAL="$existing"
    elif [ "$DRY_RUN" = true ]; then
        CF_EMAIL="owner@example.com"
        SSH_PRINCIPAL="$(principal_from_email "$CF_EMAIL")"
        info "Dry run: using the example Cloudflare email $CF_EMAIL"
    else
        die "Please give the email you sign in to Cloudflare with, for example: sudo bash bootstrap.sh --cloudflare $DASHBOARD_HOST you@example.com"
    fi
    ok "Browser SSH: a Cloudflare certificate for '$SSH_PRINCIPAL' logs in as Ubuntu user '$OWNER_USER'"
    if [ "$SSH_PRINCIPAL" != "$OWNER_USER" ]; then
        info "That is fine. When the browser terminal asks for a user name, type: $OWNER_USER"
    fi
}

# A public key line as Cloudflare shows it: type, base64, optional comment.
ssh_ca_key_valid() {
    local key="$1"
    [[ $key =~ ^(ecdsa-sha2-nistp(256|384|521)|ssh-ed25519|ssh-rsa)\ [A-Za-z0-9+/]{40,}={0,3}(\ [^[:cntrl:]]*)?$ ]] || return 1
    printf '%s\n' "$key" | ssh-keygen -l -f /dev/stdin >/dev/null 2>&1
}

read_ssh_ca_key() {
    local typed="" tries=0
    if [ "$DRY_RUN" = true ]; then
        info "Dry run: the real run asks for the Cloudflare SSH CA public key here (Enter skips)"
        return 0
    fi
    if ! have_tty; then
        if [ -s "$SSH_CA_FILE" ]; then
            ok "Keeping the SSH CA key already saved in $SSH_CA_FILE"
        else
            warn "No console to ask for the Cloudflare SSH CA key. Add it later: sudo server-ssh-ca set"
        fi
        return 0
    fi
    while [ "$tries" -lt 3 ]; do
        tries=$((tries + 1))
        if [ -s "$SSH_CA_FILE" ]; then
            printf '    Paste the SSH CA public key from Cloudflare and press Enter,\n    or press Enter alone to keep the key already saved: ' >/dev/tty
        else
            printf '    Paste the SSH CA public key from Cloudflare (it starts with ecdsa-sha2-nistp256)\n    and press Enter. No key yet? Press Enter alone to skip and add it later: ' >/dev/tty
        fi
        typed=""
        IFS= read -r typed </dev/tty || typed=""
        typed="${typed//$'\r'/}"
        typed="${typed#"${typed%%[![:space:]]*}"}"
        typed="${typed%"${typed##*[![:space:]]}"}"
        if [ -z "$typed" ]; then
            if [ -s "$SSH_CA_FILE" ]; then
                ok "Keeping the SSH CA key already saved in $SSH_CA_FILE"
            else
                warn "Skipped. Browser SSH works only after you add the key: sudo server-ssh-ca set"
            fi
            return 0
        fi
        if ssh_ca_key_valid "$typed"; then
            SSH_CA_KEY="$typed"
            ok "SSH CA key accepted ($(printf '%s\n' "$SSH_CA_KEY" | ssh-keygen -l -f /dev/stdin | awk '{print $2}'))"
            return 0
        fi
        warn "That does not look like the CA public key. It is one line that starts with ecdsa-sha2-nistp256. Try again."
    done
    warn "No valid SSH CA key. Continuing without it; add it later: sudo server-ssh-ca set"
}

# ---------------------------------------------------------------------------
# Detection helpers (read-only)
# ---------------------------------------------------------------------------
is_private_ipv4() {
    case "$1" in
        10.* | 192.168.* | 127.* | 169.254.*) return 0 ;;
        172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].*) return 0 ;;
        100.6[4-9].* | 100.[7-9][0-9].* | 100.1[0-1][0-9].* | 100.12[0-7].*) return 0 ;;
        *) return 1 ;;
    esac
}

detect_network() {
    PUBLIC_IF="$({ ip -4 route show default 2>/dev/null || true; } | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')"
    PUBLIC_IF6="$({ ip -6 route show default 2>/dev/null || true; } | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')"
    if [ "$PUBLIC_IF6" = "$PUBLIC_IF" ]; then PUBLIC_IF6=""; fi
    PUBLIC_IP="$({ ip -4 route get 1.1.1.1 2>/dev/null || true; } | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)"
    if [ -z "$PUBLIC_IP" ] || is_private_ipv4 "$PUBLIC_IP"; then
        # Behind NAT. Ask the same service Coolify's installer uses.
        local seen=""
        if command -v curl >/dev/null 2>&1; then
            seen="$(curl -4fsS --max-time 8 https://ifconfig.io 2>/dev/null | tr -d '[:space:]' || true)"
        fi
        if [[ $seen =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            if [ -n "$PUBLIC_IP" ]; then
                warn "This server's own address ($PUBLIC_IP) is private. The internet sees it as $seen."
            fi
            PUBLIC_IP="$seen"
        fi
    fi
    [ -n "$PUBLIC_IP" ] || PUBLIC_IP="<server-ip>"
}

# Installed means the coolify container exists. A half-finished earlier attempt
# (settings file but no container) is completed by running the installer again.
coolify_installed() {
    command -v docker >/dev/null 2>&1 && docker container inspect coolify >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
preflight() {
    step "Checking this server"

    if [ "$(id -u)" -ne 0 ]; then
        if [ "$DRY_RUN" = true ]; then
            warn "Not running as root. Fine for a dry run; the real run needs sudo."
        else
            die "Please run this with sudo: sudo bash bootstrap.sh $DASHBOARD_HOST"
        fi
    else
        ok "Running as root"
    fi

    # The owner's own account: SSH certificates (Cloudflare mode) are mapped to
    # it. A root login (or sudo from root) gives no account to map to.
    local su="${SUDO_USER:-}"
    if [ -z "$su" ] || [ "$su" = root ]; then
        if [ "$DRY_RUN" = true ]; then
            OWNER_USER="$(id -un)"
            [ "$OWNER_USER" != root ] || OWNER_USER="youruser"
            warn "Not started with sudo from your own account. Fine for a dry run (showing user '$OWNER_USER'); the real run stops here."
        else
            die "Please log in as your own Ubuntu user (the one created when installing Ubuntu), not as root, and run: sudo bash bootstrap.sh ${MODE_FROM_ARGS:+--$MODE_FROM_ARGS }$DASHBOARD_HOST"
        fi
    else
        if [[ ! $su =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || ! id -u -- "$su" >/dev/null 2>&1; then
            die "The account that ran sudo ('$su') is not a normal Ubuntu user name. Log in as your own user and run the command again."
        fi
        OWNER_USER="$su"
        ok "Started by Ubuntu user '$OWNER_USER'"
    fi

    local os_id="" os_version=""
    if [ -r /etc/os-release ]; then
        os_id="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')"
        os_version="$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')"
    fi
    if [ "$os_id" != "ubuntu" ] || [ "$os_version" != "24.04" ]; then
        die "This script is made for Ubuntu 24.04 LTS. This server is: ${os_id:-unknown} ${os_version:-}"
    fi
    ok "Ubuntu 24.04 LTS"

    local arch
    arch="$(dpkg --print-architecture)"
    case "$arch" in
        amd64 | arm64) ok "Processor type $arch" ;;
        *) die "Coolify needs an amd64 or arm64 server. This one is $arch." ;;
    esac

    validate_host_arg
    ok "Dashboard address: $DASHBOARD_HOST"
    resolve_mode
    if [ "$MODE" = cloudflare ]; then
        ok "Mode: Cloudflare Tunnel (no port open to the internet)"
    else
        ok "Mode: direct (this server answers 80/443 itself)"
    fi

    local cpus mem_kb disk_kb low=false
    cpus="$(nproc)"
    mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
    disk_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
    if [ "$cpus" -ge 2 ]; then ok "$cpus processors"; else warn "Only $cpus processor (2 or more recommended)"; low=true; fi
    # 3.5 GB = 3670016 kB. A "4 GB" machine reports a little less than 4 GB.
    if [ "$mem_kb" -ge 3670016 ]; then
        ok "$((mem_kb / 1024)) MB memory"
    else
        warn "Only $((mem_kb / 1024)) MB memory (3.5 GB or more recommended)"; low=true
    fi
    if [ "$disk_kb" -ge $((30 * 1024 * 1024)) ]; then
        ok "$((disk_kb / 1024 / 1024)) GB free disk space"
    else
        warn "Only $((disk_kb / 1024 / 1024)) GB free disk space (30 GB or more recommended)"; low=true
    fi
    if [ "$low" = true ]; then
        ask_yes_no "This server is smaller than recommended. Continue anyway?" || die "Stopped at your request. Nothing was changed."
    fi

    if command -v curl >/dev/null 2>&1; then
        curl -fsS --max-time 15 -o /dev/null https://cdn.coollabs.io/coolify/versions.json ||
            die "Cannot reach the internet (cdn.coollabs.io). Check the server's network and try again."
    else
        getent hosts cdn.coollabs.io >/dev/null ||
            die "Cannot look up cdn.coollabs.io. Check the server's network and try again."
    fi
    ok "Internet reachable"
    if [ "$MODE" = cloudflare ]; then
        if command -v curl >/dev/null 2>&1; then
            curl -fsS --max-time 15 -o /dev/null "$CF_KEY_URL" ||
                die "Cannot reach Cloudflare's package server (pkg.cloudflare.com). Check the server's network and try again."
            ok "Cloudflare's package server reachable"
        fi
        if ! command -v python3 >/dev/null 2>&1; then
            if [ "$DRY_RUN" = true ]; then
                warn "python3 is missing; the real run needs it to check the tunnel token"
            else
                die "python3 is missing (it is part of every Ubuntu 24.04 install). Install it: sudo apt-get install python3"
            fi
        fi
    fi

    detect_network
    if [ -n "$PUBLIC_IF" ]; then ok "Internet connection on network card '$PUBLIC_IF', address $PUBLIC_IP"; else warn "Could not find the default network card"; fi

    local resolved
    if [ "$MODE" = cloudflare ]; then
        # Through the tunnel the address points to Cloudflare, never to this server.
        info "The tunnel routes for $DASHBOARD_HOST are set in Cloudflare (see README)."
    else
        resolved="$(getent ahostsv4 "$DASHBOARD_HOST" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
        if [ -n "$resolved" ] && [[ " $resolved " == *" $PUBLIC_IP "* ]]; then
            ok "$DASHBOARD_HOST points to this server"
        else
            warn "$DASHBOARD_HOST does not point to this server yet (it points to: ${resolved:-nothing})."
            warn "Add a DNS 'A' record: $DASHBOARD_HOST -> $PUBLIC_IP. HTTPS will only work after that."
        fi
    fi

    if [ -n "$TOKEN_FILE_ARG" ] && [ "$MODE" != cloudflare ]; then
        die "--token-file is only for Cloudflare mode (--cloudflare)."
    fi

    if coolify_installed; then
        COOLIFY_WAS_INSTALLED=true
        if [ -n "$ADMIN_EMAIL" ] && ! valid_email "$ADMIN_EMAIL"; then
            die "'$ADMIN_EMAIL' is not a valid email address."
        fi
    else
        if [ -z "$ADMIN_EMAIL" ]; then
            if have_tty && [ "$DRY_RUN" = false ]; then
                printf '    Type the email address you want to log in to Coolify with, then press Enter: ' >/dev/tty
                read -r ADMIN_EMAIL </dev/tty || ADMIN_EMAIL=""
            elif [ "$DRY_RUN" = true ]; then
                ADMIN_EMAIL="owner@example.com"
                info "Dry run: using the example email $ADMIN_EMAIL"
            fi
        fi
        valid_email "$ADMIN_EMAIL" ||
            die "Please give a valid email address, for example: sudo bash bootstrap.sh $DASHBOARD_HOST you@example.com"
        ok "Coolify login email: $ADMIN_EMAIL"
    fi

    if [ "$MODE" = cloudflare ]; then
        read_tunnel_token
        read_cloudflare_identity
        read_ssh_ca_key
    fi
}

# ---------------------------------------------------------------------------
# 2. Packages
# ---------------------------------------------------------------------------
install_packages() {
    step "Updating the system and installing security tools"
    export DEBIAN_FRONTEND=noninteractive
    # needrestart on 24.04 would otherwise stop and ask which services to restart.
    export NEEDRESTART_MODE=a
    # Lock timeout: on a fresh server Ubuntu's own updater may still be running.
    local apt_opts=(-y -o DPkg::Lock::Timeout=900 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
    run apt-get -o DPkg::Lock::Timeout=900 update
    run apt-get "${apt_opts[@]}" upgrade
    run apt-get "${apt_opts[@]}" install ufw fail2ban unattended-upgrades curl ca-certificates jq openssh-server python3-systemd iproute2 lynis auditd sudo e2fsprogs
    if [ "$MODE" = cloudflare ]; then
        # gnupg checks the fingerprint of Cloudflare's package signing key.
        run apt-get "${apt_opts[@]}" install gnupg
    fi
    done_item "System updated; ufw, fail2ban, unattended-upgrades, curl, jq, lynis, auditd installed"
}

# ---------------------------------------------------------------------------
# 3. Automatic security updates
# ---------------------------------------------------------------------------
configure_unattended_upgrades() {
    step "Turning on automatic security updates"
    write_file "$UU_PERIODIC" 0644 <<'EOF'
// Written by bootstrap.sh: refresh the package lists and install Ubuntu
// security patches every day (which ones: 52unattended-upgrades-server).
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
    write_file "$UU_LOCAL" 0644 <<'EOF'
// Written by bootstrap.sh. Owner rule: nothing on the live system changes by
// itself except Ubuntu security patches. Everything else (Ubuntu's regular
// updates, Docker, cloudflared) waits until the owner runs: sudo server-update
//
// "#clear" empties the lists from Ubuntu's 50unattended-upgrades first, so the
// security pocket below is the ONLY origin that installs automatically.
#clear Unattended-Upgrade::Allowed-Origins;
#clear Unattended-Upgrade::Origins-Pattern;
Unattended-Upgrade::Allowed-Origins {
        "${distro_id}:${distro_codename}-security";
};
// Never restart the server by itself; server-update asks before restarting
// and check.sh warns when a restart has been waiting for more than 7 days.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "false";
EOF
    # Earlier versions also updated cloudflared automatically.
    if [ -e "$UU_CLOUDFLARE" ]; then
        run rm -f -- "$UU_CLOUDFLARE"
    fi
    run systemctl enable --now unattended-upgrades.service
    run systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
    if [ "$DRY_RUN" = false ]; then
        local timer origins
        for timer in apt-daily.timer apt-daily-upgrade.timer; do
            systemctl is-enabled --quiet "$timer" || warn "$timer is not enabled; automatic security updates will not run"
        done
        # Prove the result: exactly one allowed origin, the security pocket.
        origins="$(apt-config dump 2>/dev/null | grep -E '^Unattended-Upgrade::(Allowed-Origins|Origins-Pattern):: ' || true)"
        # shellcheck disable=SC2016 # the ${...} are unattended-upgrades variables, not shell
        if [ "$origins" != 'Unattended-Upgrade::Allowed-Origins:: "${distro_id}:${distro_codename}-security";' ]; then
            die "The automatic update settings did not come out as expected (only security patches). Found: ${origins:-nothing}"
        fi
    fi
    install_update_tool
    ok "Only Ubuntu security patches install by themselves (daily); the server never restarts by itself"
    ok "Everything else waits for you: sudo server-update"
    done_item "Automatic updates: Ubuntu security patches only, no automatic restart. Other updates: sudo server-update (backup first, asks before restarting)"
}

# server-update: the owner's command for every other update.
install_update_tool() {
    update_script | write_file "$UPDATE_BIN" 0755
}

update_script() {
    cat <<'UPDATE_EOF'
#!/bin/bash
# server-update: install waiting updates when YOU choose. Installed by bootstrap.sh.
#
# Automatic updates on this server install only Ubuntu security patches and
# never restart it. Everything else (Ubuntu's regular updates, Docker,
# cloudflared) waits for this command. It shows what is waiting, asks, runs the
# backup first (if server-backup is installed), updates, and asks before a
# restart.
#
#   sudo server-update                       show, ask, back up, update
#   sudo server-update --dry-run             only show what is waiting
#   sudo server-update --yes                 do not ask before updating
#   sudo server-update --skip-backup         update without running the backup
#   sudo server-update --allow-docker-major  also move Docker to a new major version
#
# Docker's major version (for example 28) is pinned in
# /etc/apt/preferences.d/docker-major-pin, so a normal run installs only
# updates within that major version. --allow-docker-major lifts the pin for
# this run and then pins the new major version.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin
umask 022

PIN_FILE="/etc/apt/preferences.d/docker-major-pin"
BACKUP_BIN="/usr/local/sbin/server-backup"
REBOOT_FILE="/var/run/reboot-required"
DOCKER_PKGS="docker-ce docker-ce-cli docker-ce-rootless-extras"
CONTAINERD_PKG="containerd.io"
APT_OPTS=(-y -o DPkg::Lock::Timeout=900 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

DRY_RUN=false
ASSUME_YES=false
SKIP_BACKUP=false
ALLOW_MAJOR=false
PREF_OPTS=()
TMP=""

if [ -t 1 ]; then
    B=$'\033[1m'; Y=$'\033[33m'; R=$'\033[31m'; G=$'\033[32m'; N=$'\033[0m'
else
    B=""; Y=""; R=""; G=""; N=""
fi
say()  { printf '%s\n' "$*"; }
warn() { printf '%sWARN%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '\n%sSTOPPED:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
cleanup() { if [ -n "$TMP" ]; then rm -rf -- "$TMP"; fi; }
trap cleanup EXIT

usage() {
    sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'
}

have_tty() { { : >/dev/tty; } 2>/dev/null; }

# Ask on the console; default "no". Without a console the answer is "no".
ask() {
    local answer=""
    have_tty || return 1
    printf '%s [y/N] ' "$1" >/dev/tty
    read -r answer </dev/tty || answer=""
    case "$answer" in y | Y | yes | YES | Yes) return 0 ;; *) return 1 ;; esac
}

installed_version() {
    dpkg-query -W -f '${db:Status-Abbrev} ${Version}\n' "$1" 2>/dev/null | awk '$1 == "ii" { print $2; exit }'
}

# The pin pattern for a version: epoch and major number, "5:28.1.1-1~..." -> "5:28".
major_of() {
    local v="$1" epoch=""
    case "$v" in *:*) epoch="${v%%:*}:"; v="${v#*:}" ;; esac
    v="${v%%[!0-9]*}"
    [ -n "$v" ] && printf '%s%s' "$epoch" "$v"
}

# Pin Docker (and containerd) to the major version installed now.
write_pin() {
    local dv cv dm cm tmpdir content
    dv="$(installed_version docker-ce || true)"
    cv="$(installed_version "$CONTAINERD_PKG" || true)"
    dm="$(major_of "${dv:-}" || true)"
    cm="$(major_of "${cv:-}" || true)"
    if [ -z "$dm" ] && [ -z "$cm" ]; then
        say "Docker is not installed, so there is no Docker version to pin."
        return 0
    fi
    content="# Written by bootstrap.sh / server-update. Keeps Docker on its current
# major version: newer versions within it are preferred (990), a new major
# version (default 500) is never chosen. To move to a new major version:
#   sudo server-update --allow-docker-major
"
    if [ -n "$dm" ]; then
        content="$content
Package: $DOCKER_PKGS
Pin: version $dm.*
Pin-Priority: 990
"
    fi
    if [ -n "$cm" ]; then
        content="$content
Package: $CONTAINERD_PKG
Pin: version $cm.*
Pin-Priority: 990
"
    fi
    if [ -f "$PIN_FILE" ] && [ "$(cat -- "$PIN_FILE")" = "$(printf '%s' "$content")" ]; then
        say "Docker pin unchanged (${dm:+docker-ce ${dm#*:}.x}${cm:+, containerd.io $cm.x})."
        return 0
    fi
    mkdir -p "$(dirname "$PIN_FILE")"
    # Stage next to preferences.d, not inside it (apt reads every file there).
    tmpdir="$(mktemp -d /etc/apt/.server-update.XXXXXX)"
    printf '%s' "$content" >"$tmpdir/pin"
    chmod 0644 "$tmpdir/pin"
    mv -f -- "$tmpdir/pin" "$PIN_FILE"
    rmdir -- "$tmpdir"
    say "Docker pinned to its current major version (${dm:+docker-ce ${dm#*:}.x}${cm:+, containerd.io $cm.x})."
}

# The highest version of a package that apt knows of (ignoring pins).
highest_known_version() {
    local best="" v
    while read -r v; do
        [ -n "$v" ] || continue
        if [ -z "$best" ] || dpkg --compare-versions "$v" gt "$best"; then best="$v"; fi
    done < <(apt-cache madison "$1" 2>/dev/null | awk -F'|' '{ gsub(/ /, "", $2); print $2 }')
    printf '%s' "$best"
}

# Group the planned changes: security, ubuntu, docker, cloudflared, other, remove.
plan() {
    apt-get -s -o Debug::NoLocking=1 "${PREF_OPTS[@]}" full-upgrade 2>/dev/null | awk '
        /^Inst / {
            name = $2; rest = $0; sub(/^Inst [^ ]+ /, "", rest); old = ""
            if (rest ~ /^\[/) { old = substr(rest, 2, index(rest, "]") - 2); rest = substr(rest, index(rest, "]") + 2) }
            sub(/^\(/, "", rest); split(rest, a, " "); new = a[1]
            if (name ~ /^docker-/ || name == "containerd.io") grp = "docker"
            else if (name == "cloudflared") grp = "cloudflared"
            else if (rest ~ /-security/) grp = "security"
            else if (rest ~ /Ubuntu:/) grp = "ubuntu"
            else grp = "other"
            printf "%s\t%s\t%s\t%s\n", grp, name, (old == "" ? "new" : old), new
        }
        /^Remv / { name = $2; ver = $3; gsub(/[][]/, "", ver); printf "remove\t%s\t%s\t-\n", name, ver }'
}

show_plan() {
    local list="$1" grp title n
    for grp in security ubuntu docker cloudflared other remove; do
        case "$grp" in
            security) title="Ubuntu security updates" ;;
            ubuntu) title="Other Ubuntu updates" ;;
            docker) title="Docker" ;;
            cloudflared) title="Cloudflare Tunnel (cloudflared)" ;;
            other) title="Other packages" ;;
            remove) title="Packages that would be REMOVED" ;;
        esac
        n="$(awk -F'\t' -v g="$grp" '$1 == g' <<<"$list" | grep -c . || true)"
        printf '%s%s: %s%s\n' "$B" "$title" "$n" "$N"
        if [ "$n" -gt 0 ]; then
            awk -F'\t' -v g="$grp" '$1 == g { if (g == "remove") printf "    %s %s\n", $2, $3; else printf "    %s  %s -> %s\n", $2, $3, $4 }' <<<"$list"
        fi
    done
}

docker_major_notice() {
    local pkg inst best
    for pkg in docker-ce "$CONTAINERD_PKG"; do
        inst="$(installed_version "$pkg" || true)"
        [ -n "$inst" ] || continue
        best="$(highest_known_version "$pkg")"
        if [ -n "$best" ] && dpkg --compare-versions "$best" gt "$inst" && [ "$(major_of "$best")" != "$(major_of "$inst")" ]; then
            if [ "$ALLOW_MAJOR" = true ]; then
                say "${Y}New major version allowed in this run:${N} $pkg $inst -> $best"
            else
                say "${Y}Held back:${N} $pkg $best is a new major version (installed: $inst)."
                say "    Read Docker's release notes first, then: sudo server-update --allow-docker-major"
            fi
        fi
    done
}

reboot_status() {
    local since days
    if [ -f "$REBOOT_FILE" ]; then
        since="$(stat -c %Y "$REBOOT_FILE")"
        days=$(( ($(date +%s) - since) / 86400 ))
        say "${Y}A restart is needed${N} (for: $(tr '\n' ' ' <"$REBOOT_FILE.pkgs" 2>/dev/null || echo "an update"); waiting $days days)."
        return 0
    fi
    say "No restart needed."
    return 1
}

main() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --dry-run | -n) DRY_RUN=true ;;
            --yes | -y) ASSUME_YES=true ;;
            --skip-backup) SKIP_BACKUP=true ;;
            --allow-docker-major) ALLOW_MAJOR=true ;;
            pin) [ "$(id -u)" -eq 0 ] || die "Please run with sudo."; write_pin; exit 0 ;;
            --help | -h) usage; exit 0 ;;
            *) usage >&2; die "Unknown option: $1" ;;
        esac
        shift
    done
    if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" = false ]; then
        die "Please run with sudo: sudo server-update"
    fi

    if [ "$ALLOW_MAJOR" = true ]; then
        # Read every preferences file except the Docker pin, for this run only.
        TMP="$(mktemp -d)"
        mkdir "$TMP/preferences.d"
        local f
        for f in /etc/apt/preferences.d/*; do
            if [ -f "$f" ] && [ "$f" != "$PIN_FILE" ]; then cp -- "$f" "$TMP/preferences.d/"; fi
        done
        PREF_OPTS=(-o "Dir::Etc::PreferencesParts=$TMP/preferences.d")
    fi

    if [ "$DRY_RUN" = true ]; then
        say "Dry run: nothing is changed. Package lists are from $(date -r /var/lib/apt/lists '+%Y-%m-%d %H:%M' 2>/dev/null || echo 'an unknown time') (they refresh daily)."
    else
        say "Refreshing the package lists..."
        apt-get -o DPkg::Lock::Timeout=900 update -qq || die "Could not refresh the package lists. Check the internet connection and try again."
    fi

    local list total
    list="$(plan)" || die "apt could not work out the updates. Try: sudo apt-get -f install"
    total="$(grep -c . <<<"$list" || true)"
    say ""
    show_plan "$list"
    say ""
    docker_major_notice
    if [ "$total" -eq 0 ]; then
        say "${G}Nothing to update.${N}"
        reboot_status || true
        exit 0
    fi
    if [ "$DRY_RUN" = true ]; then
        reboot_status || true
        say "Dry run: nothing was changed. To install these: sudo server-update"
        exit 0
    fi

    if [ "$ASSUME_YES" = false ] && ! ask "Install these $total updates now?"; then
        say "Nothing was changed."
        exit 0
    fi

    if [ "$SKIP_BACKUP" = true ]; then
        warn "Skipping the backup (--skip-backup)."
    elif [ -x "$BACKUP_BIN" ]; then
        say "Running the backup first..."
        local brc=0
        "$BACKUP_BIN" run || brc=$?
        case "$brc" in
            0) say "Backup done." ;;
            3) die "Backups are not set up yet, so nothing was updated. Set them up (sudo server-backup setup), or update without a backup: sudo server-update --skip-backup" ;;
            75) die "Another backup or restore is running, so nothing was updated. Try again in a while." ;;
            *) die "The backup failed, so nothing was updated. Fix the backup first (sudo server-backup status), or run: sudo server-update --skip-backup" ;;
        esac
    else
        say "No backup tool installed ($BACKUP_BIN), so no backup is made first."
    fi

    local cf_before cf_after
    cf_before="$(installed_version cloudflared || true)"
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
    apt-get "${APT_OPTS[@]}" "${PREF_OPTS[@]}" upgrade || die "The update stopped with an error (see above). Run sudo server-update again; if it repeats: sudo dpkg --configure -a"
    apt-get "${APT_OPTS[@]}" "${PREF_OPTS[@]}" full-upgrade || die "The update stopped with an error (see above). Run sudo server-update again; if it repeats: sudo dpkg --configure -a"
    cf_after="$(installed_version cloudflared || true)"
    if [ "$ALLOW_MAJOR" = true ]; then
        write_pin
    fi
    say ""
    say "${G}Updates installed.${N}"

    if reboot_status; then
        if ask "Restart the server now? Websites are down for a minute or two."; then
            say "Restarting now."
            systemctl reboot
            exit 0
        fi
        say "Restart later, at a quiet time: sudo reboot"
    fi
    # apt replaced cloudflared's program but the tunnel still runs the old
    # one. Restarting it drops sessions that come through it (perhaps this
    # one), so it is the very last step.
    if [ -n "$cf_after" ] && [ "$cf_after" != "$cf_before" ] && systemctl is-active --quiet cloudflared.service 2>/dev/null; then
        say "Restarting the tunnel with the new cloudflared. A browser SSH session drops; open it again in a few seconds."
        systemctl restart --no-block cloudflared.service
    fi
}

main "$@"
UPDATE_EOF
}

# Pin Docker's major version now that Docker exists (written by server-update).
pin_docker_major() {
    step "Keeping Docker on its current major version"
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] $UPDATE_BIN pin (writes $DOCKER_PIN_FILE for the installed Docker major version)"
        return 0
    fi
    local out
    out="$("$UPDATE_BIN" pin)" || die "Could not pin Docker's version ($DOCKER_PIN_FILE)."
    info "$out"
    done_item "Docker pinned to its current major version ($DOCKER_PIN_FILE); a new major only with: sudo server-update --allow-docker-major"
}

# ---------------------------------------------------------------------------
# 4. Swap
# ---------------------------------------------------------------------------
# Make $SWAPFILE a swap file and turn it on. Returns 1 if the system refuses.
enable_swapfile() {
    if [ "$DRY_RUN" = true ]; then
        run chmod 600 "$SWAPFILE"
        run mkswap "$SWAPFILE"
        run swapon "$SWAPFILE"
        return 0
    fi
    chmod 600 "$SWAPFILE"
    if ! blkid -p "$SWAPFILE" 2>/dev/null | grep -q 'TYPE="swap"'; then
        mkswap "$SWAPFILE" >/dev/null
    fi
    swapon "$SWAPFILE" 2>/dev/null
}

configure_swap() {
    step "Checking swap space"
    local use_swapfile=false
    if [ -n "$(swapon --noheadings --show 2>/dev/null || true)" ]; then
        ok "Swap already present"
    else
        local made=true
        if [ ! -f "$SWAPFILE" ]; then
            if ! run fallocate -l 2G "$SWAPFILE"; then
                rm -f -- "$SWAPFILE"
                made=false
            fi
        else
            info "Found $SWAPFILE but it is not in use; turning it on"
        fi
        if [ "$made" = true ] && enable_swapfile; then
            use_swapfile=true
        else
            # Some file systems refuse fallocate'd swap files; write it out instead.
            rm -f -- "$SWAPFILE"
            if ! dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=none; then
                rm -f -- "$SWAPFILE"
                warn "Could not write a 2 GB swap file (is the disk full?). Continuing without swap."
            elif enable_swapfile; then
                use_swapfile=true
            else
                rm -f -- "$SWAPFILE"
                warn "This system does not allow a swap file. Continuing without swap."
            fi
        fi
        if [ "$use_swapfile" = true ]; then ok "2 GB swap file is on"; fi
    fi
    if [ "$use_swapfile" = true ] && ! grep -qE "^[[:space:]]*${SWAPFILE}[[:space:]]" /etc/fstab 2>/dev/null; then
        if [ "$DRY_RUN" = true ]; then
            info "[dry-run] add '$SWAPFILE none swap sw 0 0' to /etc/fstab"
        else
            printf '%s none swap sw 0 0\n' "$SWAPFILE" >>/etc/fstab
        fi
    fi
    write_file "$SWAPPINESS_CONF" 0644 <<'EOF'
# Written by bootstrap.sh: prefer memory, use swap only under pressure.
vm.swappiness = 10
EOF
    if ! run sysctl -q --load "$SWAPPINESS_CONF"; then
        warn "Could not set vm.swappiness now; it applies after the next restart."
    fi
    done_item "Swap checked (2 GB file added if there was none), swappiness 10"
}

# ---------------------------------------------------------------------------
# 5. SSH
# ---------------------------------------------------------------------------
configure_ssh() {
    step "Hardening SSH"
    # The 01- prefix makes this file win: sshd uses the first value it reads,
    # and files in sshd_config.d are read in name order before sshd_config
    # (Ubuntu's sshd_config includes them on its first line, which is what
    # Cloudflare's guide asks for: these lines "at the top").
    local ca_lines=""
    if [ "$MODE" = cloudflare ]; then
        ca_lines="
# Cloudflare mode: Cloudflare's browser SSH terminal arrives through the tunnel
# and logs in with a short-lived certificate (valid for minutes) signed by the
# Cloudflare account's SSH CA. No password is ever accepted, not even from
# this server itself. The certificate's principal (the Cloudflare email before
# the @) must be listed in $SSH_PRINCIPALS_DIR/<user> for the Ubuntu user it
# logs in as; only the owner's account has such a file, so root and every
# other account cannot log in with a certificate. Ubuntu 24.04's default
# PubkeyAcceptedAlgorithms and CASignatureAlgorithms accept Cloudflare's ECDSA
# certificates; server-ssh-ca checks that whenever the key is set.
TrustedUserCAKeys $SSH_CA_FILE
AuthorizedPrincipalsFile $SSH_PRINCIPALS_DIR/%u"
        ssh_ca_script | write_file "$SSH_CA_BIN" 0755
        if [ "$DRY_RUN" = false ]; then
            install -d -m 0755 -o root -g root "$SSH_PRINCIPALS_DIR"
        fi
        write_file "$SSH_PRINCIPALS_DIR/$OWNER_USER" 0644 <<EOF
# Written by bootstrap.sh. Cloudflare SSH certificates whose principal is on a
# line below may log in as the Ubuntu user "$OWNER_USER". Cloudflare uses the
# part of the sign-in email before the @, in lower case. The Ubuntu user name
# is listed too, for certificates issued for the name typed at the login.
$SSH_PRINCIPAL
$( [ "$SSH_PRINCIPAL" = "$OWNER_USER" ] || printf '%s' "$OWNER_USER" )
EOF
    fi
    {
        cat <<'EOF'
# Written by bootstrap.sh. No passwords over SSH at all.
# Root may log in only with a key: Coolify manages this server as root over SSH
# with its own key, from its container (Docker private network only, see ufw).
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
# The AI agent account never logs in over SSH (it is started on the server).
DenyUsers ops-agent
EOF
        if [ -n "$ca_lines" ]; then printf '%s\n' "$ca_lines"; fi
    } | write_file "$SSHD_DROPIN" 0644
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] sshd -t (check the config), reload SSH, prove: no password for $OWNER_USER from 127.0.0.1, ::1 or elsewhere"
        if [ "$MODE" = cloudflare ]; then
            info "[dry-run] save the Cloudflare SSH CA key (if given) with: $SSH_CA_BIN set"
        fi
    else
        mkdir -p /run/sshd
        if ! sshd -t; then
            rm -f -- "$SSHD_DROPIN"
            die "The SSH settings did not pass the check, so they were removed again. SSH is unchanged."
        fi
        if systemctl is-active --quiet ssh.service; then
            systemctl reload ssh.service
        elif ! systemctl is-active --quiet ssh.socket; then
            systemctl enable --now ssh.socket
        fi
        # Ubuntu 24.04 starts sshd on demand (ssh.socket); new logins read the new settings.
        verify_ssh_rules
        if [ "$MODE" = cloudflare ] && [ -n "$SSH_CA_KEY" ]; then
            ensure_workdir
            printf '%s\n' "$SSH_CA_KEY" >"$WORKDIR/ca.pub"
            "$SSH_CA_BIN" set "$WORKDIR/ca.pub" | sed 's/^/    /' ||
                die "The SSH CA key could not be saved (see above). Add it later: sudo server-ssh-ca set"
        fi
    fi
    if [ "$MODE" = cloudflare ]; then
        ok "SSH: no passwords at all; browser SSH with a Cloudflare certificate for '$SSH_PRINCIPAL' as user '$OWNER_USER'"
        if [ "$DRY_RUN" = false ] && [ ! -s "$SSH_CA_FILE" ]; then
            warn "Browser SSH needs the Cloudflare SSH CA key. When you have it: sudo server-ssh-ca set"
        fi
        done_item "SSH hardened (no passwords; root by key only; browser SSH by Cloudflare short-lived certificate for $OWNER_USER only; 3 tries)"
    else
        ok "SSH: no passwords, root only with a key, 3 tries per connection"
        warn "Password login over SSH is now OFF. Use the Hyper-V console to log in, as before."
        done_item "SSH hardened (passwords off, root by key only, 3 tries)"
    fi
}

# Ask sshd what it will really do, for connections from this server itself
# (where the tunnel arrives) and from elsewhere. Undo the settings if any check
# fails.
verify_ssh_rules() {
    local addr user v problems=""
    sshd_value() {
        sshd -T -C "addr=$1,user=$2,host=check.invalid,laddr=127.0.0.1,lport=22" 2>/dev/null | awk -v k="$3" '$1 == k { print $2; exit }'
    }
    for addr in 127.0.0.1 ::1 203.0.113.9; do
        for user in "$OWNER_USER" root; do
            v="$(sshd_value "$addr" "$user" passwordauthentication)"
            [ "$v" = no ] || problems="$problems password($addr,$user)=$v"
            v="$(sshd_value "$addr" "$user" kbdinteractiveauthentication)"
            [ "$v" = no ] || problems="$problems keyboard($addr,$user)=$v"
        done
        v="$(sshd_value "$addr" root permitrootlogin)"
        case "$v" in without-password | prohibit-password) ;; *) problems="$problems root($addr)=$v" ;; esac
    done
    if [ "$MODE" = cloudflare ]; then
        v="$(sshd_value 127.0.0.1 "$OWNER_USER" trustedusercakeys)"
        [ "$v" = "$SSH_CA_FILE" ] || problems="$problems ca=$v"
        v="$(sshd_value 127.0.0.1 "$OWNER_USER" authorizedprincipalsfile)"
        [ "$v" = "$SSH_PRINCIPALS_DIR/%u" ] || problems="$problems principals=$v"
    fi
    if [ -n "$problems" ]; then
        rm -f -- "$SSHD_DROPIN"
        systemctl reload ssh.service 2>/dev/null || true
        die "The SSH rules did not check out ($problems ), so the settings were removed again."
    fi
    ok "Checked: no password login for '$OWNER_USER' or root, from this server or anywhere else"
}

ssh_ca_script() {
    cat <<'CA_EOF'
#!/bin/bash
# server-ssh-ca: the Cloudflare SSH CA key that lets Cloudflare's browser SSH
# terminal log in with short-lived certificates. Installed by bootstrap.sh.
#
#   sudo server-ssh-ca set          paste the CA public key from Cloudflare
#   sudo server-ssh-ca set FILE     read the key from FILE
#   sudo server-ssh-ca status       show the key and who may log in with it
#
# Where to find the key in Cloudflare: Zero Trust, Access controls, Service
# credentials, SSH, Add a certificate, choose the browser SSH application
# (ssh.<your domain>), Generate certificate, then copy the "CA public key"
# (one line that starts with ecdsa-sha2-nistp256).
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 022

CA_FILE="/etc/ssh/ca.pub"
PRINCIPALS_DIR="/etc/ssh/principals"
DROPIN="/etc/ssh/sshd_config.d/01-server-hardening.conf"

die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
have_tty() { { : >/dev/tty; } 2>/dev/null; }

trim() {
    local t="${1//$'\r'/}"
    t="${t#"${t%%[![:space:]]*}"}"
    printf '%s' "${t%"${t##*[![:space:]]}"}"
}

key_valid() {
    local key="$1"
    [[ $key =~ ^(ecdsa-sha2-nistp(256|384|521)|ssh-ed25519|ssh-rsa)\ [A-Za-z0-9+/]{40,}={0,3}(\ [^[:cntrl:]]*)?$ ]] || return 1
    printf '%s\n' "$key" | ssh-keygen -l -f /dev/stdin >/dev/null 2>&1
}

# sshd must accept signatures made by this CA type, and certificates of that
# type (Ubuntu 24.04's defaults do; a custom PubkeyAcceptedAlgorithms or
# CASignatureAlgorithms line could remove them).
algorithms_ok() {
    local type="$1" cfg sig cert
    cfg="$(sshd -T -C user=check,addr=127.0.0.1,host=localhost,laddr=127.0.0.1,lport=22 2>/dev/null)" || return 1
    case "$type" in
        ssh-rsa) sig="rsa-sha2-512"; cert="rsa-sha2-512-cert-v01@openssh.com" ;;
        *) sig="$type"; cert="$type-cert-v01@openssh.com" ;;
    esac
    awk '$1 == "casignaturealgorithms" { print $2 }' <<<"$cfg" | tr ',' '\n' | grep -qxF -- "$sig" || return 1
    awk '$1 == "pubkeyacceptedalgorithms" { print $2 }' <<<"$cfg" | tr ',' '\n' | grep -qxF -- "$cert"
}

reload_ssh() {
    if systemctl is-active --quiet ssh.service 2>/dev/null; then
        systemctl reload ssh.service
    fi
    # With ssh.socket (Ubuntu 24.04's default) every new login reads the files.
}

cmd_status() {
    local f rc=0 cfg
    if [ -s "$CA_FILE" ]; then
        echo "SSH CA key in $CA_FILE:"
        ssh-keygen -l -f "$CA_FILE" 2>/dev/null | sed 's/^/    /' || { echo "    (cannot be read)"; rc=1; }
    else
        echo "No SSH CA key yet, so browser SSH cannot log in. Add it: sudo server-ssh-ca set"
        rc=1
    fi
    cfg="$(sshd -T -C user=check,addr=127.0.0.1,host=localhost,laddr=127.0.0.1,lport=22 2>/dev/null || true)"
    if ! grep -qx "trustedusercakeys $CA_FILE" <<<"$cfg"; then
        echo "SSH does not use $CA_FILE. Run bootstrap.sh again with --cloudflare."
        rc=1
    fi
    for f in "$PRINCIPALS_DIR"/*; do
        [ -f "$f" ] || continue
        echo "Ubuntu user $(basename "$f") accepts certificates for: $(grep -v '^[[:space:]]*\(#\|$\)' "$f" | tr '\n' ' ')"
    done
    return "$rc"
}

cmd_set() {
    local src="${1:-}" line="" previous="" stage
    [ "$(id -u)" -eq 0 ] || die "Please run with sudo: sudo server-ssh-ca set"
    if [ -n "$src" ]; then
        [ -r "$src" ] || die "Cannot read $src"
        line="$(grep -v '^[[:space:]]*\(#\|$\)' -- "$src" | head -n 1 || true)"
    elif have_tty; then
        printf 'Paste the SSH CA public key from Cloudflare (one line, starts with\necdsa-sha2-nistp256), then press Enter: ' >/dev/tty
        IFS= read -r line </dev/tty || line=""
    else
        IFS= read -r line || line=""
    fi
    line="$(trim "$line")"
    key_valid "$line" ||
        die "That does not look like an SSH CA public key. Copy the whole line (it starts with ecdsa-sha2-nistp256) from Cloudflare: Zero Trust, Access controls, Service credentials, SSH."
    if ! grep -q "^TrustedUserCAKeys $CA_FILE" "$DROPIN" 2>/dev/null; then
        echo "Note: SSH is not set up for certificates yet. Run bootstrap.sh again with --cloudflare."
    fi
    if [ -f "$CA_FILE" ]; then previous="$(cat -- "$CA_FILE")"; fi
    # Stage next to the file and move it into place in one step.
    stage="$(mktemp -d /etc/ssh/.server-ssh-ca.XXXXXX)"
    printf '%s\n' "$line" >"$stage/ca.pub"
    chmod 0644 "$stage/ca.pub"
    mv -f -- "$stage/ca.pub" "$CA_FILE"
    rmdir -- "$stage"
    if ! sshd -t || ! algorithms_ok "${line%% *}"; then
        if [ -n "$previous" ]; then printf '%s\n' "$previous" >"$CA_FILE"; else rm -f -- "$CA_FILE"; fi
        die "SSH does not accept this key type (${line%% *}), so the previous setting was put back."
    fi
    if [ -n "$previous" ] && [ "$previous" != "$line" ]; then
        printf '%s\n' "$previous" >"$CA_FILE.previous"
        echo "The old key is kept in $CA_FILE.previous (not used)."
    fi
    reload_ssh
    echo "Saved. Browser SSH can now log in with Cloudflare certificates."
    cmd_status || true
}

case "${1:-status}" in
    set) cmd_set "${2:-}" ;;
    status) cmd_status ;;
    -h | --help | help) sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//' ;;
    *) echo "Usage: server-ssh-ca set [FILE] | status" >&2; exit 2 ;;
esac
CA_EOF
}

# ---------------------------------------------------------------------------
# 6. Firewall (ufw)
# ---------------------------------------------------------------------------
configure_ufw() {
    step "Setting up the firewall (ufw)"
    local range iface
    run ufw default deny incoming
    run ufw default allow outgoing
    if [ "$MODE" = cloudflare ]; then
        # Nothing from the internet. cloudflared connects out to Cloudflare and then
        # to local services over loopback, which ufw always allows (its before.rules
        # accept everything on "lo"). Remove web rules an earlier direct setup added.
        if [ "$DRY_RUN" = false ]; then
            local web
            for web in 80/tcp 443/tcp 443/udp 80 443 http https; do
                ufw delete allow "$web" >/dev/null 2>&1 || true
            done
        else
            info "[dry-run] remove any 'allow 80', 'allow 443' rules"
        fi
    else
        run ufw allow 80/tcp comment 'web (HTTP, certificates)'
        run ufw allow 443/tcp comment 'web (HTTPS)'
        run ufw allow 443/udp comment 'web (HTTP/3)'
    fi
    # SSH never from the internet. Block it on the internet network card first,
    # so even a neighbour on the provider network using a private address is refused.
    for iface in $PUBLIC_IF $PUBLIC_IF6; do
        if [ -n "$iface" ]; then
            run ufw prepend deny in on "$iface" to any port 22 proto tcp comment 'no SSH from the internet'
        fi
    done
    for range in $DOCKER_RANGES; do
        run ufw allow from "$range" to any port 22 proto tcp comment 'Coolify container to host SSH'
    done
    # Remove broad SSH rules a previous setup may have added. Missing rules are fine.
    if [ "$DRY_RUN" = false ]; then
        ufw delete allow OpenSSH >/dev/null 2>&1 || true
        ufw delete allow 22/tcp >/dev/null 2>&1 || true
        ufw delete allow 22 >/dev/null 2>&1 || true
        ufw delete allow ssh >/dev/null 2>&1 || true
    else
        info "[dry-run] remove any 'allow OpenSSH', 'allow 22', 'allow ssh' rules"
    fi
    run ufw --force enable
    if [ "$MODE" = cloudflare ]; then
        ok "Firewall on: nothing may connect in from the internet"
        done_item "Firewall (ufw) on: no incoming connections from the internet; SSH only from Docker networks"
    else
        ok "Firewall on: from the internet only 80/tcp, 443/tcp, 443/udp"
        done_item "Firewall (ufw) on: internet may reach only 80/tcp, 443/tcp, 443/udp; SSH only from Docker networks"
    fi
}

# ---------------------------------------------------------------------------
# 7. docker-port-guard (DOCKER-USER rules)
# ---------------------------------------------------------------------------
guard_script() {
    cat <<'GUARD_EOF'
#!/bin/bash
# docker-port-guard: keep Docker container ports off the internet.
# Installed by bootstrap.sh.
#
# Docker publishes container ports with its own iptables rules, which skip ufw.
# This script fills a chain called PORT-GUARD and jumps to it first from Docker's
# DOCKER-USER chain (the place Docker reserves for user rules). The chain lets
# through, in order:
#   - replies to connections that are already allowed,
#   - traffic from this host and from Docker's own networks (lo, docker0, br-*),
#   - new connections to 80/tcp, 443/tcp and 443/udp (Coolify's Traefik proxy),
#     except with MODE="cloudflare", where web traffic arrives through the
#     Cloudflare Tunnel on this host instead and no container port is public,
#   - extra ports listed in /etc/default/docker-port-guard (EXTRA_ALLOWED),
#   - during the setup window only: Coolify's 8000 and 6001,
# and drops everything else that comes from outside. That blocks Coolify's
# 8000/6001/6002 and Traefik's 8080 from the internet.
#
# Connections made on this host itself (cloudflared to 127.0.0.1:80 or :8000)
# do not pass through the FORWARD chain from outside, so they are not affected.
#
# Ports are matched with conntrack --ctorigdstport, the port the visitor asked
# for, because Docker has already rewritten the port (8000 -> 8080) by the time
# the packet reaches DOCKER-USER.
#
# Usage:
#   docker-port-guard apply                  rebuild the rules (safe to repeat)
#   docker-port-guard open-setup [M] [ADDR]  allow 8000 and 6001 for M minutes
#                                            (default 30), only from ADDR if given
#                                            (your computer's internet address)
#   docker-port-guard close                  end the setup window now
#   docker-port-guard status                 show the rules
#   docker-port-guard check-config           check the settings file
#
# The settings file is read as plain KEY=value lines, never run as a script.
# If it has a mistake, the guard does NOT stop (Docker must keep starting); it
# logs the mistake and uses safe settings instead: no extra ports, and the
# closed Cloudflare mode unless a valid MODE line was read. A mistake can
# therefore only close ports, never open them.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin

CHAIN="PORT-GUARD"
CONFIG="/etc/default/docker-port-guard"
STATE_DIR="/run/docker-port-guard"
CLOSE_UNIT="docker-port-guard-close"
SELF="/usr/local/sbin/docker-port-guard"
ALWAYS_ALLOWED="tcp/80 tcp/443 udp/443"
SETUP_PORTS="tcp/8000 tcp/6001"
TRUSTED_IFACES="lo docker0 br-+"
EXTRA_ALLOWED=""
MODE="direct"
CONFIG_ERRORS=""

# Test hooks: let a test point the script at other files.
CONFIG="${DPG_CONFIG:-$CONFIG}"
STATE_DIR="${DPG_STATE_DIR:-$STATE_DIR}"
WINDOW_FILE="$STATE_DIR/setup-window-until"
FROM_FILE="$STATE_DIR/setup-window-from"

log_error() {
    echo "docker-port-guard: $*" >&2
    logger -t docker-port-guard -p user.err -- "$*" 2>/dev/null || true
}

valid_port_entry() {
    [[ $1 =~ ^(tcp|udp)/([0-9]{1,5})$ ]] && [ "${BASH_REMATCH[2]}" -ge 1 ] && [ "${BASH_REMATCH[2]}" -le 65535 ]
}

read_config() {
    local line key value n=0 mode_seen="" extra_seen="" entry bad
    [ -e "$CONFIG" ] || return 0
    if [ ! -r "$CONFIG" ]; then
        CONFIG_ERRORS="cannot read $CONFIG"
    else
        while IFS= read -r line || [ -n "$line" ]; do
            n=$((n + 1))
            line="${line//$'\r'/}"
            line="${line#"${line%%[![:space:]]*}"}"
            line="${line%"${line##*[![:space:]]}"}"
            case "$line" in '' | '#'*) continue ;; esac
            if [[ ! $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
                CONFIG_ERRORS="$CONFIG_ERRORS; line $n is not KEY=value"
                continue
            fi
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            case "$value" in
                \"*\") value="${value:1:${#value}-2}" ;;
                \'*\') value="${value:1:${#value}-2}" ;;
            esac
            if [[ ! $value =~ ^[A-Za-z0-9/\ ._-]*$ ]]; then
                CONFIG_ERRORS="$CONFIG_ERRORS; line $n has characters that do not belong in a setting"
                continue
            fi
            case "$key" in
                MODE)
                    case "$value" in
                        direct | cloudflare) mode_seen="$value" ;;
                        *) CONFIG_ERRORS="$CONFIG_ERRORS; line $n: MODE must be direct or cloudflare" ;;
                    esac
                    ;;
                EXTRA_ALLOWED)
                    bad=""
                    for entry in $value; do
                        valid_port_entry "$entry" || bad="$bad $entry"
                    done
                    if [ -n "$bad" ]; then
                        CONFIG_ERRORS="$CONFIG_ERRORS; line $n: not a port (use tcp/1234 or udp/1234):$bad"
                    else
                        extra_seen="$value"
                    fi
                    ;;
                *) CONFIG_ERRORS="$CONFIG_ERRORS; line $n: unknown setting $key" ;;
            esac
        done <"$CONFIG"
    fi
    if [ -n "$CONFIG_ERRORS" ]; then
        CONFIG_ERRORS="${CONFIG_ERRORS#; }"
        EXTRA_ALLOWED=""
        MODE="${mode_seen:-cloudflare}"
        log_error "mistake in $CONFIG ($CONFIG_ERRORS). Using safe settings: no extra ports, mode $MODE. Fix the file, then run: sudo docker-port-guard apply"
    else
        EXTRA_ALLOWED="$extra_seen"
        MODE="${mode_seen:-direct}"
    fi
}

read_config
case "$MODE" in
    cloudflare) ALWAYS_ALLOWED="" ;;
esac

window_until() {
    local until=""
    [ -r "$WINDOW_FILE" ] && until="$(cat "$WINDOW_FILE")"
    if [[ $until =~ ^[0-9]+$ ]] && [ "$(date +%s)" -lt "$until" ]; then
        printf '%s' "$until"
        return 0
    fi
    return 1
}

# The address the setup window is limited to, if any (checked when it was set).
window_from() {
    local from=""
    [ -r "$FROM_FILE" ] && from="$(cat "$FROM_FILE")"
    if [[ $from =~ ^[0-9a-fA-F:.]+/[0-9]{1,3}$ ]]; then
        printf '%s' "$from"
    fi
}

# The rules for one address family (4 or 6).
rule_set() {
    local fam="${1:-4}" entries="$ALWAYS_ALLOWED $EXTRA_ALLOWED" setup="" entry proto port iface from="" src=""
    if window_until >/dev/null; then
        from="$(window_from)"
        if [ -z "$from" ]; then
            setup="$SETUP_PORTS"
        elif { [ "$fam" = 6 ] && [[ $from == *:* ]]; } || { [ "$fam" = 4 ] && [[ $from != *:* ]]; }; then
            setup="$SETUP_PORTS"
            src="-s $from "
        fi
    fi
    echo "*filter"
    echo ":$CHAIN - [0:0]"
    echo "-A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
    for iface in $TRUSTED_IFACES; do
        echo "-A $CHAIN -i $iface -j RETURN"
    done
    for entry in $entries; do
        valid_port_entry "$entry" || continue
        proto="${entry%/*}"
        port="${entry#*/}"
        # Only traffic Docker forwarded from a published port (DNAT), not any
        # container address that happens to listen on the same port.
        echo "-A $CHAIN -p $proto -m conntrack --ctstate DNAT --ctorigdstport $port --ctdir ORIGINAL -j RETURN"
    done
    for entry in $setup; do
        proto="${entry%/*}"
        port="${entry#*/}"
        echo "-A $CHAIN ${src}-p $proto -m conntrack --ctstate DNAT --ctorigdstport $port --ctdir ORIGINAL -j RETURN"
    done
    echo "-A $CHAIN -j DROP"
    echo "COMMIT"
}

# Returns 0 when applied or when this address family does not exist here
# (IPv6 switched off), 1 when it exists but the rules could not be applied.
apply_family() {
    local fam="$1" ipt restore first rules nums n
    if [ "$fam" = 4 ]; then ipt=iptables; restore=iptables-restore; else ipt=ip6tables; restore=ip6tables-restore; fi
    if ! command -v "$ipt" >/dev/null 2>&1 || ! "$ipt" -w -S FORWARD >/dev/null 2>&1; then
        echo "docker-port-guard: $ipt not available, skipped"
        return 0
    fi
    "$ipt" -w -N DOCKER-USER 2>/dev/null || true
    rules="$(rule_set "$fam")" || return 1
    # One transaction: the chain is emptied and refilled atomically, no gap.
    printf '%s\n' "$rules" | "$restore" -w --noflush || return 1
    # Our jump must be rule 1. Insert it first, then remove older copies
    # (highest rule number first), so there is never a moment without it.
    first="$("$ipt" -w -S DOCKER-USER | sed -n '2p')" || return 1
    if [ "$first" != "-A DOCKER-USER -j $CHAIN" ]; then
        "$ipt" -w -I DOCKER-USER 1 -j "$CHAIN" || return 1
    fi
    nums="$("$ipt" -w -S DOCKER-USER | awk -v r="-A DOCKER-USER -j $CHAIN" 'NR > 2 && $0 == r { print NR - 1 }' | sort -rn)" || return 1
    for n in $nums; do
        "$ipt" -w -D DOCKER-USER "$n" || return 1
    done
    [ "$("$ipt" -w -S DOCKER-USER | sed -n '2p')" = "-A DOCKER-USER -j $CHAIN" ] || return 1
    echo "docker-port-guard: $ipt rules applied"
}

apply() {
    # Fail closed: if a family that exists cannot be protected, exit non-zero,
    # so Docker (ExecStartPre) does not start with its ports unprotected.
    if ! apply_family 4; then
        log_error "IPv4 rules could not be applied"
        exit 1
    fi
    if ! apply_family 6; then
        log_error "IPv6 is on but its rules could not be applied"
        exit 1
    fi
    local until ports from
    ports="$(printf '%s %s' "$ALWAYS_ALLOWED" "$EXTRA_ALLOWED" | xargs)"
    echo "docker-port-guard: mode $MODE, container ports open to the internet: ${ports:-none}"
    if until="$(window_until)"; then
        from="$(window_from)"
        echo "docker-port-guard: setup window OPEN until $(date -d "@$until" '+%H:%M')${from:+ (only from $from)}"
    fi
}

# Check an address with Python's ipaddress module and print it as a network
# (203.0.113.7 -> 203.0.113.7/32).
normalize_address() {
    python3 -I -c '
import ipaddress, sys
try:
    n = ipaddress.ip_network(sys.argv[1], strict=False)
except ValueError:
    sys.exit(1)
if n.is_unspecified or n.num_addresses > 256:
    sys.exit(2)
print(n)
' "$1"
}

open_setup() {
    local minutes="30" from="" norm rc
    if [ $# -gt 0 ] && [[ $1 =~ ^[0-9]+$ ]]; then minutes="$1"; shift; fi
    if [ $# -gt 0 ]; then from="$1"; shift; fi
    [ $# -eq 0 ] || { echo "Usage: docker-port-guard open-setup [minutes] [your-internet-address]" >&2; exit 2; }
    [ "$minutes" -ge 1 ] && [ "$minutes" -le 120 ] ||
        { echo "Minutes must be between 1 and 120" >&2; exit 2; }
    if [ -n "$from" ]; then
        rc=0
        norm="$(normalize_address "$from")" || rc=$?
        case "$rc" in
            0) ;;
            2) echo "'$from' covers too many addresses. Give your computer's internet address (search 'what is my IP' on it)." >&2; exit 2 ;;
            *) echo "'$from' is not an internet address, for example 203.0.113.7" >&2; exit 2 ;;
        esac
        from="$norm"
    fi
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    # The closing timer is created first: if it cannot be created, the ports
    # are never opened. The 5 minute apply timer is a second safety net that
    # closes any window whose time has passed.
    systemctl stop "$CLOSE_UNIT.timer" >/dev/null 2>&1 || true
    systemctl reset-failed "$CLOSE_UNIT.timer" "$CLOSE_UNIT.service" >/dev/null 2>&1 || true
    if ! systemd-run --quiet --unit="$CLOSE_UNIT" --on-active="${minutes}min" "$SELF" close ||
        ! systemctl is-active --quiet "$CLOSE_UNIT.timer"; then
        echo "docker-port-guard: could not create the closing timer, so the window was NOT opened" >&2
        exit 1
    fi
    if [ -n "$from" ]; then
        printf '%s\n' "$from" >"$FROM_FILE"
    else
        rm -f "$FROM_FILE"
    fi
    echo $(( $(date +%s) + minutes * 60 )) >"$WINDOW_FILE"
    apply
}

close_setup() {
    rm -f "$WINDOW_FILE" "$FROM_FILE"
    apply
    echo "docker-port-guard: setup window closed"
}

status() {
    local ipt until from
    for ipt in iptables ip6tables; do
        if command -v "$ipt" >/dev/null 2>&1 && "$ipt" -w -S "$CHAIN" >/dev/null 2>&1; then
            echo "== $ipt DOCKER-USER"
            "$ipt" -w -S DOCKER-USER
            echo "== $ipt $CHAIN"
            "$ipt" -w -S "$CHAIN"
        fi
    done
    echo "Mode: $MODE"
    if [ -n "$CONFIG_ERRORS" ]; then echo "Settings file has mistakes: $CONFIG_ERRORS"; fi
    if until="$(window_until)"; then
        from="$(window_from)"
        echo "Setup window: OPEN until $(date -d "@$until" '+%H:%M')${from:+ (only from $from)}"
    else
        echo "Setup window: closed"
    fi
}

case "${1:-apply}" in
    apply) apply ;;
    open-setup) shift; open_setup "$@" ;;
    close) close_setup ;;
    status) status ;;
    print-rules) rule_set "${2:-4}" ;;
    check-config)
        if [ -n "$CONFIG_ERRORS" ]; then exit 1; fi
        echo "docker-port-guard: $CONFIG is fine (mode $MODE, extra ports: ${EXTRA_ALLOWED:-none})"
        ;;
    *) echo "Usage: $0 apply | open-setup [minutes] [address] | close | status | check-config" >&2; exit 2 ;;
esac
GUARD_EOF
}

guard_mode_lines() {
    cat <<EOF
# Set by bootstrap.sh (run it again with --direct or --cloudflare to change it).
# direct: 80/443 of containers are open to the internet.
# cloudflare: no container port is open; web traffic comes through the tunnel.
MODE="$MODE"
EOF
}

# Record the mode in an existing settings file, keeping the owner's other lines.
set_guard_mode() {
    if grep -qx "MODE=\"$MODE\"" "$GUARD_CONFIG"; then
        return 0
    fi
    if grep -q '^MODE=' "$GUARD_CONFIG"; then
        run sed -i "s/^MODE=.*/MODE=\"$MODE\"/" "$GUARD_CONFIG"
    elif [ "$DRY_RUN" = true ]; then
        info "[dry-run] add MODE=\"$MODE\" to $GUARD_CONFIG"
    else
        printf '\n%s\n' "$(guard_mode_lines)" >>"$GUARD_CONFIG"
    fi
}

install_guard() {
    step "Blocking container ports from the internet (docker-port-guard)"
    guard_script | write_file "$GUARD_BIN" 0755
    if [ -f "$GUARD_CONFIG" ]; then
        ok "Keeping your existing $GUARD_CONFIG"
        set_guard_mode
    else
        write_file "$GUARD_CONFIG" 0644 <<EOF
# Settings for docker-port-guard (written by bootstrap.sh; your changes are kept).
#
# Container ports that may be reached from the internet IN ADDITION to
# 80/tcp, 443/tcp and 443/udp, which are allowed in direct mode. Separate with
# spaces. Example: EXTRA_ALLOWED="tcp/5432"
# After a change run: sudo docker-port-guard apply
EXTRA_ALLOWED=""

$(guard_mode_lines)
EOF
    fi
    # Runs BEFORE Docker at boot, so the rules are in place before any container
    # starts. Docker keeps an existing DOCKER-USER chain as it is.
    write_file "$GUARD_UNIT" 0644 <<EOF
[Unit]
Description=Keep Docker container ports off the internet (see /etc/default/docker-port-guard)
Documentation=file://$GUARD_BIN
Before=docker.service
After=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$GUARD_BIN apply

[Install]
WantedBy=multi-user.target docker.service
EOF
    # Docker itself loads the rules before it starts (no "-": if the rules
    # cannot be loaded, Docker does not start, so nothing is ever exposed),
    # and again right after, in case a Docker version rebuilds its chains.
    write_file "$GUARD_DOCKER_DROPIN" 0644 <<EOF
[Service]
ExecStartPre=$GUARD_BIN apply
ExecStartPost=-$GUARD_BIN apply
EOF
    # Every 5 minutes: re-apply, which also closes an expired setup window.
    write_file /etc/systemd/system/docker-port-guard-apply.service 0644 <<EOF
[Unit]
Description=Re-apply docker-port-guard rules

[Service]
Type=oneshot
ExecStart=$GUARD_BIN apply
EOF
    write_file /etc/systemd/system/docker-port-guard-apply.timer 0644 <<EOF
[Unit]
Description=Re-apply docker-port-guard rules every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
    run systemctl daemon-reload
    run systemctl enable docker-port-guard.service
    run systemctl restart docker-port-guard.service
    run systemctl enable --now docker-port-guard-apply.timer
    if [ "$MODE" = cloudflare ]; then
        ok "No container port can be reached from the internet"
        done_item "docker-port-guard on: every container port blocked from the internet (80, 443, 8000, 6001, 6002, 8080 included)"
    else
        ok "Only 80/443 of containers can be reached from the internet"
        done_item "docker-port-guard on: container ports other than 80/443 blocked from the internet (8000, 6001, 6002, 8080 included)"
    fi
}

# ---------------------------------------------------------------------------
# 8. fail2ban
# ---------------------------------------------------------------------------
configure_fail2ban() {
    step "Setting up fail2ban"
    write_file "$F2B_JAIL" 0644 <<EOF
# Written by bootstrap.sh. SSH is closed to the internet by the firewall; this is
# an extra layer that bans an address after repeated failed logins.
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 $DOCKER_RANGES

[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] fail2ban-client --test, then enable and restart fail2ban"
    else
        fail2ban-client --test >/dev/null || die "fail2ban settings did not pass the check ($F2B_JAIL)."
        systemctl enable fail2ban.service
        systemctl restart fail2ban.service
    fi
    ok "fail2ban watches SSH logins"
    done_item "fail2ban on for SSH"
}

# ---------------------------------------------------------------------------
# 9. Cloudflare Tunnel (Cloudflare mode only)
# ---------------------------------------------------------------------------
# Print the fingerprints of the primary keys in an OpenPGP key file.
# Returns non-zero (and prints nothing) if gpg cannot read the file.
key_fingerprints() {
    local home="$WORKDIR/gnupg" listing
    mkdir -p "$home" && chmod 700 "$home"
    listing="$(gpg --batch --homedir "$home" --with-colons --show-keys "$1" 2>/dev/null)" || return 1
    awk -F: '$1 == "pub" { want = 1; next } $1 == "fpr" && want { print $10; want = 0 }' <<<"$listing"
}

install_cloudflare_key() {
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] download $CF_KEY_URL, check it is key $CF_KEY_FINGERPRINT, save it to $CF_KEYRING"
        return 0
    fi
    ensure_workdir
    local key="$WORKDIR/cloudflare-main.download" plain="$WORKDIR/cloudflare-main.gpg" fprs
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 60 -o "$key" "$CF_KEY_URL" ||
        die "Could not download Cloudflare's package signing key. Check the internet connection and run this script again."
    mkdir -p "$WORKDIR/gnupg" && chmod 700 "$WORKDIR/gnupg"
    if grep -q -- '-----BEGIN PGP' <(head -c 40 "$key"); then
        gpg --batch --homedir "$WORKDIR/gnupg" --dearmor <"$key" >"$plain" 2>/dev/null || die "Cloudflare's signing key could not be read (gpg failed to convert it)."
    else
        cp -- "$key" "$plain"
    fi
    if ! fprs="$(key_fingerprints "$plain")"; then
        die "Cloudflare's signing key could not be read (gpg could not list it). Nothing from Cloudflare was installed."
    fi
    fprs="$(tr '\n' ' ' <<<"$fprs")"
    fprs="${fprs% }"
    fprs="${fprs:+$fprs }"
    if [ "$fprs" != "$CF_KEY_FINGERPRINT " ]; then
        die "Cloudflare's package signing key is not the expected one (got: ${fprs:-nothing}). Nothing from Cloudflare was installed. Compare with https://pkg.cloudflare.com/ and update CF_KEY_FINGERPRINT in this script only if Cloudflare announced a new key."
    fi
    if [ -f "$CF_KEYRING" ] && cmp -s "$plain" "$CF_KEYRING"; then
        ok "Cloudflare's signing key already in place ($CF_KEY_FINGERPRINT)"
    else
        install -m 0644 -o root -g root "$plain" "$CF_KEYRING"
        ok "Cloudflare's signing key saved ($CF_KEY_FINGERPRINT)"
    fi
}

# Save the token in a file only root can read. Sets CF_TOKEN_CHANGED.
CF_TOKEN_CHANGED=false
save_tunnel_token() {
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] save the tunnel token (not shown) to $CF_TOKEN_FILE, mode 0600, in folder $CF_TOKEN_DIR, mode 0700"
        return 0
    fi
    install -d -m 0700 -o root -g root "$CF_TOKEN_DIR"
    chmod 0700 "$CF_TOKEN_DIR"
    if [ "$CF_TOKEN_KEEP" = true ]; then
        CF_TOKEN="$(cat -- "$CF_TOKEN_FILE")"
        token_is_valid "$(clean_token "$CF_TOKEN")" ||
            die "The tunnel token saved in $CF_TOKEN_FILE does not look right. Run again and paste a new one."
    elif [ -f "$CF_TOKEN_FILE" ] && [ "$(cat -- "$CF_TOKEN_FILE")" = "$CF_TOKEN" ]; then
        :
    else
        local tmp
        tmp="$(umask 077 && mktemp "${CF_TOKEN_FILE}.tmp.XXXXXX")"
        printf '%s\n' "$CF_TOKEN" >"$tmp"
        chmod 0600 "$tmp"
        mv -f -- "$tmp" "$CF_TOKEN_FILE"
        CF_TOKEN_CHANGED=true
    fi
    chown root:root "$CF_TOKEN_FILE"
    chmod 0600 "$CF_TOKEN_FILE"
    CF_TOKEN=""
    ok "Tunnel token saved, readable only by root: $CF_TOKEN_FILE"
}

CF_RESTART_AT_END=false
install_cloudflared() {
    step "Installing Cloudflare Tunnel (cloudflared)"
    local apt_opts=(-y -o DPkg::Lock::Timeout=900 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
    local codename unit_before="" unit_changed=false
    codename="$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release | tr -d '"')"
    install_cloudflare_key
    write_file "$CF_APT_LIST" 0644 <<EOF
# Written by bootstrap.sh: Cloudflare's official cloudflared packages, signed by
# the key in $CF_KEYRING ($CF_KEY_FINGERPRINT).
deb [signed-by=$CF_KEYRING] $CF_REPO_URL ${codename:-noble} main
EOF
    run apt-get -o DPkg::Lock::Timeout=900 update
    run apt-get "${apt_opts[@]}" install cloudflared
    if [ "$DRY_RUN" = false ]; then
        command -v cloudflared >/dev/null 2>&1 || die "cloudflared did not install."
        cloudflared tunnel run --help 2>/dev/null | grep -q -- '--token-file' ||
            die "This cloudflared version cannot read the token from a file, so it was not set up (the token would be visible to other programs)."
        ok "$(cloudflared --version 2>/dev/null | head -n 1)"
    fi

    # Updates come from apt when the owner runs "sudo server-update", not from
    # cloudflared itself (--no-autoupdate) and not automatically.

    save_tunnel_token

    # cloudflared reads the token from the root-only file itself (--token-file),
    # so it is never in this unit, on a command line, or in the environment. The
    # service runs as root only to be able to read that file: every root power
    # (capability) is dropped and the system is read-only for it.
    [ -f "$CF_UNIT" ] && unit_before="$(cat -- "$CF_UNIT")"
    write_file "$CF_UNIT" 0644 <<EOF
# Written by bootstrap.sh. Cloudflare Tunnel: connects OUT to Cloudflare and
# passes visitors on to services on this server. The routes (which address goes
# where) are set in the Cloudflare dashboard, not here.
[Unit]
Description=Cloudflare Tunnel (cloudflared)
Documentation=https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel --metrics $CF_METRICS run --token-file $CF_TOKEN_FILE
Restart=always
RestartSec=5s
TimeoutStartSec=0
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
# Other programs' processes are hidden from it in /proc.
ProtectProc=invisible
# cloudflared runs as root (systemd credentials for a non-root user did not
# work in testing), so hide the sockets and files that would turn a cloudflared
# break-in into control of the whole server, and the password hashes.
# "-" ignores paths that do not exist.
InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/run/containerd -/run/docker -/var/lib/docker -/data/coolify
InaccessiblePaths=-/etc/shadow -/etc/gshadow

[Install]
WantedBy=multi-user.target
EOF
    if [ "$DRY_RUN" = true ]; then
        run systemctl daemon-reload
        run systemctl enable --now cloudflared.service
        done_item "Cloudflare Tunnel (cloudflared) installed from Cloudflare's signed repository and running"
        return 0
    fi
    [ "$(cat -- "$CF_UNIT")" != "$unit_before" ] && unit_changed=true
    systemctl daemon-reload
    systemctl enable cloudflared.service >/dev/null 2>&1
    if ! systemctl is-active --quiet cloudflared.service; then
        systemctl reset-failed cloudflared.service >/dev/null 2>&1 || true
        systemctl restart --no-block cloudflared.service
    elif [ "$unit_changed" = true ] || [ "$CF_TOKEN_CHANGED" = true ]; then
        # Restarting the tunnel drops sessions that come through it (perhaps
        # this one), so it happens as the very last step.
        CF_RESTART_AT_END=true
    fi
    if [ "$CF_RESTART_AT_END" = false ]; then
        local _ ready=false
        for _ in $(seq 1 30); do
            if curl -fsS --max-time 2 -o /dev/null "http://$CF_METRICS/ready" 2>/dev/null; then ready=true; break; fi
            sleep 1
        done
        if [ "$ready" = true ]; then
            ok "Tunnel connected to Cloudflare"
        else
            warn "The tunnel is not connected yet. If this stays so, check the token in Cloudflare and see: sudo journalctl -u cloudflared -n 50"
        fi
    fi
    done_item "Cloudflare Tunnel (cloudflared) installed from Cloudflare's signed repository; token in a root-only file; updates through automatic updates"
}

# ---------------------------------------------------------------------------
# 10. Coolify
# ---------------------------------------------------------------------------
gen_password() {
    # 20 characters without look-alikes (0/O, 1/l/I), in 4 groups: easy to type
    # from the console into a browser, about 115 bits of randomness.
    local set='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789' raw
    while :; do
        raw="$(head -c 1024 /dev/urandom | LC_ALL=C tr -dc "$set" | cut -c1-20)"
        [ "${#raw}" -eq 20 ] || continue
        [[ $raw =~ [A-Z] && $raw =~ [a-z] && $raw =~ [0-9] ]] || continue
        printf '%s-%s-%s-%s' "${raw:0:5}" "${raw:5:5}" "${raw:10:5}" "${raw:15:5}"
        return 0
    done
}

# Read one setting from /etc/default/server-setup as text (never run as a
# script). Other settings in the file are left alone.
setup_setting() {
    local key="$1" line value=""
    [ -r "$SETUP_CONFIG" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line//$'\r'/}"
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        case "$line" in "$key="*) value="${line#"$key="}" ;; esac
    done <"$SETUP_CONFIG"
    case "$value" in
        \"*\") value="${value:1:${#value}-2}" ;;
        \'*\') value="${value:1:${#value}-2}" ;;
    esac
    printf '%s' "$value"
}

coolify_installer_pin() {
    local pin
    pin="$(setup_setting COOLIFY_INSTALLER_SHA256)"
    pin="${pin,,}"
    if [ -n "$pin" ] && [[ ! $pin =~ ^[0-9a-f]{64}$ ]]; then
        die "COOLIFY_INSTALLER_SHA256 in $SETUP_CONFIG is not a SHA-256 fingerprint (64 characters 0-9, a-f). Fix or remove that line."
    fi
    printf '%s' "$pin"
}

install_coolify() {
    step "Installing Coolify"
    if coolify_installed; then
        ok "Coolify is already installed. Skipping (Coolify updates itself)."
        done_item "Coolify already installed (left as is)"
        return 0
    fi

    # Supply chain note: this runs Coolify's official installer from its official
    # address (HTTPS only). We trust Coolify's publisher here, exactly as Coolify's
    # own documentation asks every self-hosted user to. The installer is also what
    # keeps future updates working (its header says so). The download goes to a
    # private temporary file first, and its SHA-256 fingerprint is printed. If the
    # owner pinned a fingerprint (COOLIFY_INSTALLER_SHA256 in
    # /etc/default/server-setup), a different download is refused.
    local pin
    pin="$(coolify_installer_pin)" || exit 1
    ensure_workdir
    local installer="$WORKDIR/coolify-install.sh" sum
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] download $COOLIFY_INSTALLER_URL, print its SHA-256${pin:+ and require $pin}"
    else
        curl --proto '=https' --tlsv1.2 -fsSL --max-time 120 -o "$installer" "$COOLIFY_INSTALLER_URL" ||
            die "Could not download the Coolify installer. Check the internet connection and run this script again."
        if [ ! -s "$installer" ] || ! grep -q '^#!' <(head -n 1 "$installer"); then
            die "The downloaded Coolify installer looks wrong (not a script). Nothing was installed."
        fi
        sum="$(sha256sum "$installer")"
        sum="${sum%% *}"
        info "Downloaded Coolify's official installer from $COOLIFY_INSTALLER_URL"
        info "SHA-256 fingerprint: $sum"
        if [ -n "$pin" ]; then
            if [ "$sum" != "$pin" ]; then
                die "The Coolify installer is not the one pinned in $SETUP_CONFIG (expected $pin, got $sum). Nothing was installed. Coolify may have published a new installer: check https://github.com/coollabsio/coolify/blob/main/scripts/install.sh, then update or remove COOLIFY_INSTALLER_SHA256."
            fi
            ok "Matches the fingerprint pinned in $SETUP_CONFIG"
        else
            info "No fingerprint pinned (optional: COOLIFY_INSTALLER_SHA256 in $SETUP_CONFIG)"
        fi
    fi

    # Create the admin account up front. Otherwise the first person to open the
    # dashboard becomes admin (root on this server). Coolify documents this.
    if [ "$DRY_RUN" = true ]; then
        ADMIN_PASSWORD="(generated on the real run)"
        info "[dry-run] write $FIRST_LOGIN_FILE (mode 0600) with the generated password"
    elif [ -s "$FIRST_LOGIN_FILE" ] && [ -f "$COOLIFY_ENV" ]; then
        # An earlier attempt stopped part way. Coolify's installer keeps the
        # account details already in its settings file, so reuse the same ones.
        ADMIN_PASSWORD="$(sed -n 's/^Password: *//p' "$FIRST_LOGIN_FILE" | head -n 1)"
        local saved_email
        saved_email="$(sed -n 's/^Email: *//p' "$FIRST_LOGIN_FILE" | head -n 1)"
        if [ -n "$saved_email" ] && [ "$saved_email" != "$ADMIN_EMAIL" ]; then
            warn "Using the email from the earlier attempt: $saved_email"
            ADMIN_EMAIL="$saved_email"
        fi
        [ -n "$ADMIN_PASSWORD" ] || die "Could not read the saved password in $FIRST_LOGIN_FILE."
        info "Continuing an earlier, unfinished Coolify install with the same login"
    else
        ADMIN_PASSWORD="$(gen_password)"
        (
            umask 077
            {
                echo "Coolify first login (written by bootstrap.sh on $(date '+%Y-%m-%d %H:%M'))"
                if [ "$MODE" = cloudflare ]; then
                    echo "Address:  https://$DASHBOARD_HOST  (through the Cloudflare Tunnel, after the Cloudflare steps in the README)"
                else
                    echo "Address:  http://$PUBLIC_IP:8000  (only during the setup window)"
                fi
                echo "Email:    $ADMIN_EMAIL"
                echo "Password: $ADMIN_PASSWORD"
                echo "Change this password and turn on two-factor login, then delete this file:"
                echo "  sudo rm $FIRST_LOGIN_FILE"
            } >"$FIRST_LOGIN_FILE"
        )
    fi

    info "Running the Coolify installer. This takes a few minutes."
    # The installer reads the admin account only from its environment
    # (ROOT_USERNAME, ROOT_USER_EMAIL, ROOT_USER_PASSWORD; see its header). They
    # are set with "export" (a shell builtin) in a subshell, so the password is
    # never on a command line ("env NAME=value" would put it in the process
    # list); the environment of a root process is readable only by root.
    # HOME and USER are set explicitly: the installer adds its SSH key to
    # ~/.ssh/authorized_keys of the current user, which must be root.
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] bash $installer, with HOME=/root USER=root ROOT_USERNAME=admin ROOT_USER_EMAIL=$ADMIN_EMAIL and the password in its environment"
    else
        (
            export HOME=/root USER=root ROOT_USERNAME="admin" ROOT_USER_EMAIL="$ADMIN_EMAIL" ROOT_USER_PASSWORD="$ADMIN_PASSWORD"
            exec bash "$installer"
        ) || die "The Coolify installer reported a problem. Its log is in /data/coolify/source/. You can run this script again."
    fi

    # Re-apply the guard now that Docker exists and has made its chains.
    run systemctl restart docker-port-guard.service
    if [ "$DRY_RUN" = false ]; then
        iptables -w -C DOCKER-USER -j PORT-GUARD 2>/dev/null ||
            die "The container port block is not active after installing Docker. Run: sudo systemctl restart docker-port-guard"
    fi
    ok "Coolify installed"
    done_item "Coolify installed with its official installer (admin account created up front)"
}

# ---------------------------------------------------------------------------
# 11. First login window (direct mode only)
# ---------------------------------------------------------------------------
dashboard_on_https() {
    # Ask Traefik on this server for the dashboard, with a valid certificate.
    curl -fsS --max-time 8 --resolve "$DASHBOARD_HOST:443:127.0.0.1" \
        -o /dev/null "https://$DASHBOARD_HOST/api/health" 2>/dev/null
}

open_setup_window() {
    step "First-time setup window"
    if [ "$MODE" = cloudflare ]; then
        # Not needed: the dashboard is reached through the tunnel from the start.
        if [ -f /run/docker-port-guard/setup-window-until ]; then
            run "$GUARD_BIN" close
            ok "Closed the setup window left open by an earlier run"
        fi
        ok "Not needed in Cloudflare mode: the dashboard is reached through the tunnel"
        return 0
    fi
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] if https://$DASHBOARD_HOST does not work yet: $GUARD_BIN open-setup $SETUP_WINDOW_MINUTES"
        SETUP_WINDOW_OPENED=true
        return 0
    fi
    if ! docker container inspect coolify >/dev/null 2>&1; then
        warn "Coolify is not running, so no setup window was opened."
        return 0
    fi
    if dashboard_on_https; then
        ok "https://$DASHBOARD_HOST already works. No setup window needed."
        return 0
    fi
    if [ -f /run/docker-port-guard/setup-window-until ] && "$GUARD_BIN" status 2>/dev/null | grep -q '^Setup window: OPEN'; then
        ok "The setup window is already open: $("$GUARD_BIN" status | sed -n 's/^Setup window: //p')"
        return 0
    fi
    # On a later run Coolify was set up before: opening the dashboard ports to
    # the internet again is a choice, not a default.
    if [ "$COOLIFY_WAS_INSTALLED" = true ]; then
        info "Coolify was already set up, but https://$DASHBOARD_HOST does not answer from this server."
        # Asked on the console only; --yes and runs without a console keep it closed.
        if [ "$ASSUME_YES" = true ] || ! have_tty || ! ask_yes_no "Open the Coolify dashboard ports 8000 and 6001 to the internet again for $SETUP_WINDOW_MINUTES minutes?"; then
            ok "Setup window left closed. If you need it: sudo docker-port-guard open-setup $SETUP_WINDOW_MINUTES <your-internet-address>"
            return 0
        fi
    fi
    # Optional: only the owner's own computer may use the window.
    local from="" typed="" tries=0 out
    if have_tty; then
        while [ "$tries" -lt 3 ]; do
            tries=$((tries + 1))
            printf '    To allow only your own computer during the setup window, type its internet
    address (on that computer, search the web for "what is my IP").
    Or press Enter to allow any address: ' >/dev/tty
            typed=""
            read -r typed </dev/tty || typed=""
            typed="${typed//[[:space:]]/}"
            [ -n "$typed" ] || break
            if out="$("$GUARD_BIN" open-setup "$SETUP_WINDOW_MINUTES" "$typed" 2>&1)"; then
                from="$typed"
                break
            fi
            warn "$out"
        done
    fi
    if [ -z "$from" ]; then
        "$GUARD_BIN" open-setup "$SETUP_WINDOW_MINUTES" >/dev/null ||
            die "The setup window could not be opened. See: sudo docker-port-guard status"
    fi
    SETUP_WINDOW_OPENED=true
    ok "Ports 8000 and 6001 are open for $SETUP_WINDOW_MINUTES minutes${from:+, only from $from}, then close by themselves"
    done_item "Setup window: 8000 and 6001 open${from:+ (only from $from)} until $(date -d "+$SETUP_WINDOW_MINUTES min" '+%H:%M'), then closed automatically"
}

# ---------------------------------------------------------------------------
# 12. Logs, alerts, security audit, support bundle and the AI agent account
# ---------------------------------------------------------------------------
configure_journald() {
    step "Keeping the system log (journald)"
    # Persistent (survives restarts), at most 1 GB and 90 days.
    write_file "$JOURNALD_DROPIN" 0644 <<'EOF'
# Written by bootstrap.sh: keep the system log on disk (it survives restarts),
# at most 1 GB and at most 90 days, whichever comes first.
[Journal]
Storage=persistent
SystemMaxUse=1G
MaxRetentionSec=90day
EOF
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] systemctl restart systemd-journald, then journalctl --flush"
    else
        install -d -m 2755 -o root -g systemd-journal /var/log/journal 2>/dev/null || mkdir -p /var/log/journal
        systemctl restart systemd-journald.service || warn "Could not restart the system log service; the settings apply after the next restart."
        journalctl --flush >/dev/null 2>&1 || true
    fi
    ok "System log kept on disk: at most 1 GB and 90 days"
    done_item "System log (journald) kept on disk, at most 1 GB and 90 days ($JOURNALD_DROPIN)"
}

# Docker log rotation, merged into an existing daemon.json (Coolify's installer
# writes one) without losing its other settings.
configure_docker_logs() {
    step "Rotating container logs (Docker)"
    local cur="{}" new
    if ! command -v jq >/dev/null 2>&1; then
        if [ "$DRY_RUN" = true ]; then
            info "[dry-run] set log-driver json-file, max-size 20m, max-file 5 in $DOCKER_DAEMON_JSON (other settings kept), restart Docker"
            return 0
        fi
        die "jq is missing (it is installed in step 2)."
    fi
    if [ -f "$DOCKER_DAEMON_JSON" ]; then
        if ! jq -e 'type == "object"' "$DOCKER_DAEMON_JSON" >/dev/null 2>&1; then
            warn "$DOCKER_DAEMON_JSON is not valid JSON, so it was left alone and container logs are not rotated. Fix the file, then run this script again."
            return 0
        fi
        cur="$(cat -- "$DOCKER_DAEMON_JSON")"
    fi
    new="$(jq '.["log-driver"] = "json-file" | .["log-opts"] = ((.["log-opts"] // {}) + {"max-size": "20m", "max-file": "5"})' <<<"$cur")"
    if [ -f "$DOCKER_DAEMON_JSON" ] && [ "$(jq -S . <<<"$cur")" = "$(jq -S . <<<"$new")" ]; then
        ok "Container logs already rotate (20 MB, 5 files per container)"
        return 0
    fi
    if [ "$DRY_RUN" = true ]; then
        printf '%s\n' "$new" | write_file "$DOCKER_DAEMON_JSON" 0644
        info "[dry-run] check it with dockerd --validate, keep a copy of the old file, restart Docker"
        return 0
    fi
    if ! command -v dockerd >/dev/null 2>&1; then
        warn "Docker is not installed, so container log rotation was not set."
        return 0
    fi
    ensure_workdir
    printf '%s\n' "$new" >"$WORKDIR/daemon.json"
    if dockerd --help 2>&1 | grep -q -- '--validate'; then
        dockerd --validate --config-file "$WORKDIR/daemon.json" >/dev/null 2>&1 ||
            die "Docker refused the new $DOCKER_DAEMON_JSON (dockerd --validate). The old file is unchanged."
    fi
    local backup=""
    if [ -f "$DOCKER_DAEMON_JSON" ]; then
        backup="$DOCKER_DAEMON_JSON.before-bootstrap-$(date +%Y%m%d-%H%M%S)"
        cp -p -- "$DOCKER_DAEMON_JSON" "$backup"
    fi
    printf '%s\n' "$new" | write_file "$DOCKER_DAEMON_JSON" 0644
    info "Restarting Docker to use the new log settings (Coolify and apps are back in a moment)"
    local _ up=false
    if systemctl restart docker.service; then
        for _ in $(seq 1 60); do
            if docker info >/dev/null 2>&1; then up=true; break; fi
            sleep 1
        done
    fi
    if [ "$up" = false ]; then
        if [ -n "$backup" ]; then cp -p -- "$backup" "$DOCKER_DAEMON_JSON"; else rm -f -- "$DOCKER_DAEMON_JSON"; fi
        systemctl restart docker.service || true
        die "Docker did not start with the new log settings, so the old $DOCKER_DAEMON_JSON was put back."
    fi
    iptables -w -C DOCKER-USER -j PORT-GUARD 2>/dev/null ||
        die "The container port block is not active after restarting Docker. Run: sudo systemctl restart docker-port-guard"
    ok "Container logs rotate: 20 MB per file, 5 files per container${backup:+ (old settings saved in $backup)}"
    info "Containers that exist now keep their old log settings until they are recreated."
    info "A redeploy in Coolify recreates an app's containers."
    done_item "Container logs rotate (json-file, 20 MB x 5) in $DOCKER_DAEMON_JSON; existing containers switch when recreated (redeploy)"
}

# A systemd unit file, from stdin.
write_unit() { write_file "/etc/systemd/system/$1" 0644; }

install_server_tools() {
    step "Installing the server tools (alerts, logs, security audit, support)"
    if [ "$DRY_RUN" = false ]; then
        install -d -m 0755 -o root -g root "$TOOLS_LIB" "$TOOLS_SHARE"
    fi
    redact_script | write_file "$TOOLS_LIB/redact" 0755
    alert_script | write_file "$ALERT_BIN" 0755
    lynis_script | write_file "$LYNIS_BIN" 0755
    logs_script | write_file "$LOGS_BIN" 0755
    docker_logs_script | write_file "$DOCKER_LOGS_BIN" 0755
    status_script | write_file "$STATUS_BIN" 0755
    note_script | write_file "$NOTE_BIN" 0755
    support_script | write_file "$SUPPORT_BIN" 0755
    printf '%s\n' "$SCRIPT_VERSION" | write_file "$TOOLS_SHARE/VERSION" 0644
    # check.sh from the same release, next to this script, becomes server-check.
    if [ -f "$SCRIPT_DIR/check.sh" ] && grep -q '^# check.sh: read-only health and security check' "$SCRIPT_DIR/check.sh"; then
        write_file "$CHECK_BIN" 0755 <"$SCRIPT_DIR/check.sh"
        ok "check.sh installed as: sudo server-check"
    elif [ -x "$CHECK_BIN" ]; then
        warn "check.sh is not next to bootstrap.sh, so the installed server-check was kept as it is."
    else
        warn "check.sh is not next to bootstrap.sh, so 'server-check' is not installed. Download check.sh from the same release into this folder and run this script again."
    fi
    write_file /etc/logrotate.d/ops-agent-notes 0644 <<'EOF'
# Written by bootstrap.sh: the AI agent's work notes (server-note).
/var/log/ops-agent-notes.log {
    monthly
    rotate 24
    compress
    missingok
    notifempty
    create 0644 root root
}
EOF
    # Recorded sudo sessions of the agent: kept 90 days, like the system log.
    write_file /etc/tmpfiles.d/server-sudo-io.conf 0644 <<'EOF'
# Written by bootstrap.sh: recorded sudo sessions (sudoreplay), kept 90 days.
d /var/log/sudo-io 0700 root root 90d
EOF
    write_unit server-alert-watch.service <<EOF
[Unit]
Description=Check the server and send alerts (server-alert watch)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$ALERT_BIN watch
Nice=10
TimeoutStartSec=10min
EOF
    write_unit server-alert-watch.timer <<'EOF'
[Unit]
Description=Check the server every 15 minutes and send alerts

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
AccuracySec=1min

[Install]
WantedBy=timers.target
EOF
    write_unit server-alert-digest.service <<EOF
[Unit]
Description=Daily summary message (server-alert digest; off unless chosen in setup)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$ALERT_BIN digest
TimeoutStartSec=10min
EOF
    write_unit server-alert-digest.timer <<'EOF'
[Unit]
Description=Daily summary message at 08:05 (only sent if turned on)

[Timer]
OnCalendar=*-*-* 08:05:00
AccuracySec=1min

[Install]
WantedBy=timers.target
EOF
    write_unit server-lynis.service <<EOF
[Unit]
Description=Weekly security audit (Lynis, read-only)

[Service]
Type=oneshot
ExecStart=$LYNIS_BIN run
Nice=19
IOSchedulingClass=idle
TimeoutStartSec=1h
EOF
    write_unit server-lynis.timer <<'EOF'
[Unit]
Description=Weekly security audit (Lynis), Sundays

[Timer]
OnCalendar=Sun *-*-* 04:20:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF
    run systemctl daemon-reload
    run systemd-tmpfiles --create /etc/tmpfiles.d/server-sudo-io.conf
    run systemctl enable --now server-alert-watch.timer server-alert-digest.timer server-lynis.timer
    ok "server-alert, server-logs, server-docker-logs, server-status, server-support, server-lynis, server-note installed"
    done_item "Server tools in /usr/local/sbin: server-alert, server-check, server-support, server-logs, server-docker-logs, server-status, server-lynis, server-note"
}

configure_lynis() {
    step "Weekly security audit (Lynis)"
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] start the first audit in the background: systemctl start --no-block server-lynis.service"
    elif [ ! -s /var/lib/server-alert/lynis-score ]; then
        systemctl start --no-block server-lynis.service ||
            warn "Could not start the first audit. Run it yourself: sudo server-lynis run"
        info "The first audit runs in the background now (a few minutes). See it later: sudo server-lynis show"
    fi
    ok "Lynis audits the server every Sunday (read-only); a drop of 5 points sends an alert"
    done_item "Security audit: Lynis every Sunday, reports in /var/log/lynis (last 8), score in check.sh"
}

configure_alerts() {
    step "Alerts to your phone (Telegram or Discord)"
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] if alerts are not set up yet: ask whether to run 'server-alert setup' now"
        return 0
    fi
    if [ -f /etc/server-alert/config ]; then
        ok "Alerts are set up already ($(sed -n 's/^PROVIDER=//p' /etc/server-alert/config | head -n 1)). Change: sudo server-alert setup"
        done_item "Alerts: checks every 15 minutes; messages to $(sed -n 's/^PROVIDER=//p' /etc/server-alert/config | head -n 1)"
        return 0
    fi
    if have_tty && [ "$ASSUME_YES" = false ] && ask_yes_no "Set up alerts to Telegram or Discord now (about 3 minutes)?"; then
        "$ALERT_BIN" setup || warn "Alerts are not set up. Try again later: sudo server-alert setup"
    fi
    if [ -f /etc/server-alert/config ]; then
        done_item "Alerts: checks every 15 minutes; messages to $(sed -n 's/^PROVIDER=//p' /etc/server-alert/config | head -n 1)"
    else
        warn "Alerts are not set up yet: problems are only written to the system log. Set up: sudo server-alert setup"
        done_item "Alerts: checks every 15 minutes; NOT sent anywhere until you run: sudo server-alert setup"
    fi
}

# ---------------------------------------------------------------------------
# 13. The AI agent account (ops-agent)
# ---------------------------------------------------------------------------
agent_sudoers() {
    cat <<EOF
# Written by bootstrap.sh. What the AI agent account ($AGENT_USER) may run as
# root WITHOUT a password: commands that only read, plus making a backup,
# sending an alert and writing a work note. Nothing here changes the live
# system. Everything else needs the owner: the owner runs it, or allows one
# use with: sudo server-agent-grant "<command>" 30m
#
# Arguments are exact: "" means no arguments at all. The wrappers given "*"
# check every argument themselves.
#
# Every sudo session of $AGENT_USER is recorded (what it typed and saw):
#   sudo sudoreplay -d $SUDO_IO_DIR/$AGENT_USER -l
Defaults:$AGENT_USER log_input, log_output, iolog_dir=$SUDO_IO_DIR/$AGENT_USER
Defaults:$AGENT_USER env_reset, always_set_home, use_pty
# The account has no password, so asking for one is pointless; without it,
# sudo logs every refused command ("command not allowed") instead of failing
# silently. It does not allow anything more: only the commands below run.
Defaults:$AGENT_USER !authenticate
Defaults:$AGENT_USER secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

Cmnd_Alias OPS_AGENT_CHECK = $CHECK_BIN "", \\
    $SUPPORT_BIN "", $SUPPORT_BIN --stdout, \\
    $UPDATE_BIN --dry-run, \\
    $LYNIS_BIN show, \\
    $ALERT_BIN status
Cmnd_Alias OPS_AGENT_BACKUP = $BACKUP_BIN status, $BACKUP_BIN list, \\
    $BACKUP_BIN run, $BACKUP_BIN check
Cmnd_Alias OPS_AGENT_LOGS = $LOGS_BIN "", $LOGS_BIN *, \\
    $DOCKER_LOGS_BIN *, \\
    $STATUS_BIN *
Cmnd_Alias OPS_AGENT_LIST = /usr/bin/docker ps, /usr/bin/docker ps -a, \\
    /usr/sbin/ufw status, /usr/sbin/ufw status verbose, /usr/sbin/ufw status numbered, \\
    /usr/bin/fail2ban-client status, /usr/bin/fail2ban-client status sshd, \\
    $GUARD_BIN status
Cmnd_Alias OPS_AGENT_TELL = $ALERT_BIN agent-send *, \\
    $NOTE_BIN *

$AGENT_USER ALL=(root) NOPASSWD: OPS_AGENT_CHECK, OPS_AGENT_BACKUP, OPS_AGENT_LOGS, OPS_AGENT_LIST, OPS_AGENT_TELL
EOF
}

create_ops_agent() {
    step "Account for the AI agent ($AGENT_USER)"
    if [ "$NO_AGENT" = true ]; then
        if id -u "$AGENT_USER" >/dev/null 2>&1; then
            warn "--no-agent: the $AGENT_USER account from an earlier run was kept. To remove it: sudo userdel -r $AGENT_USER && sudo rm -f $AGENT_SUDOERS"
        else
            ok "Skipped (--no-agent)"
        fi
        return 0
    fi
    if id -u "$AGENT_USER" >/dev/null 2>&1; then
        ok "Account $AGENT_USER exists"
    else
        run useradd --create-home --home-dir "$AGENT_HOME" --shell /bin/bash --user-group \
            --comment "AI operations agent, see $AGENT_HOME/CLAUDE.md" "$AGENT_USER"
    fi
    # No password at all (locked), no extra groups (never docker: docker
    # equals root), home only for itself, no cron jobs.
    run usermod --lock "$AGENT_USER"
    run usermod -G "" "$AGENT_USER"
    run chmod 0750 "$AGENT_HOME"
    if [ "$DRY_RUN" = false ]; then
        if [ -s "$AGENT_HOME/.ssh/authorized_keys" ]; then
            warn "$AGENT_USER has SSH keys in $AGENT_HOME/.ssh/authorized_keys. SSH still refuses it (DenyUsers); remove them if you did not add them."
        fi
        if ! grep -qx "$AGENT_USER" /etc/cron.deny 2>/dev/null; then
            printf '%s\n' "$AGENT_USER" >>/etc/cron.deny
        fi
        install -d -m 0700 -o root -g root "$SUDO_IO_DIR"
    else
        info "[dry-run] add $AGENT_USER to /etc/cron.deny, create $SUDO_IO_DIR (mode 0700)"
    fi

    # The sudo rules: checked with visudo before they are put in place.
    if [ "$DRY_RUN" = true ]; then
        agent_sudoers | write_file "$AGENT_SUDOERS" 0440
        info "[dry-run] visudo -cf (check the rules), then visudo -c (check all of sudo's settings)"
    else
        ensure_workdir
        agent_sudoers >"$WORKDIR/ops-agent.sudoers"
        visudo -cqf "$WORKDIR/ops-agent.sudoers" >/dev/null ||
            die "The sudo rules for $AGENT_USER did not pass visudo's check. Nothing was changed in /etc/sudoers.d."
        write_file "$AGENT_SUDOERS" 0440 <"$WORKDIR/ops-agent.sudoers"
        if ! visudo -cq >/dev/null; then
            rm -f -- "$AGENT_SUDOERS"
            die "sudo's settings did not pass the check with the $AGENT_USER rules, so they were removed again."
        fi
    fi
    grant_script | write_file "$GRANT_BIN" 0755
    write_unit server-agent-grant-expire.service <<EOF
[Unit]
Description=Remove AI agent permissions whose time is up

[Service]
Type=oneshot
ExecStart=$GRANT_BIN expire-due
EOF
    write_unit server-agent-grant-expire.timer <<'EOF'
[Unit]
Description=Remove AI agent permissions whose time is up (every 5 minutes)

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF
    run systemctl daemon-reload
    run systemctl enable --now server-agent-grant-expire.timer
    install_agent_guide
    ok "$AGENT_USER: no password, no SSH, no extra groups (not docker), read-only sudo list, every sudo session recorded"
    done_item "AI agent account $AGENT_USER: locked password, no SSH, no groups; read-only sudo list ($AGENT_SUDOERS); sessions recorded in $SUDO_IO_DIR; changes only with: sudo server-agent-grant"
}

install_agent_guide() {
    local src="$SCRIPT_DIR/AGENT-GUIDE.md" target="$AGENT_HOME/CLAUDE.md"
    if [ ! -f "$src" ]; then
        if [ -f "$TOOLS_SHARE/AGENT-GUIDE.md" ]; then
            src="$TOOLS_SHARE/AGENT-GUIDE.md"
            warn "AGENT-GUIDE.md is not next to bootstrap.sh; using the copy installed before."
        else
            warn "AGENT-GUIDE.md is not next to bootstrap.sh, so the agent has no guide ($target). Download it from the same release into this folder and run this script again."
            return 0
        fi
    fi
    if [ "$src" != "$TOOLS_SHARE/AGENT-GUIDE.md" ]; then
        write_file "$TOOLS_SHARE/AGENT-GUIDE.md" 0644 <"$src"
    fi
    # Owned by root and unchangeable (chattr +i), so the agent can read it but
    # cannot change, replace or delete it, although it is in its home folder.
    if [ "$DRY_RUN" = false ]; then chattr -i "$target" 2>/dev/null || true; fi
    write_file "$target" 0644 <"$src"
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] chown root:root $target; chattr +i $target"
        return 0
    fi
    chown root:root "$target"
    if chattr +i "$target" 2>/dev/null; then
        ok "Guide for the agent: $target (owned by root, cannot be changed)"
    else
        warn "This file system cannot make $target unchangeable; the agent could replace it. auditd logs any change to it."
    fi
}

configure_auditd() {
    step "Audit log (auditd)"
    local uid="" rules
    if [ "$NO_AGENT" = false ]; then
        uid="$(id -u "$AGENT_USER" 2>/dev/null || true)"
        if [ -z "$uid" ] && [ "$DRY_RUN" = true ]; then uid="<ops-agent uid>"; fi
    fi
    rules="## Written by bootstrap.sh. Read the log with, for example:
##   sudo ausearch -k ops-agent -i     (commands the AI agent started)
##   sudo ausearch -k sudoers -i       (changes to sudo's rules)"
    if [ -n "$uid" ]; then
        rules="$rules
## Every program the AI agent account starts. auid is the account that logged
## in; uid catches the agent when the owner started it with sudo -iu, where
## the login account stays the owner's.
-a always,exit -F arch=b64 -S execve,execveat -F auid=$uid -k ops-agent
-a always,exit -F arch=b64 -S execve,execveat -F uid=$uid -k ops-agent"
        if [ "$(dpkg --print-architecture)" = amd64 ]; then
            rules="$rules
-a always,exit -F arch=b32 -S execve -F auid=$uid -k ops-agent
-a always,exit -F arch=b32 -S execve -F uid=$uid -k ops-agent"
        fi
    fi
    rules="$rules
## Changes to SSH, sudo, the tunnel token and the port guard settings.
-w /etc/ssh -p wa -k ssh-config
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d -p wa -k sudoers
-w $GUARD_CONFIG -p wa -k port-guard"
    if [ -d "$CF_TOKEN_DIR" ] || [ "$MODE" = cloudflare ]; then
        rules="$rules
-w $CF_TOKEN_DIR -p wa -k cloudflared"
    fi
    if [ -n "$uid" ]; then
        rules="$rules
-w $AGENT_HOME/CLAUDE.md -p wa -k ops-agent-guide"
    fi
    printf '%s\n' "$rules" | write_file "$AUDIT_RULES" 0640
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] systemctl enable auditd, restart it (loads the rules), check with auditctl -l"
        done_item "auditd logs every command of $AGENT_USER and changes to /etc/ssh, sudoers, the tunnel token and the port guard settings"
        return 0
    fi
    systemctl enable auditd.service >/dev/null 2>&1 || true
    systemctl restart auditd.service >/dev/null 2>&1 || true
    if systemctl is-active --quiet auditd.service; then
        augenrules --load >/dev/null 2>&1 || true
    fi
    if auditctl -l 2>/dev/null | grep -q -- '-k ssh-config'; then
        ok "auditd is running with the rules loaded ($(auditctl -l 2>/dev/null | grep -c -- ' -k ') rules)"
        done_item "auditd logs every command of $AGENT_USER and changes to /etc/ssh, sudoers, the tunnel token and the port guard settings"
    else
        warn "auditd is not running or the rules are not loaded (normal inside a container). Rules saved in $AUDIT_RULES; they load at the next start."
        done_item "auditd rules saved ($AUDIT_RULES) but not active right now; see check.sh"
    fi
}

print_ops_footer() {
    cat <<EOF

${C_BOLD}Alerts, help and the AI agent${C_RESET}
  Alerts:     $( [ -f /etc/server-alert/config ] && echo "set up. Change: sudo server-alert setup" || echo "NOT set up yet. Do it now: sudo server-alert setup")
  Check:      sudo server-check
  Get help:   sudo server-support   (then paste the file it names to Claude)
EOF
    if [ "$NO_AGENT" = false ]; then
        cat <<EOF
  AI agent:   sudo -iu $AGENT_USER   starts a session as the agent account (guide:
              $AGENT_HOME/CLAUDE.md). It can only look; you approve changes.
EOF
    fi
}

redact_script() {
    cat <<'REDACT_EOF'
#!/usr/bin/python3 -I
# server-redact: remove secrets from text. Installed by bootstrap.sh.
#
#   some-command | /usr/local/lib/server-tools/redact [--count]
#
# Reads everything on stdin and writes it to stdout with secrets replaced by
# [REDACTED]. Two passes:
#   1. the exact values stored in this server's secret files (the tunnel
#      token, the alert settings, the backup settings and keys, Coolify's
#      settings file, the first-login password), wherever they appear;
#   2. common secret shapes: private keys, "password=...", "token: ...",
#      bearer and basic authorization headers, cookies, passwords inside web
#      addresses, Telegram bot tokens, Discord webhooks, JWTs, Cloudflare
#      tunnel tokens, and API keys with well known prefixes.
# --count prints the number of replacements on stderr.
import glob
import os
import re
import sys

MARK = "[REDACTED]"
WHOLE_FILES = ["/etc/cloudflared/tunnel-token"]
KV_FILES = ["/etc/server-alert/config", "/data/coolify/source/.env"]
KV_GLOBS = ["/etc/server-backup/*", "/etc/server-backup/*/*"]
# Values that are settings, not secrets (redacting them would hide useful facts).
PLAIN = {"true", "false", "yes", "no", "on", "off", "sftp", "ftp", "ftps", "telegram",
         "discord", "daily", "none", "root", "local", "production", "default"}
MIN_LEN = 6


def read(path):
    try:
        if os.path.islink(path) or not os.path.isfile(path):
            return ""
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(1 << 20)
    except OSError:
        return ""


def add(found, value):
    value = value.strip().strip("\"'")
    if len(value) >= MIN_LEN and value.lower() not in PLAIN:
        found.add(value)


def file_secrets():
    found = set()
    for path in WHOLE_FILES:
        for line in read(path).splitlines():
            add(found, line)
    paths = list(KV_FILES)
    for pattern in KV_GLOBS:
        paths.extend(sorted(glob.glob(pattern)))
    for path in paths:
        for line in read(path).splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("-----"):
                continue
            m = re.match(r"^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]\s*(.*)$", line)
            if m:
                add(found, m.group(1))
            else:
                # Key files and password files: every long word on the line.
                for word in line.split():
                    add(found, word)
    m = re.search(r"^Password:\s*(\S+)", read("/root/coolify-first-login.txt"), re.M)
    if m:
        add(found, m.group(1))
    return sorted(found, key=len, reverse=True)


SECRET_WORDS = (r"password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|"
                r"private[_-]?key|client[_-]?secret|credential|auth[_-]?key|session[_-]?key|"
                r"app[_-]?key|signature|webhook[_-]?url|setup[_-]?code")
PATTERNS = [
    # Space separated forms: --password X, -pX, token X, REDIS_PASSWORD X
    (re.compile(r"(?i)(--?(?:password|passwd|pass|token|secret|api-?key|key)\s+)(?!\[REDACTED)(\S+)"), r"\1" + "[REDACTED]"),
    (re.compile(r"(?<![\w-])(-p)(?!\[REDACTED)(\S{4,})"), r"\1" + "[REDACTED]"),
    (re.compile(r"(?i)\b([A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|PASSPHRASE)[A-Z0-9_]*)(\s+)(?!\[REDACTED)(\S+)"), r"\1\2" + "[REDACTED]"),
    # Quoted values with spaces after a secret word
    (re.compile(r"(?i)\b([A-Za-z0-9_.-]*(?:password|passphrase|secret|token)[A-Za-z0-9_.-]*\s*[:=]\s*)([\"'])(.*?)\2"), r"\1\2" + "[REDACTED]" + r"\2"),
    (re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)", re.S),
     "[REDACTED PRIVATE KEY]"),
    (re.compile(r"(?i)\b(authorization|proxy-authorization)(\s*[:=]\s*)(bearer|basic|token|bot)?\s*(?!\[REDACTED)[^\s\"',;]+"),
     r"\1\2\3 " + MARK),
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 " + MARK),
    (re.compile(r"(?im)\b((?:set-)?cookie)(\s*[:=]\s*).*$"), r"\1\2" + MARK),
    (re.compile(r"(?i)\b([A-Za-z0-9_.-]*(?:" + SECRET_WORDS + r")[A-Za-z0-9_.-]*)([\"']?\s*[:=]\s*[\"']?)(?!\[REDACTED)([^\s\"',;&]+)"),
     r"\1\2" + MARK),
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)([^/\s:@]+):([^/\s@]+)@"), r"\1\2:" + MARK + "@"),
    (re.compile(r"\b(bot)?[0-9]{6,12}:[A-Za-z0-9_-]{30,}"), r"\1" + MARK),
    (re.compile(r"(?i)(discord(?:app)?\.com/api/webhooks/[0-9]+/)[A-Za-z0-9_-]+"), r"\1" + MARK),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), MARK),
    (re.compile(r"\beyJ[A-Za-z0-9+/]{40,}={0,2}"), MARK),
    (re.compile(r"\b(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|"
                r"github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|"
                r"AKIA[0-9A-Z]{16})"), MARK),
    (re.compile(r"\bbase64:[A-Za-z0-9+/]{20,}={0,2}"), MARK),
]


def main():
    count = "--count" in sys.argv[1:]
    data = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    n = 0
    for secret in file_secrets():
        k = data.count(secret)
        if k:
            n += k
            data = data.replace(secret, MARK)
    for rx, repl in PATTERNS:
        data, k = rx.subn(repl, data)
        n += k
    sys.stdout.write(data)
    sys.stdout.flush()
    if count:
        sys.stderr.write("%d\n" % n)


if __name__ == "__main__":
    main()
REDACT_EOF
}

alert_script() {
    cat <<'ALERT_EOF'
#!/bin/bash
# server-alert: messages about this server to your phone, through Telegram or
# Discord. Installed by bootstrap.sh.
#
#   sudo server-alert setup     choose Telegram or Discord and send a test message
#   sudo server-alert test      send a test message again
#   sudo server-alert status    show whether alerts are set up and the last alert
#   sudo server-alert watch     run every check now (a timer does this every 15 minutes)
#   sudo server-alert digest    send the daily summary now (if turned on, a timer
#                               does this every day at 08:05 server time)
#   sudo server-alert send [--key KEY] <severity> <title> <body>
#                               send one message; severity: info, warning or critical
#
# The same alert (same KEY; without --key: the same title) is sent at most once
# every 6 hours, and never more than 12 messages in one hour, so a problem
# cannot flood your phone. Every alert is also written to the system log
# (journalctl -t server-alert), sent or not.
#
# The settings (bot token or webhook address) are in /etc/server-alert/config,
# readable only by root. They are never printed and never put on a command
# line: curl reads the address from its standard input.
set -euo pipefail
PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
export LC_ALL=C.UTF-8

CONF_DIR="/etc/server-alert"
CONF="$CONF_DIR/config"
STATE="/var/lib/server-alert"
COOLDOWN=$((6 * 3600))
MAX_PER_HOUR=12
REDACT="/usr/local/lib/server-tools/redact"
BACKUP_STATUS="/var/lib/server-backup/last-status"
BACKUP_CONF="/etc/server-backup/config"
GUARD_CONFIG="/etc/default/docker-port-guard"
AGENT_USER="ops-agent"
DISK_LIMIT=85
BACKUP_MAX_AGE=$((36 * 3600))
SECURITY_MAX_AGE=$((3 * 86400))
REBOOT_MAX_AGE=$((7 * 86400))
TELEGRAM_API="https://api.telegram.org"

PROVIDER=""
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""
DISCORD_WEBHOOK_URL=""
DIGEST="off"
SERVER_NAME=""
ENDPOINT_OVERRIDE=""
TMP=""

say() { printf '%s\n' "$*"; }
die() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }
log() { logger -t server-alert -p "user.${2:-notice}" -- "$1" 2>/dev/null || true; }
cleanup() { if [ -n "$TMP" ]; then rm -rf -- "$TMP"; fi; }
trap cleanup EXIT
need_root() { [ "$(id -u)" -eq 0 ] || die "Please run with sudo: sudo server-alert ${1:-}"; }
have_tty() { { : >/dev/tty; } 2>/dev/null; }
mktmp() { [ -n "$TMP" ] || { TMP="$(mktemp -d /run/server-alert.XXXXXX)"; chmod 700 "$TMP"; }; }

valid_telegram_token() { [[ $1 =~ ^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$ ]]; }
valid_chat_id() { [[ $1 =~ ^-?[0-9]{1,20}$ || $1 =~ ^@[A-Za-z][A-Za-z0-9_]{4,31}$ ]]; }
valid_discord_url() {
    [[ $1 =~ ^https://(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)/api/webhooks/[0-9]{5,30}/[A-Za-z0-9_-]{20,100}$ ]]
}
# Only for tests (a local fake server instead of Telegram or Discord).
valid_override() { [[ $1 =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; }

# Read the settings as plain KEY=value text, never run them.
read_config() {
    local line key value
    [ -f "$CONF" ] || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line//$'\r'/}"
        case "$line" in '' | '#'*) continue ;; esac
        [[ $line =~ ^([A-Z_]+)=(.*)$ ]] || continue
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"
        case "$value" in \"*\") value="${value:1:${#value}-2}" ;; esac
        case "$key" in
            PROVIDER) PROVIDER="$value" ;;
            TELEGRAM_BOT_TOKEN) TELEGRAM_BOT_TOKEN="$value" ;;
            TELEGRAM_CHAT_ID) TELEGRAM_CHAT_ID="$value" ;;
            DISCORD_WEBHOOK_URL) DISCORD_WEBHOOK_URL="$value" ;;
            DIGEST) DIGEST="$value" ;;
            SERVER_NAME) SERVER_NAME="$value" ;;
            ENDPOINT_OVERRIDE) ENDPOINT_OVERRIDE="$value" ;;
        esac
    done <"$CONF"
    if [ -n "$ENDPOINT_OVERRIDE" ] && ! valid_override "$ENDPOINT_OVERRIDE"; then ENDPOINT_OVERRIDE=""; fi
    case "$PROVIDER" in
        telegram) valid_telegram_token "$TELEGRAM_BOT_TOKEN" && valid_chat_id "$TELEGRAM_CHAT_ID" ;;
        discord) valid_discord_url "$DISCORD_WEBHOOK_URL" || { [ -n "$ENDPOINT_OVERRIDE" ] && [[ $DISCORD_WEBHOOK_URL =~ /api/webhooks/[0-9]+/[A-Za-z0-9_-]+$ ]]; } ;;
        *) return 1 ;;
    esac
}

server_name() {
    if [ -n "$SERVER_NAME" ]; then printf '%s' "$SERVER_NAME"; else hostname -s 2>/dev/null || hostname; fi
}

# Web address for a call. Printed only into curl's standard input.
api_url() {
    local what="$1" base
    case "$PROVIDER" in
        telegram)
            base="${ENDPOINT_OVERRIDE:-$TELEGRAM_API}"
            [ "$what" != send ] || what=sendMessage
            printf '%s/bot%s/%s' "$base" "$TELEGRAM_BOT_TOKEN" "$what" ;;
        discord)
            if [ -n "$ENDPOINT_OVERRIDE" ]; then
                printf '%s/api/webhooks/%s' "$ENDPOINT_OVERRIDE" "${DISCORD_WEBHOOK_URL##*/api/webhooks/}"
            else
                printf '%s' "$DISCORD_WEBHOOK_URL"
            fi
            [ "$what" = send ] && printf '?wait=true'
            ;;
    esac
}

# curl with the address given on standard input (a curl config line), so the
# token is not on any command line. Prints the HTTP status; the reply goes to
# $TMP/reply. Optional second argument: a file with a JSON body to POST.
call_api() {
    local what="$1" body="${2:-}" code rc=0 proto="=https"
    mktmp
    [ -z "$ENDPOINT_OVERRIDE" ] || proto="=http,https"
    local args=(-sS --max-time 10 --proto "$proto" -o "$TMP/reply" -w '%{http_code}' --config -)
    if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$body"); fi
    code="$(printf 'url = "%s"\n' "$(api_url "$what")" | curl "${args[@]}" 2>"$TMP/curl-err")" || rc=$?
    if [ "$rc" -ne 0 ]; then
        # curl's own message, with the secret removed just in case.
        sed -e "s#${TELEGRAM_BOT_TOKEN:-@@none@@}#[REDACTED]#g" -e 's#/api/webhooks/[^ ]*#/api/webhooks/[REDACTED]#g' "$TMP/curl-err" | head -n 2 >&2
        printf '000'
        return 1
    fi
    printf '%s' "$code"
}

reply_error() {
    jq -r '.description // .message // empty' "$TMP/reply" 2>/dev/null | head -c 200 |
        sed -e "s#${TELEGRAM_BOT_TOKEN:-@@none@@}#[REDACTED]#g"
}

# Post one message. Returns 0 when Telegram or Discord accepted it.
post_message() {
    local text="$1" code
    mktmp
    case "$PROVIDER" in
        telegram)
            text="${text:0:4000}"
            jq -n --arg c "$TELEGRAM_CHAT_ID" --arg t "$text" \
                '{chat_id: $c, text: $t, disable_web_page_preview: true}' >"$TMP/body"
            ;;
        discord)
            text="${text:0:1900}"
            jq -n --arg t "$text" '{content: $t, username: "server-alert", allowed_mentions: {parse: []}}' >"$TMP/body"
            ;;
        *) return 1 ;;
    esac
    code="$(call_api send "$TMP/body")" || code="000"
    case "$code" in
        2??) return 0 ;;
        000) say "Could not reach $PROVIDER (no internet, or it took longer than 10 seconds)." >&2 ;;
        *) say "$PROVIDER refused the message (HTTP $code): $(reply_error)" >&2 ;;
    esac
    return 1
}

severity_word() {
    case "$1" in critical) printf 'PROBLEM' ;; warning) printf 'Warning' ;; *) printf 'Info' ;; esac
}

format_message() {
    local sev="$1" title="$2" body="$3"
    printf '[%s] %s: %s\n%s' "$(server_name)" "$(severity_word "$sev")" "$title" "$body"
}

redact() {
    if [ -x "$REDACT" ]; then "$REDACT"; else cat; fi
}

clean_text() {
    # No control characters except line breaks; then remove secrets.
    printf '%s' "$1" | tr -d '\000-\011\013-\037\177' | redact
}

state_init() {
    mkdir -p "$STATE/cooldown"
    chmod 755 "$STATE"
    chmod 700 "$STATE/cooldown"
    exec 9>"$STATE/.lock"
    flock -w 60 9 || die "Another server-alert is busy. Try again in a minute."
}

in_cooldown() {
    local f="$STATE/cooldown/$1" t
    [ -f "$f" ] || return 1
    t="$(cat -- "$f" 2>/dev/null || echo 0)"
    [[ $t =~ ^[0-9]+$ ]] || return 1
    [ $(( $(date +%s) - t )) -lt "$COOLDOWN" ]
}

mark_sent() { date +%s >"$STATE/cooldown/$1"; }

sent_last_hour() {
    local now cutoff
    now="$(date +%s)"
    cutoff=$((now - 3600))
    [ -f "$STATE/sent.log" ] || { printf '0'; return 0; }
    awk -F'\t' -v c="$cutoff" '$1 > c' "$STATE/sent.log" | grep -c . || true
}

record_sent() {
    local sev="$1" title="$2"
    printf '%s\t%s\t%s\n' "$(date +%s)" "$sev" "${title//$'\t'/ }" >>"$STATE/sent.log"
    tail -n 200 "$STATE/sent.log" >"$STATE/sent.log.new" && mv -f "$STATE/sent.log.new" "$STATE/sent.log"
    chmod 644 "$STATE/sent.log"
    printf 'time=%s\nseverity=%s\ntitle=%s\n' "$(date +%s)" "$sev" "${title//$'\n'/ }" >"$STATE/last-sent"
    chmod 644 "$STATE/last-sent"
}

valid_key() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$ ]]; }

# Deliver one alert (already cleaned). Exit codes: 0 sent, 1 delivery failed,
# 3 alerts are not set up, 4 held back on purpose (cooldown or hourly limit).
# Alerts about the AI agent (its sudo use and approved commands) are never
# held back, so nothing can be used to silence them.
deliver() {
    local key="$1" sev="$2" title="$3" body="$4" n always=false
    case "$key" in agent-sudo | agent-sudo-* | grant-*) always=true ;; esac
    if [ "$always" = false ] && in_cooldown "$key"; then
        say "Not sent: the same alert ($key) was already sent in the last 6 hours."
        return 4
    fi
    n="$(sent_last_hour)"
    if [ "$always" = false ] && [ "$n" -ge "$MAX_PER_HOUR" ]; then
        log "held back ($n alerts in the last hour): $sev: $title" warning
        say "Not sent: already $n alerts in the last hour (limit $MAX_PER_HOUR)."
        return 4
    fi
    if ! read_config; then
        log "not sent (alerts are not set up; run: sudo server-alert setup): $sev: $title" warning
        mark_sent "$key"
        say "Alerts are not set up yet, so this was only written to the system log. Set up: sudo server-alert setup"
        return 3
    fi
    if post_message "$(format_message "$sev" "$title" "$body")"; then
        mark_sent "$key"
        record_sent "$sev" "$title"
        log "sent to $PROVIDER: $sev: $title (key $key)"
        say "Sent to $PROVIDER."
        return 0
    fi
    log "sending to $PROVIDER failed: $sev: $title (key $key)" err
    return 1
}

cmd_send() {
    local key="" sev title body
    while [ $# -gt 0 ]; do
        case "$1" in
            --key) [ $# -ge 2 ] || die "--key needs a value"; key="$2"; shift 2 ;;
            --) shift; break ;;
            -*) die "Unknown option: $1" ;;
            *) break ;;
        esac
    done
    [ $# -eq 3 ] || die 'Usage: server-alert send [--key KEY] <info|warning|critical> "<title>" "<message>"'
    sev="$1"
    case "$sev" in info | warning | critical) ;; *) die "Severity must be info, warning or critical" ;; esac
    title="$(clean_text "$2" | tr '\n' ' ')"
    body="$(clean_text "$3")"
    [ -n "$title" ] && [ "${#title}" -le 200 ] || die "The title must be 1 to 200 characters"
    [ "${#body}" -le 3000 ] || die "The message must be at most 3000 characters"
    if [ -z "$key" ]; then
        key="send-$(printf '%s|%s' "$sev" "$title" | sha256sum | cut -c1-16)"
    fi
    valid_key "$key" || die "The key may only have letters, digits, dot, dash and underscore"
    state_init
    local rc=0
    deliver "$key" "$sev" "$title" "$body" || rc=$?
    [ "$rc" -eq 4 ] && return 0
    return "$rc"
}

# Messages from the AI agent: always labelled, their own small hourly budget,
# their own keys, and never counted against (or able to delay) system alerts.
AGENT_MAX_PER_HOUR=4
cmd_agent_send() {
    [ $# -eq 3 ] || die 'Usage: server-alert agent-send <info|warning|critical> "<title>" "<message>"'
    local sev="$1" title body key n now
    case "$sev" in info | warning | critical) ;; *) die "Severity must be info, warning or critical" ;; esac
    title="[from the AI agent] $(clean_text "$2" | tr '\n' ' ')"
    body="$(clean_text "$3")"
    [ "${#title}" -le 230 ] || die "The title must be at most 200 characters"
    [ "${#body}" -le 3000 ] || die "The message must be at most 3000 characters"
    state_init
    now="$(date +%s)"
    n=0
    [ -f "$STATE/agent-sent.log" ] && n="$(awk -v c="$((now - 3600))" '$1 > c' "$STATE/agent-sent.log" | grep -c . || true)"
    [ "$n" -lt "$AGENT_MAX_PER_HOUR" ] || die "The AI agent already sent $n messages in the last hour (limit $AGENT_MAX_PER_HOUR)."
    key="agentmsg-$(printf '%s|%s' "$sev" "$title" | sha256sum | cut -c1-16)"
    in_cooldown "$key" && { say "Not sent: the same message was sent in the last 6 hours."; return 0; }
    read_config || die "Alerts are not set up yet."
    if post_message "$(format_message "$sev" "$title" "$body")"; then
        mark_sent "$key"
        printf '%s\n' "$now" >>"$STATE/agent-sent.log"
        log "agent message sent to $PROVIDER: $sev: $title"
        say "Sent to $PROVIDER."
        return 0
    fi
    log "agent message failed: $sev: $title" err
    return 1
}

# ---------------------------------------------------------------- setup

ask_line() {
    local prompt="$1" hidden="${2:-}" answer=""
    printf '%s' "$prompt" >/dev/tty
    if [ "$hidden" = hidden ]; then
        IFS= read -rs answer </dev/tty || answer=""
        printf '\n' >/dev/tty
    else
        IFS= read -r answer </dev/tty || answer=""
    fi
    answer="${answer//$'\r'/}"
    answer="${answer#"${answer%%[![:space:]]*}"}"
    printf '%s' "${answer%"${answer##*[![:space:]]}"}"
}

write_config() {
    local stage
    install -d -m 0700 -o root -g root "$CONF_DIR"
    stage="$(mktemp "$CONF_DIR/.config.XXXXXX")"
    {
        echo "# Written by: sudo server-alert setup. Readable only by root. Do not share."
        echo "PROVIDER=$PROVIDER"
        if [ "$PROVIDER" = telegram ]; then
            echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN"
            echo "TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID"
        else
            echo "DISCORD_WEBHOOK_URL=$DISCORD_WEBHOOK_URL"
        fi
        echo "DIGEST=$DIGEST"
        [ -z "$SERVER_NAME" ] || echo "SERVER_NAME=$SERVER_NAME"
        [ -z "$ENDPOINT_OVERRIDE" ] || echo "ENDPOINT_OVERRIDE=$ENDPOINT_OVERRIDE"
    } >"$stage"
    chmod 0600 "$stage"
    mv -f -- "$stage" "$CONF"
}

setup_telegram() {
    local token="" tries=0 code chat="" name
    cat >/dev/tty <<'EOF'

Telegram: you make a small "bot" that only sends you messages.
  1. In Telegram, search for @BotFather (the official one, with a blue tick)
     and open a chat with it.
  2. Send it: /newbot   Then choose a name and a user name ending in "bot".
  3. BotFather answers with a token, a long line like 123456789:AAH...
     Copy it. Anyone with this token can send messages as your bot, so keep it
     private.
  4. Open a chat with your new bot (BotFather gives the link) and send it any
     message, for example "hello". A bot cannot write to you first.

EOF
    while [ "$tries" -lt 3 ]; do
        tries=$((tries + 1))
        token="$(ask_line 'Paste the bot token and press Enter (typing stays hidden): ' hidden)"
        if valid_telegram_token "$token"; then break; fi
        say "That does not look like a bot token (digits, a colon, then about 35 letters)." >/dev/tty
        token=""
    done
    [ -n "$token" ] || die "No valid bot token. Nothing was changed."
    PROVIDER=telegram
    TELEGRAM_BOT_TOKEN="$token"
    code="$(call_api getMe)" || code="000"
    [ "$code" = 200 ] || die "Telegram did not accept this token (HTTP $code). Check it with @BotFather and run: sudo server-alert setup"
    name="$(jq -r '.result.username // empty' "$TMP/reply" 2>/dev/null)"
    say "Token accepted: bot @${name:-unknown}." >/dev/tty
    tries=0
    while [ -z "$chat" ] && [ "$tries" -lt 3 ]; do
        tries=$((tries + 1))
        ask_line "Send any message to @${name:-your bot} in Telegram now, then press Enter here. " >/dev/null
        code="$(call_api getUpdates)" || code="000"
        if [ "$code" = 200 ]; then
            chat="$(jq -r '[.result[] | (.message // .channel_post // empty) | .chat.id] | last // empty' "$TMP/reply" 2>/dev/null)"
        fi
        if [ -z "$chat" ]; then say "No message found yet." >/dev/tty; fi
    done
    if [ -z "$chat" ]; then
        chat="$(ask_line 'Type the chat id instead (a number), or press Enter to stop: ')"
    fi
    valid_chat_id "$chat" || die "No chat found. Send your bot a message in Telegram and run: sudo server-alert setup"
    TELEGRAM_CHAT_ID="$chat"
    say "Messages will go to chat $chat." >/dev/tty
}

setup_discord() {
    local url="" tries=0 code
    cat >/dev/tty <<'EOF'

Discord: messages go to one channel of a Discord server you own.
  1. In Discord, open the server, then: Server Settings, Integrations,
     Webhooks, New Webhook.
  2. Choose the channel, then Copy Webhook URL. It looks like
     https://discord.com/api/webhooks/123.../AbC...
     Anyone with this address can post in that channel, so keep it private.

EOF
    while [ "$tries" -lt 3 ]; do
        tries=$((tries + 1))
        url="$(ask_line 'Paste the webhook URL and press Enter (typing stays hidden): ' hidden)"
        if valid_discord_url "$url"; then break; fi
        say "That does not look like a Discord webhook URL (https://discord.com/api/webhooks/...)." >/dev/tty
        url=""
    done
    [ -n "$url" ] || die "No valid webhook URL. Nothing was changed."
    PROVIDER=discord
    DISCORD_WEBHOOK_URL="$url"
    code="$(call_api info)" || code="000"
    [ "$code" = 200 ] || die "Discord did not accept this webhook (HTTP $code). Copy it again and run: sudo server-alert setup"
    say "Webhook accepted (channel webhook \"$(jq -r '.name // "unknown"' "$TMP/reply" 2>/dev/null)\")." >/dev/tty
}

cmd_setup() {
    need_root setup
    have_tty || die "setup asks questions, so run it on the console: sudo server-alert setup"
    command -v jq >/dev/null 2>&1 || die "jq is missing. Install it: sudo apt-get install jq"
    local choice="" answer
    if read_config; then
        say "Alerts are set up already ($PROVIDER). Going on replaces those settings." >/dev/tty
    fi
    # ENDPOINT_OVERRIDE (tests only, a fake local server) is kept.
    PROVIDER="" TELEGRAM_BOT_TOKEN="" TELEGRAM_CHAT_ID="" DISCORD_WEBHOOK_URL=""
    say "Where should this server send alerts?" >/dev/tty
    say "  1  Telegram" >/dev/tty
    say "  2  Discord" >/dev/tty
    choice="$(ask_line 'Type 1 or 2 and press Enter: ')"
    case "$choice" in
        1 | telegram | Telegram) setup_telegram ;;
        2 | discord | Discord) setup_discord ;;
        *) die "Please type 1 or 2. Nothing was changed." ;;
    esac
    answer="$(ask_line 'Also send a short summary every morning at 08:05 (server time), even when all is well? [y/N] ')"
    case "$answer" in y | Y | yes | Yes | YES) DIGEST=daily ;; *) DIGEST=off ;; esac
    write_config
    rm -f "$STATE"/cooldown/* 2>/dev/null || true
    log "alerts set up: $PROVIDER (daily summary: $DIGEST)"
    say "Saved in $CONF (readable only by root)."
    cmd_test
}

cmd_test() {
    need_root test
    read_config || die "Alerts are not set up yet. Run: sudo server-alert setup"
    mkdir -p "$STATE"
    if post_message "$(format_message info "Test message" "Alerts from this server work. You will hear from it when something needs you.")"; then
        record_sent info "Test message"
        log "test message sent to $PROVIDER"
        say "Test message sent to $PROVIDER. Check your phone."
        return 0
    fi
    log "test message to $PROVIDER failed" err
    die "The test message was not delivered (see above). Run setup again: sudo server-alert setup"
}

cmd_status() {
    local t title sev
    if [ ! -f "$CONF" ]; then
        say "Alerts: not set up. Run: sudo server-alert setup"
    elif [ "$(id -u)" -ne 0 ]; then
        say "Alerts: settings file present (run with sudo for details)"
    elif read_config; then
        say "Alerts: set up, sent to $PROVIDER; daily summary: $DIGEST"
    else
        say "Alerts: the settings file has a mistake. Run: sudo server-alert setup"
    fi
    if [ -f "$STATE/last-sent" ]; then
        t="$(sed -n 's/^time=//p' "$STATE/last-sent")"
        sev="$(sed -n 's/^severity=//p' "$STATE/last-sent")"
        title="$(sed -n 's/^title=//p' "$STATE/last-sent")"
        say "Last alert sent: $(date -d "@${t:-0}" '+%Y-%m-%d %H:%M') ($sev) $title"
    else
        say "Last alert sent: none yet"
    fi
    if [ -f "$STATE/last-watch" ]; then
        say "Last check run: $(date -d "@$(cat "$STATE/last-watch")" '+%Y-%m-%d %H:%M')"
    fi
    say "Checks timer: $(systemctl is-active server-alert-watch.timer 2>/dev/null || true)"
}

# ---------------------------------------------------------------- watch

# Alerts found by the checks, in four lists with the same order.
A_KEY=() A_SEV=() A_TITLE=() A_BODY=()
add_alert() { A_KEY+=("$1"); A_SEV+=("$2"); A_TITLE+=("$3"); A_BODY+=("$4"); }

kv() { { sed -n "s/^$1=//p" "$2" 2>/dev/null || true; } | tail -n 1; }

check_backup() {
    local now e ok err cs age
    now="$(date +%s)"
    if [ -f "$BACKUP_STATUS" ]; then
        e="$(kv epoch "$BACKUP_STATUS")"
        ok="$(kv success "$BACKUP_STATUS")"
        err="$(kv error "$BACKUP_STATUS")"
        cs="$(kv check_success "$BACKUP_STATUS")"
        if [ "$ok" = no ]; then
            add_alert backup-failed critical "The last backup FAILED" "${err:-No reason recorded.} See: sudo server-backup status"
        fi
        if [[ $e =~ ^[0-9]+$ ]]; then
            age=$(( (now - e) / 3600 ))
            if [ $((now - e)) -gt "$BACKUP_MAX_AGE" ]; then
                add_alert backup-old warning "No new backup for $age hours" "The last backup was on $(date -d "@$e" '+%Y-%m-%d %H:%M'). Backups should run every night. See: sudo server-backup status"
            fi
        fi
        if [ "$cs" = no ]; then
            add_alert backup-check-failed warning "The backup check found a problem" "$(kv check_error "$BACKUP_STATUS") See: sudo server-backup status"
        fi
    elif [ -f "$BACKUP_CONF" ] && [ $((now - $(stat -c %Y "$BACKUP_CONF"))) -gt "$BACKUP_MAX_AGE" ]; then
        add_alert backup-old warning "No backup has finished yet" "Backups were set up more than 36 hours ago but none has finished. See: sudo server-backup status"
    fi
}

check_disks() {
    local path pct mnt seen=" "
    for path in / /var/lib/docker; do
        [ -d "$path" ] || continue
        read -r pct mnt < <(df -P "$path" 2>/dev/null | awk 'NR == 2 { gsub("%", "", $5); print $5, $6 }') || continue
        [[ $pct =~ ^[0-9]+$ ]] || continue
        case "$seen" in *" $mnt "*) continue ;; esac
        seen="$seen$mnt "
        if [ "$pct" -gt "$DISK_LIMIT" ]; then
            add_alert "disk-${mnt//\//_}" "$( [ "$pct" -ge 95 ] && echo critical || echo warning)" "Disk $pct% full ($mnt)" \
                "Free space: $(df -Ph "$path" | awk 'NR == 2 { print $4 }'). Clean up old images in Coolify (Servers, your server, Docker Cleanup) or ask for help."
        fi
    done
}

guard_mode() {
    sed -n 's/^MODE="\{0,1\}\([a-z]*\)"\{0,1\}[[:space:]]*$/\1/p' "$GUARD_CONFIG" 2>/dev/null | tail -n 1
}

check_services() {
    if [ "$(guard_mode)" = cloudflare ] && ! systemctl is-active --quiet cloudflared.service 2>/dev/null; then
        add_alert cloudflared-down critical "The Cloudflare Tunnel is down" "cloudflared is $(systemctl is-active cloudflared.service 2>/dev/null || true). Websites and the dashboard cannot be reached. On the console: sudo systemctl restart cloudflared"
    fi
    if systemctl cat docker.service >/dev/null 2>&1 && ! systemctl is-active --quiet docker.service 2>/dev/null; then
        add_alert docker-down critical "Docker is not running" "Docker is $(systemctl is-active docker.service 2>/dev/null || true), so Coolify and every app are down. See: sudo server-status docker"
    fi
}

check_containers() {
    command -v docker >/dev/null 2>&1 && systemctl is-active --quiet docker.service 2>/dev/null || return 0
    local ids line name status health count managed prev counts_new=""
    ids="$(timeout 30 docker ps -aq 2>/dev/null | tr '\n' ' ')" || return 0
    [ -n "${ids// /}" ] || return 0
    local -A before=()
    if [ -f "$STATE/restart-counts" ]; then
        while IFS='=' read -r name count; do
            [[ $count =~ ^[0-9]+$ ]] && before[$name]="$count"
        done <"$STATE/restart-counts"
    fi
    # shellcheck disable=SC2086 # the ids are separate words on purpose
    while IFS='|' read -r name status health count managed; do
        name="${name#/}"
        case "$name" in coolify*) ;; *) [ "$managed" = true ] || continue ;; esac
        [[ $count =~ ^[0-9]+$ ]] || count=0
        counts_new="$counts_new$name=$count"$'\n'
        prev="${before[$name]:-$count}"
        if [ "$health" = unhealthy ]; then
            add_alert "container-unhealthy-$name" warning "App container $name is unhealthy" "Its health check fails. See its log: sudo server-docker-logs $name"
        fi
        if [ "$status" = restarting ] || [ $((count - prev)) -ge 3 ]; then
            add_alert "container-restarting-$name" warning "App container $name keeps restarting" "Restarted $((count - prev > 0 ? count - prev : 1)) times since the last check (status: $status). See: sudo server-docker-logs $name"
        fi
    done < <(timeout 30 docker inspect --format '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.RestartCount}}|{{index .Config.Labels "coolify.managed"}}' $ids 2>/dev/null || true)
    printf '%s' "$counts_new" >"$STATE/restart-counts"
}

check_updates() {
    local now pkgs pkg t old="" new_seen=""
    now="$(date +%s)"
    pkgs="$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | awk '/^Inst / && /-security/ { print $2 }' | sort -u)"
    local -A seen=()
    if [ -f "$STATE/security-seen" ]; then
        while IFS='=' read -r pkg t; do [[ $t =~ ^[0-9]+$ ]] && seen[$pkg]="$t"; done <"$STATE/security-seen"
    fi
    for pkg in $pkgs; do
        t="${seen[$pkg]:-$now}"
        new_seen="$new_seen$pkg=$t"$'\n'
        if [ $((now - t)) -gt "$SECURITY_MAX_AGE" ]; then old="$old $pkg"; fi
    done
    printf '%s' "$new_seen" >"$STATE/security-seen"
    if [ -n "$old" ]; then
        add_alert security-updates-old warning "Security updates waiting for more than 3 days" "They should install by themselves every night, but these did not:$old. See: sudo server-update --dry-run"
    fi
    if [ -f /var/run/reboot-required ]; then
        t="$(stat -c %Y /var/run/reboot-required)"
        if [ $((now - t)) -gt "$REBOOT_MAX_AGE" ]; then
            add_alert reboot-needed warning "A restart has been needed for $(( (now - t) / 86400 )) days" "Updates finish only after a restart. At a quiet time, on the console: sudo reboot"
        fi
    fi
}

# Summaries (fail2ban bans, ops-agent sudo use) cover everything since the
# last one was sent, so nothing is lost while an alert waits out its 6 hours.
summary_since() {
    local f="$STATE/since-$1" now t
    now="$(date +%s)"
    t="$(cat -- "$f" 2>/dev/null || true)"
    if [[ ! $t =~ ^[0-9]+$ ]]; then t=$((now - 900)); printf '%s\n' "$t" >"$f"; fi
    if [ "$t" -lt $((now - 7 * 86400)) ]; then t=$((now - 7 * 86400)); fi
    printf '%s' "$t"
}

check_fail2ban() {
    local since lines from
    since="$(summary_since fail2ban-bans)"
    from="$(date -d "@$since" '+%Y-%m-%d %H:%M:%S')"
    if [ -f /var/log/fail2ban.log ]; then
        lines="$(cat /var/log/fail2ban.log /var/log/fail2ban.log.1 2>/dev/null | awk -v f="$from" 'substr($0, 1, 19) > f && / Ban / { print }' || true)"
    else
        lines="$(journalctl -q --no-pager -o cat -u fail2ban.service --since "@$since" 2>/dev/null | grep ' Ban ' || true)"
    fi
    [ -n "$lines" ] || return 0
    local n ips
    n="$(grep -c . <<<"$lines")"
    ips="$(grep -oE 'Ban [0-9a-fA-F:.]+' <<<"$lines" | awk '{ print $2 }' | sort | uniq -c | sort -rn | head -n 10 | awk '{ printf "%s (%s) ", $2, $1 }' || true)"
    add_alert fail2ban-bans info "fail2ban blocked $n login attempts" "Since $(date -d "@$since" '+%Y-%m-%d %H:%M'): $ips. Nothing to do unless one of them is you; then: sudo fail2ban-client unban <address>"
}

check_agent_sudo() {
    id -u "$AGENT_USER" >/dev/null 2>&1 || return 0
    local since lines ran refused n body
    since="$(summary_since agent-sudo)"
    lines="$(journalctl -q --no-pager -o cat _COMM=sudo --since "@$since" 2>/dev/null | grep -E "^ *$AGENT_USER : " || true)"
    [ -n "$lines" ] || return 0
    ran="$(grep -v 'command not allowed\|incorrect password\|a password is required' <<<"$lines" | sed -n 's/.*COMMAND=//p' | sort | uniq -c | sort -rn | head -n 15 | awk '{ c = $1; $1 = ""; printf "%sx%s\n", c, $0 }' || true)"
    refused="$(grep 'command not allowed\|a password is required\|incorrect password' <<<"$lines" | sed -n 's/.*COMMAND=//p' | sort -u | head -n 10 || true)"
    n="$(grep -c . <<<"$lines")"
    body="Since $(date -d "@$since" '+%Y-%m-%d %H:%M'), $n uses of sudo by $AGENT_USER."
    [ -z "$ran" ] || body="$body"$'\n'"Ran:"$'\n'"$ran"
    [ -z "$refused" ] || body="$body"$'\n'"REFUSED (needs your approval):"$'\n'"$refused"
    body="$body"$'\n'"Replay any session: sudo sudoreplay -d /var/log/sudo-io/$AGENT_USER -l"
    add_alert agent-sudo "$( [ -n "$refused" ] && echo warning || echo info)" "The AI agent used sudo ($n times)" "$body"
}

run_checks() {
    check_backup
    check_disks
    check_services
    check_containers
    check_updates
    check_fail2ban
    check_agent_sudo
}

cmd_watch() {
    need_root watch
    state_init
    run_checks
    local i new=() worst=info text="" title key
    for i in "${!A_KEY[@]}"; do
        in_cooldown "${A_KEY[$i]}" && continue
        new+=("$i")
        case "${A_SEV[$i]}" in critical) worst=critical ;; warning) [ "$worst" = critical ] || worst=warning ;; esac
    done
    date +%s >"$STATE/last-watch"
    if [ "${#new[@]}" -eq 0 ]; then
        say "No new problems (${#A_KEY[@]} known, already reported in the last 6 hours)."
        return 0
    fi
    for i in "${new[@]}"; do
        log "${A_SEV[$i]}: ${A_TITLE[$i]} (${A_KEY[$i]})" "$( [ "${A_SEV[$i]}" = info ] && echo notice || echo warning)"
        [ -z "$text" ] || text="$text"$'\n\n'
        text="$text$(severity_word "${A_SEV[$i]}"): ${A_TITLE[$i]}"$'\n'"${A_BODY[$i]}"
    done
    if [ "${#new[@]}" -eq 1 ]; then
        i="${new[0]}"
        key="${A_KEY[$i]}"
        title="${A_TITLE[$i]}"
        text="${A_BODY[$i]}"
    else
        # One message for all of them; each still waits its own 6 hours.
        key="watch-$(date +%s)"
        title="${#new[@]} things need a look"
    fi
    local rc=0
    deliver "$key" "$worst" "$title" "$(printf '%s' "$text" | redact)" || rc=$?
    # Delivered (or alerts are not set up yet): every alert in it now waits.
    if [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ]; then
        for i in "${new[@]}"; do
            mark_sent "${A_KEY[$i]}"
            case "${A_KEY[$i]}" in fail2ban-bans | agent-sudo) date +%s >"$STATE/since-${A_KEY[$i]}" ;; esac
        done
        return 0
    fi
    return "$rc"
}

cmd_digest() {
    need_root digest
    local force="${1:-}"
    read_config || { say "Alerts are not set up, so there is no summary."; return 0; }
    if [ "$DIGEST" != daily ] && [ "$force" != --now ]; then
        say "The daily summary is off (sudo server-alert setup turns it on). To send one anyway: sudo server-alert digest --now"
        return 0
    fi
    state_init
    run_checks
    local i problems="" text e ok score
    for i in "${!A_KEY[@]}"; do
        problems="$problems- ${A_TITLE[$i]}"$'\n'
    done
    text="Disk: $(df -Ph / | awk 'NR == 2 { print $5 " used, " $4 " free" }')"
    text="$text"$'\n'"Memory free: $(awk '/^MemAvailable:/ { print int($2 / 1024) " MB" }' /proc/meminfo)"
    if [ -f "$BACKUP_STATUS" ]; then
        e="$(kv epoch "$BACKUP_STATUS")"; ok="$(kv success "$BACKUP_STATUS")"
        text="$text"$'\n'"Last backup: $(date -d "@${e:-0}" '+%Y-%m-%d %H:%M') ($( [ "$ok" = yes ] && echo OK || echo FAILED))"
    else
        text="$text"$'\n'"Last backup: none recorded"
    fi
    text="$text"$'\n'"Updates waiting: $(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | grep -c '^Inst ' || true) (install with: sudo server-update)"
    if [ -f /var/run/reboot-required ]; then text="$text"$'\n'"A restart is needed."; fi
    score="$(kv score "$STATE/lynis-score")"
    [ -z "$score" ] || text="$text"$'\n'"Security score (Lynis): $score"
    if [ -n "$problems" ]; then
        text="$text"$'\n\n'"Needs a look:"$'\n'"$problems"
    else
        text="$text"$'\n\n'"Nothing needs you today."
    fi
    deliver "digest-$(date +%Y%m%d%H%M)" info "Daily summary" "$(printf '%s' "$text" | redact)"
}

case "${1:-}" in
    setup | test | watch | digest | send) [ "$(id -u)" -ne 0 ] || mktmp ;;
esac
case "${1:-}" in
    setup) cmd_setup ;;
    test) cmd_test ;;
    status) cmd_status ;;
    watch) cmd_watch ;;
    digest) shift; cmd_digest "${1:-}" ;;
    send) need_root send; shift; cmd_send "$@" ;;
    agent-send) need_root agent-send; shift; cmd_agent_send "$@" ;;
    -h | --help | help | "") sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//' ;;
    *) echo "Unknown command: $1 (try: server-alert --help)" >&2; exit 2 ;;
esac
ALERT_EOF
}

lynis_script() {
    cat <<'LYNIS_EOF'
#!/bin/bash
# server-lynis: weekly security audit with Lynis (Ubuntu's lynis package).
# Installed by bootstrap.sh. It only reads; it changes nothing.
#
#   sudo server-lynis run    run the audit now (a timer does this every Sunday)
#   sudo server-lynis show   show the last score and the top warnings
#
# Reports are kept in /var/log/lynis/ (the last 8 runs). The hardening index
# (0 to 100, higher is better) is saved in /var/lib/server-alert/lynis-score.
# If it drops by 5 or more since the previous run, an alert is sent.
set -euo pipefail
PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
umask 027
export LC_ALL=C.UTF-8

LOG_DIR="/var/log/lynis"
STATE="/var/lib/server-alert"
SCORE_FILE="$STATE/lynis-score"
KEEP=8
DROP_ALERT=5

die() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }
kv() { { sed -n "s/^$1=//p" "$2" 2>/dev/null || true; } | tail -n 1; }

top_warnings() {
    # warning[]=ID|text|details|solution|
    sed -n 's/^warning\[\]=//p' "$1" 2>/dev/null | awk -F'|' '{ printf "%s: %s\n", $1, $2 }' | head -n "${2:-5}"
}

cmd_run() {
    [ "$(id -u)" -eq 0 ] || die "Please run with sudo: sudo server-lynis run"
    command -v lynis >/dev/null 2>&1 || die "lynis is not installed. Run bootstrap.sh again."
    install -d -m 0750 -o root -g adm "$LOG_DIR"
    mkdir -p "$STATE"
    chmod 755 "$STATE"
    exec 8>"$STATE/.lynis.lock"
    flock -n 8 || die "An audit is already running."
    local stamp report score prev rc=0 old
    stamp="$(date +%Y%m%d-%H%M%S)"
    report="$LOG_DIR/report-$stamp.dat"
    lynis audit system --quick --no-colors --logfile "$LOG_DIR/lynis-$stamp.log" \
        --report-file "$report" >"$LOG_DIR/output-$stamp.txt" 2>&1 || rc=$?
    score="$(kv hardening_index "$report")"
    if [[ ! $score =~ ^[0-9]+$ ]]; then
        logger -t server-lynis -p user.err -- "audit did not produce a score (exit $rc), see $LOG_DIR/output-$stamp.txt" 2>/dev/null || true
        die "The audit did not finish (exit $rc). See $LOG_DIR/output-$stamp.txt"
    fi
    prev="$(kv score "$SCORE_FILE")"
    {
        echo "score=$score"
        echo "time=$(date +%s)"
        echo "report=$report"
        echo "previous=${prev:-}"
        echo "warnings=$(grep -c '^warning\[\]=' "$report" || true)"
        echo "suggestions=$(grep -c '^suggestion\[\]=' "$report" || true)"
    } >"$SCORE_FILE.new"
    chmod 644 "$SCORE_FILE.new"
    mv -f "$SCORE_FILE.new" "$SCORE_FILE"
    # Keep the newest $KEEP runs (report, log and screen output of each).
    while read -r old; do
        old="${old#"$LOG_DIR"/report-}"
        old="${old%.dat}"
        rm -f -- "$LOG_DIR/report-$old.dat" "$LOG_DIR/lynis-$old.log" "$LOG_DIR/output-$old.txt"
    done < <(find "$LOG_DIR" -maxdepth 1 -name 'report-*.dat' -printf '%f\n' | sort -r | tail -n +$((KEEP + 1)) | sed "s#^#$LOG_DIR/#")
    logger -t server-lynis -- "security audit done: hardening index $score (previous ${prev:-none})" 2>/dev/null || true
    echo "Security audit done. Hardening index: $score (previous: ${prev:-none}). Report: $report"
    if [[ $prev =~ ^[0-9]+$ ]] && [ $((prev - score)) -ge "$DROP_ALERT" ]; then
        server-alert send --key lynis-score-drop warning "Security score dropped from $prev to $score" \
            "The weekly Lynis audit scores this server lower than last time. Top warnings:
$(top_warnings "$report" 5)
Details: sudo server-lynis show" || true
    fi
}

cmd_show() {
    [ -f "$SCORE_FILE" ] || { echo "No audit has run yet. Run one: sudo server-lynis run"; return 0; }
    local report
    report="$(kv report "$SCORE_FILE")"
    echo "Hardening index: $(kv score "$SCORE_FILE") (previous: $(kv previous "$SCORE_FILE" | grep . || echo none)), $(date -d "@$(kv time "$SCORE_FILE")" '+%Y-%m-%d %H:%M')"
    echo "Warnings: $(kv warnings "$SCORE_FILE"), suggestions: $(kv suggestions "$SCORE_FILE")"
    if [ -r "$report" ]; then
        echo "Top warnings:"
        top_warnings "$report" 10 | sed 's/^/  /'
        echo "Full report: $report"
    fi
}

case "${1:-show}" in
    run) cmd_run ;;
    show) cmd_show ;;
    -h | --help | help) sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//' ;;
    *) echo "Usage: server-lynis run | show" >&2; exit 2 ;;
esac
LYNIS_EOF
}

logs_script() {
    cat <<'LOGS_EOF'
#!/bin/bash
# server-logs: read the system log (journal). It only reads: it cannot delete,
# rotate or change any log. Installed by bootstrap.sh. Secrets are removed
# from the output.
#
#   sudo server-logs [--unit NAME] [--since TIME] [--lines N]
#
#   --unit NAME   one service, for example cloudflared, docker, ssh, fail2ban
#   --since TIME  for example "-2h", "today", "yesterday", "2026-11-15 08:00"
#   --lines N     how many lines, newest last (default 200, at most 5000)
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C.UTF-8 SYSTEMD_PAGER=cat PAGER=cat SYSTEMD_LESS=""

REDACT="/usr/local/lib/server-tools/redact"
die() { printf 'server-logs: %s\n' "$*" >&2; exit 2; }

unit="" since="" lines=200
while [ $# -gt 0 ]; do
    case "$1" in
        --unit) [ $# -ge 2 ] || die "--unit needs a name"; unit="$2"; shift 2 ;;
        --since) [ $# -ge 2 ] || die "--since needs a time"; since="$2"; shift 2 ;;
        --lines) [ $# -ge 2 ] || die "--lines needs a number"; lines="$2"; shift 2 ;;
        -h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $1 (allowed: --unit NAME --since TIME --lines N)" ;;
    esac
done
if [ -n "$unit" ]; then
    [[ $unit =~ ^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,99}$ ]] && [[ $unit != *..* ]] ||
        die "not a service name: $unit"
fi
if [ -n "$since" ]; then
    [[ $since =~ ^[A-Za-z0-9][A-Za-z0-9\ :.+-]{0,39}$ || $since =~ ^-[0-9]{1,4}(s|m|min|h|d|w)$ ]] ||
        die "not a time: $since (examples: -2h, today, \"2026-11-15 08:00\")"
fi
[[ $lines =~ ^[0-9]{1,4}$ ]] && [ "$lines" -ge 1 ] && [ "$lines" -le 5000 ] ||
    die "--lines must be a number from 1 to 5000"
[ -x "$REDACT" ] || die "the secret filter ($REDACT) is missing, so no log is shown"

args=(--no-pager --quiet --output=short-iso "--lines=$lines")
[ -z "$unit" ] || args+=("--unit=$unit")
[ -z "$since" ] || args+=("--since=$since")
journalctl "${args[@]}" 2>&1 </dev/null | "$REDACT"
LOGS_EOF
}

docker_logs_script() {
    cat <<'DLOGS_EOF'
#!/bin/bash
# server-docker-logs: read the log of one container. It only reads. Installed
# by bootstrap.sh. Secrets are removed from the output.
#
#   sudo server-docker-logs NAME [--lines N] [--since TIME]
#
#   NAME          a container name as "sudo docker ps -a" shows it
#   --lines N     how many lines (default 200, at most 5000)
#   --since TIME  for example 2h, 30m, or 2026-11-15T08:00:00
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C.UTF-8

REDACT="/usr/local/lib/server-tools/redact"
die() { printf 'server-docker-logs: %s\n' "$*" >&2; exit 2; }

name="" since="" lines=200
while [ $# -gt 0 ]; do
    case "$1" in
        --lines) [ $# -ge 2 ] || die "--lines needs a number"; lines="$2"; shift 2 ;;
        --since) [ $# -ge 2 ] || die "--since needs a time"; since="$2"; shift 2 ;;
        -h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; exit 0 ;;
        -*) die "unknown option: $1 (allowed: --lines N --since TIME)" ;;
        *) [ -z "$name" ] || die "only one container name"; name="$1"; shift ;;
    esac
done
[ -n "$name" ] || die "give a container name (see: sudo docker ps -a)"
[[ $name =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die "not a container name: $name"
[[ $lines =~ ^[0-9]{1,4}$ ]] && [ "$lines" -ge 1 ] && [ "$lines" -le 5000 ] ||
    die "--lines must be a number from 1 to 5000"
if [ -n "$since" ]; then
    [[ $since =~ ^[0-9]{1,5}[smhd]$ || $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2})?Z?)?$ ]] ||
        die "not a time: $since (examples: 2h, 30m, 2026-11-15T08:00:00)"
fi
[ -x "$REDACT" ] || die "the secret filter ($REDACT) is missing, so no log is shown"
# Only real containers: the exact name must exist.
found="$(docker container inspect --format '{{.Name}}' "$name" 2>/dev/null || true)"
[ "$found" = "/$name" ] || die "no container called $name (see: sudo docker ps -a)"

args=(logs "--tail=$lines" --timestamps)
[ -z "$since" ] || args+=("--since=$since")
docker "${args[@]}" "$name" 2>&1 </dev/null | "$REDACT"
DLOGS_EOF
}

status_script() {
    cat <<'STATUS_EOF'
#!/bin/bash
# server-status: show the state of services (systemctl status). It only reads.
# Installed by bootstrap.sh. Secrets are removed from the output.
#
#   sudo server-status NAME [NAME...]   for example: sudo server-status cloudflared docker
set -uo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C.UTF-8 SYSTEMD_PAGER=cat PAGER=cat SYSTEMD_LESS=""

REDACT="/usr/local/lib/server-tools/redact"
die() { printf 'server-status: %s\n' "$*" >&2; exit 2; }

case "${1:-}" in -h | --help) sed -n '2,/^set -uo/p' "$0" | sed -e '/^set -uo/d' -e 's/^# \{0,1\}//'; exit 0 ;; esac
[ $# -ge 1 ] || die "give one or more service names, for example: sudo server-status cloudflared"
[ $# -le 10 ] || die "at most 10 services at a time"
for u in "$@"; do
    [[ $u =~ ^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,99}$ ]] && [[ $u != *..* ]] || die "not a service name: $u"
done
[ -x "$REDACT" ] || die "the secret filter ($REDACT) is missing, so nothing is shown"
systemctl status --no-pager --full --lines=20 -- "$@" 2>&1 </dev/null | "$REDACT"
exit "${PIPESTATUS[0]}"
STATUS_EOF
}

note_script() {
    cat <<'NOTE_EOF'
#!/bin/bash
# server-note: add one line to the AI agent's work notes,
# /var/log/ops-agent-notes.log. Installed by bootstrap.sh. Notes can only be
# added, never changed or removed by the agent (the file belongs to root).
#
#   sudo server-note "Checked the tunnel after the owner's report; restarted nothing."
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 022
export LC_ALL=C.UTF-8

NOTES="/var/log/ops-agent-notes.log"
REDACT="/usr/local/lib/server-tools/redact"
die() { printf 'server-note: %s\n' "$*" >&2; exit 2; }

case "${1:-}" in -h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; exit 0 ;; esac
[ "$(id -u)" -eq 0 ] || die "run it with sudo: sudo server-note \"what you did\""
[ $# -ge 1 ] || die 'give the note in quotes: sudo server-note "what you did"'
text="$*"
text="$(printf '%s' "$text" | tr '\n\r\t' '   ' | tr -d '\000-\037\177')"
[ -n "${text// /}" ] || die "the note is empty"
[ "${#text}" -le 2000 ] || die "keep the note under 2000 characters"
[ ! -x "$REDACT" ] || text="$(printf '%s' "$text" | "$REDACT")"
who="${SUDO_USER:-root}"
[[ $who =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || who="unknown"
if [ ! -e "$NOTES" ]; then install -m 0644 -o root -g root /dev/null "$NOTES"; fi
printf '%s %s: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$who" "$text" >>"$NOTES"
logger -t ops-agent-note -- "$who: $text" 2>/dev/null || true
echo "Note saved in $NOTES"
NOTE_EOF
}

support_script() {
    cat <<'SUPPORT_EOF'
#!/bin/bash
# server-support: collect everything needed to diagnose this server in one
# text file, with secrets removed, to paste to Claude (or anyone helping).
# Installed by bootstrap.sh. It only reads; it changes nothing on the server.
#
#   sudo server-support            write the file and show a short summary
#   sudo server-support --stdout   print the whole file instead
#
# The file is /var/lib/server-support/support-<date>.txt (readable only by
# root; the newest 10 are kept). To share it: sudo cat <that file>, copy
# everything and paste it.
#
# Secrets are removed before anything is written: the exact values in the
# tunnel token, the alert settings, the backup settings and keys and
# Coolify's settings file, plus anything that looks like a password, token,
# key, cookie or authorization header.
set -uo pipefail
PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
export LC_ALL=C.UTF-8 SYSTEMD_PAGER=cat PAGER=cat

OUT_DIR="/var/lib/server-support"
REDACT="/usr/local/lib/server-tools/redact"
KEEP=10
COOLIFY_CONTAINERS="coolify coolify-db coolify-redis coolify-realtime coolify-proxy coolify-sentinel"
SERVICES="docker containerd ssh ssh.socket cloudflared fail2ban ufw unattended-upgrades auditd systemd-journald docker-port-guard"
TIMERS="server-alert-watch.timer server-alert-digest.timer server-lynis.timer server-agent-grant-expire.timer docker-port-guard-apply.timer apt-daily.timer apt-daily-upgrade.timer"

die() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }

STDOUT=false
case "${1:-}" in
    "") ;;
    --stdout) STDOUT=true ;;
    -h | --help) sed -n '2,/^set -uo/p' "$0" | sed -e '/^set -uo/d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Usage: sudo server-support [--stdout]" >&2; exit 2 ;;
esac
[ "$(id -u)" -eq 0 ] || die "Please run with sudo: sudo server-support"
[ -x "$REDACT" ] || die "The secret filter ($REDACT) is missing, so nothing was collected. Run bootstrap.sh again."

install -d -m 0700 -o root -g root "$OUT_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
raw="$(mktemp "$OUT_DIR/.raw.XXXXXX")"
out="$OUT_DIR/support-$stamp.txt"
trap 'rm -f -- "$raw" "$out.part"' EXIT

section() { printf '\n===== %s =====\n' "$*"; }
# Run one command with a time limit; its errors go into the file too.
run() {
    printf '$ %s\n' "$*"
    timeout 120 "$@" 2>&1 </dev/null
    local rc=$?
    [ "$rc" -eq 0 ] || printf '(exit code %s)\n' "$rc"
}
present() { if [ -e "$1" ]; then echo "present"; else echo "missing"; fi; }

collect() {
    echo "Support bundle for $(hostname -f 2>/dev/null || hostname), $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "Made by: sudo server-support (run by ${SUDO_USER:-root}). Secrets are replaced by [REDACTED]."
    echo "Server tools version: $(cat /usr/local/share/server-tools/VERSION 2>/dev/null || echo unknown)"

    section "Versions"
    sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '"'
    echo "Kernel: $(uname -r)"
    echo "Docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'not running or not installed')"
    echo "Coolify: $(docker container inspect --format '{{.Config.Image}}' coolify 2>/dev/null || echo 'not found')"
    echo "cloudflared: $(cloudflared --version 2>/dev/null | head -n 1 || true)"
    echo "Lynis: $(lynis --version 2>/dev/null || echo 'not installed')"
    echo "Uptime: $(uptime -p 2>/dev/null) (since $(uptime -s 2>/dev/null))"
    if [ -f /var/run/reboot-required ]; then echo "A restart is needed since $(date -r /var/run/reboot-required '+%Y-%m-%d')"; fi

    section "Server check (server-check)"
    if [ -x /usr/local/sbin/server-check ]; then
        run /usr/local/sbin/server-check
    else
        echo "server-check is not installed (bootstrap.sh installs it from check.sh)"
    fi

    section "Services"
    local s
    for s in $SERVICES; do
        printf '%-26s active=%-10s enabled=%s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)" "$(systemctl is-enabled "$s" 2>/dev/null)"
    done
    for s in $TIMERS; do
        printf '%-34s active=%-10s next=%s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)" "$(systemctl show -p NextElapseUSecRealtime --value "$s" 2>/dev/null)"
    done
    run systemctl --failed --no-pager --no-legend
    run systemctl list-timers --all --no-pager

    section "Disk and memory"
    run df -h -x tmpfs -x devtmpfs -x overlay
    run free -m
    run docker system df

    section "Firewall and container port guard"
    run ufw status verbose
    run docker-port-guard status
    run fail2ban-client status sshd

    section "Backups"
    if [ -x /usr/local/sbin/server-backup ]; then
        run /usr/local/sbin/server-backup status
    else
        echo "server-backup is not installed"
    fi
    echo "--- /var/lib/server-backup/last-status"
    cat /var/lib/server-backup/last-status 2>/dev/null || echo "(no status file)"

    section "Alerts (settings are not shown, only whether they exist)"
    echo "Settings file /etc/server-alert/config: $(present /etc/server-alert/config)"
    if [ -f /etc/server-alert/config ]; then
        echo "Provider: $(sed -n 's/^PROVIDER=//p' /etc/server-alert/config | head -n 1)"
        echo "Daily summary: $(sed -n 's/^DIGEST=//p' /etc/server-alert/config | head -n 1)"
        echo "Mode: $(stat -c '%a %U:%G' /etc/server-alert/config)"
    fi
    run server-alert status
    echo "--- last alerts sent"
    tail -n 20 /var/lib/server-alert/sent.log 2>/dev/null |
        awk -F'\t' '{ cmd = "date -d @" $1 " +\"%Y-%m-%d %H:%M\""; cmd | getline t; close(cmd); print t, $2, $3 }'

    section "Security audit (Lynis)"
    run server-lynis show

    section "Audit log (auditd)"
    printf 'auditd: %s\n' "$(systemctl is-active auditd 2>/dev/null)"
    run auditctl -l
    echo "--- recent ops-agent commands (audit log)"
    timeout 60 ausearch -k ops-agent -i --start today 2>/dev/null | grep -E '^type=EXECVE' | tail -n 30 || echo "(none)"

    section "AI agent account (ops-agent)"
    if id ops-agent >/dev/null 2>&1; then
        run id ops-agent
        run passwd -S ops-agent
        echo "sudo rules file: $(present /etc/sudoers.d/ops-agent)"
        run visudo -c
        run server-agent-grant list
        echo "--- last 30 agent notes (/var/log/ops-agent-notes.log)"
        tail -n 30 /var/log/ops-agent-notes.log 2>/dev/null || echo "(no notes)"
        echo "--- agent sudo use, last 24 hours"
        journalctl -q --no-pager -o short-iso _COMM=sudo --since -24h 2>/dev/null | grep ' ops-agent : ' | tail -n 50
    else
        echo "No ops-agent account (bootstrap.sh --no-agent)."
    fi

    section "Containers"
    run docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.RunningFor}}'
    local c
    for c in $COOLIFY_CONTAINERS; do
        docker container inspect "$c" >/dev/null 2>&1 || continue
        section "Log of container $c (last 200 lines)"
        timeout 60 docker logs --tail 200 --timestamps "$c" 2>&1 </dev/null
    done

    section "Journal: cloudflared (last 200 lines)"
    journalctl -q --no-pager -o short-iso -u cloudflared -n 200 2>&1
    section "Journal: docker (last 200 lines)"
    journalctl -q --no-pager -o short-iso -u docker -n 200 2>&1
    section "Journal: ssh (last 50 lines)"
    journalctl -q --no-pager -o short-iso -u ssh -n 50 2>&1
    section "Journal: warnings and errors, last 24 hours (last 200 lines)"
    journalctl -q --no-pager -o short-iso -p warning --since -24h -n 200 2>&1
    section "Journal size"
    journalctl --disk-usage 2>&1
}

collect >"$raw" 2>&1
count_file="$(mktemp "$OUT_DIR/.count.XXXXXX")"
if ! "$REDACT" --count <"$raw" >"$out.part" 2>"$count_file"; then
    rm -f -- "$count_file"
    die "Removing secrets failed, so no file was written."
fi
redactions="$(tail -n 1 "$count_file")"
rm -f -- "$count_file" "$raw"
printf '\n===== End. %s values were replaced by [REDACTED]. =====\n' "${redactions:-0}" >>"$out.part"
chmod 0600 "$out.part"
mv -f -- "$out.part" "$out"
# Keep the newest $KEEP bundles.
find "$OUT_DIR" -maxdepth 1 -name 'support-*.txt' -printf '%f\n' | sort -r | tail -n +$((KEEP + 1)) |
    while read -r old; do rm -f -- "${OUT_DIR:?}/$old"; done
logger -t server-support -- "support bundle written: $out (by ${SUDO_USER:-root})" 2>/dev/null || true

if [ "$STDOUT" = true ]; then
    cat -- "$out"
    exit 0
fi
result="$(grep -m 1 '^Result:' "$out" || true)"
failed="$(systemctl --failed --no-legend --plain 2>/dev/null | grep -c . || true)"
echo "Support file written: $out"
echo "  Size: $(du -h "$out" | cut -f1), $(wc -l <"$out") lines; ${redactions:-0} secrets replaced by [REDACTED]."
echo "  Server check: ${result#Result: }"
echo "  Failed services: $failed"
echo "To share it: sudo cat $out"
echo "then copy everything and paste it to Claude. Or print it here: sudo server-support --stdout"
SUPPORT_EOF
}

grant_script() {
    cat <<'GRANT_EOF'
#!/bin/bash
# server-agent-grant: let the AI agent (account ops-agent) run ONE change
# command ONCE, for a short time, after you agreed to it. Installed by
# bootstrap.sh. Only you (with sudo) can give a permission.
#
#   sudo server-agent-grant "<command>" <time>    for example:
#        sudo server-agent-grant "server-update --yes" 30m
#   sudo server-agent-grant list                  permissions not used yet
#   sudo server-agent-grant revoke ID|all         take a permission back
#
# The agent then runs:  sudo server-agent-grant use ID
# That runs the exact command and removes the permission at once, so it works
# one time only. Unused permissions are removed when the time is up (at most
# 4 hours), by a systemd timer. Every step is written to the system log
# (journalctl -t server-agent-grant) and sent as an alert.
#
# Only these commands can be granted:
#   server-update            server-update --yes
#   server-backup restore-files [--snapshot ID] [--target DIR] [--volume NAME] [PATH...]
#   systemctl restart <service>
#   reboot
set -euo pipefail
PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
export LC_ALL=C.UTF-8

AGENT="ops-agent"
STATE="/var/lib/server-agent-grant"
SUDOERS_DIR="/etc/sudoers.d"
PREFIX="ops-agent-grant-"
SELF="/usr/local/sbin/server-agent-grant"
MAX_MINUTES=240

die() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }
log() { logger -t server-agent-grant -p "auth.${2:-notice}" -- "$1" 2>/dev/null || true; }
alert() { server-alert send --key "$1" "$2" "$3" "$4" >/dev/null 2>&1 || true; }
have_tty() { { : >/dev/tty; } 2>/dev/null; }
valid_id() { [[ $1 =~ ^[0-9]{14}[0-9a-f]{6}$ ]]; }
valid_unit() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,99}$ ]] && [[ $1 != *..* ]]; }
# Plain words only: nothing a shell or sudoers would treat specially.
valid_word() { [[ $1 =~ ^[A-Za-z0-9_./@-]{1,200}$ ]] && [[ $1 != *..* ]]; }

[ "$(id -u)" -eq 0 ] || die "Please run with sudo."
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 9>"$STATE/.lock"
flock -w 30 9 || die "Another server-agent-grant is busy. Try again."

# Turn the owner's text into the exact program and arguments, or refuse.
CMD=()
parse_command() {
    local text="$1" words w i
    read -ra words <<<"$text"
    [ "${#words[@]}" -ge 1 ] || return 1
    if [ "${words[0]}" = sudo ]; then words=("${words[@]:1}"); fi
    [ "${#words[@]}" -ge 1 ] || return 1
    for w in "${words[@]}"; do valid_word "$w" || { echo "Not allowed in a command: $w" >&2; return 1; }; done
    case "${words[0]##*/}" in
        server-update)
            case "${words[*]:1}" in
                # Only --yes: it never restarts the server, so the agent cannot
                # answer a restart question on the owner's behalf.
                "--yes") CMD=(/usr/local/sbin/server-update --yes) ;;
                *) return 1 ;;
            esac ;;
        server-backup)
            [ "${words[1]:-}" = restore-files ] || return 1
            i=2
            while [ "$i" -lt "${#words[@]}" ]; do
                case "${words[$i]}" in
                    --snapshot) [[ ${words[$((i + 1))]:-} =~ ^[0-9a-f]{8,64}$ ]] || return 1; i=$((i + 2)) ;;
                    --target) [[ ${words[$((i + 1))]:-} == /* ]] || return 1; i=$((i + 2)) ;;
                    --volume) [[ ${words[$((i + 1))]:-} =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || return 1; i=$((i + 2)) ;;
                    /*) i=$((i + 1)) ;;
                    *) return 1 ;;
                esac
            done
            CMD=(/usr/local/sbin/server-backup "${words[@]:1}") ;;
        systemctl)
            [ "${#words[@]}" -eq 3 ] && [ "${words[1]}" = restart ] && valid_unit "${words[2]}" || return 1
            systemctl cat -- "${words[2]}" >/dev/null 2>&1 || { echo "There is no service called ${words[2]}." >&2; return 1; }
            CMD=(/usr/bin/systemctl restart "${words[2]}") ;;
        reboot)
            [ "${#words[@]}" -eq 1 ] || return 1
            CMD=(/usr/sbin/reboot) ;;
        *) return 1 ;;
    esac
    # A full path must be the real place of that program.
    case "${words[0]}" in */*) [ "${words[0]}" = "${CMD[0]}" ] || return 1 ;; esac
}

to_minutes() {
    [[ $1 =~ ^([0-9]{1,3})(m|min|h)$ ]] || return 1
    local n="${BASH_REMATCH[1]}"
    case "${BASH_REMATCH[2]}" in h) n=$((n * 60)) ;; esac
    [ "$n" -ge 1 ] && [ "$n" -le "$MAX_MINUTES" ] || return 1
    printf '%s' "$n"
}

remove_grant() {
    local id="$1" why="$2" cmd=""
    valid_id "$id" || return 1
    [ -f "$STATE/$id.meta" ] || [ -f "$SUDOERS_DIR/$PREFIX$id" ] || return 1
    cmd="$(sed -n 's/^command=//p' "$STATE/$id.meta" 2>/dev/null || true)"
    rm -f -- "$SUDOERS_DIR/$PREFIX$id" "$STATE/$id.meta" "$STATE/$id.cmd"
    systemctl stop "server-agent-grant-expire-$id.timer" >/dev/null 2>&1 || true
    log "permission $id $why: ${cmd:-?}"
    printf '%s' "$cmd"
}

cmd_grant() {
    local text="$1" dur="$2" minutes id expires stage rule answer
    parse_command "$text" || die "This command cannot be granted: \"$text\". Allowed: server-update --yes, server-backup restore-files ..., systemctl restart <service>, reboot. Everything else you run yourself."
    minutes="$(to_minutes "$dur")" || die "The time must be like 15m, 30m or 2h (at most 4h)."
    id="$(date +%Y%m%d%H%M%S)$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
    expires=$(( $(date +%s) + minutes * 60 ))
    echo "The agent ($AGENT) may run this ONCE, within $minutes minutes:"
    echo "    ${CMD[*]}"
    if have_tty; then
        printf 'Allow this? [y/N] ' >/dev/tty
        read -r answer </dev/tty || answer=""
        case "$answer" in y | Y | yes | Yes | YES) ;; *) die "Nothing was granted." ;; esac
    elif [ "${ASSUME_YES:-}" != 1 ]; then
        die "No console to confirm on. Nothing was granted."
    fi
    # Store the exact words; the sudo rule only allows "use <this id>".
    printf '%s\0' "${CMD[@]}" >"$STATE/$id.cmd"
    {
        echo "id=$id"
        echo "command=${CMD[*]}"
        echo "expires=$expires"
        echo "granted_by=${SUDO_USER:-root}"
        echo "granted_at=$(date +%s)"
    } >"$STATE/$id.meta"
    rule="$AGENT ALL=(root) NOPASSWD: $SELF use $id"
    stage="$(mktemp -d /etc/.server-agent-grant.XXXXXX)"
    printf '# Written by server-agent-grant for %s at %s. Expires %s. One use only.\n# Command: %s\n%s\n' \
        "${SUDO_USER:-root}" "$(date '+%Y-%m-%d %H:%M')" "$(date -d "@$expires" '+%Y-%m-%d %H:%M')" "${CMD[*]}" "$rule" >"$stage/rule"
    chmod 0440 "$stage/rule"
    if ! visudo -cqf "$stage/rule" >/dev/null; then
        rm -rf -- "$stage" "$STATE/$id.cmd" "$STATE/$id.meta"
        die "The sudo rule did not pass visudo's check. Nothing was granted."
    fi
    mv -f -- "$stage/rule" "$SUDOERS_DIR/$PREFIX$id"
    rmdir -- "$stage"
    if ! visudo -cq >/dev/null; then
        rm -f -- "$SUDOERS_DIR/$PREFIX$id" "$STATE/$id.cmd" "$STATE/$id.meta"
        die "sudo's settings did not pass the check with this rule, so it was removed. Nothing was granted."
    fi
    # The timer is made right after; without it the permission is removed again
    # (the 5 minute safety timer would also remove it once it is past due).
    if ! systemd-run --quiet --unit="server-agent-grant-expire-$id" --on-active="${minutes}min" --timer-property=AccuracySec=1s "$SELF" expire "$id" >/dev/null 2>&1; then
        remove_grant "$id" "removed (no expiry timer)" >/dev/null || true
        die "Could not create the timer that ends the permission, so nothing was granted."
    fi
    log "permission $id granted by ${SUDO_USER:-root} to $AGENT until $(date -d "@$expires" '+%Y-%m-%d %H:%M'): ${CMD[*]}" warning
    alert "grant-$id" warning "AI agent may run one command" "Granted by ${SUDO_USER:-root}, once, until $(date -d "@$expires" '+%H:%M'): ${CMD[*]}"
    echo "Granted (id $id). Tell the agent it may now run:"
    echo "    sudo server-agent-grant use $id"
    echo "Take it back any time: sudo server-agent-grant revoke $id"
}

cmd_use() {
    local id="$1" expires argv=() rc=0 cmd
    valid_id "$id" || die "Not a permission id."
    [ -f "$STATE/$id.meta" ] && [ -f "$STATE/$id.cmd" ] || die "There is no such permission (used already, taken back or expired). Ask the owner."
    expires="$(sed -n 's/^expires=//p' "$STATE/$id.meta")"
    if [[ ! $expires =~ ^[0-9]+$ ]] || [ "$(date +%s)" -ge "$expires" ]; then
        remove_grant "$id" "expired" >/dev/null || true
        die "This permission has expired. Ask the owner."
    fi
    mapfile -d '' -t argv <"$STATE/$id.cmd"
    [ "${#argv[@]}" -ge 1 ] || die "The stored command is empty."
    # One use only: the permission is gone before the command starts.
    cmd="$(remove_grant "$id" "used by ${SUDO_USER:-root}")"
    alert "grant-used-$id" warning "AI agent is running an approved command" "${SUDO_USER:-root} started: $cmd"
    log "running for ${SUDO_USER:-root}: $cmd" warning
    # The lock is not passed on: a long update must not block other grants.
    "${argv[@]}" 9>&- || rc=$?
    log "finished with exit code $rc: $cmd" "$( [ "$rc" -eq 0 ] && echo notice || echo warning)"
    alert "grant-done-$id" "$( [ "$rc" -eq 0 ] && echo info || echo warning)" "Approved command finished (exit code $rc)" "$cmd"
    exit "$rc"
}

cmd_expire() {
    local id="$1" cmd
    if cmd="$(remove_grant "$id" "expired unused")"; then
        alert "grant-expired-$id" info "AI agent permission ended unused" "$cmd"
    fi
}

# Remove every permission whose time is up, and rules left without their
# state file (safety net for timers lost in a restart).
cmd_expire_due() {
    local f id expires now
    now="$(date +%s)"
    for f in "$STATE"/*.meta; do
        [ -f "$f" ] || continue
        id="$(basename "$f" .meta)"
        expires="$(sed -n 's/^expires=//p' "$f")"
        if [[ ! $expires =~ ^[0-9]+$ ]] || [ "$now" -ge "$expires" ]; then cmd_expire "$id"; fi
    done
    for f in "$SUDOERS_DIR/$PREFIX"*; do
        [ -f "$f" ] || continue
        id="${f##*/"$PREFIX"}"
        if ! valid_id "$id" || [ ! -f "$STATE/$id.meta" ]; then
            rm -f -- "$f"
            log "removed a leftover agent permission rule: $f" warning
        fi
    done
}

cmd_list() {
    local f n=0
    for f in "$STATE"/*.meta; do
        [ -f "$f" ] || continue
        n=$((n + 1))
        printf '%s  until %s  %s\n' "$(sed -n 's/^id=//p' "$f")" \
            "$(date -d "@$(sed -n 's/^expires=//p' "$f")" '+%Y-%m-%d %H:%M')" "$(sed -n 's/^command=//p' "$f")"
    done
    [ "$n" -gt 0 ] || echo "No open permissions for the agent."
}

cmd_revoke() {
    local id="$1" f cmd
    if [ "$id" = all ]; then
        for f in "$STATE"/*.meta; do
            [ -f "$f" ] || continue
            cmd_revoke "$(basename "$f" .meta)"
        done
        return 0
    fi
    cmd="$(remove_grant "$id" "taken back by ${SUDO_USER:-root}")" || die "No such permission: $id"
    alert "grant-revoked-$id" info "AI agent permission taken back" "$cmd"
    echo "Taken back: $cmd"
}

case "${1:-}" in
    use) [ $# -eq 2 ] || die "Usage: sudo server-agent-grant use ID"; cmd_use "$2" ;;
    list) cmd_list ;;
    revoke) [ $# -eq 2 ] || die "Usage: sudo server-agent-grant revoke ID|all"; cmd_revoke "$2" ;;
    expire) [ $# -eq 2 ] || exit 2; cmd_expire "$2" ;;
    expire-due) cmd_expire_due ;;
    -h | --help | help | "") sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//' ;;
    -*) die "Unknown option: $1" ;;
    *) [ $# -eq 2 ] || die 'Usage: sudo server-agent-grant "<command>" 30m'; cmd_grant "$1" "$2" ;;
esac
GRANT_EOF
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary_cloudflare() {
    local item base="${DASHBOARD_HOST#*.}"
    # The browser terminal is named after the dashboard: appy.example.com -> appy-ssh.example.com
    local ssh_host="${DASHBOARD_HOST%%.*}-ssh.$base" routes
    # Same order and spelling as the guide (docs/SERVER.md, step 7).
    routes="$(
        printf '       %-22s %-49s %s\n' \
            "$DASHBOARD_HOST" 'path ^/webhooks/source/github/events(/manual)?$' 'HTTP 127.0.0.1:8000' \
            "$DASHBOARD_HOST" 'path ^/app/' 'HTTP 127.0.0.1:6001' \
            "$DASHBOARD_HOST" 'path ^/terminal/ws' 'HTTP 127.0.0.1:6002' \
            "$DASHBOARD_HOST" '(no path)' 'HTTP 127.0.0.1:8000' \
            "$ssh_host" '(no path)' 'SSH  127.0.0.1:22' \
            "*.$base" '(no path)' 'HTTP 127.0.0.1:80'
    )"
    printf '\n%s============================================================%s\n' "$C_BOLD" "$C_RESET"
    printf '%s Done. What this script did%s\n' "$C_BOLD" "$C_RESET"
    printf '%s============================================================%s\n' "$C_BOLD" "$C_RESET"
    for item in "${SUMMARY[@]}"; do
        printf '  - %s\n' "$item"
    done
    printf '\n%sOpen to the internet:%s nothing. Everything comes in through the Cloudflare Tunnel.\n' "$C_BOLD" "$C_RESET"
    printf 'Closed to the internet: 22, 80, 443, Coolify ports 8000/6001/6002, everything else.\n'
    if [ "$DRY_RUN" = true ]; then
        printf '\n%sDry run: nothing was changed.%s\n' "$C_YELLOW" "$C_RESET"
        return 0
    fi
    cat <<EOF

${C_BOLD}Next steps in the Cloudflare dashboard${C_RESET} (step by step: docs/SERVER.md):
  1. FIRST, Zero Trust, Access, Applications: protect $DASHBOARD_HOST,
     $ssh_host (browser rendering: SSH) and *.$base with your email.
     Add a Bypass application for $DASHBOARD_HOST, path
     webhooks/source/github/events, so GitHub can tell Coolify to deploy.
  2. Only then, your tunnel, Routes, add these in this order:
$routes
  3. SSH CA for the browser terminal: Access controls, Service credentials,
     SSH, Add a certificate, application $ssh_host, Generate certificate.

${C_BOLD}Then in your browser:${C_RESET}
  4. Open https://$DASHBOARD_HOST and log in with:
EOF
    if [ -n "$ADMIN_PASSWORD" ]; then
        cat <<EOF
       Email:    $ADMIN_EMAIL
       Password: $ADMIN_PASSWORD
     (Also saved in $FIRST_LOGIN_FILE, readable only by root:
      sudo cat $FIRST_LOGIN_FILE)
EOF
    elif [ -s "$FIRST_LOGIN_FILE" ]; then
        echo "       the email and password saved in $FIRST_LOGIN_FILE (sudo cat $FIRST_LOGIN_FILE)"
    else
        echo "       the Coolify account you already have."
    fi
    cat <<EOF
  5. Change that password at once, then turn on two-factor login (Profile).
  6. Settings: URL https://$DASHBOARD_HOST, "Redirect HTTP to HTTPS" Disabled.
  7. Delete the saved password:  sudo rm $FIRST_LOGIN_FILE

SSH in the browser: https://$ssh_host, sign in to Cloudflare, user name $OWNER_USER.
No password: Cloudflare gives the browser a certificate that lasts a few minutes.
EOF
    if [ ! -s "$SSH_CA_FILE" ]; then
        cat <<EOF
${C_YELLOW}Browser SSH needs the SSH CA key from Cloudflare first:${C_RESET}
  Zero Trust, Access controls, Service credentials, SSH, Add a certificate,
  choose the $ssh_host application, Generate certificate, copy the CA public key.
  Then on this console:  sudo server-ssh-ca set   (paste it, press Enter)
EOF
    fi
    cat <<EOF
Updates: Ubuntu security patches install by themselves. For everything else,
when it suits you:  sudo server-update
EOF
    print_ops_footer
}

print_summary() {
    local item closes
    if [ "$MODE" = cloudflare ]; then
        print_summary_cloudflare
        return 0
    fi
    closes="$(date -d "+$SETUP_WINDOW_MINUTES min" '+%H:%M')"
    printf '\n%s============================================================%s\n' "$C_BOLD" "$C_RESET"
    printf '%s Done. What this script did%s\n' "$C_BOLD" "$C_RESET"
    printf '%s============================================================%s\n' "$C_BOLD" "$C_RESET"
    for item in "${SUMMARY[@]}"; do
        printf '  - %s\n' "$item"
    done

    printf '\n%sOpen to the internet:%s only 80/tcp, 443/tcp and 443/udp (websites over HTTPS).\n' "$C_BOLD" "$C_RESET"
    printf 'Closed to the internet: SSH (22), Coolify dashboard ports 8000/6001/6002, everything else.\n'
    if [ "$SETUP_WINDOW_OPENED" = true ]; then
        printf 'Temporarily open: 8000 and 6001, for the first login only, until %s.\n' "$closes"
    fi
    if [ "$DRY_RUN" = true ]; then
        printf '\n%sDry run: nothing was changed.%s\n' "$C_YELLOW" "$C_RESET"
        return 0
    fi

    printf '\n%sSSH password login is OFF.%s Keep using the Hyper-V console.\n' "$C_YELLOW" "$C_RESET"

    if [ "$SETUP_WINDOW_OPENED" = true ]; then
        cat <<EOF

${C_BOLD}Next steps (do these before $closes):${C_RESET}
  1. Make sure your domain has a DNS "A" record: $DASHBOARD_HOST -> $PUBLIC_IP
  2. On your computer, open:  http://$PUBLIC_IP:8000
     The browser will say "Not secure". That is expected, for this one visit only.
EOF
        if [ -n "$ADMIN_PASSWORD" ]; then
            cat <<EOF
  3. Log in with:
       Email:    $ADMIN_EMAIL
       Password: $ADMIN_PASSWORD
     (Also saved in $FIRST_LOGIN_FILE, readable only by root:
      sudo cat $FIRST_LOGIN_FILE)
EOF
        elif [ -s "$FIRST_LOGIN_FILE" ]; then
            echo "  3. Log in with the email and password saved in $FIRST_LOGIN_FILE:"
            echo "       sudo cat $FIRST_LOGIN_FILE"
        else
            echo "  3. Log in with the Coolify account you already have."
        fi
        cat <<EOF
  4. Follow Coolify's welcome steps and choose "This Machine" (localhost) as the server.
  5. Go to Settings. In "Domain" (Instance's Domain) type:  https://$DASHBOARD_HOST
     and press Save. Wait one or two minutes.
  6. Open https://$DASHBOARD_HOST (with the lock icon) and log in again.
  7. Click your profile: change the password, then turn on two-factor login.
  8. Delete the saved password:  sudo rm $FIRST_LOGIN_FILE
  9. Optional: close the setup window early:  sudo docker-port-guard close

If time runs out, open the window again with:  sudo docker-port-guard open-setup 30 <your-internet-address>
Updates (when it suits you):                   sudo server-update
EOF
    else
        printf '\nDashboard: https://%s\n' "$DASHBOARD_HOST"
        printf 'If you ever need the first-login window again: sudo docker-port-guard open-setup 30 <your-internet-address>\n'
        printf 'Updates (when it suits you): sudo server-update\n'
    fi
    print_ops_footer
}

# ---------------------------------------------------------------------------
# Backup and disaster recovery (see backup/README.md)
# ---------------------------------------------------------------------------
install_backup_tool() {
    step "Backup and disaster recovery tool"
    local src
    src="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/backup/server-backup"
    if [ ! -f "$src" ]; then
        warn "backup/server-backup was not found next to this script, so backups are not installed. Download it with this script (see README)."
        return 0
    fi
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends restic rclone jq openssh-client openssl
    run install -m 0755 -o root -g root "$src" /usr/local/sbin/server-backup
    ok "server-backup installed"
    if [ -f /etc/server-backup/config ]; then
        done_item "Backups: already set up. Status: sudo server-backup status"
    else
        done_item "Backups: NOT set up yet. Next: sudo server-backup setup (to your SFTP or FTPS server)"
    fi
}

main() {
    parse_args "$@"
    printf '%sServer setup for Coolify (bootstrap.sh %s)%s\n' "$C_BOLD" "$SCRIPT_VERSION" "$C_RESET"
    [ "$DRY_RUN" = true ] && printf '%sDRY RUN: changes are shown, not made.%s\n' "$C_YELLOW" "$C_RESET"
    preflight
    install_packages
    configure_journald
    configure_unattended_upgrades
    configure_swap
    configure_ssh
    configure_ufw
    install_guard
    configure_fail2ban
    if [ "$MODE" = cloudflare ]; then
        install_cloudflared
    elif [ -f "$CF_UNIT" ]; then
        warn "cloudflared is still running from Cloudflare mode. Remove it (sudo systemctl disable --now cloudflared) and remove CLIENT_IP_HEADER from your apps in Coolify: with 80/443 open, anyone could fake that header."
    fi
    install_coolify
    pin_docker_major
    configure_docker_logs
    install_server_tools
    create_ops_agent
    configure_auditd
    configure_lynis
    configure_alerts
    install_backup_tool
    open_setup_window
    print_summary
    if [ "$CF_RESTART_AT_END" = true ]; then
        printf '\nRestarting the tunnel with the new settings now. A browser SSH session through\nthe tunnel drops; open it again in a few seconds.\n'
        systemctl restart --no-block cloudflared.service
    fi
}

main "$@"
