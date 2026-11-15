# Server setup (Ubuntu 24.04 + Coolify)

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
| `bootstrap.sh` | One-time setup (safe to run again): updates, automatic updates, swap, SSH lockdown, firewall, container port block, fail2ban, Cloudflare Tunnel (Cloudflare mode), Coolify. |
| `check.sh` | Read-only check you can run any time. Prints PASS, WARN or FAIL lines. Changes nothing. |

## Before you start

1. A fresh Ubuntu 24.04 LTS server, at least 2 processors, 4 GB memory, 40 GB disk.
2. Pick the dashboard address, for example `admin.example.com`.
3. At your domain provider, add a DNS **A record**: `admin.example.com` pointing
   to the server's internet address. Do this first: the HTTPS certificate can
   only be issued once this record works.

## Run it from the Hyper-V console

1. Open the server in Hyper-V (VMConnect) and log in as the user you created
   when installing Ubuntu.
2. Copy this one line on your computer, with your own addresses filled in.
   The file is published at https://raw.githubusercontent.com/dmo18/crd/main/infra/ubuntu/bootstrap.sh

   ```
   curl -fsSL https://raw.githubusercontent.com/dmo18/crd/main/infra/ubuntu/bootstrap.sh -o bootstrap.sh && sudo bash bootstrap.sh admin.example.com you@example.com
   ```

3. In the VMConnect window choose **Clipboard > Type clipboard text**. The line
   is typed for you. Check it looks right, then press Enter.
4. Type your Ubuntu password when asked (for `sudo`).
5. The script takes about 5 to 10 minutes. If the server is smaller than
   recommended it asks "Continue anyway?". Type `y` and Enter to go on.
6. At the end it prints what it did and the next steps, including the
   Coolify login password. Leave the console open while you do them.

To see what the script would change without changing anything:
`sudo bash bootstrap.sh --dry-run admin.example.com`

## First login to Coolify

The Coolify dashboard ports (8000, 6001, 6002) are blocked from the internet.
For the very first login the script opens 8000 and 6001 for **30 minutes**, and
they close again by themselves (also after a restart). The Coolify admin
account is created by the script with a long random password, so nobody else
can claim the dashboard during those minutes.

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

Ran out of time? Open the window again: `sudo docker-port-guard open-setup 30`

## Cloudflare mode

Visitors go to Cloudflare, and Cloudflare passes them through the tunnel to
this server. You reach the Coolify dashboard and a terminal (SSH in the browser)
the same way, after signing in to Cloudflare Access. No port is open on the
server at all, not even 22, 80 or 443. No Cloudflare password or API key is
stored on the server, only the tunnel token.

### 1. Create the tunnel (Cloudflare dashboard)

Your domain must use Cloudflare for its DNS.

1. Cloudflare dashboard, **Zero Trust**, **Networks**, **Tunnels**,
   **Create a tunnel**, type **Cloudflared**, give it a name.
2. On the "install connector" page Cloudflare shows a command with a long
   token in it (starts with `eyJ`). Copy only the token. Do not run the
   command; the script installs cloudflared itself.

### 2. Run the script (Hyper-V console)

```
curl -fsSL https://raw.githubusercontent.com/dmo18/crd/main/infra/ubuntu/bootstrap.sh -o bootstrap.sh && sudo bash bootstrap.sh --cloudflare admin.example.com you@example.com
```

When it asks for the token, paste it (Clipboard, Type clipboard text) and press
Enter. What you type stays hidden. Never put the token on the command line:
other programs and the shell history could see it. For a run without a
console, put it in the environment variable `CF_TUNNEL_TOKEN` instead. When
you run the script again it offers to keep the token it already has.

The token is saved in `/etc/cloudflared/tunnel-token`, readable only by root.
At the end the script prints the Coolify login (email and a random password).

### 3. Tunnel routes (Cloudflare dashboard)

