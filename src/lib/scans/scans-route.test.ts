import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDbForTests } from "@/db";
import { items, scans } from "@/db/schema";
import { getScanView } from "@/lib/scans/view";

// Real guard unless a test signs in. Outside a request there is no cookie store, so the real guard answers 401.
const signedIn = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/auth/guard", async (orig) => {
  const real = await orig<typeof import("@/lib/auth/guard")>();
  return { ...real, guardApi: (r: Request) => (signedIn.value ? Promise.resolve(null) : real.guardApi(r)) };
});
// Keep the background reader out of these tests.
vi.mock("@/lib/scans/process", async (orig) => ({ ...(await orig<typeof import("@/lib/scans/process")>()), enqueueScan: vi.fn(), recoverScans: vi.fn() }));

const { POST } = await import("@/app/api/scans/route");
const { GET: STATUS } = await import("@/app/api/scans/status/route");
const { enqueueScan } = await import("@/lib/scans/process");

const KEY = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const jpeg = () => sharp({ create: { width: 600, height: 800, channels: 3, background: "#224466" } }).jpeg().toBuffer();

async function send(fields: Record<string, string>) {
  const form = new FormData();
  form.set("mode", "single");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("front", new File([new Uint8Array(await jpeg())], "a.jpg", { type: "image/jpeg" }));
  return POST(new Request("http://localhost/api/scans", { method: "POST", body: form }));
}

let db: ReturnType<typeof createDb>;
beforeEach(() => {
  signedIn.value = true;
  db = createDb(":memory:");
  setDbForTests(db);
  vi.mocked(enqueueScan).mockClear();
});

describe("POST /api/scans clientKey", () => {
  it("same key twice: 201 then 200, same scanId, one scan, queued once", async () => {
    const a = await send({ clientKey: KEY });
    const b = await send({ clientKey: KEY });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect((await b.json()).scanId).toBe((await a.json()).scanId);
    expect(db.select().from(scans).all()).toHaveLength(1);
    expect(enqueueScan).toHaveBeenCalledTimes(1);
  });

  it("works without a key", async () => {
    expect((await send({})).status).toBe(201);
    expect((await send({})).status).toBe(201);
    expect(db.select().from(scans).all()).toHaveLength(2);
  });

  it("a bad key is a 400 and saves nothing", async () => {
    for (const clientKey of ["nope", "123", "6f9619ff-8b86-4011-b42d-00c04fc964f"]) {
      expect((await send({ clientKey })).status).toBe(400);
    }
    expect(db.select().from(scans).all()).toHaveLength(0);
  });

  it("a blank key counts as no key", async () => {
    expect((await send({ clientKey: "  " })).status).toBe(201);
  });

  it("needs the owner session", async () => {
    signedIn.value = false;
    expect((await send({ clientKey: KEY })).status).toBe(401);
    expect(db.select().from(scans).all()).toHaveLength(0);
  });
});

describe("GET /api/scans/status", () => {
  it("needs the owner session", async () => {
    signedIn.value = false;
    expect((await STATUS(new Request("http://localhost/api/scans/status"))).status).toBe(401);
  });

  it("returns the counts, uncached", async () => {
    db.insert(scans).values([{ mode: "single", status: "queued" }, { mode: "single", status: "failed" }]).run();
    const res = await STATUS(new Request("http://localhost/api/scans/status"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ reading: 1, failed: 1, toReview: 0 });
  });
});

describe("GET /api/scans/status?ids=", () => {
  const ask = (q: string) => STATUS(new Request(`http://localhost/api/scans/status?ids=${q}`));

  it("needs the owner session", async () => {
    signedIn.value = false;
    expect((await ask("1,2")).status).toBe(401);
  });

  it("refuses a bad list with a short message", async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1).join(",");
    for (const q of ["", "a", "0", "-1", "1.5", "1,,2", "1,x", "99999999999", tooMany]) {
      const res = await ask(q);
      expect(res.status, q).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Bad list of scans." });
    }
  });

  it("returns the counts and each scan's progress, uncached, repeats removed, unknown ids left out", async () => {
    const [a, b] = db.insert(scans).values([{ mode: "single", status: "queued" }, { mode: "multi", status: "done", itemCount: 1 }]).returning({ id: scans.id }).all();
    db.insert(items).values({ scanId: b!.id, kind: "card", status: "needs_review", title: "1990 Topps Ken Griffey Jr." }).run();
    const res = await ask(`${b!.id},${a!.id},${b!.id},999`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ reading: 1, failed: 0, toReview: 1 });
    expect(body.scans).toHaveLength(2);
    expect(body.scans[0]).toMatchObject({ id: a!.id, status: "queued", queuePosition: 1, items: [] });
    expect(body.scans[1]).toMatchObject({ id: b!.id, status: "done", items: [{ status: "needs_review", title: "1990 Topps Ken Griffey Jr." }] });
    // Same answer as the one scan route gives.
    expect(body.scans[1]).toEqual({ ...getScanView(b!.id, db), serverTime: body.scans[1].serverTime });
  });

  it("100 ids is allowed", async () => {
    expect((await ask(Array.from({ length: 100 }, (_, i) => i + 1).join(","))).status).toBe(200);
  });
});
