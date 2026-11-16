# Status

## Milestone 10: the card catalog (live 2026-11-16, commit 0b19b1d)
- Search cards (free MyCardfolio catalog, no key), Add by hand, link and
  unlink later; every scan asks the catalog in the background and Review
  shows ranked suggestions with one tap "This is my card"; owner fields are
  never overwritten; "Use the catalog's values" for read fields.
- Automatic filling is OFF (AUTO_FILL_SURE false): the sure rule failed
  review five times; every catalog card needs the owner's tap.
- Connections screen (More): switch, Test, usage, stored answers; locked
  key store (AES-256-GCM) ready for free signup keys in Milestone 14.
- Outside-call gate: one call at a time, pacing, caps, retry, pause on
  429, stored answers with age limits, no secrets logged.
- Better free reading (Part C merged): extra band and edge passes, no names
  from sentences, team only when certain or confirmed by Wikidata, else a
  hint in notes. Griffey test: Ken Griffey Jr., 1990, Mariners, #336 Topps
  first in the suggestions.
- Verified: 1122 tests, build, npm audit 0, phone screenshots with a real
  catalog search, live deploy healthy, migration 0008 applied, data intact.
- Known: Did-you-mean team chip not built (needs a migration); brand often
  unread from photos; a big many-card sheet uses quick reads (6 passes).

