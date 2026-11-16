# Roadmap after the owner's feature sheet (2026-11-16)

The owner sent a spreadsheet with a Keep or Skip decision for 50 features.
29 are Keep. This file compares them with today's app, lists what does not
fit together, says honestly which free data sources can carry them, and
proposes the milestones after Milestone 9.

Nothing here is approved yet. The questions at the end need the owner's
answer before Milestone 10 starts.

Checked today, on 2026-11-16, from this server:
- CardPricer: real calls made without a key. Works, but see section 3.
- MyCardfolio: real calls made without a key. Found the 1990 Topps Ken
  Griffey Jr. #336 base card and the Tiffany version.
- The Card API and CardSight AI: only their public docs and price pages
  were read. No key was created, no call was made.
- eBay image search: the docs page did not state the approval rules.
  Not verified.

## Owner answers (2026-11-16)

1. Free signup keys (no credit card): yes. The owner adds them in an
   admin section of the app, not in Coolify. Settled design for that
   screen ("More, Connections"): owner session required; a key is pasted
   once and never shown again (only "saved, ends in ...4f2a" and the date);
   stored encrypted in the database with AES-256-GCM using a key derived
   with HKDF from a new server setting `SETTINGS_KEY` (falls back to
   `SESSION_SECRET` if unset; changing it means re-entering the keys);
   Remove and Replace buttons; a "Test" button that makes one small call;
   every save, removal and test is an audit event without the key; keys
   never appear in logs, exports, backups shown to the owner, or errors.
   Built in Milestone 10 together with the F49 usage core, used first by
   Milestone 14.
2. Mass edit and delete (Part B): stays (asked for directly).
3. Part C: shortened; reading uses the online catalog (Milestone 10).
   9.12 and 9.13 return only if the catalog trial fails.
4. Batch scans: sure reads are filed automatically; unsure ones wait for
   approval in Review.
5. No folders, rows or slots, no in-app full backup (builder decision,
   matches the sheet's Skip choices; location field, CSV export and the
   server backup stay).
6. Order approved: Part A, Part B, short Part C, then Milestones 10 to 16.
   Run cap: 75 tasks or 12M delegated tokens, then stop and ask.

## Part C status (2026-11-16, night)

Part C (9.10, 9.11) is built on branch `work/m9c` but NOT live. It failed
review twice: the team rules from text alone keep producing wrong teams
(second review: a lowercase bio word like "twins" beats a misread front
team; plain words like STARS, BEARS, MAGIC become teams; four digit split
stat rows lose the year). Per the run rules it stopped after two failures.
Decision (builder): do not ship it alone. Milestone 10 task 8 takes the
branch, keeps the good parts (extra reading passes, sentence rule, name
particles, header years, the Griffey fixture) and makes team and brand come
from the catalog card, with text team matching only as a weak hint that
the catalog must confirm. The second review's list (H1, M1 to M4, L1, L2)
becomes that task's test list.

## 1. The 29 kept features against today's app

"Today's app" means branch `work/m9-owner-top3` with Part A done.

