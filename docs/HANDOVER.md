# Handover: the server Claude runs everything

Written by the Claude session that built Card Vault and the server "appy",
for the Claude that now lives on that server. Read this fully once. Then read
`CLAUDE.md` (code rules), `docs/SPEC.md`, `docs/PLAN.md`, `docs/STATUS.md`.

## Your role
You are the single Claude for this owner: you design, build, test, deploy and
operate. The owner decided this on 2026-11-15 and gave you full authority on
the server, including changes to the server itself. The older rule "look
freely, ask before changes" in `/home/ops-agent/CLAUDE.md` is replaced by
this file and `/agent/CLAUDE.md`; its facts about the server remain useful.

Full authority is trust, not a licence to be careless:
- Before anything risky (system updates, firewall, SSH, Coolify settings,
  data migrations) make sure a fresh backup exists: `sudo server-backup run`.
- Never open a port to the internet. Everything comes in through the
  Cloudflare Tunnel. Never weaken SSH (no passwords except the LAN rule).
- Never touch the bare domain `moadab.com` or names you did not create. The
  domain is shared; its main site is WordPress elsewhere.
- Never hide what you did. Sudo sessions are recorded; keep it that way.
- You cannot click in Cloudflare or GitHub settings. When a step needs the
  owner (a route, a sign-in rule, a deploy key), give exact clicks and values.
- Tell the owner afterwards, in plain words, what you changed and how to undo it.

## The owner
- Not a developer. Works from a phone and a remote desktop. Types fast with
  typos; read for intent. Has zero tolerance for instructions that fail:
  test every command you hand over, exactly as they will run it.
- Plain language. Short steps. Commands they can paste. One approval per plan,
  then run to the end. Status blocks, not essays.
- Never em dashes or en dashes, in chat, UI text or docs.
- Never paid API keys. Free tools only. (Paid AI recognition exists in the
  code but stays off unless `RECOGNITION_MODE=anthropic`.)
- Nothing on the server updates by itself except Ubuntu security patches. No
  automatic restarts. Other updates: `sudo server-update`, at a time you pick
  sensibly and announce.
- Secrets never go in git, logs, chat or command lines.
- Use the skill `owner-workflow` for every piece of work, and `new-app` when
  the owner wants another app.

## How code goes live (the owner's choice: live is dev)
- GitHub `dmo18/crd` is the source. Branch `main` = last version the owner
  called good. Branch `live` = what is running and being refined.
- Your working copy: `/agent/crd`. You push with the deploy key in
  `/home/ops-agent/.ssh/id_ed25519` (write access to this one repository).
- Loop: edit in `/agent/crd` on `live`, run `npm run check`, commit, push
  `live`, deploy, look at https://cards.moadab.com, tell the owner what to try.
- When the owner says it is good: merge `live` into `main` and push `main`.
- If a change breaks the site: redeploy the last good commit (reset `live` to
  `main` with a new commit or `git revert`, push, deploy). Never force-push `main`.
- Card data is not in the code. It lives in the Docker volume mounted at
  `/data` in the container (SQLite database and photos). Rebuilds keep it. A
  bad migration can still damage it: back up before any schema change
  (`npm run db:generate` creates migrations; they apply on startup).

First-time tasks for this loop (do them, ask the owner only for clicks):
1. Install Node matching `.nvmrc` so `npm ci` and `npm run check` work in
   `/agent/crd`. Tests never touch the network. OCR tests need fonts
   (`fonts-dejavu-core`) or they fail for a reason unrelated to the code.
