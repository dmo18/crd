# Status

## Milestone 8: blind review, owner-approved updates, backups, logging, agent-ready
- Blind review in four areas (app, card reading, server, guides); fixes for
  every critical, high and medium finding plus most lows.
- Updates: only Ubuntu security patches install by themselves; no automatic
  restarts; `server-update` backs up first and asks; Docker major version
  pinned; Coolify auto update off.
- Backup and DR: `server-backup` (restic, encrypted, SFTP or FTPS) with a
  full restore onto a fresh server, tested against real Coolify 4.7.5.
- Logging and security: app activity log (365 days) and alerts to Telegram
  or Discord; capped system and Docker logs; server alerts; weekly Lynis;
  auditd; certificate-only browser SSH.
- Agent-ready: `ops-agent` account that can only check, one-time grants
  for changes, session recording, guide at ~/CLAUDE.md; `server-support`
  redacted help report.
- Photos: AVIF archives, about 61 KB per card instead of 807 KB.
- Card reading: 27 of 27 realistic test cases (4 before); on the owner's
  13 sample screenshots, 7 give useful data, none wrongly confirmed; the
  rest show only a signature or logo, which free text reading cannot read.
- Not verified: everything on a real Hyper-V machine (auditd rules load,
  Cloudflare browser SSH certificates, Access path bypass for webhooks,
  live tunnel, Telegram/Discord delivery, AVIF display on phones).
- Known issue: one full test run failed once while three builders ran heavy
  tests in parallel; not reproduced in 8 later runs. Likely a timing
  sensitive test under load; not yet pinned down.


## Milestone 7: Cloudflare Tunnel, private by default, self updating
- Owner choices: Cloudflare (DNS already there), main site stays elsewhere,
  one subdomain per app, new apps private until marked public, Cloudflare
  set up by hand (no API token on the server), everything kept on the
  latest released versions.
