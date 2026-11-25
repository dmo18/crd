import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { FIELDS, markCard, type Answer, type Field, type ReadValues } from "@/lib/free/bench/score";
import { ONE_SIDE_NOTE } from "@/lib/free/multi";
import { FRONT_TWICE, type RecognizedItem } from "@/lib/recognition/types";
import type { LiveSingle } from "./ocr-fixture";

/**
 * What the owner's live scans of 2026-11-25 must give, shared by the replay
 * test (recorded reader text) and the real reader test. Truth is in
 * tests/fixtures/real-cards/answers.json.
 */

type AnswerFile = { cards: { id: string; answer: Answer }[]; scans: { id: string; cards: { answer: Answer }[] }[] };
const answers = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/real-cards/answers.json"), "utf8")) as AnswerFile;

const SINGLE_IDS: Record<LiveSingle, string> = {
  live9: "live9-front-twice", live10: "live10-hardaway", live11: "live11-milacki", live12: "live12-mills",
};

export function values(item: RecognizedItem): ReadValues {
  return { sport: item.sport, year: item.year, brand: item.brand, setName: item.setName, cardNumber: item.cardNumber, player: item.player, team: item.team };
}

function nothingWrong(item: RecognizedItem, answer: Answer, what: string) {
  const read = values(item);
  const marks = markCard(read, answer);
  for (const f of FIELDS) expect(marks[f], `${what} ${f}: ${String(read[f])}`).not.toBe("wrong");
}

function filled(item: RecognizedItem, fields: Field[], what: string) {
  for (const f of fields) expect(item[f], `${what} ${f}`).not.toBeNull();
}

/** The fields each live one card scan must fill (right), and those that must be sure. */
const SINGLE_FILL: Record<LiveSingle, { fill: Field[]; sure: Field[] }> = {
  // The front twice: only what the front shows, nothing sure from the copy.
  live9: { fill: ["player", "brand"], sure: [] },
  live10: { fill: ["player", "year", "brand", "cardNumber", "team"], sure: ["player", "year", "cardNumber"] },
  // The back with a piece of the Mills card at its top: the Milacki card wins.
  live11: { fill: ["player", "year", "brand", "cardNumber", "team"], sure: ["player", "year", "brand", "cardNumber"] },
  live12: { fill: ["player", "year", "brand", "cardNumber"], sure: ["player", "cardNumber"] },
};

export function checkLiveSingle(id: LiveSingle, items: RecognizedItem[]) {
  expect(items).toHaveLength(1);
  const [item] = items;
  const answer = answers.cards.find((c) => c.id === SINGLE_IDS[id])!.answer;
  nothingWrong(item, answer, id);
  filled(item, SINGLE_FILL[id].fill, id);
  for (const f of SINGLE_FILL[id].sure) expect(item.evidence?.certainty?.[f], `${id} ${f} sure`).toBe("sure");
  const twice = item.evidence?.hold?.includes("front_twice") ?? false;
  expect(twice, `${id} front twice`).toBe(id === "live9");
  if (id === "live9") {
    expect(item.notes?.startsWith(FRONT_TWICE)).toBe(true);
    expect(item.evidence?.certainty?.player).not.toBe("sure");
  }
}

/** Owner scan 8: exactly three items, each with its front and its back, nothing wrong, nothing blank. */
export function checkLiveMany(items: RecognizedItem[]) {
  const scan = answers.scans.find((s) => s.id === "live8-many")!;
  expect(items.map((i) => i.player)).toEqual(expect.arrayContaining(["Bob Milacki", "Billy Mills", "Tim Hardaway"]));
  expect(items).toHaveLength(3);
  for (const card of scan.cards) {
    const item = items.find((i) => i.player === card.answer.player)!;
    nothingWrong(item, card.answer, String(card.answer.player));
    expect(item.backPhoto, `${card.answer.player} paired with its back`).toBeDefined();
    expect(item.notes ?? "").not.toContain(ONE_SIDE_NOTE);
    filled(item, ["player", "year", "brand"], String(card.answer.player));
  }
  // The Milacki and Hardaway numbers are on their backs; the Mills back's corner is cut off by the photo's edge.
  expect(items.find((i) => i.player === "Bob Milacki")!.cardNumber).toBe("101");
  expect(items.find((i) => i.player === "Tim Hardaway")!.cardNumber).toBe("65");
}
