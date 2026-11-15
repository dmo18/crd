#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016  # test style: cmd && ok || bad, remote commands in single quotes
# Disaster recovery test with the REAL Coolify installer (in containers only).
# Server A: real Coolify + Card Vault stand-in, backed up over SFTP.
# Server B: a second, fresh real Coolify install (other APP_KEY, other admin
# password), then restore-dr, then checks that B now runs A's Coolify.
#
# Needs: tests/images/build.sh done, sbdest running (tests/e2e.sh starts it),
# the Coolify installer at $COOLIFY_INSTALLER, and for sandboxes without direct
# internet: PROXY_URL (HTTPS proxy reachable from the test network, its CA in
# PROXY_CA) and REGISTRY_MIRROR (Docker Hub mirror). Coolify's own images are
# pulled from ghcr.io.
#
# Known gap in sandboxes without IPv6: Coolify's nginx cannot listen on [::],
# so the web UI and its health check stay down. Database, migrations, APP_KEY
# decryption, SSH access and container recreation are still real and checked.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOL="$HERE/../server-backup"
COOLIFY_INSTALLER="${COOLIFY_INSTALLER:?path to Coolify install.sh}"
IMAGES_TAR="${IMAGES_TAR:?tar with sb-cardvault}"
LOG_DIR="${LOG_DIR:-/tmp/sb-e2e-logs}"
NET=sbnet DEST=sbdest A=sbRA B=sbRB
mkdir -p "$LOG_DIR"
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
expect() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
in_() { local c=$1; shift; docker exec -i "$c" bash -c "$*"; }
tinker() { in_ "$1" "docker exec coolify php artisan tinker --execute=\"$2\" 2>/dev/null | tail -n 1"; }

make_real() { # make_real NAME HOSTNAME ADMIN_PASSWORD
    local n=$1 h=$2 pw=$3
    docker rm -f "$n" >/dev/null 2>&1 || true
    docker volume rm "$n-docker" "$n-containerd" >/dev/null 2>&1 || true
    docker run -d --privileged --name "$n" --hostname "$h" --network "$NET" \
        -v "$n-docker:/var/lib/docker" -v "$n-containerd:/var/lib/containerd" sb-node /sbin/init >/dev/null
    for _ in $(seq 60); do docker exec "$n" docker info >/dev/null 2>&1 && break; sleep 1; done
    if [[ -n ${PROXY_URL:-} ]]; then
        docker cp "$PROXY_CA" "$n:/usr/local/share/ca-certificates/proxy.crt"
        in_ "$n" "update-ca-certificates >/dev/null 2>&1
printf 'Acquire::https::CaInfo \"/usr/local/share/ca-certificates/proxy.crt\";\nAcquire::https::Proxy \"$PROXY_URL\";\n' >/etc/apt/apt.conf.d/99proxy
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nEnvironment=HTTPS_PROXY=$PROXY_URL NO_PROXY=localhost,127.0.0.1\n' >/etc/systemd/system/docker.service.d/proxy.conf"
    fi
    [[ -n ${REGISTRY_MIRROR:-} ]] && in_ "$n" "echo '{\"registry-mirrors\": [\"$REGISTRY_MIRROR\"]}' >/etc/docker/daemon.json"
    in_ "$n" 'systemctl daemon-reload; systemctl restart docker; systemctl enable --now ssh >/dev/null 2>&1'
    docker cp "$COOLIFY_INSTALLER" "$n:/root/coolify-install.sh"
    in_ "$n" "export https_proxy=${PROXY_URL:-} HTTPS_PROXY=${PROXY_URL:-} no_proxy=localhost,127.0.0.1 REGISTRY_URL=ghcr.io \
        ROOT_USERNAME=admin ROOT_USER_EMAIL=owner@example.com ROOT_USER_PASSWORD='$pw'
        timeout 1500 bash /root/coolify-install.sh >/root/coolify-install.log 2>&1 || true"
    in_ "$n" "docker exec coolify-db pg_isready -q && docker exec coolify php artisan migrate:status >/dev/null" ||
        { echo "Coolify did not install on $n, see /root/coolify-install.log there"; exit 1; }
    docker exec -i "$n" docker load -q <"$IMAGES_TAR" >/dev/null
    docker cp "$TOOL" "$n:/usr/local/sbin/server-backup"
}

path="sb-real-$RANDOM"
echo "--- server A: real Coolify"
make_real "$A" real-a 'Old-Server-Passw0rd'
in_ "$A" 'docker volume create --label coolify.managed=true abc123_cardvault-data >/dev/null
docker run -d --name cardvault-abc123 --network coolify --label coolify.managed=true --label com.docker.compose.service=cardvault -v abc123_cardvault-data:/data sb-cardvault >/dev/null
mkdir -p /etc/cloudflared && echo TOKEN-A >/etc/cloudflared/tunnel-token
ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/backup_key'
docker exec "$A" cat /root/.ssh/backup_key.pub | docker exec -i "$DEST" bash -c 'mkdir -p /home/bk/.ssh && cat >>/home/bk/.ssh/authorized_keys && chown -R bk:bk /home/bk/.ssh && chmod 600 /home/bk/.ssh/authorized_keys'
in_ "$A" "docker exec coolify-db psql -U coolify -d coolify -qc \"insert into projects (uuid, name, team_id, created_at, updated_at) values ('proj-from-a', 'Project made on A', 0, now(), now())\""
tinker "$A" 'echo md5(App\\Models\\PrivateKey::first()->private_key);' >"$LOG_DIR/real-key-a.txt"
in_ "$A" 'grep -E "^(APP_KEY|DB_PASSWORD|REDIS_PASSWORD)=" /data/coolify/source/.env' >"$LOG_DIR/real-env-a.txt"
in_ "$A" 'docker exec coolify-db psql -U coolify -d coolify -tAc "select count(*) from migrations"' >"$LOG_DIR/real-mig-a.txt"
sleep 5

