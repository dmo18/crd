# Plan

Approved by the owner on 2026-11-15. Run cap: 22 tasks or 2,500,000 delegated
tokens. Preview: phone-size screenshots with sample data.

Every task follows CLAUDE.md and the security rules at the bottom. Checks for
every task: `npm run check` and `npm run build` pass.

## Design decisions (settled, do not reopen)

**Shape.** One Next.js app. Pages under `src/app/(app)/` share a layout with a
bottom tab bar (Home, Scan, Review, Inventory, More). `/login` sits outside it.

**Auth.** One owner. `iron-session` cookie `crd_session` (httpOnly, sameSite
lax, secure in production, 30 days). Password checked with bcryptjs against
`OWNER_PASSWORD_HASH_B64`. Sign-in is rate limited through `login_attempts`.
`src/proxy.ts` only does a fast "is there a cookie" redirect. The real check
is `requireOwner()` in the `(app)` layout, in every server action, and
`guardApi(request)` at the top of every route handler (also rejects
cross-site POST by comparing Origin with Host).

```ts
// src/lib/auth/guard.ts
export async function isOwner(): Promise<boolean>
export async function requireOwner(): Promise<void>            // redirects to /login
export async function guardApi(request: Request): Promise<Response | null> // 401/403 or null
```

**Photos.** The browser shrinks each photo to a JPEG (long edge 2000px) before
upload. The server never trusts that: sharp decodes, auto-rotates, strips
metadata (including location), re-encodes to JPEG, and makes a 400px thumb.
Limits: 15 MB per photo, 12 photos per scan, JPEG/PNG/WebP only. Files are
named by the server (`<uuid>.jpg`) under `DATA_DIR/uploads` and served only
through an authenticated route.

```ts
// src/lib/images/store.ts
export const MAX_UPLOAD_BYTES: number; export const MAX_PHOTOS_PER_SCAN: number
export class ImageError extends Error { userMessage: string }
export type StoredImage = { file: string; thumbFile: string; width: number; height: number; bytes: number }
export async function saveUpload(input: Buffer): Promise<StoredImage>
export async function readStored(file: string): Promise<Buffer>   // rejects bad names
export async function cropStored(file: string, box: Box, padding?: number): Promise<StoredImage>
export async function deleteStored(file: string): Promise<void>
export function isValidImageName(name: string): boolean
```

**Recognition.** Contract in `src/lib/recognition/types.ts`. `getRecognizer()`
in `src/lib/recognition/index.ts` returns the Anthropic one or the sample one
according to `recognitionMode()`. One AI call per scan returns identification,
rarity, visible condition and a value range together. The owner's hint text is
passed as data and can never change the instructions.

**Scan pipeline.** `src/lib/scans/`. A scan row plus its photos are saved,
then processed in the background of the same server process, one at a time.
The browser polls the scan until it is `done` or `failed`. Each recognized
item becomes an `items` row. Confidence at or above `REVIEW_THRESHOLD` is
filed as `confirmed`, otherwise `needs_review`. Scans stuck in `processing`
after a restart are re-queued.

**Value.** Per unit, in cents. `estValueCents` is the middle of the AI range.
`manualValueCents` wins when set. Every change adds a `valuations` row. A
daily row in `collection_snapshots` feeds the chart. Price sources implement
one interface in `src/lib/valuation/` so a paid feed can be added later.

**Kinds.** card, sealed, bulk in one `items` table (see `src/db/schema.ts`).

## Tasks

### Milestone 1: scan one card
| # | Task | Files | Needs | Proof | Model |
|---|---|---|---|---|---|
| 1 | Setup, checks, docs | root, docs | | check + build pass | main |
| 2 | Database and contracts | src/db, src/lib | 1 | foundation.test.ts | main |
| 3 | Owner login | src/lib/auth, src/proxy.ts, src/app/login, src/app/(app)/layout.tsx, src/components/nav | 2 | auth tests; signed-out request redirects | Sonnet |
| 4 | Photo store and camera capture | src/lib/images, src/app/api/images, src/components/capture | 2 | store tests incl. bad files | Sonnet |
| 5 | AI recognition | src/lib/recognition | 2 | tests with a fake AI client; sample is deterministic | Opus |
| 6 | Scan pipeline, scan and result screens | src/lib/scans, src/lib/items, src/app/api/scans, src/app/(app)/scan, src/app/(app)/items/[id] | 3,4,5 | pipeline tests; browser run of a full scan | main + Sonnet |

### Milestone 2: multiples, sealed, bulk
| # | Task | Needs | Proof | Model |
|---|---|---|---|---|
| 7 | Many cards in one photo: crop each card, one item each | 6 | pipeline test; screenshot | Opus |
| 8 | Rapid-fire queue: keep shooting while earlier scans process | 6 | browser run with 5 scans | Sonnet |
| 9 | Sealed packs and boxes flow | 6 | test + screenshot | Sonnet |
| 10 | Bulk lot flow with pull list | 6 | test + screenshot | Sonnet |
| 11 | Review queue and duplicate merge | 6 | tests for merge | Sonnet |

### Milestone 3: value and inventory
| # | Task | Needs | Proof | Model |
|---|---|---|---|---|
| 12 | Valuation engine, re-estimate, manual value, snapshots | 6 | unit tests | Opus |
| 13 | Inventory search, filter, sort, item page edit | 6 | query tests + screenshot | Sonnet |
| 14 | Dashboard | 12 | tests for totals + screenshot | Sonnet |
| 15 | Storage locations and CSV export | 13 | CSV test incl. formula-injection guard | Sonnet |
| 16 | Rarity flags, worth-grading flag, sold-listing links | 12,13 | link builder tests | Sonnet |
| 17 | Final verification, security review, handover | all | full check, review clean | Fable |

## Security rules for every task
- No secrets in code, logs or git. Scan the diff before committing.
- zod-validate all outside input: forms, query strings, uploads, AI output.
- Drizzle query builder only. No SQL built from strings.
- Every page, action and route handler checks the owner session.
- Uploads: type and size limits, re-encode, server-made file names, no path
  from the browser ever touches the file system.
