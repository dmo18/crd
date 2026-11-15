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
#      ca-certificates, jq, openssh-server, python3-systemd.
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
#  12. Direct mode only: a 30 minute "setup window" on ports 8000 and 6001 so the
#      owner can do the first login from a browser. It closes by itself. On a
#      later run it is only opened again after asking.
#
# Safe to run again: every step checks the current state first. Coolify is only
# installed once; after that it updates itself.

set -euo pipefail
umask 022

readonly SCRIPT_VERSION="1.2.0"
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

DRY_RUN=false
ASSUME_YES=false
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
        warn "Your email starts with '$SSH_PRINCIPAL' but your Ubuntu user is '$OWNER_USER'. Cloudflare's guide says the browser terminal expects them to be the same. If the terminal refuses, type '$OWNER_USER' when it asks for the user name."
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
    run apt-get "${apt_opts[@]}" install ufw fail2ban unattended-upgrades curl ca-certificates jq openssh-server python3-systemd iproute2
    if [ "$MODE" = cloudflare ]; then
        # gnupg checks the fingerprint of Cloudflare's package signing key.
        run apt-get "${apt_opts[@]}" install gnupg
    fi
    done_item "System updated; ufw, fail2ban, unattended-upgrades, curl, jq installed"
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
        "$BACKUP_BIN" run || die "The backup failed, so nothing was updated. Fix the backup first, or run: sudo server-update --skip-backup"
        say "Backup done."
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
# part of the sign-in email before the @, in lower case.
$SSH_PRINCIPAL
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
        if [ "$ASSUME_YES" = true ] || ! ask_yes_no "Open the Coolify dashboard ports 8000 and 6001 to the internet again for $SETUP_WINDOW_MINUTES minutes?"; then
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
# Summary
# ---------------------------------------------------------------------------
print_summary_cloudflare() {
    local item base="${DASHBOARD_HOST#*.}"
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
     ssh.$base (browser rendering: SSH) and *.$base with your email.
     Add a Bypass application for $DASHBOARD_HOST, path
     webhooks/source/github/events, so GitHub can tell Coolify to deploy.
  2. Only then, your tunnel, Routes, add these in this order:
       $DASHBOARD_HOST   path ^/webhooks/source/github/events -> HTTP 127.0.0.1:8000
       $DASHBOARD_HOST   path ^/app/         ->  HTTP  127.0.0.1:6001
       $DASHBOARD_HOST   path ^/terminal/ws  ->  HTTP  127.0.0.1:6002
       $DASHBOARD_HOST   (no path)           ->  HTTP  127.0.0.1:8000
       ssh.$base         (no path)           ->  SSH   127.0.0.1:22
       *.$base           (no path)           ->  HTTP  127.0.0.1:80
  3. SSH CA for the browser terminal: Access controls, Service credentials,
     SSH, Add a certificate, application ssh.$base, Generate certificate.

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

SSH in the browser: https://ssh.$base, sign in to Cloudflare, user name $OWNER_USER.
No password: Cloudflare gives the browser a certificate that lasts a few minutes.
EOF
    if [ ! -s "$SSH_CA_FILE" ]; then
        cat <<EOF
${C_YELLOW}Browser SSH needs the SSH CA key from Cloudflare first:${C_RESET}
  Zero Trust, Access controls, Service credentials, SSH, Add a certificate,
  choose the ssh.$base application, Generate certificate, copy the CA public key.
  Then on this console:  sudo server-ssh-ca set   (paste it, press Enter)
EOF
    fi
    cat <<EOF
Updates: Ubuntu security patches install by themselves. For everything else,
when it suits you:  sudo server-update
Check the server any time with:  sudo bash check.sh
EOF
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
Check the server any time with:                sudo bash check.sh
EOF
    else
        printf '\nDashboard: https://%s\n' "$DASHBOARD_HOST"
        printf 'If you ever need the first-login window again: sudo docker-port-guard open-setup 30 <your-internet-address>\n'
        printf 'Updates (when it suits you): sudo server-update\n'
    fi
}

main() {
    parse_args "$@"
    printf '%sServer setup for Coolify (bootstrap.sh %s)%s\n' "$C_BOLD" "$SCRIPT_VERSION" "$C_RESET"
    [ "$DRY_RUN" = true ] && printf '%sDRY RUN: changes are shown, not made.%s\n' "$C_YELLOW" "$C_RESET"
    preflight
    install_packages
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
    open_setup_window
    print_summary
    if [ "$CF_RESTART_AT_END" = true ]; then
        printf '\nRestarting the tunnel with the new settings now. A browser SSH session through\nthe tunnel drops; open it again in a few seconds.\n'
        systemctl restart --no-block cloudflared.service
    fi
}

main "$@"
