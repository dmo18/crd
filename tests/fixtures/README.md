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
photos, so parsing tests run fast and exactly. Record it again after a change
to the reader with:

    UPDATE_OCR=1 npx vitest run src/lib/free/ocr.test.ts
