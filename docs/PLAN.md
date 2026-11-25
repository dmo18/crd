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

**10.6 third review decision (settled 2026-11-16, main session; done in 10.6e)**
Tightens 10.6d. "Sure" additionally needs ALL of:
- sport, year and brand were read (none null);
- the base set id is known and the card's source set id equals it;
- on the number path, the surname matches exactly after OCR folding (no
  close spelling), and a read first name or initial agrees; if another
  player in the pool has that surname, the first name or initial must be
  read.
- Search answers from step 3 (no set known) are candidates only.
- parseName joins leading particles (de, la, del, los, las, da, di, le, van,
  von, st, st., mc, o) into the surname on both sides; a particle is never a
  first name or a first-name prefix.
Tests: the review's cases (Nolan Ryan #1 with no year; Bo Jackson #300 with
no sport; De La Cruz, St. Claire, La Russa, O Neill in a complete set;
Griffey #581, Williamson #41, Costello #427 with a misread number; a second
clean set of the same year and brand) are all not sure.

**10.6 fourth review decision (settled 2026-11-16, main session; done in 10.6f; FINAL)**
"Sure" (filled without a tap) exists in exactly one case, all required:
- a card number was read and matches the card exactly (after the existing
  number cleaning);
- a first name AND surname were read and both match the card's parsed names
  exactly after OCR folding (initial only is not enough); the card row has
  a first name;
- sport, year and brand were read; the year did not come from stat rows;
  exactly one brand and one year are tried;
- the base set id was confirmed by fetching that set's checklist (set name
  Base Set) in this scan or from stored answers, not only learned from a
  search; and the card's source set id equals it;
