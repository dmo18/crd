---
name: new-app
description: Checklist for adding another app to the server "appy" (new repository, Coolify resource, Cloudflare route). Use when the owner wants to build or deploy a new app or site.
---

# Adding an app to appy

Every app follows the same pattern as Card Vault. Use `owner-workflow` for
the build itself; this is the hosting checklist.

1. **Name.** Pick a short subdomain with the owner, for example `shop`. Check
   it is not already used on the shared domain (DNS records, tunnel routes).
2. **Repository.** One GitHub repository per app, private by default. You
   cannot create repositories or deploy keys yourself: give the owner the
   clicks (New repository; then Settings, Deploy keys). Make two keys:
   - a write key for your working copy in `/agent/NAME` (generate it with
     `ssh-keygen -t ed25519 -f ~/.ssh/NAME_ed25519 -N ""`, add a `Host`
     alias in `~/.ssh/config`),
   - a read-only key generated in Coolify (Keys & Tokens) for deploys.
3. **Shape of the app.** A `Dockerfile` (non-root user, pinned base image)
   and a `docker-compose.yaml` like Card Vault's: one service, a named volume
   for data, a health check, secrets from Coolify's generated variables
   (`SERVICE_PASSWORD_...`), never in git. Copy `CLAUDE.md`, `docs/` layout
   and the `.claude/skills` folder into the new repository.
4. **Coolify.** New resource, Private Git Repository (with Deploy Key),
   Build Pack Docker Compose, branch `live`, domain
   `https://NAME.moadab.com:PORT` (PORT is the port inside the container),
   Force HTTPS off (Cloudflare does HTTPS), environment variable
   `CLIENT_IP_HEADER=cf-connecting-ip` if the app limits sign-ins by address.
5. **Cloudflare (owner clicks).** Tunnel `appy`, Routes, Add route: subdomain
   `NAME`, path empty, Service URL `http://127.0.0.1:80`. Private app: also an
   Access application for `NAME` with the Allow policy. Public app: none.
   Never leave the subdomain empty.
6. **Backups.** `server-backup` covers Coolify-managed volumes; run
   `sudo server-backup run` after the first deploy and check the new volume
   is listed in `sudo server-backup status`.
7. **Verify** from outside: the address loads over HTTPS, private apps ask
   for the Cloudflare sign-in, `sudo server-check` shows nothing new.
8. **Record it** in that app's `docs/STATUS.md` and add the app to the list
   in `/agent/crd/docs/HANDOVER.md` under "The server".
