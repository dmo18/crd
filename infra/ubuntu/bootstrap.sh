#!/usr/bin/env bash
#
# bootstrap.sh: prepare a fresh Ubuntu 24.04 LTS server for Coolify v4.
#
# Usage (from the server console, as the user created during Ubuntu install):
#   sudo bash bootstrap.sh admin.example.com [you@example.com]
#   sudo bash bootstrap.sh --dry-run admin.example.com      (only print what would change)
#   sudo bash bootstrap.sh --cloudflare admin.example.com [you@example.com]
#
# Two modes:
#   direct (default)  the server answers web traffic itself on 80/443.
#   --cloudflare      everything comes in through a Cloudflare Tunnel: cloudflared
#                     on this server connects OUT to Cloudflare, so no port at all
#                     is open to the internet (not 22, not 80, not 443). The tunnel
#                     token is asked for with hidden typing, or read from the
#                     environment variable CF_TUNNEL_TOKEN (never from the command
#                     line, where other users could see it).
#
# What it does, in order:
#   1. Preflight checks (Ubuntu 24.04, root, CPU/RAM/disk, internet).
#   2. Updates the system and installs: ufw, fail2ban, unattended-upgrades, curl,
#      ca-certificates, jq, openssh-server, python3-systemd.
#   3. Automatic updates every day (Ubuntu security and regular updates, Docker's
#      packages, cloudflared in Cloudflare mode), reboot at 04:30 only when required.
#   4. A 2 GB swap file if the server has no swap, and vm.swappiness=10.
#   5. SSH hardening: keys only, root only with a key (Coolify needs that), 3 tries.
#      Cloudflare mode only: password login is allowed for connections from this
#      server itself (127.0.0.1, ::1), which is where Cloudflare's browser SSH
#      terminal arrives through the tunnel. Root still never logs in by password.
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
#  11. Direct mode only: a 30 minute "setup window" on ports 8000 and 6001 so the
#      owner can do the first login from a browser. It closes by itself.
#
# Safe to run again: every step checks the current state first. Coolify is only
# installed once; after that it updates itself.

set -euo pipefail
umask 022

readonly SCRIPT_VERSION="1.1.0"
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
readonly UU_CLOUDFLARE="/etc/apt/apt.conf.d/53unattended-upgrades-cloudflared"

DRY_RUN=false
ASSUME_YES=false
MODE=""            # direct or cloudflare, from --direct / --cloudflare or the earlier run
MODE_FROM_ARGS=""
CF_TOKEN=""        # the tunnel token, only in memory; never printed
CF_TOKEN_KEEP=false
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
    mkdir -p -- "$(dirname -- "$path")"
    tmp="$(mktemp "${path}.tmp.XXXXXX")"
    printf '%s\n' "$content" >"$tmp"
    chmod "$mode" "$tmp"
    mv -f -- "$tmp" "$path"
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
                  You are asked for the tunnel token (typing stays hidden).
                  For runs without a console, put it in the environment
                  variable CF_TUNNEL_TOKEN instead. Never type it on the
                  command line.
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

