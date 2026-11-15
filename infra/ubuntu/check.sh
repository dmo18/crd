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

# direct: this server answers 80/443 itself. cloudflare: everything comes in
# through the Cloudflare Tunnel and nothing is open to the internet.
MODE="direct"
if [ -r /etc/default/docker-port-guard ]; then
    m="$(sed -n 's/^MODE="\{0,1\}\([a-z]*\)"\{0,1\}[[:space:]]*$/\1/p' /etc/default/docker-port-guard | tail -n 1)"
    if [ -n "$m" ]; then MODE="$m"; fi
fi
readonly CF_METRICS="127.0.0.1:20241"
readonly CF_TOKEN_FILE="/etc/cloudflared/tunnel-token"

printf '%sServer check, %s%s\n' "$C_BOLD" "$(date '+%Y-%m-%d %H:%M')" "$C_RESET"
if [ "$MODE" = cloudflare ]; then
    printf 'Mode: Cloudflare Tunnel (nothing should be open to the internet)\n'
else
    printf 'Mode: direct (only web ports 80 and 443 open to the internet)\n'
fi

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
    if [ "$MODE" = cloudflare ]; then
        web_rules="$(ufw status 2>/dev/null | awk '/ALLOW/' | grep -E '^(80|443)(/(tcp|udp))?( \(v6\))?[[:space:]]' || true)"
        if [ -z "$web_rules" ]; then
            pass "No web ports (80, 443) are open in the firewall"
        else
            fail "The firewall still lets the internet reach web ports. Fix: sudo bash bootstrap.sh --cloudflare <dashboard-address>"
            while IFS= read -r line; do note "$line"; done <<<"$web_rules"
        fi
        open_rules="$(ufw status 2>/dev/null | awk '/ALLOW/ && /Anywhere/' || true)"
        if [ -z "$open_rules" ]; then
            pass "Nothing from the internet is allowed in"
        else
            warn "These firewall rules allow traffic from anywhere:"
            while IFS= read -r line; do note "$line"; done <<<"$open_rules"
        fi
        if iptables -w -S ufw-before-input 2>/dev/null | grep -qx -- '-A ufw-before-input -i lo -j ACCEPT'; then
            pass "This server may connect to itself (the tunnel needs that)"
        else
            fail "The firewall blocks this server's own connections (loopback), so the tunnel cannot reach Coolify"
        fi
    else
        # Rules that allow traffic from Anywhere, other than web ports.
        open_rules="$(ufw status 2>/dev/null | awk '/ALLOW/ && /Anywhere/' | grep -vE '^(80|443)(/(tcp|udp))?( \(v6\))?[[:space:]]' || true)"
        if [ -z "$open_rules" ]; then
            pass "From the internet only web ports (80, 443) are allowed"
        else
            warn "These firewall rules allow more than web traffic from anywhere:"
            while IFS= read -r line; do note "$line"; done <<<"$open_rules"
        fi
    fi
    if ufw status 2>/dev/null | grep -qE '^22(/tcp)? on [^ ]+ +DENY'; then
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
    if [ "$MODE" = cloudflare ]; then
        if [ -z "${allowed// /}" ]; then
            pass "No container port is open to the internet (Cloudflare mode)"
        else
            warn "In Cloudflare mode no container port should be open, but these are: $allowed (see EXTRA_ALLOWED in /etc/default/docker-port-guard)"
        fi
    fi
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
    unexpected=""
    while read -r proto _ _ _ local_addr _ process; do
        name="$(sed -n 's/.*(("\([^"]*\)".*/\1/p' <<<"$process")"
        case "$local_addr" in
            127.* | \[::1\]:* | \[::ffff:127.*) where="this server only" ;;
            *)
                where="all networks"
                if [ "$proto" = tcp ]; then
                    case "${name:-?}:${local_addr##*:}" in
                        docker-proxy:*) where="all networks, container port (port guard)" ;;
                        sshd:22 | systemd:22) where="all networks, SSH (firewall: Docker networks only)" ;;
                        *) unexpected="$unexpected ${local_addr}(${name:-?})" ;;
                    esac
                fi
                ;;
        esac
        note "$(printf '%-4s %-28s %-18s %s' "$proto" "$local_addr" "${name:-?}" "$where")"
    done < <(ss -H -tulpn 2>/dev/null)
    note "Ports on 'all networks' are still filtered by the firewall and the port guard above."
    if [ "$MODE" = cloudflare ]; then
        if [ -z "$unexpected" ]; then
            pass "No program listens on a public address except Docker's (blocked by the port guard) and SSH (firewalled)"
        else
            warn "These programs listen on a public address (the firewall still blocks them):$unexpected"
        fi
    fi
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
        if [ "$MODE" = cloudflare ]; then
            # Password login only for connections from this server (Cloudflare's
            # browser SSH terminal arrives through the tunnel from 127.0.0.1 or ::1).
            match_val() { sshd -T -C "addr=$1,user=$2,host=localhost,laddr=127.0.0.1,lport=22" 2>/dev/null | awk -v k="$3" '$1 == k { print $2; exit }'; }
            if [ "$(match_val 127.0.0.1 check passwordauthentication)" = yes ] && [ "$(match_val ::1 check passwordauthentication)" = yes ]; then
                pass "Password login allowed for the browser SSH terminal through the tunnel"
            else
                warn "Password login through the tunnel is off: Cloudflare's browser SSH terminal can then only use a key"
            fi
            if [ "$(match_val 203.0.113.9 check passwordauthentication)" = no ]; then
                pass "Password login refused for any other address"
            else
                fail "Password login is allowed from other addresses"
            fi
            case "$(match_val 127.0.0.1 root permitrootlogin)" in
                without-password | prohibit-password | no) pass "Root may not log in with a password, even through the tunnel" ;;
                *) fail "Root may log in with a password through the tunnel" ;;
            esac
        fi
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
if [ "$MODE" = cloudflare ]; then
    section "Cloudflare Tunnel (cloudflared)"
    if systemctl is-active --quiet cloudflared.service 2>/dev/null; then
        pass "cloudflared is running"
    else
        fail "cloudflared is not running ($(systemctl is-active cloudflared.service 2>/dev/null)). See: sudo journalctl -u cloudflared -n 50"
    fi
    if systemctl is-enabled --quiet cloudflared.service 2>/dev/null; then
        pass "cloudflared starts automatically at boot"
    else
        fail "cloudflared does not start at boot. Fix: sudo systemctl enable --now cloudflared"
    fi
    # "cloudflared tunnel info" needs a Cloudflare login on the server, which this
    # setup does not have; cloudflared's local ready page reports the connections.
    ready="$(curl -fsS --max-time 3 "http://$CF_METRICS/ready" 2>/dev/null || true)"
    conns="$(sed -n 's/.*"readyConnections":\([0-9]*\).*/\1/p' <<<"$ready")"
    if [ "${conns:-0}" -gt 0 ]; then
        pass "Tunnel connected to Cloudflare ($conns connections)"
    else
        inv="$(systemctl show -p InvocationID --value cloudflared.service 2>/dev/null || true)"
        registered=0
        if [ -n "$inv" ]; then
            registered="$(journalctl -q --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null | grep -c 'Registered tunnel connection' || true)"
        fi
        if [ "${registered:-0}" -gt 0 ]; then
            warn "The ready page does not answer, but the log shows $registered tunnel connections since cloudflared started"
        else
            fail "The tunnel is not connected to Cloudflare. Check the token and see: sudo journalctl -u cloudflared -n 50"
        fi
    fi
    if [ -f "$CF_TOKEN_FILE" ]; then
        perm="$(stat -c '%a %U %G' "$CF_TOKEN_FILE" 2>/dev/null)"
        dperm="$(stat -c '%a %U' "$(dirname "$CF_TOKEN_FILE")" 2>/dev/null)"
        if [ "$perm" = "600 root root" ] && [ "$dperm" = "700 root" ]; then
            pass "Tunnel token is readable only by root"
        else
            fail "Tunnel token file permissions are $perm (folder $dperm). Fix: sudo chmod 700 $(dirname "$CF_TOKEN_FILE") && sudo chmod 600 $CF_TOKEN_FILE"
        fi
    else
        fail "Tunnel token file $CF_TOKEN_FILE is missing"
    fi
    if systemctl cat cloudflared.service 2>/dev/null | grep -qE -- '--token[ =]|TUNNEL_TOKEN=|eyJ'; then
        fail "The cloudflared service settings contain the token itself, which other users can read"
    else
        pass "The token is not in the service settings"
    fi
    if apt-cache policy cloudflared 2>/dev/null | grep -q 'pkg.cloudflare.com/cloudflared'; then
        pass "cloudflared comes from Cloudflare's signed package repository"
    else
        warn "cloudflared is not installed from Cloudflare's package repository"
    fi
    if apt-config dump 2>/dev/null | grep -q 'origin=cloudflared'; then
        pass "cloudflared updates are installed automatically"
    else
        warn "cloudflared is not part of the automatic updates"
    fi
