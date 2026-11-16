import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { boxOf, createTextReader, LONG_EDGE, MAX_PASSES, readerSettings, sidewaysTurn, textReaderStatus, type OcrEngine, type WorkerRead } from "./ocr";
import { WorkerClient } from "./ocr-worker";

/**
 * The text reader with a fake worker (tests/helpers/fake-ocr-worker.mjs, run
 * by Node): no Python here. The real worker is tested by
 * ocr.integration.test.ts when OCR_TEST_PYTHON is set.
 */

const FAKE = path.join(process.cwd(), "tests", "helpers", "fake-ocr-worker.mjs");
const clients: WorkerClient[] = [];

function fake(mode: string, extra: Partial<ConstructorParameters<typeof WorkerClient>[0]> = {}, state?: string): WorkerClient {
  const c = new WorkerClient({ command: process.execPath, args: [FAKE, mode, ...(state ? [state] : [])], startTimeoutMs: 10_000, jobTimeoutMs: 5_000, ...extra });
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
});

async function photo(width = 700, height = 500): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#f3ecd8" } }).jpeg().toBuffer();
}

describe("text reader over the worker", () => {
  it("turns worker lines into text, confidence and boxes in fractions", async () => {
    const result = await createTextReader(fake("ok")).read(await photo());
    expect(result.passes).toBe(1);
    const size = result.lines.find((l) => l.text.startsWith("size"))!;
    expect(size.text).toBe("size 700x500");
    expect(size.confidence).toBeCloseTo(0.95);
    expect(size.box).toEqual({ x: 0, y: 0, w: 0.5, h: 0.25 });
    expect(size.source).toBe("page");
    for (const l of result.lines) {
      expect(l.box.x + l.box.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(l.box.y + l.box.h).toBeLessThanOrEqual(1 + 1e-9);
    }
    // One letter and very low confidence lines are dropped, as before.
    expect(result.lines.some((l) => l.text === "x" || l.text === "LOW SCORE")).toBe(false);
    expect(result.text.split("\n")).toEqual(result.lines.map((l) => l.text));
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("sends at most LONG_EDGE pixels and never enlarges a small photo", async () => {
    const reader = createTextReader(fake("ok"));
    const big = await reader.read(await photo(3000, 2000));
    expect(big.text).toContain(`size ${LONG_EDGE}x800`);
    const small = await reader.read(await photo(400, 300));
    expect(small.text).toContain("size 400x300");
  });

  it("passes the picture as a private file in a private folder, removed afterwards, with no app secrets and telemetry off", async () => {
    process.env.SESSION_SECRET ??= "test-only-session-secret-0123456789abcdef";
    const client = fake("ok", { threads: 3 });
    const result = await createTextReader(client).read(await photo());
    expect(result.text).toContain("in job folder true file 600 folder 700");
    expect(result.text).toContain("secret absent threads 3 telemetry off");
    const dirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("crd-ocr-"));
    for (const d of dirs) {
      const left = fs.existsSync(path.join(os.tmpdir(), d)) ? fs.readdirSync(path.join(os.tmpdir(), d)) : [];
      expect(left.filter((f) => f.endsWith(".png"))).toEqual([]);
    }
  });

  it("reads one picture at a time, in order", async () => {
    const reader = createTextReader(fake("ok"));
    const results = await Promise.all([300, 320, 340, 360].map(async (w) => reader.read(await photo(w, 200))));
    expect(results.map((r) => r.lines[0].text)).toEqual(["size 300x200", "size 320x200", "size 340x200", "size 360x200"]);
  });

  it("reports waiting, then ready, and down after the worker dies", async () => {
    const client = fake("crash");
    expect(client.status()).toBe("waiting");
    await expect(createTextReader(client).read(await photo())).rejects.toThrow("Could not read text from the photo.");
    expect(client.status()).toBe("down");
    const ok = fake("ok");
    await createTextReader(ok).read(await photo());
    expect(ok.status()).toBe("ready");
  });

  it("starts a fresh worker after one dies", async () => {
    const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crd-fake-")), "state");
    const reader = createTextReader(fake("crashonce", {}, state));
    await expect(reader.read(await photo())).rejects.toThrow();
    const again = await reader.read(await photo());
    expect(again.text).toContain("size 700x500");
    fs.rmSync(path.dirname(state), { recursive: true, force: true });
  });

  it("stops a job that takes too long, and the next job still runs", async () => {
    const slow = fake("slow", { jobTimeoutMs: 300 });
    const started = Date.now();
    await expect(createTextReader(slow).read(await photo())).rejects.toThrow("Could not read text from the photo.");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(slow.status()).toBe("down");
  });

  it("gives up when the worker never gets ready", async () => {
    const client = fake("noready", { startTimeoutMs: 300 });
    await expect(createTextReader(client).read(await photo())).rejects.toThrow();
    expect(client.status()).toBe("down");
  });

  it("fails when the worker program does not exist", async () => {
    const client = new WorkerClient({ command: path.join(os.tmpdir(), "no-such-python-here"), args: [] });
    clients.push(client);
    await expect(createTextReader(client).read(await photo())).rejects.toThrow();
    expect(client.status()).toBe("down");
  });

  it("rejects answers that are not JSON, the wrong shape, or too large", async () => {
    for (const mode of ["garbage", "badshape", "huge"]) {
      await expect(createTextReader(fake(mode)).read(await photo()), mode).rejects.toThrow("Could not read text from the photo.");
    }
  });

  it("a picture the worker cannot read fails that read only", async () => {
    const client = fake("error");
    await expect(createTextReader(client).read(await photo())).rejects.toThrow();
    expect(client.status()).toBe("ready");
  });

  it("does not start the worker for an unreadable photo", async () => {
    const client = fake("ok");
    await expect(createTextReader(client).read(Buffer.from("not a photo"))).rejects.toThrow();
    expect(client.status()).toBe("waiting");
  });

  it("re-reads a sideways photo turned upright and keeps boxes for the upright card", async () => {
    const result = await createTextReader(fake("sideways")).read(await photo(500, 700));
    expect(result.passes).toBe(2);
    expect(result.passes).toBeLessThanOrEqual(MAX_PASSES);
    // The second read got the picture turned to 700 wide, 500 high.
    expect(result.text).toContain("size 700x500");
    expect(result.crops).toBe(0);
  });

  it("reads the four corners of a back again, and nothing more for a quick read", async () => {
    const back = await createTextReader(fake("ok")).read(await photo(), { back: true });
    expect(back.passes).toBe(1);
    expect(back.crops).toBe(4);
    const quick = await createTextReader(fake("sideways")).read(await photo(500, 700), { quick: true, back: true });
    expect(quick.passes).toBe(2);
    expect(quick.crops).toBe(0);
  });

  it("thorough reads skip the sideways re-read", async () => {
    const result = await createTextReader(fake("sideways")).read(await photo(500, 700), { thorough: true });
    expect(result.passes).toBe(1);
    expect(result.text).toContain("BILL RIPKEN");
  });

  it("the shared reader's status does not start a worker", () => {
    expect(["waiting", "ready", "down"]).toContain(textReaderStatus());
  });
});

describe("sidewaysTurn", () => {
  const line = (box: [number, number][], turned: boolean, text = "SOME TEXT") => ({ text, score: 0.9, box, turned });
  const tall: [number, number][] = [[0, 0], [30, 0], [30, 300], [0, 300]];
  const wide: [number, number][] = [[0, 0], [300, 0], [300, 30], [0, 30]];
  const read = (lines: WorkerRead["lines"]): WorkerRead => ({ width: 500, height: 700, lines });

  it("is 0 when most text runs across", () => {
    expect(sidewaysTurn(read([line(wide, false), line(wide, false), line(tall, true)]))).toBe(0);
    expect(sidewaysTurn(read([]))).toBe(0);
  });
  it("turns 90 for text running up the photo, 270 for text running down", () => {
    expect(sidewaysTurn(read([line(tall, true), line(tall, true), line(wide, false, "AB")]))).toBe(90);
    expect(sidewaysTurn(read([line(tall, false), line(tall, false)]))).toBe(270);
  });
  it("ignores a few tall letters", () => {
    expect(sidewaysTurn(read([line(tall, true, "AB")]))).toBe(0);
  });
  it("turns 180 when text runs across but most of it was read turned over (12R.5)", () => {
    expect(sidewaysTurn(read([line(wide, true), line(wide, true), line(wide, false, "AB")]))).toBe(180);
    // Half turned over: not sure, left as it is.
    expect(sidewaysTurn(read([line(wide, true), line(wide, false)]))).toBe(0);
    // Too little text to judge.
    expect(sidewaysTurn(read([line(wide, true, "AB")]))).toBe(0);
  });
});

describe("boxOf", () => {
  it("is the upright box around four corners, inside the picture", () => {
    const b = boxOf([[10, 20], [110, 25], [108, 60], [8, 55]], 200, 100)!;
    expect(b.x).toBeCloseTo(0.04);
    expect(b.y).toBeCloseTo(0.2);
    expect(b.w).toBeCloseTo(0.51);
    expect(b.h).toBeCloseTo(0.4);
    expect(boxOf([[-5, -5], [300, -5], [300, 150], [-5, 150]], 200, 100)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(boxOf([[5, 5], [5, 5], [5, 5], [5, 5]], 200, 100)).toBeNull();
  });
});

describe("readerSettings", () => {
  it("has defaults for the app folder", () => {
    const s = readerSettings({});
    expect(s.python).toBe("python3");
    expect(s.worker).toBe(path.join(process.cwd(), "ocr", "worker.py"));
    expect(s.modelsDir).toBe("");
    expect(s.threads).toBe(4);
  });
  it("takes paths and threads from the settings and refuses bad values", () => {
    const s = readerSettings({ OCR_PYTHON: "/opt/ocr/venv/bin/python", OCR_WORKER: "/app/ocr/worker.py", OCR_MODELS_DIR: "/opt/ocr/models", OCR_THREADS: "2" });
    expect(s).toEqual({ python: "/opt/ocr/venv/bin/python", worker: "/app/ocr/worker.py", modelsDir: "/opt/ocr/models", threads: 2 });
    expect(() => readerSettings({ OCR_THREADS: "64" })).toThrow();
    expect(() => readerSettings({ OCR_PYTHON: "py\0thon" })).toThrow();
  });
});

describe("an engine that throws", () => {
  it("passes the failure to the caller", async () => {
    const broken: OcrEngine = { read: async () => { throw new Error("down"); }, status: () => "down", close: async () => undefined };
    await expect(createTextReader(broken).read(await photo())).rejects.toThrow("down");
  });
});
