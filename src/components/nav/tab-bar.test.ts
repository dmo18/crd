import { describe, expect, it } from "vitest";
import { isActive } from "./TabBar";

describe("tab bar", () => {
  it("lights Inventory on its own pages and on Manage records", () => {
    for (const p of ["/items", "/items/4", "/manage", "/manage/deleted"]) expect(isActive(p, "/items")).toBe(true);
    expect(isActive("/manager", "/items")).toBe(false);
    expect(isActive("/manage", "/more")).toBe(false);
  });
  it("lights Home only on the home page", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/items", "/")).toBe(false);
  });
});
