# Catalog trial: MyCardfolio

Date: 2026-11-16. This is the trial for Milestone 10, task 1. Nothing in the app was changed. Only this file and the recorded answers in `tests/fixtures/catalog/` were added.

## Verdict: GO, with conditions

Use MyCardfolio as the catalog for baseball and football cards, and as a weaker helper for basketball and hockey. Do not rely on it to forgive misspellings: it does not. The app must do its own fuzzy matching.

Reasons:
- Exact text search finds the right card (right number) in the top 5 for 26 of 31 cards (84 percent). For baseball and football, the clean (non-eBay) entry was found for 19 of 21 cards (90 percent).
- Basketball and hockey are almost all eBay noise entries. No clean entry was found for any of the 6 basketball or 4 hockey cards. The right card turned up only as a noise entry in 6 of those 10 cases.
- Damaged queries (first name dropped, one wrong letter) found nothing: 0 of 31. The search needs every word to match exactly. The "identify" tool did no better (0 of 8). So the app must fix names itself before asking.
- It is fast: median 216 ms over 98 calls, usually under half a second. A few slow calls (up to 4.3 seconds).
- No key, no errors, no rate limit answers seen in about 110 calls at one call per 2 seconds.
- Terms are thin (see below), so the plan in the roadmap stands: look up live, keep only cards the owner touched, ask the site by message before storing checklists.

Conditions for the build (task 4 and the shared gate in task 3):
1. The client must clean the query: try the full text, then year and brand and surname only, then year and brand and number. Plan a local fuzzy step (for example, fetch the set checklist with `get_set_checklist` for the year and brand, then match the surname by edit distance on the phone side). Ask the site first whether keeping a checklist for a short time is fine.
2. Drop or demote ids starting `ebay_` and `ing_`. Prefer all-digit ids.
3. Basketball and hockey: show the candidates but mark them "unverified", or use another source later.
4. Keep the catalog behind one interface so it can be swapped.

## Important correction to the roadmap

The address `https://mycardfolio.com/mcp` is only a web page that describes the service. A POST there answers 405 (Method Not Allowed). The real endpoint is **`https://mycardfolio.com/api/mcp`** (found on that page). Plain JSON-RPC POSTs work there with no library. Send these headers: `Content-Type: application/json` and `Accept: application/json, text/event-stream`. The answer comes back as a server-sent event: a line `event: message` and a line `data: {...json...}`. Inside, `result.content[0].text` is a second JSON string that must be parsed again. The `initialize` call is not needed before `tools/call` (all calls were stateless, no session id), though I did run it once.

## Method

- Calls made from a small Python script with the User-Agent `CardVault-trial/1.0`, one call every 2.1 seconds or slower, no personal details. About 110 calls in total (budget was about 120): 6 to find the endpoint and terms page, 2 for initialize and tools list, 62 searches for the main test, 36 for follow-up checks (identify, card, variants), 3 extra probes, 1 first look.
- 31 cards: 30 from `src/lib/free/key-cards.ts` plus the 1990 Topps Ken Griffey Jr. #336. Mix: 15 baseball (including the Bill Ripken 1989 Fleer rude-bat-knob error, the Dale Murphy 1989 Upper Deck reversed negative, the Frank Thomas 1990 Topps #414 and a Traded "11T" number), 6 basketball, 5 football, 4 hockey, plus Griffey. Years 1980 to 1995.
- Exact query: "year brand full player name" (for example "1980 Topps Rickey Henderson"), `limit` 5.
- Damaged query: year and brand, first name dropped, one letter of the surname changed (first letter or a middle letter, for example "1990 Topps Eriffey").
- A hit means: within the top 5, the card number equals the key list number, the year matches, the product name matches the brand, and the surname is among the subjects. "Clean" means the hit has an id that is not `ebay_` or `ing_`.
- Then `get_card` and `find_variants` on 10 cards that were found, `identify_card` on 8 damaged and 6 exact texts.

