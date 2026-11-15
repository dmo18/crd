#!/usr/bin/env bash
#
# check.sh: read-only health and security check for the Coolify server.
# It changes nothing. Run it any time from the server console:
#   sudo bash check.sh
#
# Each line starts with PASS (fine), WARN (look at it) or FAIL (fix it).

set -uo pipefail

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

if [ -t 1 ]; then
    C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
    C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi

section() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  %sPASS%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); printf '  %sWARN%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  %sFAIL%s %s\n' "$C_RED" "$C_RESET" "$*"; }
note() { printf '       %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -ne 0 ]; then
    echo "Please run with sudo: sudo bash check.sh"
    exit 2
fi

printf '%sServer check, %s%s\n' "$C_BOLD" "$(date '+%Y-%m-%d %H:%M')" "$C_RESET"

# ---------------------------------------------------------------------------
section "Firewall (ufw)"
if have ufw; then
    ufw_out="$(ufw status verbose 2>/dev/null)"
    if grep -q '^Status: active' <<<"$ufw_out"; then
        pass "Firewall is on"
    else
        fail "Firewall is OFF. Turn it on: sudo ufw --force enable"
    fi
    if grep -q 'deny (incoming)' <<<"$ufw_out"; then
        pass "Incoming traffic is blocked unless allowed"
    else
        fail "Incoming traffic is not blocked by default"
    fi
    # Rules that allow traffic from Anywhere, other than web ports.
    open_rules="$(ufw status 2>/dev/null | awk '/ALLOW/ && /Anywhere/' | grep -vE '^(80|443)(/(tcp|udp))?( \(v6\))?[[:space:]]' || true)"
    if [ -z "$open_rules" ]; then
        pass "From the internet only web ports (80, 443) are allowed"
    else
        warn "These firewall rules allow more than web traffic from anywhere:"
        while IFS= read -r line; do note "$line"; done <<<"$open_rules"
    fi
    if ufw status 2>/dev/null | grep -E '^22(/tcp)?[[:space:]]' | grep -q 'DENY IN'; then
        pass "SSH (22) is refused on the internet network card"
    else
        warn "No rule refusing SSH on the internet network card"
    fi
else
    fail "ufw is not installed"
fi

# ---------------------------------------------------------------------------
section "Container ports (docker-port-guard)"
if have iptables && iptables -w -S PORT-GUARD >/dev/null 2>&1; then
    first="$(iptables -w -S DOCKER-USER 2>/dev/null | sed -n '2p')"
    if [ "$first" = "-A DOCKER-USER -j PORT-GUARD" ]; then
        pass "Docker's DOCKER-USER chain sends traffic through the port guard first"
    else
        fail "The port guard is not the first rule in DOCKER-USER. Fix: sudo docker-port-guard apply"
    fi
    if iptables -w -S PORT-GUARD | tail -n 1 | grep -qx -- '-A PORT-GUARD -j DROP'; then
        pass "Container ports other than the allowed ones are blocked from the internet"
    else
        fail "The port guard does not end with a block rule. Fix: sudo docker-port-guard apply"
    fi
    allowed="$(iptables -w -S PORT-GUARD | sed -n 's/.*-p \([a-z]*\) .*--ctorigdstport \([0-9]*\) .*/\2\/\1/p' | tr '\n' ' ')"
    note "Ports open to the internet for containers: ${allowed:-none}"
    if [[ " $allowed " == *" 8000/tcp "* ]]; then
        if [ -r /run/docker-port-guard/setup-window-until ]; then
            until="$(cat /run/docker-port-guard/setup-window-until)"
            warn "First-login window is OPEN (port 8000 and 6001) until $(date -d "@$until" '+%H:%M'). Close it: sudo docker-port-guard close"
        else
            warn "Port 8000 is open to the internet"
        fi
    else
        pass "Coolify dashboard ports 8000, 6001, 6002 are closed to the internet"
    fi
    if [ -s /proc/net/if_inet6 ] && have ip6tables; then
        if ip6tables -w -S DOCKER-USER 2>/dev/null | sed -n '2p' | grep -qx -- '-A DOCKER-USER -j PORT-GUARD'; then
            pass "Same protection for IPv6"
        else
            warn "IPv6 is on but the IPv6 port guard is missing. Fix: sudo docker-port-guard apply"
        fi
    fi
else
    fail "The port guard rules are missing. Fix: sudo systemctl restart docker-port-guard"
fi
if systemctl is-enabled --quiet docker-port-guard.service 2>/dev/null; then
    pass "Port guard starts automatically at boot"
else
    fail "Port guard is not set to start at boot. Fix: sudo systemctl enable docker-port-guard"
fi

# ---------------------------------------------------------------------------
section "Listening ports (programs waiting for connections)"
if have ss; then
    while read -r proto _ _ local_addr _ process; do
        name="$(sed -n 's/.*(("\([^"]*\)".*/\1/p' <<<"$process")"
        case "$local_addr" in
            127.* | \[::1\]:* | \[::ffff:127.*) where="this server only" ;;
            *) where="all networks" ;;
        esac
        note "$(printf '%-4s %-28s %-18s %s' "$proto" "$local_addr" "${name:-?}" "$where")"
    done < <(ss -H -tulpn 2>/dev/null)
    note "Ports on 'all networks' are still filtered by the firewall and the port guard above."
else
    warn "Cannot list ports (ss missing)"
fi

# ---------------------------------------------------------------------------
section "SSH"
if have sshd; then
    sshd_out="$(sshd -T 2>/dev/null || true)"
    if [ -z "$sshd_out" ]; then
        warn "Could not read the SSH settings"
    else
        val() { awk -v k="$1" '$1 == k { print $2; exit }' <<<"$sshd_out"; }
        if [ "$(val passwordauthentication)" = "no" ]; then pass "Password login over SSH is off"; else fail "Password login over SSH is ON"; fi
        if [ "$(val kbdinteractiveauthentication)" = "no" ]; then pass "Keyboard-interactive login is off"; else fail "Keyboard-interactive login is ON"; fi
        case "$(val permitrootlogin)" in
            without-password | prohibit-password) pass "Root may log in only with a key (Coolify uses this)" ;;
            no) warn "Root login is off; Coolify cannot manage this server" ;;
            *) fail "Root may log in with a password" ;;
        esac
        mat="$(val maxauthtries)"
        if [ "${mat:-99}" -le 3 ]; then pass "At most $mat login tries per connection"; else warn "MaxAuthTries is ${mat:-unknown} (3 expected)"; fi
    fi
