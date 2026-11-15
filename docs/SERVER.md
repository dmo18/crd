# Your app server: setup guide (Cloudflare)

One Ubuntu machine on your Hyper-V host runs **Coolify**, a free dashboard
that hosts Card Vault and every app you build later, each on its own
subdomain. The server has **no open ports**: visitors reach it only through
Cloudflare, and you reach the admin side only after a Cloudflare sign-in.

```
visitor  ->  Cloudflare  ->  tunnel  ->  server  ->  app.yourdomain.com
you      ->  Cloudflare sign-in  ->  tunnel  ->  dashboard / browser SSH
```

New apps are **private by default** (Cloudflare sign-in first). You make an
app public with one click. Your main website is not touched.

Time: about an hour, mostly waiting. Cost: $0.
In the steps below, replace `yourdomain.com` with your domain.

## 1. Create the Ubuntu machine (Hyper-V)
1. New virtual machine, **Generation 2**, at least **2 CPUs, 4 GB memory,
   60 GB disk**, on the network that gives it internet access.
2. Install **Ubuntu Server 24.04 LTS** (Secure Boot template: "Microsoft
   UEFI Certificate Authority"). Accept the defaults; create your user and a
   strong password (you will use it for browser SSH). Skip extra snaps.

## 2. Create the tunnel (Cloudflare, about 5 minutes)
1. Cloudflare dashboard, **Zero Trust**, **Networks**, **Tunnels**,
   **Create a tunnel**, type **Cloudflared**, name it `app-server`.
2. On the install screen, copy the long **token** (the text after
   `--token` in the command shown). Do not run that command; my setup does
   it. Keep the token somewhere private for step 3.
3. Leave this page open; you add the routes in step 5.

## 3. Run the setup command (Hyper-V console, once)
In the console window, signed in as your user, use **Clipboard, Type
clipboard text** to paste:

```
curl -fsSL https://raw.githubusercontent.com/dmo18/crd/main/infra/ubuntu/bootstrap.sh -o bootstrap.sh && sudo bash bootstrap.sh --cloudflare admin.yourdomain.com you@example.com
```

When asked, paste the tunnel token (it is not shown as you type).
Takes 10 to 15 minutes. It updates Ubuntu, closes every inbound port,
starts the tunnel, turns on automatic updates, and installs Coolify. At the
end it prints a **temporary dashboard password**. Write it down.

## 4. Mark your existing subdomains public (before step 6)
Step 6 puts a sign-in in front of every subdomain. Your main site's
subdomains must stay open:
1. Cloudflare, your domain, **DNS**, **Records**. Note every record with
   an orange cloud (Proxied) whose name is a subdomain, for example `www`.
   The bare domain itself is not affected.
2. These go into the **Public** list in step 6.

## 5. Add the tunnel routes (Cloudflare)
Back on the tunnel, **Public Hostname** tab, add these **in this order**
(Type, then URL):

| # | Subdomain | Path | Type | URL |
|---|---|---|---|---|
| 1 | `admin` | `^/app/` | HTTP | `127.0.0.1:6001` |
| 2 | `admin` | `^/terminal/ws` | HTTP | `127.0.0.1:6002` |
| 3 | `admin` | (empty) | HTTP | `127.0.0.1:8000` |
| 4 | `ssh` | (empty) | SSH | `127.0.0.1:22` |
| 5 | `*` | (empty) | HTTP | `127.0.0.1:80` |

Cloudflare creates the DNS records for 1 to 4 itself. For row 5, in **DNS**,
add a **CNAME** record: name `*`, target `<tunnel id>.cfargotunnel.com`
(the tunnel id is on the tunnel page), Proxied (orange cloud). Existing
records like `www` keep winning over the `*` record.

## 6. Add the sign-in rules (Cloudflare Access)
**Zero Trust**, **Access**, **Applications**, **Add an application**,
**Self-hosted**. Create these three:

1. **All apps (private)**: domain `*.yourdomain.com`. Policy: Action
   **Allow**, Include **Emails**: your email. This is the private by
   default rule.
2. **Browser SSH**: domain `ssh.yourdomain.com`, same Allow policy. Under
   **Browser rendering**, choose **SSH**.
3. **Public apps**: domain: each subdomain from step 4 (for example
   `www.yourdomain.com`), plus `cards.yourdomain.com`. Policy: Action
   **Bypass**, Include **Everyone**.

A specific subdomain rule wins over the `*` rule, so anything in Public
apps opens without a sign-in. **To make any app public later: add its
address to Public apps. To make it private again: remove it.**

Sign-in method: Zero Trust, **Settings**, **Authentication**: the email
**One-time PIN** is on by default (a code to your inbox). You can add
Google too.

## 7. Secure the dashboard
1. Open `https://admin.yourdomain.com`, pass the Cloudflare sign-in, then
   sign in to Coolify with your email and the temporary password.
2. **Settings**: Instance's domain `https://admin.yourdomain.com`; turn
   **Registration allowed** OFF; turn **Auto update** ON (keeps Coolify on
   its latest release).
3. **Profile**: change the password, turn on **Two-factor
   authentication**, save the recovery codes.
4. Browser SSH (`https://ssh.yourdomain.com`, your Ubuntu user and
   password) or the console:
   `sudo rm /root/coolify-first-login.txt` and
   `sudo sed -i '/^ROOT_USER_PASSWORD=/d' /data/coolify/source/.env`

## 8. Protect your GitHub account
Coolify builds your apps from GitHub. Turn on GitHub **two-factor
authentication**, and in the `crd` repository add a branch rule for `main`
that requires a pull request.

## 9. Add Card Vault
In the dashboard:
1. **Projects**, **+ New**, **Public Repository**,
   `https://github.com/dmo18/crd`, Check Repository.
2. Build Pack **Docker Compose** (`/docker-compose.yaml`).
3. Domain for `cardvault`: `https://cards.yourdomain.com:3000`
   (the `:3000` is the port inside the app). Under **Advanced**, turn
   **Redirect HTTP to HTTPS** off (Cloudflare already does HTTPS).
4. **Environment Variables**: add `CLIENT_IP_HEADER` = `cf-connecting-ip`.
5. **Deploy** (5 to 10 minutes the first time).
6. **Scheduled Tasks**: add `sh scripts/container/backup.sh`, every day at
   03:17 (`17 3 * * *`).
7. **Automatic deploys**: in GitHub, the `crd` repository, **Settings**,
   **Webhooks**, add the webhook URL and secret Coolify shows under the
   app's **Webhooks** tab, so every merged update deploys by itself.

## 10. Choose your Card Vault password (phone)
1. Coolify, the app, **Environment Variables**: copy `SETUP_CODE`.
2. Open `https://cards.yourdomain.com`, tap **Set your password**, paste
   the code, choose a passphrase of 16 or more characters.
3. **More**, **Connection check**: "Public address" should match, and
   "IP used for sign-in limits" should be your phone's internet address.
4. Scan a card. **Add to Home Screen** makes it open like an app.

## Adding your next app
1. Coolify, **+ New**, point it at the app's GitHub repository.
2. Domain `https://newapp.yourdomain.com` (plus `:port` if the app listens
   on one), **Redirect HTTP to HTTPS** off, Deploy.
3. It is live and **private** (Cloudflare sign-in). To make it public,
   add `newapp.yourdomain.com` to the **Public apps** list (step 6).

No DNS or tunnel changes needed for new apps.

## Staying up to date
| Piece | How |
|---|---|
| Ubuntu, Docker, the tunnel | Install automatically every night; restart at 04:30 only if needed |
| Coolify | Auto update setting (step 7) |
| Card Vault and its parts | GitHub proposes updates every Monday; checks run on each; merge, and the webhook deploys |
| Your other apps | The same: GitHub weekly update proposals plus a Coolify webhook each |

## Checking the server
In browser SSH run `sudo bash check.sh` (download it like bootstrap.sh from
`infra/ubuntu/check.sh`). It prints PASS or WARN for the tunnel, open
ports, firewall, SSH settings, pending updates and reboots.

## If something goes wrong
- Site shows a Cloudflare error 1033 or 502: the tunnel is down. In the
  console: `sudo systemctl restart cloudflared`.
- Locked out of Cloudflare sign-in: the Hyper-V console always works.
- Lost the Coolify 2FA phone: sign in with a saved recovery code.
- Card Vault does not start: Coolify, the app, **Logs**.

## Backups
Card Vault keeps 14 nightly backups inside its storage on this server. Keep
a copy elsewhere too: download one now and then, or add an S3 compatible
storage (for example Cloudflare R2, which has a free tier) in Coolify.
