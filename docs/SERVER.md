# Your app server: setup guide

One Ubuntu machine on your Hyper-V host runs **Coolify**, a free dashboard
that hosts Card Vault and every app you build later, each on its own
subdomain. The server has **no open ports**: visitors reach it only through
Cloudflare, and you reach the admin side only after a Cloudflare sign-in.

```
visitor  ->  Cloudflare  ->  tunnel  ->  server  ->  app.yourdomain.com
you      ->  Cloudflare sign-in  ->  tunnel  ->  dashboard / browser SSH
```

- New apps are **private by default**; you make an app public with one click.
- Nothing on the server changes by itself except Ubuntu security patches.
  You install everything else when you choose.
- Everything is backed up nightly, encrypted, to your own SFTP or FTPS
  server, and can be rebuilt on a new machine.
- Your main website stays where it is.

Time: about 90 minutes, mostly waiting. Software cost: $0 (Cloudflare's free
plan covers the tunnel and up to 50 sign-in users). You provide the Hyper-V
host, the domain, and an SFTP or FTPS server for backups.

In the steps, replace `yourdomain.com` with your domain. Menu names in
Cloudflare and Coolify change from time to time: if you cannot find one,
use the search box at the top of their dashboard.

## 1. Create the Ubuntu machine (Hyper-V)
1. New virtual machine, **Generation 2**, at least **2 CPUs, 4 GB memory,
   60 GB disk**, on the network that gives it internet access.