## Tools (7)

| Tool | Inputs |
|---|---|
| `search_cards` | `query` (text, at least 2 characters, required), `sport`, `year` (both text), `limit` (1 to 50, default 20) |
| `get_card` | `card_id` (required) |
| `get_set_checklist` | `set_id` (required) |
| `browse` | `sport`, `year` (needs sport), `product_id`, all optional |
| `find_variants` | `card_id` (required) |
| `identify_card` | `description` (text, at least 3 characters, required) |
| `card_of_the_day` | none |

Not tested: `get_set_checklist`, `browse`, `card_of_the_day` (kept the call count down).

## Results

Columns: exact text finds the right card in the top 5; damaged text finds it; milliseconds for the exact search and the damaged search.

| Card | Exact hit | Damaged hit | ms (exact / damaged) |
|---|---|---|---|
| 1980 Topps Rickey Henderson #482 (baseball) | yes (rank 1, clean entry) | no | 715 / 139 |
| 1982 Topps Cal Ripken Jr. #21 (baseball) | yes (rank 1, noise entry only) | no | 1250 / 235 |
| 1983 Fleer Tony Gwynn #360 (baseball) | yes (rank 1, clean entry) | no | 377 / 252 |
| 1984 Donruss Don Mattingly #248 (baseball) | yes (rank 1, clean entry) | no | 404 / 261 |
| 1985 Topps Kirby Puckett #536 (baseball) | yes (rank 1, clean entry) | no | 199 / 160 |
| 1986 Donruss Jose Canseco #39 (baseball) | yes (rank 1, clean entry) | no | 215 / 237 |
| 1987 Topps Barry Bonds #320 (baseball) | yes (rank 1, clean entry) | no | 604 / 194 |
| 1987 Donruss Greg Maddux #36 (baseball) | yes (rank 1, clean entry) | no | 605 / 265 |
| 1989 Upper Deck Ken Griffey Jr. #1 (baseball) | yes (rank 1, clean entry) | no | 1943 / 174 |
| 1989 Upper Deck Dale Murphy #357 (baseball) | yes (rank 1, clean entry) | no | 310 / 166 |
| 1989 Fleer Bill Ripken #616 (baseball) | yes (rank 2, clean entry) | no | 200 / 147 |
| 1990 Topps Frank Thomas #414 (baseball) | yes (rank 1, clean entry) | no | 454 / 153 |
| 1993 Topps Derek Jeter #98 (baseball) | yes (rank 1, clean entry) | no | 756 / 194 |
| 1992 Bowman Mariano Rivera #302 (baseball) | yes (rank 1, clean entry) | no | 267 / 147 |
| 1986 Topps Barry Bonds #11T (baseball) | yes (rank 1, clean entry) | no | 462 / 148 |
| 1984 Star Michael Jordan #101 (basketball) | no | no | 317 / 138 |
| 1986 Fleer Michael Jordan #57 (basketball) | yes (rank 3, noise entry only) | no | 358 / 253 |
| 1986 Fleer Charles Barkley #7 (basketball) | yes (rank 1, noise entry only) | no | 272 / 158 |
| 1988 Fleer Scottie Pippen #20 (basketball) | yes (rank 1, noise entry only) | no | 167 / 170 |
| 1992 Upper Deck Shaquille O'Neal #1 (basketball) | yes (rank 2, noise entry only) | no | 464 / 259 |
| 1989 NBA Hoops David Robinson #138 (basketball) | yes (rank 1, noise entry only) | no | 184 / 155 |
| 1984 Topps Dan Marino #123 (football) | yes (rank 1, clean entry) | no | 300 / 192 |
| 1986 Topps Jerry Rice #161 (football) | yes (rank 1, clean entry) | no | 354 / 152 |
| 1989 Score Barry Sanders #257 (football) | yes (rank 1, clean entry) | no | 214 / 159 |
| 1990 Topps Emmitt Smith #27T (football) | yes (rank 1, clean entry) | no | 216 / 173 |
| 1991 Topps Brett Favre #94 (football) | no | no | 492 / 252 |
| 1980 O-Pee-Chee Wayne Gretzky #250 (hockey) | no | no | 268 / 159 |
| 1985 O-Pee-Chee Mario Lemieux #9 (hockey) | yes (rank 1, noise entry only) | no | 185 / 184 |
| 1986 O-Pee-Chee Patrick Roy #53 (hockey) | no | no | 233 / 161 |
| 1990 Upper Deck Jaromir Jagr #356 (hockey) | no | no | 513 / 217 |
| 1990 Topps Ken Griffey Jr. #336 (baseball) | yes (rank 1, clean entry) | no | 1943 / 148 |

