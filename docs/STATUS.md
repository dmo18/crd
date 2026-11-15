# Status

## Done
- Task 1: project setup, checks, docs
- Task 2: database design and shared contracts

## In progress
- Milestone 1: login, camera capture, AI recognition, review screen

## Next
- Milestone 2: multi-card photos, rapid-fire, sealed, bulk, review queue
- Milestone 3: valuation, inventory, dashboard, locations, export, flags

## Decisions and reasons
- Next.js + SQLite in one app: one thing to host, cheap, enough for one owner.
- `cacheComponents` off: private per-request app, no benefit from static shells.
- System fonts, no web font download: faster on phones, builds offline.
- Password hash stored base64 encoded: bcrypt hashes contain `$`, which env
  file loading would otherwise mangle.
- One `items` table for cards, sealed and bulk: one inventory, one search.
- Money in integer cents: no rounding errors.
- Sample recognizer: lets every screen be built, tested and previewed with no
  API key and no cost.
- Tasks 1 and 2 were done in the main session, not delegated: writing the brief
  would have cost more than the work.

## Known issues
- `npm audit`: 12 moderate findings, all in developer tools (the linter's
  file matcher and the migration tool), none in the running app. No fix
  available without downgrading; recheck at each milestone.

## Open security findings
None yet. First review at the end of milestone 1.

## Run log
- Delegated tokens used: 0 of 2,500,000
- Tasks done: 2 of 17. Failed attempts: 0.
