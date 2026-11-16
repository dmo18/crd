import { describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { items } from "@/db/schema";
import { effectiveValueCents, formatCents, parseDollars } from "@/lib/money";
import { buildTitle } from "@/lib/title";
import { recognizedItemSchema } from "@/lib/recognition/types";

describe("database", () => {
  it("creates all tables and stores an item", () => {
    const db = createDb(":memory:");
    const [row] = db.insert(items).values({ kind: "card", title: "x" }).returning().all();
    expect(row.id).toBe(1);
    expect(row.status).toBe("needs_review");
    expect(row.quantity).toBe(1);
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});

describe("titles", () => {
  it("names a card", () => {
    expect(buildTitle({ kind: "card", year: 1989, brand: "Upper Deck", setName: "Upper Deck", cardNumber: "1", player: "Ken Griffey Jr." }))
      .toBe("1989 Upper Deck #1 Ken Griffey Jr.");
  });
  it("names sealed product and bulk lots", () => {
    expect(buildTitle({ kind: "card", description: "x".repeat(80) })).toBe("x".repeat(60));
    expect(buildTitle({ kind: "card", description: "  Mystery box  " })).toBe("Mystery box");
    expect(buildTitle({ kind: "card", description: "  " })).toBe("Unidentified item");
    expect(buildTitle({ kind: "sealed", year: 1990, brand: "Topps", sport: "baseball", productType: "box" })).toBe("1990 Topps baseball box");
    expect(buildTitle({ kind: "bulk", year: 1987, yearEnd: 1991, brand: "Donruss", estCount: 3200 })).toBe("Bulk lot, 1987-1991 Donruss, about 3,200 cards");
    expect(buildTitle({ kind: "card" })).toBe("Unidentified item");
  });
});

describe("money", () => {
  it("formats and parses", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(parseDollars("$1,234.50")).toBe(123450);
    expect(parseDollars("abc")).toBeNull();
    expect(effectiveValueCents({ manualValueCents: 500, estValueCents: 100 })).toBe(500);
    expect(effectiveValueCents({ manualValueCents: null, estValueCents: 100 })).toBe(100);
  });
});

describe("recognition contract", () => {
  it("fills safe defaults and rejects bad data", () => {
    const ok = recognizedItemSchema.parse({ kind: "card", confidence: 0.9, player: "  Bo Jackson " });
    expect(ok.player).toBe("Bo Jackson");
    expect(ok.isRookie).toBe(false);
    expect(ok.pullList).toEqual([]);
    expect(recognizedItemSchema.safeParse({ kind: "card", confidence: 3 }).success).toBe(false);
    expect(recognizedItemSchema.safeParse({ kind: "coin", confidence: 0.5 }).success).toBe(false);
  });
});
