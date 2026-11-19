import { describe, expect, it } from "vitest";
import { anyUnfinished, scanStatusWords } from "./ScanActivity";

describe("Scan activity words", () => {
  it("says each state in plain words", () => {
    expect(scanStatusWords({ status: "queued", error: null })).toBe("Waiting");
    expect(scanStatusWords({ status: "processing", error: null })).toBe("Being read");
    expect(scanStatusWords({ status: "done", error: null })).toBe("Done");
    expect(scanStatusWords({ status: "failed", error: "Bad photo" })).toBe("Did not work: Bad photo");
    expect(scanStatusWords({ status: "failed", error: null })).toBe("Did not work");
  });
  it("keeps refreshing only while something is waiting or being read", () => {
    expect(anyUnfinished([{ status: "done" }, { status: "failed" }])).toBe(0);
    expect(anyUnfinished([{ status: "queued" }, { status: "processing" }, { status: "done" }])).toBe(2);
  });
});
