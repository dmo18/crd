import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { ownerSettings } from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { sessionIsCurrent } from "./guard";
import {
  BCRYPT_COST, changeOwnerPassword, checkOwnerPassword, createOwnerPassword, currentSessionVersion, hashNewPassword,
  newPasswordProblem, passwordSource, setupAvailable, setupCodeMatches, verifyPassword,
} from "./password";

const saved = { OWNER_PASSWORD_HASH_B64: process.env.OWNER_PASSWORD_HASH_B64, SETUP_CODE: process.env.SETUP_CODE };

function withEnv(vars: Partial<Record<keyof typeof saved, string | undefined>>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

afterEach(() => withEnv(saved));

const fastHash = (plain: string) => bcrypt.hashSync(plain, 4);
const CODE = "setup-code-0123456789";

describe("verifyPassword with the password in the server settings", () => {
  it("accepts the right password", async () => {
    expect(await verifyPassword("test-password")).toBe(true);
    expect(await checkOwnerPassword("test-password")).toBe(0);
  });
  it("rejects wrong, empty and over-long input", async () => {
    expect(await verifyPassword("nope")).toBe(false);
    expect(await verifyPassword("")).toBe(false);
    expect(await verifyPassword("a".repeat(201))).toBe(false);
    expect(await verifyPassword("test-password" + "x".repeat(200))).toBe(false);
    expect(await checkOwnerPassword(null)).toBeNull();
  });
  it("wins over a password saved in the database", async () => {
    const db = createDb(":memory:");
    db.insert(ownerSettings).values({ id: 1, passwordHash: fastHash("database-password-1234"), sessionVersion: 3 }).run();
    expect(passwordSource(db).source).toBe("env");
    expect(currentSessionVersion(db)).toBe(0);
    expect(await checkOwnerPassword("database-password-1234", db)).toBeNull();
    expect(await checkOwnerPassword("test-password", db)).toBe(0);
  });
});

describe("password saved in the database", () => {
  it("is used when the server settings have none", async () => {
    withEnv({ OWNER_PASSWORD_HASH_B64: undefined });
    const db = createDb(":memory:");
    expect(passwordSource(db).source).toBe("none");
    expect(currentSessionVersion(db)).toBeNull();
    expect(await checkOwnerPassword("anything at all here", db)).toBeNull();

    expect(createOwnerPassword(fastHash("database-password-1234"), db)).toBe(1);
    expect(passwordSource(db)).toMatchObject({ source: "db", version: 1 });
    expect(await checkOwnerPassword("database-password-1234", db)).toBe(1);
    expect(await checkOwnerPassword("wrong-password-123456", db)).toBeNull();
  });

  it("can be created only once, even when two requests race", () => {
    withEnv({ OWNER_PASSWORD_HASH_B64: undefined });
    const db = createDb(":memory:");
    expect(createOwnerPassword(fastHash("first-password-123456"), db)).toBe(1);
    expect(createOwnerPassword(fastHash("second-password-12345"), db)).toBeNull();
    // Even skipping the check, the database itself refuses a second row.
    expect(() => db.insert(ownerSettings).values({ id: 1, passwordHash: "x" }).run()).toThrow(/constraint/i);
    expect(() => db.insert(ownerSettings).values({ id: 2, passwordHash: "x" }).run()).toThrow(/constraint/i);
    expect(db.select().from(ownerSettings).all()).toHaveLength(1);
  });

  it("is not created when the server settings already have one", () => {
    const db = createDb(":memory:");
    expect(createOwnerPassword(fastHash("first-password-123456"), db)).toBeNull();
    expect(db.select().from(ownerSettings).all()).toHaveLength(0);
  });

  it("a change raises the version, and a stale version cannot change it", async () => {
    withEnv({ OWNER_PASSWORD_HASH_B64: undefined });
    const db = createDb(":memory:");
    createOwnerPassword(fastHash("first-password-123456"), db);
    expect(changeOwnerPassword(1, fastHash("second-password-12345"), db)).toBe(2);
    expect(await checkOwnerPassword("second-password-12345", db)).toBe(2);
    expect(await checkOwnerPassword("first-password-123456", db)).toBeNull();
    expect(changeOwnerPassword(1, fastHash("third-password-123456"), db)).toBeNull();
    expect(currentSessionVersion(db)).toBe(2);
  });
});

describe("sessions after a password change", () => {
  it("only the current version counts as signed in", () => {
    expect(sessionIsCurrent({ owner: true, version: 2 }, 2)).toBe(true);
    expect(sessionIsCurrent({ owner: true, version: 1 }, 2)).toBe(false);
    expect(sessionIsCurrent({ owner: true }, 0)).toBe(false);
    expect(sessionIsCurrent({ owner: true, version: 0 }, 0)).toBe(true);
    expect(sessionIsCurrent({ version: 2 }, 2)).toBe(false);
    expect(sessionIsCurrent({ owner: true, version: 1 }, null)).toBe(false);
  });
});

describe("setup", () => {
  it("is available only with a setup code and no password anywhere", () => {
    const db = createDb(":memory:");
    withEnv({ SETUP_CODE: CODE });
    expect(setupAvailable(db)).toBe(false);
    withEnv({ OWNER_PASSWORD_HASH_B64: undefined, SETUP_CODE: undefined });
    expect(setupAvailable(db)).toBe(false);
    withEnv({ SETUP_CODE: CODE });
    expect(setupAvailable(db)).toBe(true);
    createOwnerPassword(fastHash("first-password-123456"), db);
    expect(setupAvailable(db)).toBe(false);
  });
  it("compares the code exactly, whatever the lengths", () => {
    expect(setupCodeMatches(CODE, CODE)).toBe(true);
    expect(setupCodeMatches(CODE.slice(0, -1), CODE)).toBe(false);
    expect(setupCodeMatches(`${CODE}x`, CODE)).toBe(false);
    expect(setupCodeMatches("", CODE)).toBe(false);
    expect(setupCodeMatches(CODE.toUpperCase(), CODE)).toBe(false);
  });
});

describe("new passwords", () => {
  it("need 16 to 200 characters, typed the same twice", () => {
    expect(newPasswordProblem({ password: "a".repeat(15), confirm: "a".repeat(15) })).toMatch(/16/);
    expect(newPasswordProblem({ password: "a".repeat(201), confirm: "a".repeat(201) })).toMatch(/200/);
    expect(newPasswordProblem({ password: "a".repeat(16), confirm: "b".repeat(16) })).toMatch(/not the same/);
    expect(newPasswordProblem({ password: null, confirm: null })).toMatch(/16/);
    expect(newPasswordProblem({ password: "a".repeat(16), confirm: "a".repeat(16) })).toBeNull();
  });
  it("are hashed with bcrypt cost 12", async () => {
    expect(BCRYPT_COST).toBe(12);
    const hash = await hashNewPassword("a-long-new-password-1");
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare("a-long-new-password-1", hash)).toBe(true);
  });
});