- Errors shown to the browser are short and reveal nothing internal.
- CSV export guards against spreadsheet formula injection.
- Sensitive tasks (3, 4, and anything touching auth or uploads) get an
  independent review by a fresh reviewer.
- A subagent that meets a choice not covered here stops and reports back.

## Milestone 4: free card reading, no keys (approved 2026-11-15)

Owner direction: never require API keys, free preferred. Paid AI code stays
but is off unless `RECOGNITION_MODE=anthropic` is set on purpose. Values come
from sold-listing links plus quick owner entry (no free, allowed, keyless
price source exists; scraping eBay is against its terms).

Recognition modes: `free` (default, `auto` means free), `sample` (tests and
previews), `anthropic` (off unless chosen). Everything in `src/lib/free/`.

```ts
// src/lib/free/ocr.ts  (tesseract.js 7, bundled @tesseract.js-data/eng, offline)
export type OcrLine = { text: string; confidence: number; box: Box };  // box in fractions
export type OcrResult = { text: string; lines: OcrLine[]; confidence: number }; // 0..1
export interface TextReader { read(image: Buffer): Promise<OcrResult> }
export function getTextReader(): TextReader;   // one shared worker, one job at a time
// src/lib/free/find-cards.ts  (sharp only, no AI)
export async function findCardBoxes(image: Buffer): Promise<Box[]>; // reading order
// src/lib/free/parse.ts
export function parseCardText(front: OcrResult | null, back: OcrResult | null): ParsedCard;
export function parseProductText(ocr: OcrResult): ParsedProduct;
// src/lib/free/key-cards.ts
export const KEY_CARDS: readonly KeyCard[];
export function findKeyCard(q: KeyCardQuery): KeyCard | null;
export function keyCardsFor(q: { year?: number | null; yearEnd?: number | null; brand?: string | null; sport?: Sport | null }): KeyCard[];
// src/lib/free/wikidata.ts  (free public API, no key, cached in player_facts)
export async function lookupPlayer(name: string, opts?: LookupOptions): Promise<PlayerFacts | null>;
// src/lib/free/recognizer.ts
export class FreeRecognizer implements Recognizer { name = "free" }
```

| # | Task | Model |
|---|---|---|
| 18 | Server text reading (ocr.ts) | Opus |
| 19 | Card finder for many-card photos (find-cards.ts) | Opus |
| 20 | Text to card details (parse.ts) | Opus |
| 21 | Wikidata player lookup with cache (wikidata.ts) | Sonnet |
| 22 | Key 1980 to 1995 cards list (key-cards.ts) | Opus |
| 23 | Free recognizer wiring, paid path off, quick sold price entry, wording | main + Sonnet |
| 24 | Real-style photo test, security review, pull request | Opus |

Rules: a scan never fails because Wikidata is slow or down (lookups time out
and return null). Network calls only to `www.wikidata.org` and
`query.wikidata.org`, with a generic User-Agent and no personal details.
Tests never touch the network.

## Milestone 5: go live on Cloudways (approved 2026-11-15)

Owner choice: their existing Cloudways **Flexible** server (DigitalOcean),
which already hosts their site. Card Vault runs as a separate Cloudways
application on its own subdomain (for example cards.<their domain>), public
link protected by the owner password. No new paid service. The existing
site must not be disturbed.

How it runs on Cloudways Flexible (no root):
- Node 22 installed with nvm in the master user's home (`.nvmrc` = 22).
- Code is cloned from the public GitHub repo (no keys needed).
- Layout under `CV_HOME` (default `$HOME/cardvault`):
  `releases/<stamp>-<sha>/` (built copies), `current` -> active release,
  `shared/.env.local`, `shared/data/` (DATA_DIR: database and photos),
  `shared/logs/`, `shared/backups/`, `shared/app.pid`.
- Started with `next start -p $PORT` (PORT default 3210) by
  `scripts/server/start.sh`; `watchdog.sh` (cron, every minute) restarts it
  if `/api/health` fails, which also covers server reboots.
- Traffic: Cloudways Nginx -> (Varnish off for this app) -> Apache ->
  `.htaccess` `RewriteRule ... http://127.0.0.1:3210/$1 [P,L]` -> Node.
  mod_proxy may need enabling by Cloudways support.
- Through Apache's proxy the Host header becomes 127.0.0.1:3210 and the
  public host arrives in X-Forwarded-Host. Absolute URLs use `APP_ORIGIN`.
- Daily backup (cron) of the database (online SQLite backup) and photos,
  14 kept, one-step restore. Update and rollback switch the `current` link.
- Memory: heap capped with NODE_OPTIONS so the existing site keeps room.

| # | Task | Model |
|---|---|---|
| 25 | Production settings: APP_ORIGIN redirects, trusted proxy hops for client IP, owner-only connection check, stronger public sign-in limits, scan deadline, cache prune, health route exclusion | Opus |
| 26 | Backup and restore scripts | Sonnet |
| 27 | Install, update and rollback scripts with releases | main (Opus) |
| 28 | Start, stop, watchdog, health endpoint, logs | Sonnet |
| 29 | Phone-friendly go-live guide and a local proxy rehearsal | main (Opus) |

## Milestone 8: blind review, owner-approved updates, backups, logging, agent-ready (approved 2026-11-15)

Owner decisions: nothing changes on the live server without the owner,
except Ubuntu security patches (no automatic restarts); full disaster
recovery from FTP or SFTP; logging and security built in; alerts to
Telegram or Discord (owner chooses at setup); an AI agent will later run on
the server with its own `ops-agent` account that may check freely but must
ask before installing updates, restarting, restoring or deleting.

