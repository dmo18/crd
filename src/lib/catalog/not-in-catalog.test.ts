import { describe, expect, it } from "vitest";
import { filedNotInCatalog, NOT_IN_CATALOG_LINE } from "./candidates";

describe("a filed card the free catalog does not have (review 7)", () => {
  const filed = { kind: "card", status: "confirmed", catalogCardId: null };
  it("shows one calm line, only for a checked card whose search found nothing", () => {
    expect(filedNotInCatalog(filed, { status: "none" })).toBe(true);
    expect(filedNotInCatalog({ ...filed, status: "needs_review" }, { status: "none" })).toBe(false);
    expect(filedNotInCatalog(filed, { status: "candidates" })).toBe(false);
    expect(filedNotInCatalog(filed, { status: "not_checked" })).toBe(false);
    expect(filedNotInCatalog({ ...filed, catalogCardId: 3 }, { status: "none" })).toBe(false);
    expect(filedNotInCatalog({ ...filed, kind: "sealed" }, { status: "none" })).toBe(false);
    expect(filedNotInCatalog(filed, null)).toBe(false);
    expect(NOT_IN_CATALOG_LINE).toBe("The free catalog does not have this card. Your details are kept as read.");
  });
});
