# Server setup (Ubuntu 24.04 + Coolify)

**Cloudflare setup: follow docs/SERVER.md; this file is reference.**

Two scripts for the Ubuntu 24.04 LTS server that runs Coolify and, through it,
Card Vault. The server has its own internet address and no firewall in front of
it, so these scripts build the protection on the server itself.

There are two ways to run it:

| Mode | Command | What reaches the server from the internet |
| --- | --- | --- |
| Direct | `sudo bash bootstrap.sh admin.example.com you@example.com` | Only 80/443 (websites). The server answers them itself. |
| Cloudflare Tunnel | `sudo bash bootstrap.sh --cloudflare admin.example.com you@example.com` | Nothing. A program on the server (cloudflared) connects out to Cloudflare, and visitors and you come in through that connection. See [Cloudflare mode](#cloudflare-mode). |

The script remembers the mode. To change it later, run it again with
`--cloudflare` or `--direct`.

| File | What it does |
| --- | --- |
| `bootstrap.sh` | One-time setup (safe to run again): updates, automatic security patches, swap, SSH lockdown, firewall, container port block, fail2ban, Cloudflare Tunnel (Cloudflare mode), Coolify, log retention, alerts, security audit, auditd, the AI agent account. Installs the commands below. |
| `check.sh` | Read-only check you can run any time. Prints PASS, WARN or FAIL lines. Changes nothing. Installed as `server-check`. |
| `AGENT-GUIDE.md` | The guide for the AI agent; installed as `/home/ops-agent/CLAUDE.md`. |
| `backup/` | The backup tool `server-backup` (its own README). |

Put `check.sh` and `AGENT-GUIDE.md` (same release) in the same folder as
`bootstrap.sh` before running it; it installs them from there.

Commands that `bootstrap.sh` installs in `/usr/local/sbin/`:

| Command | What it does |
| --- | --- |
| `sudo server-update` | Installs every waiting update when you choose (see [Updates](#updates)). |
| `sudo server-ssh-ca set` | Saves Cloudflare's SSH CA key for browser SSH (Cloudflare mode). `status` shows it. |
| `sudo docker-port-guard ...` | The container port block: `apply`, `status`, `open-setup`, `close`, `check-config`. |
| `sudo server-check` | The installed copy of `check.sh`. |
| `sudo server-alert setup` | Alerts to Telegram or Discord (see [Alerts](#alerts)). Also `test`, `status`, `send`, `watch`, `digest`. |
| `sudo server-support` | One text file with everything needed to get help, secrets removed (see [Getting help](#getting-help)). |
| `sudo server-lynis show` | Last weekly security audit score and warnings; `run` audits now. |
| `sudo server-logs`, `server-docker-logs`, `server-status` | Read-only log and service views with secrets removed (used by the AI agent). |
| `sudo server-agent-grant "<command>" 30m` | Lets the AI agent run one approved change once (see [AI agent account](#ai-agent-account)). |
| `sudo server-note "<text>"` | Adds a line to the agent's work notes, `/var/log/ops-agent-notes.log`. |

## Before you start

1. A fresh Ubuntu 24.04 LTS server, at least 2 processors, 4 GB memory, 40 GB disk.
2. Pick the dashboard address, for example `admin.example.com`.
3. Direct mode only: at your domain provider, add a DNS **A record**:
   `admin.example.com` pointing to the server's internet address. Do this
   first: the HTTPS certificate can only be issued once this record works.

## Get the script (from a release, checked)

Always take the script from a **release** (a fixed, numbered version), not from
the newest code, and check its fingerprint before running it. In the examples
the release is `v1.0.0`; use the newest one listed at
https://github.com/dmo18/crd/releases

On the server, signed in as **your own user** (the one created when installing
Ubuntu, not root):

```
curl -fsSLO https://github.com/dmo18/crd/releases/download/v1.0.0/bootstrap.sh
curl -fsSLO https://github.com/dmo18/crd/releases/download/v1.0.0/bootstrap.sh.sha256
sha256sum -c bootstrap.sh.sha256
```

The last line must print `bootstrap.sh: OK`. If it prints `FAILED` or anything
else, stop: delete both files and download them again. `check.sh` comes the
same way (`check.sh` and `check.sh.sha256` from the same release).

The fingerprint file sits next to the script on GitHub, so it protects against
a broken or changed download and against running unreleased code, not against
someone who controls the GitHub account. For that extra step, compare the
fingerprint `sha256sum bootstrap.sh` prints with the one written in the
release notes or sent to you separately.

## Run it from the Hyper-V console

1. Open the server in Hyper-V (VMConnect) and log in as your own user.
2. Get and check the script as shown above.
3. Copy the run line on your computer, with your own addresses filled in:

   ```
   sudo bash bootstrap.sh admin.example.com you@example.com
   ```

4. In the VMConnect window choose **Clipboard > Type clipboard text**. The line
   is typed for you. Check it looks right, then press Enter.
5. Type your Ubuntu password when asked (for `sudo`).
6. The script takes about 5 to 10 minutes. If the server is smaller than
   recommended it asks "Continue anyway?". Type `y` and Enter to go on.
7. At the end it prints what it did and the next steps, including the
   Coolify login password. Leave the console open while you do them.

Always start it with `sudo` from your own account. Logged in as root (or with
`sudo` from root) it stops: it needs to know your account, because browser
SSH logs in to it.

To see what the script would change without changing anything:
`sudo bash bootstrap.sh --dry-run admin.example.com`

## First login to Coolify (direct mode)

The Coolify dashboard ports (8000, 6001, 6002) are blocked from the internet.
For the very first login the script opens 8000 and 6001 for **30 minutes**, and
they close again by themselves (also after a restart). The Coolify admin
account is created by the script with a long random password, so nobody else
can claim the dashboard during those minutes. The script asks for your
computer's internet address (search "what is my IP" on that computer); give it
and only your computer can use the window. Press Enter to allow any address.

1. On your computer open `http://<server address>:8000`. The browser says
   "Not secure". That is expected, for this one visit only.
2. Log in with the email and password the script printed. The details are also
   saved, readable only by root: `sudo cat /root/coolify-first-login.txt`
3. Follow Coolify's welcome steps and choose **This Machine** (localhost).
4. Open **Settings**. In **Domain** (Instance's Domain) type
   `https://admin.example.com` and press Save. Wait a minute or two.
5. Open `https://admin.example.com` (lock icon in the address bar) and log in.
6. In your profile: change the password, then turn on two-factor login.
7. Delete the saved password: `sudo rm /root/coolify-first-login.txt`
8. Optional, close the window early: `sudo docker-port-guard close`

Ran out of time? Open the window again, only for your computer:
`sudo docker-port-guard open-setup 30 203.0.113.7` (your address instead of
`203.0.113.7`; leave it out to allow any address). When you run
`bootstrap.sh` again later, it opens the window only if you answer `y`.

## Cloudflare mode

Visitors go to Cloudflare, and Cloudflare passes them through the tunnel to
this server. You reach the Coolify dashboard and a terminal (SSH in the browser)
the same way, after signing in to Cloudflare Access. No port is open on the
server at all, not even 22, 80 or 443. No Cloudflare password or API key is
stored on the server, only the tunnel token.

**The step by step guide is `docs/SERVER.md`.** This section explains what the
script does and why.

### What the script asks

1. **The tunnel token** (Zero Trust, Networks, Tunnels, your tunnel; the long
   text that starts with `eyJ`). Paste it when asked; what you type stays
   hidden. Never put it on the command line or in an environment variable:
   both end up in the shell history. For a run without a console, save it in
   a file only root can read and give that:
   `sudo bash bootstrap.sh --cloudflare --token-file /root/tunnel-token admin.example.com`
   (the file must belong to root with mode 600; delete it after the run).
   When you run the script again it offers to keep the token it already has.
   The token is saved in `/etc/cloudflared/tunnel-token`, readable only by root.
2. **The email you sign in to Cloudflare with** (Enter keeps the Coolify
   email). Cloudflare puts the part before the `@` (lower case) in the browser
   SSH certificate, so `jdoe@example.com` becomes `jdoe`. The script lets that
   name log in as your Ubuntu user, and nothing else.
3. **The SSH CA public key** for browser SSH (see below). No key yet? Press
   Enter to skip. Add it later on the console with `sudo server-ssh-ca set`
   (paste the key, press Enter). Until then browser SSH cannot log in; the
   Hyper-V console always works.

At the end the script prints the Coolify login (email and a random password).

### Order in Cloudflare: Access first, then routes

Create the Cloudflare Access applications **before** the tunnel routes. A route
is live the moment it is saved; without its Access application the dashboard
or the terminal would be reachable without a sign-in for that time.

Routes (tunnel, **Routes**, **Published application**), in this order
(Cloudflare uses the first that matches):

| # | Subdomain | Path | Service |
| --- | --- | --- | --- |
| 1 | `admin` | `^/webhooks/source/github/events` | HTTP, `127.0.0.1:8000` (GitHub tells Coolify to deploy) |
| 2 | `admin` | `^/app/` | HTTP, `127.0.0.1:6001` (live updates) |
| 3 | `admin` | `^/terminal/ws` | HTTP, `127.0.0.1:6002` (Coolify's terminal) |
| 4 | `admin` | (empty) | HTTP, `127.0.0.1:8000` (Coolify dashboard) |
| 5 | `ssh` | (empty) | SSH, `127.0.0.1:22` (terminal in the browser) |
| 6 | `*` | (empty) | HTTP, `127.0.0.1:80` (all apps, through Coolify's proxy) |

Notes:

- The path is a pattern: `^/app/` means "starts with /app/". Plain `app`
  would also catch dashboard pages such as `/project/.../application/...`.
- `127.0.0.1` instead of `localhost`: Coolify's ports do not answer on the
  IPv6 address that `localhost` can mean (Coolify's guide gives this fix).
- GitHub webhooks: GitHub cannot sign in to Cloudflare Access, so the webhook
  address needs a **Bypass** Access application for `admin.example.com` with
  path `webhooks/source/github/events` (Coolify's address is
  `/webhooks/source/github/events/manual`, see Coolify's `routes/webhooks.php`;
  Coolify still checks the webhook secret). Route 1 must **not** have "Protect
  with Access" turned on, because a bypassed request carries no Access token;
  routes 2 to 5 should have it.

### Browser SSH with short-lived certificates

There is no password for SSH at all, not even through the tunnel. When you open
`https://ssh.example.com` and pass the Cloudflare sign-in, Cloudflare creates
an SSH certificate for you that is valid for a few minutes, signed by your
Cloudflare account's SSH CA. The server trusts that CA and nothing else:

```
# /etc/ssh/sshd_config.d/01-server-hardening.conf (Cloudflare mode)
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
TrustedUserCAKeys /etc/ssh/ca.pub
AuthorizedPrincipalsFile /etc/ssh/principals/%u
```

- `/etc/ssh/ca.pub` holds the CA public key (set with `sudo server-ssh-ca set`).
- `/etc/ssh/principals/<your user>` holds the name from your Cloudflare email
  (before the `@`). Only your account has such a file, so a certificate can
  never log in as root or as anyone else.
- Cloudflare's guide asks for these lines "at the top" of `sshd_config`.
  Ubuntu's `sshd_config` includes `sshd_config.d/*.conf` on its first line and
  sshd uses the first value it reads, so the file above comes first.
- Certificates need sshd to accept the CA's key type. Ubuntu 24.04's default
  `PubkeyAcceptedAlgorithms` and `CASignatureAlgorithms` accept Cloudflare's
  ECDSA keys; `server-ssh-ca set` refuses a key type sshd would not accept,
  and `check.sh` checks it.
- Cloudflare's guide says the browser terminal expects your email name and your
  Ubuntu user to be the same. If they differ (`jdoe` and `john`), the script
  warns; type your Ubuntu user name when the terminal asks.

Where the key comes from: Cloudflare dashboard, **Zero Trust**, **Access
controls**, **Service credentials**, **SSH**, **Add a certificate**, choose the
browser SSH application (`ssh.example.com`), **Generate certificate**, then
copy the **CA public key** (one line, starts with `ecdsa-sha2-nistp256`).

Tested in a container with a locally made CA: a certificate for the mapped
name logs in as the owner's user; the same certificate as root, a certificate
for another name, the bare key, and every password login (from the server
itself and from another machine) are refused.

### Every app behind the tunnel

Give it its domain with `https://`, for example `https://cards.example.com`
(for Card Vault `https://cards.example.com:3000`, see `docs/SERVER.md`), and on
the app's **Domains** page set **Redirect HTTP to HTTPS** to **Disabled**.
Cloudflare does HTTPS for visitors; the last step from the tunnel to Coolify's
proxy is plain HTTP on this server, so the redirect would loop
(TOO_MANY_REDIRECTS). Card Vault also needs `CLIENT_IP_HEADER=cf-connecting-ip`
(see `docs/COOLIFY.md`).

Sources: Coolify's tunnel guides
(https://coolify.io/docs/integrations/networking/cloudflare/tunnels/all-resource,
.../single-resource, .../server-ssh), Coolify's instance settings
(https://coolify.io/docs/core/instance-management/instance-settings), Coolify's
webhook routes (https://github.com/coollabsio/coolify/blob/main/routes/webhooks.php),
Cloudflare's browser SSH guide
(https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-browser-rendering/)
and short-lived certificates
(https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/short-lived-certificates-legacy/).

## Check the server

Run `sudo server-check` (or `sudo bash check.sh` from the release). It checks
the firewall, the container port block and its settings file, open ports, SSH
settings (no passwords, the Cloudflare CA and who may log in with it), the
Cloudflare Tunnel (Cloudflare mode), updates, fail2ban, disk, memory, the
Coolify containers, log retention, alerts (set up, last check, last alert),
the Lynis score and top warnings, auditd and its rules, the AI agent account
(no password, not in docker or sudo, sudo rules valid and recorded, open
permissions) and the support command. Anything marked FAIL comes with the
command that fixes it.

## Logs

- System log (journald): kept on disk, at most 1 GB and 90 days
  (`/etc/systemd/journald.conf.d/60-server-retention.conf`).
- Container logs: `/etc/docker/daemon.json` gets `log-driver json-file`,
  `max-size 20m`, `max-file 5`, merged with `jq` into what is there (Coolify's
  installer writes this file; its other settings are kept, the old file is
  saved as `daemon.json.before-bootstrap-<date>`). Docker is restarted once,
  during `bootstrap.sh` only. **Containers that exist keep their old log
  settings until they are recreated**; a redeploy in Coolify recreates them,
  and `check.sh` lists those still on old settings. If Coolify's installer
  ever runs again it may write its own values; run `bootstrap.sh` again.
- Recorded sudo sessions of the agent (`/var/log/sudo-io`) are kept 90 days;
  the agent's notes rotate monthly (24 kept); Lynis keeps 8 reports.

## Alerts

`sudo server-alert setup` asks Telegram or Discord:

- **Telegram**: in Telegram open **@BotFather**, send `/newbot`, pick a name;
  it gives a bot token. Send your new bot any message, paste the token
  (hidden typing), and setup finds your chat by itself.
- **Discord**: Server Settings, Integrations, Webhooks, New Webhook, choose
  the channel, Copy Webhook URL, paste it (hidden typing).

It checks the token or address with Telegram or Discord, asks whether you
want a daily summary (08:05 server time), saves everything in
`/etc/server-alert/config` (root only, mode 600) and sends a test message.
The token is never printed and never on a command line (curl reads the
address from its standard input).

Every 15 minutes `server-alert watch` (a systemd timer) alerts on: last
backup failed, or older than 36 hours; disk above 85% on `/` or
`/var/lib/docker`; cloudflared not running (Cloudflare mode); Docker not
running; a Coolify container unhealthy or restarting repeatedly; security
updates waiting more than 3 days; a restart needed for more than 7 days;
fail2ban bans (summary); sudo use by `ops-agent` (summary of commands run
and refused). Everything found in one run goes in one message. Each problem
is sent at most once per 6 hours, and never more than 12 messages an hour.
Every alert is also in the system log: `journalctl -t server-alert`.
Without setup, alerts only go to the system log.

## Security audit

Lynis (Ubuntu package) runs `lynis audit system --quick` every Sunday
(`server-lynis.timer`; it only reads). Reports: `/var/log/lynis/` (last 8).
The hardening index goes to `/var/lib/server-alert/lynis-score`; a drop of 5
or more sends an alert. `sudo server-lynis show` shows the score and the top
warnings.

auditd logs every program the `ops-agent` account starts, and every change to
`/etc/ssh`, `/etc/sudoers*`, `/etc/cloudflared`,
`/etc/default/docker-port-guard` and the agent's guide
(`/etc/audit/rules.d/60-server.rules`). Read it with
`sudo ausearch -k ops-agent -i` (keys: `ops-agent`, `ssh-config`,
`sudoers`, `cloudflared`, `port-guard`, `ops-agent-guide`).

## AI agent account

`bootstrap.sh` creates `ops-agent` (skip with `--no-agent`): no password
(locked), SSH refused (`DenyUsers ops-agent`), no extra groups (never
`docker`, which equals root), no cron jobs. Start a session as it on the
server, from your own account: `sudo -iu ops-agent` (then start the agent
there). It reads `/home/ops-agent/CLAUDE.md` (from `AGENT-GUIDE.md`, owned by
root and locked with `chattr +i`).

`/etc/sudoers.d/ops-agent` (checked with `visudo`) lets it run, without a
password, only: `server-check`, `server-support`, `server-update --dry-run`,
`server-backup status|list|run|check`, `server-lynis show`,
`server-alert status|send ...`, `server-logs`, `server-docker-logs`,
`server-status` (wrappers that only read and check every argument),
`docker ps [-a]`, `ufw status [verbose|numbered]`,
`fail2ban-client status [sshd]`, `docker-port-guard status` and
`server-note`. Every session is recorded with input and output:
`sudo sudoreplay -d /var/log/sudo-io/ops-agent -l`, then
`sudo sudoreplay -d /var/log/sudo-io/ops-agent <TSID>`. Refused commands are
logged and appear in the next alert summary.

**Changes need you.** Either run the command yourself, or allow it once:

```
sudo server-agent-grant "server-update --yes" 30m
```

You confirm, get an id, and the agent runs `sudo server-agent-grant use <id>`.
It works one time, ends by itself after the time (at most 4 hours, removed by
a systemd timer), and every grant, use and expiry goes to the system log
(`journalctl -t server-agent-grant`) and to your phone. Only these can be
granted: `server-update`, `server-update --yes`,
`server-backup restore-files ...`, `systemctl restart <service>`, `reboot`.
`sudo server-agent-grant list` shows open ones, `revoke <id>|all` takes them
back.

How the agent runs is your choice. The setup assumes you start it yourself on
the server with `sudo -iu ops-agent`. Giving it SSH would mean removing the
`DenyUsers` line and adding a key; do not do that without thinking it through.

## Getting help

`sudo server-support` writes `/var/lib/server-support/support-<date>.txt`
(root only, newest 10 kept) and prints its path and a short summary. It holds
the check output, versions (Ubuntu, kernel, Docker, Coolify, cloudflared),
service and timer states, the last lines of the cloudflared, docker and ssh
logs and of Coolify's containers, backup status, whether alerts are set up
(never the settings), firewall and port guard status, the Lynis score, audit
and agent information, disk and memory. Secrets are removed: the exact values
in `/etc/cloudflared/tunnel-token`, `/etc/server-alert/config`,
`/etc/server-backup/*`, Coolify's `.env` and the first-login file, plus
anything shaped like a password, token, key, cookie, bearer header, password
in a web address, Telegram token or Discord webhook. Show it with
`sudo cat <file>` (or `sudo server-support --stdout`), copy it and paste it
to Claude.

## What is open to the internet

**Cloudflare mode:** nothing. 22, 80, 443, 8000, 6001, 6002 and every other
port are closed to the internet, for programs on the server (ufw) and for
containers (docker-port-guard). Everything arrives through the tunnel, which
connects out from the server; Cloudflare Access decides who gets through.

**Direct mode:**

| Port | Open? | Why |
| --- | --- | --- |
| 80/tcp, 443/tcp, 443/udp | yes | Websites (Coolify's Traefik proxy, HTTPS certificates, HTTP/3) |
| 22/tcp (SSH) | no | Only Coolify's own container may connect, from Docker's private networks (172.16.0.0/12, 10.0.0.0/8), with its key |
| 8000, 6001, 6002 | no | Coolify dashboard ports; reached through `https://admin...` instead. Only open during the setup window. |
| everything else | no | |

Password login over SSH is switched off. You keep using the Hyper-V console.

## Locked out? Undo from the Hyper-V console

Log in on the Hyper-V console (it does not use the network, so the firewall
never blocks it), then run only what you need:

| Problem | Command |
| --- | --- |
| Turn the firewall off | `sudo ufw disable` (back on: `sudo ufw --force enable`) |
| Reach the Coolify dashboard directly for 30 minutes | `sudo docker-port-guard open-setup 30 <your-internet-address>` |
| Remove the container port block until the next restart | `sudo iptables -D DOCKER-USER -j PORT-GUARD` and `sudo ip6tables -D DOCKER-USER -j PORT-GUARD` |
| Remove the container port block for good | `sudo systemctl disable --now docker-port-guard` then the two lines above |
| Docker does not start after a change to the port block settings | `sudo docker-port-guard check-config`, fix `/etc/default/docker-port-guard`, then `sudo systemctl restart docker` |
| An address was banned by fail2ban | `sudo fail2ban-client unban --all` |
| Browser SSH refuses to log in | `sudo server-ssh-ca status`; a new key from Cloudflare: `sudo server-ssh-ca set` |
| Allow SSH passwords again | `sudo rm /etc/ssh/sshd_config.d/01-server-hardening.conf && sudo systemctl restart ssh` |
| Cloudflare mode: the tunnel is down | `sudo systemctl restart cloudflared`, then `sudo journalctl -u cloudflared -n 50` |
| Cloudflare mode: new tunnel token | `sudo bash bootstrap.sh --cloudflare admin.example.com` and paste the new token |
| Cloudflare mode: reach the dashboard without Cloudflare | `sudo docker-port-guard open-setup 30 <your-internet-address>`, then `http://<server address>:8000` (30 minutes) |

To put everything back, run `bootstrap.sh` again.

## Updates

Owner rule: **nothing on the live system changes by itself except Ubuntu
security patches.**

| What | How | When |
| --- | --- | --- |
| Ubuntu security patches | unattended-upgrades, only `${distro_id}:${distro_codename}-security` | daily, by themselves |
| Package lists (to see what is waiting) | apt-daily timer | daily, by themselves |
| Other Ubuntu updates, Docker, cloudflared | `sudo server-update` | when you choose |
| A new Docker major version (for example 28 to 29) | `sudo server-update --allow-docker-major` | only when you choose that too |
| Coolify | Coolify's own auto update (Settings) | as Coolify sets it |
| Restart of the server | `server-update` asks; it never happens by itself | when you choose |

`sudo server-update`:

1. Shows what is waiting, grouped: Ubuntu security, other Ubuntu, Docker,
   cloudflared (and anything that would be removed).
2. Asks before it changes anything (`--yes` skips the question; `--dry-run`
   only shows the list).
3. Runs the backup first if the backup tool is installed
   (`/usr/local/sbin/server-backup run`). If the backup fails, it stops and
   changes nothing. `--skip-backup` updates without a backup.
4. Installs the updates (`apt-get upgrade`, then `apt-get full-upgrade`).
5. Says whether a restart is needed and asks before restarting. Without a
   console it never restarts; restart later with `sudo reboot`.
6. If cloudflared was updated, restarts the tunnel as the very last step (a
   browser SSH session drops for a few seconds).

Docker's major version is pinned in `/etc/apt/preferences.d/docker-major-pin`
(written by `bootstrap.sh` once Docker is installed, or `sudo server-update pin`),
for `docker-ce`, `docker-ce-cli`, `docker-ce-rootless-extras` and
`containerd.io`. Updates within the major version install normally; a new one
is listed as "Held back" until you run `sudo server-update --allow-docker-major`,
which lifts the pin for that run and then pins the new major version.

A Docker update restarts Docker for a moment. Coolify's containers and the apps
it deploys have restart policies, so they start again by themselves.

`sudo bash check.sh` shows how many updates are waiting (security, Ubuntu,
Docker, cloudflared) with "run sudo server-update when convenient", and warns
when a security update has been waiting for more than 3 days (it should
install by itself) or a restart has been needed for more than 7 days.

## Opening another port to the internet

Coolify apps should use 80/443 through their domain. If one really needs its own
port (for example a database reached from outside), add it to
`/etc/default/docker-port-guard`, for example `EXTRA_ALLOWED="tcp/5432"`, and run
`sudo docker-port-guard apply`. A port used by a program on the server itself
(not a container) also needs `sudo ufw allow <port>/tcp`.

The file is read as plain `NAME=value` lines (only `MODE` and `EXTRA_ALLOWED`),
never run as a program. A mistake in it does not stop Docker: the guard logs
it, `check.sh` warns, and until it is fixed no extra port is open (and, if the
`MODE` line itself is wrong, the closed Cloudflare mode is used). A mistake can
only close ports, never open them. Check the file with
`sudo docker-port-guard check-config`.

## Optional settings: /etc/default/server-setup

Plain `NAME=value` lines, read as text. Known setting:

| Setting | What it does |
| --- | --- |
| `COOLIFY_INSTALLER_SHA256` | The SHA-256 fingerprint the Coolify installer must have. `bootstrap.sh` always prints the fingerprint of the installer it downloads; with this set, a different installer is refused and nothing is installed. Coolify changes its installer with new releases, so update or remove the line when that happens. |

## Design notes

**Docker skips ufw.** Ports that Docker publishes for containers are handled by
Docker's own iptables rules before ufw sees them. `docker-port-guard` (installed
to `/usr/local/sbin/`) puts a chain called `PORT-GUARD` first in Docker's
`DOCKER-USER` chain, for IPv4 and IPv6. It lets through replies, traffic from
the server itself and from Docker networks (`lo`, `docker0`, `br-*`), and new
connections to 80/tcp, 443/tcp, 443/udp. Everything else from outside is
dropped. Ports are matched on the port the visitor asked for
(`conntrack --ctorigdstport`), because Docker has already changed 8000 to the
container's 8080 by the time `DOCKER-USER` sees the packet. The rules are
rebuilt in one `iptables-restore` transaction, so there is no gap and no
duplicate rules. `docker-port-guard.service` applies them at boot **before**
Docker starts (Docker keeps an existing `DOCKER-USER` chain), and a drop-in
re-applies them right after every Docker start or restart. It fails closed:
if the IPv4 rules, or the IPv6 rules on a server where IPv6 works, cannot be
loaded, it exits with an error and Docker does not start.

**Differences from Coolify's firewall guide**
(https://coolify.io/docs/knowledge-base/server/firewall):

- The guide's first choice is the hosting provider's firewall. There is none
  here, so everything is done on the server.
- For servers without one, it suggests the community tool `ufw-docker`. That
  tool works by adding rules to the same `DOCKER-USER` chain. These scripts
  write those rules directly, so there is no extra third-party download, and
  they allow only web ports by default.
  The guide warns against rules tied to container IP addresses, which break
  after updates; these rules use only ports and network card names.
- The guide also suggests binding 8000/6001/6002 to `127.0.0.1` with
  `/data/coolify/source/docker-compose.custom.yml`, after the domain works.
  The script does not do this, because the first login needs port 8000 from a
  browser, and the console-only owner has no SSH tunnel. The port block already
  stops outside access to those ports. Adding the override later is an optional
  extra layer, but then the setup window can no longer be used as a way back in.
- Coolify's own Traefik also publishes 8080 (its dashboard); the block covers it.

**Why a timed setup window and not a preset domain.** The safest option would
be to have the dashboard on `https://admin...` from the start. Coolify does not
support presetting this: its installer and settings file have no option for the
instance domain (it lives in Coolify's database and is set in Settings), and the
proxy is only configured during the welcome steps. Writing to Coolify's database
directly is unsupported and could break with updates. So the script opens 8000
and 6001 for 30 minutes (optionally only for the owner's address), closes them
with a systemd timer (and on any restart, because the window lives in `/run`),
and creates the admin account up front with Coolify's documented
`ROOT_USER_EMAIL` / `ROOT_USER_PASSWORD` settings, so the "first visitor
becomes admin" risk does not exist. The one weak spot is that this first login
uses plain HTTP; changing the password over HTTPS right after (step 6) and
turning on two-factor login removes that risk.

**Trusting Coolify's installer.** The script downloads Coolify's official
installer from `https://cdn.coollabs.io/coolify/install.sh` into a private
temporary folder, prints its SHA-256 fingerprint, compares it with
`COOLIFY_INSTALLER_SHA256` if you set one, and runs it. That means trusting
Coolify's publisher, which is the path Coolify documents
(https://coolify.io/docs/get-started/installation) and the one its automatic
updates rely on. The installer also installs Docker from Docker's official
script. The installer reads the admin account only from its environment
(`ROOT_USERNAME`, `ROOT_USER_EMAIL`, `ROOT_USER_PASSWORD`); the script sets
them with the shell's `export` in a sub-shell, so the password never appears
on a command line or in the process list.

**Cloudflare mode details**

- cloudflared comes from Cloudflare's apt repository
  (https://pkg.cloudflare.com/). The script checks the signing key's
  fingerprint (`CC94 B39C 77AE 7342 A68B 8962 8A68 2D30 8D4E 5E73`) before
  trusting it, and stops if Cloudflare ever changes the key or gpg cannot read it.
- The tunnel token is base64 of `{"a": account, "t": tunnel id, "s": secret}`
  (see `TunnelToken` in cloudflared's source); the script checks that shape.
  It lives in `/etc/cloudflared/tunnel-token` (folder 0700, file 0600, root).
  The service starts `cloudflared tunnel run --token-file ...`, so the token is
  never in the service file, a command line, the environment or the log.
- The service runs as root only to read that file (systemd credentials for a
  non-root user did not work in testing). Every root power (capability) is
  dropped, the system is read-only for it, other programs' processes are hidden
  (`ProtectProc=invisible`), and the Docker socket, Docker's and Coolify's data,
  `/etc/shadow` and `/etc/gshadow` are invisible to it. cloudflared's own
  updater is off (`--no-autoupdate`); `server-update` updates it.
- cloudflared's ready page is on `127.0.0.1:20241/ready` (this server only);
  `check.sh` reads the number of tunnel connections there.
  `cloudflared tunnel info` is not used: it needs a Cloudflare login on the server.
- Traffic from cloudflared to Coolify (`localhost:80`, `:8000`, `:6001`,
  `:6002`) starts on the server itself, so the container port block, which
  only looks at traffic coming in from outside, does not get in its way.
- fail2ban keeps watching SSH. Tunnel logins arrive from 127.0.0.1, which
  fail2ban never bans (that would lock you out of the browser terminal too);
  with no passwords at all there is nothing to guess there anyway.

**Other choices**

- The server never restarts by itself. `check.sh` warns after 7 days of a
  waiting restart.
- fail2ban watches SSH even though SSH is closed to the internet. Docker's
  private ranges are never banned, so Coolify cannot lock itself out.
- SSH settings live in `/etc/ssh/sshd_config.d/01-server-hardening.conf` and are
  checked with `sshd -t` before SSH reloads, then proven with `sshd -T`: no
  password or keyboard login for your user or root, from 127.0.0.1, ::1 or any
  other address. If a check fails the file is removed again.
- Files are written to a private temporary folder next to their final folder
  and then moved into place, so apt and sshd never see a half-written file in
  `apt.conf.d` or `sshd_config.d`.
- `--dry-run` prints every change instead of making it.
- What changes by itself: still only Ubuntu security patches. The timers
  added here only read (checks, alerts, Lynis), or remove the agent's expired
  permissions.

## Files the scripts create

`/etc/ssh/sshd_config.d/01-server-hardening.conf`,
`/etc/apt/apt.conf.d/20auto-upgrades`,
`/etc/apt/apt.conf.d/52unattended-upgrades-server`,
`/etc/apt/preferences.d/docker-major-pin`,
`/etc/sysctl.d/99-server-swappiness.conf`, `/swapfile` (only if there was no swap),
`/etc/fail2ban/jail.d/90-sshd-server.local`,
`/usr/local/sbin/server-update`,
`/usr/local/sbin/docker-port-guard`, `/etc/default/docker-port-guard`,
`/etc/systemd/system/docker-port-guard.service`,
`/etc/systemd/system/docker-port-guard-apply.service` and `.timer`,
`/etc/systemd/system/docker.service.d/50-docker-port-guard.conf`,
`/root/coolify-first-login.txt` (delete after first login),
`/etc/systemd/journald.conf.d/60-server-retention.conf`, `/etc/docker/daemon.json`
(merged), `/usr/local/sbin/server-{check,alert,support,lynis,logs,docker-logs,status,note,agent-grant}`,
`/usr/local/lib/server-tools/redact`, `/usr/local/share/server-tools/`,
`/etc/server-alert/config` (after setup), `/var/lib/server-alert/`,
`/var/log/lynis/`, `/var/lib/server-support/`,
`/etc/systemd/system/server-alert-{watch,digest}.{service,timer}`,
`server-lynis.{service,timer}`, `server-agent-grant-expire.{service,timer}`,
`/etc/audit/rules.d/60-server.rules`, `/etc/logrotate.d/ops-agent-notes`,
`/etc/tmpfiles.d/server-sudo-io.conf`; with the agent: the `ops-agent` account,
`/home/ops-agent/CLAUDE.md`, `/etc/sudoers.d/ops-agent` (and short-lived
`ops-agent-grant-*`), `/var/log/sudo-io/`, `/var/log/ops-agent-notes.log`,
`/var/lib/server-agent-grant/`, a line in `/etc/cron.deny`; plus ufw rules and
everything Coolify installs under `/data/coolify`. Cloudflare mode adds
`/usr/local/sbin/server-ssh-ca`, `/etc/ssh/ca.pub` (once the key is set),
`/etc/ssh/principals/<your user>`,
`/usr/share/keyrings/cloudflare-main.gpg`, `/etc/apt/sources.list.d/cloudflared.list`,
`/etc/cloudflared/tunnel-token` and `/etc/systemd/system/cloudflared.service`.
Earlier versions also wrote `/etc/apt/apt.conf.d/53unattended-upgrades-cloudflared`;
the script removes it.
