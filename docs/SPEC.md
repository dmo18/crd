# Card Vault: what it does

**Owner:** one person, working from a phone, with a large sports card
collection mostly from about 40 years ago (roughly 1980 to 1995).

## Must haves
1. Scan from the phone camera: one card at a time (front, optional back), or
   one photo holding many cards, or a fast back-to-back queue.
2. The server identifies each card (free text reading, no paid AI): sport, year, brand, set, number, player, team,
   variation, plus rookie, error, parallel, insert, autograph flags.
3. Every item gets a rarity tier and an estimated value range.
4. Three kinds of item:
   - **Card**: a single loose or graded card.
   - **Sealed**: unopened pack, box, case or factory set. Never opened to
     scan; valued as sealed product, with a note on seal state.
   - **Bulk lot**: many loose cards counted as one lot, with a short list of
     cards worth pulling out and scanning on their own.
5. Uncertain scans go to a review queue. Nothing is filed as confirmed without
   either high confidence or the owner's OK.
6. Inventory: search, filter, sort, edit, duplicates as quantity, storage
   location (which box or binder), CSV export.
7. Dashboard: total value, counts, top cards, value over time.

## Value
Your own value, guided by one-tap links to
real sold listings. The owner can type their own value, which wins. A paid
price feed can be plugged in later without redesign.

## Borrowed from existing apps
- CollX: instant photo ID and value, value over time, condition changes the
  price, CSV export.
- Center Stage: confidence score and a human review queue for weak matches.
- Ludex: accuracy first, so front and back photos and a confirm step.
- Gap we fill: sealed product and bulk lots, which those apps do not handle.

## Out of scope for now
Marketplace or selling inside the app, multiple users, native app store apps,
formal grading.

## Decisions by the owner (2026-11-15)
- Prices: sold-listing links plus quick owner entry (owner rule: no API keys,
  free only; no automatic prices).
- Users: owner only, one password.
- Preview: phone-size screenshots in chat, sample data.

## Outside sources (Milestone 10)
The app may call two free outside sources, both without keys: MyCardfolio
(the card catalog) and Wikidata (player facts). Every call goes through one
shared gate (`src/lib/outside/gate.ts`): one call at a time, a pause between
calls, hour and day limits, a short timeout, and a stop when a site asks us
to slow down. The owner can switch each source off; the app then works as
it did before the catalog.

Storage policy (the site's terms say "free for personal and assistant use,
read only, rate limited" and nothing about storing):
- Search and checklist answers are kept only for a bounded time (search
  with results 7 days, search with nothing 1 day, card details and set
  checklists 30 days, 50 MB in total, oldest removed first), only on this
  private server, only to spare the site repeat calls.
- Kept for good: only the cards the owner confirmed, each with its link to
  the source.
- Never: copying the whole catalog, walking sets the owner did not scan or
  search, showing catalog data to anyone else, downloading the site's card
  images (the app links to the card page instead).
- "Clear stored answers" on the Connections screen empties the stored
  answers of a source.
