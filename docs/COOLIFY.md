# Coolify deploy notes

Notes for the go-live guide. Card Vault runs as one Docker container that
Coolify v4 builds from this public GitHub repository, behind Coolify's
Traefik proxy (Traefik handles HTTPS). Everything below is done in the
Coolify web dashboard. No terminal is needed.

## Files

- `Dockerfile`: three stages on `node:22.23.5-bookworm-slim`. Runs as user
  1001, `NODE_ENV=production`, heap capped at 512 MB, data in `/data`,
  port 3000, health check on `/api/health`.
- `docker-compose.yaml`: what Coolify reads (Build Pack: Docker Compose).
- `scripts/container/backup.sh`: daily backup, run by a Coolify Scheduled Task.

## Create the app

1. Project, then + New, then Public Repository. Paste the GitHub address and
   choose Check Repository.
2. Build Pack: **Docker Compose**. Docker Compose Location: `/docker-compose.yaml`.
   Base Directory: `/`.
3. Domains: for the service `cardvault`, enter
   `https://cards.example.com:3000` (your own address). The `:3000` only tells
   Coolify which port inside the container gets the visits; people still use
   the normal address without a port. It must start with `https://`: the
   app refuses to start in production with an `http://` address (sign-in
   cookies are HTTPS only).
4. Deploy. Wait for the deployment log to finish and the app to show healthy.

## Settings Coolify makes by itself

The compose file uses Coolify's generated values ("magic" variables). Coolify
creates them the first time it reads the file, keeps them between deploys and
shows them under Environment Variables, where they can be copied or changed.
Syntax confirmed on https://coolify.io/docs/knowledge-base/docker/compose
(section "Generated stack values"):

| Setting | Value in the compose file | What it is |
|---|---|---|
| Domain routing | `SERVICE_URL_CARDVAULT_3000` | Generated URL for service `cardvault`, routed to port 3000 |
| `APP_ORIGIN` | `${SERVICE_URL_CARDVAULT_3000}` | The address set under Domains, with the scheme |
| `SESSION_SECRET` | `${SERVICE_PASSWORD_64_SESSIONSECRET}` | 64 random letters and digits |
| `SETUP_CODE` | `${SERVICE_PASSWORD_SETUPCODE}` | 32 random letters and digits |
| `OWNER_PASSWORD_HASH_B64` | `${OWNER_PASSWORD_HASH_B64:-}` | Empty unless you want the old way |
| `TRUST_PROXY_HOPS` | `1` | See "Visitor address" below |
| `RECOGNITION_MODE` | `auto` | Free card reading, no keys |

Per the docs, the part after the type and size must be one word with no
underscore (`SESSIONSECRET`, not `SESSION_SECRET`), and `SERVICE_PASSWORD_*`
values contain no symbols. `SERVICE_BASE64_*` would also work (despite its
name it is plain letters and digits).

Not confirmed by the docs: whether a URL variable with the port suffix gives
exactly `https://cards.example.com` with no port and no trailing slash. After
the first deploy, check More, Connection check, "Public address (APP_ORIGIN)":
it should say "matches this visit". If the value is wrong, the app shows an
error at start in Runtime Logs; then replace `APP_ORIGIN` under Environment
Variables with the plain address, like `https://cards.example.com`.

## First visit: choose the password

1. In Coolify, open the app, Environment Variables, and copy the value of
   `SETUP_CODE`.
2. On the phone, open the app's address. It shows "Finish setup first".
   Tap "Set your password".
3. Paste the setup code, type a new password of at least 16 characters
   twice, and save. You are signed in.
4. After that `/setup` is gone for good (it shows "not found"). The setup code
   is useless from then on; leaving it set is harmless.

Setup tries count toward the same limits as sign-in (5 wrong tries in 15
minutes from one address, 10 in 24 hours, 300 from everyone in 15 minutes).

If someone else could open the address before the owner, they would still
need the setup code, which only the Coolify dashboard shows.

To change the password later: More, Password. This signs out every other
phone and computer. If `OWNER_PASSWORD_HASH_B64` is set in Coolify, it wins
over the password chosen in the app, and More says it is set in the server
settings.

Forgotten password: there is no reset by email. Someone with the Coolify
dashboard can set `OWNER_PASSWORD_HASH_B64` (made with `npm run set-password`
on any computer with the code), then redeploy.

## Visitor address (TRUST_PROXY_HOPS=1)

Sign-in limits need the visitor's real address. Traefik adds the address it
received the connection from as the last entry of `X-Forwarded-For` (its docs
describe the option `forwardedHeaders.notAppendXForwardedFor` as "Traefik will
not append the client's RemoteAddr", so appending is the default:
https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/).
A visitor can put fake entries in front, but never after Traefik's, so the
app reads the last entry: `TRUST_PROXY_HOPS=1`.

Not stated on that page: whether Traefik first removes an untrusted
incoming `X-Forwarded-For` (community answers say it does). Either way the
last entry is the real one, so the setting is the same.

Check after deploy: More, Connection check, "IP used for sign-in limits"
should be the phone's internet address. If it shows an address like
`172.x.x.x` or `10.x.x.x`, the server's firewall or Docker is hiding real
addresses; if a CDN such as Cloudflare is put in front, use 2.

## Data and backups

All data (database and photos) lives in the volume `cardvault-data`, mounted
at `/data`. It survives redeploys and restarts. Settings and secrets are not
in it: they stay in Coolify.

Daily backup: app, Scheduled Tasks, Add:
- Name: `Backup`
- Command: `sh scripts/container/backup.sh`
- Frequency: `17 3 * * *` (every day at 03:17, server time)
- Container: `cardvault` (if asked)

Each run writes `/data/backups/cardvault-<date>-<time>.tar.gz` (database
copied with SQLite's own online backup, plus photos) and keeps the newest 14.
Output appears under the task's recent executions.

Download a backup: app, **Files** (marked Beta in Coolify), choose the
`cardvault` container, open `/data/backups`, choose a file, Download. Per
https://coolify.io/docs/core/container-file-browser this works up to 1 GiB per
file without extra setup and needs a dashboard user who may use the terminal
(Team Members cannot). For larger collections, Coolify's volume backups to
S3 storage are the alternative
(https://coolify.io/docs/core/persistent-storage/storage-mounts/backups).
Copies kept only on the same server do not protect against losing the
server, so download one now and then.

Restore is not automated in the container yet: it needs the app stopped,
then the files from the archive put back into `/data`.

## Tested locally (Docker 29.9.2)

Built the image, ran it with a named volume on port 3300, `APP_ORIGIN`
`http://localhost:3300` (production accepts `http://` only for localhost,
127.0.0.1 and [::1]). Health 200 within 1 second, process uid 1001, setup and
sign-in through a real browser, `/setup` 404 afterwards, a free scan read
"1990 Topps #414 Frank Thomas" in 2.9 seconds, data kept across restart and
across a rebuilt image, a password change signed out the second browser,
backup made and 14 kept. Image: 1.01 GB on disk, 227 MB download.

Building inside this sandbox needed its network proxy for npm; Coolify does
not. The Dockerfile itself was not changed for that.
