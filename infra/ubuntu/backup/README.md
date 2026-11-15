# server-backup

Encrypted nightly backups of the whole server to **your own SFTP or FTP
server**, and a full recovery onto a brand new server if this one is lost.

It uses two programs from Ubuntu itself: `restic` (encrypts, saves only what
changed, keeps old versions) and `rclone` (talks to SFTP and FTP servers).
Everything is encrypted on this server before it leaves, so the owner of the
backup server cannot read it.

## IMPORTANT: the backup password

During setup a backup password is shown **once**, for example
`k7m2p-x9qrt-...`. Store it in your password manager straight away, together
with the address of the backup server.

- Without this password **nobody can restore anything**, not even you.
- It is deliberately **not** inside the backups (a locked box should not hold
  its own key). If the server is lost, the password manager is the only copy.
- If you also want a paper copy, keep it somewhere safe at home.

## What is backed up

| What | Where | How |
|---|---|---|
| Coolify's database (projects, apps, settings, users) | `coolify-db` container | Full dump with `pg_dumpall`, made just before each backup |
| Coolify's files: `.env` with APP_KEY and passwords, SSH keys, proxy and certificates, app settings, Coolify's own backups | `/data/coolify` | Files |
| Every app's data (Card Vault database and photos, and any other app) | Docker named volumes in `/var/lib/docker/volumes` | Files, while the apps keep running |
| Card Vault's database, as a safe copy | inside its volume, `/data/backups` | Card Vault's own backup script runs first (hook) |
| Cloudflare Tunnel token | `/etc/cloudflared` | Files |
| Backup settings (where backups go, including that login) | `/etc/server-backup` | Files, **without** the backup password |
| Firewall, SSH settings | `/etc/default/docker-port-guard`, `/etc/ssh/sshd_config.d`, `/etc/ssh/ca.pub`, `/etc/ssh/principals` | Files, when present |
| A list of what was there | manifest: Coolify version, volumes and sizes, containers | Text file in each backup |

Not backed up, on purpose: the backup password; the raw files of Coolify's
live database (the dump replaces them); Coolify's metrics (`/data/coolify/sentinel`,
`/data/coolify/metrics`); unnamed Docker volumes; Docker images and containers
(Coolify rebuilds them from GitHub when you click Redeploy).

Old backups are cleaned up every night: the last **7 daily, 4 weekly and 12
monthly** backups are kept. A check runs every Sunday and reads back a random
5% of the stored data to prove it is still intact.

About databases of other apps: Card Vault's SQLite database gets a safe copy
from its own script. If you later add an app with its own PostgreSQL or MySQL
in Coolify, its live files are copied as they are, which is usually fine but not
guaranteed. For those, switch on Coolify's own scheduled database backup (it
writes to `/data/coolify/backups`, which is included), or add a hook (see below).

## Installing

`bootstrap.sh` installs the program to `/usr/local/sbin/server-backup`. By hand:

```
sudo install -m 755 server-backup /usr/local/sbin/server-backup
```

## Setting up (once)

You need: the address of your SFTP or FTP server, a user name, and either a
password or (for SFTP) a private key file on this server.

1. Run `sudo server-backup setup`.
2. Choose the kind of server: **1** SFTP (best), **2** FTPS (FTP with
   encryption), or **3** plain FTP. Plain FTP sends your FTP password
   unencrypted, so you have to type `YES` to use it (the backup data itself is
   still encrypted).
3. Type the address, port, user name and folder. Passwords are typed hidden.
4. SFTP: the server's fingerprints are shown. If your provider lists them,
   compare; then answer `y`. FTPS with a home or NAS certificate: its
   fingerprint is shown; type `YES` to accept it. Every backup then checks that
   the certificate is still the same.
5. **Write the backup password into your password manager**, then type `SAVED`.
6. Answer `y` to make the first backup now.

Settings end up in `/etc/server-backup/` (root only). Backups then run every
night at 02:30 (up to 30 minutes later, chosen at random).

## Everyday commands

```
sudo server-backup status      one screen: last backup, result, next run
sudo server-backup list        all backups, newest first, with their ID
sudo server-backup run         make a backup now (run --dry-run: only show what would happen)
sudo server-backup check       check the stored backups now
```

## "I deleted something": getting files back

This never touches the live server. Files come back into a separate folder.

```
sudo server-backup restore-files                      asks what to restore, from the newest backup
sudo server-backup restore-files --volume abc123_cardvault-data
sudo server-backup restore-files --snapshot 1a2b3c4d /data/coolify/proxy
sudo server-backup restore-files --target /var/lib/server-backup/restores/tunnel /etc/cloudflared
```

