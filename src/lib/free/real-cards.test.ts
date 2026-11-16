import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RecognizedItem } from "@/lib/recognition/types";
import { REAL_CARDS, recordedRealCard, type RealCard } from "../../../tests/helpers/ocr-fixture";
import { FIELDS, markCard, type Answer, type ReadValues } from "./bench/score";
import type { OcrResult } from "./ocr";
import { parseCardText } from "./parse";
import { FreeRecognizer } from "./recognizer";

/**
 * The owner's four real cards, from the text the RapidOCR reader recorded
 * (tests/fixtures/real-cards/<card>.ocr.json; record again with UPDATE_OCR=1,
 * see ocr.integration.test.ts). No Python and no network: the recognizer gets
 * the recorded text, no catalog and no Wikidata.
 *
 * Bar (12R): no field filled wrong. Expected fills: player, year and brand on
 * all four; the number on Hardaway, Milacki and Mills (Griffey's is cut out
 * of the photo and must stay blank).
 */

type AnswerFile = { cards: { id: RealCard; answer: Answer; mayBeBlank: string[] }[] };
const answers = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/real-cards/answers.json"), "utf8")) as AnswerFile;

async function recognize(front: OcrResult | null, back: OcrResult | null): Promise<RecognizedItem> {
  const r = new FreeRecognizer({
    reader: { read: async (image: Buffer) => (image[0] === 1 ? front : back) ?? { text: "", lines: [], confidence: 0 } },
    lookup: async () => null,
  });
  const photos = [{ role: "front" as const, data: Buffer.from([1]), width: 1, height: 1 }];
  if (back) photos.push({ role: "back" as const, data: Buffer.from([2]), width: 1, height: 1 } as never);
  const [item] = await r.recognize({ mode: "single", photos });
  return item;
}

function values(item: RecognizedItem): ReadValues {
  return { sport: item.sport, year: item.year, brand: item.brand, setName: item.setName, cardNumber: item.cardNumber, player: item.player, team: item.team };
}

const FILLED: Record<RealCard, (typeof FIELDS)[number][]> = {
  griffey: ["player", "year", "brand"],
  hardaway: ["player", "year", "brand", "cardNumber"],
  milacki: ["player", "year", "brand", "cardNumber"],
  mills: ["player", "year", "brand", "cardNumber"],
};

describe("the owner's four cards, from the recorded reader text", () => {
  for (const id of REAL_CARDS) {
    it(`${id}: no field wrong, and the expected fields filled`, async () => {
      const { front, back } = recordedRealCard(id);
      const card = answers.cards.find((c) => c.id === id)!;
      const read = values(await recognize(front, back));
      const marks = markCard(read, card.answer);
      for (const f of FIELDS) expect(marks[f], `${id} ${f}: ${String(read[f])}`).not.toBe("wrong");
      for (const f of FILLED[id]) expect(marks[f], `${id} ${f}`).toBe("right");
    });
  }

  it("Griffey's number, cut out of the photo, stays blank", async () => {
    const { front, back } = recordedRealCard("griffey");
    expect((await recognize(front, back)).cardNumber).toBeNull();
  });

  it("Milacki: the copyright year and the stat table give 1992 even without the front's set year", async () => {
    const { front, back } = recordedRealCard("milacki");
    const noBand = { ...front, lines: front.lines.filter((l) => l.source !== "band") };
    const p = parseCardText(noBand, back);
    expect(p.year).toBe(1992);
    expect(p.brand).toBe("Donruss");
  });

  it("Milacki and Mills: the back's dates and 'Signed by Orioles' give no serial and no autograph", () => {
    for (const id of ["milacki", "mills"] as const) {
      const { front, back } = recordedRealCard(id);
      const p = parseCardText(front, back);
      expect(p.serialRead, id).toBeNull();
      expect(p.isAutograph, id).toBe(false);
    }
  });

  it("each side alone never names someone else (the back may give the full name: ROBERT for BOB)", async () => {
    for (const id of REAL_CARDS) {
      const { front, back } = recordedRealCard(id);
      const card = answers.cards.find((c) => c.id === id)!;
      const surname = String(card.answer.player).replace(/ (?:Jr|Sr)\.$/, "").split(" ").pop()!;
      const fromFront = parseCardText(front, null).player;
      if (fromFront) expect(markCard({ player: fromFront }, card.answer).player, `${id} front: ${fromFront}`).toBe("right");
      const fromBack = parseCardText(null, back).player;
      if (fromBack) expect(fromBack, `${id} back`).toContain(surname);
    }
  });

  it("confidence counts agreeing signs: Milacki (front and back agree on name, year and brand) is surer than Hardaway", async () => {
    const m = recordedRealCard("milacki");
    const h = recordedRealCard("hardaway");
    const milacki = await recognize(m.front, m.back);
    const hardaway = await recognize(h.front, h.back);
    expect(milacki.confidence).toBeGreaterThan(hardaway.confidence);
    expect(milacki.confidence).toBeLessThanOrEqual(0.8);
  });
});
