# Test fixtures

## cards/

`griffey-1990-topps-front.jpg` and `griffey-1990-topps-back.jpg` are the
owner's own phone photos of a public, printed 1990 Topps #336 Ken Griffey Jr.
card (photographed from a screen). The owner gave them for testing on
2026-11-16. They were re-encoded with sharp: all photo metadata removed, long
edge at most 1200 pixels.

They are the card the free reader first failed on, kept as a permanent test
(`src/lib/free/griffey.test.ts`). Known limits of these photos: the front is
cropped so the name reads "KEN GRIFFEY, J" and the cap hides part of
"MARINERS"; the back is cropped so the card number (336) is cut off.

`griffey-1990-topps.ocr.json` is the text the real reader returned for both
photos, so parsing tests run fast and exactly. It is still the old reader's
(tesseract.js) text; the parsing rules are tuned on it until task 12R.4.
Record it again with the current reader (needs a Python with rapidocr, see
ocr/README.txt) with:

    UPDATE_OCR=1 OCR_TEST_PYTHON=/path/to/python npx vitest run src/lib/free/ocr.integration.test.ts

## catalog/

Recorded answers of the MyCardfolio catalog (public card data only, see the
`note` in each file), read by `tests/helpers/fake-catalog.ts`. The Griffey
end to end test (`griffey.test.ts`) answers the search "1990 Ken Griffey Jr."
(no brand is read from the photos) with the recorded answer to "1990 Topps
Ken Griffey Jr.". The Wikidata facts for Ken Griffey Jr. in that test are
written by hand, not recorded; tests never call Wikidata.

`versions_*.json` (task 11.2) are the "Show versions" searches for ten cards
with known versions, asked exactly as the app asks (`search_cards`, limit 20,
sport and year set): "year brand number surname", and for two cards also
"year brand full name". Read by `src/lib/catalog/versions.test.ts` and
`version-actions.test.ts` through `recordedSearch(name, 20)`. What they showed
is in `docs/CATALOG-TRIAL.md`, "Version recordings".