read_tunnel_token() {
    local from_env="${CF_TUNNEL_TOKEN:-}" typed="" tries=0
    # Keep it out of the environment of every program started from here on.
    unset CF_TUNNEL_TOKEN
    if [ -n "$from_env" ]; then
        CF_TOKEN="$(clean_token "$from_env")"
        from_env=""
        token_is_valid "$CF_TOKEN" ||
            die "The tunnel token in CF_TUNNEL_TOKEN does not look right. Copy it again from Cloudflare (it starts with eyJ and is one long line)."
        ok "Tunnel token read from CF_TUNNEL_TOKEN (not shown)"
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
        die "No console to ask for the tunnel token. Run it from the console, or set CF_TUNNEL_TOKEN."
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

    if ! coolify_installed; then
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
    step "Turning on automatic updates"
    write_file "$UU_PERIODIC" 0644 <<'EOF'
// Written by bootstrap.sh: check for and install updates every day.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
    write_file "$UU_LOCAL" 0644 <<'EOF'
// Written by bootstrap.sh. Keep everything on the latest released version:
// Ubuntu's security and regular updates, and Docker's own packages (docker-ce,
// containerd.io, the compose and buildx plugins) from Docker's repository,
// which Coolify's installer adds (Release file: Origin "Docker", Label
// "Docker CE", Suite = the Ubuntu codename). A Docker engine update restarts
// Docker; Coolify's containers and apps have restart policies and come back.
// These lists add to Ubuntu's defaults in 50unattended-upgrades.
Unattended-Upgrade::Allowed-Origins {
        "${distro_id}:${distro_codename}-security";
        "${distro_id}:${distro_codename}-updates";
};
Unattended-Upgrade::Origins-Pattern {
        "origin=Docker,label=Docker CE,archive=${distro_codename}";
};
// Restart at a quiet time, only when an update needs one.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
    run systemctl enable --now unattended-upgrades.service
    run systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
    local tz
    tz="$(timedatectl show -p Timezone --value 2>/dev/null || echo "server time")"
    if [ "$DRY_RUN" = false ]; then
        local timer
        for timer in apt-daily.timer apt-daily-upgrade.timer; do
            systemctl is-enabled --quiet "$timer" || warn "$timer is not enabled; automatic updates will not run"
        done
    fi
    ok "Updates (Ubuntu security and regular, Docker) install daily; restart at 04:30 ($tz) only when needed"
    done_item "Automatic updates on: Ubuntu security and regular updates, Docker packages (restart at 04:30 $tz only when required)"
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
        if [ ! -f "$SWAPFILE" ]; then
            run fallocate -l 2G "$SWAPFILE"
        else
            info "Found $SWAPFILE but it is not in use; turning it on"
        fi
        if enable_swapfile; then
            use_swapfile=true
        else
            # Some file systems refuse fallocate'd swap files; write it out instead.
            rm -f -- "$SWAPFILE"
            dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=none
            if enable_swapfile; then
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
    # and files in sshd_config.d are read in name order before sshd_config.
    local loopback_passwords=""
    if [ "$MODE" = cloudflare ]; then
        # Must stay at the end of the file: everything after "Match" belongs to it.
        loopback_passwords='
# Cloudflare mode: Cloudflare'"'"'s browser SSH terminal reaches this server through
# the tunnel, so cloudflared connects from this server itself (127.0.0.1 or ::1).
# Only those connections may use a password, and only after the Cloudflare Access
# sign-in. Root still needs a key (PermitRootLogin above applies here too).
Match Address 127.0.0.1,::1
    PasswordAuthentication yes
    KbdInteractiveAuthentication no'
        # Only the person who ran this setup may use it, so nothing else on
        # this server (for example an app on the host network) can try other
        # accounts through 127.0.0.1.
        if [[ ${SUDO_USER:-} =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [ "$SUDO_USER" != root ]; then
            loopback_passwords="$loopback_passwords
    AllowUsers $SUDO_USER root"
        fi
    fi
    {
        cat <<'EOF'
# Written by bootstrap.sh. Keys only; no passwords over the network.
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
        if [ -n "$loopback_passwords" ]; then printf '%s\n' "$loopback_passwords"; fi
    } | write_file "$SSHD_DROPIN" 0644
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] sshd -t (check the config), then reload SSH"
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
    fi
    if [ "$MODE" = cloudflare ]; then
        if [ "$DRY_RUN" = false ]; then
            # Prove the rule: password only for connections from this server itself.
            local pw_local pw_remote pw_root
            pw_local="$(sshd -T -C addr=127.0.0.1,user=check,host=localhost,laddr=127.0.0.1,lport=22 2>/dev/null | awk '$1 == "passwordauthentication" {print $2}')"
            pw_remote="$(sshd -T -C addr=203.0.113.9,user=check,host=example.net,laddr=127.0.0.1,lport=22 2>/dev/null | awk '$1 == "passwordauthentication" {print $2}')"
            pw_root="$(sshd -T -C addr=127.0.0.1,user=root,host=localhost,laddr=127.0.0.1,lport=22 2>/dev/null | awk '$1 == "permitrootlogin" {print $2}')"
            case "$pw_root" in without-password | prohibit-password) ;; *) pw_root="bad:$pw_root" ;; esac
            if [ "$pw_local" != yes ] || [ "$pw_remote" != no ] || [ "${pw_root#bad:}" != "$pw_root" ]; then
                rm -f -- "$SSHD_DROPIN"
                systemctl reload ssh.service 2>/dev/null || true
                die "The SSH password rule did not check out (local=$pw_local, other=$pw_remote, root=$pw_root), so the settings were removed again."
            fi
        fi
        ok "SSH: keys only from the network; password only through the Cloudflare tunnel (not for root)"
        done_item "SSH hardened (keys only; password only for Cloudflare's browser SSH via the tunnel, never root; 3 tries)"
    else
        ok "SSH: keys only, root only with a key, 3 tries per connection"
        warn "Password login over SSH is now OFF. Use the Hyper-V console to log in, as before."
        done_item "SSH hardened (passwords off, root by key only, 3 tries)"
    fi
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
#   docker-port-guard apply            rebuild the rules (safe to repeat)
#   docker-port-guard open-setup [M]   allow 8000 and 6001 for M minutes (default 30)
#   docker-port-guard close            end the setup window now
#   docker-port-guard status           show the rules
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin

