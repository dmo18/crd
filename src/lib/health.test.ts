import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { checkHealth } from "@/lib/health";

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
});
