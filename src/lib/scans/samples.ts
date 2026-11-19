import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/** How many sample photos are kept. Older ones are removed. */
export const SAMPLE_LIMIT = 200;

export function samplesDir(): string {
  return path.resolve(env().DATA_DIR, "reader-samples");
}

/**
 * Keeps a copy of exactly what the reader was given, so reading can be
 * tested later against real photos. Names are made here from numbers only.
 * Best effort: a failure here never fails a scan.
 */
export async function keepReaderSamples(scanId: number, photos: { role: string; data: Buffer }[]): Promise<void> {
  try {
    const dir = samplesDir();
    await fs.mkdir(dir, { recursive: true });
    for (const [i, p] of photos.entries()) {
      const role = p.role === "front" || p.role === "back" ? p.role : "source";
      await fs.writeFile(path.join(dir, `scan${scanId}-${i}-${role}.jpg`), p.data);
    }
    const names = (await fs.readdir(dir)).filter((n) => /^scan\d+-\d+-(front|back|source)\.jpg$/.test(n));
    if (names.length <= SAMPLE_LIMIT) return;
    const num = (n: string) => Number(n.slice(4, n.indexOf("-")));
    names.sort((a, b) => num(a) - num(b));
    for (const n of names.slice(0, names.length - SAMPLE_LIMIT)) await fs.rm(path.join(dir, n), { force: true });
  } catch {
    // Samples are a convenience only.
  }
}
