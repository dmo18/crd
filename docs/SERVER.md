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
| 6 | Cloudflare Zero Trust | Access, Applications: add the five sign-in rules (below) |
| 7 | Cloudflare | Tunnel `appy`, Public Hostname: add the six routes (below), then one DNS record: CNAME `*` to `TUNNEL-ID.cfargotunnel.com`, proxied |
| 8 | Cloudflare, console | Access, Service credentials, SSH: generate a certificate for "Browser SSH", copy the public key, run `sudo server-ssh-ca set` and paste it. Terminal is then at `https://ssh.yourdomain.com` |
| 9 | `https://admin.yourdomain.com` | Sign in with the temporary password, choose "This Machine", Settings: domain `https://admin.yourdomain.com`, Registration off, Auto Update off. Profile: new password and two-factor. Then run the cleanup command (below) |
| 10 | Browser terminal | `sudo server-alert setup` (Telegram or Discord) |
| 11 | Browser terminal | `sudo server-backup setup`, save the passphrase, then `sudo server-backup run` |
| 12 | Coolify | New project, Public Repository `https://github.com/dmo18/crd`, Build Pack Docker Compose, Domain `https://cards.yourdomain.com:3000`, HTTPS redirect off, variable `CLIENT_IP_HEADER` = `cf-connecting-ip`, Deploy |
| 13 | Coolify, phone | Copy `SETUP_CODE` from Environment Variables, open `https://cards.yourdomain.com`, Set your password, scan a card |
| 14 | Browser terminal | `sudo server-check` |

## Step 5 command
```
curl -fsSL https://github.com/dmo18/crd/archive/refs/heads/main.tar.gz | tar xz && cd crd-main/infra/ubuntu && sudo bash bootstrap.sh --cloudflare admin.yourdomain.com you@example.com
```
In the Hyper-V console paste with **Clipboard, Type clipboard text**.

## Step 6 sign-in rules (create before the routes)
| # | Name | Subdomain | Path | Action | Include |
|---|---|---|---|---|---|
| 1 | All apps | `*` | | Allow | Emails: yours |
| 2 | Server dashboard | `admin` | | Allow | Emails: yours |
| 3 | Browser SSH (Browser rendering: SSH) | `ssh` | | Allow | Emails: yours |
| 4 | GitHub notices | `admin` | `webhooks/source/github/events` | Bypass | Everyone |
| 5 | Public apps | `cards` (plus your main site's proxied subdomains, like `www`) | | Bypass | Everyone |

Never put `admin`, `ssh` or `*` in rule 5.

## Step 7 routes (in this order)
| # | Subdomain | Path | Type | URL |
|---|---|---|---|---|
| 0 | `admin` | `^/webhooks/source/github/events(/manual)?$` | HTTP | `127.0.0.1:8000` |
| 1 | `admin` | `^/app/` | HTTP | `127.0.0.1:6001` |
| 2 | `admin` | `^/terminal/ws` | HTTP | `127.0.0.1:6002` |
| 3 | `admin` | | HTTP | `127.0.0.1:8000` |
| 4 | `ssh` | | SSH | `127.0.0.1:22` |
| 5 | `*` | | HTTP | `127.0.0.1:80` |

## Step 9 cleanup command
```
sudo rm -f /root/coolify-first-login.txt && sudo sed -i '/^ROOT_USER_PASSWORD=/d' /data/coolify/source/.env
```

## After setup
| When | Do this |
|---|---|
| Something looks wrong | `sudo server-support`, `sudo cat` the file it names, paste the text to Claude (secrets are removed) |
| Updates are waiting | `sudo server-update` (backs up first, asks before restarting). Only security patches install by themselves |
| Add another app | Coolify, new resource, Domain `https://name.yourdomain.com`, Deploy. Private until `name` is added to "Public apps" |
| The server is lost | Steps 2, 3 and 5 on a new machine, then `sudo server-backup restore-dr` with the backup passphrase |
| Locked out | The Hyper-V console always works |
| AI agent on the server | `sudo -iu ops-agent`. It can only look; approve one change with `sudo server-agent-grant "<command>" 30m` |

Also do once: GitHub two-factor sign-in and a pull request rule on `main`;
snapshots or add-only access on your backup server.

More detail: `infra/ubuntu/README.md`, `infra/ubuntu/backup/README.md`,
`docs/COOLIFY.md`.