## Milestone 10: the card catalog (in progress, branch work/m10)
- 10.10 done: branch work/m9c merged (reading passes, sentence rule, name
  particles, header years, Griffey fixture kept). Team from text is now a
  weak hint. The team is written only when one nickname is read exactly, in
  capitals, on a team line (the team, its city, positions, numbers) that is
  not a sentence, and no other team is read; or when the hint is in the
  player's Wikidata team list (a key card player is looked up only for
  that). Otherwise the notes say "Maybe team X (not sure, check it)". Close
  spellings are only hints; they need look alike letters (I and M, E and F,
  O and Q), never the last letter, and a position of another sport drops
  them. Lowercase nicknames ("the twins") are ignored; plain word
  nicknames (STARS, KINGS, HEAT, TIGERS) count only on a team line. A small
  l in a word in capitals is read as I. Split stat rows with the club and no
  numbers: four digit years count too; card words ("88 ROOKIE", "87 DRAFT
  PICK", "1989 MONTHLY") and checklist names ("56 JOHN SMITH") do not.
  The second review's list (H1, M1 to M4, L1, L2) is a named test each in
  `parse.test.ts`. Griffey end to end (recorded text, recorded catalog
  answers, Wikidata facts written by hand): Ken Griffey Jr., baseball,
  1990, Seattle Mariners (confirmed by the team list), no number, no brand,
  and 1990 Topps #336 (551033) first in the suggestions, not filled. With
  the real reader the whole Griffey scan took 13 to 15 s (3 runs, all
  green). Not done here: the "Did you mean" team chip in Review (the hint is
  in the notes only, a chip needs a stored field and a migration), and the
  container memory after one scan (needs the live container).
- 10.6 matching (`src/lib/catalog/match.ts`, `lookup.ts`): timing on this
  server after 10.6d (median of 7 runs): a full look up on an 800 row
  checklist in memory with 5 spellings about 7 ms (limit 20 ms); judging
  800 names with 5 spellings about 7 ms; turning 800 cards into slim rows
  (once per scan) about 5 ms.
- 10.6f (FINAL rule, replaces the sure rules of 10.6d and 10.6e): a
  catalog card is sure only when the read number equals the card's number,
  a whole first name and the surname (and the suffix) equal the card's
  parsed names after folding, the card row has a first name, sport, year
  and brand were read with one brand and one year tried (not a year from
  stat rows), the base set id is confirmed by its fetched Base Set
  checklist and the card is in it, no other player of the pool (checklist
  rows and every answer seen for this card) carries that surname or one
  ending in it unless the read first name tells them apart, and the card
  is not a subset, variation, insert or multi-player card. Sure by name in
  a complete set is gone. "Von Hayes" now parses as first Von; particles
  join the surname only in names of three or more words. A second clean set
  id for a key in any later answer marks a conflict for the rest of the
  scan. Step 1 stops as soon as a card would be sure and fetches the
  checklist to confirm (a cold start Griffey #336 costs 2 calls).
  Choices made inside the rule: rows of another whole name ("Jeff D." and
  "Jeff M. Robinson", "Dave Johnson (P)") are other players; "Ken Griffey"
  is not exact for "Ken Griffey Jr."; only clean rows count as rivals.
- 10.6d (simpler rule after the second failed review, sure rules replaced by 10.6f): a catalog card is
  sure only when (a) the read number and the name agree with one clean base
  card (not a subset card, not a variation), or (b) the checklist is
  complete and exactly one player fits the read name, compared on parsed
  first name, surname and suffix. Everything else, also a name that stands
  alone in a checklist cut short, is a ranked candidate for Review. The
  confirm search is gone; the number search for cards past #500 stays.
  Bracketed qualifiers ("(P)", "(Texas)") are dropped before names are
  parsed. The scan's checklist memory keeps slim rows (parsed once).
- 10.6c rules still in force: subset cards and variations are never sure;
  the sport is part of the set key and memory lives only for one scan;
  every network try counts in the budgets (8 per card, 40 per scan), one
  retry at most; a "busy" answer stops catalog calls for the rest of the
  scan; a prefix fits only for an initial or a read under 3 letters.
- 10.6d choices made inside the settled rules (for the next review): a
  subset card is not sure even with its number read (rule (a) says
  non-subset); with checklists in memory a card gets at most one search
  (the number search past the cut); with no sport read nothing is sure by
  name alone and the scan's memory is not used; a card of several players
  counts as a subset card; in a complete set any other fitting player
  (also on a subset or variation card) blocks a sure card by name.
- Known limit: "Ken Griffey, J" with no number in 1990 Topps (cut short at
  500 of 792) is a top candidate only, not sure; it needs one tap in Review.
- Known gap: a misread name with no number and no earlier clean hit of the
  same year and brand finds no base set id (the broad "year brand" search
  gives only noise, see CATALOG-TRIAL.md), so no checklist is fetched.
- 10.9 catalog in the scan (branch work/m10-scan): after the free reading
  each card is looked up in the `background` line within the scan budget;
  a sure card is kept, linked and fills only empty fields (marked
  `catalog`), confidence by `lookupConfidence`; otherwise up to 5 candidates
  wait on the item for one tap in Review. Catalog trouble never fails a
  scan: Review says "Catalog not checked" with the reason. Choices made
  (for the review): the catalog part of a scan starts no look up after 2
  minutes of catalog time or 4 minutes after the reading began (the scan
  has 5); "Look up again" stores what it finds as candidates (a sure card
  first) and fills nothing until the owner taps; a pick whose card differs
  from what the scanner read links and fills, but keeps the item in Review
  with the differences and "Use the catalog's values" (Confirm keeps the
  scanner's values); the item page shows the same differences and button
  after "This is my card". Canonical key keeps the printed number order.

## Milestone 9: the owner's top three (2026-11-16)
- Part A live (f1258f6): take, save, move on for every scan mode; uploads
  live in a provider in the app layout and survive page changes; safe
  repeats with clientKey (migration 0006); one batched status call every
  5 s only while the tab is visible; "being read" pill; Scan activity page;
  version in the footer (package version plus deployed commit).
- Part B live (bb517da): Manage records (search, smart filters, select
  page or all matching, set a field, find and replace, move, mark, delete),
  preview before every change with a list fingerprint, undo with summary
  and date, Recently deleted bin for 30 days with restore, delete forever,
  empty the bin, purge in batches; undo text scrubbed on purge and merge
  (migration 0007).
- Verified: npm run check (598 tests), build, npm audit 0, phone and wide
  screenshots with sample data, a real delete and undo through the screens,
  live deploys healthy with migrations applied and data intact (backups in
  /root/cardvault-db-backups before each deploy).
- Part C (better free reading) is on branch work/m9c, not live: failed
  review twice on team guessing; folded into Milestone 10 (see ROADMAP).
- Test time limit raised to 60 s: AVIF encoding takes about 2 s per photo
  on the server's old CPU.
- Known: one test failed once while a build ran in parallel; not reproduced.

## Milestone 9 Part C: better reading (merged into work/m10 in task 10.10)
- 9.10 done: the owner's two photos of the 1990 Topps Ken Griffey Jr. card
  are a permanent test (`tests/fixtures/cards/`, recorded text in
  `griffey-1990-topps.ocr.json`). New reading passes for card photos: up to
  3 wide colored or dark bands read as one line each, and the left and right
  edge strips turned upright when no year was read. At most 9 passes a photo.
- Measured on this server, both Griffey photos together: before 9.10 about
  12 s for the whole scan, after 9.10 about 12 to 14 s (front 9 passes, back
  6). Limit is 40 s.
- Reads now: "KEN GRIFFEY, J" from the front name strip and
  "Ken Griffey, Jr. OF" from the dark back header. Not read: MARINERS on
  the front (the cap hides part of it; the band reader gets nothing), and
  TOPPS anywhere (the logo is script, the copyright print on the right edge
  is too small and sits inside the photo, not in the outer 9% strip).
- 9.11 done: parsing rules. No name from a bio sentence (its first word is
  kept only as a first name hint), the name header "Name, Jr. * POS" is the
  strongest name and sets the position, a name in capitals read from a band
  is trusted, team names match with one letter wrong ("MARMNERS"), the last
  stat table row gives the team, and split stat rows with a repeated season
  give the year.
- 9.11 review fixes: a close team spelling is now narrow (same first
  letter, 6 or more letters, one letter wrong or one left out but not one
  of the last two, a stop list of surnames and plain words, never on a line
  that gave a player name, half weight, and only when no team was read
  exactly). So "TOM BREWER" with "RED SOX" is Red Sox and "KEVIN BROWN" is
  no team. Names with a small word ("Jose de Jesus") are not sentences. A
  header such as "1989 UPPER DECK" is not a stat row. Known limit: a row
  with the club but no numbers still counts with a two digit season
  ("89 MARINERS"), because the reader splits the Griffey rows that way.
  The end to end Griffey test checks only stable fields; the exact name
  words are checked on the recorded text.
- Griffey photos end to end now: sport baseball, year 1990, team Seattle
  Mariners, player "Ken Griffey Jr." (matched to the key card list from the
  header), no number, no wrong names. Whole scan about 13 to 19 s.
- Open question for the owner or lead: the brand Topps is not read from
  these photos (see above), so the Griffey test cannot meet "brand Topps"
  or "confidence at least 0.5" (confidence is 0.35 without the brand). Both
  stay marked todo in `griffey.test.ts`. Milestone 10's catalog may settle
  it; a wider edge strip was tried and read nothing useful either.
- The same photo can read slightly differently depending on what the text
  engine read just before (seen in testing). The band reading of the back
  header's G switches between "Griffey" and "Criffey" with small changes.

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
- Final security review: no critical or high. Fixed: the agent can no
  longer mute or imitate system alerts (own labelled agent-send command
  and budget; agent and grant alerts are never held back; held-back alerts
  no longer count as sent), restore-files only into a root-owned restore
  area, snapshot volume paths validated, a warning when the newest backup
  looks too old, grants cannot answer restart questions, better secret
  removal in help reports, the webhook route anchored. Accepted with
  advice in the guide: protecting backups from a taken-over server needs
  snapshots or add-only access on the backup server itself; the setup
  downloads the current main branch (no release tag yet). The backup end
  to end suite was not re-run after the restore path change (direct rule
  check done); auditd only logs the agent's own-account commands, its
  sudo commands are in the sudo session recordings.
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
- The photo edit queue is separate from the scan and archiver sharp work (a
  builder choice). Worst case is about 3 large decodes at once, which is fine
  on 4 GB.
- A restored original is turned into AVIF again by the archiver within
  minutes, so restore is exact only until then.
- Duplicates (11.6, builder choices inside the settled design, all on the
  safe side: unclear pairs are a "maybe", which never combines): a pair with
  equal version names where one is confirmed and the other never asked is a
  "maybe"; a serial copy on one side only is a "maybe"; two different print
  runs (/100 and /50) are not duplicates.
- Combining moves the other record's photos (and kept originals) to the
  kept record and takes them off the old scan. When that scan still has a
  whole-sheet photo, the scan stays (with no cards) so the sheet is kept. A
  kept record can then hold two fronts; the page shows both.
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
