#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016  # test style: cmd && ok || bad, remote commands in single quotes
# End to end test of server-backup, entirely in containers (never on a real server).
#
#   tests/images/build.sh            (once: builds sb-dest, sb-node, sb-cardvault)
#   tests/e2e.sh sftp                SFTP with a key:  server A backs up, server B restores
#   tests/e2e.sh ftps                FTPS with a password and a self-signed certificate
#   tests/e2e.sh extras              SFTP password, plain FTP, wrong password, locking
#
# Server A and B are privileged Ubuntu 24.04 containers running systemd and Docker.
# Each runs a stand-in for Coolify (coolify-db postgres:15-alpine, coolify-redis,
# a "coolify" container, the /data/coolify tree with source/.env) and apps.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOL="$HERE/../server-backup"
MODE="${1:-sftp}"
NET=sbnet
DEST=sbdest
A="sbA-$MODE"
B="sbB-$MODE"
IMAGES_TAR="${IMAGES_TAR:-/tmp/sb-inner-images.tar}"
LOG_DIR="${LOG_DIR:-/tmp/sb-e2e-logs}"
mkdir -p "$LOG_DIR"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
expect() { # expect "description" command...
    local d=$1
    shift
    if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
in_() { local c=$1; shift; docker exec -i "$c" bash -c "$*"; }
# Runs a script (from stdin) inside a container, with stdin closed for its commands.
script_in() {
    local c=$1 f
    f="$(mktemp)"
    cat >"$f"
    docker cp -q "$f" "$c:/tmp/e2e-step.sh"
    rm -f "$f"
    docker exec "$c" bash /tmp/e2e-step.sh </dev/null
}

start_dest() {
    docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
    if ! docker container inspect "$DEST" >/dev/null 2>&1; then
        docker run -d --name "$DEST" --hostname "$DEST" --network "$NET" sb-dest >/dev/null
        sleep 2
    fi
}

make_server() { # make_server NAME HOSTNAME
    local n=$1 h=$2
    docker rm -f "$n" >/dev/null 2>&1 || true
    docker volume rm "$n-docker" "$n-containerd" >/dev/null 2>&1 || true
    docker run -d --privileged --name "$n" --hostname "$h" --network "$NET" \
        -v "$n-docker:/var/lib/docker" -v "$n-containerd:/var/lib/containerd" sb-node /sbin/init >/dev/null
    local _
    for _ in $(seq 1 60); do
        in_ "$n" 'docker info >/dev/null 2>&1' && break
        sleep 1
    done
    docker exec -i "$n" docker load -q <"$IMAGES_TAR" >/dev/null
    docker cp "$TOOL" "$n:/usr/local/sbin/server-backup"
    in_ "$n" 'chmod 755 /usr/local/sbin/server-backup; docker network create coolify >/dev/null'
}

# Stand-in for a Coolify v4 install, same file layout and container names.
standin_coolify() { # standin_coolify NAME
    local n=$1
    script_in "$n" <<'EOS'
set -euo pipefail
docker tag postgres:15-alpine ghcr.io/coollabsio/coolify:4.0.0-beta.999
mkdir -p /data/coolify/{source,ssh/keys,ssh/mux,applications,databases,services,backups,proxy/dynamic,sentinel/db,webhooks-during-maintenance}
rnd() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }
cat >/data/coolify/source/.env <<EOF
APP_ID=$(rnd 32)
APP_NAME=Coolify
APP_KEY=base64:$(head -c 32 /dev/urandom | base64)
DB_USERNAME=coolify
DB_PASSWORD=$(rnd 40)
REDIS_PASSWORD=$(rnd 40)
PUSHER_APP_ID=$(rnd 32)
PUSHER_APP_KEY=$(rnd 32)
PUSHER_APP_SECRET=$(rnd 32)
EOF
chmod 600 /data/coolify/source/.env
cat >/data/coolify/source/docker-compose.yml <<'EOF'
services:
  coolify:
    image: "ghcr.io/coollabsio/coolify:${LATEST_IMAGE:-4.0.0-beta.999}"
    container_name: coolify
    restart: always
    command: ["sh", "-c", "while :; do sleep 3600; done"]
    environment:
      - APP_KEY=${APP_KEY}
      - DB_USERNAME=${DB_USERNAME}
      - DB_PASSWORD=${DB_PASSWORD}
      - REDIS_PASSWORD=${REDIS_PASSWORD}
    volumes:
      - /data/coolify/ssh:/var/www/html/storage/app/ssh
    depends_on: [postgres, redis]
  postgres:
    image: postgres:15-alpine
    container_name: coolify-db
    restart: always
    volumes:
      - coolify-db:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: "${DB_USERNAME}"
      POSTGRES_PASSWORD: "${DB_PASSWORD}"
      POSTGRES_DB: "${DB_DATABASE:-coolify}"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USERNAME} -d ${DB_DATABASE:-coolify}"]
      interval: 2s
      retries: 30
  redis:
    image: redis:7-alpine
    container_name: coolify-redis
    restart: always
    command: redis-server --save 20 1 --loglevel warning --requirepass ${REDIS_PASSWORD}
    volumes:
      - coolify-redis:/data
