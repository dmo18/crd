/**
 * Scoring for the reading test bench. Pure functions, no files, no network.
 * Each field of each card is marked right, wrong or blank. Two rates matter:
 * fill rate (how often the reader says something) and wrong rate (how often
 * what it says is wrong). Since 12R.5 round 2 each read field also says
 * whether the reader is sure, and the same two rates are kept for the sure
 * fields alone: sure reads are filed without the owner, so they must be right.
 */

export const FIELDS = ["sport", "year", "brand", "setName", "cardNumber", "player", "team"] as const;
export type Field = (typeof FIELDS)[number];
export type Mark = "right" | "wrong" | "blank";

/** The right answer per field. null means the field should stay blank. */
export type Answer = Record<Field, string | number | null>;
/** What the reader returned per field; anything missing counts as blank. */
export type ReadValues = Partial<Record<Field, string | number | null | undefined>>;
export type CardMarks = Record<Field, Mark>;
export type Certainty = "sure" | "unsure";
/** The reader's certainty per filled field; a field left out is not sure. */
export type ReadCertainty = Partial<Record<Field, Certainty>>;

export type FieldSummary = {
  field: Field;
  cards: number;
  right: number;
  wrong: number;
  blank: number;
  filled: number;
  /** filled / cards, 0 to 1 */
  fillRate: number;
  /** wrong / filled, 0 to 1 (0 when nothing is filled) */
  wrongRate: number;
};

export type Summary = {
  fields: FieldSummary[];
  filled: number;
  wrong: number;
  /** wrong / filled across all fields, 0 to 1 */
  overallWrongRate: number;
};

export type BarResult = { pass: boolean; reasons: string[] };