else
    warn "OpenSSH server not installed (Coolify needs it to manage this server)"
fi

# ---------------------------------------------------------------------------
section "Automatic security updates"
if systemctl is-enabled --quiet unattended-upgrades.service 2>/dev/null; then
    pass "Automatic updates service is on"
else
    fail "Automatic updates service is off"
fi
apt_dump="$(apt-config dump 2>/dev/null)"
if grep -q '^APT::Periodic::Unattended-Upgrade "1";' <<<"$apt_dump"; then
    pass "Updates install daily"
else
    fail "Daily automatic updates are not switched on"
fi
if grep -q '^Unattended-Upgrade::Automatic-Reboot "true";' <<<"$apt_dump"; then
    rt="$(sed -n 's/^Unattended-Upgrade::Automatic-Reboot-Time "\(.*\)";/\1/p' <<<"$apt_dump")"
    pass "Restart after updates when needed, at ${rt:-the default time}"
else
    warn "No automatic restart after updates that need one"
fi
if [ -f /var/run/reboot-required ]; then
    warn "A restart is waiting (it will happen at the planned time)"
fi

# ---------------------------------------------------------------------------
section "fail2ban"
if systemctl is-active --quiet fail2ban.service 2>/dev/null; then
    pass "fail2ban is running"
    if f2b="$(fail2ban-client status sshd 2>/dev/null)"; then
        banned="$(awk -F': *' '/Currently banned/ { print $2 }' <<<"$f2b")"
        pass "SSH protection active (addresses banned right now: ${banned:-0})"
    else
        warn "fail2ban runs but the SSH protection (sshd jail) is not active"
    fi
else
    fail "fail2ban is not running"
fi

# ---------------------------------------------------------------------------
section "Disk and memory"
disk_pct="$(df -P / | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
disk_free="$(df -Ph / | awk 'NR == 2 { print $4 }')"
if [ "$disk_pct" -lt 80 ]; then
    pass "Disk ${disk_pct}% used, $disk_free free"
elif [ "$disk_pct" -lt 90 ]; then
    warn "Disk ${disk_pct}% used, $disk_free free. Clean up soon (Coolify: Servers > Cleanup)."
else
    fail "Disk ${disk_pct}% used, only $disk_free free"
fi
mem_avail_mb="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)"
mem_total_mb="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
if [ "$mem_avail_mb" -ge 300 ]; then
    pass "Memory: $mem_avail_mb MB free of $mem_total_mb MB"
else
    warn "Memory is low: $mem_avail_mb MB free of $mem_total_mb MB"
fi
if [ -n "$(swapon --noheadings --show 2>/dev/null)" ]; then
    pass "Swap is on (swappiness $(cat /proc/sys/vm/swappiness))"
else
    warn "No swap"
fi

# ---------------------------------------------------------------------------
section "Coolify"
if have docker && docker info >/dev/null 2>&1; then
    pass "Docker is running"
    for c in coolify coolify-db coolify-redis; do
        state="$(docker inspect -f '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}' "$c" 2>/dev/null || true)"
        case "$state" in
            "running" | "running (healthy)") pass "$c is running" ;;
            "") fail "$c container not found" ;;
            *) fail "$c is $state" ;;
        esac
    done
    state="$(docker inspect -f '{{.State.Status}}' coolify-proxy 2>/dev/null || true)"
    if [ "$state" = "running" ]; then
        pass "coolify-proxy (Traefik, serves your websites) is running"
    else
        warn "coolify-proxy is not running (normal before the first-time setup in Coolify is finished)"
    fi
else
    fail "Docker is not running"
fi

# ---------------------------------------------------------------------------
printf '\n%sResult:%s %s PASS, %s WARN, %s FAIL\n' "$C_BOLD" "$C_RESET" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
fi
exit 0
