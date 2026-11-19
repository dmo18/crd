import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db";
import { items, type NewItem } from "@/db/schema";
import { applyBulk } from "./bulk";
import { createItem } from "./create";
import { checkSerialParts, formatSerial, parseSerial, SERIAL_MESSAGES, splitSerial } from "./serial";
import { updateItem } from "./update";

describe("parseSerial, splitSerial, formatSerial", () => {
  it("keeps leading zeros of the copy and drops them from the edition", () => {
    expect(parseSerial("045/100")).toEqual({ ok: true, parts: { copy: "045", edition: "100" } });
    expect(parseSerial(" #045 / 0100 ")).toEqual({ ok: true, parts: { copy: "045", edition: "100" } });
    expect(parseSerial("45 of 100")).toEqual({ ok: true, parts: { copy: "45", edition: "100" } });
    expect(checkSerialParts("007", "50")).toEqual({ ok: true, parts: { copy: "007", edition: "50" } });
  });

  it("reads \"/100\" as an unknown copy of an edition of 100", () => {
    expect(parseSerial("/100")).toEqual({ ok: true, parts: { copy: null, edition: "100" } });
    expect(checkSerialParts("", "100")).toEqual({ ok: true, parts: { copy: null, edition: "100" } });
    expect(formatSerial(null, "100")).toBe("/100");
    expect(formatSerial("045", "100")).toBe("045/100");
    expect(formatSerial("045", null)).toBeNull();
  });

  it("refuses a copy above the edition, a copy of 0 and an edition of 0", () => {
    expect(parseSerial("150/100")).toEqual({ ok: false, error: SERIAL_MESSAGES.copyAbove });
    expect(checkSerialParts("101", "100")).toEqual({ ok: false, error: SERIAL_MESSAGES.copyAbove });
    expect(parseSerial("0/100")).toEqual({ ok: false, error: SERIAL_MESSAGES.copyZero });
    expect(checkSerialParts("000", "100")).toEqual({ ok: false, error: SERIAL_MESSAGES.copyZero });
    expect(checkSerialParts("1", "0")).toEqual({ ok: false, error: SERIAL_MESSAGES.editionRange });
    expect(checkSerialParts("1", "1234567")).toEqual({ ok: false, error: SERIAL_MESSAGES.editionDigits });
    expect(checkSerialParts("12", "")).toEqual({ ok: false, error: SERIAL_MESSAGES.editionMissing });
    expect(checkSerialParts("1a", "100")).toEqual({ ok: false, error: SERIAL_MESSAGES.copyDigits });
    expect(checkSerialParts("1", "999999")).toEqual({ ok: true, parts: { copy: "1", edition: "999999" } });
  });

  it("leaves a text that does not split whole", () => {
    expect(splitSerial("1 of 1 promo")).toBeNull();
    expect(parseSerial("1 of 1 promo").ok).toBe(false);
    expect(splitSerial("150/100")).toBeNull();
    expect(splitSerial("5/12/68")).toBeNull();
    expect(splitSerial("")).toBeNull();
    expect(splitSerial(null)).toBeNull();
    expect(splitSerial("045/100")).toEqual({ copy: "045", edition: "100" });
    expect(splitSerial("1 of 1")).toEqual({ copy: "1", edition: "1" });
  });
});

describe("serial columns stay in step on every owner write", () => {
  let db: Db;
  beforeEach(() => { db = createDb(":memory:"); });
  const insert = (over: Partial<NewItem> = {}) =>
    db.insert(items).values({ kind: "card", title: "Old", ...over }).returning({ id: items.id }).get().id;
  const get = (id: number) => db.select().from(items).where(eq(items.id, id)).get()!;

  it("the item form: a text that splits fills the parts and is rebuilt", () => {
    const id = insert();
    expect(updateItem(id, { quantity: "1", serialNumber: "45 of 100" }, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject({ serialNumber: "45/100", serialCopy: "45", serialEdition: "100" });
    expect(updateItem(id, { quantity: "1", serialNumber: "1 of 1 promo" }, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject({ serialNumber: "1 of 1 promo", serialCopy: null, serialEdition: null });
    expect(updateItem(id, { quantity: "1", serialNumber: "" }, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject({ serialNumber: null, serialCopy: null, serialEdition: null });
  });

  it("the two boxes: checked, saved as parts, the text rebuilt", () => {
    const id = insert({ serialNumber: "1 of 1 promo" });
    expect(updateItem(id, { quantity: "1", serialCopy: "045", serialEdition: "100" }, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject({ serialNumber: "045/100", serialCopy: "045", serialEdition: "100" });
    expect(updateItem(id, { quantity: "1", serialCopy: "", serialEdition: "100" }, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject({ serialNumber: "/100", serialCopy: null, serialEdition: "100" });
    expect(updateItem(id, { quantity: "1", serialCopy: "101", serialEdition: "100" }, db)).toEqual({ ok: false, errors: { serialCopy: SERIAL_MESSAGES.copyAbove } });
    expect(updateItem(id, { quantity: "1", serialCopy: "0", serialEdition: "100" }, db)).toEqual({ ok: false, errors: { serialCopy: SERIAL_MESSAGES.copyZero } });
    expect(updateItem(id, { quantity: "1", serialCopy: "5", serialEdition: "" }, db)).toEqual({ ok: false, errors: { serialEdition: SERIAL_MESSAGES.editionMissing } });
    expect(get(id)).toMatchObject({ serialNumber: "/100", serialEdition: "100" });
    expect(updateItem(id, { quantity: "1", serialCopy: "", serialEdition: "" }, db)).toEqual({ ok: true });
    expect(get(id)).toMatchObject({ serialNumber: null, serialCopy: null, serialEdition: null });
  });

  it("add by hand fills the parts; sealed and bulk items have no serial", () => {
    const made = createItem("card", { player: "Someone", serialNumber: "007/050" }, db);
    expect(made.ok && get(made.id)).toMatchObject({ serialNumber: "007/50", serialCopy: "007", serialEdition: "50" });
    const sealed = insert({ kind: "sealed", productType: "box", serialNumber: "x" });
    expect(updateItem(sealed, { quantity: "1", serialCopy: "1", serialEdition: "5" }, db)).toEqual({ ok: true });
    expect(get(sealed)).toMatchObject({ serialNumber: "x", serialCopy: null, serialEdition: null });
  });

  it("bulk find and replace never touches serial numbers", () => {
    const id = insert({ serialNumber: "045/100", serialCopy: "045", serialEdition: "100", notes: "045" });
    applyBulk({ ids: [id] }, { type: "replace", field: "notes", find: "045", replace: "046", matchCase: false }, db);
    expect(get(id)).toMatchObject({ notes: "046", serialNumber: "045/100", serialCopy: "045", serialEdition: "100" });
  });
});