volumes:
  coolify-db:
    name: coolify-db
  coolify-redis:
    name: coolify-redis
networks:
  default:
    name: coolify
    external: true
EOF
printf 'services: {}\n' >/data/coolify/source/docker-compose.prod.yml
cd /data/coolify/source
docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml up -d --wait >/dev/null 2>&1
ssh-keygen -q -t ed25519 -N '' -C coolify -f "/data/coolify/ssh/keys/ssh_key@$(rnd 24 | tr 'A-Z' 'a-z')"
rm -f /data/coolify/ssh/keys/*.pub
mkdir -p /root/.ssh && chmod 700 /root/.ssh
for k in /data/coolify/ssh/keys/*; do ssh-keygen -y -f "$k" >>/root/.ssh/authorized_keys; done
EOS
}

# Things only server A has: Coolify data, apps, /etc files.
populate_a() {
    script_in "$A" <<'EOS'
set -euo pipefail
q() { docker exec -i coolify-db psql -U coolify -v ON_ERROR_STOP=1 -q "$@"; }
q -d coolify <<'SQL'
CREATE TABLE applications (id serial PRIMARY KEY, uuid text, name text, fqdn text);
INSERT INTO applications (uuid, name, fqdn) SELECT 'uuid-' || g, 'app ' || g, 'https://app' || g || '.example.com' FROM generate_series(1, 500) g;
CREATE TABLE users (id serial PRIMARY KEY, email text, password text);
INSERT INTO users (email, password) VALUES ('owner@example.com', '$2y$12$oldserverhash');
SQL
q -d postgres -c "CREATE ROLE reader LOGIN PASSWORD 'readerpw'"
q -d postgres -c "CREATE DATABASE extra OWNER reader"
q -d extra -c "CREATE TABLE t (v text); INSERT INTO t VALUES ('extra database row')"
echo '{"letsencrypt":{"Certificates":[{"domain":"app1.example.com"}]}}' >/data/coolify/proxy/acme.json
chmod 600 /data/coolify/proxy/acme.json
printf 'services:\n  traefik:\n    image: traefik:v3\n' >/data/coolify/proxy/docker-compose.yml.example
mkdir -p /data/coolify/applications/abc123
printf 'services:\n  cardvault:\n    image: sb-cardvault\n' >/data/coolify/applications/abc123/docker-compose.yaml
head -c 300000 /dev/urandom >/data/coolify/sentinel/db/metrics.sqlite
mkdir -p /data/coolify/backups/coolify && echo "old coolify backup" >/data/coolify/backups/coolify/note.txt
# Card Vault (Docker Compose style names and labels, as Coolify creates them).
docker volume create --label com.docker.compose.project=abc123 --label com.docker.compose.volume=cardvault-data \
    --label coolify.managed=true abc123_cardvault-data >/dev/null
docker run -d --name cardvault-abc123-174411 --restart unless-stopped --network coolify \
    --label coolify.managed=true --label com.docker.compose.service=cardvault --label com.docker.compose.project=abc123 \
    -v abc123_cardvault-data:/data sb-cardvault >/dev/null
# Another app with a volume that will not exist on server B.
docker volume create --label coolify.managed=true otherapp-data >/dev/null
docker run --rm -v otherapp-data:/v --user 0 sb-cardvault sh -c 'mkdir -p /v/sub && echo "hello from otherapp" >/v/sub/hello.txt && chown -R 70:70 /v && chmod 750 /v/sub'
mkdir -p /etc/cloudflared && echo "eyJ-TUNNEL-TOKEN-OF-SERVER-A" >/etc/cloudflared/tunnel-token && chmod 700 /etc/cloudflared && chmod 600 /etc/cloudflared/tunnel-token
mkdir -p /etc/default && echo 'ALLOWED_PORTS="80 443"  # server A' >/etc/default/docker-port-guard
mkdir -p /etc/ssh/sshd_config.d && printf 'PasswordAuthentication no\n# server A hardening\n' >/etc/ssh/sshd_config.d/01-server-hardening.conf
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOf0VUxfakefakefakefakefakefakefakefakefake ca@a" >/etc/ssh/ca.pub
mkdir -p /etc/ssh/principals && echo admin >/etc/ssh/principals/root
sleep 4
EOS
}

# Server B looks like a fresh bootstrap.sh install: its own Coolify secrets, its
# own /etc files, an empty Card Vault volume (otherapp-data does not exist).
populate_b() {
    script_in "$B" <<'EOS'
set -euo pipefail
mkdir -p /etc/cloudflared && echo "TOKEN-OF-NEW-SERVER-B" >/etc/cloudflared/tunnel-token
echo 'ALLOWED_PORTS="80 443"  # server B' >/etc/default/docker-port-guard
mkdir -p /etc/ssh/sshd_config.d && printf '# server B hardening\n' >/etc/ssh/sshd_config.d/01-server-hardening.conf
docker volume create abc123_cardvault-data >/dev/null
EOS
}

# Feeds answers to "server-backup setup" or "restore-dr" for the mode.
dest_answers() { # dest_answers PATH
    case "$MODE" in
        sftp) printf '1\n%s\n22\nbk\n%s\n1\n/root/.ssh/backup_key\ny\n' "$DEST" "$1" ;;
        ftps) printf '2\n%s\n21\nbk\n%s\nS3cret pass!\nYES\n' "$DEST" "$1" ;;
    esac
}

checksums_a() {
    script_in "$A" <<'EOS'
set -euo pipefail
mp=$(docker volume inspect -f '{{.Mountpoint}}' abc123_cardvault-data)
(cd "$mp/uploads" && find . -type f -print0 | sort -z | xargs -0 sha256sum)
EOS
}

main() {
    [[ -f $IMAGES_TAR ]] || docker save postgres:15-alpine redis:7-alpine sb-cardvault -o "$IMAGES_TAR"
    start_dest
    local path="sb-$MODE-$RANDOM"
    say_step "Server A ($MODE)"
    make_server "$A" server-a
    standin_coolify "$A"
    populate_a
    if [[ $MODE == sftp ]]; then
        in_ "$A" "ssh-keygen -q -t ed25519 -N '' -f /root/.ssh/backup_key"
        docker exec "$A" cat /root/.ssh/backup_key.pub | docker exec -i "$DEST" bash -c 'mkdir -p /home/bk/.ssh && cat >>/home/bk/.ssh/authorized_keys && chown -R bk:bk /home/bk/.ssh && chmod 700 /home/bk/.ssh && chmod 600 /home/bk/.ssh/authorized_keys'
    fi

    say_step "setup on A"
    { dest_answers "$path"; printf 'SAVED\nn\n'; } | docker exec -i "$A" server-backup setup >"$LOG_DIR/$MODE-setup.log" 2>&1 && ok "setup exits 0" || bad "setup exits 0 (see $LOG_DIR/$MODE-setup.log)"
    local pw
    pw="$(grep -A2 'YOUR BACKUP PASSWORD' "$LOG_DIR/$MODE-setup.log" | grep -oE '[a-z2-9]{5}(-[a-z2-9]{5}){5}' | head -n1)"
    [[ -n $pw ]] && ok "password shown once at setup" || bad "password shown at setup"
    expect "config dir is 700" in_ "$A" '[[ $(stat -c %a /etc/server-backup) == 700 ]]'
    expect "password file is 600" in_ "$A" '[[ $(stat -c %a /etc/server-backup/restic-password) == 600 ]]'
    expect "rclone.conf is 600 and has no plain password" in_ "$A" '[[ $(stat -c %a /etc/server-backup/rclone.conf) == 600 ]] && ! grep -q "S3cret" /etc/server-backup/rclone.conf'
    expect "timers enabled" in_ "$A" 'systemctl is-enabled server-backup.timer && systemctl is-enabled server-backup-check.timer'
    expect "timer is daily 02:30 with 30 min random delay" in_ "$A" 'systemctl cat server-backup.timer | grep -q "OnCalendar=\*-\*-\* 02:30:00" && systemctl cat server-backup.timer | grep -q "RandomizedDelaySec=30min"'
    expect "Card Vault hook installed" in_ "$A" '[[ -x /etc/server-backup/hooks.d/10-cardvault ]]'
    [[ $MODE == sftp ]] && expect "SFTP host key recorded" in_ "$A" 'grep -q sbdest /etc/server-backup/known_hosts'
    [[ $MODE == ftps ]] && expect "FTPS certificate pinned" in_ "$A" 'grep -q "FTP_CERT_CHECK=pinned" /etc/server-backup/config'

    say_step "run on A (apps keep running and writing)"
    in_ "$A" 'server-backup run --dry-run' >"$LOG_DIR/$MODE-dryrun.log" 2>&1 && ok "run --dry-run" || bad "run --dry-run"
    expect "dry run wrote no status" in_ "$A" '[[ ! -f /var/lib/server-backup/last-status ]]'
    in_ "$A" 'server-backup run' >"$LOG_DIR/$MODE-run1.log" 2>&1 && ok "run 1 exits 0" || bad "run 1 exits 0 (see $LOG_DIR/$MODE-run1.log)"
    in_ "$A" 'systemctl start server-backup.service' >"$LOG_DIR/$MODE-run2.log" 2>&1 && ok "run 2 through systemd service exits 0" || bad "run 2 via systemd"
    expect "status file: success=yes and snapshot id" in_ "$A" 'grep -qx success=yes /var/lib/server-backup/last-status && grep -qE "^snapshot=[0-9a-f]{64}$" /var/lib/server-backup/last-status'
    expect "Card Vault hook made a copy inside the volume" in_ "$A" 'ls $(docker volume inspect -f "{{.Mountpoint}}" abc123_cardvault-data)/backups/cardvault-*.tar.gz'
    in_ "$A" 'server-backup list' >"$LOG_DIR/$MODE-list.log" 2>&1 && ok "list" || bad "list"
    expect "list shows 2 backups" grep -q '^2 backups' "$LOG_DIR/$MODE-list.log"
    in_ "$A" 'server-backup check' >"$LOG_DIR/$MODE-check.log" 2>&1 && ok "check (5% read)" || bad "check"
    expect "status has check_success=yes" in_ "$A" 'grep -qx check_success=yes /var/lib/server-backup/last-status'
    in_ "$A" 'server-backup status' >"$LOG_DIR/$MODE-status.log" 2>&1 && ok "status exits 0" || bad "status"

    say_step "what is in the snapshot"
    in_ "$A" 'export RESTIC_REPOSITORY=rclone:backupdest:'"$path"' RESTIC_PASSWORD_FILE=/etc/server-backup/restic-password RCLONE_CONFIG=/etc/server-backup/rclone.conf; restic ls latest' >"$LOG_DIR/$MODE-ls.txt" 2>/dev/null
    expect "restic password file not in snapshot" bash -c "! grep -q 'restic-password' '$LOG_DIR/$MODE-ls.txt'"
    expect "rclone.conf (destination login) is in snapshot" grep -q '^/etc/server-backup/rclone.conf$' "$LOG_DIR/$MODE-ls.txt"
    expect "coolify-db live data not in snapshot" bash -c "! grep -q '/volumes/coolify-db/' '$LOG_DIR/$MODE-ls.txt'"
    expect "sentinel metrics excluded" bash -c "! grep -q '/data/coolify/sentinel' '$LOG_DIR/$MODE-ls.txt'"
    expect "pg dump in snapshot" grep -q '/var/lib/server-backup/staging/coolify-db.sql$' "$LOG_DIR/$MODE-ls.txt"
    expect "manifest in snapshot" grep -q '/var/lib/server-backup/staging/manifest.txt$' "$LOG_DIR/$MODE-ls.txt"
    expect "redis volume in snapshot" grep -q '/volumes/coolify-redis/_data' "$LOG_DIR/$MODE-ls.txt"
    in_ "$A" 'mkdir -p /tmp/full && export RESTIC_REPOSITORY=rclone:backupdest:'"$path"' RESTIC_PASSWORD_FILE=/etc/server-backup/restic-password RCLONE_CONFIG=/etc/server-backup/rclone.conf; restic restore latest --target /tmp/full >/dev/null 2>&1'
    expect "restic password text appears nowhere in the restored snapshot" in_ "$A" "! grep -rqF '$pw' /tmp/full"
    in_ "$A" 'rm -rf /tmp/full'

    say_step "restore-files on A"
    in_ "$A" 'server-backup restore-files --volume otherapp-data --target /root/got' >"$LOG_DIR/$MODE-rf.log" 2>&1 && ok "restore-files --volume" || bad "restore-files --volume"
    expect "restore-files: file content back" in_ "$A" 'grep -q "hello from otherapp" /root/got/var/lib/docker/volumes/otherapp-data/_data/sub/hello.txt'
    expect "restore-files: owner and mode kept" in_ "$A" '[[ $(stat -c "%u %a" /root/got/var/lib/docker/volumes/otherapp-data/_data/sub) == "70 750" ]]'
    in_ "$A" 'server-backup restore-files --target /root/got2 /etc/cloudflared' >>"$LOG_DIR/$MODE-rf.log" 2>&1 && ok "restore-files PATH" || bad "restore-files PATH"
    expect "restore-files: token file back" in_ "$A" 'grep -q SERVER-A /root/got2/etc/cloudflared/tunnel-token'
    expect "restore-files refuses a non-empty target" bash -c "! docker exec $A server-backup restore-files --target /root/got /etc/cloudflared"
    expect "restore-files refuses /" bash -c "! docker exec $A server-backup restore-files --target / /etc/cloudflared"

    checksums_a >"$LOG_DIR/$MODE-photos-a.txt"
    in_ "$A" "docker exec -i coolify-db psql -U coolify -d coolify -tAc 'select count(*), md5(string_agg(fqdn, chr(44) order by id)) from applications'" >"$LOG_DIR/$MODE-db-a.txt"
    in_ "$A" 'grep -E "^(APP_KEY|DB_PASSWORD|REDIS_PASSWORD)=" /data/coolify/source/.env' >"$LOG_DIR/$MODE-env-a.txt"

    say_step "Server B: fresh install, then restore-dr"
    make_server "$B" server-b
    standin_coolify "$B"
    populate_b
    in_ "$B" 'grep -E "^(APP_KEY)=" /data/coolify/source/.env' >"$LOG_DIR/$MODE-env-b-before.txt"
    if [[ $MODE == sftp ]]; then docker cp "$A:/root/.ssh/backup_key" - | docker cp - "$B:/root/.ssh/"; fi
    { dest_answers "$path"; printf '%s\n' "$pw"; } | docker exec -i "$B" server-backup restore-dr --dry-run >"$LOG_DIR/$MODE-dr-dry.log" 2>&1 && ok "restore-dr --dry-run" || bad "restore-dr --dry-run"
    expect "dry run changed nothing" in_ "$B" '[[ ! -e /etc/server-backup ]] && grep -q NEW-SERVER-B /etc/cloudflared/tunnel-token'
    { dest_answers "$path"; printf '%s\nrestore\n' "$pw"; } | docker exec -i "$B" server-backup restore-dr >"$LOG_DIR/$MODE-dr-no.log" 2>&1 && bad "restore-dr stops without RESTORE" || ok "restore-dr stops unless RESTORE is typed"
    { dest_answers "$path"; printf '%s\nRESTORE\n' "$pw"; } | docker exec -i "$B" server-backup restore-dr >"$LOG_DIR/$MODE-dr.log" 2>&1 && ok "restore-dr exits 0" || bad "restore-dr exits 0 (see $LOG_DIR/$MODE-dr.log)"

    say_step "verify server B"
    in_ "$B" "docker exec -i coolify-db psql -U coolify -d coolify -tAc 'select count(*), md5(string_agg(fqdn, chr(44) order by id)) from applications'" >"$LOG_DIR/$MODE-db-b.txt" 2>&1 || true
    expect "postgres: applications table identical" cmp "$LOG_DIR/$MODE-db-a.txt" "$LOG_DIR/$MODE-db-b.txt"
    expect "postgres: extra database restored" in_ "$B" "docker exec coolify-db psql -U coolify -d extra -tAc 'select v from t' | grep -q 'extra database row'"
    expect "postgres: extra role restored with its password" in_ "$B" "docker exec coolify-db sh -c \"PGPASSWORD=readerpw psql -h 127.0.0.1 -U reader -d extra -tAc 'select current_user'\" | grep -q reader"
    expect "coolify container logs in to the DB with the restored .env password" in_ "$B" "docker exec coolify sh -c 'PGPASSWORD=\$DB_PASSWORD psql -h coolify-db -U \$DB_USERNAME -d coolify -tAc \"select email from users\"' | grep -q owner@example.com"
    in_ "$B" 'grep -E "^(APP_KEY|DB_PASSWORD|REDIS_PASSWORD)=" /data/coolify/source/.env' >"$LOG_DIR/$MODE-env-b.txt"
    expect ".env secrets (APP_KEY, DB and Redis passwords) match server A" cmp "$LOG_DIR/$MODE-env-a.txt" "$LOG_DIR/$MODE-env-b.txt"
    expect "running coolify container has server A's APP_KEY" in_ "$B" "[[ \$(docker exec coolify printenv APP_KEY) == \$(grep ^APP_KEY= /data/coolify/source/.env | cut -d= -f2-) ]]"
    expect "redis runs with server A's password" in_ "$B" "docker exec coolify-redis redis-cli -a \"\$(grep ^REDIS_PASSWORD= /data/coolify/source/.env | cut -d= -f2-)\" --no-auth-warning ping | grep -q PONG"
    expect "/data/coolify files back (acme.json, app compose, Coolify SSH key)" in_ "$B" 'grep -q app1.example.com /data/coolify/proxy/acme.json && [[ -f /data/coolify/applications/abc123/docker-compose.yaml ]] && [[ $(stat -c %a /data/coolify/proxy/acme.json) == 600 ]]'
    expect "Coolify SSH key from A accepted by root on B" in_ "$B" 'for k in /data/coolify/ssh/keys/*; do grep -qF "$(ssh-keygen -y -f "$k")" /root/.ssh/authorized_keys || exit 1; done'
    expect "/etc/cloudflared token from A" in_ "$B" 'grep -q SERVER-A /etc/cloudflared/tunnel-token && [[ $(stat -c %a /etc/cloudflared/tunnel-token) == 600 ]]'
    expect "/etc/default/docker-port-guard from A" in_ "$B" 'grep -q "server A" /etc/default/docker-port-guard'
    expect "/etc/ssh files from A" in_ "$B" 'grep -q "server A" /etc/ssh/sshd_config.d/01-server-hardening.conf && [[ -f /etc/ssh/ca.pub && -f /etc/ssh/principals/root ]]'
    expect "B's old files moved aside, not deleted" in_ "$B" 'grep -q NEW-SERVER-B /var/lib/server-backup/pre-restore-*/etc/cloudflared/tunnel-token && [[ -f $(ls -d /var/lib/server-backup/pre-restore-*)/coolify-db-before-restore.sql ]] && [[ -f $(ls -d /var/lib/server-backup/pre-restore-*)/data/coolify/source/.env ]]'
    expect "otherapp-data volume created with its label and data" in_ "$B" 'docker volume inspect -f "{{index .Labels \"coolify.managed\"}}" otherapp-data | grep -q true && grep -q "hello from otherapp" $(docker volume inspect -f "{{.Mountpoint}}" otherapp-data)/sub/hello.txt && [[ $(stat -c "%u %a" $(docker volume inspect -f "{{.Mountpoint}}" otherapp-data)/sub) == "70 750" ]]'
    # Card Vault: start the app on the restored volume, as a Coolify redeploy would.
    in_ "$B" 'docker run -d --name cardvault-abc123-new --network coolify -v abc123_cardvault-data:/data sb-cardvault sleep 3600 >/dev/null'
    script_in "$B" >"$LOG_DIR/$MODE-sqlite-b.txt" 2>&1 <<'EOS' || true
