import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { setLogSink } from "@/lib/log";
import { boxOf, createTextReader, LONG_EDGE, MAX_PASSES, readerSettings, sidewaysTurn, textReaderStatus, turnWithTrust, type OcrEngine, type WorkerRead } from "./ocr";
import { ReaderDownError, removeJobFolders, WorkerClient } from "./ocr-worker";

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

describe("a dead reader is told apart from an unreadable picture (12R final review)", () => {
  it("a crash, a time out, a bad answer and a reader that never starts are reader failures", async () => {
    await expect(createTextReader(fake("crash")).read(await photo())).rejects.toBeInstanceOf(ReaderDownError);
    await expect(createTextReader(fake("slow", { jobTimeoutMs: 300 })).read(await photo())).rejects.toBeInstanceOf(ReaderDownError);
    await expect(createTextReader(fake("garbage")).read(await photo())).rejects.toBeInstanceOf(ReaderDownError);
    await expect(createTextReader(fake("noready", { startTimeoutMs: 300 })).read(await photo())).rejects.toBeInstanceOf(ReaderDownError);
  });

  it("a picture the worker could not read is not a reader failure", async () => {
    const err = await createTextReader(fake("error")).read(await photo()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ReaderDownError);
  });

  it("a missing program is a reader failure and is logged by kind and code only", async () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    try {
      const missing = path.join(os.tmpdir(), "no-such-python-here-secret-place");
      const client = new WorkerClient({ command: missing, args: [] });
      clients.push(client);
      await expect(createTextReader(client).read(await photo())).rejects.toBeInstanceOf(ReaderDownError);
      const logged = lines.map((l) => JSON.parse(l)).filter((l) => l.event === "text_reader_start_failed");
      expect(logged.length).toBeGreaterThan(0);
      expect(logged[0]).toMatchObject({ level: "warn", errno: "ENOENT" });
      expect(lines.join("\n")).not.toContain("secret-place");
      expect(lines.join("\n")).not.toContain(os.tmpdir());
    } finally {
      setLogSink();
    }
  });
});

describe("a failed re-read keeps the good first read (12R final review)", () => {
  it("corner re-reads the worker could not read leave the first read standing", async () => {
    const back = await createTextReader(fake("okthenerror")).read(await photo(), { back: true });
    expect(back.text).toContain("size 700x500");
    expect(back.crops).toBe(0);
  });

  it("a reader that dies on a re-read keeps the first read and tries no more re-reads", async () => {
    const client = fake("okthencrash");
    const back = await createTextReader(client).read(await photo(), { back: true });
    expect(back.text).toContain("size 700x500");
    expect(back.crops).toBe(0);
    // No fresh worker was started for the other corners.
    expect(client.status()).toBe("down");
  });

  it("a failed sideways re-read keeps the first read", async () => {
    // The first (sideways) read works, then the reader dies on the upright re-read.
    const engine: OcrEngine = {
      calls: 0,
      async read() {
        this.calls++;
        if (this.calls > 1) throw new ReaderDownError();
        return { width: 500, height: 700, lines: [
          { text: "BILL RIPKEN", score: 0.9, box: [[10, 100], [40, 100], [40, 400], [10, 400]], turned: true },
          { text: "1989 FLEER CORP", score: 0.9, box: [[60, 100], [80, 100], [80, 500], [60, 500]], turned: true },
        ] };
      },
      status: () => "ready",
      close: async () => undefined,
    } as OcrEngine & { calls: number };
    const result = await createTextReader(engine).read(await photo(500, 700));
    expect(result.text).toContain("BILL RIPKEN");
    expect(result.passes).toBe(1);
  });

  it("a dead reader on the first read still fails the read", async () => {
    const engine: OcrEngine = { read: async () => { throw new ReaderDownError(); }, status: () => "down", close: async () => undefined };
    await expect(createTextReader(engine).read(await photo(), { back: true })).rejects.toBeInstanceOf(ReaderDownError);
  });
});

describe("the worker stops when idle (12R final review)", () => {
  it("stops after the idle time with an unref'd timer, shows waiting, and starts again on the next job", async () => {
    const client = fake("ok", { idleMs: 200 });
    const reader = createTextReader(client);
    await reader.read(await photo());
    expect(client.status()).toBe("ready");
    const timer = (client as unknown as { idleTimer: { hasRef(): boolean } | null }).idleTimer;
    expect(timer).not.toBeNull();
    expect(timer!.hasRef()).toBe(false);
    const folder = client.jobFolder()!;
    await new Promise((r) => setTimeout(r, 500));
    expect(client.status()).toBe("waiting");
    expect(client.jobFolder()).toBeNull();
    expect(fs.existsSync(folder)).toBe(false);
    const again = await reader.read(await photo());
    expect(again.text).toContain("size 700x500");
    expect(client.status()).toBe("ready");
  });

  it("idle 0 keeps the worker running", async () => {
    const client = fake("ok", { idleMs: 0 });
    await createTextReader(client).read(await photo());
    expect((client as unknown as { idleTimer: unknown }).idleTimer).toBeNull();
    expect(client.status()).toBe("ready");
  });
});

