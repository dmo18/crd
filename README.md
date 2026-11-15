# Card Vault

Scan sports cards from your phone. The app identifies each card with AI, files
it in a searchable inventory, and estimates what it is worth. It also tracks
sealed packs and boxes and bulk lots.

## Run it on a computer

1. Install Node.js 22 or newer.
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env.local`.
4. Run `npm run secret` and paste the line it prints into `.env.local`.
5. Run `npm run set-password`, choose a password, paste the printed line too.
6. Run `npm run dev` and open http://localhost:3000.

Without an Anthropic API key the app runs in free sample mode: scans return
made-up example cards so you can try every screen. Add `ANTHROPIC_API_KEY` to
`.env.local` for real recognition (billed per scan by Anthropic).

## Checks

`npm run check` runs the linter, type check and tests. `npm run build` makes
the production build.

## Good to know

- Values are AI estimates, not appraisals. Each item links to real sold
  listings so you can confirm before selling or insuring.
- Photos and the database are stored in the `data` folder. Back it up.