mp=$(docker volume inspect -f '{{.Mountpoint}}' abc123_cardvault-data)
echo "raw: $(sqlite3 "$mp/crd.db" 'pragma integrity_check')"
f=$(ls -1t "$mp"/backups/cardvault-*.tar.gz | head -n1); mkdir -p /tmp/cv && tar -xzf "$f" -C /tmp/cv
echo "hook copy: $(sqlite3 /tmp/cv/crd.db 'pragma integrity_check')"
echo "rows: $(sqlite3 /tmp/cv/crd.db 'select count(*) from cards')"
echo "owner: $(stat -c %u "$mp/crd.db")"
EOS
    expect "SQLite (hook copy) integrity_check ok" grep -q '^hook copy: ok$' "$LOG_DIR/$MODE-sqlite-b.txt"
    expect "SQLite (raw live file) integrity_check ok" grep -q '^raw: ok$' "$LOG_DIR/$MODE-sqlite-b.txt"
    expect "SQLite file owner kept (uid 1000)" grep -q '^owner: 1000$' "$LOG_DIR/$MODE-sqlite-b.txt"
    in_ "$B" 'mp=$(docker volume inspect -f "{{.Mountpoint}}" abc123_cardvault-data); cd "$mp/uploads" && find . -type f -print0 | sort -z | xargs -0 sha256sum' >"$LOG_DIR/$MODE-photos-b.txt"
    expect "20 photos, checksums match" bash -c "[[ \$(wc -l <'$LOG_DIR/$MODE-photos-a.txt') -eq 20 ]] && cmp '$LOG_DIR/$MODE-photos-a.txt' '$LOG_DIR/$MODE-photos-b.txt'"
    expect "B's empty cardvault volume moved aside or replaced" in_ "$B" 'ls $(docker volume inspect -f "{{.Mountpoint}}" abc123_cardvault-data)/crd.db'
    expect "backup settings on B: password file 600, timers on" in_ "$B" '[[ $(stat -c %a /etc/server-backup/restic-password) == 600 ]] && systemctl is-enabled server-backup.timer'
    expect "backup settings keep A's backup name" in_ "$B" 'grep -qx BACKUP_HOST=server-a /etc/server-backup/config'
    in_ "$B" 'server-backup run' >"$LOG_DIR/$MODE-b-run.log" 2>&1 && ok "B can back up to the same store after restore" || bad "B backup after restore"
    printf '\n%s: %d passed, %d failed. Logs in %s\n' "$MODE" "$PASS" "$FAIL" "$LOG_DIR"
    ((FAIL == 0))
}