fi

# ---------------------------------------------------------------------------
section "Automatic updates"
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
for timer in apt-daily.timer apt-daily-upgrade.timer; do
    if systemctl is-enabled --quiet "$timer" 2>/dev/null; then
        pass "$timer is on (next: $(systemctl show -p NextElapseUSecRealtime --value "$timer" 2>/dev/null || echo unknown))"
    else
        fail "$timer is off. Fix: sudo systemctl enable --now $timer"
    fi
done
for origin in '-security' '-updates' 'origin=Docker,label=Docker CE'; do
    if grep -qF -- "$origin" <<<"$(apt-config dump 2>/dev/null | grep -E '^Unattended-Upgrade::(Allowed-Origins|Origins-Pattern)')"; then
        pass "Automatic updates include: $origin"
    else
        warn "Automatic updates do not include: $origin (run bootstrap.sh again)"
    fi
done
uu_log="/var/log/unattended-upgrades/unattended-upgrades.log"
if [ -s "$uu_log" ]; then
    last_run="$(grep -m1 -o '^[0-9-]* [0-9:]*' <(tac "$uu_log" | grep 'Starting unattended upgrades script') 2>/dev/null || true)"
    note "Last automatic update run: ${last_run:-not found in $uu_log}"
else
    last_run=""
    warn "Automatic updates have not run yet (no $uu_log)"