CHAIN="PORT-GUARD"
CONFIG="/etc/default/docker-port-guard"
STATE_DIR="/run/docker-port-guard"
WINDOW_FILE="$STATE_DIR/setup-window-until"
CLOSE_UNIT="docker-port-guard-close"
SELF="/usr/local/sbin/docker-port-guard"
ALWAYS_ALLOWED="tcp/80 tcp/443 udp/443"
SETUP_PORTS="tcp/8000 tcp/6001"
TRUSTED_IFACES="lo docker0 br-+"
EXTRA_ALLOWED=""
MODE="direct"

# Test hooks: let a test point the script at other files.
CONFIG="${DPG_CONFIG:-$CONFIG}"
STATE_DIR="${DPG_STATE_DIR:-$STATE_DIR}"
WINDOW_FILE="$STATE_DIR/setup-window-until"

if [ -r "$CONFIG" ]; then
    # shellcheck source=/dev/null
    . "$CONFIG"
fi
case "$MODE" in
    cloudflare) ALWAYS_ALLOWED="" ;;
    direct) ;;
    *) echo "docker-port-guard: unknown MODE '$MODE' in $CONFIG, using direct" >&2; MODE="direct" ;;
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

rule_set() {
    local entries="$ALWAYS_ALLOWED $EXTRA_ALLOWED" entry proto port iface
    if window_until >/dev/null; then
        entries="$entries $SETUP_PORTS"
    fi
    echo "*filter"
    echo ":$CHAIN - [0:0]"
    echo "-A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
    for iface in $TRUSTED_IFACES; do
        echo "-A $CHAIN -i $iface -j RETURN"
    done
    for entry in $entries; do
        if [[ ! $entry =~ ^(tcp|udp)/([0-9]{1,5})$ ]] || [ "${BASH_REMATCH[2]}" -lt 1 ] || [ "${BASH_REMATCH[2]}" -gt 65535 ]; then
            echo "docker-port-guard: ignoring invalid port entry '$entry' (use tcp/1234 or udp/1234)" >&2
            continue
        fi
        proto="${BASH_REMATCH[1]}"
        port="${BASH_REMATCH[2]}"
        # Only traffic Docker forwarded from a published port (DNAT), not any
        # container address that happens to listen on the same port.
        echo "-A $CHAIN -p $proto -m conntrack --ctstate DNAT --ctorigdstport $port --ctdir ORIGINAL -j RETURN"
    done
    echo "-A $CHAIN -j DROP"
    echo "COMMIT"
}

