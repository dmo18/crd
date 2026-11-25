import { describe, expect, it } from "vitest";
import { endSentence } from "@/lib/title";
import { checkNotice } from "./labels";

describe("text slips (review fix 11)", () => {
  it("a sentence that ends with a name ending in a period gets no second period", () => {
    expect(endSentence("Matched to the catalog: 2021 Prizm #SG-4 Ronald Acuña Jr.")).toBe("Matched to the catalog: 2021 Prizm #SG-4 Ronald Acuña Jr.");
    expect(endSentence("Matched to the catalog: 1990 Topps #414 Frank Thomas")).toBe("Matched to the catalog: 1990 Topps #414 Frank Thomas.");
  });

  it("the Check this notice agrees in number", () => {
    expect(checkNotice(["year"])).toBe("Not sure of: Year. Check it against the card. It is marked Check this below.");
    expect(checkNotice(["year", "brand"])).toBe("Not sure of: Year, Brand. Check them against the card. They are marked Check this below.");
    expect(checkNotice([])).toBeNull();
  });
});
