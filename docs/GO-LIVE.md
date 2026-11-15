# Putting Card Vault online (Cloudways)

Card Vault runs as a **new, separate app** on your existing Cloudways server.
Your current website is not changed. Cost: $0 extra (Cloudways bills per
server, not per app). Time: about 30 minutes, mostly waiting.

You need: your Cloudways login, and access to your domain's DNS settings.

## 1. Check the server has room
Cloudways, **Servers**, your server, **Monitoring**.
- 2 GB of memory or more: good.
- 1 GB: scale up to 2 GB first (**Vertical Scaling**), or the build may
  run out of memory next to your existing site.

## 2. Add the app
1. **Applications**, **Add Application**.
2. Server: your existing server.
3. Application: **Custom PHP** (it is only a shell, Card Vault replaces it).
4. Name it **Card Vault**.
5. Open the new app, **Application Settings**. Write down the **folder
   name** (letters and numbers, for example `abcdxyz123`).
6. In the same place, turn **Varnish** off for this app only.

## 3. Give it a web address
1. In your DNS settings (where your domain is managed), add an **A record**:
   name `cards`, value = your server's **Public IP** (Cloudways, Servers).
2. Cloudways, the Card Vault app, **Domain Management**: add
   `cards.yourdomain.com` and make it primary.
3. **SSL Certificate**: choose Let's Encrypt, enter
   `cards.yourdomain.com`, install. (DNS can take up to an hour first.)

## 4. Ask Cloudways support one thing
Open the chat bubble in Cloudways and paste:

> Please enable Apache mod_proxy and mod_proxy_http for my application
> "Card Vault" on server [your server name]. I proxy it to a Node.js
> process on 127.0.0.1:3210 with an .htaccess RewriteRule [P] rule.

## 5. Run the installer
1. Cloudways, **Servers**, your server, **Master Credentials**,
   **Launch SSH Terminal** (opens in the browser; a tablet or computer is
   easier than a phone for this step).
2. Paste this, with your address and the folder name from step 2:

```
curl -fsSL https://raw.githubusercontent.com/dmo18/crd/main/scripts/server/install.sh -o install.sh && bash install.sh https://cards.yourdomain.com FOLDERNAME
```

3. When asked, choose your Card Vault password: a long passphrase, at
   least 16 characters, used nowhere else. It is not shown as you type.
4. Wait for **Card Vault is running.** (5 to 10 minutes.)

The installer also schedules a check every minute that restarts Card Vault
if it stops (including after a server restart) and a backup every night.
If it prints two lines to add under Cron Job Management, add them there.

## 6. Sign in and check
1. On your phone open `https://cards.yourdomain.com` and sign in.
2. **More**, **Connection check**: "IP used for sign-in limits" should
   be your phone's internet address. If it shows `127.0.0.1` or the server's
   address, tell me what it shows and I will give you the one setting to
   change.
3. Scan one card to confirm everything works.

Tip: in your phone browser use **Add to Home Screen** so Card Vault opens
like an app.

## Later
| To | Run in the SSH terminal |
|---|---|
| Update to the newest version | `~/cardvault/current/scripts/server/update.sh` |
| Go back one version | `~/cardvault/current/scripts/server/rollback.sh` |
| Back up now | `~/cardvault/current/scripts/server/backup.sh` |
| Restore a backup | `~/cardvault/current/scripts/server/restore.sh <file>` |

Updates back up your data first and go back by themselves if the new
version does not start. Backups (last 14 nights) are in
`~/cardvault/shared/backups`. Download one now and then through Cloudways
SFTP so a copy lives off the server. Backups never include your password
settings.

## If something goes wrong
- The address shows a Cloudways or blank page: step 4 is not done yet, or
  DNS has not caught up.
- "Card Vault did not start": the reason is at the end of
  `~/cardvault/shared/logs/app.log`.
- Health check (anyone can open it, it shows nothing private):
  `https://cards.yourdomain.com/api/health` should show `{"ok":true}`.