- no other player in the pool (checklist rows plus answers seen in this
  card's lookup) has the same surname or a surname whose last word equals
  it (Von Hayes and Charlie Hayes), unless the read first name tells them
  apart exactly;
- the card is not a subset, variation, insert or multi-player card.
Removed: sure by name in a complete set. A two-word name starting with a
particle keeps the particle as the first name ("Von Hayes": first Von,
surname Hayes); particles join the surname only with three or more words
or before a capitalized surname after a real first name. A second clean
set id for the same key in any later answer marks the conflict for the
rest of the scan. If any later review still finds a wrong-sure path, the
fallback is: no catalog card is ever filled without the owner's tap.

**10.6 fifth review outcome (2026-11-16, main session): automatic filling OFF**
The final review still found a wrong-sure path (a read product line such as
"Topps Chrome" or "Topps Gold" is reduced to the brand "Topps", so the base
card #336 is filled for a parallel). As settled in the fourth decision, the
fallback applies: `AUTO_FILL_SURE = false` in src/lib/free/recognizer.ts.
A sure answer only moves that card to the top of the suggestions; nothing
is filled without the owner's tap. To switch it on again later: fix the
read-variation case (any read brand with a product variation, or more
than one raw brand before dedupe, means no sure; the Jeff Robinson #42
cut-checklist case too) and pass a new independent review.

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
- From the 10.7 review (deferred here): "This is my card" on a scanned item must show the differences returned by `linkCatalogCard` with a "Use the catalog's values" button.

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

## Milestone 11: the exact version (approved 2026-11-16 as part of the roadmap)

What the owner can try when it is live: a "Which version is it?" list on
every card with the reason for each choice; a serial number as two boxes
("45 of 100") that the scanner only suggests; a rookie mark that says where
it comes from; add a back photo later, turn, trim and zoom a photo; a clear
duplicate question with three answers; and on the Connections screen, why
a look up had to wait.

Source of the facts below: `docs/ROADMAP.md` (Milestone 11, section 1 rows
F04, F22, F23, F24, F41, F49), `docs/CATALOG-TRIAL.md`, and the five
matching reviews of Milestone 10.

**The rule of this milestone: the app suggests, the owner chooses.** Five
reviews in Milestone 10 showed that rules which decide for the owner keep
finding a wrong sure case. So here:
- No new automatic filling. `AUTO_FILL_SURE` stays `false`. Nothing in this
  milestone links a catalog card, sets a version, writes a serial number or
  changes a rookie mark without a tap of the owner.
- Every suggestion shows its evidence in a few plain words and its source
  ("From MyCardfolio", "Known versions list", "Read on the card", "Key card
  list").
- A choice is always taken by its position in a list the server stored,
  never from fields the browser sends.
- "Not sure yet" is always a valid answer and never blocks saving.

Rules for every task: CLAUDE.md, the security rules above, the Milestone 10
rules (gate for every outside call, storage policy, recorded answers only
in tests, 360px, 44px tap targets, no em or en dashes), `npm run check` and
`npm run build` pass, no new dependency. A builder who meets a choice not
settled here stops and reports back. "Review" means a fresh reviewer who
did not write the code.

Real catalog calls allowed in the whole milestone: at most 20, by hand, one
per 2.1 seconds, only in task 11.2 to make recordings, plus the one Test
tap at go live. All other work uses the recordings.

Not in this milestone (later, do not start): switching automatic filling
back on; the `find_variants` tool of the site (its answers were mostly
eBay listings in the trial); reference pictures side by side; rookie proof
from set checklists (Milestone 15); moving photos on a merge; a free hand
crop box; pinch zoom code of our own; a check for duplicates inside a CSV
import (there is no import yet); a new "Data sources" page (the Connections
screen gets the missing lines instead); totals that leave out cards with
an open version (Milestone 14, when real prices hang on the version).

One go live at the end (task 11.8), on the Milestone 10 way.

### Design: data model (settled)

**One migration, adds only.** `drizzle/0009_*`, written in task 11.1, holds
every new column of this milestone. No new table. Nothing renamed, dropped
or made required. No stored row is rewritten by the migration or at start
up: old values are read through small pure functions and are written in
the new form only when the owner next saves that item.

New nullable columns on `items`:

| Column | Meaning |
|---|---|
| `versionState` | `confirmed` or `not_sure`. Null means never asked (every item of today). |
| `versionSource` | `catalog`, `known_list`, `owner`: where the chosen version came from |
| `versionOptions` | JSON: at most 12 options from the last "Show versions", with the time. Cleared after a choice or after 30 days. |
| `serialCopy` | text, digits only, leading zeros kept ("045") |
| `serialEdition` | text, digits only, no leading zeros ("100") |
| `serialSuggested` | JSON: what the scanner read (`copy`, `edition`, the line of text it stood in, `weak` true or false). Cleared when the owner answers. |
| `rookieState` | `yes`, `no`, `unknown`, `disputed`. Null means not recorded (old items). |
| `rookieSource` | `owner`, `key_list`, `catalog`, `reading` |
| `rookieNote` | text, at most 200 characters: the evidence in plain words |
| `keptApartFrom` | JSON list of item ids (at most 50) the owner said are separate records |

New nullable column on `images`: `originalFile` (the photo as it was before
the owner's first turn or trim; server made name, same folder).

**Old columns stay and stay true.** `variation`, `isParallel`,
`serialNumber` and `isRookie` keep their meaning, so filters, bulk edit,
CSV export and old code keep working:
- `serialNumber` is the text shown and exported. It is rebuilt as
  "045/100" (or "/100" when only the edition is known) whenever the two
  parts are saved.
- `isRookie` is true exactly when `rookieState` is `yes`. One function,
  `withRookie()`, writes both.
- An old item with `serialNumber` "045/100" and empty parts is shown split
  by `splitSerial()` and counts as the owner's own entry. An old text that
  does not split ("1 of 1 promo") is shown as it is in one box, untouched.
- An old item with null `rookieState` shows "Rookie card: yes" or nothing,
  as today, with the line "Source not recorded".
- The single edit form and the bulk engine keep both forms in step: a bulk
  "set rookie" writes `rookieState` yes or no with source `owner`; a typed
  serial text that splits fills the parts.

**Canonical key.** Stays `v1`. The variation is already its last part, so
base and Tiffany have two keys. No key is rebuilt in this milestone.

### Design: which version is it (settled, F04)

**Where the choices come from** (`src/lib/catalog/versions.ts`, pure
`buildVersionOptions()` plus `loadVersionOptions()` which may spend calls):
1. *The catalog.* One search "year brand number surname" (the trial showed
   that such a search lists the base card and its Tiffany or other product
   lines as clean entries). Kept: clean entries only (all digit id), same
   year, same normalized player, same card number. Each product line or
   variation becomes one option with the link "From MyCardfolio". At most
   2 calls per tap (the second only when the item has no number: "year
   brand full name"), in the `now` line, and a stored answer costs nothing.
   Unverified listings are never options.
2. *The known versions list* (`src/lib/catalog/versions-known.ts`): a short
   table written by hand for the owner's years, about 15 rows, each with
   brand, years, name and one line on how to tell. Examples: Topps Tiffany
   1984 to 1991 ("glossy front, bright white back, sold only as a boxed
   set"); Fleer Glossy 1987 to 1989; Topps Desert Shield 1991 ("gold foil
   shield stamp on the front"); Topps Gold 1992 to 1994; Upper Deck
   Electric Diamond 1994; Score Gold Rush 1994; Collector's Choice Silver
   Signature 1994 and 1995; O-Pee-Chee for Topps baseball and hockey. Every
   row carries a source note in the file. A row is offered when brand and
   year fit; it is a choice, never a claim that the card is that version.
3. *Read on the card.* When the scanner read a version word ("TIFFANY",
   "GLOSSY", "GOLD") or the item's `variation` field holds a text of the
   reader, the matching option gets the evidence line "The scanner read
   the word GOLD on the card". It moves that option to second place, never
   to first, and chooses nothing.
4. Always present: **"The normal card (base)"** first, **"Another version"**
   (a text box, 2 to 120 characters) and **"Not sure yet"** last.

The same version from two sources is one option with both evidence lines.
Order: base, options with read evidence, catalog options, known list
options, another, not sure. At most 12.

**Choosing** (`chooseVersionAction`, owner session, zod, the option by its
position in the stored `versionOptions`):
- Base: `variation` emptied, `isParallel` false, state `confirmed`.
- A version: `variation` set to its name and marked `owner` in
  `fieldSources`, `isParallel` true, state `confirmed`, `versionSource`
  set. When the option is a catalog entry, the item is linked to that
  catalog card through the existing `linkCatalogCard` path with the filling
  rule of Milestone 10 (owner fields stay; differences are listed with
  "Use the catalog's values"). When the item was linked to the base card,
  that link is replaced by the chosen one.
- Another version: the typed text, source `owner`.
- Not sure yet: state `not_sure`, no field changed.
- Audit event `version_chosen` (item id, state, source; no free text).
The choice can be changed at any time; "Show versions" may be tapped once
per 10 seconds per item.

**A pick in Review.** A candidate row whose line shows a version ("Topps
Tiffany") sets state `confirmed`, source `catalog`, because the owner
tapped that very row. A pick of a base row leaves the state null. When the
stored candidates of an item hold more than one version of the same card,
the Review row and the item page show "There is more than one version of
this card" with the button "Choose the version".

**Value.** While the state is `not_sure`, the item page and the item rows
show "Choose the version to see a value" in place of the estimate. The
owner's own figure (`manualValueCents`) is always shown. Stored values are
not touched and totals are not changed in this milestone. Null state
(never asked) changes nothing, so no card of today loses its value.

**Screens.** Item page of a card: block "Which version is it?" with the
state in one line ("Version: Tiffany, you chose it, from MyCardfolio" or
"Version: not chosen"), the button "Show versions", then the options as
big radio rows with the evidence under each name and one "Save" button.
Catalog off, paused or busy: the known list and the three fixed options
still show, with one plain line. Inventory filter "Version not sure".

### Design: serial numbers (settled, F24)

`src/lib/items/serial.ts`, pure: `parseSerial(text)`, `splitSerial(text)`,
`formatSerial(copy, edition)`.
- Copy: 1 to 6 digits, leading zeros kept. Edition: 1 to 6 digits, from 1
  to 999999. Copy must not be above the edition and not 0. The copy may be
  empty when it cannot be read ("/100").
- **Never mixed with the card number.** The reader's `findSerial` result is
  dropped when it equals the read card number or its line starts with "No."
  or "#" followed by one number only, or when the text looks like a date
  ("5/12/68"), a "1 of 792" set count that equals a known set size on a
  line with "CARD" or "CHECKLIST", or stands in a stat row.
- **A read is only a suggestion.** New scans no longer write
  `serialNumber`. The read goes to `serialSuggested`. `weak` is true when a
  digit came from a look alike letter (O, l, S, B), when the copy is above
  the edition, or when the card's year is before 1990 (the line then says
  "Cards before 1990 were almost never numbered").
- **Asking.** Review row and item page: "The scanner read 045/100. Is this
  the serial number?" with "Yes", "Fix it" (the two boxes, filled) and "No
  serial number". A weak read shows the line of text it came from and has
  no "Yes" button, only "Fix it" and "No". Yes writes the parts, marks
  nothing else, clears the suggestion. Audit event `serial_confirmed`.
- **Form.** `ItemForm` shows "Serial number" as two small number boxes
  "Copy" and "of" (text inputs with the number keyboard, so zeros stay).
- Items of today are not touched (see data model).

### Design: rookie mark (settled, F41)

`src/lib/items/rookie.ts`, pure: `rookieEvidence(item, keyCard, catalogTags,
readWords)` gives a list of evidence lines and one suggested state.

| Evidence | Says |
|---|---|
| Key card list has the card with rookie true | yes, with the list's note |
| Key card list has the card with rookie false | no, with the note ("his 1985 Topps Olympic card came first") |
| The linked clean catalog entry carries the tag RC | yes, "From MyCardfolio" |
| The word ROOKIE or RC was read on the card | maybe, "Read on the card" |

- Sources agree on yes: suggestion `yes`. Key list says no: `no`. Key list
  and another source disagree: `disputed`, both lines shown. Only the read
  word: `unknown` with the line "The word ROOKIE is on the card. That alone
  does not make it the rookie card (it may be an All-Star Rookie cup or a
  Rated Rookie of a later year)". Nothing at all: nothing is shown.
- **What a scan writes** stays exactly as today and gets its source: a key
  list hit writes `rookieState` yes or no, source `key_list`, the note.
  Nothing else is written by a scan: the catalog tag and the read word
  only ever make a suggestion.
- **Asking.** Item page and Review row: "Rookie card?" with the evidence
  lines and four buttons "Yes", "No", "Not sure", "Disputed". The owner's
  answer is stored with source `owner` and is never changed again by the
  app, also not by a later look up or a link. Audit event `rookie_set`.
- The "Rookies" filter keeps using `isRookie`. `ItemForm` replaces the
  check box with the four way choice.

### Design: photos (settled, F23)

- **Add or replace later.** Item page, under the photos: "Add a back
  photo" (or "Add a front photo" when there is none) and "Replace" on each
  photo. Upload through the existing `saveUpload` (type and size limits,
  re-encode, server made names). Reuses `PhotoPicker` and the browser side
  shrink. At most one front and one back per item; the scan's crop counts
  as the front. A replaced photo's files are removed after the new row is
  stored. No reading is started by an added photo; a button "Read this
  photo again" is not built.
- **Turn.** "Turn left" and "Turn right" (90 degrees) on the photo view.
  Server side with sharp from the best file there is (the working copy
  when it still exists, else the archive file), written under a new server
  made name, thumbnail made again, row updated in one transaction, old
  files removed after it.
- **Trim.** Four sliders "Top", "Bottom", "Left", "Right" (0 to 40 percent
  each, whole numbers), with the cut shown live on the picture by CSS. No
  free hand box. The server checks the four numbers with zod, the rest
  must be at least 200 pixels on each side, then sharp cuts.
- **The original is kept.** Before the first turn or trim the photo's file
  is kept as `images.originalFile`. "Back to the original photo" restores
  it. Each photo holds at most one original. `removeItemRows`, the bin, the
  merge and the orphan cleanup (`src/lib/images/cleanup.ts`) must know the
  column: an original is deleted with its photo and is never seen as an
  orphan while its row lives.
- **Zoom.** A tap on a photo opens `/items/[id]/photo/[imageId]`: the
  picture alone on a dark page, buttons "Bigger" and "Smaller" (1, 2 and 4
  times, inside a box that scrolls both ways), the browser's own pinch zoom
  left on, and the Turn and Trim tools below. No zoom library.
- All photo actions: owner session, zod, ids as integers, the image must
  belong to the item, one edit at a time per image, audit events
  `photo_added`, `photo_edited`, `photo_restored`.
- Slow server: one sharp job at a time (the existing limiter); a turn of a
  1600 pixel photo must end in under 3 seconds, measured in the task.

### Design: duplicates (settled, F22)

`src/lib/items/duplicates.ts`. The key of a card becomes, in this order:
1. *What card:* the `catalogCardId` when both items have one (two items
   with different catalog cards are never duplicates); else the fields of
   today (year, brand, set, number, player), compared through the
   `normalize.ts` functions so "Ken Griffey Jr" and "Ken Griffey Jr." meet.
2. *Version:* the normalized `variation`.
3. *Grader and grade,* as today.
4. *Serial:* see below.

The result is no longer yes or no but one of three kinds:

| Kind | When | Notice |
|---|---|---|
| `same` | all four parts equal, version of both `confirmed` or both never asked, no serial copy on either | "You already have this card" |
| `maybe` | card equal, but one version is `not_sure` or one side has no version while the other has one; or one grade is empty | "This may be a card you already have. The version differs or is open." |
| `same_numbered` | card and version equal and both have the same copy and edition | "This looks like the very same numbered card (045/100) entered twice" |

Two items with different serial copies are never duplicates and never
merge: each is one numbered card. A pair in `keptApartFrom` is not asked
again.

**Three answers** on the notice (item page, Review row, and right after
"Add by hand" and "Add to my collection", which open the item page):
- **"Count it with the old one"** (merge): only for `same`, and for
  `same_numbered` with the wording "Remove this double entry" (the
  quantity is then not raised). `mergeInto` as today (quantities add, value
  kept, the newer record is removed), plus: the confirm line says in plain
  words that the photos of the newer record go away with it; the target
  keeps its own fields; refused for `maybe`.
- **"Keep both as they are"**: writes each id into the other's
  `keptApartFrom`; the notice goes away for that pair.
- **"Open the old one to fix it"**: a link to the old item's edit form.
The "Possible duplicates" filter lists `same`, `maybe` and `same_numbered`
without the kept apart pairs. Audit events: `items_merged` (exists today,
kept) and the new `duplicate_kept_apart`.

### Design: why a look up waited (settled, F49 rest)

No new page and no new table. The Connections card of each source gets a
folded part "Waits and skips today", built only from `outside_usage` and
`outside_state`: "3 look ups were skipped: the hourly limit was reached",
"The site asked us to slow down 1 time", "Paused until 14:20", "Look ups
waited 42 seconds in all (the app makes one call at a time, 2 seconds
apart)", and "Nothing had to wait today". The More page link text becomes
"Connections and data sources". This closes F49 for free sources.

### Tasks

Order: 11.1 first. Then 11.2, 11.5 and 11.7 side by side. Then 11.3, then
11.4, then 11.6 (these three all touch the item page and the Review row,
so they run one after another; each adds its own component and one line in
the page). Then 11.8.

**11.1 Data model and the one migration** (Opus, review)
- Files: `src/db/schema.ts`, `drizzle/0009_*`, `src/db/migration-0009.test.ts`,
  `src/lib/items/serial.ts`, `src/lib/items/rookie.ts` (state and
  `withRookie` only; the evidence part is 11.4) (+ tests),
  `src/lib/items/update.ts`, `bulk.ts`, `create.ts`, `from-recognition.ts`
  (key list hit writes state and source; nothing else changes yet),
  `src/lib/audit/labels.ts`, `src/lib/export/` (new columns left out).
- Depends on: Milestone 10 live.
- Done when: every column of the data model exists; `parseSerial`,
  `splitSerial`, `formatSerial` and `withRookie` work as designed; single
  edit and bulk edit keep the old and the new columns in step; new audit
  names have plain labels.
- Check: the migration applies to a copy of a database made by `0008` with
  items and photos in it and every old row reads back unchanged; the build
  from before this task still starts on the migrated copy; serial tests
  (zeros kept, "045/100", "/100", copy above edition refused, "1 of 1
  promo" left whole, 0 refused); rookie tests (state and `isRookie` never
  disagree after any write path: form, bulk, scan); a bulk edit of 500
  items stays inside the Milestone 9 time limit.

**11.2 Version choices and the choose action** (Opus, review)
- Files: `src/lib/catalog/versions.ts`, `versions-known.ts` (+ tests),
  `src/lib/catalog/item-actions.ts` or a new `version-actions.ts` (+ test),
  `src/lib/catalog/pick.ts` (a version row picked in Review sets the
  state), `tests/fixtures/catalog/*` (new recordings),
  `tests/fixtures/README.md`, `docs/CATALOG-TRIAL.md` (what the calls
  showed).
- Depends on: 11.1.
- Starts with at most 20 real calls by hand (2.1 seconds apart, the trial's
  User-Agent, no personal details) for recordings: the number and name
  searches for about 8 cards with known versions (1990 Topps Frank Thomas
  414, 1989 Fleer Bill Ripken 616, 1987 Fleer Barry Bonds 604, 1991 Topps
  Chipper Jones 333, 1992 Topps a star card, 1994 Upper Deck a star card,
  one football card, one basketball card that has only listings).
- Done when: `loadVersionOptions` and `chooseVersionAction` work as
  designed, for all four kinds of choice, through the gate only.
- Check: tests on the recordings (base and Tiffany become two options with
  links; listings never become options; another player with the same
  number is left out; same version from catalog and known list is one
  option with two lines; a read word moves an option to second place and
  chooses nothing; at most 12; catalog off still gives the known list and
  the fixed three); action tests (no session refused; position 9 of a 5
  row list refused; an `owner` field survives a version link; base link
  replaced by the chosen card; `firstSuggestion` identical before and
  after; "not sure" changes no field; once per 10 seconds; audit row); a
  test that no path in this task writes a version without the action; the
  reviewer is given the fifth review text of 10.6 and asked to look for
  any path that decides a version for the owner.

**11.3 "Which version is it?" on the item page and in Review** (Sonnet)
- Files: `src/components/catalog/VersionPicker.tsx`,
  `src/app/(app)/items/[id]/page.tsx`, `src/app/(app)/review/page.tsx`,
  `src/components/items/CatalogCandidates.tsx`, `ItemRow.tsx`,
  `InventoryFilters.tsx`, `src/lib/items/query.ts` (+ test),
  `src/components/manage/filter-url.ts`.
- Depends on: 11.2.
- Done when: the block, the Review line, the value line for `not_sure` and
  the filter work as designed.
- Check: query test for the filter; a render test that a `not_sure` item
  shows no estimate but shows the owner's own figure, and that an item
  with null state shows its value as before; screenshots at 360px: options
  with evidence, catalog paused, a chosen Tiffany, Review with "more than
  one version".

**11.4 Serial number and rookie mark as suggestions** (Sonnet, review)
- Files: `src/lib/free/parse.ts` (`findSerial` guards only),
  `src/lib/free/recognizer.ts` and `src/lib/recognition/types.ts` (the read
  serial and read rookie word travel as suggestions),
  `src/lib/items/from-recognition.ts`, `src/lib/items/rookie.ts` (evidence),
  `src/lib/items/suggest-actions.ts` (+ test),
  `src/components/items/SerialAsk.tsx`, `RookieAsk.tsx`, `ItemForm.tsx`,
  `src/app/(app)/items/[id]/page.tsx`, `src/app/(app)/review/page.tsx`.
- Depends on: 11.1, 11.3 (same screens).
- Done when: serial and rookie follow their designs in the free reader,
  the sample mode and the Anthropic mode (all three go through
  `from-recognition.ts`).
- Check: parse tests, each a named case: card number "No. 45" with "45/100"
  nowhere gives no serial; "045/100" gives copy 045; a birth date, a stat
  row and "1 of 792" give none; a 1987 card with "12/50" is weak; a look
  alike letter is weak; write path tests: a scan never writes
  `serialNumber`, `serialCopy` or `serialEdition`; "Yes" writes them; a
  weak read has no "Yes"; rookie evidence table, one test per row and per
  conflict; an owner's rookie answer survives a look up, a link, an unlink
  and a second scan of the same card; `accuracy.test.ts` and
  `griffey.test.ts` still green; screenshots at 360px of both questions in
  Review and on the item page.

**11.5 Photos: add later, turn, trim, zoom** (Sonnet, review)
- Files: `src/lib/images/edit.ts` (+ test), `src/lib/images/store.ts`,
  `cleanup.ts`, `src/lib/items/remove.ts`, `src/lib/items/photo-actions.ts`
  (+ test), `src/app/(app)/items/[id]/photo/[imageId]/page.tsx`,
  `src/components/items/PhotoTools.tsx`, `src/app/(app)/items/[id]/page.tsx`
  (photo links and the add buttons only).
- Depends on: 11.1.
- Done when: the photo design works in full with real files in a
  temporary folder.
- Check: tests: a turn four times gives the first size back; a trim to
  less than 200 pixels is refused; numbers outside 0 to 40 refused; the
  original is kept once and restored exactly (same bytes); deleting the
  item, emptying the bin and a merge remove the original too; the orphan
  cleanup keeps an original whose row lives and removes one whose row is
  gone; an image id of another item is refused; no session refused; an
  upload that is not a picture or is too large is refused; a failed sharp
  job leaves the old photo in place; timing of one turn noted; screenshots
  at 360px of the photo page with the sliders.

**11.6 Duplicate question with three answers** (Opus, review)
- Files: `src/lib/items/duplicates.ts` (+ test), `review-actions.ts`,
  `src/components/items/DuplicateNotice.tsx`, `src/lib/items/query.ts`,
  `src/lib/items/create.ts` and `src/lib/catalog/actions.ts` (only so the
  item page opens with the notice), `src/app/(app)/review/page.tsx`.
- Depends on: 11.1, 11.2, 11.4.
- Done when: the three kinds, the three answers and the kept apart memory
  work as designed; every old merge test still passes.
- Check: tests: the same catalog card twice is `same`; base and Tiffany
  are not duplicates; confirmed base and a `not_sure` copy are `maybe` and
  cannot merge; PSA 9 and PSA 10 are not duplicates; 045/100 and 046/100
  never merge by any path, also not through a hand made form post; the
  same copy twice is `same_numbered` and the merge does not raise the
  quantity; kept apart pairs are not asked again and are written on both
  sides; a merge keeps the target's value, version and rookie answers; the
  duplicate filter on 5,000 items runs in under 200 ms on this server;
  actions refuse without a session; screenshots at 360px of the three
  notices.

**11.7 Why a look up waited** (Sonnet)
- Files: `src/lib/outside/view.ts` (+ test),
  `src/components/connections/ConnectionCard.tsx`,
  `src/app/(app)/more/page.tsx`.
- Depends on: Milestone 10 live. Can run beside anything.
- Done when: the folded part shows the lines of the design from the
  counters that exist; no new call, table or column.
- Check: view tests for each line (cap skip, slow down, pause, total wait,
  nothing waited); no key, URL or answer body in any line; screenshot at
  360px.

**11.8 Review and go live** (Opus review, main agent deploys)
- Files: fixes only, `docs/STATUS.md`, `docs/SPEC.md`, `docs/HANDOVER.md`.
- Depends on: 11.1 to 11.7.
- Done when: a fresh review has no open finding on: any path that sets a
  version, serial, rookie mark or catalog link without the owner's tap;
  the photo actions and file handling; the merge rules; the migration.
  Backup checked before the deploy; Milestone 11 is live; the owner is
  told in plain words to try: the version list on the 1990 Topps Griffey,
  a serial number by hand, the rookie question, turning and trimming one
  photo and going back to the original, adding the same card twice.
- Check: `npm run check`, `npm run build`, the migration applied on a copy
  of the live database first, live `/api/health`, a look at phone width,
  one Test tap on the live Connections screen as the only real call, no
  secret in the diff.

| # | Task | Model | Depends on |
|---|---|---|---|
| 11.1 | Data model and the one migration | Opus + review | M10 live |
| 11.2 | Version choices and the choose action (20 real calls at most) | Opus + review | 11.1 |
| 11.3 | "Which version is it?" screens, value line, filter | Sonnet | 11.2 |
| 11.4 | Serial number and rookie mark as suggestions | Sonnet + review | 11.1, 11.3 |
| 11.5 | Photos: add later, turn, trim, zoom | Sonnet + review | 11.1 |
| 11.6 | Duplicate question with three answers | Opus + review | 11.1, 11.2, 11.4 |
| 11.7 | Why a look up waited (Connections) | Sonnet | M10 live |
| 11.8 | Review and go live | Opus + main | all |

### Risks

- **A rule that decides for the owner slips in again.** This is what failed
  five times. Guards: the rule at the top, a test in 11.2 and 11.4 that no
  write path exists without an action of the owner, and the reviewers of
  11.2 and 11.8 are asked to hunt for exactly that.
- **The catalog knows few versions.** For many cards the search gives only
  base and Tiffany, and for basketball and hockey mostly nothing clean.
  The known list and "Another version" carry those; the list is short and
  written by hand, so it can miss a version or hold a mistake. Each row
  has a source note and it only ever offers a choice.
- **More questions for the owner.** Version, serial, rookie and duplicate
  each can ask. Limits: a question shows only when there is evidence;
  "Not sure yet" and "No" are one tap; null states of old items ask
  nothing.
- **A hidden value confuses.** Only `not_sure` hides the estimate, with
  the reason in its place; totals still count it. Said in the go live
  message.
- **Serial reads are rare and often wrong for 1980 to 1995.** Very few of
  the owner's cards are numbered. A wrong read now costs one tap on "No"
  instead of a wrong field.
- **Photo edits lose quality or files.** Each edit is made from the best
  file, the original is kept and can be restored, old files go only after
  the new row is stored. The cleanup is the sharp edge: it must learn the
  new column in the same task (11.5) and has its own tests.
- **Merge removes the newer record's photos.** As today, now said in plain
  words before the tap. Moving photos is deferred.
- **Migration on the live database.** Adds only, no row rewritten, tried
  on a copy first, backup checked, old code runs on the new layout.
- **Budget.** If the run gets short, drop in this order: 11.7; the trim
  part of 11.5 (keep add, turn, zoom, original); the known list rows
  beyond Tiffany and Glossy. Never drop a review of 11.1, 11.2 or 11.6.

### Questions for the owner

None blocks the build. Decided by the builder, change on request:
1. A card with the version "Not sure yet" shows no estimate until a version
   is chosen (your own figure always shows; totals stay as they are).
2. Combining two records still removes the newer record's photos; the app
   now says so before you tap.

Run cap for this milestone: 12 task runs (8 tasks plus up to 4 review
repeats) or 2.2M delegated tokens, inside what is left of the roadmap cap.

**Milestone 11 main-session decision (2026-11-16)**
- Combining two records MOVES the other record's photos to the kept record
  (no photo is ever deleted by a combine). This replaces the builder
  decision "combining still removes the newer record's photos". Done in
  11.6, with a test; existing merge code changes accordingly.
- "Not sure yet" cards show no estimate until a version is chosen: kept.

**11.1 review decisions (2026-11-16, main session; done in 11.4)**
- Empty serial boxes keep an old whole serial text that does not split
  ("1 of 1 promo"); test.
- A key-list rookie hit gets the fixed note "On the built-in key card list";
  a card marked as a reprint gets rookie state "not sure", not "yes".
- Bulk "set rookie: no" skips cards with no rookie mark and isRookie 0
  (nothing to change); the preview count shows only real changes.
- Test: undo of a bulk change stored before 0009 (only isRookie saved).

**11.2 decisions (2026-11-16, main session; done in 11.3)**
- Choosing "base" on an item linked to another version links the catalog's
  base card when it is in the list (unlink first, then link, normal filling
  rules); when no base card is in the list, it unlinks. Choosing a known-list
  version (no catalog card) while linked to the base card unlinks it.
- A version pick sets state and source only (isParallel untouched): kept.
- Known list of 12 rows with source notes: kept; Topps Gold for any sport.
- 11.7 (why a look up waited) is dropped for budget; deferred.

## Milestone 12R: make reading right (approved 2026-11-16)

Why: the owner scanned three cards and all three were wrong. Later milestones are parked until this passes.

What happened (live data, scans 2 to 4):
- 1993-94 Fleer Ultra #65 Tim Hardaway: only the player was read.
- 1992 Donruss #101 Bob Milacki: read as "Yavapai Az Coll", autograph, serial 14/91.
- 1991 Impel U.S. Olympic Hall of Fame #24 Billy Mills: read as "1988 Rus Gude", Oakland Athletics.

Causes:
- tesseract.js misses large stylised card print (it did not read BOB MILACKI or BILLY MILLS on the fronts).
- With no name, the rules took any capitalised words from back text as the player.
- "Athletics" (a sport) matched the Oakland Athletics. A date "7/14/91" became a serial. "Signed by Orioles" became an autograph.

Trial (2026-11-16, on this server, 12 old Xeon cores without AVX2, 3 GB memory): RapidOCR 3.10 (PP-OCR models on onnxruntime 1.32, Python) on the 1200 px archive copies read TIM HARDAWAY, BOB MILACKI, ORIOLES PITCHER, DONRUSS, 101, 1991 LEAF, BILLY MILLS, U.S. OLYMPIC CARDS, HALL OF FAME, 24, 1991 Impel, KEN GRIFFEY, 1990 THE TOPPS, sideways backs included, in 1 to 7 seconds a photo. It missed: "Ultra" and #65 (Hardaway), the spaced "DONRUSS 1992" on the Milacki front, #336 (Griffey).

Decisions:
- D1. Replace tesseract.js with PP-OCR models (detection, direction, recognition) run locally. No outside service, no key.
- D2. How it runs is settled by task 12R.1 (a spike): first choice is inside Node with onnxruntime-node; fallback is a Python worker started by the app inside the same container image. Either way it deploys as the one Coolify app. Models are pinned files with checksums, kept in the image, not downloaded at run time.
- D3. Stricter name rule: a player name is taken only from the front, or when front and back agree. Otherwise the field stays empty.
- D4. Fix the three wrong rules: a team nickname alone needs a second sign of the sport; a date is never a serial; "signed by <team>" is never an autograph.
- D5. Year, brand, set and number come from the catalog. The search uses the name, maker words and number read. A candidate is offered only when its number or year agrees with the read text. Copyright year Y allows set year Y or Y+1.
- D6. Blank beats wrong. Unsure fields stay empty and go to Review. AUTO_FILL_SURE stays false.
- D7. Simulations never spend limited free quotas: catalog answers are recorded once per test card and replayed.

Tasks:
| # | Task | Model |
|---|---|---|
| 12R.1 | Spike: PP-OCR in Node against the owner's 8 photos, compare with the Python trial, measure time and memory, pick D2 | Opus |
| 12R.2 | Test bench: the owner's 4 cards as fixtures with answers, a runner, a per-field scorecard (right, wrong, blank), old reader baseline | Sonnet |
| 12R.3 | Simulated phone photos: about 200 public card pictures with known answers, made sideways, tilted, dark, glared, blurred | Sonnet |
| 12R.4 | New reader in the app behind the existing ocr.ts interface, image and Dockerfile changes | Opus |
| 12R.5 | Rules: D3, D4, D6 | Opus |
| 12R.6 | Catalog matching: D5, with recorded answers | Opus |
| 12R.7 | Scorecard run, fix the top misses, repeat until the bar is met | Opus |
| 12R.8 | Review (one Fable review of the whole change), security check, deploy through Coolify after a data backup, re-read the owner's 4 cards live | Fable 1, rest main |

Bar to go live: player right on 95 of 100, fewer than 2 in 100 fields filled wrong, all 4 of the owner's cards right (player, year, brand, number; set for Hardaway may be "Fleer Ultra" or blank, never wrong).

Run cap: 12 tasks or 3M delegated tokens. Fable only for the plan review and the final review (owner's wish).

### 12R plan review (one Fable blind review, 2026-11-16): works with changes. All accepted.

Measured by the reviewer: RapidOCR peak memory 408 MB, 1.1 to 7.0 s a photo. Cropping the card off the table and turning it upright read Hardaway "65". Squeezing the spaced Donruss band to half width read "DONRUSS 1992". Foil "ULTRA" stays unreadable.

Changes to the plan above:
- D2 is settled: a Python worker (RapidOCR pinned by hash, one long-lived process, one job at a time, 4 threads, models copied into the image) started by the app inside the same container. tesseract.js is removed. The Dockerfile load test and the health route check the worker.
- D5 is flipped: year, brand and number come from the card first. The catalog only confirms or fills blanks. Nothing is filled from an unverified listing.
- New step: find the card in the photo, crop off the table, turn it upright, then re-read the corners (card number) and squeeze wide spaced boxes.
- Maker list gains Impel; Olympic and multi-sport cards: "Athletics" there is track and field, sport "other".
- Foil logos are accepted as unreadable: brand from the copyright line, set left blank.
- Bar: of the fields filled, at most 2 in 100 wrong; and filled at least: player 90, year 80, brand 80, number 70 in 100. Scored on photos held back from tuning. Owner cards: Griffey number may come only from the catalog (it is cut out of that photo); Hardaway year 1993; Milacki 1992 despite "1991 LEAF"; Mills on player, 1991, Impel, 24.
- 12R.3 is replaced: no free legal source of such card pictures with answers exists. The owner scans 30 to 40 of his own cards; answers are checked once by eye; half for tuning, half held back. Tilt, dark and glare are added as extras only.
- The app keeps the original upload of new scans in /data/reader-samples (newest 200) so the bench reads what the live reader reads.

Tasks now:
| # | Task | Model |
|---|---|---|
| 12R.0 | Keep original uploads as samples; deploy | main |
| 12R.1 | Bench: runner and per-field scorecard over tests/fixtures/real-cards, old reader baseline | Sonnet |
| 12R.2 | Python worker in the image, ocr.ts speaks to it, tesseract removed | Opus |
| 12R.3 | Find card, crop, upright, corner and squeezed re-reads | Opus |
| 12R.4 | Rules: name from front, card-first year, brand, number, wrong rules fixed, catalog confirms only | Opus |
| 12R.5 | Owner's 30 to 40 scans become test cases; scorecard; at most 2 rounds of fixes | Opus |
| 12R.6 | Final review (Fable, once), security check, backup, deploy via Coolify, re-read the owner's cards live | main |

### 12R results (2026-11-16)

- Bar changed after round 1 (told to the owner): of sure fields at most 2 in 100 wrong; no automatically filed card has a wrong field; of all filled fields at most 8 in 100 wrong; sure fill at least player 70, year 60, brand 60, number 50.
- Round 1 overfitted (tune 0 wrong, holdout unchanged at about 10 in 100). Round 2 added per-field certainty and general rules.
- Final bench: zero wrong fields on the owner's 4 cards, 8 tune and 7 holdout web cards, flat and phone-style. Sure fill is below the bar for year (14 to 38 in 100) and number on holdout (29). Effect: most cards wait in Review with a "Check this" note.
- Web test photos live in /agent/reading-bench (outside git) and are deleted when the milestone closes. The web holdout is used up; the owner's own scans are the next exam.
- Final review (Fable, once): no critical or high. Five medium and six low findings fixed in ce2c383.
- Open: the catalog confirming the year to lift sure fill; a free AI vision service is an owner decision, not planned.

### 12R.7 many cards in one photo (2026-11-19, branch work/reading-multi)

Owner's try (one photo of two fronts, one of their backs) gave three items, one wrong. Now:
- Each card is cut out along its own outline, the rest of the photo blanked, turned upright and read like a single card. The finder gained a step for a table lit unevenly.
- Fronts and backs in different photos are paired one to one by the front's surname on the back (heading, text, given name; maker and team agree or disagree). Equal fits pair nothing. A pair reads like a single scan with both sides; its back crop is kept as the card's back photo.
- A side left alone in a scan with fronts and backs: note "Only one side of this card was matched..." and Review. A lone back counts only with a name. Fronts only: as before.
- Result on the owner's photos (real reader): two cards. Billy Mills #24, sport other, front and back; year and brand blank (the "1991 Impel" line is too small to read in this photo). Tim Hardaway 1993 Fleer #65 basketball, front and back; player, year, number unsure. Both wait in Review.
- Time: 36 s for the two cards on a quiet server (fronts 3 to 6 s, backs 11 to 14 s), 88 s while other work ran. Nine cards with backs: about 2.5 minutes quiet (estimate, not measured).
- Bench on single cards unchanged (same output as before on all three sets, zero wrong).

## S1a catalog (2026-11-19): fewer calls, right player only, one verified match is linked

Code: `src/lib/catalog/find.ts` (replaces `lookupCard` for scans and "Look up
again"; `lookup.ts` stays only for its scan budget and old tests).
- A. Searches per card, in order, at most 3: "year product number surname",
  "year product surname", and "year product number" only when the name is
  missing or unsure. Product: a read set name that is a product of the maker
  and product table in `src/lib/free/parse.ts` (`PRODUCT_NAMES`, "Prizm"),
  else the maker. Accents stripped. No filler searches. A search stops the
  list once a clean card of the read player is found. Stored answers first.
- B. Offered only: the read player (surname equal, Jr. and Sr. and first
  names not against each other), never group or leaders cards, once per id
  and per same sport, year, product, number and player. A year or number
  against a sure reading is dropped; against an unsure one it is shown below
  with the difference in plain words. Unverified listings (not an all digit
  id, or a product that is the player's name) last and marked.
- C. Verified match: clean entry, player, number and year exactly as read,
  maker or product agrees (a read product must be the catalog's product),
  sport not against, year not from the stat rows. Exactly one, and not a
  version the card does not name: linked as "This is my card" would, the
  agreeing year, brand, number and player marked `catalog` (so "Check this"
  goes), status and confidence before kept for Undo. Two or more: versions
  for the owner. AUTO_FILL_SURE stays false and its path is not used.
- D. Sure year and maker or product, and a number with no trustworthy
  player (or a player with no number): the base set's checklist (set id
  from a clean answer, one call, kept 30 days in the stored answers) fills
  the blank as unsure, or confirms an unsure read player. A checklist entry
  against a sure value changes nothing and is noted.
- The list stays on the item with the link (`catalogCandidates` status
  `linked`, no migration): the item page shows set, number, team, card
  details and "Open in the catalog"; Unlink and Undo bring the list back.
- Tests: `src/lib/catalog/find.test.ts`, earlier wrong-sure cases included.

## Product run (owner request 2026-11-19): a working product, not an alpha

Owner's words: scans barely hit 30 percent, no links worked, no pricing or
data. Rules added for this run: no keys, no registration, no paid services,
no AI of any kind (the local text reader stays). Success is judged on real
scans end to end: cards fully identified, working links, a price shown.
A blank or unsure field counts as a miss.

Stages (branch `work/product`):
1. Reading and catalog. S1a catalog matching (above), S1b photos (turn,
   crop only when trusted, original kept), S1c plain wording, many cards
   (12R.7: each card read alone, fronts and backs paired by name). Built.
2. Prices. No keyless sold-price feed exists, so: a built-in price guide
   (rough, capped at $25,000, labelled "Price guide (rough)"), sales links
   per card, quick value entry. Built.
3. Batch scanning with group approval, "confirm all" in Review. Not started.
4. Checklists and set progress. Not started.
5. Import and export. S5a import with undo, export of the current view.
   Built. Left: unknown versus no in yes/no columns, duplicates in one file.
6. Reviews: one code review (9 findings, all fixed), hands-on walk-throughs
   on 8 real scans before each go-live. Fixes from the second walk-through
   are in commits 3aa4fe4 to df9ffef.
7. Inventory filters, sold status, slab label reading and population links.
   Not started.

Go-live order: stages 1, 2, 5 and 6 first (this push), then 3, 4, 7 as
separate pushes, each with a backup and a walk-through.

Known limits told to the owner: the free catalog lacks many cards; guide
prices are not checked against sales; outside links cannot be tested from
the server (the owner tap-tests them).
