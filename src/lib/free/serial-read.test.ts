import { describe, expect, it } from "vitest";
import type { OcrLine, OcrResult } from "./ocr";
import { findSerialRead, parseCardText } from "./parse";

type Row = [string, number?];
function ocr(rows: Row[]): OcrResult {
  const lines: OcrLine[] = rows.map(([text, y = 0.5]) => ({ text, confidence: 0.85, box: { x: 0.1, y, w: 0.8, h: 0.03 } }));
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.8 };
}
const topps = (year: number): Row => [`© ${year} THE TOPPS COMPANY, INC. PRINTED IN U.S.A.`, 0.95];
const read = (rows: Row[]) => parseCardText(ocr(rows), null);

describe("serial number reading (a suggestion only)", () => {
  it("a card number 'No. 45' with 45/100 nowhere gives no serial", () => {
    const p = read([["NO. 45", 0.05], ["FRANK THOMAS", 0.1], topps(1995)]);
    expect(p.serialRead).toBeNull();
    expect(p.serialNumber).toBeNull();
    expect(read([["#45", 0.05], topps(1995)]).serialRead).toBeNull();
  });

  it("a read that equals the card number is dropped", () => {
    expect(findSerialRead([{ raw: "45/100", up: "45/100", lz: "45/100", tokens: ["45/100"], conf: 0.9 } as never], { cardNumber: "45/100" })).toBeNull();
  });

  it("045/100 gives copy 045 and edition 100, with the line it stood in", () => {
    const p = read([["045/100", 0.9], topps(1995)]);
    expect(p.serialRead).toMatchObject({ text: "045/100", copy: "045", edition: "100", line: "045/100", weak: false, why: [] });
  });

  it("a birth date, a stat row and '1 of 792' give none", () => {
    expect(read([["BORN: 5/12/68, COLUMBUS", 0.2], topps(1995)]).serialRead).toBeNull();
    expect(read([["5/12/68", 0.2], topps(1995)]).serialRead).toBeNull();
    expect(read([["1991 PIT 150 .289 25 80 12/50", 0.4], topps(1995)]).serialRead).toBeNull();
    expect(read([["CARD 1 OF 792", 0.4], topps(1995)]).serialRead).toBeNull();
    expect(read([["CARD 1/792", 0.4], topps(1995)]).serialRead).toBeNull();
    expect(read([["CHECKLIST 1/132", 0.4], topps(1995)]).serialRead).toBeNull();
  });

  it("a 1987 card with 12/50 is weak, with the reason in plain words", () => {
    const p = read([["12/50", 0.9], topps(1987)]);
    expect(p.serialRead).toMatchObject({ text: "12/50", weak: true });
    expect(p.serialRead?.why.join(" ")).toMatch(/before 1990 were almost never numbered/);
  });

  it("a look alike letter is weak", () => {
    const p = read([["O45/1OO", 0.9], topps(1995)]);
    expect(p.serialRead).toMatchObject({ text: "045/100", copy: "045", edition: "100", weak: true });
    expect(p.serialRead?.why.join(" ")).toMatch(/looks like a digit/);
  });

  it("a copy above the edition is weak, not dropped", () => {
    expect(read([["150/100", 0.9], topps(1995)]).serialRead).toMatchObject({ text: "150/100", weak: true });
  });

  it("only letters never make a serial", () => {
    expect(read([["SO/SOS", 0.9], topps(1995)]).serialRead).toBeNull();
  });

  it("the word ROOKIE or RC on the card is noted, nothing more", () => {
    expect(read([["ROOKIE", 0.2], topps(1995)]).rookieWord).toBe(true);
    expect(read([["RC", 0.2], topps(1995)]).rookieWord).toBe(true);
    expect(read([["FRANK THOMAS", 0.2], topps(1995)]).rookieWord).toBe(false);
  });
});