The files appear under `/var/lib/server-backup/restored-<date>/` (or your
`--target`), with their full path, for example
`/var/lib/server-backup/restored-20261115-101500/var/lib/docker/volumes/abc123_cardvault-data/_data/`.
Copy back what you need. Card Vault also keeps its own copies in
`/data/backups` inside its volume.

## After losing the server: full recovery

You need: your password manager (backup password, backup server login) and a
new Ubuntu 24.04 server.

1. Create the new server and run `bootstrap.sh` on it, in the **same mode**
   as before (with `--cloudflare` if you used Cloudflare Tunnel). This installs
   a fresh, empty Coolify. Do not set anything up in Coolify.
2. If your backups go to SFTP with a key: copy that private key to the new
   server, for example to `/root/.ssh/backup_key` (`chmod 600` it).
3. Run `sudo server-backup restore-dr`.
4. Type the backup server's details exactly as during setup, then the backup
   password from your password manager.
5. Read the summary (which backup, which apps and volumes). Type `RESTORE`.
   It downloads the backup, stops Coolify, puts back Coolify's database, its
   settings and APP_KEY, every app's data, the Cloudflare token and the SSH
   settings, and starts Coolify again. Nothing is deleted: whatever was on the
   new server before is moved to `/var/lib/server-backup/pre-restore-<date>/`.
6. Open Coolify in the browser and log in with your **old** Coolify email and
   password.
7. For **each app**, open it and click **Redeploy**. Coolify rebuilds it from
   GitHub and it finds its restored data. Start with Card Vault and check
   that your cards and photos are there.
8. Direct mode: point your domain names (DNS) to the new server's IP address.
   Cloudflare mode: in Cloudflare (Zero Trust, Networks, Tunnels) the tunnel
   should show as Healthy within a minute.
9. Keep the old server switched off if it still exists.
10. Run `sudo server-backup status` the next day: the nightly backups continue
    into the same backup store.

Options: `--snapshot ID` restores an older backup (IDs from `list`),
`--dry-run` only checks the login and password and shows what would be restored.

## Testing a restore (do this once a year)

- Quick: `sudo server-backup restore-files --volume <a volume from list>` and
  look at the files in `/var/lib/server-backup/restored-*`. Delete that folder
  afterwards.
- Full: rent a small server for an hour, follow "After losing the server" on
  it with `--dry-run` first and then for real, check Card Vault, and delete
  that server again. With Cloudflare Tunnel, the test server joins your live
  tunnel as soon as the token is restored and may receive visitors: run
  `sudo systemctl stop cloudflared` on it right after the restore.

## Hooks

Every executable file in `/etc/server-backup/hooks.d/` runs before each backup
(as root, in name order). The shipped `10-cardvault` runs
`sh scripts/container/backup.sh` inside every running container whose name,
image or labels contain `cardvault` or `card-vault`. If a hook fails, the
backup is still made but marked as failed, so you notice.

## For check.sh: status file

`/var/lib/server-backup/last-status` (readable by everyone, no secrets), one
`key=value` per line:

| Key | Meaning |
|---|---|
| `time`, `epoch` | last backup attempt (UTC ISO time, Unix seconds) |
| `success` | `yes` or `no` |
| `snapshot` | ID of the last saved backup |
| `size_bytes`, `size`, `added_bytes` | total size backed up, and new data sent |
| `error` | plain explanation when `success=no` |
| `warning` | for example files that changed while being read (backup still OK) |
| `duration_seconds` | how long it took |
| `check_time`, `check_epoch`, `check_success`, `check_error` | last weekly check |
| `restore_time`, `restore_snapshot` | last full recovery on this server |

Exit codes of the program: 0 OK, 1 failed, 2 wrong usage, 3 not set up yet,
75 another backup, check or restore is running.

## Files

- `server-backup`: the program (bash).
- `/etc/server-backup/config`: destination (no passwords), `rclone.conf`
  (destination login, password obscured), `known_hosts` (SFTP fingerprints),
  `ssh-key` (SFTP key copy), `restic-password` (never backed up), `hooks.d/`.
- systemd: `server-backup.timer` (daily), `server-backup-check.timer` (weekly).
- `tests/`: end to end tests in containers (`tests/images/build.sh`, then
  `tests/e2e.sh sftp`, `tests/e2e.sh ftps`, `tests/e2e.sh extras`, and
  `tests/real-coolify.sh` with the real Coolify installer).

## Good to know

- Backups go over SFTP or FTPS encrypted twice (connection and data). With
  plain FTP only the data is encrypted; the FTP login can be read on the way.
- Coolify's live database is restored from its dump; the dump must come from
  the same or an older PostgreSQL version than the new server runs. If not,
  `restore-dr` stops before changing anything and tells you how to upgrade.
- The backup store can be opened by any computer with restic and rclone, the
  login and the backup password, even without this program.
