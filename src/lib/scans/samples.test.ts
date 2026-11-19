import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "samples-"));
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({ env: () => ({ DATA_DIR: dir }) }));
});
afterEach(async () => {
  vi.doUnmock("@/lib/env");
  await fs.rm(dir, { recursive: true, force: true });
});

test("keeps what the reader was given, under names made from numbers", async () => {
  const { keepReaderSamples, samplesDir } = await import("./samples");
  await keepReaderSamples(7, [{ role: "front", data: Buffer.from("a") }, { role: "../x", data: Buffer.from("b") }]);
  expect((await fs.readdir(samplesDir())).sort()).toEqual(["scan7-0-front.jpg", "scan7-1-source.jpg"]);
});

test("removes the oldest beyond the limit", async () => {
  const { keepReaderSamples, samplesDir, SAMPLE_LIMIT } = await import("./samples");
  for (let s = 1; s <= SAMPLE_LIMIT + 3; s++) await keepReaderSamples(s, [{ role: "front", data: Buffer.from("a") }]);
  const names = await fs.readdir(samplesDir());
  expect(names.length).toBe(SAMPLE_LIMIT);
  expect(names).not.toContain("scan1-0-front.jpg");
  expect(names).toContain(`scan${SAMPLE_LIMIT + 3}-0-front.jpg`);
});