| # | Task | Model |
|---|---|---|
| 40 | Blind review in four areas (done) | Opus, Sonnet |
| 41 | Server fixes: security-only auto updates, `server-update`, Docker major pin, Cloudflare SSH certificates, other server findings | Opus |
| 42 | App fixes: trusted device cookie, rapid scan duplicates, atomic deletes, other app findings | Opus |
| 43 | Backup and disaster recovery engine (`server-backup`, restic to SFTP or FTPS) | Opus |
| 44 | Card reading accuracy fixes | Opus |
| 45 | Guides: restore, Access before routes, webhooks bypass, "This Machine", support report, runbook | main |
| 46 | Security review and merge | Opus |
| 47 | Logging and alerts: app activity log, journald and Docker log caps, Telegram or Discord alerts, weekly Lynis audit | Opus |
| 48 | Agent-ready server: `ops-agent` user, sudo allowlist, command logging, server ops guide | Opus |

Run cap: 11 tasks or 2.8M tokens.

## Milestone 9: the owner's top three (approved 2026-11-16)

The owner asked for three things after the first real test. They are built
and put live in this order, one part at a time, so each can be tried on
https://cards.moadab.com before the next starts:

- **Part A (9A): take, save, move on.** Scanning never makes the owner wait.
- **Part B (9B): record manager.** Search, select, mass edit, mass delete,
  with a 30 day "Recently deleted" bin.
- **Part C (9C): better reading.** The failed 1990 Topps Ken Griffey Jr. card
  becomes a permanent test. Honest goal: better, not perfect.

Rules for every task in this milestone: CLAUDE.md, the security rules above,
`npm run check` and `npm run build` pass, no new dependency, no paid keys,
tests never touch the network, screens work at 360px with 44px tap targets.
A builder who meets a choice not settled here stops and reports back.
"Review" in a task means a fresh reviewer who did not write the code.

How a part goes live: merge the part into `live`, push, then
`curl -fsS -X POST -H "Authorization: Bearer $(cat ~/.coolify-token)" "http://127.0.0.1:8000/api/v1/deploy?uuid=APP_UUID"`,
wait for `/api/health`, look at the live site at phone width, then tell the
owner in plain words what to try.

### Part A design: take, save, move on (settled)

**What the owner sees.** One scan screen for every mode (one card, many
cards, sealed, bulk). Pick the photos, tap Save. The screen is ready for the
next one at once. Nothing waits for the reading. The old "wait and watch"
phase of `ScanFlow.tsx` is removed. `RapidScan.tsx` is folded into the same
flow: "one card, fronts only, many in a row" stays as a choice in it.

**When the screen may say "Saved".** Only after `POST /api/scans` answered
201. Until then the entry says "Saving". The photo files stay in the page's
memory until the server has them.

**Bad connection.** A failed upload is tried again by the page on its own:
3 more tries, after 2, 8 and 20 seconds. After that the entry says "Not
saved" with a Retry button and the photo is kept in the page. While any
entry is not yet saved the screen shows "Keep this page open until your
photos are saved" and the browser's leave warning (`beforeunload`) is on.
At most 2 uploads run at a time (`MAX_PARALLEL`), at most 100 entries per
visit (`MAX_QUEUE`), both as today. No service worker and no offline
storage in this milestone (see Risks).

**No duplicates from a retry.** The page makes one random id per entry
(`crypto.randomUUID()`) and sends it as form field `clientKey` on every try
for that entry. New column `scans.client_key` (text, null allowed, unique
index). When a scan with that key already exists, `createScan` saves
nothing and the route answers 200 with the existing `scanId`. zod: optional
uuid. This is migration `0006`. It only adds a column and an index.

**Server status, one small route.** `GET /api/scans/status` (behind
`guardApi`, `Cache-Control: no-store`) returns
`{ reading: number, failed: number, toReview: number }`:
`reading` is scans `queued` or `processing`; `failed` is scans `failed`;
`toReview` is items `needs_review`. It calls `recoverScans()` first, like
the list route. Drizzle counts only.

```ts
// src/lib/scans/view.ts
export type ScanStatusCounts = { reading: number; failed: number; toReview: number };
export function scanStatusCounts(db?: Db): ScanStatusCounts;
```

**The indicator.** A small pill in the `(app)` layout, above the tab bar,
on every page: "3 being read", and "1 did not work" in the danger color
when `failed` is above 0. Hidden when both are 0. It is a link to
`/scans`. It is a client component (`src/components/nav/ScanStatus.tsx`).
It asks the status route once when a page loads, then every 5 seconds only
while `reading` is above 0, and once more when the scan screen fires the
window event `crd:scan-saved`. When `reading` drops to 0 it stops asking.
It never asks while the tab is hidden.

**Scan activity page.** New page `/scans` ("Scan activity"), linked from
the pill, from the scan screen ("See what was read") and from More. It
lists the last 50 scans from `recentScans`, newest first: small photo,
status in words ("Waiting", "Being read", "Done", "Did not work" with the
short error), and for done scans the items found, each a link to the item,
with a "Check" tag linking to Review when it needs review. Failed scans
have Retry (existing `POST /api/scans/[id]/retry`) and the existing "Delete
failed scans" button moves here (it also stays on Review). The page
refreshes itself every 5 seconds while anything is waiting or being read.
`/scans` gets no tab of its own.

**In the scan screen.** Below the form, the entries of this visit, newest
first: thumb, "Saving", "Saved, being read", "Read: <title>" (link),
"Check this one" (link to Review) or "Did not work" with Retry. The state
machine stays `scan-queue.ts`; add the automatic upload retry to it as
pure functions with tests. The 6 minute page timeout stays but only
changes the wording of the entry; nothing blocks.

### Part B design: record manager (settled)

**One screen.** New page `/manage` ("Manage records"), opened from a
"Select and edit" button on Inventory and from More. It reuses
`inventoryFilterSchema` and `listItems` so search, filters and sorts are
the same as Inventory. Phone: a list of rows with a 44px checkbox each.
From 1024px wide: a table (checkbox, photo, title, year, brand, number,
player, team, location, value, status). A row tap opens the item page.
No editing inside table cells in this milestone.

