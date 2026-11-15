#!/usr/bin/env bash
#
# bootstrap.sh: prepare a fresh Ubuntu 24.04 LTS server for Coolify v4.
#
# Usage (from the server console, as the user created during Ubuntu install):
#   sudo bash bootstrap.sh admin.example.com [you@example.com]
#   sudo bash bootstrap.sh --dry-run admin.example.com      (only print what would change)
#
# What it does, in order:
#   1. Preflight checks (Ubuntu 24.04, root, CPU/RAM/disk, internet).
#   2. Updates the system and installs: ufw, fail2ban, unattended-upgrades, curl,
#      ca-certificates, jq, openssh-server, python3-systemd.
#   3. Automatic security updates, with a reboot at 04:30 only when one is required.
#   4. A 2 GB swap file if the server has no swap, and vm.swappiness=10.
#   5. SSH hardening: keys only, root only with a key (Coolify needs that), 3 tries.
#   6. Firewall (ufw): only 80/tcp, 443/tcp and 443/udp from the internet. SSH (22)
#      only from Docker's private networks, so Coolify can manage this server.
#   7. docker-port-guard: Docker skips ufw for container ports, so a separate rule
#      set in the iptables DOCKER-USER chain blocks every container port from the
#      internet except 80/443 (Coolify's Traefik proxy). This covers Coolify's
#      8000/6001/6002 and Traefik's own 8080.
#   8. fail2ban for SSH.
#   9. Coolify, with its official installer and an admin account created up front.
#  10. A 30 minute "setup window" on ports 8000 and 6001 so the owner can do the
#      first login from a browser. It closes by itself.
#
# Safe to run again: every step checks the current state first. Coolify is only
# installed once; after that it updates itself.

set -euo pipefail
umask 022

readonly SCRIPT_VERSION="1.0.0"
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

DRY_RUN=false
ASSUME_YES=false
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

# Ask a yes/no question on the console. Default is "no".
ask_yes_no() {
    local answer=""
    if [ "$ASSUME_YES" = true ]; then
        return 0
    fi
    if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
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

    detect_network
    if [ -n "$PUBLIC_IF" ]; then ok "Internet connection on network card '$PUBLIC_IF', address $PUBLIC_IP"; else warn "Could not find the default network card"; fi

    local resolved
    resolved="$(getent ahostsv4 "$DASHBOARD_HOST" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
    if [ -n "$resolved" ] && [[ " $resolved " == *" $PUBLIC_IP "* ]]; then
        ok "$DASHBOARD_HOST points to this server"
    else
        warn "$DASHBOARD_HOST does not point to this server yet (it points to: ${resolved:-nothing})."
        warn "Add a DNS 'A' record: $DASHBOARD_HOST -> $PUBLIC_IP. HTTPS will only work after that."
    fi

    if ! coolify_installed; then
        if [ -z "$ADMIN_EMAIL" ]; then
            if [ -r /dev/tty ] && [ -w /dev/tty ] && [ "$DRY_RUN" = false ]; then
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
    done_item "System updated; ufw, fail2ban, unattended-upgrades, curl, jq installed"
}

# ---------------------------------------------------------------------------
# 3. Automatic security updates
# ---------------------------------------------------------------------------
configure_unattended_upgrades() {
    step "Turning on automatic security updates"
    write_file "$UU_PERIODIC" 0644 <<'EOF'
// Written by bootstrap.sh: check for and install updates every day.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
    write_file "$UU_LOCAL" 0644 <<'EOF'
// Written by bootstrap.sh. Ubuntu's defaults already install security updates;
// this adds a restart at a quiet time, only when an update needs one.
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
    ok "Security updates install daily; restart at 04:30 ($tz) only when needed"
    done_item "Automatic security updates on (restart at 04:30 $tz only when required)"
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
    write_file "$SSHD_DROPIN" 0644 <<'EOF'
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
    ok "SSH: keys only, root only with a key, 3 tries per connection"
    warn "Password login over SSH is now OFF. Use the Hyper-V console to log in, as before."
    done_item "SSH hardened (passwords off, root by key only, 3 tries)"
}

# ---------------------------------------------------------------------------
# 6. Firewall (ufw)
# ---------------------------------------------------------------------------
configure_ufw() {
    step "Setting up the firewall (ufw)"
    local range iface
    run ufw default deny incoming
    run ufw default allow outgoing
    run ufw allow 80/tcp comment 'web (HTTP, certificates)'
    run ufw allow 443/tcp comment 'web (HTTPS)'
    run ufw allow 443/udp comment 'web (HTTP/3)'
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
    ok "Firewall on: from the internet only 80/tcp, 443/tcp, 443/udp"
    done_item "Firewall (ufw) on: internet may reach only 80/tcp, 443/tcp, 443/udp; SSH only from Docker networks"
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
#   - extra ports listed in /etc/default/docker-port-guard (EXTRA_ALLOWED),
#   - during the setup window only: Coolify's 8000 and 6001,
# and drops everything else that comes from outside. That blocks Coolify's
# 8000/6001/6002 and Traefik's 8080 from the internet.
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

# Test hooks: let a test point the script at other files.
CONFIG="${DPG_CONFIG:-$CONFIG}"
STATE_DIR="${DPG_STATE_DIR:-$STATE_DIR}"
WINDOW_FILE="$STATE_DIR/setup-window-until"

if [ -r "$CONFIG" ]; then
    # shellcheck source=/dev/null
    . "$CONFIG"
fi

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
    local until
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

install_guard() {
    step "Blocking container ports from the internet (docker-port-guard)"
    guard_script | write_file "$GUARD_BIN" 0755
    if [ -f "$GUARD_CONFIG" ]; then
        ok "Keeping your existing $GUARD_CONFIG"
    else
        write_file "$GUARD_CONFIG" 0644 <<'EOF'
# Settings for docker-port-guard (written by bootstrap.sh; your changes are kept).
#
# Container ports that may be reached from the internet IN ADDITION to
# 80/tcp, 443/tcp and 443/udp, which are always allowed. Separate with spaces.
# Example: EXTRA_ALLOWED="tcp/5432"
# After a change run: sudo docker-port-guard apply
EXTRA_ALLOWED=""
EOF
    fi
    # Runs BEFORE Docker at boot, so the rules are in place before any container
    # starts. Docker keeps an existing DOCKER-USER chain as it is.
    write_file "$GUARD_UNIT" 0644 <<EOF
[Unit]
Description=Keep Docker container ports off the internet (except 80/443)
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
    ok "Only 80/443 of containers can be reached from the internet"
    done_item "docker-port-guard on: container ports other than 80/443 blocked from the internet (8000, 6001, 6002, 8080 included)"
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
# 9. Coolify
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
    WORKDIR="$(mktemp -d)"
    chmod 700 "$WORKDIR"
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
                echo "Address:  http://$PUBLIC_IP:8000  (only during the setup window)"
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
# 10. First login window
# ---------------------------------------------------------------------------
dashboard_on_https() {
    # Ask Traefik on this server for the dashboard, with a valid certificate.
    curl -fsS --max-time 8 --resolve "$DASHBOARD_HOST:443:127.0.0.1" \
        -o /dev/null "https://$DASHBOARD_HOST/api/health" 2>/dev/null
}

open_setup_window() {
    step "First-time setup window"
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
print_summary() {
    local item closes
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
    install_coolify
    open_setup_window
    print_summary
}

main "$@"
