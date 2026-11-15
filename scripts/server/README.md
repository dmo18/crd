# Server scripts

All scripts work from `CV_HOME` (default `$HOME/cardvault`). Run them as the
same user that owns that folder. Node comes from nvm.

- `common.sh`: shared settings. Not run on its own. Reads only the `PORT` line
  from `shared/.env.local` (default 3210). Writes `shared/logs/ops.log`.
- `start.sh`: starts the app in the background, listening on 127.0.0.1 only, so
  it is reachable only through Apache. Waits up to 60 seconds for it to answer.
  Refuses to start if it is already running.
- `stop.sh`: stops the app politely, forces it after 20 seconds. Only touches
  the saved process if it is really the app.
- `watchdog.sh`: checks `/api/health`. If it fails twice, 5 seconds apart, it
  stops and starts the app. Two runs never overlap. Also trims `app.log` when
  it passes 20 MB (keeps 3 older copies).
- `backup.sh`: copies the database safely while the app runs, adds the photos,
  and saves `shared/backups/cardvault-DATE-TIME.tar.gz`. Keeps the newest 14.
  The secrets file `.env.local` is never put in a backup, so keep your own safe
  copy of it (password manager).
- `restore.sh <backup file>`: asks you to type RESTORE, stops the app, moves the
  current `shared/data` to `shared/data.before-restore-DATE-TIME` (never
  deleted), unpacks the backup, starts the app and checks it. Add `--yes` to skip
  the question.
- `../backup-db.mjs`: the database copy step used by `backup.sh`.

## Cron lines

Add these in the Cloudways panel (Server, Cron Job Management, Advanced) or
with `crontab -e`:

```
* * * * * $HOME/cardvault/current/scripts/server/watchdog.sh >/dev/null 2>&1
17 3 * * * $HOME/cardvault/current/scripts/server/backup.sh >/dev/null 2>&1
```

The watchdog also starts the app again after a server restart.

## Getting a backup onto your phone or computer

1. In Cloudways, open Servers, then your server, then Master Credentials, and
   note the public IP, username and password (turn on SFTP if asked).
2. Use an SFTP app (FileZilla on a computer, or a phone app such as Termius or
   Secure ShellFish) with that IP, port 22, and those credentials.
3. Open `cardvault/shared/backups/` and download the newest
   `cardvault-....tar.gz`.

Keep a copy somewhere other than the server now and then.
