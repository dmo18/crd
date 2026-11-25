// Reading test bench. Run: npm run bench:reading [-- --out result.json]
// Options (src/lib/free/bench/args.ts): --split tune, --card <id>, --show-text.
// Reads real card photos with the free reader and scores each field.
// Fixtures: tests/fixtures/real-cards. More cards: set READING_BENCH_DIR to a
// folder with answers.json (same format) and the photo files.
// OFFLINE: no catalog is given to the reader, the Wikidata lookup is replaced
// by a stub, and fetch is replaced so any network call stops the run.
// READING_BENCH_CACHE=<folder>: keep the reader's text of tuning cards there
// and use it again on the next run (rules work without new reads). Held back
// cards are never cached. Clear the folder after a change to the reader.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { FreeRecognizer } from "../src/lib/free/recognizer";
import { closeTextReader, getTextReader, type OcrResult, type TextReader } from "../src/lib/free/ocr";
import { parseBenchArgs, showsCards, wanted } from "../src/lib/free/bench/args";
import {
  FIELDS, checkBar, countFiled, markCard, matchItems, summarize, sureMarks,
  type Answer, type CardMarks, type Field, type ReadCertainty, type ReadValues, type Summary,
} from "../src/lib/free/bench/score";
import { REVIEW_THRESHOLD, type RecognitionPhoto, type Recognizer } from "../src/lib/recognition/types";

let networkCalls = 0;
globalThis.fetch = (async (input: unknown) => {
  networkCalls++;
  throw new Error(`bench is offline: blocked fetch of ${String(input)}`);
}) as typeof fetch;

