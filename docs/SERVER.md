# Your app server: setup guide

One Ubuntu machine on your Hyper-V host runs **Coolify**, a free web
dashboard that hosts Card Vault and any app you build later. Only web
traffic (HTTPS) is open to the internet. Everything after step 3 happens
in your browser.

Time: about 45 minutes, mostly waiting. Cost: $0 in software.

You need: your Hyper-V host, your domain's DNS settings, and an email
address for the dashboard account.

## 1. Create the Ubuntu machine (Hyper-V)
1. New virtual machine, **Generation 2**, at least **2 CPUs, 4 GB memory,
   60 GB disk**, connected to the network that gives it its own public IP.
2. Install **Ubuntu Server 24.04 LTS** from the official ISO (in
   Generation 2, set Secure Boot template to "Microsoft UEFI Certificate
   Authority"). Accept the defaults; create your user and password.
   Do not install extra "snaps" when asked.
3. After the restart, sign in at the console and type `ip -4 addr` to see
   the public IP. Write it down.

## 2. Point two addresses at it (DNS)
At your domain's DNS settings, add two **A records**, both pointing to
that public IP:

| Name | Purpose |
|---|---|
| `admin` | the Coolify dashboard, for example admin.ssi.com |
| `cards` | Card Vault, for example cards.ssi.com |

(Or one wildcard record `*` to cover every future app at once.)

## 3. Run the setup command (console, once)
In the Hyper-V console window, signed in as your user, use
**Clipboard, Type clipboard text** to paste this one line, with your
dashboard address and email:

```
curl -fsSL https://raw.githubusercontent.com/dmo18/crd/main/infra/ubuntu/bootstrap.sh -o bootstrap.sh && sudo bash bootstrap.sh admin.ssi.com you@example.com
```

It takes 10 to 15 minutes. It updates Ubuntu, turns on the firewall (only
web traffic gets in, including a fix so Docker cannot open other ports),
turns off password logins over the network, adds automatic security
updates and brute force blocking, and installs Coolify.

At the end it prints a **temporary dashboard password** and a link like
`http://<your IP>:8000`. That link works for **30 minutes only**, then
closes by itself.

## 4. Secure the dashboard (browser, within those 30 minutes)
1. Open the printed link and sign in with your email and the temporary
   password.
2. **Settings**, Instance's domain: enter `https://admin.ssi.com`, save.
   Wait a minute, then open `https://admin.ssi.com` and sign in there.
   From now on use only that address.
3. **Profile**: change the password to a long passphrase you use nowhere
   else, then turn on **Two-factor authentication** with an
   authenticator app.
4. Back in the console, delete the note with the temporary password
   (the setup output says which file).

Missed the 30 minutes? Run `sudo bash bootstrap.sh admin.ssi.com` again
in the console to reopen the window.

## 5. Protect your GitHub account
Coolify builds your apps from GitHub, so whoever controls that account
controls the apps. In GitHub turn on **two-factor authentication**, and in
the `crd` repository add a rule for `main` that requires a pull request.

## 6. Add Card Vault
In the dashboard:
1. **Projects**, **+ New**, **Public Repository**, paste
   `https://github.com/dmo18/crd`, Check Repository.
2. Build Pack: **Docker Compose** (file `/docker-compose.yaml`).
3. Domain for `cardvault`: `https://cards.ssi.com:3000` (the `:3000` only
   tells Coolify which port inside the app to use; people use the normal
   address).
4. **Deploy** and wait until it shows healthy (5 to 10 minutes the first
   time).
5. **Scheduled Tasks**, add one: command `sh scripts/container/backup.sh`,
   every day at 03:17 (`17 3 * * *`).

## 7. Choose your Card Vault password (phone)
1. In Coolify, the Card Vault app, **Environment Variables**: copy the
   value of `SETUP_CODE`.
2. Open `https://cards.ssi.com` on your phone, tap **Set your password**,
   paste the code, choose a passphrase of 16 or more characters.
3. **More**, **Connection check**: "Public address" should say it matches,
   and "IP used for sign-in limits" should be your phone's internet
   address. If not, tell me what it shows.
4. Scan a card. Tip: **Add to Home Screen** makes it open like an app.

## Everyday
- **Updates**: when a new version is merged on GitHub, open the app in
  Coolify and press **Redeploy** (or turn on automatic deploys).
- **Backups**: nightly, 14 kept, inside the app's storage. Coolify can also
  back up the whole server; download a copy now and then.
- **Health check**: run `sudo bash check.sh` in the console any time
  (download it like bootstrap.sh from `infra/ubuntu/check.sh`). It prints
  PASS or WARN for each protection.
- **Your next app**: Projects, + New, point it at its GitHub repository,
  give it an address like `newapp.ssi.com`, Deploy. HTTPS is automatic.

## If something goes wrong
- Locked out of the network: the Hyper-V console always works. The
  undo steps are in `infra/ubuntu/README.md`.
- Card Vault does not start: Coolify, the app, **Logs** shows why.
- Dashboard 2FA device lost: in the console, `infra/ubuntu/README.md`
  explains how to reset it.

## What is open to the internet
Only ports 80 and 443 (web). The dashboard is protected by its password and
two-factor login. The terminal port and Coolify's internal ports are closed
from outside.
