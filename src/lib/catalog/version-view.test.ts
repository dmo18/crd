import { describe, expect, it } from "vitest";
import { stateLine, CATALOG_LINES } from "./version-view";

describe("version view lines", () => {
  it("says the state in plain words", () => {
    expect(stateLine({ versionState: null, versionSource: null, variation: null })).toBe("Version: not chosen");
    expect(stateLine({ versionState: "not_sure", versionSource: null, variation: null })).toBe("Version: not sure yet");
    expect(stateLine({ versionState: "confirmed", versionSource: "catalog", variation: "Tiffany" })).toBe("Version: Tiffany, you chose it, from MyCardfolio");
    expect(stateLine({ versionState: "confirmed", versionSource: "owner", variation: null })).toBe("Version: the normal card, you chose it");
  });
  it("no line has an em or en dash", () => {
    for (const l of Object.values(CATALOG_LINES)) expect(l).not.toMatch(/[–—]/);
  });
});