const answerValue = z.union([z.string(), z.number(), z.null()]);
const expectedCard = z.object({
  answer: z.object(Object.fromEntries(FIELDS.map((f) => [f, answerValue])) as Record<Field, typeof answerValue>),
  mayBeBlank: z.array(z.enum(FIELDS)).default([]),
});
const answersSchema = z.object({
  // Many-cards scans (owner scan 8): photos in the order sent, the cards they hold.
  scans: z.array(z.object({
    id: z.string().min(1),
    mode: z.literal("multi"),
    photos: z.array(z.string()).min(1).max(12),
    cards: z.array(expectedCard).min(1),
    split: z.enum(["tune", "holdout"]).optional(),
  })).default([]),
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
type BenchScan = { id: string; split: string; dir: string; photos: string[]; answers: Answer[] };

async function loadDir(dir: string): Promise<{ cards: BenchCard[]; scans: BenchScan[] }> {
  const parsed = answersSchema.parse(JSON.parse(await readFile(path.join(dir, "answers.json"), "utf8")));
  return {
    cards: parsed.cards.map((c) => ({
      id: c.id, split: c.split ?? "all", dir, front: c.front, back: c.back,
      answer: c.answer as Answer, mayBeBlank: c.mayBeBlank,
    })),
    scans: parsed.scans.map((s) => ({ id: s.id, split: s.split ?? "all", dir, photos: s.photos, answers: s.cards.map((c) => c.answer as Answer) })),
  };
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

type CardResult = {
  id: string; split: string; read: ReadValues; marks: CardMarks;
  certainty: ReadCertainty; confidence: number; filed: boolean;
};
/** A many-cards scan: items made against cards expected, and items made that stand for no card. */
type ScanResult = { id: string; split: string; made: number; expected: number; missing: number; extra: number; extraFiled: number; seconds: number };

function table(title: string, summary: Summary): string[] {
  const lines = ["", title, "field      fill  wrong  r/x/-"];
  for (const s of summary.fields) {
    lines.push(`${s.field.padEnd(10)} ${pct(s.fillRate).padStart(4)} ${pct(s.wrongRate).padStart(6)}  ${s.right}/${s.wrong}/${s.blank}`);
  }
  lines.push(`overall wrong ${pct(summary.overallWrongRate)} of ${summary.filled} filled`);
  return lines;
}

function section(name: string, results: CardResult[], scans: ScanResult[] = []) {
  const summary = summarize(results.map((r) => r.marks));
  const sure = summarize(results.map((r) => sureMarks(r.marks, r.certainty)));
  const counted = countFiled(results);
  // An item that stands for no card and was filed on its own is a wrongly filed card too.
  const extraFiled = scans.reduce((n, s) => n + s.extraFiled, 0);
  const filed = { ...counted, filed: counted.filed + extraFiled, filedWrong: counted.filedWrong + extraFiled };
  const bar = checkBar(summary, sure, filed);
  const lines: string[] = [`== ${name} (${results.length} cards)`];
  // Held back cards are the honest exam: only their totals are printed.
  // Per card: the marks of all fields, then those of the sure fields only
  // ("?" an unsure filled field), the confidence and "filed" when filed alone.
  if (showsCards(name)) lines.push(`${"".padEnd(14)}${FIELDS.map((f) => LETTER[f]).join("")}  sure`);
  for (const r of showsCards(name) ? results : []) {
    const sureText = FIELDS.map((f) => (r.marks[f] !== "blank" && r.read[f] != null && r.certainty[f] !== "sure" ? "?" : MARK[sureMarks(r.marks, r.certainty)[f]])).join("");
    lines.push(`${r.id.slice(0, 13).padEnd(14)}${FIELDS.map((f) => MARK[r.marks[f]]).join("")}  ${sureText}  ${r.confidence.toFixed(2)}${r.filed ? " filed" : ""}`);
    for (const f of FIELDS) if (r.marks[f] === "wrong") lines.push(`  wrong ${f} (${r.certainty[f] ?? "unsure"}): ${String(r.read[f])}`);
  }
  lines.push(...table("All filled fields (sure and unsure)", summary));
  lines.push(...table("Sure fields only", sure));
  // Cards whose player, year, brand and number are all filled and sure.
  const fullySure = results.filter((r) => (["player", "year", "brand", "cardNumber"] as const).every((f) => r.read[f] != null && r.certainty[f] === "sure")).length;
  lines.push("", `filed automatically: ${filed.filed} of ${filed.cards} cards, ${filed.filedWrong} of them with a wrong field`);
  lines.push(`player, year, brand and number all sure: ${fullySure} of ${results.length} cards`);
  for (const sc of scans) {
    lines.push(`many-cards scan ${showsCards(name) ? sc.id : "(held back)"}: ${sc.made} items made for ${sc.expected} cards, ${sc.missing} cards missing, ${sc.extra} items extra, ${sc.seconds.toFixed(1)} s`);
  }
  lines.push(`BAR: ${bar.pass ? "PASS" : "FAIL"}`);
  for (const why of bar.reasons) lines.push(`  ${why}`);
  return { text: lines.join("\n"), summary, sure, filed, bar, fullySure };
}

function showText(side: string, r: OcrResult | null) {
  console.log(`  -- ${side}${r ? ` (passes ${r.passes ?? "?"}, crops ${r.crops ?? 0})` : ": no read"}`);
  for (const l of r?.lines ?? []) {
    const b = l.box;
    const at = [b.x, b.y, b.w, b.h].map((v) => v.toFixed(2)).join(" ");
    console.log(`  ${at}  ${l.confidence.toFixed(2)} ${(l.source ?? "page").padEnd(6)} ${l.text}`);
  }
}

async function main() {
  const args = parseBenchArgs(process.argv.slice(2));
  const outPath = args.out;

  const dirs = [path.resolve("tests/fixtures/real-cards")];
  if (process.env.READING_BENCH_DIR) dirs.push(path.resolve(process.env.READING_BENCH_DIR));
  const loaded = await Promise.all(dirs.map(loadDir));
  const cards = loaded.flatMap((l) => l.cards).filter((c) => wanted(args, c));
  const scans = loaded.flatMap((l) => l.scans).filter((s) => wanted(args, s));
  if (args.showText && cards.some((c) => !showsCards(c.split))) throw new Error("--show-text is not allowed on held back cards");

  // No catalog, and the player lookup is a stub: nothing leaves this machine.
  const reads: (OcrResult | null)[] = [];
  const base = getTextReader();
  const cacheDir = process.env.READING_BENCH_CACHE ? path.resolve(process.env.READING_BENCH_CACHE) : null;
  if (cacheDir) await mkdir(cacheDir, { recursive: true });
  let cacheable = false;
  const cached = async (image: Buffer, options: Parameters<TextReader["read"]>[1]): Promise<OcrResult | null> => {
    if (!cacheDir || !cacheable) return base.read(image, options).catch(() => null);
    const file = path.join(cacheDir, `${createHash("sha256").update(image).update(JSON.stringify(options ?? {})).digest("hex")}.json`);
    const hit = await readFile(file, "utf8").then((t) => JSON.parse(t) as OcrResult | null).catch(() => undefined);
    if (hit !== undefined) return hit;
    const r = await base.read(image, options).catch(() => null);
    await writeFile(file, JSON.stringify(r));
    return r;
  };
  const reader: TextReader = {
    read: async (image, options) => {
      const r = await cached(image, options);
      reads.push(r);
      if (!r) throw new Error("no read");
      return r;
    },
  };
  const recognizer: Recognizer = new FreeRecognizer({ reader, lookup: async () => null });
  const results: CardResult[] = [];
  for (const c of cards) {
    reads.length = 0;
    cacheable = showsCards(c.split);
    const started = Date.now();
    const photos = [await toPhoto(path.join(c.dir, c.front), "front")];
    if (c.back) photos.push(await toPhoto(path.join(c.dir, c.back), "back"));
    const items = await recognizer.recognize({ mode: "single", photos });
    const item = items.find((i) => i.kind === "card") ?? items[0];
    const read = readValues(item);
    if (args.showText) {
      console.log(`## ${c.id} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
      reads.forEach((r, i) => showText(i === 0 ? "front" : "back", r));
      console.log(`  read: ${JSON.stringify(read)}`);
      console.log(`  certainty: ${JSON.stringify(item?.evidence?.certainty ?? {})} confidence ${item?.confidence ?? 0}`);
      console.log(`  notes: ${item?.notes ?? ""}`);
    }
    const confidence = item?.confidence ?? 0;
    results.push({
      id: c.id, split: c.split, read, marks: markCard(read, c.answer),
      certainty: item?.evidence?.certainty ?? {}, confidence, filed: confidence >= REVIEW_THRESHOLD,
    });
  }
  const scanResults: ScanResult[] = [];
  for (const sc of scans) {
    reads.length = 0;
    cacheable = showsCards(sc.split);
    const started = Date.now();
    // As the scan queue sends them: the stored photos, unchanged.
    const photos: RecognitionPhoto[] = [];
    for (const f of sc.photos) {
      const data = await readFile(path.join(sc.dir, f));
      const meta = await sharp(data).metadata();
      photos.push({ role: "source", data, width: meta.width ?? 0, height: meta.height ?? 0 });
    }
    const items = (await recognizer.recognize({ mode: "multi", photos })).filter((i) => i.kind === "card");
    const seconds = (Date.now() - started) / 1000;
    const values = items.map(readValues);
    const match = matchItems(sc.answers, values);
    sc.answers.forEach((answer, k) => {
      const at = match[k];
      const item = at == null ? undefined : items[at];
      const read = at == null ? {} : values[at];
      const confidence = item?.confidence ?? 0;
      results.push({
        id: `${sc.id}/${k + 1}`, split: sc.split, read, marks: markCard(read, answer),
        certainty: item?.evidence?.certainty ?? {}, confidence, filed: confidence >= REVIEW_THRESHOLD,
      });
    });
    const extras = items.filter((_, i) => !match.includes(i));
    scanResults.push({
      id: sc.id, split: sc.split, made: items.length, expected: sc.answers.length,
      missing: match.filter((m) => m == null).length, extra: extras.length,
      extraFiled: extras.filter((i) => i.confidence >= REVIEW_THRESHOLD).length, seconds,
    });
  }
  await closeTextReader();

  const names = [...new Set([...results.map((r) => r.split), ...scanResults.map((s) => s.split)])];
  const parts = names.map((n) => ({ name: n, ...section(n, results.filter((r) => r.split === n), scanResults.filter((s) => s.split === n)) }));
  console.log(parts.map((p) => p.text).join("\n\n"));
  console.log(`\nnetwork calls: ${networkCalls}`);

  if (outPath) {
    const json = {
      networkCalls,
      cards: results.filter((r) => showsCards(r.split)),
      scans: scanResults.filter((r) => showsCards(r.split)),
      splits: parts.map((p) => ({ name: p.name, summary: p.summary, sure: p.sure, filed: p.filed, bar: p.bar, fullySure: p.fullySure })),
    };
    await writeFile(outPath, JSON.stringify(json, null, 2) + "\n");
  }
  if (networkCalls > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