/** Lowercase, punctuation to spaces, spaces collapsed. */
export function normalizeText(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function isBlank(v: string | number | null | undefined): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function cardNumberText(v: string | number): string {
  return String(v).trim().replace(/^#\s*/, "");
}

export function markField(field: Field, read: string | number | null | undefined, answer: string | number | null): Mark {
  if (isBlank(read)) return answer === null ? "right" : "blank";
  if (answer === null) return "wrong";
  const r = read as string | number;
  switch (field) {
    case "year":
      return Number(r) === Number(answer) ? "right" : "wrong";
    case "cardNumber":
      return cardNumberText(r) === cardNumberText(answer) ? "right" : "wrong";
    case "team": {
      const a = normalizeText(String(answer));
      const x = normalizeText(String(r));
      const nickname = a.split(" ").pop() ?? "";
      return x !== "" && (x === a || x === nickname) ? "right" : "wrong";
    }
    case "setName": {
      // A set read by its first words counts ("Select" for "Select Draft
      // Picks"), and so does a read with more words than the answer.
      const a = normalizeText(String(answer));
      const x = normalizeText(String(r));
      return x !== "" && (x === a || a.startsWith(`${x} `) || x.startsWith(`${a} `)) ? "right" : "wrong";
    }
    default:
      return normalizeText(String(r)) === normalizeText(String(answer)) ? "right" : "wrong";
  }
}

export function markCard(read: ReadValues, answer: Answer): CardMarks {
  const out = {} as CardMarks;
  for (const f of FIELDS) out[f] = markField(f, read[f], answer[f]);
  return out;
}

export function summarize(cards: CardMarks[]): Summary {
  const fields = FIELDS.map((field): FieldSummary => {
    let right = 0;
    let wrong = 0;
    let blank = 0;
    for (const c of cards) {
      if (c[field] === "right") right++;
      else if (c[field] === "wrong") wrong++;
      else blank++;
    }
    const filled = right + wrong;
    return {
      field, cards: cards.length, right, wrong, blank, filled,
      fillRate: cards.length ? filled / cards.length : 0,
      wrongRate: filled ? wrong / filled : 0,
    };
  });
  const filled = fields.reduce((n, f) => n + f.filled, 0);
  const wrong = fields.reduce((n, f) => n + f.wrong, 0);
  return { fields, filled, wrong, overallWrongRate: filled ? wrong / filled : 0 };
}

/**
 * Marks of the sure fields only: a field the reader filled without being
 * sure counts as blank, so the summary of these marks is the "sure fields
 * only" table (fill = sure fields / cards, wrong = wrong among sure fields).
 */
export function sureMarks(marks: CardMarks, certainty: ReadCertainty): CardMarks {
  const out = {} as CardMarks;
  for (const f of FIELDS) out[f] = certainty[f] === "sure" && marks[f] !== "blank" ? marks[f] : "blank";
  return out;
}

/** Cards filed without the owner (confidence at or over the review line), and how many of them had any field wrong. */
export type Filed = { cards: number; filed: number; filedWrong: number };

export function countFiled(cards: { marks: CardMarks; filed: boolean }[]): Filed {
  const filed = cards.filter((c) => c.filed);
  return {
    cards: cards.length,
    filed: filed.length,
    filedWrong: filed.filter((c) => FIELDS.some((f) => c.marks[f] === "wrong")).length,
  };
}

/**
 * The bar (12R.5 round 2), replacing the first one: among sure fields at
 * most 2 in 100 wrong; no card filed on its own has a wrong field; among all
 * filled fields (sure and unsure) at most 8 in 100 wrong; sure fields filled
 * at least: player 70, year 60, brand 60, card number 50 in 100.
 */
export const BAR = {
  maxSureWrongRate: 0.02,
  maxWrongRate: 0.08,
  maxFiledWrong: 0,
  minSureFillRate: { player: 0.7, year: 0.6, brand: 0.6, cardNumber: 0.5 } as Partial<Record<Field, number>>,
};

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

export function checkBar(all: Summary, sure: Summary, filed: Filed): BarResult {
  const reasons: string[] = [];
  if (sure.overallWrongRate > BAR.maxSureWrongRate) {
    reasons.push(`sure wrong rate ${pct(sure.overallWrongRate)} is over ${pct(BAR.maxSureWrongRate)}`);
  }
  if (filed.filedWrong > BAR.maxFiledWrong) {
    reasons.push(`${filed.filedWrong} of ${filed.filed} cards filed on their own have a wrong field`);
  }
  if (all.overallWrongRate > BAR.maxWrongRate) {
    reasons.push(`wrong rate ${pct(all.overallWrongRate)} of all filled fields is over ${pct(BAR.maxWrongRate)}`);
  }
  for (const [field, min] of Object.entries(BAR.minSureFillRate) as [Field, number][]) {
    const rate = sure.fields.find((f) => f.field === field)?.fillRate ?? 0;
    if (rate < min) reasons.push(`${field} sure fill rate ${pct(rate)} is under ${pct(min)}`);
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Many-cards scans: which item the reader made stands for which expected
 * card. Each expected card, in order of the best fit first, takes the unused
 * item with the most right filled fields (at least one, the player or the
 * number among them); a card with no such item is missing. Returns, per
 * expected card, the index of its item or null.
 */
export function matchItems(answers: Answer[], reads: ReadValues[]): (number | null)[] {
  const fit = (a: Answer, r: ReadValues) => {
    const marks = markCard(r, a);
    const key = marks.player === "right" && r.player != null ? 1 : marks.cardNumber === "right" && r.cardNumber != null ? 1 : 0;
    const right = FIELDS.filter((f) => marks[f] === "right" && r[f] != null && r[f] !== "").length;
    return key > 0 ? right : 0;
  };
  const pairs: { a: number; r: number; s: number }[] = [];
  answers.forEach((a, ai) => reads.forEach((r, ri) => {
    const s = fit(a, r);
    if (s > 0) pairs.push({ a: ai, r: ri, s });
  }));
  pairs.sort((x, y) => y.s - x.s || x.a - y.a || x.r - y.r);
  const out: (number | null)[] = answers.map(() => null);
  const used = new Set<number>();
  for (const p of pairs) {
    if (out[p.a] !== null || used.has(p.r)) continue;
    out[p.a] = p.r;
    used.add(p.r);
  }
  return out;
}
