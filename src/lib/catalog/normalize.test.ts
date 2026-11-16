import { describe, expect, it } from "vitest";
import * as old from "@/lib/free/key-cards";
import { normalizeBrand, normalizeCardNumber, normalizeName, normalizeText, printedCardNumber } from "./normalize";

describe("catalog normalize", () => {
  it("gives the same keys as before the move", () => {
    expect(normalizeBrand("O-Pee-Chee")).toBe("opeechee");
    expect(normalizeBrand(" upper  DECK ")).toBe("upperdeck");
    expect(normalizeName("Ken Griffey Jr.")).toBe("ken griffey jr");
    expect(normalizeName("SHAQUILLE O'NEAL")).toBe("shaquille oneal");
    expect(normalizeName("Jaromír Jágr")).toBe("jaromir jagr");
    expect(normalizeCardNumber("U-27")).toBe(normalizeCardNumber("27u"));
    expect(normalizeCardNumber("098T")).toBe("T98");
    expect(normalizeCardNumber("#11")).toBe("11");
  });

  it("is still exported from the old place, as the very same functions", () => {
    expect(old.normalizeBrand).toBe(normalizeBrand);
    expect(old.normalizeName).toBe(normalizeName);
    expect(old.normalizeCardNumber).toBe(normalizeCardNumber);
  });

  it("normalizes plain text: lowercase, no accents, no punctuation, spaces collapsed", () => {
    expect(normalizeText("  Traded   &  Rookies! ")).toBe("traded rookies");
    expect(normalizeText("Base|Set")).toBe("base set");
    expect(normalizeText("José")).toBe("jose");
  });

  it("keeps a printed card number in its printed order", () => {
    expect(printedCardNumber("11T")).toBe("11T");
    expect(printedCardNumber("T11")).toBe("T11");
    expect(printedCardNumber("#0336")).toBe("336");
    expect(printedCardNumber(" bc-12 ")).toBe("BC12");
    expect(printedCardNumber("0")).toBe("0");
    expect(printedCardNumber(null as unknown as string)).toBe("");
  });

  it("never throws on missing input", () => {
    expect(normalizeBrand(null as unknown as string)).toBe("");
    expect(normalizeName(undefined as unknown as string)).toBe("");
    expect(normalizeCardNumber(null as unknown as string)).toBe("");
    expect(normalizeText(null as unknown as string)).toBe("");
  });
});
