import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { appVersion } from "./version";

describe("appVersion", () => {
  it("shows the package version and the short commit", () => {
    expect(appVersion("666210689dd01b40902608cb95b49dbd43a2190b")).toBe(`Version ${pkg.version} (6662106)`);
  });
  it("says dev when no commit is set", () => {
    expect(appVersion(undefined)).toBe(`Version ${pkg.version} (dev)`);
    expect(appVersion("")).toBe(`Version ${pkg.version} (dev)`);
  });
  it("never shows text that is not a commit", () => {
    expect(appVersion("<script>")).toBe(`Version ${pkg.version} (dev)`);
    expect(appVersion("unknown")).toBe(`Version ${pkg.version} (dev)`);
  });
});
