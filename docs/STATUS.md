# Status

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