| ID | Feature | Today | What is there, what is missing |
|---|---|---|---|
| F01 | Photo card identification | Partly | Free text reading of front and back, confidence, Review queue. No card catalog, so no list of candidate cards to pick from. |
| F02 | Bulk image scanning | Partly | Part A: take, save, move on, with a Scan activity page and retry. No "pick 50 files at once", no batch summary, no approve step for a whole batch. |
| F03 | Card detail search | Missing | Search only looks in the owner's own records. There is no catalog to search. |
| F04 | Parallel and short print | Partly | A free text "variation" field and parallel, insert, error flags. No list of known versions to choose from, no version identity. |
| F05 | Checklists and set completion | Missing | Nothing. |
| F06 | Raw card value | Partly | A rough range from rules, the owner's own value (which wins) and one tap links to sold listings. No real sold prices inside the app. |
| F07 | Graded values by grade | Partly | Grader, grade and cert number are stored, plus a "worth grading" hint. No prices per grade. |
| F08 | Completed sales evidence | Missing | Only outside links to eBay sold listings. No sales stored or shown. |
| F11 | Collection inventory | Mostly exists | Quantity, photos, condition, grade, notes, locations, search, edit, delete, duplicates as quantity. Missing: sold or removed status, link to a catalog card. |
| F12 | Portfolio valuation | Partly | Home shows total, counts, top cards, by kind, by decade, value over time. Missing: by sport, player, team, set; raw against graded; unpriced count. |
| F13 | CSV import and export | Partly | CSV export exists and is safe against spreadsheet formulas. No import, no Excel, no export of a filtered selection. |
| F19 | Population reports | Missing | Nothing. |
| F21 | Manual correction | Partly | Every field can be edited. The scanner's first suggestion is not kept beside the correction. |
| F22 | Duplicate detection | Partly | Possible duplicates show in Review with a merge button. Not checked on manual add or import; does not use grade or serial number. |
| F23 | Front and back photos | Partly | Front and back are saved and shown. No rotate, crop or zoom by the owner, no adding a back photo later. |
| F24 | Serial number reading | Partly | The reader finds numbers like 045/100 and stores them as one text. Copy number and edition size are not separate; no confirm step. |
| F27 | Search and filters | Partly | Text search, kind, status, rarity, location, 8 sorts. Part B adds "No player", "No value", duplicates and more. Missing: flags, grader, grade, value range, quantity. |
| F29 | Confidence scores | Mostly exists | Confidence is stored and unsure reads wait in Review. No list of other possible matches (needs the catalog). |
| F32 | Value confidence | Missing | Needs real sales first. |
| F33 | Fill in missing details | Partly | A small live Wikidata lookup adds player facts. No card catalog lookup, no "source of this field" note. |
| F34 | One identity from many sources | Missing | No canonical card key, no source IDs. |
| F36 | Manual price refresh | Partly | The owner can re-run the rough estimate. No provider to refresh from. |
| F37 | Price source shown | Partly | Each value has a source and a short basis text, with history. No provider name, sale count or evidence links. |
| F38 | Bulk review and approval | Partly | Review page with confirm, delete, merge per card. No batch groups, no multi select approve, no "import only what I approved". |
| F41 | Rookie identification | Partly | A rookie flag read from the card text and a small key card list. No checklist proof, no "unknown or disputed" state. |
| F43 | Barcode and slab reading | Partly | Slab labels are read (grader, grade, cert, year, brand). No barcode or QR reading. |
| F45 | Manual card entry | Missing | A record can only be created by a scan. There is no "Add by hand" screen. |
| F49 | API usage and limits | Missing | The Wikidata lookup has its own pause logic. No shared counter, caps or usage page. |
| F50 | Find listings by photo | Missing | Nothing. Needs an eBay developer account (section 3). |

Count: 2 mostly exist, 17 partly, 10 missing.

## 2. Conflicts and oddities

**Sheet against what the owner asked today**

1. **F20 is Skip but includes "mass editing".** Today the owner asked for
   mass edit and mass delete (Milestone 9 Part B). Reading: F20 was skipped
   for its dealer parts (repricing, shipping, labels, listings). Part B
   stays. The newer, direct request wins.
2. **F11 keeps "edit/delete" but says nothing about a bin.** Part B adds a
   30 day "Recently deleted" bin, which the owner approved today. No real
   conflict; the bin stays.

**Sheet against itself**

3. **F26 storage locations is Skip, but F11 Keep lists "physical storage
   locations" and "box/binder/sleeve location".** The app already has
   locations. Reading: keep the simple location field, do not build rows
   and slots.
4. **F47 binders is Skip and F35 (whose text describes folders) is Skip,
   but F11 Keep mentions "custom folders" and F12 mentions totals "by
   folder".** Reading: no folders. Location plus filters cover it.
5. **F46 backup and restore is Skip, but F13 Keep says "full collection
   backup" and "backup and restore verification".** Reading: a full CSV
   export is the owner's copy of the data. Photos and full restore stay
   with the server backup (`server-backup`, Milestone 8), which already
   exists.