2. Create branch `live` from `main` and push it.
3. In Coolify (https://appy.moadab.com), the Card Vault app, Git Source:
   switch the branch from `main` to `live`. Ask the owner to click it, or use
   the API below.
4. Deploys without clicking: ask the owner to enable the API (Coolify,
   Settings) and create a token under Keys & Tokens with deploy rights. Store
   it in `/home/ops-agent/.coolify-token`, mode 600, never in git. Then:
   `curl -fsS -X POST -H "Authorization: Bearer $(cat ~/.coolify-token)" "http://127.0.0.1:8000/api/v1/deploy?uuid=APP_UUID"`
   Coolify 4.7.5: POST, not GET (GET answers "use POST"). Card Vault's uuid
   is `uxxie2puczalzcb3yxzfw5fe`. Progress:
   `GET /api/v1/deployments/<deployment_uuid>` (status `finished` or `failed`).
   Done on 2026-11-16: branch is `live`, API on, token stored (read, deploy).
   Owner rule: deploy only through Coolify, never with docker by hand.

## The server
- "appy": Ubuntu 24.04 on Hyper-V, LAN 10.20.1.12, behind the owner's
  firewall. Built by `infra/ubuntu/bootstrap.sh` 1.3.1 in Cloudflare mode.
  Details: `infra/ubuntu/README.md`, `docs/SERVER.md`, `docs/COOLIFY.md`.
- Coolify v4.7.5 hosts apps. Its proxy (Traefik) listens on 127.0.0.1:80 and
  routes by host name. Card Vault's port 3000 exists only inside its container.
- Cloudflare tunnel "appy". Routes: `appy` `^/app/` to :6001, `appy`
  `^/terminal/ws` to :6002, `appy` to :8000, `appy-ssh` to ssh :22, `cards`
  to `http://127.0.0.1:80`. No wildcard (Cloudflare does not offer it). No
  webhook route. Access apps: `appy` (Allow DBM plus two office-IP Bypass),
  `appy-ssh` (Allow DBM only, browser rendering SSH). `cards` has none: it is
  public and Card Vault has its own login.
- Accounts: `owner` (PuTTY, console), `david.moadab` (browser terminal;
  Cloudflare logs in as the sign-in email's name), `ops-agent` (you).
- SSH: Cloudflare certificates (CA `/etc/ssh/ca.pub`, names in
  `/etc/ssh/principals/`). Password SSH only from LAN 10.20.1.0/24
  (`/etc/ssh/sshd_config.d/00-lan.conf`, from the `lan-ssh` script).
- You run in tmux under systemd (`claude-agent.service`, command `agent`).
- Tools: `server-check`, `server-support`, `server-update`, `server-backup`,
  `server-alert`, `server-logs`, `server-docker-logs`, `server-status`,
  `server-lynis`. Alerts go to the owner's Telegram.
- `sudo server-check` will now FAIL or WARN on the lines about ops-agent's
  sudo rights. That is expected since the owner gave you full authority. If
  bootstrap.sh is ever run again it reinstalls the read-only guide but keeps
  `/etc/sudoers.d/zz-ops-agent-owner`.

## Lessons paid for during setup (do not repeat)
- This server's awk is gawk. In scripts with `pipefail`, never pipe into a
  reader that quits early (`grep -q`, `awk ... exit`, `head`): the writer dies
  of SIGPIPE and the script stops silently. Read the whole output first
  (`grep -q x <<<"$(cmd)"`).
- Test what you hand over the way the owner runs it: as a normal sudo user,
  from any folder, in a real terminal. A test harness that ignores SIGPIPE or
  starts in a writable folder hides real failures.
- A command that downloads and unpacks must `cd ~` first.
- Typing long commands into the Hyper-V console garbles them. Give short
  commands or use PuTTY or the browser terminal.
- Cloudflare's browser SSH only presents its certificate for the user named
  like the email's local part. A different Ubuntu user never works there.
- A Bypass policy on the SSH Access app breaks the browser terminal.
- An Access app covers every path of its host. A host with no Access app is open.
- Tunnel route with an empty subdomain means the bare domain. Never create one.
- Coolify inside a sandbox without IPv6 fails its health check; real hosts are fine.

## Open items when this was written
- Card Vault is live at https://cards.moadab.com and, in the owner's words,
  "a fail" that "needs lots of refining". Ask the owner for the first three
  things that bother them most, on their phone, and start there.
- Backups may not be set up yet: `sudo server-backup setup` needs the owner's
  SFTP or FTPS details and they must save the passphrase. Do this before
  heavy work on live data.
- Coolify lock-down to confirm: admin password changed, two-factor on,
  registration off, auto update off, `/root/coolify-first-login.txt` deleted.
- `/etc/ssh/sshd_config.d/00-debug.conf` (verbose logging) should be removed.
- The owner plans to make this repository private. Coolify already uses a
  read-only deploy key, so deploys keep working. The one-line commands that
  download from GitHub (step 5 of the guide, `lan-ssh`, `agent-session`,
  `agent-builder`) stop working then; disaster recovery needs step 5. Before
  it goes private, propose moving `infra/` and those scripts to a small
  public repository, or keep a copy on the backup server.
