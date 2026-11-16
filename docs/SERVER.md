# Server "appy": setup guide

**Use the illustrated guide:** https://claude.ai/artifact/97qZ1327DM13kHSJan8cDt
(the same page is in this folder as `server-guide.html`). It has a drawing of
every screen, copy buttons, and a tick box per step. This file is the short
text version of the same 14 steps.

One pasted command (step 5) does the server work automatically: updates,
firewall, Cloudflare connection, Coolify, security patches, logs, backup
tool, alert tool, health check. The rest is clicking through Hyper-V,
Cloudflare and Coolify.

| # | Where | What |
|---|---|---|
| 1 | Hyper-V host | Download Ubuntu Server **24.04 LTS** from ubuntu.com/download/server |
| 2 | Hyper-V Manager | New virtual machine `appy`: Generation 2, 4096 MB, your internet switch, 60 GB, the Ubuntu .iso. Then Settings: Secure Boot template "Microsoft UEFI Certificate Authority" (still no boot? untick Enable Secure Boot), 2 processors, start automatically |
| 3 | Console window | Install Ubuntu with the defaults. Server's name `appy`. Write down the username and password |
| 4 | Cloudflare Zero Trust | Networks, Tunnels, Create a tunnel, Cloudflared, name `appy`. Copy the token (starts `eyJ`) |
| 5 | Console window | Paste the setup command (below). Answer: token, your email, Enter to skip the SSH key, `n` for alerts. Write down the temporary Coolify password it prints |
| 6 | Cloudflare Zero Trust | Access controls, Applications: add the two sign-in rules (below) |
| 7 | Cloudflare | Tunnel `appy`, Routes: add the four routes (below). Cloudflare makes their DNS records |
| 8 | Cloudflare, console | Access controls, Service credentials, tab SSH (not Service Tokens), Add a certificate, Application `appy-ssh`, Generate certificate. Copy the public key, run `sudo server-ssh-ca set` and paste it. Terminal is then at `https://appy-ssh.yourdomain.com`. It logs in as your sign-in email before the @; if that is not an Ubuntu user, create it: `sudo useradd -m -s /bin/bash -G sudo NAME && echo NAME \| sudo tee /etc/ssh/principals/NAME && sudo passwd NAME` |
| 9 | `https://appy.yourdomain.com` | Sign in with the temporary password, choose "This Machine", Settings: domain `https://appy.yourdomain.com`, Registration off, Auto Update off. Profile: new password and two-factor. Then run the cleanup command (below) |
| 10 | Browser terminal | `sudo server-alert setup` (Telegram or Discord) |
| 11 | Browser terminal | `sudo server-backup setup`, save the passphrase, then `sudo server-backup run` |
| 12 | Coolify, GitHub, Cloudflare | Coolify, Keys & Tokens: generate an ED25519 key, add its public key in GitHub, repository Settings, Deploy keys (read only). New resource, Private Git Repository (with Deploy Key), `git@github.com:dmo18/crd.git`, Build Pack Docker Compose, Domain `https://cards.yourdomain.com:3000`, HTTPS redirect off, variable `CLIENT_IP_HEADER` = `cf-connecting-ip`, Deploy. Then tunnel route `cards` to `http://127.0.0.1:80` (no sign-in rule: Card Vault has its own password) |
| 13 | Coolify, phone | Copy `SETUP_CODE` from Environment Variables, open `https://cards.yourdomain.com`, Set your password, scan a card |
| 14 | Browser terminal | `sudo server-check` |

## Step 5 command
```
cd ~ && rm -rf crd-main && curl -fsSL https://github.com/dmo18/crd/archive/refs/heads/main.tar.gz | tar xz && cd crd-main/infra/ubuntu && sudo bash bootstrap.sh --cloudflare appy.yourdomain.com you@example.com
```
In the Hyper-V console paste with **Clipboard, Type clipboard text**.

## Step 6 sign-in rules (create before the routes)
An address with a sign-in rule asks for your email code first; an address
without one is open. So your other sites on this domain are not affected.

| # | Name | Subdomain | Path | Policies | Extra |
|---|---|---|---|---|---|
| 1 | Server dashboard | `appy` | | Allow: your email (Bypass for your office is fine) | |
| 2 | Browser SSH | `appy-ssh` | | Allow: your email, **no Bypass** | Browser-based sessions on, protocol SSH |

A Bypass on rule 2 breaks the browser terminal: no sign-in means no certificate.

## Step 7 routes (paths above the empty one)
| # | Subdomain | Path | Service URL |
|---|---|---|---|
| 1 | `appy` | `^/app/` | `http://127.0.0.1:6001` |
| 2 | `appy` | `^/terminal/ws` | `http://127.0.0.1:6002` |
| 3 | `appy` | | `http://127.0.0.1:8000` |
| 4 | `appy-ssh` | | `ssh://127.0.0.1:22` |

Never leave the subdomain empty: that is your main site. Each app gets its
own route later (for example `cards` to `http://127.0.0.1:80`).

## PuTTY from your own network (optional)
The setup turns off password SSH. To allow PuTTY from your local network
only: `curl -sL github.com/dmo18/crd/raw/main/lan-ssh | sudo bash`
(add `-s off` to undo).

## Step 9 cleanup command
```
sudo rm -f /root/coolify-first-login.txt && sudo sed -i '/^ROOT_USER_PASSWORD=/d' /data/coolify/source/.env
```

## After setup
| When | Do this |
|---|---|
| Something looks wrong | `sudo server-support`, `sudo cat` the file it names, paste the text to Claude (secrets are removed) |
| Updates are waiting | `sudo server-update` (backs up first, asks before restarting). Only security patches install by themselves |
| Add another app | Coolify, new resource, Domain `https://name.yourdomain.com:PORT`, Deploy. Then tunnel route `name` to `http://127.0.0.1:80`. Public unless you add a sign-in rule for `name` |
| The server is lost | Steps 2, 3 and 5 on a new machine, then `sudo server-backup restore-dr` with the backup passphrase |
| Locked out | The Hyper-V console always works |
| AI agent on the server | `sudo -iu ops-agent`. It can only look; approve one change with `sudo server-agent-grant "<command>" 30m` |

Also do once: GitHub two-factor sign-in and a pull request rule on `main`;
snapshots or add-only access on your backup server.

More detail: `infra/ubuntu/README.md`, `infra/ubuntu/backup/README.md`,
`docs/COOLIFY.md`.
