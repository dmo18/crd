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
    expect(checkHealth(createDb(":memory:"), dir)).toMatchObject({ ok: true });
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });
  it("fails when the data folder is missing", () => {
    const missing = path.join(os.tmpdir(), "crd-health-missing-" + Date.now());
    expect(checkHealth(createDb(":memory:"), missing)).toMatchObject({ ok: false });
  });
  it("fails when the database is closed or broken", () => {
    const broken = { run() { throw new Error("secret detail"); } } as unknown as Parameters<typeof checkHealth>[0];
    expect(checkHealth(broken, os.tmpdir())).toMatchObject({ ok: false });
  });
  it("writes to disk at most once a minute and reuses the answer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-health-"));
    const db = createDb(":memory:");
    const writes = vi.spyOn(fs, "writeFileSync");
    try {
      const t0 = 1_000_000;
      for (let i = 0; i < 5; i++) expect(checkHealth(db, dir, t0 + i * 1000)).toMatchObject({ ok: true });
      expect(writes).toHaveBeenCalledTimes(1);
      // A folder that disappears is noticed at the next check, within a minute.
      fs.rmSync(dir, { recursive: true });
      expect(checkHealth(db, dir, t0 + 30_000)).toMatchObject({ ok: true });
      expect(checkHealth(db, dir, t0 + WRITE_CHECK_EVERY_MS)).toMatchObject({ ok: false });
      expect(writes).toHaveBeenCalledTimes(2);
    } finally {
      writes.mockRestore();
    }
  });
  it("says whether the text reader is up, in one word, without starting it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-health-"));
    const db = createDb(":memory:");
    expect(checkHealth(db, dir)).toEqual({ ok: true, reader: "waiting" });
    expect(checkHealth(db, dir, Date.now(), () => "ready")).toEqual({ ok: true, reader: "ready" });
    // A reader that is down does not make the app unhealthy; the next scan starts it again.
    expect(checkHealth(db, dir, Date.now(), () => "down")).toEqual({ ok: true, reader: "down" });
    expect(checkHealth(db, dir, Date.now(), () => { throw new Error("secret detail"); })).toEqual({ ok: true, reader: "down" });
    fs.rmSync(dir, { recursive: true });
  });
});
