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

**9.4b Version in the footer** (added by the owner 2026-11-16, main session)
- Files: `src/lib/version.ts` (+ test), `src/app/(app)/layout.tsx`.
- Every signed-in page ends with "Version 0.1.0 (abc1234)": package version
  plus the first 7 letters of `SOURCE_COMMIT`, which Coolify sets in the
  running container. Anything not a hex commit shows "dev". Not on /login
  (no version details for signed-out visitors).

**9.3 review decisions (settled 2026-11-16 after the 9.3 review failed)**
- The scan queue and uploader live in a client provider in `(app)/layout.tsx`,
  so moving to another page inside the app never stops or loses uploads.
- Permanent errors (4xx except 408 and 429) stop at once and show the
  server's short message. No Retry for 400, 413, 415; for 401 keep Retry and
  add a "Sign in again" link.
- Each upload aborts after 90 s and counts as a retryable failure.
- One live region, always rendered, announces counts ("2 saving, 1 not
  saved"); the "Keep this page open" notice is announced too.
- Preview URLs are freed on failure and timeout as well.

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

## Milestone 10: the card catalog (approved 2026-11-16 as part of the roadmap)

What the owner can try when it is live: search any card by words and add
it; add a card by hand; after a scan, pick the right card from a short list
in Review; see in "More, Connections" which outside sources the app uses,
test them, and see how many calls were made.

Source of the facts below: `docs/CATALOG-TRIAL.md` (task 10.1, done, verdict
GO with conditions) and `docs/ROADMAP.md` ("Owner answers", "Part C status",
section 3).

Rules for every task in this milestone: CLAUDE.md, the security rules above,
`npm run check` and `npm run build` pass, no new dependency, no paid keys,
tests never touch the network (recorded answers in `tests/fixtures/catalog/`
or fakes), screens work at 360px with 44px tap targets, no em or en dashes.
A builder who meets a choice not settled here stops and reports back.
"Review" in a task means a fresh reviewer who did not write the code. Every
task that touches keys, outside calls or the database layout gets one.

Not in this milestone (Milestone 11 or later, do not start): the "Which
version is it?" picker, serial number split, rookie mark with source, photo
rotate and crop, the new duplicate check on the canonical key, the full
"Data sources" page, sold prices, set progress.

One go live at the end (task 10.11), on the Milestone 9 way: merge into
`live`, push, Coolify deploy call, `/api/health`, look at phone width, then
tell the owner in plain words what to try.

### Design: identity (settled)

**One migration, adds only.** `drizzle/0008_*` is written in task 10.2 and
holds every new table and column of this milestone (identity, gate,
connection keys), so there is one reviewed change to the live database.
Nothing is renamed, dropped or made required. Code from before the
migration keeps running on the new layout.

**Catalog cards.** New table `catalog_cards`: one row per card the owner
confirmed (picked in Review, added from Search, or linked later). Never a
row for a card the owner only looked at.

| Column | Meaning |
|---|---|
| `id` | number |
| `canonicalKey` | unique text, see below |
| `sport`, `year`, `brand`, `setName`, `cardNumber`, `player`, `team`, `variation` | cleaned values; `cardNumber` as printed ("11T") |
| `verified` | true when it came from a clean catalog entry (all digit id), false for an unverified listing |
| `fieldSources` | JSON, for each filled field one of `catalog`, `owner`, `reading`, `key_list`, `wikidata` |
| `createdAt`, `updatedAt` | times |

**Canonical key.** `v1|sport|year|brand|set|number|player`, each part
normalized: lowercase, accents and punctuation removed, spaces collapsed;
brand through `normalizeBrand`, number through `normalizeCardNumber`, player
through `normalizeName` (all three already in `src/lib/free/key-cards.ts`
and moved to `src/lib/catalog/normalize.ts`, re-exported from the old
place); set is `base` when the source says "Base Set" or nothing. A catalog
card needs sport, year, brand and player; number may be empty. A record
with less than that stays a plain item without a catalog link. The key is
built in one function, `canonicalKey()`, and the `v1` prefix lets
Milestone 11 rebuild keys when versions arrive. The version (Tiffany and so
on) is not part of the key design work here: "Topps Tiffany" from the
source is stored as brand `Topps`, variation `Tiffany`, and the variation
text is the last key part only when it is not empty.

**Source ids.** New table `catalog_sources`: `catalogCardId`, `source`
(`mycardfolio`), `sourceId` ("551033"), `url` (the card's page, shown as
"From MyCardfolio" so the source is cited), `sourceSetId` ("9179"),
`fetchedAt`. Unique on (`source`, `sourceId`). One catalog card may have
several source rows later (prices in Milestone 14).

**Items.** New nullable columns on `items`:
- `catalogCardId`: link to `catalog_cards`, set null on delete.
- `firstSuggestion`: JSON written once when a scan creates the item and
  never changed again (F21): the scanner's fields, its confidence, which
  reader made it, the time. Items made before this milestone have null and
  the item page then shows nothing for it.
- `fieldSources`: JSON, for each filled field `reading`, `catalog`,
  `owner` or `key_list`. `updateItem` and the bulk engine mark every field
  the owner changes as `owner`. Old items have null, which is treated as
  `owner` for every filled field (the safe reading: never overwrite).
- `catalogCandidates`: JSON, at most 5 slim candidates from the last look
  up (source, source id, url, year, brand, set, number, player, verified,
  score, a few plain words on why), with the time. Cleared when the owner
  picks one, says "None of these", confirms the item, or after 30 days.

**Filling rule (used everywhere a catalog card meets an item).**
`applyCatalogCard(item, card)` in `src/lib/catalog/apply.ts`:
1. Empty fields are filled and marked `catalog`.
2. A field marked `owner` is never changed.
3. A field marked `reading` that differs from the catalog is not changed
   by the one tap pick. The differences are listed under the pick
   ("Scanner read team: Twins. Catalog says: Mariners") with one more
   button "Use the catalog's values", which changes only those `reading`
   fields.
4. The title is rebuilt, a `valuations` row is not touched, and
   `firstSuggestion` stays as it was.
Unlinking sets `catalogCardId` to null and changes no other field.

### Design: the shared gate for outside calls (settled, F49 core)

`src/lib/outside/gate.ts`. Every call that leaves the server goes through
`outsideCall(source, request, options)`. Nothing else in the app may call
`fetch` for an outside address; a test greps `src/` for `fetch(` outside
this folder and the two known exceptions (alerts, and the Wikidata fetch
which is wrapped in this milestone).

**Sources** are listed in code in `src/lib/outside/sources.ts`: id, plain
name, fixed https host, whether it needs a key, its caps, its Test call.
The address of a call is built from the fixed host; no part of a URL ever
comes from the browser or from a catalog answer. Redirects are refused.
User-Agent is `CardVault/<version>` with no personal details. Cookies are
never stored or sent.

**Limits for `mycardfolio`** (the site states no number; the trial ran one
call per 2 seconds without trouble, so the app stays at or below that):

| Limit | Value |
|---|---|
| Calls at the same time, all sources together | 1 |
| Pause between call starts | at least 2,000 ms |
| Per hour | 200 |
| Per day (UTC) | 1,000 |
| Timeout | 5 s (10 s for a checklist) |
| Largest answer read | 2 MB |

Wikidata is registered as a second source with its limits of today, so its
calls are counted too; its own `player_facts` store stays as it is.

**Order.** Two lines: `now` (the owner is looking at a screen: Search,
Test, "Look up again") goes before `background` (scans). A `now` call that
cannot start within 8 seconds gives up with "The catalog is busy. Try again
in a moment." A `background` call that meets a cap is skipped, not queued
for hours: the scan keeps its plain reading.

**Retry and backoff.** Timeout, network error or status 500 and above: up
to 2 more tries after 2 s and 8 s (plus up to 500 ms of random spread).
Status 429, or 403 from the front door: no retry; the source is paused for
the `Retry-After` time when given (1 second to 1 hour), otherwise 15
minutes. Three failed calls in a row pause the source for 10 minutes. The
pause is stored, so a restart does not forget it. Other 4xx: no retry.

**Counters.** Table `outside_usage`, one row per source and UTC day:
calls, answers from the store, errors, "slow down" answers, skipped by cap,
total wait in ms. Table `outside_state`, one row per source: switched on
or off by the owner, paused until, last good call, last error in a few
plain words (never a URL with a key, never an answer body). Hour counts
live in memory and are rebuilt as "0 so far" on restart, which is safe
because the day cap and the pacing still hold.

**Stored answers.** Table `outside_cache`: key (SHA-256 of source, tool and
normalized arguments), source, kind, body, fetched at, expires at, size.

| Kind | Kept for |
|---|---|
| search answer with results | 7 days |
| search answer with nothing | 1 day |
| card detail, variants | 30 days |
| set checklist | 30 days |

Total size cap 50 MB; the oldest rows go first. Pruned on write, at most
once an hour. A stored answer is used without counting as a call.

**Storage policy (the site's terms say "free for personal and assistant
use, read only, rate limited" and nothing about storing).** Settled:
- Search and checklist answers are kept only for the bounded times above,
  only on this private server, only to spare the site repeat calls.
- Kept for good: only the cards the owner confirmed (`catalog_cards`),
  each with its source link.
- Never: copying the whole catalog, walking sets the owner did not scan or
  search, showing catalog data to anyone else, downloading the site's card
  images (the app links to the card page instead).
- "Clear stored catalog answers" on the Connections screen empties
  `outside_cache` for a source. Switching a source off stops all calls to
  it; the app then works as before this milestone.
- This is written into `docs/SPEC.md` (a new "Outside sources" section) and
  `docs/HANDOVER.md` in task 10.3.

### Design: Connections screen and keys (settled)

`/more/connections`, linked from More. Owner session required on the page
and in every action.

**Per source card:** name, what it is used for in one line, state (On, Off,
"Paused until 14:20: the site asked us to slow down", "Needs a key"), a
switch, **Test** (one small real call through the gate in the `now` line;
for MyCardfolio a search for "1990 Topps Griffey" with limit 1; shows
"Works, answered in 0.3 s" or a short plain reason), "Clear stored
answers", and the **usage view**: calls today against the day cap, calls
this hour, answers taken from the store today, errors today, last good
call, and a 7 day list of calls per day. Test may be tapped once per 10
seconds per source and counts as a call. The full "Data sources" page with
"why a lookup waited" is Milestone 11 and is not built here.

**Keys** (design from the owner answers; first real use is Milestone 14).
`src/lib/outside/keys.ts`, table `connection_keys` (source as primary key,
ciphertext, iv, auth tag, last 4 characters, saved at, last test at, last
test result).
- Encryption: AES-256-GCM from `node:crypto`, a fresh random 12 byte iv on
  every save, the source id as additional authenticated data. The 32 byte
  key comes from HKDF-SHA256 over `SETTINGS_KEY` (new optional setting, at
  least 32 characters), falling back to `SESSION_SECRET`; fixed salt
  `crd-connections-v1`, info `key:<source id>`.
- Write only: the key is pasted once and never sent back to the browser.
  The screen shows "Saved, ends in ...4f2a" and the date. Buttons: Replace,
  Remove, Test.
- Each source gives a shape rule (length and characters) checked with zod
  before saving; at most 200 characters; surrounding spaces removed.
- When a key cannot be opened (the setting changed) the card says "This
  key must be entered again" and the source counts as "Needs a key".
- The key never appears in logs, audit rows, errors, the CSV export or the
  usage view. The gate adds the key to the request at the last step and
  the logger gets the request without headers.
- New audit events: `connection_key_saved`, `connection_key_removed`,
  `connection_tested`, `connection_switched`, `catalog_answers_cleared`.
  Detail holds the source name and the outcome, never the key or its end.
- No source with a key is live in this milestone (MyCardfolio and Wikidata
  need none). The key part is built and proven with a `demo` source that
  exists only when `NODE_ENV` is not `production`; Milestone 14 adds the
  first real one as one entry in `sources.ts`.
- `SETTINGS_KEY` is added to `.env.example` and, at go live, set once in
  Coolify by the main agent (random, 48 characters), so no key is ever
  stored under the session secret.

### Design: MyCardfolio client (settled)

`src/lib/catalog/`: `types.ts` (the one interface, so the catalog can be
swapped), `mycardfolio.ts`, `clean.ts`.

```ts
// src/lib/catalog/types.ts
export type CatalogCard = {
  source: "mycardfolio"; sourceId: string; url: string; sourceSetId: string | null
  verified: boolean                 // clean entry: id is all digits
  sport: Sport | null; year: number | null; brand: string | null; setName: string | null
  cardNumber: string | null; player: string | null; otherPlayers: string[]
  variation: string | null; tags: string[]   // "RC", "IR", "TC"... kept for Milestone 11
}
export type CatalogResult<T> = { ok: true; value: T; fromStore: boolean } | { ok: false; reason: "off" | "paused" | "cap" | "busy" | "failed" }
export type Line = "now" | "background"
export interface Catalog {
  search(q: { text: string; sport?: Sport; year?: number; limit?: number }, line: Line): Promise<CatalogResult<CatalogCard[]>>
  card(sourceId: string, line: Line): Promise<CatalogResult<CatalogCard | null>>
  checklist(sourceSetId: string, line: Line): Promise<CatalogResult<{ cards: CatalogCard[]; complete: boolean }>>
}
```

**Wire format.** POST to `https://mycardfolio.com/api/mcp` with
`Content-Type: application/json` and `Accept: application/json,
text/event-stream`; body is JSON-RPC `tools/call`. The answer is read as
text, the `data:` line is parsed as JSON, then `result.content[0].text` is
parsed as JSON again, then checked with zod (unknown fields ignored, a bad
entry dropped, never the whole answer thrown away for one bad row). "No
card found with card_id" is a normal "nothing" answer. `find_variants`,
`identify_card`, `browse` and `card_of_the_day` are not used in this
milestone.

**Noise.** An entry is clean only when its id is all digits. Ids starting
`ebay_` or `ing_`, and any other shape, are noise. Rule: when a query has
at least one clean entry, noise is dropped. When it has none, at most 3
noise entries are kept, marked `verified: false`, shown as "Unverified
listing", never applied by the app itself, never used for close-spelling
matching, and their team and rookie words are ignored.

**Cleaning** (`clean.ts`, pure functions, table driven tests):
- Name: trailing tags removed into `tags` (IR, RC, TC, AS, DP, UER, ERR,
  COR, HOF, "NO NAME ON FRONT", BLACKBOX and the like, from one list);
  capitals turned into name case with Mc, Mac, O', De, Van, St. handled;
  "Jr" and "Sr" get their period; "DAN MARINO IR" becomes "Dan Marino".
- Number: "#", "No." and spaces removed, capitals, leading zeros removed,
  letters kept ("11T", "27T", "BC12"). Anything that is not 1 to 4 digits
  with up to 3 letters before or 2 after (for example "or", "6m7", "0p6")
  becomes empty.
- Year: the first four digits ("1986-87" gives 1986). Sport: lowercase and
  matched to `SPORTS`. Product: a known brand at the start becomes `brand`,
  the rest `variation` ("Topps Tiffany"). Set "Base Set" becomes empty.
- Set id: taken from the card's `url` (the digits at the end of the set
  part, "base-set-9179") only when the host is mycardfolio.com, else from
  the `set` block of `get_card`.
- The catalog gives no team and no rookie flag. The client never invents
  them. Rookie marks keep coming from `key-cards.ts`.

**Checklist probe.** `get_set_checklist` was not called in the trial. Task
10.5 starts with at most 40 real calls by hand (one per 2.1 seconds, same
User-Agent as the trial) to learn: how a set with more than 500 cards is
paged (1990 Topps has 792), the answer size and time, and whether a search
for "1990 Topps" with limit 50 gives the base set id through the urls. The
answers are recorded as `checklist_9179_*.json` and
`search_1990_topps_sets.json`, and the findings go into
`docs/CATALOG-TRIAL.md`. If a set cannot be paged past 500, the client
returns the first 500 and says so (`complete: false`); matching then adds
one search by year, brand and number.

### Design: matching done by Card Vault (settled)

The site forgives no spelling mistake, so the app matches names itself.
`src/lib/catalog/match.ts`, pure and testable, plus `lookup.ts` which
spends calls.

**Input:** what the reader found: year (or none), up to 2 possible brands,
sport, up to 5 name spellings, card number (or none).

**Budget:** at most 8 outside calls per card and 40 per scan (a photo with
many cards); cards beyond the budget keep their plain reading and get the
"Look up again" button in Review. Stored answers do not count. Because of
the 30 day checklist store, the second card of the same set costs no call.

**Steps, stop at the first that gives a sure card:**
1. *Exact search* (needs year and brand): "year brand full name", then
   "year brand surname", then "year brand number" when a number was read.
   Clean entries only. Up to 3 calls.
2. *Checklist and close spelling* (needs year and brand): find the base
   set id (from step 1's urls, else one search "year brand" with limit 50),
   fetch the checklist of at most 2 sets per card (two possible brands, or
   one brand in the year and the year before when the year came only from
   the last stat row), then match locally.
3. *Year or brand unknown:* no checklist is fetched. One search with what
   is known ("year full name" or "brand full name" or the full name with
   the sport). The clean results become candidates for Review and are never
   applied by the app, except when exactly one clean entry agrees with a
   read card number and the name. When the name itself was misread too,
   nothing is found: the plain reading stands, Review asks, and once the
   owner has typed a year or brand, "Look up again" runs step 1 and 2.

**Close-spelling rule (step 2, local):** names are normalized (lowercase,
no accents, no punctuation, "jr" and "sr" set apart). Each read spelling is
compared with each checklist name by edit distance where a swap of two
neighbours counts 1 and the usual reading mix-ups count one half (l, I and
1; O and 0; S and 5; B and 8; rn and m; a cut off last word). Allowed:
surname up to 3 letters must be exact; 4 to 7 letters distance at most 1;
8 or more at most 2. A first name or initial that was read must not
contradict ("K" or "Ken" fits Ken, not Kevin). Score order: number and
name agree; name exact; name close.
- *Sure* (applied by the app): name close or exact AND the read number
  equals the checklist number; or name exact, number not read, and no
  other card in the fetched sets is within the allowed distance. A close
  name without the number is sure only when it wins by a clear margin: no
  other name in the sets within one more edit.
- *Not sure:* up to 5 candidates go to Review in score order.
- A read number that disagrees with the best name match is never
  overwritten: both cards become candidates.
- Tiffany and other special products are candidates only, never applied
  (the version question is Milestone 11).

**Confidence.** Number and name agree: at or above `REVIEW_THRESHOLD`
(filed as sure, as key list hits are today). Applied without a read number:
`CHECK_CONFIDENCE` (0.7), so it waits in Review with the card already
filled in. Candidates only: the reading's own confidence.

**Slow server.** A checklist is turned once into slim rows (id, number,
normalized name) and the last 4 sets are kept in memory (well under 1 MB).
A comparison stops early when the lengths differ by more than the allowed
distance. 800 names times 5 spellings must take under 50 ms on this server
(measured in the task). All calls for scans run in the `background` line,
one at a time, after the reading; the owner never waits (Part A).

**Sports honesty.** Clean entries exist for baseball (15 of 16 in the
trial) and football (4 of 5), and for none of the 10 basketball and hockey
cards. For those two sports most scans will get no sure card. Then the
plain free reading stands exactly as today, unverified listings may appear
as candidates marked "Unverified listing", and Review asks the owner. The
Search screen says so in one line when the sport filter is basketball or
hockey. Nothing in this milestone makes those sports worse than today.

### Design: screens (settled)

**Search cards** (`/search`, linked from More, from Inventory's empty state
and from the Scan page as "Or search by words"). One text box (2 to 80
characters), optional sport and year, a Search button (no call per typed
letter). Results: clean cards first as rows (year, brand, number, player,
set when not base), then "Unverified listings" folded shut. Each row:
"Add to my collection" and "From MyCardfolio" (link to the card page, new
tab). Adding creates the catalog card, a `card` item with status
`confirmed`, quantity 1, every field marked `catalog`, and opens the item
page; the existing duplicate notice shows when there is a similar item.
Catalog off, paused or busy: a plain line and a link to Add by hand.

**Add by hand** (`/items/new`, linked from More, Scan and Search). The
existing `ItemForm` with the kind choice on top. Only one of player, set
name or description is needed; everything else may stay empty. Saved as
`confirmed`, all filled fields marked `owner`, no outside call.

**Link later.** An item page of a card without a catalog link shows "Find
this card in the catalog": it opens Search filled with the item's year,
brand and player; rows then show "This is my card" instead of "Add". The
pick follows the filling rule, so the owner's words stay. A linked item
shows a "Catalog card" block: the card line, "From MyCardfolio", "Unlink".
Under it, folded shut, "What the scanner first read" from `firstSuggestion`.

**Review.** Under an item with candidates: up to 3 rows (2 more behind
"More"), each with the card line, "Unverified listing" where it applies,
and "This one". One tap applies the filling rule, links the catalog card,
confirms the item and takes it out of Review. "None of these" clears the
candidates. "Look up again" (also shown when there are no candidates and
the item has a player or a number) runs the look up in the `now` line with
the item's fields of the moment, at most once per 10 seconds per item. The
name suggestions from task 9.14 are not built; the candidates replace them.

All new actions: `requireOwner`, zod on every input (ids as integers, the
candidate chosen by its position in the stored list, never by fields sent
from the browser), audit events `catalog_card_added`, `catalog_card_linked`,
`catalog_card_unlinked`.

### Design: Part C finished through the catalog (settled)

Branch `work/m9c` (commits f331a2b, c35ebc3, ecef104) is merged into
`work/m10` in task 10.10. Kept as they are: the extra reading passes, the
sentence rule, name particles, header years, the Griffey fixture.

**Team and brand.**
- Brand: from the catalog card when one is applied; the read brand only
  chooses which sets to fetch.
- Team: the catalog has no team. So the team read from text becomes a
  *hint*, and a hint is written into the team field only when it is
  confirmed: a catalog card was applied (so player and sport are known),
  the hint's sport equals the card's sport, and the team is in that
  player's team list from the existing Wikidata facts (`PlayerFacts.teams`,
  stored 90 days). A confirmed team is marked `wikidata` in `fieldSources`.
- Not confirmed (no catalog card, no facts, or not in the list): the team
  field stays empty and the hint is shown in Review and on the item page
  as a "Did you mean: Mariners" chip, one tap to fill.
- Without any catalog card, the team rules that are live today (before
  `work/m9c`) keep working so nothing gets worse; the new close-spelling,
  lowercase and split-row team rules of `work/m9c` only ever make hints.

**Test list from the second review** (each one a named test in
`parse.test.ts` or `recognizer.test.ts`; all must pass):

| Id | Case | Must give |
|---|---|---|
| H1 | lowercase bio word "twins" on the back, misread team on the front | no team "Twins" in the item; at most a hint |
| M1 | split stat rows with four digit years | the year is kept |
| M2 | club-only two digit rows next to a header like "88 ROOKIE" | the header is not a stat row and gives no year |
| M3 | small l read where capital I stands in a capitals word | matched as I |
| M4 | plain words STARS, BEARS, MAGIC, HEAT, BILLS, KINGS, JETS, TIGERS in text | no team written without confirmation |
| L1 | FALCONE, ANGELL, PILATES and similar | no team, no hint |
| L2 | close team spelling with a position of another sport | no team, no hint |

**Griffey target in full.** End to end through `FreeRecognizer` with the
real text reader on the two photo fixtures, the catalog faked with the
recorded answers (search, card 551033, checklist 9179), the player lookup
faked with a recorded facts row that lists the Seattle Mariners, no
network:

| Field | Must be |
|---|---|
| player | `Ken Griffey Jr.` |
| sport | `baseball` |
| year | `1990` |
| brand | `Topps` |
| card number | `336` (from the catalog; the photo cuts it off) |
| team | contains `Mariners` |
| title | contains `Griffey`, does not contain `Graduated` |
| confidence | at least 0.5 |
| catalog | linked candidate is source id `551033`, not the Tiffany card, not Ken Griffey Sr. |

A second run with the catalog switched off must still give a Griffey
spelling as player, year 1990, no wrong number and no wrong team.

### Tasks

Order: 10.2 first. Then 10.3. Then 10.4 and 10.5 side by side. Then 10.6.
Then 10.7, 10.8 and 10.9 (10.7 and 10.8 side by side). Then 10.10, 10.11.

**10.1 Catalog trial** (Sonnet). Done 2026-11-16, see
`docs/CATALOG-TRIAL.md`. Verdict: go, with conditions that are built into
the designs above.

**10.2 Data model and the one migration** (Fable, review)
- Files: `src/db/schema.ts`, `drizzle/0008_*`, `src/lib/catalog/normalize.ts`
  (+ test), `src/lib/catalog/key.ts` (+ test), `src/lib/catalog/apply.ts`
  (+ test), `src/lib/items/from-recognition.ts`, `src/lib/items/update.ts`,
  `src/lib/items/bulk.ts`, `src/lib/free/key-cards.ts` (re-export only),
  `src/lib/export/` (new columns left out of the CSV).
- Depends on: 10.1.
- Done when: all tables and columns of the designs exist (`catalog_cards`,
  `catalog_sources`, four item columns, `outside_usage`, `outside_state`,
  `outside_cache`, `connection_keys`); `canonicalKey` and
  `applyCatalogCard` work as designed; a scan writes `firstSuggestion`
  once and marks its fields `reading`; owner edits (single and bulk) mark
  fields `owner`; new audit event names are in `AUDIT_EVENTS` with plain
  labels.
- Check: migration applies to a copy of a database made by `0007` with
  items in it, and the old item rows read back unchanged; a test that the
  build before this task still starts on the migrated copy (old code, new
  layout); key tests (same card from two spellings gives one key; "11T"
  and "11" differ; Tiffany differs from base); filling rule tests for
  each of the 4 rules including "old item with null sources is never
  overwritten"; `firstSuggestion` unchanged after edit, bulk edit and pick.

**10.2 review decisions (settled 2026-11-16, main session)**
- Unlinking a catalog card turns that card's `catalog` field marks into
  `reading` marks (values kept), so a later link to another card lists or
  replaces them under the normal rules. Done in 10.9.
- Card numbers keep their printed order in the canonical key ("11T" and
  "T11" differ). Done in 10.9 with a test; no stored keys exist yet.
- Vault (10.4): a fresh `randomBytes(12)` iv on every save; keys shorter
  than 16 characters are refused; `last4` never goes into audit detail or
  logs.

**10.3 Shared gate for outside calls** (Opus, review)
- Files: `src/lib/outside/gate.ts`, `sources.ts`, `usage.ts`, `cache.ts`
  (+ tests), `src/lib/free/wikidata.ts` (its fetch goes through the gate,
  its store stays), `docs/SPEC.md`, `docs/HANDOVER.md`.
- Depends on: 10.2.
- Done when: pacing, caps, the two lines, retry, pause, counters, stored
  answers with their ages and the size cap work as designed with an
  injected clock and an injected `fetch`; a switched off source makes no
  call; the storage policy stands in SPEC.md and HANDOVER.md.
- Check: tests with a fake clock for: 2 s spacing, one call at a time
  under 5 parallel requests, hour cap, day cap across a restart, `now`
  before `background`, `now` gives up after 8 s, retry on 500 and timeout
  (2 then stop), 429 with and without `Retry-After`, three failures pause,
  pause survives a restart, stored answer used and not counted, expired
  answer fetched again, 2 MB limit, redirect refused, size cap prunes the
  oldest; the "no other fetch in src" test; all Wikidata tests still green.

**10.3 review decisions (settled 2026-11-16, main session; fixed in 10.6a)**
- Stored-answer key = sha256 of method, host, path, sorted query and the
  JSON body exactly as sent; only named free-text fields (search words) are
  lowercased and trimmed before hashing.
- The `now` line has one overall deadline of 12 s for the whole call
  (queue, tries and waits); after that the owner sees the plain "busy"
  message. `background` keeps the retries.
- The gate map lives on globalThis next to the database.
- Prune runs when the stored total passes the cap (checked on write) and
  at most hourly otherwise; deletes run in one transaction.
- Retries only for requests marked safe to repeat (all MCP reads are).
- "No other fetch" test also flags node:http, node:https, undici imports,
  `fetchImpl(` and `.fetch(` outside the allowed list.
- Failure streak: three failed requests in a row (each try counts), any
  answer from the server (including 4xx) resets it.

**10.4 Connections screen, keys, Test button, usage view** (Opus, review)
- Files: `src/lib/outside/keys.ts` (+ test), `src/lib/outside/actions.ts`,
  `src/app/(app)/more/connections/page.tsx`, `src/components/connections/*`,
  `src/app/(app)/more/page.tsx`, `src/lib/env.ts`, `.env.example`,
  `src/lib/audit/labels.ts`, `src/lib/log.ts` (only if a redaction rule is
  missing).
- Depends on: 10.3. Can run beside 10.5 (Test for MyCardfolio is wired
  when 10.5 lands; until then it uses the source's raw test call).
- Done when: the screen shows MyCardfolio and Wikidata with state, switch,
  Test, Clear stored answers and the usage view; the key flow works for
  the `demo` source outside production as designed; `SETTINGS_KEY` is read
  with the fallback.
- Check: key tests (save then open gives the key back inside the server
  only; a second save of the same key gives a different ciphertext; a
  changed bit, a changed source id or a changed setting fails closed with
  "enter again"; fallback to `SESSION_SECRET`; shape rule; 200 character
  limit); a test that renders the page and every action answer and finds
  the key nowhere; a test that captures the logger and the audit table
  through save, test, failed test and remove and finds neither the key nor
  its last 4; actions refuse without a session; Test limited to one per
  10 seconds; screenshots at 360px (two sources, a paused source, the demo
  key card before and after saving).

**10.5 MyCardfolio client** (Sonnet, review)
- Files: `src/lib/catalog/types.ts`, `mycardfolio.ts`, `clean.ts`
  (+ tests), `tests/fixtures/catalog/*` (new recordings),
  `docs/CATALOG-TRIAL.md` (probe findings), `scripts/catalog-probe.mjs`
  (hand run only, never in tests or the build).
- Depends on: 10.3.
- Done when: the checklist probe is done and written down; `search`,
  `card` and `checklist` work through the gate and return cleaned
  `CatalogCard` rows; noise and cleaning rules as designed.
- Check: tests on the recorded answers: Griffey search gives clean
  `551033` first and no noise; the Jordan search gives at most 3 rows, all
  `verified: false`; card detail gives set id `9179`; a checklist recording
  parses and contains #336; cleaning table ("DAN MARINO IR", "FRANK THOMAS
  NO NAME ON FRONT", "Emmitt Smith RC", "Ken Griffey Jr", "11T", "0336",
  "or", "6m7", "1986-87", "Topps Tiffany", "O-PEE-CHEE"); broken answers
  (no `data:` line, bad inner JSON, one bad row among good ones, an error
  result) give `failed` or drop the row and never throw; a url from another
  host gives no set id.

**10.6 Matching: exact steps, checklist, close spelling** (Opus, review)
- Files: `src/lib/catalog/match.ts`, `lookup.ts` (+ tests),
  `tests/fixtures/catalog/trial-cards.json` (the 31 trial cards with their
  damaged spellings).
- Depends on: 10.5.
- Done when: `lookupCard(read, line)` returns `{ sure: CatalogCard | null,
  candidates: CatalogCard[], callsUsed }` following the steps, budgets and
  rules as designed.
- Check: with a fake catalog built from the recordings: "Eriffey", "Ken
  Griffey, J" and "KEN GRIFFEY JR" against checklist 9179 give `551033`;
  Ken Griffey Sr. of the same set is not chosen for "Ken Griffey, J"; a
  three letter surname needs an exact match; "Kevin" does not fit "Ken";
  a read number that disagrees gives two candidates and no sure card;
  Tiffany is never sure; unknown year or unknown brand fetches no
  checklist; never more than 8 calls per card and 40 per scan (counted on
  the fake); a second card of the same set uses 0 calls; `off`, `paused`
  and `cap` answers give "no card" without an error; the timing test
  (800 names, 5 spellings, under 50 ms) run on the server and noted in
  STATUS.md; noise rows are never matched by close spelling.

**10.6 decisions (settled 2026-11-16, main session; done in 10.6b)**
- Finding a base set id on a cold start: search "year brand 1" with limit 5,
  and if no clean Base Set card comes back, "year brand 2"; take the set id
  from a clean, verified Base Set result's url. At most 2 calls, inside the
  card's budget. Learned set ids are kept for the scan and come back from
  stored search answers later.
- Prune goes down to 90% of the cap, and the stored total is kept as a
  running number in the gate (checked every write, recomputed hourly).
- A search answer counts as "nothing found" only when count is 0 and
  results is empty; rows that are all unusable give failed (not stored).
- The Accept header is part of the stored-answer key.
- Fetch scanner: `//host` is not the app's own address; also flag node:net,
  node:tls, WebSocket and EventSource; one negative test for hyphen numbers.

**10.6 review decisions (settled 2026-11-16, main session; done in 10.6c by Fable)**
- "No other card fits" counts only over a COMPLETE set. When a checklist is
  cut short (1990 Topps: 500 of 792), a name found in it is confirmed by one
  exact search "year brand <full corrected name>" (limit 10): sure only when
  that search returns exactly one clean card of that player in that set that
  is not a subset, variation or insert, and its number does not disagree.
  Otherwise candidates only.
- The set key includes the sport; memory rows and learned set ids are
  filtered by sport; nothing carries across sports. Memory is per scan plus
  stored answers, never a global map that outlives a scan.
- Subset cards (All-Star, Record Breaker, Salute, Team Leaders, Checklist,
  Highlights, Turn Back the Clock, Future Stars, Draft Pick, Prospects) are
  candidates only unless the read number agrees.
- A prefix counts as a fit only for initials or a read under 3 letters;
  otherwise exact or close spelling ("Ken" never fits "Kent").
- Budget counts every network try: the gate reports tries for each call and
  lookup adds them; catalog calls from a scan use at most one retry.
- A variation (Tiffany or any other) is never sure, even when read; it is
  offered as a candidate (design rule kept).
- A "busy" answer stops catalog calls for the rest of that scan.
- When a whole checklist in memory gave no sure card, do not spend more
  searches on that card except the single confirm search above.
- Griffey target (10.10): with the number cut off, "Ken Griffey, J" reaches
  #336 through the checklist plus the confirm search; if the confirm search
  shows more than one clean base card, it stays a top candidate in Review.

**10.6 second review decision (settled 2026-11-16, main session; done in 10.6d)**
The matching failed review twice (cut-short checklists hide second players
of the same name, e.g. Jeff Robinson #42 and #723, Ken Griffey Sr. #581).
New, simpler rule that replaces "sure by name":
- A catalog card is applied as sure ONLY when (a) the read card number and
  the name agree with one clean, non-subset, non-variation card of the set,
  or (b) the set is complete (checklist complete:true) and exactly one
  player in it fits the read name, with first name, surname and suffix
  compared on parsed names.
- Everything else, including a unique name in a cut-short checklist and any
  confirm search result, is only a ranked candidate shown in Review with
  one tap to pick. No item is ever filled from a candidate without the tap.
- The confirm search is removed. The number search for cards past #500
  stays.
- Names drop bracketed qualifiers ("(P)", "(Texas)") before parsing, and
  players are told apart by parsed first name, surname and suffix.
- Slim rows are kept in the scan's checklist memory (parsed once).
- Griffey target (10.10): "Ken Griffey, J" with no number gives #336 as the
  top candidate in Review (one tap), not sure; year 1990, sport baseball,
  team Mariners still come from the reading.

**10.7 Search cards screen and "Add to my collection"** (Sonnet)
- Files: `src/app/(app)/search/page.tsx`, `src/components/catalog/*`,
  `src/lib/catalog/actions.ts` (+ test), `src/app/(app)/more/page.tsx`,
  `src/app/(app)/scan/page.tsx`, `src/app/(app)/items/page.tsx`.
- Depends on: 10.2, 10.5.
- Done when: the screen works as designed; adding stores the catalog card
  and its source row once (a second add of the same card makes a second
  item, not a second catalog card); off, paused and busy states show plain
  lines.
- Check: action tests (no session refused; bad input refused; add twice
  gives one `catalog_cards` row and two items; the chosen row is taken
  from the server's own answer, not from fields the browser sent);
  screenshots at 360px: results with clean rows, only unverified listings,
  nothing found, catalog paused.

**10.8 Add by hand and link later** (Sonnet)
- Files: `src/app/(app)/items/new/page.tsx`, `src/lib/items/create.ts`
  (+ test), `src/lib/items/actions.ts`, `src/components/items/ItemForm.tsx`,
  `src/app/(app)/items/[id]/page.tsx`, `src/components/catalog/CatalogBlock.tsx`.
- Depends on: 10.2; the link part on 10.7.
- Done when: a record with only a player (or only a description) can be
  saved; the item page shows the catalog block, "Find this card in the
  catalog", "Unlink" and the folded "What the scanner first read".
- Check: create tests (nearly empty record accepted, fully empty refused,
  fields marked `owner`); link test: an item with the owner's player and
  team keeps both after linking to a card with other values, empty year
  and number are filled; unlink changes no field; screenshots at 360px of
  the form, a linked item, an unlinked item.

**10.9 Catalog in the scan and one tap pick in Review** (Opus, review)
- Files: `src/lib/free/recognizer.ts` (new optional `catalog` in
  `FreeDeps`), `src/lib/recognition/types.ts` (optional catalog part of an
  item, default empty), `src/lib/scans/process.ts`,
  `src/lib/items/from-recognition.ts`, `src/lib/items/review-actions.ts`,
  `src/lib/items/duplicates.ts` (candidates in the review rows),
  `src/components/items/CatalogCandidates.tsx`, `src/app/(app)/review/page.tsx`,
  tests beside each.
- Depends on: 10.2, 10.6.
- Done when: after the reading, a card scan runs `lookupCard` in the
  `background` line; a sure card is applied (fields marked `catalog`, the
  link set, confidence as designed); candidates are stored on the item;
  Review shows them with "This one", "Use the catalog's values", "None of
  these" and "Look up again" as designed; sealed and bulk scans make no
  catalog call; sample mode and the Anthropic mode are unchanged.
- Check: recognizer tests with a fake catalog (sure card applied; only
  candidates; catalog off gives exactly today's result, compared field by
  field with a run without the dep; a failing catalog never fails the
  scan); pick tests: fills empty fields only, an `owner` field survives,
  a `reading` difference is listed and changes only through the second
  button, `firstSuggestion` identical before and after, item leaves
  Review, audit row written; a pick of position 7 of a 3 row list is
  refused; "Look up again" limited to one per 10 seconds; a basketball
  scan with only unverified listings applies nothing; screenshots at 360px
  of Review with candidates, with a difference list, and with none.

**10.10 Merge `work/m9c`, finish Part C through the catalog** (Opus, review)
- Files: merge of `work/m9c` (`src/lib/free/ocr.ts`, `parse.ts`, their
  tests, `griffey.test.ts`, `tests/fixtures/cards/*`, `tests/helpers/*`),
  then `src/lib/free/parse.ts` (team hints, M1 to M3), `recognizer.ts`
  (team confirmation), `src/components/items/SmartChips.tsx` or the Review
  row (the "Did you mean" team chip), `tests/fixtures/catalog/*`,
  `tests/fixtures/README.md`, `docs/STATUS.md`.
- Depends on: 10.9.
- Done when: the branch is merged with history kept; `parseCardText`
  returns `teamHint` apart from `team`; team and brand follow the design;
  every row of the test list (H1, M1 to M4, L1, L2) is a passing named
  test; the Griffey target table is met in full, and the second run with
  the catalog off holds.
- Check: `griffey.test.ts` end to end (real text reader, recorded catalog
  and facts, no network) green three times in a row on the server; the
  seven review cases green; `accuracy.test.ts` of today still green (no
  card that had a right team before loses it); reading time and container
  memory after one scan noted in STATUS.md (memory under 1 GB); the
  reviewer is given the two earlier review reports and asked to try 10 new
  plain word cases of their own against the team rule.

**10.11 Review and go live** (Opus review, main agent deploys)
- Files: fixes only, `docs/STATUS.md`, `docs/SPEC.md`, `docs/HANDOVER.md`.
- Depends on: 10.2 to 10.10.
- Done when: a fresh security review (keys, the gate, every new action and
  page, the migration, what is stored from the site) has no open finding;
  backup checked before the deploy; `SETTINGS_KEY` set in Coolify;
  Milestone 10 is live; the owner is told in plain words to try: Search
  ("1990 Topps Griffey"), Add by hand, a scan of the Griffey card and
  three others, and the Connections screen.
- Check: `npm run check`, `npm run build`, live `/api/health`, the
  migration applied on a copy of the live database first, the Test button
  on the live Connections screen answers "Works" (this is the only real
  catalog call made by the builder on the live site), usage view shows
  that call, no key or secret in the diff.

| # | Task | Model | Depends on |
|---|---|---|---|
| 10.1 | Catalog trial (done) | Sonnet | |
| 10.2 | Data model and the one migration | Fable + review | 10.1 |
| 10.3 | Shared gate for outside calls | Opus + review | 10.2 |
| 10.4 | Connections screen, keys, Test, usage view | Opus + review | 10.3 |
| 10.5 | MyCardfolio client and checklist probe | Sonnet + review | 10.3 |
| 10.6 | Matching: exact steps, checklist, close spelling | Opus + review | 10.5 |
| 10.7 | Search cards screen, add to collection | Sonnet | 10.2, 10.5 |
| 10.8 | Add by hand, link later | Sonnet | 10.2, 10.7 |
| 10.9 | Catalog in the scan, one tap pick in Review | Opus + review | 10.2, 10.6 |
| 10.10 | Merge `work/m9c`, finish Part C, Griffey in full | Opus + review | 10.9 |
| 10.11 | Review and go live | Opus + main | all |

### Risks

- **One hobby site.** MyCardfolio can change, slow down or go away. The
  one interface, the switch on the Connections screen and the rule "the
  plain reading always stands by itself" limit the damage.
- **Terms say nothing about storing.** The bounded store is a careful
  reading of "free for personal use", not a permission. If the site
  objects, the ages in one file go to zero and the app still works, with
  more calls. No message has been sent to the site yet (see the question).
- **Unknown rate limit.** The caps are our own guess, set below what the
  trial ran. A 429 pauses the source by itself.
- **Checklist tool never called yet.** Paging, size and speed are learned
  in the 10.5 probe. If checklists are not usable, step 2 of the matching
  falls back to searches by year, brand and number, and misread names
  without a number go to Review.
- **Basketball and hockey.** Mostly no clean entries. The owner will see
  "Unverified listing" or nothing for those. Said on the Search screen and
  in the go live message.
- **Wrong card applied.** Close spelling can pick the wrong player. The
  number rule, the clear margin rule, the cap at 0.7 without a number and
  `firstSuggestion` limit this; "Unlink" undoes the link.
- **Team needs two sources.** A team is only written when Wikidata knows
  the player. For lesser known players the team stays a chip to tap.
- **Slower scans.** Up to 8 paced calls can add about 20 seconds to a
  card's reading in the worst case; usually 1 to 3 calls. It runs in the
  background (Part A).
- **Migration on the live database.** Adds only, tried on a copy first,
  backup checked before the deploy, old code runs on the new layout.
- **Key store without a real user yet.** Proven only by tests and the demo
  source until Milestone 14. The independent review of 10.4 is the guard.

### Questions for the owner

None blocks the build. One for later:

1. **Before the set progress feature (Milestone 15), the site should be
   asked whether keeping whole set lists is fine. It can only be reached
   on X (Twitter). Will you send that short message, or shall the feature
   wait in its careful form?** Recommended: decide when Milestone 15
   starts. Until then the app keeps set lists for 30 days at most and only
   for sets you scanned or searched.

Run cap for this milestone: 14 task runs (10 tasks plus up to 4 review
repeats) or 3M delegated tokens, inside the roadmap cap of 75 tasks or 12M.
