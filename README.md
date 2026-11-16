# Card Vault

**Owner: to set up your server, follow [docs/SERVER.md](docs/SERVER.md).**
The rest of this page is for developers.

Scan sports cards from your phone. The app reads the printed text on each
card, files it in a searchable inventory, and links to real sold prices so
you can record what it is worth. It also tracks
sealed packs and boxes and bulk lots.

## Run it on a computer

1. Install Node.js 22 or newer.
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env.local`.
4. Run `npm run secret` and paste the line it prints into `.env.local`.
5. Run `npm run set-password`, choose a password, paste the printed line too.
6. Run `npm run dev` and open http://localhost:3000.

Cards are read for free on the server: no API keys, no accounts. The app
reads the printed text (RapidOCR, offline on this server), checks a built-in
list of key 1980 to 1995 cards, and confirms players on Wikidata, a free
public database.
Values come from you: each card has one-tap links to real sold listings and a
box to type the price you see. To try the app with made-up cards instead, set
`RECOGNITION_MODE=sample` in `.env.local`.

## Checks

`npm run check` runs the linter, type check and tests. `npm run build` makes
the production build.

## Good to know

- Values are your own entries, guided by real sold listings. They are not
  appraisals.
- Clear, flat, well lit photos without glare read best. Card backs (with
  the copyright line and card number) identify cards most reliably.
- Locally, photos and the database are stored in the `data` folder. On the
  server they live in the app's storage and are backed up by the server
  backup (see docs/SERVER.md).
