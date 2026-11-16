import fs from "node:fs";
import path from "node:path";
import { parseChecklist, parseSearch } from "@/lib/catalog/mycardfolio";
import type { Catalog, CatalogCard, CatalogFailure, CatalogResult } from "@/lib/catalog/types";

/**
 * A catalog for tests built from the recorded answers in
 * tests/fixtures/catalog. Never touches the network. Any search it has no
 * recording for answers nothing, as the site does for a wrong word.
 */

function body(name: string): string {
  return JSON.stringify(JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/catalog", name), "utf8")).response);
}
export function recordedSearch(name: string, limit = 10): CatalogCard[] {
  const v = parseSearch(body(name), limit);
  if (!v) throw new Error(name);
  return v;
}
const checklist = parseChecklist(body("checklist_9179_first500.json"), "9179");
if (!checklist) throw new Error("checklist");

export const GRIFFEY_SEARCH = recordedSearch("search_1990_topps_griffey.json");
export const RECORDED: Record<string, CatalogCard[]> = {
  "1990 topps ken griffey jr.": GRIFFEY_SEARCH,
  "1990 topps griffey": GRIFFEY_SEARCH,
  "1990 topps 1": recordedSearch("search_1990_topps_1.json"),
  "1990 topps 336": GRIFFEY_SEARCH,
};

export class FakeCatalog implements Catalog {
  calls: string[] = [];
  lines: string[] = [];
  constructor(private readonly opts: { fail?: CatalogFailure; searches?: Record<string, CatalogCard[]>; throws?: boolean } = {}) {}
  private answer<T>(value: T): CatalogResult<T> {
    if (this.opts.throws) throw new Error("catalog broke");
    return this.opts.fail ? { ok: false, reason: this.opts.fail } : { ok: true, value, fromStore: false };
  }
  async search(q: { text: string }, line: string) {
    this.calls.push(`search:${q.text}`);
    this.lines.push(line);
    return this.answer((this.opts.searches ?? RECORDED)[q.text.toLowerCase()] ?? []);
  }
  async card(sourceId: string, line: string) {
    this.calls.push(`card:${sourceId}`);
    this.lines.push(line);
    return this.answer(null);
  }
  async checklist(sourceSetId: string, line: string) {
    this.calls.push(`checklist:${sourceSetId}`);
    this.lines.push(line);
    return this.answer(sourceSetId === "9179" ? checklist! : { cards: [], complete: false });
  }
}