2. Install **Ubuntu Server 24.04 LTS** (Secure Boot template: "Microsoft
   UEFI Certificate Authority"). Accept the defaults; create your user.
   Skip extra snaps.
3. In Hyper-V, the machine's **Settings**, **Automatic Start Action**:
   "Always start this virtual machine automatically", so it comes back
   after the host restarts.

## 2. Write down your existing subdomains (Cloudflare)
The private-by-default rule in step 4 covers every subdomain. Your main
site's subdomains must stay open, so list them first:
Cloudflare, your domain, **DNS**, **Records**: note every record with an
orange cloud (Proxied) whose name is a subdomain, for example `www`. The
bare domain is not affected. Also note any existing `admin` or `ssh`
records: delete them, or pick other names for steps 4 and 5.

## 3. Create the tunnel (Cloudflare)
1. **Zero Trust**, **Networks**, **Tunnels**, **Create a tunnel**, type
   **Cloudflared**, name it `app-server`.
2. On the install screen copy the long **token** (the text after `--token`).
   Do not run the command shown; my setup does it. Keep the token private.

## 4. Add the sign-in rules (Cloudflare Access) BEFORE the routes
A route is live the moment it is saved, so the rules come first.
**Zero Trust**, **Access**, **Applications**, **Add an application**,
**Self-hosted**. Create these five:

1. **All apps (private)**: domain `*.yourdomain.com`. Policy: Action
   **Allow**, Include **Emails**: your email.
2. **Server dashboard**: domain `admin.yourdomain.com`, same Allow policy,
   **Session duration 24 hours**.
3. **Browser SSH**: domain `ssh.yourdomain.com`, same Allow policy (Allow
   only; Cloudflare does not support Bypass here), session 24 hours. Under
   **Browser rendering**, choose **SSH**.
4. **GitHub deploy notices**: domain `admin.yourdomain.com`, path
   `webhooks/source/github/events`, Action **Bypass**, Include **Everyone**.
   This lets GitHub tell Coolify about updates; nothing else is opened.
5. **Public apps**: domain: each subdomain from step 2 (for example
   `www.yourdomain.com`) plus `cards.yourdomain.com`. Action **Bypass**,
   Include **Everyone**. **Never add `admin`, `ssh` or `*` here.**

Then the certificate for browser SSH (no passwords are used):
**Zero Trust**, **Access**, **Service credentials** (or Access controls),
**SSH**, **Add a certificate**, choose the **Browser SSH** application,
**Generate certificate**, and copy the **public key**. You paste it in step 6.

## 5. Add the tunnel routes (Cloudflare)
Back on the tunnel, **Routes** (older dashboards: **Public Hostname**), add
these **in this order**:

| # | Subdomain | Path | Type | URL | Protect with Access |
|---|---|---|---|---|---|
| 0 | `admin` | `^/webhooks/source/github/events(/manual)?$` | HTTP | `127.0.0.1:8000` | no |
| 1 | `admin` | `^/app/` | HTTP | `127.0.0.1:6001` | Server dashboard |
| 2 | `admin` | `^/terminal/ws` | HTTP | `127.0.0.1:6002` | Server dashboard |
| 3 | `admin` | (empty) | HTTP | `127.0.0.1:8000` | Server dashboard |
| 4 | `ssh` | (empty) | SSH | `127.0.0.1:22` | Browser SSH |
| 5 | `*` | (empty) | HTTP | `127.0.0.1:80` | (leave off) |

"Protect with Access" is under each route's **Additional application
settings**, **Access**: it makes the tunnel refuse admin and SSH requests
that did not pass your sign-in, even if a rule is changed by mistake. If
that menu is missing in your dashboard, skip it; step 4 still protects them.

For row 5, in **DNS** add a **CNAME**: name `*`, target
`<tunnel id>.cfargotunnel.com` (the id is on the tunnel page), Proxied.
Records that already exist (like `www`) keep pointing where they do.

## 6. Run the setup (Hyper-V console, once)
In the console, signed in as **your own user**, use **Clipboard, Type
clipboard text** to paste this line:

```
curl -fsSL https://github.com/dmo18/crd/archive/refs/heads/main.tar.gz | tar xz && cd crd-main/infra/ubuntu && sudo bash bootstrap.sh --cloudflare admin.yourdomain.com you@example.com
```

It asks for: the tunnel token (hidden), the email you use for Cloudflare,
the SSH certificate public key from step 4 (press Enter to add it later
with `sudo server-ssh-ca set`), and whether to set up alerts now.
Takes 15 to 20 minutes. At the end it prints a **temporary Coolify
password**. Write it down.

It closes every inbound port, starts the tunnel, turns on automatic Ubuntu
security patches (and nothing else), log limits, a weekly security audit,
the agent account, the backup tool, and installs Coolify.

## 7. Set up alerts (if you skipped it in step 6)
`sudo server-alert setup` and choose:
- **Telegram**: in Telegram talk to **@BotFather**, send `/newbot`, copy
  the token, then send your new bot any message; paste the token when asked.
- **Discord**: your server, **Server Settings**, **Integrations**,
  **Webhooks**, **New Webhook**, **Copy Webhook URL**; paste it when asked.

A test message arrives. You will be alerted about failed backups, a full
disk, the tunnel or Docker stopping, unhealthy apps, security updates
waiting, and bursts of blocked logins.

## 8. Set up backups
`sudo server-backup setup`, choose **SFTP** (best) or **FTPS**, and enter
your backup server's details. It shows a **backup passphrase once**: save it
in your password manager now. **Without it no backup can ever be
restored.** Then run `sudo server-backup run` once and check
`sudo server-backup status` says it worked.
Backups run nightly at about 02:30, keep 7 daily, 4 weekly and 12 monthly
copies, and are checked for damage weekly.

Protect the backups from the server itself: if the server were ever taken
over, it could delete its own backups. On your backup server, turn on its
own snapshots or versioning (most NAS and hosting panels have it), or give
the backup account permission to add files but not delete them. Restores
also warn you if the newest backup looks older than it should.

## 9. Secure the Coolify dashboard
1. Open `https://admin.yourdomain.com`, pass the Cloudflare sign-in, sign
   in to Coolify with your email and the temporary password.
2. Coolify shows welcome steps: choose **This Machine** (localhost) as the
   server and let it start the proxy.
3. **Settings**: Instance's domain `https://admin.yourdomain.com`;
   **Registration allowed** OFF; **Auto update** OFF (you update Coolify
   from Settings when you choose); **Redirect HTTP to HTTPS** off.
4. **Profile**: change the password, turn on **Two-factor
   authentication**, save the recovery codes.
5. In the console: `sudo rm /root/coolify-first-login.txt` and
   `sudo sed -i '/^ROOT_USER_PASSWORD=/d' /data/coolify/source/.env`

## 10. Protect your GitHub account
Coolify builds your apps from GitHub. Turn on GitHub **two-factor
authentication**, and in the `crd` repository add a branch rule for `main`
that requires a pull request.

## 11. Add Card Vault
In Coolify:
1. **Projects**, **+ New**, **Public Repository**,
   `https://github.com/dmo18/crd`, Check Repository.
2. Build Pack **Docker Compose** (`/docker-compose.yaml`).
3. Domain for `cardvault`: `https://cards.yourdomain.com:3000` (the
   `:3000` is the port inside the app). **Advanced**: **Redirect HTTP to
   HTTPS** off.
4. **Environment Variables**: add `CLIENT_IP_HEADER` = `cf-connecting-ip`.
   Optional alerts from the app itself: `ALERT_TELEGRAM_BOT_TOKEN` and
   `ALERT_TELEGRAM_CHAT_ID`, or `ALERT_DISCORD_WEBHOOK_URL`.
5. **Deploy** (5 to 10 minutes the first time).
6. **Webhooks** tab: copy the URL and secret into GitHub, the `crd`
   repository, **Settings**, **Webhooks**, so merged updates deploy.
7. **Save these values in your password manager**: Coolify, the app,
   Environment Variables (they are also in the server backup).

## 12. Choose your Card Vault password (phone)
1. Coolify, the app, **Environment Variables**: copy `SETUP_CODE`.
2. Open `https://cards.yourdomain.com`, tap **Set your password**, paste
   the code, choose a passphrase of 16 or more characters.
3. **More**, **Connection check**: the address should match and "IP used
   for sign-in limits" should be your phone's internet address.
4. **More**, **Send a test alert** if you set app alerts.
5. Scan a card. **Add to Home Screen** makes it open like an app.

## Adding your next app
1. Coolify, **+ New**, point it at the app's GitHub repository.
2. Domain `https://newapp.yourdomain.com` (plus `:port` if needed),
   **Redirect HTTP to HTTPS** off, Deploy.
3. It is live and **private**. No DNS or tunnel change is needed (the `*`
   route in step 5 covers it).
4. To make it public: add `newapp.yourdomain.com` to **Public apps**
   (step 4). A public app must have its own login if it holds anything
   private. To make it private again: remove it.

## Updates: only when you say so
| Piece | How it updates |
|---|---|
| Ubuntu security patches | By themselves, daily. The server never restarts by itself. |
| Everything else on the server (Ubuntu, Docker, the tunnel) | `sudo server-update`: shows what is waiting, backs up first, asks before a restart. A new Docker major version also needs `--allow-docker-major`. |
| Coolify | Coolify, **Settings**, update button, when you choose. |
| Card Vault and your apps | GitHub proposes updates every Monday as pull requests with automatic checks. Nothing changes until one is merged; then Coolify deploys it. |

`sudo server-check` says when updates are waiting, and alerts warn if
security updates are stuck or a restart has been waiting more than a week.

## Checking the server
`sudo server-check`: PASS or WARN for the tunnel, open ports, firewall,
SSH, updates, backups, alerts, logs, the security audit score and the
agent account. Browser SSH is at `https://ssh.yourdomain.com`.

## Getting help (from Claude)
1. `sudo server-support` and then `sudo cat` the file it names.
2. Copy all of it and paste it to Claude (any Claude Code session).
   Passwords, tokens and keys are removed automatically.

## Optional: an AI agent on the server
Start it from the console or browser SSH with `sudo -iu ops-agent`. It
reads its guide (`~/CLAUDE.md`) and can check, read logs and run backups.
It cannot change anything live. To approve one change it proposes:
`sudo server-agent-grant "<exact command>" 30m`. Every command it runs is
recorded.

## Disaster recovery (the server is lost)
1. Create a new Ubuntu machine (step 1) and run step 6 with the same mode.
2. `sudo server-backup restore-dr`, enter your backup server details and the
   **backup passphrase**, type `RESTORE`.
3. Coolify comes back with all its settings and passwords. In Coolify,
   **Redeploy** each app; they reattach to their restored data.
4. Check with `sudo server-check` and open your apps.
Details: `infra/ubuntu/backup/README.md`.

To get back one deleted thing instead: `sudo server-backup restore-files`.

## If something goes wrong
| You see | Do this |
|---|---|
| Cloudflare error 1033 or 502 | Tunnel down: `sudo systemctl restart cloudflared`, then `sudo server-check` |
| An app shows an error | Coolify, the app, **Logs**; if a new version broke it, **Deployments**, redeploy the previous one |
| Disk full alert | `sudo server-check` shows what is big; ask Claude with `sudo server-support` |
| Backup failed alert | `sudo server-backup status` shows the reason (often the backup server's password or space) |
| Cannot sign in to Cloudflare | The Hyper-V console always works |
| Lost the Coolify 2FA phone | Sign in with a saved recovery code |
| Anything else | `sudo server-support` and paste it to Claude |

## Photos and space
Card photos are stored compactly (about 60 KB per card for front and back).
**More** in Card Vault shows how much space photos use.