6. **F35 title "Automatic Price Refresh" has the description of folders
   and binders.** Either way it is Skip, and F36 says "no automatic
   scheduled updates", so nothing is lost.
7. **F39 title "Offline Collection Access" has the description of a
   grading cost calculator.** Skip either way. Note: the app has a small
   "worth grading" hint today; it stays as is, nothing more is built.
8. **F44 multi card detection is Skip, but the app already has it** (one
   photo with many cards, `src/lib/free/find-cards.ts`, in the spec since
   Milestone 2). Reading: do not remove working code; spend no more work
   on it. F02 itself lists it as an "optional later improvement".
9. **F09 price charts is Skip, but the app already shows "value over
   time" on Home**, and F12 says "historical trend charts are excluded".
   Reading: leave the existing chart, build no new ones.
10. **F25 rarity and print runs is Skip, but the app gives every item a
    rarity tier** (common to grail). The tier is the app's own rough label,
    not a print run. It stays, no new work.
11. **F42 autograph and memorabilia identification is Skip, but F27 Keep
    filters by "autograph flag" and the app already has autograph and
    memorabilia flags.** The flags stay as simple tick boxes.
12. **F18 certificate lookup is Skip, but F07 says "verification of
    grader, grade and certification number where possible".** Reading:
    store the cert number, no lookup.
13. **F14 cost and profit is Skip, but F13 says to preserve "original
    costs" on import.** Reading: no cost fields. An imported cost column
    goes into the notes or is left out.
14. **F30 cross marketplace comparison is Skip, but F08 asks to remove
    duplicates "across feeds".** Reading: one sales source at a time.
15. **Suggestion and decision differ, on purpose:** F05 (Consider, owner
    Keep), F14 and F18 (suggested Keep, owner Skip), F19 (Consider, owner
    Keep), F50 (suggested Skip, owner Keep). The owner's column wins.
16. **F36 names Beckett and TCDB under "reported on sites" but its link
    goes to The Card API; F38 names SportsCardsPro but links to Card
    Dealer Pro.** Research slips, no effect on the plan.

**Sheet against the owner's rules and the real data**

17. **The sheet lets providers be "trial" or paid** (Ximilar, Trading Card
    API, SportsCardsPro, Card Hedge, HobbyCardIndex) and F49 talks about
    "separate limits for paid APIs". Owner rule: never paid keys. All of
    these are out. F49 is built for free sources only.
18. **Most "free" sources in the sheet need a signup key.** Only
    CardPricer and MyCardfolio work with no key at all. Whether a free
    signup key is allowed is question 1.
19. **The Card API lookback:** the sheet says 3 days, the provider's docs
    page today says 30 days. To be checked with a real key.
20. **CardPricer is ranked 2 as "strong free source for catalog plus
    values". Real calls today show otherwise** for this collection
    (section 3): about 2,600 baseball cards in total, almost all graded
    slabs. It cannot be the catalog.
21. **Sold prices clash with the settled spec decision** "no automatic
    prices, sold links plus owner entry" (2026-11-15). F06, F07, F08, F32,
    F36 and F37 reopen that. The owner's newer sheet wins, but only as far
    as free data really exists.
22. **F02 and F38 say nothing joins the collection before the owner
    approves it. Today a sure read is filed as confirmed by itself**, and
    Part A is built on "take, save, move on". This is question 4.
23. **F01 and F04 ask for reference images side by side, but F28
    (reference image comparison) is Skip.** Reading: show the catalog's
    small picture in the candidate list when the source gives one, no
    zoom and compare tool.

## 3. Data sources: what is really free

Owner collection: mostly 1980 to 1995, mostly raw (ungraded) cards. That
matters more than anything else below.

### Catalog and identification (F01, F03, F33, F34, also F04, F05, F41)

