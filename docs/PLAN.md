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