**Smart filters.** New optional filter `missing`, one of `player`, `year`,
`brand`, `cardNumber`, `team`, `location`, `value`, `photo`, and new
optional filter `flag`, one of `duplicates` (uses `src/lib/items/duplicates.ts`),
`lowConfidence` (confidence below `REVIEW_THRESHOLD`). They show as one row
of chips: "No player", "No year", "No value", "No location", "Possible
duplicates", "Unsure reads", "Needs review". They are added to
`inventoryFilterSchema`, so Inventory understands the same links.

**Selecting.** Tick rows one by one, "Select this page" (40 rows), or
"Select all N matching". A selection sent to the server is one of:
`{ ids: number[] }` (1 to 500 ids) or `{ filters, expectedCount }` (the
filter values, no page). For the second form the server runs the filter
again; when the count differs from `expectedCount` it changes nothing and
answers "The list changed. Look again." One action touches at most 5,000
items; above that the owner is told to narrow the search.

**Bulk actions** (bottom bar that appears when something is selected):

1. **Set a field.** Fields allowed: sport, year, brand, set name, card
   number, player, team, variation, condition, rarity tier, the six yes or
   no flags, quantity, notes, own value (manual value). Values are checked
   with the matching piece of `itemEditSchema`. Option "Only fill where
   empty" (default on for text fields). Option "Clear this field".
2. **Find and replace** in one text field: player, team, brand, set name,
   variation, card number, notes, description. Plain text, not patterns.
   Option "Match capital letters" (default off). Find text 1 to 100
   characters, replace text 0 to 100.
3. **Move to a location** (or "No location").
4. **Mark as checked** (`confirmed`) or **Mark as needs review**.
5. **Delete** (to the bin, see below).

Every action is two steps. Step one is a dry run: the server returns how
many items would change and up to 5 before and after samples. Step two
applies it after the owner taps "Change N items". All of one action runs in
one `immediate` transaction. Titles are rebuilt with the same code the item
form uses. A changed own value adds a `valuations` row per item, as the
single edit does.

**Undo.** New table `bulk_ops`: id, at, action, a short summary, item
count, `undo` (JSON: for each item id the old values of the changed
columns), `undone_at`. The last 20 are kept, at most 30 days. "Undo" on the
manager screen shows the latest operation not yet undone and puts the old
values back for items that still exist and were not edited since
(`updated_at` not later than the operation). It reports how many were put
back and how many were skipped. Undo of a bulk delete is a bulk restore.

**Recently deleted.** New column `items.deleted_at` (timestamp, null when
live) with an index. Every delete of an item in the app becomes a soft
delete: the single Delete button, delete from Review, and bulk delete. A
deleted item keeps all its rows and photos. It is hidden everywhere else:
inventory, review, home numbers, charts and snapshots, duplicates, export,
scan activity. One helper, `liveItem` in `src/lib/items/live.ts`
(`isNull(items.deletedAt)`), is used by every reader. The item page of a
deleted item shows only "This was deleted on <date>" with Restore.
Page `/manage/deleted` ("Recently deleted"): list with days left, Restore
(one or many), "Delete forever" (one or many) and "Empty the bin", each
with a confirm step. After 30 days a daily job (same pattern as
`maybeCleanupPhotos`) removes them for good with `removeItemRows` and then
`deletePhotoFiles`. Photos are removed only at that point, never before.
Merging duplicates keeps deleting the extra row at once (its count moves to
the kept item, so a restore would count it twice). "Delete failed scans"
is unchanged: failed scans have no items.

```ts
// src/lib/items/live.ts
export const liveItem: SQL;                       // items.deleted_at is null
// src/lib/items/bin.ts
export const BIN_DAYS = 30;
export function softDeleteItems(ids: number[], db?: Db): number;
export function restoreItems(ids: number[], db?: Db): number;
export async function purgeItems(ids: number[], db?: Db): Promise<number>;      // rows, then files
export async function purgeExpired(db?: Db, now?: Date): Promise<number>;
// src/lib/items/bulk.ts
export const MAX_BULK_IDS = 500; export const MAX_BULK_ITEMS = 5000;
export type Selection = { ids: number[] } | { filters: InventoryFilters; expectedCount: number };
export type BulkAction =
  | { type: "set"; field: BulkField; value: unknown; onlyEmpty: boolean }
  | { type: "replace"; field: BulkTextField; find: string; replace: string; matchCase: boolean }
  | { type: "move"; locationId: number | null }
  | { type: "status"; status: ItemStatus }
  | { type: "delete" };
export type BulkPreview = { count: number; samples: { id: number; before: string; after: string }[] };
export function previewBulk(sel: Selection, action: BulkAction, db?: Db): BulkPreview | { error: string };
export function applyBulk(sel: Selection, action: BulkAction, db?: Db): { changed: number; opId: number } | { error: string };
export function undoBulk(opId: number, db?: Db): { restored: number; skipped: number } | { error: string };
```

**Safety.** Every server action starts with `requireOwner()`. Server
actions only (Next checks the origin for them); no new route handler. zod
on every input, with the limits above. Drizzle only; find and replace is
done in JavaScript per row inside the transaction, never with SQL built
from the owner's text. New audit events: `bulk_edit`, `bulk_delete`,
`bulk_restore`, `bulk_purge`, `bulk_undo`, `item_restored`; detail is the
count and the action in a few words, never the full text of notes.

**Migration `0007`.** Adds `items.deleted_at`, its index and `bulk_ops`.
Nothing is removed or rewritten. Before Part B goes live: run the database
backup from HANDOVER.md, check that the backup file exists and is not
empty, then deploy. Rollback: the old code ignores the new column.

**What "full control" covers, and what is out.** In: every field of every
item, in bulk; delete and restore; scans through Scan activity (Part A:
retry, delete failed); locations through the existing Locations page plus
bulk move here. Out for now: editing table cells in place, adding or
swapping photos in bulk, CSV import, editing the value history, editing the
activity log (it must stay a true record), export of just the selection
(the full CSV export stays).

