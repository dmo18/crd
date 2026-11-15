# Server setup (Ubuntu 24.04 + Coolify)

Two scripts for the Ubuntu 24.04 LTS server that runs Coolify and, through it,
Card Vault. The server has its own internet address and no firewall in front of
it, so these scripts build the protection on the server itself.

| File | What it does |
| --- | --- |
| `bootstrap.sh` | One-time setup (safe to run again): updates, automatic security updates, swap, SSH lockdown, firewall, container port block, fail2ban, Coolify. |
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

## Check the server

Get `check.sh` onto the server the same way as `bootstrap.sh`, then run
`sudo bash check.sh`. It checks the firewall, the container port block, open
ports, SSH settings, automatic updates, fail2ban, disk, memory and the Coolify
containers. Anything marked FAIL comes with the command that fixes it.

## What is open to the internet

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

To put everything back, run `bootstrap.sh` again.

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

**Other choices**

- Automatic security updates restart the server at 04:30 server time (UTC
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
everything Coolify installs under `/data/coolify`.