| Source | Key needed | What we saw | Verdict |
|---|---|---|---|
| **MyCardfolio** | None | Live today. Tools: search, card detail, set checklist (500 cards per call), browse by sport and year, find variants, identify from a text line. Found 1990 Topps #336 base and Tiffany. It is not a normal web API but answers a plain web request, so no new library is needed. | **Use as the catalog.** |
| CardPricer | None | Live today. 60 calls per minute, 1,000 per hour. Only 2,626 baseball cards in total, about 50 per year for 1987 to 1990, nearly all graded. A search for the 1990 Topps Griffey #336 gave nothing. | Not a catalog. |
| CardSight AI | Free signup key | 750 calls a month. Photo identification, catalog and prices in one. Not tested. The owner's photos would be sent to that company. | Only if question 1 is yes, as a second opinion for hard cards. |
| Wikidata | None | Already in the app for player facts. | Keep as the fallback for player names. |
| Topps, Panini, Upper Deck checklists | None | Web pages and PDF files, no data feed, weak for 1980 to 1995. | Links only. |

Honest limits of MyCardfolio:
- Terms say only "free for personal and assistant use" and "rate limited",
  with no number. They say nothing about storing results.
- Plan for that: look up live, store only the cards the owner looked at or
  confirmed (with the source link), never copy the whole catalog. Ask the
  site by message whether keeping set checklists is fine before F05.
- Results contain noise (entries taken from eBay titles, IDs starting with
  `ebay_`). The app must prefer the clean entries.
- It is one hobby website. If it goes away, the app must keep working with
  today's reading. The catalog sits behind one interface so it can be
  replaced.
- No source reads a card photo for free without a key. Photo reading stays
  our own text reader; the catalog then turns the read text into candidates.

### Sold prices (F06, F07, F08, and with them F32, F36, F37, F12)

| Source | Key needed | Free amount | Verdict |
|---|---|---|---|
| **The Card API** | Free signup key, no credit card | 5,000 sale rows a day; 30 days back (the sheet says 3). Search by listing title; rows carry price, date, marketplace, link, grader and grade. | **Best free fit**, if question 1 is yes. Terms on storing rows not read yet. |
| CardPricer | None | See above. Its data comes from a few online slab markets; its eBay, COMC and Goldin feeds showed zero in the last 7 days. | Extra source for graded star cards only. |
| CompsAPI | Free signup key | 100 calls a month. | Too small, except for a handful of top cards. |
| SoldComps | Free signup key | 100 calls a month, 90 days back. Data is scraped from eBay. | Too small, and the legal side is unclear. Avoid. |
| Soldgraph | Free signup key | 100 calls, unclear if they renew. | Avoid. |
| eBay itself | Developer account | Sold listings are not open to normal developers. | Cannot be done. |

What cannot be done free: real sold prices with **no key at all** for raw
1980 to 1995 cards. Without a signup key the app stays where it is: rough
range, the owner's own value, and links to sold listings. With a free key,
30 days of sales will still be thin for common cards, so many cards will
honestly say "not enough sales". That is what F32 asks for anyway.

Storing: keep only the sales used for the owner's own cards, with the link
and the date. No bulk copies, no showing them to anyone else. The app is
private, so the "link back on public pages" rules do not bite.

### Population reports (F19): links only

No grading company offers free population data to programs. The PSA API
is free with a token but only looks up one certificate (that is F18,
Skip). Plan: buttons on the card page that open the official PSA, SGC and
CGC population pages with the card's words filled in, plus the line "this
counts graded copies, not how many were printed". No counts inside the app.

### Listings by photo (F50)

Only eBay offers this. It needs an eBay developer account in the owner's
name, an app key and secret (stored in host settings), and eBay's approval
for live use. The docs page fetched today did not state the approval rules
for image search, so this is **not verified**. It is free of charge, about
5,000 calls a day. It shows asking prices only, never sold prices. If
approval fails, the fallback is a plain link to an eBay search.

### Summary

- No key at all: catalog and identification help (MyCardfolio), population
  links, a little graded pricing (CardPricer).
- Free signup key: real sold prices (The Card API), photo second opinion
  (CardSight AI), listings by photo (eBay account).
- Not possible free: sold prices from eBay directly, population counts in
  the app, automatic reading of subtle parallels, reference images we may
  keep.

## 4. What this changes in Milestone 9

**Part A:** no change. Goes live as planned.