Your tunnel, **Routes** (older dashboards: **Public Hostname**), **Add route**,
**Published application**. Add these rows **in this order** (Cloudflare checks
them from top to bottom and uses the first that matches). `example.com` is your
domain.

| # | Subdomain | Domain | Path | Service |
| --- | --- | --- | --- | --- |
| 1 | `admin` | `example.com` | `^/app/` | HTTP, `127.0.0.1:6001` (live updates) |
| 2 | `admin` | `example.com` | `^/terminal/ws` | HTTP, `127.0.0.1:6002` (Coolify's terminal) |
| 3 | `admin` | `example.com` | (empty) | HTTP, `127.0.0.1:8000` (Coolify dashboard) |
| 4 | `ssh` | `example.com` | (empty) | SSH, `127.0.0.1:22` (terminal in the browser) |
| 5 | `*` | `example.com` | (empty) | HTTP, `127.0.0.1:80` (all apps, through Coolify's proxy) |

Notes:

- The path is a pattern: `^/app/` means "starts with /app/". Plain `app`
  would also catch dashboard pages such as `/project/.../application/...`.
- Coolify's and Cloudflare's guides write `localhost`; `127.0.0.1` is the
  same server but avoids a known problem where `localhost` means the IPv6
  address and Coolify's ports do not answer there (Coolify's guide gives this
  as the fix).
- This order was checked with cloudflared's own rule matcher
  (`cloudflared tunnel ingress rule`): `/app/...` goes to 6001,
  `/terminal/ws` to 6002, every other dashboard page to 8000, other names to 80.
- Row 5 covers every future app (`cards.example.com`, `newapp.example.com`,
  ...). Cloudflare creates the DNS records for the rows. If a record with the
  same name already exists (for example an old A record), delete it first.
- Coolify's newest guide also allows a single row `admin` to `localhost:80`
  once the dashboard URL is set (step 5). Rows 1 to 3 work from the very first
  login and do not depend on Coolify's proxy, so keep them.

### 4. Keep it private (Cloudflare Access)

**Zero Trust**, **Access**, **Applications**, **Add an application**,
**Self-hosted**. For each, add a policy: Action **Allow**, Include **Emails**,
your email address.

| Application | Address | Extra setting |
| --- | --- | --- |
| Coolify | `admin.example.com` | |
| Server terminal | `ssh.example.com` | Browser rendering: **SSH** |
| All apps | `*.example.com` | New apps are then private until you decide otherwise |

To make one app public (for example Card Vault, which has its own password),
add an application for just that address (`cards.example.com`) with a
**Bypass** policy for **Everyone**.

### 5. First login and Coolify settings (browser)

1. Open `https://admin.example.com`, sign in to Cloudflare Access, then log in
   to Coolify with the email and password the script printed (also in
   `sudo cat /root/coolify-first-login.txt`).
2. Change the password at once, then turn on two-factor login (Profile).
3. Follow the welcome steps and choose **This Machine** (localhost).
4. **Settings**, **General**: URL `https://admin.example.com`, and
   **Redirect HTTP to HTTPS**: **Disabled**. Save.
5. Delete the saved password: `sudo rm /root/coolify-first-login.txt`

**Every app behind the tunnel:** give it its domain with `https://`, for
example `https://cards.example.com` (for Card Vault `https://cards.example.com:3000`,
see `docs/SERVER.md`), and on the app's **Domains** page set **Redirect HTTP
to HTTPS** to **Disabled**. Cloudflare does HTTPS for visitors; the last step
from the tunnel to Coolify's proxy is plain HTTP on this server, so the
redirect would loop (TOO_MANY_REDIRECTS). Card Vault also needs
`CLIENT_IP_HEADER=cf-connecting-ip` (see `docs/COOLIFY.md`).

Sources: Coolify's tunnel guides
(https://coolify.io/docs/integrations/networking/cloudflare/tunnels/all-resource,
.../single-resource, .../server-ssh), Coolify's instance settings
(https://coolify.io/docs/core/instance-management/instance-settings), and
Cloudflare's browser SSH guide
(https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-browser-rendering/).
The live update and terminal addresses (rows 1 and 2) follow from Coolify's
own code: on `https://admin...` the browser opens `wss://admin.../app/...` and
`wss://admin.../terminal/ws`.

### 6. SSH in the browser

Open `https://ssh.example.com`, sign in to Cloudflare Access, then log in with
your Ubuntu user name and password (the user created when installing Ubuntu).
Password login is allowed only for these tunnel connections, which arrive from
the server itself (127.0.0.1); from anywhere else SSH stays key only, and root
can never log in with a password. The Hyper-V console keeps working as always.

## Check the server

Get `check.sh` onto the server the same way as `bootstrap.sh`, then run
`sudo bash check.sh`. It checks the firewall, the container port block, open
ports, SSH settings, the Cloudflare Tunnel (Cloudflare mode), automatic
updates, fail2ban, disk, memory and the Coolify containers. Anything marked FAIL comes with the command that fixes it.

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
| Reach the Coolify dashboard directly for 30 minutes | `sudo docker-port-guard open-setup 30` |
| Remove the container port block until the next restart | `sudo iptables -D DOCKER-USER -j PORT-GUARD` and `sudo ip6tables -D DOCKER-USER -j PORT-GUARD` |
| Remove the container port block for good | `sudo systemctl disable --now docker-port-guard` then the two lines above |
| An address was banned by fail2ban | `sudo fail2ban-client unban --all` |
| Allow SSH passwords again | `sudo rm /etc/ssh/sshd_config.d/01-server-hardening.conf && sudo systemctl restart ssh` |
| Cloudflare mode: the tunnel is down | `sudo systemctl restart cloudflared`, then `sudo journalctl -u cloudflared -n 50` |
| Cloudflare mode: new tunnel token | `sudo bash bootstrap.sh --cloudflare admin.example.com` and paste the new token |
| Cloudflare mode: reach the dashboard without Cloudflare | `sudo docker-port-guard open-setup 30`, then `http://<server address>:8000` (30 minutes) |

To put everything back, run `bootstrap.sh` again.

## Staying up to date

Everything updates itself to the latest released version:

| What | How | When |
| --- | --- | --- |
| Ubuntu (security and regular updates) | unattended-upgrades | daily (apt-daily and apt-daily-upgrade timers) |
| Docker (docker-ce, containerd.io, compose and buildx plugins) | unattended-upgrades, from Docker's repository that Coolify's installer adds | daily |
| cloudflared (Cloudflare mode) | unattended-upgrades, from Cloudflare's signed repository (its own updater is off) | daily |
| Coolify | Coolify's own auto update (Settings) | as Coolify sets it |
| Restart of the server | only when an update needs one | 04:30 server time |

A Docker update restarts Docker for a moment. Coolify's containers and the apps
it deploys have restart policies, so they start again by themselves.
`sudo bash check.sh` shows the waiting updates, when updates last ran, the
installed and newest versions of docker-ce and cloudflared, whether a restart
is waiting, and warns if a security update has been waiting for more than 3 days.

## Opening another port to the internet

Coolify apps should use 80/443 through their domain. If one really needs its own
port (for example a database reached from outside), add it to
`/etc/default/docker-port-guard`, for example `EXTRA_ALLOWED="tcp/5432"`, and run
`sudo docker-port-guard apply`. A port used by a program on the server itself
(not a container) also needs `sudo ufw allow <port>/tcp`.

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
re-applies them right after every Docker start or restart.

**Differences from Coolify's firewall guide**
(https://coolify.io/docs/knowledge-base/server/firewall):

- The guide's first choice is the hosting provider's firewall. There is none
  here, so everything is done on the server.
- For servers without one, it suggests the community tool `ufw-docker`. That
  tool works by adding rules to the same `DOCKER-USER` chain. These scripts
  write those rules directly, so there is no extra third-party download,, and
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
and 6001 for 30 minutes, closes them with a systemd timer (and on any restart,
because the window lives in `/run`), and creates the admin account up front
with Coolify's documented `ROOT_USER_EMAIL` / `ROOT_USER_PASSWORD` settings, so
the "first visitor becomes admin" risk does not exist. The one weak spot is that
this first login uses plain HTTP; changing the password over HTTPS right after
(step 6) and turning on two-factor login removes that risk.

**Trusting Coolify's installer.** The script downloads Coolify's official
installer from `https://cdn.coollabs.io/coolify/install.sh` into a private
temporary folder, prints its SHA-256 fingerprint, and runs it. That means
trusting Coolify's publisher, which is the path Coolify documents
(https://coolify.io/docs/get-started/installation) and the one its automatic
updates rely on. The installer also installs Docker from Docker's official
script.

**Cloudflare mode details**

- cloudflared comes from Cloudflare's apt repository
  (https://pkg.cloudflare.com/). The script checks the signing key's
  fingerprint (`CC94 B39C 77AE 7342 A68B 8962 8A68 2D30 8D4E 5E73`) before
  trusting it, and stops if Cloudflare ever changes the key.
- The tunnel token is base64 of `{"a": account, "t": tunnel id, "s": secret}`
  (see `TunnelToken` in cloudflared's source); the script checks that shape.
  It lives in `/etc/cloudflared/tunnel-token` (folder 0700, file 0600, root).
  The service starts `cloudflared tunnel run --token-file ...`, so the token is
  never in the service file, a command line, the environment or the log.
  The service runs as root only to read that file, with every root power
  (capability) dropped and the system read-only for it. cloudflared's own
  updater is off (`--no-autoupdate`); apt updates it.
- cloudflared's ready page is on `127.0.0.1:20241/ready` (this server only);
  `check.sh` reads the number of tunnel connections there.
  `cloudflared tunnel info` is not used: it needs a Cloudflare login on the server.
- Traffic from cloudflared to Coolify (`localhost:80`, `:8000`, `:6001`,
  `:6002`) starts on the server itself, so the container port block, which
  only looks at traffic coming in from outside, does not get in its way.
- fail2ban keeps watching SSH. Tunnel logins arrive from 127.0.0.1, which
  fail2ban never bans (that would lock you out of the browser terminal too);
  Cloudflare Access in front is what keeps strangers away from that login.

**Other choices**

- Automatic updates restart the server at 04:30 server time (UTC
  unless changed), only when an update needs a restart. Containers come back by
  themselves.
- fail2ban watches SSH even though SSH is closed to the internet. Docker's
  private ranges are never banned, so Coolify cannot lock itself out.
- SSH settings live in `/etc/ssh/sshd_config.d/01-server-hardening.conf` and are
  checked with `sshd -t` before SSH reloads.
- `--dry-run` prints every change instead of making it.

## Files the scripts create

`/etc/ssh/sshd_config.d/01-server-hardening.conf`,
`/etc/apt/apt.conf.d/20auto-upgrades`,
`/etc/apt/apt.conf.d/52unattended-upgrades-server`,
`/etc/sysctl.d/99-server-swappiness.conf`, `/swapfile` (only if there was no swap),
`/etc/fail2ban/jail.d/90-sshd-server.local`,
`/usr/local/sbin/docker-port-guard`, `/etc/default/docker-port-guard`,
`/etc/systemd/system/docker-port-guard.service`,
`/etc/systemd/system/docker.service.d/50-docker-port-guard.conf`,
`/root/coolify-first-login.txt` (delete after first login), plus ufw rules and
everything Coolify installs under `/data/coolify`. Cloudflare mode adds
`/usr/share/keyrings/cloudflare-main.gpg`, `/etc/apt/sources.list.d/cloudflared.list`,
`/etc/apt/apt.conf.d/53unattended-upgrades-cloudflared`,
`/etc/cloudflared/tunnel-token` and `/etc/systemd/system/cloudflared.service`.
