/**
 * Scoring for the reading test bench. Pure functions, no files, no network.
 * Each field of each card is marked right, wrong or blank. Two rates matter:
 * fill rate (how often the reader says something) and wrong rate (how often
 * what it says is wrong).
 */

export const FIELDS = ["sport", "year", "brand", "setName", "cardNumber", "player", "team"] as const;
export type Field = (typeof FIELDS)[number];
export type Mark = "right" | "wrong" | "blank";

/** The right answer per field. null means the field should stay blank. */
export type Answer = Record<Field, string | number | null>;
/** What the reader returned per field; anything missing counts as blank. */
export type ReadValues = Partial<Record<Field, string | number | null | undefined>>;
export type CardMarks = Record<Field, Mark>;

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

/** Fill rate minimums (fractions) and the most wrong allowed among filled fields. */
export const BAR = {
  maxWrongRate: 0.02,
  minFillRate: { player: 0.9, year: 0.8, brand: 0.8, cardNumber: 0.7 } as Partial<Record<Field, number>>,
};

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

export function checkBar(summary: Summary): BarResult {
  const reasons: string[] = [];
  if (summary.overallWrongRate > BAR.maxWrongRate) {
    reasons.push(`wrong rate ${pct(summary.overallWrongRate)} is over ${pct(BAR.maxWrongRate)}`);
  }
  for (const [field, min] of Object.entries(BAR.minFillRate) as [Field, number][]) {
    const rate = summary.fields.find((f) => f.field === field)?.fillRate ?? 0;
    if (rate < min) reasons.push(`${field} fill rate ${pct(rate)} is under ${pct(min)}`);
  }
  return { pass: reasons.length === 0, reasons };
}