**Part B (record manager): continue exactly as designed.** The owner asked
for it today, F11 and F27 need it, and later milestones reuse its parts:
the selection engine for "refresh prices for these cards" (F36) and for
multi select approval (F38), the smart filters for F27, the bin for safe
imports (F13). Nothing in the sheet argues against it; the F20 Skip is
about dealer tools.

**Part C (better reading): reshape, do not drop.**

- Keep **9.10** (Griffey test photos and extra reading passes), **9.11**
  (parsing rules) and **9.14** (fix a name fast in Review). A catalog can
  only match text that was read well, so this work is needed either way.
- Replace **9.12 and 9.13** (the bundled Wikidata player list, up to 40 MB
  of memory, two Opus tasks). A card catalog does the same job better: it
  knows the card, not just the player. "1990, Topps, GRIFFEY" gives the
  exact card with its number, set and versions; a player list only fixes
  the name. These two tasks move into Milestone 10 as "match the read
  text against the catalog".
- Effect on the Griffey test: after the short Part C the test must pass for
  sport, year, brand, team and "no wrong names". The full name "Ken Griffey
  Jr." and the number 336 are met in Milestone 10, with a recorded catalog
  answer so tests still never touch the network.
- Safety net: Milestone 10 starts with a trial of the catalog on 30 real
  cards. If the trial fails (too slow, too many misses, blocked), the
  bundled player list comes back as planned in 9.12 and 9.13.
- Part C goes from 6 tasks to 4 (9.10, 9.11, 9.14, review and go live).

## 5. Proposed milestones 10 and later

Order: identity first, because prices, checklists and duplicate checks are
only right when the app knows exactly which card and which version it has.
Every milestone ends live on the phone. Model tier per task in brackets.
"review" means a fresh reviewer who did not write the code.

Rules for all of them: free sources only, keys only in host settings, tests
never touch the network (recorded answers), every outside call goes through
one shared gate with a counter and a cap, deploy only through Coolify, slow
server in mind (one outside call at a time, nothing heavy in memory).

### Milestone 10: the card catalog (F03, F33, F34, F45, F21, F01, F49 core)

The owner can try: search any card by words and add it; add a card by
hand; after a scan, pick the right card from a short list.

1. Catalog trial on 30 real cards: hit rate, speed, limits; message to the
   site about storing. Go or no go. (Sonnet)
2. Data model: catalog card with one canonical key, source IDs, source of
   each field; items link to it; the scanner's first suggestion is kept.
   Adds only, old code keeps running. (Fable, review)
3. Shared gate for outside calls: per source counter, cap, wait and retry,
   stored answers with an age limit. (Opus, review)
4. MyCardfolio client: search, card, variants; cleans names and numbers,
   drops noise entries; recorded answers for tests. (Sonnet, review)
5. "Search cards" screen with filters and "Add to my collection". (Sonnet)
6. "Add by hand" screen, partial records allowed, "link to a catalog card"
   later without losing the owner's edits. (Sonnet)
7. After a scan: catalog candidates in Review, one tap to pick; fills empty
   fields only, never overwrites what the owner typed. (Opus, review)
8. Griffey test met in full through the catalog (replaces 9.12, 9.13).
   (Opus)
9. Review and go live. (Opus review)

9 tasks.

### Milestone 11: the exact version (F04, F24, F41, F23, F22, F49 screen)

The owner can try: "Which version is it?" picker, serial number split into
copy and edition, rookie mark with its source, rotate and crop a photo,
clear duplicate questions.

1. Version identity: known versions of a card from the catalog, picker
   with "not sure yet"; value is not shown for an unconfirmed version.
   (Opus, review)
2. Serial numbers: copy number and edition size apart, leading zeros kept,
   confirm when the read is weak, never mixed with the card number.
   (Sonnet, review)
3. Rookie mark: yes, no, unknown or disputed, with the source; owner can
   override. (Sonnet)
4. Photos: add a back photo later, rotate, crop, zoom. (Sonnet)
5. Duplicate check on the canonical key with version, grader, grade and
   serial; three choices: add another copy, merge, fix the old record; also
   on manual add. (Opus, review)