### Part C design: better reading (settled)

**The Griffey card as a permanent test.** The owner's two photos go into
`tests/fixtures/cards/griffey-1990-topps-front.jpg` and `...-back.jpg`
(metadata stripped with sharp, long edge at most 1200px, about 200 KB
together). This is the first photo fixture in the repo; `tests/fixtures/README.md`
says where they came from (the owner's own photos of a public card). Next
to them `griffey-1990-topps.ocr.json` holds the recorded `OcrResult` of
both sides, written by the test helper when run with `UPDATE_OCR=1`, so
the parsing tests are fast and exact.

Facts about these photos that shape the target: they are phone photos of a
screen; the front is cropped so the name reads "KEN GRIFFEY, J"; the back
is cropped so the card number (336) is cut off; the back header is light
text on a dark band; the year stands only in the stat table (last season
89) and in tiny upright print on the right edge.

**Target, checked end to end through `FreeRecognizer` with the real text
reader and no network** (`lookup` faked to return null):

| Field | Must be |
|---|---|
| player | `Ken Griffey Jr.` |
| sport | `baseball` |
| year | `1990` |
| brand | `Topps` |
| team | contains `Mariners` |
| card number | `336` or empty, never another number |
| title | contains `Griffey`, does not contain `Graduated` |
| confidence | at least 0.5 (it may still wait in Review) |

A second, fast test runs `parseCardText` on the recorded text and must give
player candidates that start with a Griffey spelling and contain none of
"Ken Graduated", "Moeller Cincinnati", "Tug Atau Le".

**More reading passes (ocr.ts).** Two new kinds of pass for card photos,
both merged into the result line by line (kept when the text is new), not
"best pass wins":

- *Band pass.* Find up to 3 wide bands: at least 40% of the photo's width,
  4% to 22% of its height, mostly one strong color or dark, with lettering
  inside. Cut each out, enlarge so the band is 160px high, take the color
  channel with the most contrast, flip to dark on light when the band is
  dark, clean with the existing Otsu threshold, read as one line
  (`PSM.SINGLE_LINE`). This is for "MARINERS", "KEN GRIFFEY, JR." and the
  "Ken Griffey, Jr. • OF" header.
- *Edge pass.* Only when no year from 1900 to 2099 was read so far: cut the
  right and left 9% of the photo, turn each upright, enlarge 2 times, read.
  This is for the upright copyright line.

`MAX_PASSES` goes from 6 to 9 for card photos. New lines carry a flag
`source: "band" | "edge" | "page"` on `OcrLine` (optional field) so the
parser can trust a band line as a headline. Time limit: the Griffey scan
(two photos) must finish in under 40 seconds on this server; the builder
measures and writes the number into STATUS.md.

**Parsing rules (parse.ts).**

- A name is never taken from a sentence. A line is a sentence when a
  candidate name is followed by a lowercase word, or the line has 6 or more
  words with a lowercase verb or ends in a full stop. From a sentence only
  the first word is kept, as a first name hint ("Ken").
- Header pattern: `<Name>[, Jr.|Sr.|II|III] <dot, bullet, dash or space> <POS>`
  where POS is a known position for the sport (OF, 1B, 2B, 3B, SS, C, P,
  DH, QB, RB, WR, TE, LB, DB, G, F, C, LW, RW, D and so on). A match is the
  strongest name candidate and sets the position.
- A band line that is all capitals and looks like a name, with or without
  a cut off suffix ("KEN GRIFFEY, J"), is a strong name candidate.
- Team: fuzzy match of capital words against the team names of the four
  sports already in the code (one wrong or missing letter in 6 or more:
  "MARMNERS" gives Mariners). A stat table row counts ("89 MARINERS"), the
  last row wins.
- Year from the stat table: accept seasons read from the first column when
  at least the last two rows are in order, even with repeated years (87,
  88, 88, 89 gives 1990 for brands that print the year after).
- Brand: "TOPPS" read anywhere on front or back (logo, trophy, copyright)
  counts; a lone logo read is the weak kind, as today.

**Bundled player list.** Source: Wikidata, license CC0 (public domain, may
be shipped, no credit required; we credit it anyway). Chosen over the
Chadwick Register because one source covers all four sports with one
format and has no credit duty; Chadwick is baseball only and ODC-By.
`scripts/build-players.mjs` is run by a developer, by hand, never in tests
and never on the server. It asks `query.wikidata.org` (SPARQL, generic
User-Agent, one sport and one birth decade per request, polite pauses) for
people whose occupation is baseball player, American football player,
basketball player or ice hockey player, born 1850 to 2008, with an English
Wikipedia page. Kept per player: name, sport, birth year, first and last
playing year when known, and the number of Wikipedia languages (a fame
score for tie breaks). The 15,000 best known per sport are kept (60,000 at
most). Output: `src/lib/free/data/players.tsv.gz` (target under 1.5 MB)
and `src/lib/free/data/PLAYERS-LICENSE.md` (source, CC0, date built, row
counts). The file is committed, read once on first use with `node:zlib`,
and kept in memory (target under 40 MB of heap, load under 1.5 seconds on
this server; both measured in a test and written to STATUS.md). It is
listed in `outputFileTracingIncludes` in `next.config.ts` so the built app
contains it. A tiny hand written sample list (about 40 players, including
both Ken Griffeys) is used by unit tests through dependency injection; one
test loads the real file and checks counts, size and that "Ken Griffey
Jr." is in it.

```ts
// src/lib/free/players.ts
export type Player = { name: string; sport: Sport; born: number | null; from: number | null; to: number | null; fame: number };
export type PlayerMatch = { player: Player; score: number; exact: boolean };
export function loadPlayers(): readonly Player[];                       // cached
export function matchPlayer(q: { text: string; firstNameHint?: string | null; sport?: Sport | null; year?: number | null }, list?: readonly Player[]): PlayerMatch[]; // best first, at most 5
export function suggestPlayers(prefix: string, opts?: { sport?: Sport | null; limit?: number }, list?: readonly Player[]): Player[]; // for typing
```

**Fuzzy matching rules.** Names are compared in the `normalizeName` form.
The family name must match within 1 wrong letter (5 to 7 letters) or 2
(8 or more); shorter family names must match exactly. The first name must
match, or match as an initial, or be missing; a first name hint from a
sentence counts. "Jr", "Sr", "II", "III" must agree when both sides have
one. The card year, when known, must fit: from birth year plus 16 to birth
year plus 50, or inside the playing years plus 1. The sport must agree
when known. Ties go to the higher fame score. A match is used on its own
only when it is the single best by a clear margin (no second candidate
within 1 wrong letter and a tenth of its fame); otherwise the read text
stays and the candidates are offered in Review. "Eriffey Jr" with year
1990 and baseball must give Ken Griffey Jr., not Ken Griffey Sr.

**Wiring (recognizer.ts).** After parsing: try each name candidate against
the list, best first. A clear match sets the player to the list spelling
and the sport when it was unknown, adds 0.15 to confidence (the same step
the online facts give; both together still add 0.15 only), and writes
"Name matched to the player list" in the AI notes. The online Wikidata
lookup stays as it is and is asked with the corrected name; team and
position from it are used to confirm, never to overrule the card. A scan
never fails because the list cannot be loaded: log once, carry on without.
Key card: add `1990 Topps #336 Ken Griffey Jr.` (tier `star`, "Second year
card with the All-Star Rookie cup") to `KEY_CARDS`; when year, brand and
player match exactly one key card and the number was not read, the number
is filled from it and the note says so.

**Fast fix in Review.** The player field in `ItemForm` and a new "Fix
name" control on each Review row get suggestions while typing, from
`GET /api/players?q=...&sport=...` (behind `guardApi`, zod: q 2 to 40
characters, at most 8 answers, `no-store`). Built with a labeled input
and a plain list of 44px buttons below it (no `datalist`, it is poor on
phones). Review rows whose scan left other candidates show them as one tap
chips ("Did you mean Ken Griffey Jr.?"). Picking a name saves the player
and rebuilds the title through the existing `updateItem`.

### Tasks

Order: 9.1, then Part A, Part B, Part C. Inside a part the tasks run in
number order unless "depends on" allows side by side work.

**9.1 Housekeeping: test time limit and deploy note** (Haiku)
- Files: `vitest.config.ts`, `docs/HANDOVER.md`.
- Depends on: nothing.
- Done when: `testTimeout` and `hookTimeout` are 60000 in the Vitest
  config; HANDOVER.md shows the deploy call as
  `curl -fsS -X POST ... "http://127.0.0.1:8000/api/v1/deploy?uuid=APP_UUID"`
  and says "Coolify 4.7.5: POST, not GET".
- Check: `npm run check` passes with all tests green on this server (465
  today, none timing out).

#### Part A (9A)

**9.2 Server: safe repeat uploads and status counts** (Sonnet, review)
- Files: `src/db/schema.ts`, `drizzle/0006_*`, `src/lib/scans/create.ts`,
  `src/lib/scans/view.ts`, `src/app/api/scans/route.ts`,
  `src/app/api/scans/status/route.ts` (new), `src/lib/scans/scans.test.ts`.
- Depends on: 9.1.
- Done when: `clientKey` works as designed (same key twice gives one scan,
  one set of photo files, second answer 200 with the same id; a bad key is
  a 400); `scanStatusCounts` and the status route exist; both routes sit
  behind `guardApi`.
- Check: tests for first upload, repeat upload (file count on disk does not
  grow), two repeats racing, no key (works as before), status counts for
  each scan state, 401 without a session. Migration applies to a copy of a
  database made by `0005`.

**9.3 One scan screen: take, save, move on** (Sonnet, review)
- Files: `src/components/items/ScanFlow.tsx`, `RapidScan.tsx` (folded in,
  then removed), `scan-queue.ts`, `scan-queue.test.ts`,
  `src/app/(app)/scan/page.tsx`.
- Depends on: 9.2.
- Done when: every mode saves and frees the form at once; "Saved" shows
  only after the server answered; automatic retries (2, 8, 20 seconds) then
  a Retry button; `clientKey` sent on every try; leave warning while
  anything is unsaved; entries list as designed; `crd:scan-saved` fired;
  no code path waits for a scan to finish before the next photo.
- Check: reducer tests for the retry steps and for "never two uploads of
  one entry at once"; a test with a fake `fetch` that fails twice then
  works gives one scan; phone width screenshots (sample mode) of: form,
  3 entries in mixed states, "Not saved" with Retry.

**9.4 "Being read" pill and Scan activity page** (Sonnet)
- Files: `src/components/nav/ScanStatus.tsx` (new), `src/app/(app)/layout.tsx`,
  `src/app/(app)/scans/page.tsx` (new), `src/components/items/ScanActivity.tsx`
  (new), `src/app/(app)/more/page.tsx`, `src/lib/scans/view.ts`.
- Depends on: 9.2. Can run beside 9.3.
- Done when: pill and page behave as designed; polling stops at 0 and
  while the tab is hidden; failed scans show the reason, Retry and delete;
  items link to the item page and to Review.
- Check: unit test for the "when to ask again" function (pure); page test
  data with one scan in each state; screenshots at 360px of pill (reading,
  failed) and of the page; no layout shift of the tab bar.

**9.5 Part A review and go live** (Opus review, main agent deploys)
- Files: fixes only, `docs/STATUS.md`.
- Depends on: 9.2, 9.3, 9.4.
- Done when: a fresh review of uploads and the new routes has no open
  finding; a rehearsal in sample mode with the network throttled and cut
  mid upload ends with every photo saved once; Part A is live.
- Check: `npm run check`, `npm run build`, live `/api/health`, one sample
  free scan on a test build (not on the owner's data), owner message sent.

#### Part B (9B)

**9.6 Recently deleted: soft delete everywhere, restore, purge** (Opus, review)
- Files: `src/db/schema.ts`, `drizzle/0007_*`, `src/lib/items/live.ts` and
  `bin.ts` (new) with tests, `update.ts`, `remove.ts`, `query.ts`,
  `stats.ts`, `duplicates.ts`, `review-actions.ts`, `actions.ts`,
  `src/lib/scans/view.ts`, `src/lib/valuation/snapshots.ts` and `index.ts`,
  `src/lib/audit/subjects.ts`, `src/app/api/export/route.ts`,
  `src/app/(app)/review/page.tsx`, `src/app/(app)/items/[id]/page.tsx`,
  the startup hook that runs the daily jobs.
- Depends on: Part A live.
- Done when: design above holds; `bulk_ops` table is in the same migration
  (used by 9.7); every reader of `items` uses `liveItem` or says in a
  comment why not (purge, restore, the bin list, image archiving).
- Check: one test seeds a live and a deleted item and asserts the deleted
  one is absent from inventory, review, each stats function, duplicates,
  snapshot totals, export and scan views; photo files of a deleted item
  still exist after `removeOrphanPhotos` and after the item's last sibling
  from the same scan is deleted; restore brings back item, photos and
  value history; `purgeExpired` at day 29 removes nothing and at day 31
  removes rows and files; migration applies to a copy of a `0006` database
  with rows in it.

**9.7 Bulk engine: preview, apply, undo** (Opus, review)
- Files: `src/lib/items/bulk.ts` (new), `bulk.test.ts`, `bulk-actions.ts`
  (server actions, new), `query.ts` (`missing`, `flag` filters, a function
  that returns matching ids up to a cap), `src/db/schema.ts` (audit event
  names only), `src/lib/audit/*` labels.
- Depends on: 9.6.
- Done when: all five actions, both selection forms, the limits, the two
  steps, undo and the audit events work as designed; every action calls
  `requireOwner()` first and validates with zod.
- Check: tests for each action; "only fill where empty" leaves filled rows
  alone; find and replace treats `%`, `_`, `\` and quotes as plain text;
  `expectedCount` mismatch changes nothing; 501 ids and 5,001 matches are
  refused; a failure in the middle rolls everything back; undo skips rows
  edited afterwards and reports the numbers; titles rebuilt; value history
  rows added for bulk own value; actions redirect to `/login` without a
  session; 5,000 item update finishes in under 5 seconds on this server.

**9.8 Manager screen and Recently deleted screen** (Sonnet)
- Files: `src/app/(app)/manage/page.tsx`, `src/app/(app)/manage/deleted/page.tsx`,
  `src/components/manage/*` (new: list, table, selection bar, action
  sheets, preview step, undo notice), `InventoryFilters.tsx` (new chips),
  `src/app/(app)/items/page.tsx` (button), `src/app/(app)/more/page.tsx`.
- Depends on: 9.7.
- Done when: the screens match the design at 360px and at 1280px; the
  selection survives paging inside one visit; "Select all N matching"
  shows N; every action shows its preview before it changes anything;
  after an action a notice shows the count with Undo; all controls labeled
  and 44px.
- Check: `npm run check`; screenshots with sample data at 360px (list,
  selection bar, each action sheet, preview, bin) and 1280px (table);
  keyboard only pass on the wide table.

**9.9 Part B review and go live** (Opus review, main agent deploys)
- Files: fixes only, `docs/STATUS.md`, `docs/HANDOVER.md` (the bin and the
  30 days, the backup step before schema changes).
- Depends on: 9.6, 9.7, 9.8.
- Done when: a fresh review of deletion, the migration and the bulk
  actions has no open finding; the database was backed up and the backup
  checked right before the deploy; Part B is live.
- Check: `npm run check`, `npm run build`; migration rehearsed on a copy of
  the live database file (copy read only, never the live file); live
  `/api/health`; live item count before and after the deploy is the same;
  owner message sent.

#### Part C (9C)

**9.10 Griffey fixture and extra reading passes** (Opus)
- Files: `tests/fixtures/cards/*`, `tests/fixtures/README.md`,
  `tests/helpers/ocr-fixture.ts` (new), `src/lib/free/ocr.ts`,
  `ocr.test.ts`, `src/lib/free/griffey.test.ts` (new, the end to end
  target, marked `todo` for the fields later tasks deliver).
- Depends on: Part B live (order only; no code link).
- Done when: band and edge passes exist as designed; on the fixture the
  real reader returns a line matching `/GRIFFEY/i` from the front and one
  from the back header, and a line matching `/MARINERS/i`; older reading
  tests still pass unchanged; recorded text file written.
- Check: `ocr.test.ts` cases with made up pictures (white on black band,
  black on orange band, upright edge text) plus the fixture; pass count
  never above 9; time for the two fixture photos printed and under 40
  seconds.

**9.11 Parsing rules: no names from sentences, headers, teams, years** (Opus)
- Files: `src/lib/free/parse.ts`, `parse.test.ts`, `accuracy.test.ts`.
- Depends on: 9.10 (uses the recorded text).
- Done when: the five parsing rules hold; on the recorded Griffey text:
  no sentence names, team Mariners, year 1990, brand Topps, position OF.
- Check: new unit tests per rule (at least 3 real style lines each,
  including bios such as "Bo played football at Auburn" and headers such
  as "CAL RIPKEN, JR. SS"); the whole existing accuracy suite still
  passes with no expectation loosened.

**9.12 Player list: build script, data file, loader, matcher** (Opus)
- Files: `scripts/build-players.mjs`, `src/lib/free/data/players.tsv.gz`,
  `src/lib/free/data/PLAYERS-LICENSE.md`, `src/lib/free/players.ts`,
  `players.test.ts`, `next.config.ts`.
- Depends on: nothing in Part C; can run beside 9.10 and 9.11.
- Done when: the list is built from Wikidata as designed and committed;
  loader and matcher follow the rules; size, memory and load time are
  inside the targets; the script is the only code that talks to the
  network and no test imports it.
- Check: matcher tests on the sample list (Eriffey Jr gives Griffey Jr.;
  Jr. and Sr. kept apart; short names need an exact match; wrong sport or
  impossible year refused; a tie gives no single winner); real file test
  (row counts per sport, under 1.5 MB, heap growth under 40 MB, load under
  1.5 seconds); `npm run build` output contains the data file.

**9.13 Use the list when reading; Griffey target met** (Opus)
- Files: `src/lib/free/recognizer.ts`, `recognizer.test.ts`,
  `src/lib/free/key-cards.ts`, `key-cards.test.ts`, `griffey.test.ts`.
- Depends on: 9.10, 9.11, 9.12.
- Done when: wiring as designed; every row of the Griffey target table
  passes with the real reader and no network; no `todo` left in
  `griffey.test.ts`; unmatched candidates are kept for Review (stored in
  the item's AI notes as a short "Other names: a, b" line, at most 3).
- Check: `griffey.test.ts`; recognizer tests with a fake reader for: clear
  match, tie, list missing, list and online facts disagree; existing
  recognizer and accuracy tests pass.

**9.14 Fix a name fast in Review** (Sonnet)
- Files: `src/app/api/players/route.ts` (new) with a test,
  `src/components/items/PlayerInput.tsx` (new), `ItemForm.tsx`,
  `ReviewRowActions.tsx`, `src/app/(app)/review/page.tsx`,
  `src/lib/items/review-actions.ts`.
- Depends on: 9.12 (list), 9.13 (other names line).
- Done when: typing 2 letters shows up to 8 names within half a second on
  the server; one tap fills and saves; "Did you mean" chips appear when
  the scan left other names; route behind `guardApi` with zod limits.
- Check: route tests (401, too short, too long, limit, sport filter);
  screenshots at 360px of the suggestions and the chips; saving through a
  chip rebuilds the title.

**9.15 Part C review and go live** (Opus review, main agent deploys)
- Files: fixes only, `docs/STATUS.md` (measured times and sizes, what
  still reads badly), `docs/SPEC.md` (reading section).
- Depends on: 9.10 to 9.14.
- Done when: a fresh review (license file, no network in tests or at run
  time beyond the existing Wikidata lookup, memory on the server) has no
  open finding; Part C is live; the owner is asked to scan the Griffey
  card again and three other cards.
- Check: `npm run check`, `npm run build`, live `/api/health`, container
  memory after the first scan noted in STATUS.md and under 1 GB.

| # | Task | Model |
|---|---|---|
| 9.1 | Housekeeping: test time limit, deploy note | Haiku |
| 9.2 | Server: safe repeat uploads, status counts | Sonnet + review |
| 9.3 | One scan screen: take, save, move on | Sonnet + review |
| 9.4 | "Being read" pill and Scan activity page | Sonnet |
| 9.5 | Part A review and go live | Opus + main |
| 9.6 | Recently deleted: soft delete, restore, purge | Opus + review |
| 9.7 | Bulk engine: preview, apply, undo | Opus + review |
| 9.8 | Manager screen and Recently deleted screen | Sonnet |
| 9.9 | Part B review and go live | Opus + main |
| 9.10 | Griffey fixture and extra reading passes | Opus |
| 9.11 | Parsing rules | Opus |
| 9.12 | Player list: build, data, loader, matcher | Opus |
| 9.13 | Use the list when reading; Griffey target met | Opus |
| 9.14 | Fix a name fast in Review | Sonnet |
| 9.15 | Part C review and go live | Opus + main |

### Risks

- **Photos live in the page until saved.** If the owner closes the browser
  while an entry still says "Saving", that photo is lost. The screen says
  so and warns before leaving. Keeping photos on the phone across restarts
  would need offline storage and is left out on purpose.
- **Reading stays imperfect.** Photos of a screen, glare and cut off edges
  will still fail sometimes. The Griffey test proves this one card; the
  fast name fix is the safety net.
- **Slower scans.** Up to 3 more passes per photo. A scan may go from about
  14 to about 25 seconds. It no longer blocks the owner (Part A), which is
  why Part A goes first.
- **Wrong "correction".** Fuzzy matching can turn an unknown player into a
  famous one. The clear margin rule, the year and sport checks and the note
  in the item limit this; unclear cases go to Review.
- **Soft delete missed in one reader.** A deleted item could still show in
  a total. One helper and one test over every reader guard against it.
- **Schema changes on the live database** (0006, 0007). Both only add.
  Backup is checked before each deploy; old code still runs on the new
  schema.
- **Bulk mistakes.** One tap can change thousands of records. Preview,
  count check, Undo and the bin limit the damage.
- **Memory.** The player list adds up to 40 MB. The server has 4 GB;
  measured after go live.
- **Wikidata build.** The public query service can time out. The script
  works in small slices and can resume; it runs at build time only, so a
  failure never reaches the live site.

### Questions for the owner (answered 2026-11-16)

Answers: 1 yes, 30 days. 2 yes, fix and note it. 3 decided by the builder: yes.
Also decided: order A, B, C; run to the end; `main` is updated only when the
owner says the live version is good (finished parts go to `live`).

1. **When you delete a record, keep it 30 days in "Recently deleted"
   before it is gone for good?** Recommended: yes, 30 days.
2. **May the app correct a misread name by itself when it is sure (for
   example "Eriffey Jr" becomes "Ken Griffey Jr."), and say so on the
   card's page?** Recommended: yes. Unsure cases wait in Review with
   "Did you mean" buttons.
3. **Is it fine that a photo is only safe once the screen says "Saved",
   so you keep the page open for the few seconds that takes?**
   Recommended: yes. Reading then goes on by itself, page open or not.

Run cap: 19 tasks or 4.5M delegated tokens.