apply_family() {
    local ipt="$1" restore="$2" first
    if ! command -v "$ipt" >/dev/null 2>&1 || ! "$ipt" -w -S FORWARD >/dev/null 2>&1; then
        echo "docker-port-guard: $ipt not available, skipped"
        return 0
    fi
    "$ipt" -w -N DOCKER-USER 2>/dev/null || true
    # One transaction: the chain is emptied and refilled atomically, no gap.
    rule_set | "$restore" -w --noflush
    # Our jump must be rule 1. Insert it first, then remove older copies
    # (highest rule number first), so there is never a moment without it.
    first="$("$ipt" -w -S DOCKER-USER | sed -n '2p')"
    if [ "$first" != "-A DOCKER-USER -j $CHAIN" ]; then
        "$ipt" -w -I DOCKER-USER 1 -j "$CHAIN"
    fi
    "$ipt" -w -S DOCKER-USER |
        awk -v r="-A DOCKER-USER -j $CHAIN" 'NR > 2 && $0 == r { print NR - 1 }' |
        sort -rn |
        while read -r n; do
            "$ipt" -w -D DOCKER-USER "$n"
        done
    echo "docker-port-guard: $ipt rules applied"
}

apply() {
    apply_family iptables iptables-restore
    # The IPv6 part may be missing (IPv6 off); IPv4 must work.
    apply_family ip6tables ip6tables-restore || echo "docker-port-guard: IPv6 rules could not be applied" >&2
    local until ports
    ports="$(printf '%s %s' "$ALWAYS_ALLOWED" "$EXTRA_ALLOWED" | xargs)"
    echo "docker-port-guard: mode $MODE, container ports open to the internet: ${ports:-none}"
    if until="$(window_until)"; then
        echo "docker-port-guard: setup window OPEN until $(date -d "@$until" '+%H:%M')"
    fi
}

open_setup() {
    local minutes="${1:-30}"
    [[ $minutes =~ ^[0-9]+$ ]] && [ "$minutes" -ge 1 ] && [ "$minutes" -le 120 ] ||
        { echo "Minutes must be between 1 and 120" >&2; exit 2; }
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
    echo $(( $(date +%s) + minutes * 60 )) >"$WINDOW_FILE"
    apply
}

close_setup() {
    rm -f "$WINDOW_FILE"
    apply
    echo "docker-port-guard: setup window closed"
}

status() {
    local ipt until
    for ipt in iptables ip6tables; do
        if command -v "$ipt" >/dev/null 2>&1 && "$ipt" -w -S "$CHAIN" >/dev/null 2>&1; then
            echo "== $ipt DOCKER-USER"
            "$ipt" -w -S DOCKER-USER
            echo "== $ipt $CHAIN"
            "$ipt" -w -S "$CHAIN"
        fi
    done
    echo "Mode: $MODE"
    if until="$(window_until)"; then
        echo "Setup window: OPEN until $(date -d "@$until" '+%H:%M')"
    else
        echo "Setup window: closed"
    fi
}