describe("job folders are not left behind (12R final review)", () => {
  it("a restarted worker removes the folder of the one before", async () => {
    const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crd-fake-")), "state");
    const client = fake("crashonce", {}, state);
    const reader = createTextReader(client);
    await expect(reader.read(await photo())).rejects.toThrow();
    const first = client.jobFolder()!;
    expect(fs.existsSync(first)).toBe(true);
    await reader.read(await photo());
    const second = client.jobFolder()!;
    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(true);
    fs.rmSync(path.dirname(state), { recursive: true, force: true });
  });

  it("folders still on disk are removed when the process exits", async () => {
    const client = fake("ok");
    await createTextReader(client).read(await photo());
    const folder = client.jobFolder()!;
    expect(process.listeners("exit")).toContain(removeJobFolders);
    removeJobFolders();
    expect(fs.existsSync(folder)).toBe(false);
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

describe("turnWithTrust (S1b)", () => {
  const line = (box: [number, number][], turned: boolean, text = "SOME TEXT") => ({ text, score: 0.9, box, turned });
  const tall: [number, number][] = [[0, 0], [30, 0], [30, 300], [0, 300]];
  const wide: [number, number][] = [[0, 0], [300, 0], [300, 30], [0, 30]];
  const read = (lines: WorkerRead["lines"]): WorkerRead => ({ width: 500, height: 700, lines });

  it("trusts a turn when several lines agree", () => {
    expect(turnWithTrust(read([line(tall, true), line(tall, true), line(tall, true)]))).toEqual({ turn: 90, trusted: true });
    expect(turnWithTrust(read([line(wide, true), line(wide, true)]))).toEqual({ turn: 180, trusted: true });
  });
  it("does not trust one long line, or lines that disagree, or too little text", () => {
    expect(turnWithTrust(read([line(tall, true, "A LONG LINE OF TEXT HERE")])).trusted).toBe(false);
    expect(turnWithTrust(read([line(tall, true), line(tall, true), line(tall, false), line(tall, false)])).trusted).toBe(false);
    expect(turnWithTrust(read([line(tall, true, "AB")])).trusted).toBe(false);
  });
  it("reports the card box and the turn on the read, in the photo's own fractions", async () => {
    const engine: OcrEngine = {
      async read() { return read([line(tall, true), line(tall, true)]); },
      status: () => "ready",
      async close() {},
    };
    const result = await createTextReader(engine).read(await photo());
    expect(result.fix).toMatchObject({ turn: 90, turnTrusted: true });
    expect(result.fix!.lines.length).toBeGreaterThan(0);
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
    expect(s.idleMinutes).toBe(10);
  });
  it("takes the idle minutes, 0 meaning never stop", () => {
    expect(readerSettings({ OCR_IDLE_MINUTES: "3" }).idleMinutes).toBe(3);
    expect(readerSettings({ OCR_IDLE_MINUTES: "0" }).idleMinutes).toBe(0);
    expect(() => readerSettings({ OCR_IDLE_MINUTES: "-1" })).toThrow();
  });
  it("takes paths and threads from the settings and refuses bad values", () => {
    const s = readerSettings({ OCR_PYTHON: "/opt/ocr/venv/bin/python", OCR_WORKER: "/app/ocr/worker.py", OCR_MODELS_DIR: "/opt/ocr/models", OCR_THREADS: "2" });
    expect(s).toEqual({ python: "/opt/ocr/venv/bin/python", worker: "/app/ocr/worker.py", modelsDir: "/opt/ocr/models", threads: 2, idleMinutes: 10 });
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

describe("a piece of another card at the photo's edge (owner scan 11)", () => {
  // A white card across the middle of a dark photo, and a piece of another white card at the top edge.
  async function scene(): Promise<Buffer> {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="2000">
      <rect width="100%" height="100%" fill="#202020"/>
      <rect x="420" y="0" width="480" height="260" fill="#f4f4f0"/>
      <rect x="20" y="800" width="860" height="680" fill="#f4f4f0"/>
    </svg>`;
    return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  }
  const at = (text: string, x: number, y: number, w: number, h: number, W: number, H: number) => ({
    text, score: 0.97, turned: false, box: [[x * W, y * H], [(x + w) * W, y * H], [(x + w) * W, (y + h) * H], [x * W, (y + h) * H]] as [number, number][],
  });
  const card: [string, number, number, number, number][] = [
    ["ROBERT", 0.1, 0.42, 0.2, 0.03], ["MILACKI", 0.1, 0.45, 0.2, 0.03], ["101", 0.8, 0.42, 0.08, 0.03],
    ["Born: July 28, 1964", 0.12, 0.5, 0.25, 0.015], ["Home: Lake Havasu Cty., AZ", 0.05, 0.53, 0.3, 0.015],
    ["Orioles top winner in '91", 0.72, 0.5, 0.25, 0.015], ["RECENT MAJOR LEAGUE PERFORMANCE", 0.15, 0.64, 0.4, 0.02],
    ["1991 Orioles 4.01 31 184", 0.1, 0.68, 0.5, 0.015],
  ];
  const piece: [string, number, number, number, number][] = [
    ["president of Billy Mills", 0.75, 0.0, 0.07, 0.11], ["Olympic record", 0.9, 0.02, 0.06, 0.1], ["1964 Tokyo Olympic", 0.85, 0.0, 0.07, 0.12],
  ];

  it("leaves out the lines well clear of the card that fills the photo", async () => {
    const engine: OcrEngine = {
      async read(png) {
        const { width = 1, height = 1 } = await sharp(png).metadata();
        // The whole photo is tall; the card cut out of it is not.
        const whole = height / width > 1.5;
        const lines = whole ? [...card, ...piece] : card.map(([t, x, y, w, h]): [string, number, number, number, number] => [t, x, (y - 0.4) / 0.34, w, h / 0.34]);
        return { width, height, lines: lines.map(([t, x, y, w, h]) => at(t, x, y, w, h, width, height)) };
      },
      status: () => "ready",
      async close() {},
    };
    const result = await createTextReader(engine).read(await scene(), { back: true });
    expect(result.text).toContain("MILACKI");
    expect(result.text).not.toMatch(/Billy|Olympic|Tokyo/);
    expect(result.fix?.cardTrusted).toBe(true);
  });
});