## Hit rates

- Exact text, any entry (clean or noise): 26 of 31 (84 percent). First place: 23 of 31.
- Exact text, clean entry only: 19 of 31 (61 percent). By sport: baseball 15 of 16, football 4 of 5, basketball 0 of 6, hockey 0 of 4.
- Damaged text with `search_cards`: 0 of 31. With `identify_card`: 0 of 8 tried.
- Even a partly shortened query works if every word is right: "1990 Topps Griffey" (no first name) found #336 in the top 3, so dropping the first name is fine. A single wrong letter is what kills it.

Why the 5 exact misses: 1984 Star Jordan (only a different card, #195, came back, so the number was wrong), and 1991 Topps Favre, 1980 O-Pee-Chee Gretzky, 1986 O-Pee-Chee Roy, 1990 Upper Deck Jagr came back with zero cards. Probes with only year and surname ("1980 Gretzky", "1990 Jagr", "1991 Favre") returned many cards, all noise entries and none the card asked for (for example no 1980 O-Pee-Chee #250). So the brand word did not match how the site names those products, and the clean sets for these are probably missing. Brand spelling also varies: "O-PEE-CHEE", "FLEER", "Fleer Sticker".

## Speed

- Median over all 98 calls: 216 ms. Worst: 4,257 ms (`find_variants` for 1984 Topps Dan Marino). Next worst 2,545 ms (variants) and 1,943 ms (two searches).
- `search_cards`: median 354 ms for exact queries (empty answers were quicker, about 150 to 250 ms).
- `get_card`: median 152 ms. `find_variants`: median 583 ms, with a slow tail.
- Plan the app for a 5 second timeout and show a spinner.

## Griffey 1990 Topps #336

Found. The exact query "1990 Topps Ken Griffey Jr." gave two eBay noise entries first, then the clean base card `551033` (Topps, set "Base Set", number 336) at rank 3. Rank 4 of `identify_card` for "1990 Topps Ken Griffey Jr #336" was the Tiffany card `551885`. `find_variants` for `551033` returns one variant, an eBay entry marked "Rookie Card, Error Card, Bloody Arm Scar". The damaged query "1990 Topps Eriffey" found nothing. Time: 1,943 ms for the exact search (slowest of the main run, a one-off).

## Noise

- Of 86 search results seen in the main run: 48 had ids starting `ebay_`, 4 started `ing_`, 34 were clean all-digit ids. So over half of what comes back is noise.
- Noise entries come first often (an eBay entry ranked ahead of the clean card in many searches, as with Griffey).
- Noise has messy values: product "Baseball" or "Rookie Card" or "Sports Stars USA", set text such as "Ken Griffey Jr #336 SGC 8 HOF" or "1986 Fleer Michael Jordan Rookie Card", number "616a", "1b", "1B", "6m7", "0p6", names in capitals ("MICHAEL JORDAN"). Some noise is wrong for the search (a 1984 Star Jordan #195, a 1991 Favre "Upper Deck" with number 13).
- A few clean entries are also messy: name "DAN MARINO IR", "FRANK THOMAS NO NAME ON FRONT", "Emmitt Smith RC", "DALE MURPHY TC", "BILL RIPKEN BLACKBOX" (the last is a Fleer Glossy entry), and one card number "or" for a Dale Murphy entry.
- Rule for the client: keep clean ids first, then noise only if no clean card matches, and flag it.

## Field formats

- Every card has: `card_id` (text), `sport` (capitalised: "Baseball"), `year` (text, "1990"; for winter sports and basketball it is the first year, "1986" for 1986 to 87 on clean entries, but some noise uses "1986-87" in the set field), `product` (the brand or line: "Topps", "Topps Tiffany", "Upper Deck"), `set` ("Base Set" for clean entries, free text for noise), `card_number` (text as printed: "336", "11T", "27T"; Traded numbers keep the "T"), `subjects` (a list of name and team), `card_details`, `url` (a mycardfolio.com page, cite it), `image_url`.
- Player names carry the full name with a period for Jr. ("Ken Griffey Jr."); noise often drops the period ("Ken Griffey Jr").
- `team_name` is empty on every clean entry. It was filled on only 19 of 87 subjects, all on noise entries ("San Francisco 49ers"). So team is not reliably available.
- Rookie flag: there is no yes or no field. It shows only as the words "RC" or "Rookie Card" inside `card_details`, and only on noise entries. Clean entries have `card_details` empty. 1990 Topps Griffey base `551033` has no rookie mark. The app must keep its own rookie list (key-cards.ts) and not trust the catalog for this.
- `get_card` returns `card`, `set` (id, name, url) and `related_cards` (about 10 other cards of the same set).
- `find_variants` returns `card`, `variant_count` and `variants`. Counts seen: 0 for Mattingly 1984 Donruss, 1 for Griffey and Rice; the other cards were not counted here. Variants in the answers were mostly eBay entries.
- Not found: `get_card` with a bad id answers plainly "No card found with card_id ..." with status 200, not an error code.
- `identify_card` returns `parsed` (year, card number, search_query, ignored_tokens), `confidence` text and `matches`. It simply runs the same search and gave the same results as search for the exact text, but with Tiffany variants mixed in. Empty answer reads "low: no matches found".

## Limits seen

- No error status, no 429, no rate limit header in about 110 calls at 1 call per 2 seconds. I did not test faster calls on purpose. The limit number is still unknown.
- No quota header and no retry hint were returned. Cloudflare sits in front (a cookie is set, ignore it).
- Every call is independent (no session). Result `limit` up to 50.
- The page cache headers on the info page say nothing about the data.

## Terms summary

From the MCP info page (https://mycardfolio.com/mcp), the only terms found: "read-only, no authentication, rate limited". "The server is free for personal and assistant use. Questions or heavy-usage needs? Reach out via X / Twitter." There is a privacy policy link (not read; it is about site visitors). Nothing says whether results may be stored. Card pages must be linked back (the server instructions say to cite the canonical URLs). So: personal use fits Card Vault, store only cards the owner touched with the source link, and ask the site (on X) before storing set checklists or anything bigger.

## Recorded answers (for tests)

In `tests/fixtures/catalog/`, as returned by the server, wrapped with the tool name, arguments and time:
- `search_1990_topps_griffey.json`: search with noise first, clean card at rank 3.
- `search_1986_fleer_jordan_noisy.json`: a search where every hit is noise or the wrong card.
- `card_551033.json`: card detail for the clean 1990 Topps Griffey.
- `variants_551033.json`: its variants answer.
- `identify_card_griffey.json`: identify answer including Tiffany.
Only public card data. No headers, cookies or tokens are stored.

## Open points for the next tasks

- Ask the site by message about storing checklists (needed before F05).
- Decide the fuzzy step (see condition 1) in task 4 and test it against these 31 queries.
- Check `get_set_checklist` and `browse` size and speed before relying on them.
- Check why the O-Pee-Chee, Stadium Club and Upper Deck hockey sets gave nothing (brand spelling or missing data).
