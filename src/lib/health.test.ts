import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/db";
import { checkHealth, resetHealthCache, WRITE_CHECK_EVERY_MS } from "@/lib/health";

beforeEach(() => resetHealthCache());

describe("checkHealth", () => {
  it("is ok with a working database and a writable folder, and leaves no file behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-health-"));
    expect(checkHealth(createDb(":memory:"), dir)).toEqual({ ok: true });
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });
  it("fails when the data folder is missing", () => {
    const missing = path.join(os.tmpdir(), "crd-health-missing-" + Date.now());
    expect(checkHealth(createDb(":memory:"), missing)).toEqual({ ok: false });
  });
  it("fails when the database is closed or broken", () => {
    const broken = { run() { throw new Error("secret detail"); } } as unknown as Parameters<typeof checkHealth>[0];
    expect(checkHealth(broken, os.tmpdir())).toEqual({ ok: false });
  });
  it("writes to disk at most once a minute and reuses the answer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-health-"));
    const db = createDb(":memory:");
    const writes = vi.spyOn(fs, "writeFileSync");
    try {
      const t0 = 1_000_000;
      for (let i = 0; i < 5; i++) expect(checkHealth(db, dir, t0 + i * 1000)).toEqual({ ok: true });
      expect(writes).toHaveBeenCalledTimes(1);
      // A folder that disappears is noticed at the next check, within a minute.
      fs.rmSync(dir, { recursive: true });
      expect(checkHealth(db, dir, t0 + 30_000)).toEqual({ ok: true });
      expect(checkHealth(db, dir, t0 + WRITE_CHECK_EVERY_MS)).toEqual({ ok: false });
      expect(writes).toHaveBeenCalledTimes(2);
    } finally {
      writes.mockRestore();
    }
  });
});
