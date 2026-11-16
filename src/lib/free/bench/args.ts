/**
 * Options of the reading bench (scripts/reading-bench.ts).
 *   --out <file>    write the full result as JSON
 *   --split <name>  run only the cards of that split ("tune", "holdout", or
 *                   "all" for cards without a split, like the owner's cards)
 *   --card <id>     run only that card (one id; may be given more than once)
 *   --show-text     print the reader lines and their positions per card
 * Reader text of held back cards is never printed: --show-text and the
 * per-card lines are refused or left out for the "holdout" split.
 */
export type BenchArgs = {
  out?: string;
  split?: string;
  cards: string[];
  showText: boolean;
};

const SPLIT = /^[a-z0-9_-]{1,32}$/i;

export function parseBenchArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { cards: [], showText: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--out":
        args.out = value(i, a);
        i++;
        break;
      case "--split": {
        const v = value(i, a);
        if (!SPLIT.test(v)) throw new Error(`--split: unknown name ${v}`);
        args.split = v;
        i++;
        break;
      }
      case "--card":
        args.cards.push(value(i, a));
        i++;
        break;
      case "--show-text":
        args.showText = true;
        break;
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  return args;
}

/** True when a card of this split passes the chosen filters. */
export function wanted(args: BenchArgs, card: { id: string; split: string }): boolean {
  if (args.split && card.split !== args.split) return false;
  if (args.cards.length > 0 && !args.cards.includes(card.id)) return false;
  return true;
}

/** Splits whose cards may be shown one by one (all but the held back exam). */
export function showsCards(split: string): boolean {
  return split !== "holdout";
}