6. "Data sources" page in More: calls used, caps, why a lookup waited.
   (Sonnet)
7. Review and go live. (Opus review)

7 tasks.

### Milestone 12: inventory power (F27, F13, F11, F12 without prices)

The owner can try: filter by anything, bring in a spreadsheet, mark a card
as sold, see totals by sport, player, team and set.

1. More filters: flags, version, grader, grade, value range, quantity,
   no price; saved in the link like today. (Sonnet)
2. "Sold" and "Removed" status, kept out of totals. (Sonnet, review)
3. CSV import engine: read, match columns, check every row, find
   duplicates, all or nothing, stable IDs so a second import updates
   instead of doubling. (Opus, review)
4. Import screens: pick file, match columns, preview, result report.
   (Sonnet)
5. Export what is filtered or selected, with stable IDs. (Haiku)
6. Home: totals by sport, player, team, set; raw against graded; unpriced
   count. (Sonnet)
7. Review and go live. (Opus review)

7 tasks. Excel files need a new library; first version is CSV only, and
the import screen says "save as CSV first".

### Milestone 13: batch scanning with approval (F02, F38, F29)

The owner can try: pick 50 photos at once, watch them being read, see
Ready, Needs review and Unmatched groups, approve many at once.

1. Batch model on top of Part A scans: one batch, state per card, survives
   a restart. (Opus, review)
2. Pick many files at once; clear message when a limit pauses the batch.
   (Sonnet)
3. Batch review screen: three groups, other possible matches, duplicate
   flags, multi select approve and reject (reuses the Part B selection).
   (Sonnet, review)
4. Approval rule from question 4 applied in every total and list.
   (Opus, review)
5. Batch report, continue later, retry failed ones without reading the
   finished ones again. (Sonnet)
6. Review and go live. (Opus review)

6 tasks.

### Milestone 14: real sold prices (F06, F07, F08, F32, F36, F37, F12)

Needs question 1 answered yes and Milestones 10 and 11 live. It can move
ahead of 12 and 13 if the owner wants prices sooner.

The owner can try: open a card, see the sales behind its value, drop a
wrong sale, see High, Medium or Low trust, tap "Refresh price".

1. Price source trial with the free key on 30 real cards: how many get
   enough sales; read the terms on storing. Go or no go. (Sonnet)
2. Data model: sales, price lookups with source, method and time; manual
   values stay marked as the owner's. Adds only. (Opus, review)
3. Sales clients through the shared gate, and matching sale titles to the
   exact card and version: no lots, no reprints, no other grades.
   (Fable, review)
4. Estimate: middle of the suitable sales, low and high, minimum number of
   sales, trust label with the reason in plain words; "not enough sales"
   instead of a guess. (Opus, review)
5. Price panel on the card page: sales list with links, exclude a sale,
   source, date, method. (Sonnet)
6. Graded: value per grader and grade, shown apart from raw, never mixed.
   (Sonnet, review)
7. "Refresh price" for one card or a selection; old value kept when a
   lookup fails; daily cap respected. (Sonnet)
8. Home uses the new values; stale and unpriced counts. (Sonnet)
9. Review and go live. (Opus review)

9 tasks.

### Milestone 15: checklists and set progress (F05)

The owner can try: open "1990 Topps", see owned, missing and wanted cards
and the percent complete, copy the missing list.

1. Data model: sets, checklist entries, wanted marks, "checklist complete
   or partial" flag. (Opus, review)
2. Checklist loading in pieces (500 cards per call), only for sets the
   owner opens, within what the source allows. (Sonnet, review)
3. Set screen: owned, missing, wanted, counts and percent; warning when
   the checklist is partial. (Sonnet)
4. Owned cards matched to entries by themselves after a scan or add;
   several copies count once. (Sonnet, review)
5. Missing and wanted list: copy and CSV. (Haiku)
6. Review and go live. (Opus review)

6 tasks.

### Milestone 16: slabs, population links, listings (F43, F19, F50)