- Server: `bootstrap.sh --cloudflare`: cloudflared from Cloudflare's signed
  repository, token in a root-only file, no inbound ports at all, browser
  SSH through the tunnel (password only from loopback and only for the
  owner's user), cloudflared walled off from Docker's controls.
- Updates: unattended upgrades for Ubuntu security and updates, Docker and
  cloudflared (reboot at 04:30 only if needed); Coolify auto update;
  GitHub Dependabot weekly update PRs with CI (lint, types, tests, build,
  container health) on every PR; Coolify webhook deploys merged updates.
- Card Vault: CLIENT_IP_HEADER=cf-connecting-ip behind the tunnel, IPv6
  limits per /64, http APP_ORIGIN upgraded to https.
- Verified: Cloudflare mode run in a systemd Ubuntu container (signed
  repo, token secrecy, nothing reachable from outside, sshd rules, mode
  switching, update origins), sshd owner-only rule, unit file check, 306
  tests, build without local settings (as CI runs it).
- Not verified: a live tunnel, Cloudflare Access rules, browser SSH, the
  Coolify dashboard through the tunnel, a real Docker engine upgrade, and
  cloudflared running under the new path restrictions (outside programs
  cannot be downloaded and run in this sandbox).
- Security review: no critical or high. Fixed: cloudflared cannot reach
  Docker's socket, loopback SSH limited to the owner, separate dashboard
  and SSH Access apps with tunnel token checking, CI actions pinned by
  commit. Accepted: Docker major versions update automatically (the port
  guard fails closed if Docker ever changes its firewall backend).


## Milestone 6: own Ubuntu app server with Coolify (ready for the owner)
- Cloudways dropped (needs a terminal the owner does not want). Owner's
  Hyper-V host: Ubuntu 24.04 VM with its own public IP and no network
  security in front, Coolify dashboard public with password and 2FA
  (owner's informed choice), hosts Card Vault and future apps.
- infra/ubuntu/bootstrap.sh: firewall allowing only 80/443, Docker port
  guard (DOCKER-USER rules, loaded before Docker starts, re-applied every 5
  minutes), SSH closed to the internet and key only, fail2ban, unattended
  security updates, swap, Coolify with a pre-created admin and a 30 minute
  first-login window whose closing timer is created first.
  infra/ubuntu/check.sh audits it. Guide: docs/SERVER.md.
- Card Vault container (non-root, pinned base image by digest, health
  check, data volume), Coolify compose with generated secrets, a /setup
  page protected by a generated setup code (no terminal), password change
  that signs out other devices, nightly in-container backup.
- Verified: container built and run here (setup, sign in, free scan,
  restart and rebuild keep data, backup); bootstrap run in a systemd Ubuntu
  container with the real Coolify installer (only 80/443 answered from
  outside, window closed by itself, rules survive restart); 291 tests.
- Not verified: the real Hyper-V machine, IPv6 (guide says A records only),
  the Coolify dashboard end to end, Coolify's exact generated address
  format (APP_ORIGIN now tolerates a slash, path or the internal :3000).
- Security review: no critical or high; mediums fixed (setup window fail
  open, Docker starting before the rules, IPv6 sharing a limit). Accepted:
  first dashboard login is over plain HTTP during the 30 minute window;
  backups stay on the server unless the owner adds off-site storage.


## Milestone 5: go live on Cloudways (ready for the owner)
- Runs as a separate Cloudways app on the owner's existing Flexible server,
  public https link, owner password. Guide: docs/GO-LIVE.md.
- Scripts in scripts/server: install (Node 22 via nvm, checksum checked),
  update (backup first, automatic rollback if the new version fails),
  rollback, start, stop, keep-alive every minute, nightly backup (14 kept),
  restore. Public health check at /api/health shows only ok or not.
- Public link hardening: APP_ORIGIN, visitor address from the second
  X-Forwarded-For entry from the right (Nginx then Apache), lockouts of 15
  minutes and 24 hours per address, global pause at 300 failures, owner-only
  Connection check on the More page.
- Rehearsed here end to end against a stand-in for Cloudways Nginx and
  Apache: real installer on a clean home folder, sign in, scan, save,
  photos, connection check (spoofed address ignored), update, rollback,
  crash recovery, broken update refused with nothing changed.
- Not verified: the real Cloudways server (mod_proxy must be enabled by
  support, memory on the shared server, cron access for the master user).
- Security review: no critical or high. Fixed: nvm checksum, failed build
  never goes live, .htaccess permissions, cron jobs preserved, backup link
  check, exact process match, passphrase spaces. Accepted: anyone can pause
  sign-in for 15 minutes with 300 wrong tries; updates trust the GitHub
  account (owner turns on 2FA and branch protection, see the guide).


## Milestone 4: free card reading, no keys (done)
- Owner rule: never require API keys; free preferred.
- Cards are read on the server with Tesseract (offline, bundled English
  data), a card finder splits many-card photos, a parser pulls out year,
  brand, number, player, team and slab details, a built-in list of 107 key
  1980 to 1995 cards flags rookies and errors, and Wikidata (free, no key,
  cached 90 days) confirms players and Hall of Fame status.
- Values: one-tap sold listing links plus a quick "Price you saw" box.
  No automatic prices (no free, keyless, allowed source exists).
- Paid AI code kept but off unless `RECOGNITION_MODE=anthropic`.
- Verified: 239 tests, build, phone-size walkthrough with printed-style
  test cards: single cards identified in 2 to 4 seconds, 6 of 6 names read
  in a many-card photo, sealed box and bulk lot labels read.
- Not verified: real phone photos of real cards (glare, wear, busy fronts).
  Expect more scans in Review than with paid AI.
- Known limits: card fronts alone rarely show the year, so front-only
  scans usually wait in Review; adding the back photo helps most. Wikidata
  data has gaps (for example, Michael Jordan's Hall of Fame entry was not
  found). The key card list comes from model knowledge and leaves out cards
  it was unsure of.


## Done (all 17 planned tasks)
- Milestone 1: setup, database, owner login, camera capture, AI recognition
  (real and sample), scan pipeline, scan and item screens
- Milestone 2: many cards in one photo, rapid-fire scanning, sealed product,
  bulk lots with pull lists, review queue, duplicate detection and merge
- Milestone 3: valuation engine with fresh-estimate button, inventory search
  and filters, dashboard, storage locations, CSV export, rarity flags,
  grading advice, sold-listing links, final verification

## Verified
- `npm run check`: lint clean, types clean, 165 tests pass
- `npm run build`: passes
- Phone-size browser walkthrough (sample mode): sign in, all five scan modes,
  item edit and re-estimate, review, inventory filters, locations, export,
  dashboard. No console or network errors, no sideways scrolling.
- Signed-out and forged-cookie requests receive no data.
- Two independent security reviews. No critical or high findings remain.
- `npm audit --omit=dev`: 0 vulnerabilities.

## Not verified (needs a real Anthropic API key)
- Real card recognition and real value estimates. The request format,
  answer checking and error handling are tested against a stand-in only.
  First real scans should be spot-checked for accuracy and speed.
- The 130point search link format.
- Real phone camera behaviour (tested with a phone-size desktop browser).

## Decisions and reasons
- Next.js + SQLite in one app: one thing to host, cheap, enough for one owner.
- `cacheComponents` off: private per-request app.
- System fonts: faster on phones, builds offline.
- Password hash stored base64 encoded: bcrypt hashes contain `$`, which env
  file loading would otherwise mangle.
- One `items` table for cards, sealed and bulk: one inventory, one search.
- Money in integer cents: no rounding errors.
- Sample recognizer and price source: every screen can be built, tested and
  previewed with no API key and no cost.
- AI model default `claude-opus-5-5`, changeable with `ANTHROPIC_MODEL`.
  Structured JSON output, always re-checked before saving.
- High-confidence scans (75% or more) are filed as confirmed; the rest wait
  in Review.
- Duplicates are suggested, never merged automatically, because condition
  can differ between copies.
- Tasks 1, 2, the scan pipeline, and the end of tasks 12 and 16 were done in
  the main session. The Opus builder for 12 and 16 stopped at the account
  usage limit; the owner chose to continue straight away.

## Known issues and follow-ups
- Sign-in limit trusts the first `x-forwarded-for` address. Before going
  live, read the address from the chosen host's own header. Thirty wrong
  passwords in 15 minutes from anywhere lock sign-in for everyone for that
  window (signed-in sessions keep working). Use a long password.
- Signing out clears only that device. To sign out everywhere, change
  `SESSION_SECRET`.
- Original photos from multi-card scans and photos from failed scans are
  kept on disk. A cleanup job would save space on very large collections.
- Scans are processed one at a time inside the server. Fine for one owner;
  it needs a host that keeps one server running (not serverless).
- The value chart needs at least two days of use before it draws a line.
- `npm audit`: 12 moderate findings, all in developer tools (the linter's
  file matcher), none in the running app.
- No paid price feed yet. The `PriceSource` interface is where one plugs in.

## Open security findings
Milestone 4 review: no critical or high. Three lows fixed (edge label
crop, at most 3 extra label passes per photo, text engine start timeout).
Open lows: a scan has no overall time limit (each reading pass has 60s);
Wikidata cache rows are never pruned (small, owner-only growth).
None critical or high. Low: forwarded-address trust (above). Info: the
content security policy allows inline scripts (needed by the framework
without per-request nonces); photos stay in the browser cache after sign-out.

## Run log
- Delegated tokens: about 1,230,000 of 2,500,000 (reported by helpers; the
  interrupted Opus run did not report a figure and is not included).
- Helper runs: Sonnet 8, Opus 4 (1 interrupted). Failed attempts: 1.
