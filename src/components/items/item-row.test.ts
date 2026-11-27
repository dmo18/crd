import { describe, expect, it } from "vitest";
import type { ItemSummary } from "@/lib/scans/view";
import { valueText } from "./ItemRow";

const base: ItemSummary = {
  id: 1, kind: "card", status: "confirmed", title: "T", confidence: 0.8, quantity: 1, valueCents: 350, waitingForVersion: false,
  ownersValue: true, lowCents: null, highCents: null, isRookie: false, rarityTier: null, thumb: null, notice: null, soldPriceCents: null,
};

describe("the value line of a list row (review 7)", () => {
  it("a sold card shows what it sold for, not its value", () => {
    expect(valueText(base)).toBe("Your value $3.50");
    expect(valueText({ ...base, status: "sold", soldPriceCents: 425 })).toBe("Sold for $4.25");
    expect(valueText({ ...base, status: "sold" })).toBe("Sold, no price written down");
  });
});
