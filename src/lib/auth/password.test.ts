import { describe, expect, it } from "vitest";
import { verifyPassword } from "./password";

describe("verifyPassword", () => {
  it("accepts the right password", async () => {
    expect(await verifyPassword("test-password")).toBe(true);
  });
  it("rejects wrong, empty and over-long input", async () => {
    expect(await verifyPassword("nope")).toBe(false);
    expect(await verifyPassword("")).toBe(false);
    expect(await verifyPassword("a".repeat(201))).toBe(false);
    expect(await verifyPassword("test-password" + "x".repeat(200))).toBe(false);
  });
});