say_step() { printf '\n--- %s\n' "$*"; }

extras() {
    start_dest
    local S=sbX path="sb-x-$RANDOM"
    make_server "$S" server-x
    standin_coolify "$S"
    say_step "SFTP with password"
    printf '1\n%s\n22\nbk\n%s\n2\nS3cret pass!\ny\nSAVED\nn\n' "$DEST" "$path" | docker exec -i "$S" server-backup setup >"$LOG_DIR/x-setup-pw.log" 2>&1 && ok "setup SFTP with password" || bad "setup SFTP with password"
    expect "obscured password in rclone.conf, not plain" in_ "$S" 'grep -q "^pass = " /etc/server-backup/rclone.conf && ! grep -q S3cret /etc/server-backup/rclone.conf'
    # Sample every process's command line while a backup runs.
    in_ "$S" '(while :; do ps -eww -o args= >>/root/ps.txt; sleep 0.1; done) & p=$!; server-backup run; rc=$?; kill $p; exit $rc' >"$LOG_DIR/x-run-pw.log" 2>&1 && ok "run over SFTP password" || bad "run over SFTP password"
    expect "process list was sampled during the run (restic and rclone seen)" in_ "$S" 'grep -q "restic -o rclone.timeout" /root/ps.txt && grep -q "rclone serve restic" /root/ps.txt'
    expect "no password (SFTP, obscured, or restic) in any command line" in_ "$S" '! grep -qF -e "S3cret" -e "$(grep ^pass /etc/server-backup/rclone.conf | cut -d" " -f3)" -e "$(cat /etc/server-backup/restic-password)" /root/ps.txt'
    expect "no password in the run log" bash -c "! grep -q 'S3cret' '$LOG_DIR/x-run-pw.log'"

    say_step "lock: two runs never overlap"
    in_ "$S" 'exec 9>/run/server-backup.lock; flock -n 9; server-backup run; echo "rc=$?"' >"$LOG_DIR/x-lock.log" 2>&1 || true
    expect "second run refused with exit code 75" grep -q 'rc=75' "$LOG_DIR/x-lock.log"
    expect "busy run did not overwrite the status" in_ "$S" 'grep -qx success=yes /var/lib/server-backup/last-status'

    say_step "wrong destination password"
    in_ "$S" 'cp /etc/server-backup/rclone.conf /root/rclone.good; sed -i "s/^pass = .*/pass = $(printf wrongpass | rclone obscure -)/" /etc/server-backup/rclone.conf'
    in_ "$S" 'server-backup run; echo "rc=$?"' >"$LOG_DIR/x-wrong-dest.log" 2>&1 || true
    expect "wrong FTP/SFTP password: exit 1" grep -q 'rc=1' "$LOG_DIR/x-wrong-dest.log"
    expect "wrong FTP/SFTP password: clear message" grep -q 'refused the login' "$LOG_DIR/x-wrong-dest.log"
    expect "status success=no with the reason" in_ "$S" 'grep -qx success=no /var/lib/server-backup/last-status && grep -q "^error=The backup server refused the login" /var/lib/server-backup/last-status'
    in_ "$S" 'server-backup status; echo "rc=$?"' >"$LOG_DIR/x-status-failed.log" 2>&1 || true
    expect "status shows FAILED, exit 1" bash -c "grep -q FAILED '$LOG_DIR/x-status-failed.log' && grep -q rc=1 '$LOG_DIR/x-status-failed.log'"
    in_ "$S" 'cp /root/rclone.good /etc/server-backup/rclone.conf'

    say_step "wrong restic password"
    in_ "$S" 'cp /etc/server-backup/restic-password /root/pw.good; printf wrong >/etc/server-backup/restic-password'
    in_ "$S" 'server-backup run; echo "rc=$?"' >"$LOG_DIR/x-wrong-restic.log" 2>&1 || true
    expect "wrong restic password: exit 1 and clear message" bash -c "grep -q 'rc=1' '$LOG_DIR/x-wrong-restic.log' && grep -q 'backup password (restic password) is wrong' '$LOG_DIR/x-wrong-restic.log'"
    in_ "$S" 'cp /root/pw.good /etc/server-backup/restic-password'

    say_step "unreachable server"
    in_ "$S" 'cp /etc/server-backup/rclone.conf /root/rclone.good; sed -i "s/^port = .*/port = 2/" /etc/server-backup/rclone.conf; server-backup run; echo "rc=$?"' >"$LOG_DIR/x-unreach.log" 2>&1 || true
    expect "unreachable: clear message" bash -c "grep -q 'rc=1' '$LOG_DIR/x-unreach.log' && grep -q 'refused the connection' '$LOG_DIR/x-unreach.log'"
    in_ "$S" 'cp /root/rclone.good /etc/server-backup/rclone.conf'

    say_step "plain FTP needs YES"
    in_ "$S" 'mkdir -p /root/old && mv /etc/server-backup /root/old/'
    printf '3\nno\n' | docker exec -i "$S" server-backup setup >"$LOG_DIR/x-ftp-no.log" 2>&1 && bad "plain FTP without YES refused" || ok "plain FTP without YES refused"
    expect "nothing saved after refusal" in_ "$S" '[[ ! -f /etc/server-backup/config ]]'
    printf '3\nYES\n%s\n2121\nbk\n%s-ftp\nS3cret pass!\nSAVED\nn\n' "$DEST" "$path" | docker exec -i "$S" server-backup setup >"$LOG_DIR/x-ftp.log" 2>&1 && ok "plain FTP setup after YES" || bad "plain FTP setup after YES"
    in_ "$S" 'server-backup run && server-backup check --quick' >"$LOG_DIR/x-ftp-run.log" 2>&1 && ok "run and check over plain FTP" || bad "run over plain FTP"
    in_ "$S" 'server-backup bogus; echo "rc=$?"' 2>&1 | grep -q 'rc=2' && ok "unknown command exits 2" || bad "unknown command exits 2"

    say_step "a failing hook marks the backup as failed, but the backup is still made"
    in_ "$S" 'printf "#!/bin/sh\necho broken; exit 4\n" >/etc/server-backup/hooks.d/50-broken; chmod 700 /etc/server-backup/hooks.d/50-broken; server-backup run; echo "rc=$?"' >"$LOG_DIR/x-hook.log" 2>&1 || true
    expect "failing hook: exit 1, status names the hook, snapshot recorded" bash -c "grep -q rc=1 '$LOG_DIR/x-hook.log' && docker exec $S grep -q '^error=These preparation hooks failed: 50-broken' /var/lib/server-backup/last-status && docker exec $S grep -qE '^snapshot=[0-9a-f]{64}' /var/lib/server-backup/last-status"
    in_ "$S" 'rm /etc/server-backup/hooks.d/50-broken'

    say_step "restore-dr with settings already on the server, older snapshot chosen by ID"
    local first
    first="$(in_ "$S" 'server-backup list' | awk '$1 ~ /^[0-9]+$/ && NF == 8 {id=$7} END {print id}')"
    in_ "$S" "docker exec coolify-db psql -U coolify -d coolify -qc 'create table after_backup (x int)'"
    printf 'RESTORE\n' | docker exec -i "$S" server-backup restore-dr --snapshot "$first" >"$LOG_DIR/x-dr-local.log" 2>&1 && ok "restore-dr --snapshot $first using saved settings" || bad "restore-dr with saved settings (see $LOG_DIR/x-dr-local.log)"
    expect "database is back to the backup state (table made later is gone)" in_ "$S" "! docker exec coolify-db psql -U coolify -d coolify -tAc 'select 1 from after_backup' 2>/dev/null"
    expect "Coolify containers running after restore" in_ "$S" '[[ $(docker inspect -f "{{.State.Running}}" coolify coolify-db coolify-redis | sort -u) == true ]]'
    expect "backups still work after restore" in_ "$S" 'server-backup run'

    say_step "check finds damage in the backup store"
    docker exec "$DEST" bash -c "f=\$(find /home/bk/$path-ftp/data -type f | head -n 1); mv \"\$f\" /tmp/"
    in_ "$S" 'server-backup check; echo "rc=$?"' >"$LOG_DIR/x-check-bad.log" 2>&1 || true
    expect "damaged store: check exits 1 and status check_success=no" bash -c "grep -q rc=1 '$LOG_DIR/x-check-bad.log' && docker exec $S grep -qx check_success=no /var/lib/server-backup/last-status"

    say_step "FTPS certificate change is detected"
    in_ "$S" 'rm -rf /etc/server-backup'
    printf '2\n%s\n21\nbk\n%s-ftps\nS3cret pass!\nYES\nSAVED\nn\n' "$DEST" "$path" | docker exec -i "$S" server-backup setup >"$LOG_DIR/x-ftps.log" 2>&1 && ok "FTPS setup" || bad "FTPS setup"
    in_ "$S" 'sed -i "s/^FTP_CERT_SHA256=.*/FTP_CERT_SHA256=00:11/" /etc/server-backup/config; server-backup run; echo "rc=$?"' >"$LOG_DIR/x-ftps-pin.log" 2>&1 || true
    expect "changed certificate: backup refused with a clear message" bash -c "grep -q rc=1 '$LOG_DIR/x-ftps-pin.log' && grep -q 'certificate has changed' '$LOG_DIR/x-ftps-pin.log'"
    printf '\nextras: %d passed, %d failed. Logs in %s\n' "$PASS" "$FAIL" "$LOG_DIR"
    ((FAIL == 0))
}

case "$MODE" in
    sftp | ftps) main ;;
    extras) extras ;;
    *) echo "usage: $0 sftp|ftps|extras" >&2; exit 2 ;;
esac
