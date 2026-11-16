// Reading test bench. Run: npm run bench:reading [-- --out result.json]
// Reads real card photos with the free reader and scores each field.
// Fixtures: tests/fixtures/real-cards. More cards: set READING_BENCH_DIR to a
// folder with answers.json (same format) and the photo files.
// OFFLINE: no catalog is given to the reader, the Wikidata lookup is replaced
// by a stub, and fetch is replaced so any network call stops the run.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { FreeRecognizer } from "../src/lib/free/recognizer";
import { closeTextReader } from "../src/lib/free/ocr";
import {
  FIELDS, checkBar, markCard, summarize,
  type Answer, type CardMarks, type Field, type ReadValues,
} from "../src/lib/free/bench/score";
import type { RecognitionPhoto, Recognizer } from "../src/lib/recognition/types";

let networkCalls = 0;
globalThis.fetch = (async (input: unknown) => {
  networkCalls++;
  throw new Error(`bench is offline: blocked fetch of ${String(input)}`);
}) as typeof fetch;

const answerValue = z.union([z.string(), z.number(), z.null()]);
const answersSchema = z.object({
  cards: z.array(z.object({
    id: z.string().min(1),
    front: z.string(),
    back: z.string().optional(),
    answer: z.object(Object.fromEntries(FIELDS.map((f) => [f, answerValue])) as Record<Field, typeof answerValue>),
    mayBeBlank: z.array(z.enum(FIELDS)).default([]),
    split: z.enum(["tune", "holdout"]).optional(),
  })),
});

type BenchCard = {
  id: string; split: string; dir: string; front: string; back?: string;
  answer: Answer; mayBeBlank: Field[];
};

async function loadDir(dir: string): Promise<BenchCard[]> {
  const parsed = answersSchema.parse(JSON.parse(await readFile(path.join(dir, "answers.json"), "utf8")));
  return parsed.cards.map((c) => ({
    id: c.id, split: c.split ?? "all", dir, front: c.front, back: c.back,
    answer: c.answer as Answer, mayBeBlank: c.mayBeBlank,
  }));
}

async function toPhoto(file: string, role: "front" | "back"): Promise<RecognitionPhoto> {
  const { data, info } = await sharp(await readFile(file)).rotate().jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  return { role, data, width: info.width, height: info.height };
}

function readValues(item: Awaited<ReturnType<Recognizer["recognize"]>>[number] | undefined): ReadValues {
  if (!item) return {};
  return {
    sport: item.sport, year: item.year, brand: item.brand, setName: item.setName,
    cardNumber: item.cardNumber, player: item.player, team: item.team,
  };
}

const MARK = { right: "+", wrong: "x", blank: "-" } as const;
const LETTER: Record<Field, string> = { sport: "S", year: "Y", brand: "B", setName: "E", cardNumber: "N", player: "P", team: "T" };
const pct = (x: number) => `${Math.round(x * 100)}%`;

type CardResult = { id: string; split: string; read: ReadValues; marks: CardMarks };

function section(name: string, results: CardResult[]) {
  const summary = summarize(results.map((r) => r.marks));
  const bar = checkBar(summary);
  const lines: string[] = [`== ${name} (${results.length} cards)`, `${"".padEnd(14)}${FIELDS.map((f) => LETTER[f]).join("")}`];
  for (const r of results) {
    lines.push(`${r.id.slice(0, 13).padEnd(14)}${FIELDS.map((f) => MARK[r.marks[f]]).join("")}`);
    for (const f of FIELDS) if (r.marks[f] === "wrong") lines.push(`  wrong ${f}: ${String(r.read[f])}`);
  }
  lines.push("", "field      fill  wrong  r/x/-");
  for (const s of summary.fields) {
    lines.push(`${s.field.padEnd(10)} ${pct(s.fillRate).padStart(4)} ${pct(s.wrongRate).padStart(6)}  ${s.right}/${s.wrong}/${s.blank}`);
  }
  lines.push(`overall wrong ${pct(summary.overallWrongRate)} of ${summary.filled} filled`, `BAR: ${bar.pass ? "PASS" : "FAIL"}`);
  for (const why of bar.reasons) lines.push(`  ${why}`);
  return { text: lines.join("\n"), summary, bar };
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
  if (outIdx >= 0 && !outPath) throw new Error("--out needs a file path");

  const dirs = [path.resolve("tests/fixtures/real-cards")];
  if (process.env.READING_BENCH_DIR) dirs.push(path.resolve(process.env.READING_BENCH_DIR));
  const cards = (await Promise.all(dirs.map(loadDir))).flat();

  // No catalog, and the player lookup is a stub: nothing leaves this machine.
  const recognizer: Recognizer = new FreeRecognizer({ lookup: async () => null });
  const results: CardResult[] = [];
  for (const c of cards) {
    const photos = [await toPhoto(path.join(c.dir, c.front), "front")];
    if (c.back) photos.push(await toPhoto(path.join(c.dir, c.back), "back"));
    const items = await recognizer.recognize({ mode: "single", photos });
    const read = readValues(items.find((i) => i.kind === "card") ?? items[0]);
    results.push({ id: c.id, split: c.split, read, marks: markCard(read, c.answer) });
  }
  await closeTextReader();

  const names = [...new Set(results.map((r) => r.split))];
  const parts = names.map((n) => ({ name: n, ...section(n, results.filter((r) => r.split === n)) }));
  console.log(parts.map((p) => p.text).join("\n\n"));
  console.log(`\nnetwork calls: ${networkCalls}`);

  if (outPath) {
    const json = {
      networkCalls,
      cards: results,
      splits: parts.map((p) => ({ name: p.name, summary: p.summary, bar: p.bar })),
    };
    await writeFile(outPath, JSON.stringify(json, null, 2) + "\n");
  }
  if (networkCalls > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