fi
upgradable="$(apt list --upgradable 2>/dev/null | grep -v '^Listing' || true)"
pending="$(grep -c . <<<"$upgradable" || true)"
[ -z "$upgradable" ] && pending=0
sec_pkgs="$(grep -- '-security' <<<"$upgradable" | cut -d/ -f1 | tr '\n' ' ' || true)"
note "Updates waiting: $pending (security: $(wc -w <<<"$sec_pkgs" | tr -d ' '))"
# A security update older than 3 days is one the daily run should have installed:
# it is in a run's "to upgrade" or "kept back" list from more than 3 days ago, or
# automatic updates have not run for 3 days.
if [ -n "${sec_pkgs// /}" ]; then
    cutoff="$(date -d '3 days ago' '+%Y-%m-%d %H:%M:%S')"
    old=""
    for pkg in $sec_pkgs; do
        first="$(zcat -f "$uu_log"* 2>/dev/null | grep -E "(Packages that will be upgraded|kept back)" | grep -E "[: ]${pkg}( |$)" | cut -c1-19 | sort | head -n 1)"
        if [ -n "$first" ] && [[ $first < $cutoff ]]; then old="$old $pkg"; fi
    done
    if [ -n "$old" ]; then
        warn "Security updates waiting for more than 3 days:$old. See: sudo cat $uu_log"
    elif [ -z "$last_run" ] || [[ $last_run < $cutoff ]]; then
        warn "Security updates are waiting and automatic updates have not run for 3 days: $sec_pkgs"
    else
        pass "Waiting security updates are new; the next daily run installs them"
    fi
else
    pass "No security updates waiting"
fi
for pkg in docker-ce cloudflared; do
    pol="$(apt-cache policy "$pkg" 2>/dev/null)"
    inst="$(awk '/Installed:/ {print $2; exit}' <<<"$pol")"
    cand="$(awk '/Candidate:/ {print $2; exit}' <<<"$pol")"
    if [ -z "$inst" ] || [ "$inst" = "(none)" ]; then
        if [ "$pkg" = cloudflared ] && [ "$MODE" != cloudflare ]; then continue; fi
        note "$pkg: not installed"
    elif [ "$inst" = "$cand" ]; then
        pass "$pkg $inst is the newest version"
    else
        note "$pkg: installed $inst, newest $cand (installs with the next daily run)"
    fi
done
if [ -f /var/run/reboot-required ]; then
    warn "A restart is waiting (it will happen at the planned time, 04:30)"
else
    pass "No restart needed"
fi

# ---------------------------------------------------------------------------
section "fail2ban"
if systemctl is-active --quiet fail2ban.service 2>/dev/null; then
    pass "fail2ban is running"
    if f2b="$(fail2ban-client status sshd 2>/dev/null)"; then
        banned="$(awk -F':' '/Currently banned/ { gsub(/[[:space:]]/, "", $2); print $2 }' <<<"$f2b")"
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
        state="$(docker container inspect -f '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}' "$c" 2>/dev/null || true)"
        case "$state" in
            "running" | "running (healthy)") pass "$c is running" ;;
            "") fail "$c container not found" ;;
            *) fail "$c has a problem: $state (see: sudo docker logs $c)" ;;
        esac
    done
    state="$(docker container inspect -f '{{.State.Status}}' coolify-proxy 2>/dev/null || true)"
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