case "${1:-apply}" in
    apply) apply ;;
    open-setup) open_setup "${2:-30}" ;;
    close) close_setup ;;
    status) status ;;
    print-rules) rule_set ;;
    *) echo "Usage: $0 apply | open-setup [minutes] | close | status" >&2; exit 2 ;;
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
key_fingerprints() {
    local home="$WORKDIR/gnupg"
    mkdir -p "$home" && chmod 700 "$home"
    gpg --batch --homedir "$home" --with-colons --show-keys "$1" 2>/dev/null |
        awk -F: '$1 == "pub" { want = 1; next } $1 == "fpr" && want { print $10; want = 0 }'
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
    if head -c 40 "$key" | grep -q -- '-----BEGIN PGP'; then
        gpg --batch --homedir "$WORKDIR/gnupg" --dearmor <"$key" >"$plain" 2>/dev/null || die "Cloudflare's signing key could not be read."
    else
        cp -- "$key" "$plain"
    fi
    fprs="$(key_fingerprints "$plain" | tr '\n' ' ')"
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

    # Updates come from apt (with the automatic security updates), not from
    # cloudflared itself: allow Cloudflare's repository in unattended-upgrades.
    write_file "$UU_CLOUDFLARE" 0644 <<'EOF'
// Written by bootstrap.sh: install cloudflared updates from Cloudflare's signed
// repository automatically, together with Ubuntu's security updates.
Unattended-Upgrade::Origins-Pattern {
        "origin=cloudflared,codename=${distro_codename}";
};
EOF

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
# cloudflared runs as root (systemd credentials for a non-root user did not
# work in testing), so hide the sockets that would turn a cloudflared break-in
# into control of the whole server. "-" ignores paths that do not exist.
InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/run/containerd -/run/docker -/var/lib/docker -/data/coolify

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
    # private temporary file first, and its SHA-256 fingerprint is printed so the
    # run can be compared against a fresh download later if anything looks wrong.
    ensure_workdir
    local installer="$WORKDIR/coolify-install.sh" sum
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 120 -o "$installer" "$COOLIFY_INSTALLER_URL" ||
        die "Could not download the Coolify installer. Check the internet connection and run this script again."
    if [ ! -s "$installer" ] || ! head -n 1 "$installer" | grep -q '^#!'; then
        die "The downloaded Coolify installer looks wrong (not a script). Nothing was installed."
    fi
    sum="$(sha256sum "$installer" | awk '{print $1}')"
    info "Downloaded Coolify's official installer from $COOLIFY_INSTALLER_URL"
    info "SHA-256 fingerprint: $sum"

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
    # HOME and USER are set explicitly: the installer adds its SSH key to
    # ~/.ssh/authorized_keys of the current user, which must be root.
    run env HOME=/root USER=root \
        ROOT_USERNAME="admin" \
        ROOT_USER_EMAIL="$ADMIN_EMAIL" \
        ROOT_USER_PASSWORD="$ADMIN_PASSWORD" \
        bash "$installer" ||
        die "The Coolify installer reported a problem. Its log is in /data/coolify/source/. You can run this script again."

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
    "$GUARD_BIN" open-setup "$SETUP_WINDOW_MINUTES"
    SETUP_WINDOW_OPENED=true
    ok "Ports 8000 and 6001 are open for $SETUP_WINDOW_MINUTES minutes, then close by themselves"
    done_item "Setup window: 8000 and 6001 open until $(date -d "+$SETUP_WINDOW_MINUTES min" '+%H:%M'), then closed automatically"
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

${C_BOLD}Next steps in the Cloudflare dashboard${C_RESET} (details in README.md, "Cloudflare mode"):
  1. Your tunnel, Routes (Public hostnames), add these in this order:
       $DASHBOARD_HOST   path ^/app/         ->  HTTP  127.0.0.1:6001
       $DASHBOARD_HOST   path ^/terminal/ws  ->  HTTP  127.0.0.1:6002
       $DASHBOARD_HOST   (no path)           ->  HTTP  127.0.0.1:8000
       ssh.$base         (no path)           ->  SSH   127.0.0.1:22
       *.$base           (no path)           ->  HTTP  127.0.0.1:80
  2. Zero Trust, Access, Applications: protect $DASHBOARD_HOST and ssh.$base
     (browser rendering: SSH) with your email, and also *.$base.

${C_BOLD}Then in your browser:${C_RESET}
  3. Open https://$DASHBOARD_HOST and log in with:
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
  4. Change that password at once, then turn on two-factor login (Profile).
  5. Settings: URL https://$DASHBOARD_HOST, "Redirect HTTP to HTTPS" Disabled.
  6. Delete the saved password:  sudo rm $FIRST_LOGIN_FILE

SSH in the browser: https://ssh.$base, then your Ubuntu user name and password.
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

If time runs out, open the window again with:  sudo docker-port-guard open-setup 30
Check the server any time with:                sudo bash check.sh
EOF
    else
        printf '\nDashboard: https://%s\n' "$DASHBOARD_HOST"
        printf 'If you ever need the first-login window again: sudo docker-port-guard open-setup 30\n'
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
    open_setup_window
    print_summary
    if [ "$CF_RESTART_AT_END" = true ]; then
        printf '\nRestarting the tunnel with the new settings now. A browser SSH session through\nthe tunnel drops; open it again in a few seconds.\n'
        systemctl restart --no-block cloudflared.service
    fi
}

main "$@"