The owner can try: photograph a slab and get its label filled in, open
the official population page in one tap, find listings for a card.

1. Slab label reading: show the read text beside the fields, fix in one
   tap, match to the catalog card. (Opus)
2. Barcode and QR reading (needs one small library, reason stated in the
   task). (Sonnet, review)
3. Population buttons to PSA, SGC and CGC pages with the fixed note.
   (Haiku)
4. eBay account trial with the owner: sign up, keys into host settings,
   check that image search is allowed. Go or no go. (Sonnet)
5. "Find listings" screen: asking prices, clearly apart from sold prices
   and never changing the card's value. (Sonnet, review)
6. Fallback when eBay says no: plain search links. (Haiku)
7. Review and go live. (Opus review)

7 tasks.

### Totals

| Milestone | Tasks | Haiku | Sonnet | Opus | Fable |
|---|---|---|---|---|---|
| 10 Catalog | 9 | 0 | 4 | 4 | 1 |
| 11 Exact version | 7 | 0 | 4 | 3 | 0 |
| 12 Inventory power | 7 | 1 | 4 | 2 | 0 |
| 13 Batch approval | 6 | 0 | 3 | 3 | 0 |
| 14 Sold prices | 9 | 0 | 5 | 3 | 1 |
| 15 Checklists | 6 | 1 | 3 | 2 | 0 |
| 16 Slabs, population, listings | 7 | 2 | 3 | 2 | 0 |
| **All** | **51** | 4 | 26 | 19 | 2 |

Kept features and where they land: F01 M10; F02 M13; F03 M10; F04 M11;
F05 M15; F06 M14; F07 M14; F08 M14; F11 M9 Part B and M12; F12 M12 and
M14; F13 M12; F19 M16; F21 M10; F22 M11; F23 M11; F24 M11; F27 M9 Part B
and M12; F29 M10 and M13; F32 M14; F33 M10; F34 M10; F36 M14; F37 M14;
F38 M13; F41 M11; F43 M16; F45 M10; F49 M10 and M11; F50 M16.

### Risks

- **One catalog source.** MyCardfolio is a hobby site with no stated
  limits. The trial task, the shared gate and the single interface limit
  the damage; today's reading stays as the fallback.
- **Thin price data for old raw cards.** Even with a free key, many common
  cards will have no sales in 30 days. The app will say so instead of
  guessing.
- **Terms on storing.** Not stated by MyCardfolio or CardPricer, not yet
  read for The Card API. Each trial task reads the terms first.
- **Free today, changed tomorrow.** Free plans shrink. Every source can be
  switched off in settings without breaking the app.
- **Data model changes on the live database.** All add only, backup
  checked before each deploy, as in Milestone 9.
- **Slow server.** Outside calls run one at a time in the background, the
  owner never waits on them (same idea as Part A).

## 6. Questions for the owner

1. **May the app use free accounts that need a signup but never a credit
   card (a free key, stored only in the server settings)?**
   Recommended: yes, for The Card API (sold prices) and later eBay
   (listings). Reason: without them there are no real sold prices at all;
   nothing is ever paid and the key never leaves the server.
2. **Mass edit and mass delete (Part B) stay, even though the sheet skips
   "dealer bulk operations" (F20)?**
   Recommended: yes. Reason: you asked for it today, and F20 was about
   dealer tools like repricing and shipping.
3. **Change Part C: use the online card catalog to fix names and fill in
   card details, instead of a built in player list?**
   Recommended: yes. Reason: the catalog knows the exact card, number and
   versions, not only the player, and it saves memory on the small server.
4. **Batch scans: should cards the app is sure about still be filed by
   themselves (as today), or must you approve every card first (as the
   sheet says)?**
   Recommended: keep today's way for sure reads, and show unsure ones in
   the approval groups. Reason: with a large collection, approving every
   single card would slow you down a lot.
5. **Folders, storage rows and slots, and a full backup file inside the
   app are left out; the simple "location" field, the CSV export and the
   server backup stay. Agreed?**
   Recommended: yes. Reason: the sheet skips F26, F46 and F47, and what
   exists already covers the everyday need.