printf '1\n%s\n22\nbk\n%s\n1\n/root/.ssh/backup_key\ny\nSAVED\nn\n' "$DEST" "$path" | docker exec -i "$A" server-backup setup >"$LOG_DIR/real-setup.log" 2>&1 && ok "setup on real Coolify" || bad "setup"
pw="$(grep -oE '[a-z2-9]{5}(-[a-z2-9]{5}){5}' "$LOG_DIR/real-setup.log" | head -n 1)"
in_ "$A" 'server-backup run' >"$LOG_DIR/real-run.log" 2>&1 && ok "run on real Coolify" || bad "run (see $LOG_DIR/real-run.log)"
expect "manifest names the real Coolify version" grep -q 'Coolify version: 4\.' "$LOG_DIR/real-run.log"

echo "--- server B: fresh real Coolify, then restore-dr"
make_real "$B" real-b 'New-Server-Passw0rd'
docker cp "$A:/root/.ssh/backup_key" - | docker cp - "$B:/root/.ssh/"
expect "B starts with a different APP_KEY" bash -c "! diff <(docker exec $B grep ^APP_KEY= /data/coolify/source/.env) <(grep ^APP_KEY= '$LOG_DIR/real-env-a.txt')"
printf '1\n%s\n22\nbk\n%s\n1\n/root/.ssh/backup_key\ny\n%s\nRESTORE\n' "$DEST" "$path" "$pw" | docker exec -i "$B" server-backup restore-dr >"$LOG_DIR/real-dr.log" 2>&1 && ok "restore-dr onto fresh real Coolify" || bad "restore-dr (see $LOG_DIR/real-dr.log)"
in_ "$B" 'for _ in $(seq 60); do docker exec coolify php artisan migrate:status >/dev/null 2>&1 && break; sleep 3; done'

in_ "$B" 'grep -E "^(APP_KEY|DB_PASSWORD|REDIS_PASSWORD)=" /data/coolify/source/.env' >"$LOG_DIR/real-env-b.txt"
expect ".env secrets on B equal A's" cmp "$LOG_DIR/real-env-a.txt" "$LOG_DIR/real-env-b.txt"
tinker "$B" 'echo md5(App\\Models\\PrivateKey::first()->private_key);' >"$LOG_DIR/real-key-b.txt"
expect "Coolify on B decrypts A's encrypted SSH key (APP_KEY matches the database)" bash -c "[[ -s '$LOG_DIR/real-key-a.txt' ]] && cmp '$LOG_DIR/real-key-a.txt' '$LOG_DIR/real-key-b.txt'"
expect "A's project is in B's Coolify database" in_ "$B" "docker exec coolify-db psql -U coolify -d coolify -tAc \"select name from projects where uuid='proj-from-a'\" | grep -q 'Project made on A'"
expect "A's admin password works on B, B's own does not" bash -c "[[ \$(docker exec $B docker exec coolify php artisan tinker --execute=\"echo (int) Illuminate\\\\Support\\\\Facades\\\\Hash::check('Old-Server-Passw0rd', App\\\\Models\\\\User::first()->password) . (int) Illuminate\\\\Support\\\\Facades\\\\Hash::check('New-Server-Passw0rd', App\\\\Models\\\\User::first()->password);\" 2>/dev/null | tail -n 1) == 10 ]]"
in_ "$B" 'docker exec coolify-db psql -U coolify -d coolify -tAc "select count(*) from migrations"' >"$LOG_DIR/real-mig-b.txt"
expect "migrations table intact" cmp "$LOG_DIR/real-mig-a.txt" "$LOG_DIR/real-mig-b.txt"
expect "Coolify container recreated and connected to its DB" in_ "$B" 'docker exec coolify php artisan migrate:status'
expect "Coolify reaches this host over SSH as root with A's key" in_ "$B" 'k=$(ls /data/coolify/ssh/keys/ssh_key@* | grep -v "\.lock$" | head -n1); docker exec coolify ssh -o StrictHostKeyChecking=no -o BatchMode=yes -i "/var/www/html/storage/app/ssh/keys/$(basename "$k")" root@host.docker.internal true'
expect "Card Vault volume and cloudflared token restored" in_ "$B" 'ls $(docker volume inspect -f "{{.Mountpoint}}" abc123_cardvault-data)/backups/cardvault-*.tar.gz && grep -q TOKEN-A /etc/cloudflared/tunnel-token'
in_ "$B" 'docker ps --format "{{.Names}} {{.Status}}"' >"$LOG_DIR/real-ps-b.txt"
printf '\nreal Coolify: %d passed, %d failed. Logs in %s\n' "$PASS" "$FAIL" "$LOG_DIR"
((FAIL == 0))
